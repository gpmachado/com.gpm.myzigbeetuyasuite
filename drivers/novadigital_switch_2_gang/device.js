'use strict';

const { ZigBeeDevice } = require('homey-zigbeedriver');
const { CLUSTER, Cluster, debug } = require('zigbee-clusters');
const TuyaOnOffCluster = require('../../lib/TuyaOnOffCluster');
const TuyaPowerOnStateCluster = require('../../lib/TuyaPowerOnStateCluster');
const OnOffBoundCluster = require('../../lib/OnOffBoundCluster');
const { AvailabilityManagerCluster6 } = require('../../lib/AvailabilityManager');

Cluster.addCluster(TuyaOnOffCluster);
Cluster.addCluster(TuyaPowerOnStateCluster);

debug(false);

const DRIVER_VERSION = '3.5.0';
const DRIVER_NAME = 'NovaDigital 2-Gang';

/**
 * NovaDigital 2-Gang ZCL Wall Switch Driver
 * 
 * Version: 3.5.0 - Using AvailabilityManager lib
 */
class NovaDigitalSwitch2Gang extends ZigBeeDevice {

  async onNodeInit({ zclNode, node }) {
    const data = this.getData();
    const subDeviceId = data.subDeviceId || null;

    if (subDeviceId === 'secondSwitch') {
      this._endpoint = 2;
      this._gangType = 'Gang 2';
    } else {
      this._endpoint = 1;
      this._gangType = 'Main (Gang 1)';
    }

    this._isMainDevice = !subDeviceId;

    this.log(`${DRIVER_NAME} v${DRIVER_VERSION} - Endpoint: ${this._endpoint}, Type: ${this._gangType}`);

    // Register capability
    this.registerCapability('onoff', CLUSTER.ON_OFF, {
      endpoint: this._endpoint,
      reportParser: (value) => {
        this._markAliveFromAvailability?.('reportAttributes');
        return this._debouncedReportParser('onoff', value);
      },
    });

    this.registerCapabilityListener('onoff', (value, opts) =>
      this._debouncedOnCapabilityOnoff(value, opts)
    );

    this._setupBoundCluster();

    if (this._isMainDevice) {
      this.printNode();
      await this._setupAttributeReporting();
      await this._readBasicAttributes(zclNode);

      // Optional: genBasic heartbeat
      try {
        this.zclNode.endpoints[1].clusters.basic.on('attr', () => {
          this.log('[Heartbeat] genBasic report');
          this._markAliveFromAvailability?.('basic');
        });
        this.log('[Heartbeat] genBasic listener attached');
      } catch (err) {
        this.log('[Heartbeat] Could not attach:', err.message);
      }

    } else {
      this.log(`[${this._gangType}] Syncing settings from device...`);
    }

    // Install on every instance so each endpoint feeds its own watchdog.
    // _getSiblings() in AvailabilityManager cascades unavailable/available
    // across all gangs when any timeout fires or any frame recovers.
    this._availability = new AvailabilityManagerCluster6(this, {
      timeout: 10 * 60 * 1000,
    });
    await this._availability.install();

    // Mark alive on boot
    this._markAliveFromAvailability?.('boot');

    await this._syncFromConfig();
    await this.ready();

    this.log(`${DRIVER_NAME} - ${this._gangType} ready`);
  }

  // Same methods as 1-gang
  _debouncedReportParser(capabilityId, value) {
    const now = Date.now();
    const lastTime = this._lastReportTime?.[capabilityId] || 0;
    const lastValue = this._lastReportValue?.[capabilityId];

    if (now - lastTime < 500 && lastValue === value) {
      return value;
    }

    if (!this._lastReportTime) this._lastReportTime = {};
    if (!this._lastReportValue) this._lastReportValue = {};

    this._lastReportTime[capabilityId] = now;
    this._lastReportValue[capabilityId] = value;

    return value;
  }

  _debouncedSetCapability(capabilityId, value) {
    const now = Date.now();
    const lastTime = this._lastReportTime?.[capabilityId] || 0;

    if (now - lastTime < 500) {
      if (this._syncTimer) clearTimeout(this._syncTimer);
      this._syncTimer = setTimeout(() => {
        this.setCapabilityValue(capabilityId, value).catch(() => {});
        this._syncTimer = null;
      }, 600);
      return;
    }

    this.setCapabilityValue(capabilityId, value).catch(() => {});
    if (!this._lastReportTime) this._lastReportTime = {};
    this._lastReportTime[capabilityId] = now;
  }

  async _debouncedOnCapabilityOnoff(value, opts) {
    const now = Date.now();

    if (this._commandLock) {
      this.log(`Command busy, queuing ${value ? 'ON' : 'OFF'}`);
      if (this._commandAbort) {
        this._commandAbort.abort();
        this._commandAbort = null;
      }
      this._pendingCommand = { value, opts, time: now };
      await this._sleep(100);
      if (this._pendingCommand && this._pendingCommand.time === now) {
        return this._executeOnCapabilityOnoff(value, opts);
      }
      return;
    }

    if (now - (this._lastCommandTime || 0) < 300) {
      this.log(`Command debounced`);
      return;
    }

    return this._executeOnCapabilityOnoff(value, opts);
  }

  async _executeOnCapabilityOnoff(value, opts) {
    this._commandLock = true;
    this._lastCommandTime = Date.now();
    this._pendingCommand = null;

    if (this._commandAbort) {
      this._commandAbort.abort();
      this.log(`Previous command aborted`);
    }

    const ac = new AbortController();
    this._commandAbort = ac;

    this.log(`[${this._gangType}] App command: ${value ? 'ON' : 'OFF'}`);

    try {
      const result = await this._withRetry(async () => {
        if (ac.signal.aborted) throw new Error('aborted');
        if (value) {
          await this.zclNode.endpoints[this._endpoint].clusters.onOff.setOn();
        } else {
          await this.zclNode.endpoints[this._endpoint].clusters.onOff.setOff();
        }
      }, ac.signal);

      if (result === 'aborted') {
        this.log('Command aborted');
        return;
      }

      this._markAliveFromAvailability?.('command');

    } catch (error) {
      if (ac.signal.aborted || error.message === 'aborted') {
        this.log('Command aborted during execution');
        return;
      }
      this.error(`Command failed:`, error.message);
      throw error;

    } finally {
      this._commandLock = false;
      if (this._commandAbort === ac) this._commandAbort = null;

      if (this._pendingCommand) {
        const pending = this._pendingCommand;
        this._pendingCommand = null;
        if (Date.now() - pending.time < 5000) {
          setTimeout(() => this._debouncedOnCapabilityOnoff(pending.value, pending.opts), 50);
        }
      }
    }
  }

  _setupBoundCluster() {
    try {
      const boundCluster = new OnOffBoundCluster({
        onSetOn: () => this._handlePhysicalCommand('on'),
        onSetOff: () => this._handlePhysicalCommand('off'),
        onToggle: () => this._handlePhysicalCommand('toggle')
      });

      this.zclNode.endpoints[this._endpoint].bind(CLUSTER.ON_OFF.NAME, boundCluster);
      this.log(`[${this._gangType}] BoundCluster registered`);
    } catch (error) {
      this.error('Failed to register BoundCluster:', error.message);
    }
  }

  _handlePhysicalCommand(command) {
    this.log(`[${this._gangType}] Physical button: ${command.toUpperCase()}`);
    
    this._markAliveFromAvailability?.('physical');

    try {
      if (command === 'toggle') {
        const newState = !this.getCapabilityValue('onoff');
        this._debouncedSetCapability('onoff', newState);
      } else if (command === 'on') {
        this._debouncedSetCapability('onoff', true);
      } else if (command === 'off') {
        this._debouncedSetCapability('onoff', false);
      }
    } catch (error) {
      this.error(`Failed to handle physical command:`, error);
    }
  }

  onEndDeviceAnnounce() {
    this.log(`[${this._gangType}] End Device Announce`);
    this._markAliveFromAvailability?.('announce');
  }

  async _setupAttributeReporting() {
    try {
      await this.configureAttributeReporting([{
        endpointId: 1,
        cluster: CLUSTER.ON_OFF,
        attributeName: 'onOff',
        minInterval: 0,
        maxInterval: 600,
        minChange: 0
      }]);
      this.log('[Gang 1] Attribute reporting configured (EP1 only)');
    } catch (err) {
      this.log('Could not configure reporting:', err.message);
    }
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (!this._isMainDevice) return;

    this.log('Settings change:', changedKeys);

    for (const key of changedKeys) {
      if (key === 'health_monitoring_enabled') {
        if (newSettings.health_monitoring_enabled) {
          this.log('Health monitoring enabled');
          await this._availability.install();
        } else {
          this.log('Health monitoring disabled');
          await this._availability.uninstall();
        }
      }
    }
  }

  async _syncFromConfig() {
    // Sync logic if needed
  }

  async _withRetry(fn, signal) {
    const settings = this.getSettings?.() ?? {};
    const stage = String(settings.retry_stage || 'balanced');

    const policy = {
      off: { retries: 0, delayMs: 0 },
      balanced: { retries: 2, delayMs: 350 },
      max: { retries: 5, delayMs: 600 },
    }[stage] || { retries: 2, delayMs: 350 };

    let lastErr;
    for (let i = 0; i <= policy.retries; i++) {
      if (signal?.aborted) {
        this.log(`Retry aborted at attempt ${i + 1}`);
        return 'aborted';
      }

      try {
        await fn();
        if (i > 0) this.log(`Retry succeeded on attempt ${i + 1}`);
        return true;
      } catch (err) {
        if (signal?.aborted || err.message === 'aborted') {
          return 'aborted';
        }
        lastErr = err;

        if (i < policy.retries && policy.delayMs > 0) {
          this.log(`Retry ${i + 1}/${policy.retries}, waiting ${policy.delayMs}ms...`);
          await this._sleepWithAbort(policy.delayMs, signal);
          if (signal?.aborted) return 'aborted';
        }
      }
    }

    if (policy.retries > 0) {
      this.log(`Failed after ${policy.retries} retries`);
    }
    throw lastErr;
  }

  _sleepWithAbort(ms, signal) {
    return new Promise((resolve) => {
      const timeout = setTimeout(resolve, ms);
      if (signal) {
        const handler = () => { clearTimeout(timeout); resolve(); };
        if (signal.aborted) handler();
        else signal.addEventListener('abort', handler, { once: true });
      }
    });
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async _readBasicAttributes(zclNode) {
    try {
      await zclNode.endpoints[1].clusters.basic.readAttributes([
        'manufacturerName', 'zclVersion', 'appVersion',
        'modelId', 'powerSource', 'attributeReportingStatus'
      ]).catch(err => this.error('Error reading attributes:', err));
    } catch (err) {
      this.error('Error reading basic attributes:', err);
    }
  }

  onDeleted() {
    if (this._availability) {
      this._availability.uninstall();
    }
    if (this._syncTimer) {
      clearTimeout(this._syncTimer);
      this._syncTimer = null;
    }
    if (this._commandAbort) {
      this._commandAbort.abort();
      this._commandAbort = null;
    }
    this.log(`${DRIVER_NAME} - ${this._gangType} removed`);
  }
}

module.exports = NovaDigitalSwitch2Gang;
