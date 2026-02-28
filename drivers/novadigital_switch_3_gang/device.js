'use strict';

const { ZigBeeDevice } = require('homey-zigbeedriver');
const { CLUSTER, Cluster, debug } = require('zigbee-clusters');
const TuyaOnOffCluster = require('../../lib/TuyaOnOffCluster');
const TuyaPowerOnStateCluster = require('../../lib/TuyaPowerOnStateCluster');
const OnOffBoundCluster = require('../../lib/OnOffBoundCluster');
const { AvailabilityManagerCluster6 } = require('../../lib/AvailabilityManager');

// Register custom clusters
Cluster.addCluster(TuyaOnOffCluster);
Cluster.addCluster(TuyaPowerOnStateCluster);

debug(false);

const DRIVER_VERSION = '3.5.0';
const DRIVER_NAME = 'NovaDigital 3-Gang';

/**
 * NovaDigital 3-Gang ZCL Wall Switch Driver
 * 
 * Version: 3.5.0 - Using AvailabilityManager lib
 * 
 * Changes from v3.4.2:
 * - Migrated to AvailabilityManagerCluster6 lib
 * - Replaced _lastSeenTimestamp with lib's store-based tracking
 * - Replaced _startHealthMonitoring with lib
 * - Replaced _onCommunicationSuccess with _markAliveFromAvailability
 * - Cleaner, more maintainable code
 */
class NovaDigitalSwitch3Gang extends ZigBeeDevice {

  async onNodeInit({ zclNode, node }) {
    const data = this.getData();
    const subDeviceId = data.subDeviceId || null;

    if (subDeviceId === 'secondSwitch') {
      this._endpoint = 2;
      this._gangType = 'Gang 2';
    } else if (subDeviceId === 'thirdSwitch') {
      this._endpoint = 3;
      this._gangType = 'Gang 3';
    } else {
      this._endpoint = 1;
      this._gangType = 'Main (Gang 1)';
    }

    this._isMainDevice = !subDeviceId;

    // Initialize debounce state (must exist before registerCapability)
    this._lastReportTime = {};
    this._lastReportValue = {};
    this._lastCommandTime = 0;
    this._consecutiveFailures = 0;

    this.log(`${DRIVER_NAME} v${DRIVER_VERSION} - Endpoint: ${this._endpoint}, Type: ${this._gangType}`);

    // Register capability with markAlive integration
    this.registerCapability('onoff', CLUSTER.ON_OFF, {
      endpoint: this._endpoint,
      reportParser: (value) => {
        // Mark alive on reportAttributes
        this._markAliveFromAvailability?.('reportAttributes');
        return this._debouncedReportParser('onoff', value);
      },
    });

    this.registerCapabilityListener('onoff', (value, opts) => this._debouncedOnCapabilityOnoff(value, opts));

    this._setupBoundCluster();

    if (this._isMainDevice) {
      this.printNode();
      await this._setupAttributeReporting();
      await this._readBasicAttributes(zclNode);

      // Optional: genBasic heartbeat monitoring
      try {
        this.zclNode.endpoints[1].clusters.basic.on('attr', (data) => {
          this.log('[Heartbeat] genBasic report received');
          this._markAliveFromAvailability?.('basic');
        });
        this.log('[Heartbeat] genBasic listener attached');
      } catch (err) {
        this.log('[Heartbeat] Could not attach genBasic listener:', err.message);
      }
      
    } else {
      this.log(`[${this._gangType}] Syncing settings from device...`);
    }

    // Single watchdog on main device — _getSiblings() in AvailabilityManager
    // cascades unavailable/available across all gangs automatically.
    if (this._isMainDevice) {
      this._availability = new AvailabilityManagerCluster6(this, {
        timeout: 10 * 60 * 1000,
      });
      await this._availability.install();
      this._markAliveFromAvailability?.('boot');
    }

    await this._syncFromConfig();
    await this.ready();

    this.log(`${DRIVER_NAME} - ${this._gangType} ready`);
  }

  // ───────────────────────────────────────────────
  //  DEBOUNCED REPORT PARSER
  // ───────────────────────────────────────────────

  _debouncedReportParser(capabilityId, value) {
    const now = Date.now();
    const lastTime = this._lastReportTime[capabilityId] || 0;
    const lastValue = this._lastReportValue[capabilityId];

    if (now - lastTime < 500 && lastValue === value) {
      return value;
    }

    this._lastReportTime[capabilityId] = now;
    this._lastReportValue[capabilityId] = value;

    return value;
  }

  _debouncedSetCapability(capabilityId, value) {
    const now = Date.now();
    const lastTime = this._lastReportTime[capabilityId] || 0;

    if (now - lastTime < 500) {
      if (this._syncTimer) {
        clearTimeout(this._syncTimer);
      }
      this._syncTimer = setTimeout(() => {
        this.setCapabilityValue(capabilityId, value).catch(() => {});
        this._syncTimer = null;
      }, 600);
      return;
    }

    this.setCapabilityValue(capabilityId, value).catch(() => {});
    this._lastReportTime[capabilityId] = now;
  }

  // ───────────────────────────────────────────────
  //  COMMAND EXECUTION
  // ───────────────────────────────────────────────

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

    if (now - this._lastCommandTime < 300) {
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
      this.log(`Previous command aborted - superseded by ${value ? 'ON' : 'OFF'}`);
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
        this.log('Command aborted, not counting as failure');
        return;
      }

      // Mark alive on command success
      this._markAliveFromAvailability?.('command');

    } catch (error) {
      if (ac.signal.aborted || error.message === 'aborted') {
        this.log('Command aborted during execution');
        return;
      }
      this._onCommandFailure(error);
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

  _onCommandFailure(error) {
    this._consecutiveFailures++;
    this.error(`Command failed (${this._consecutiveFailures} consecutive):`, error.message);
  }

  // ───────────────────────────────────────────────
  //  BOUND CLUSTER / PHYSICAL BUTTON
  // ───────────────────────────────────────────────

  _setupBoundCluster() {
    try {
      const boundCluster = new OnOffBoundCluster({
        onSetOn: () => this._handlePhysicalCommand('on'),
        onSetOff: () => this._handlePhysicalCommand('off'),
        onToggle: () => this._handlePhysicalCommand('toggle')
      });

      this.zclNode.endpoints[this._endpoint].bind(CLUSTER.ON_OFF.NAME, boundCluster);
      this.log(`[${this._gangType}] BoundCluster registered for physical button detection`);

    } catch (error) {
      this.error('Failed to register BoundCluster:', error.message);
    }
  }

  _handlePhysicalCommand(command) {
    this.log(`[${this._gangType}] Physical button: ${command.toUpperCase()}`);
    
    // Mark alive on physical button
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
      this.error(`Failed to handle physical command ${command}:`, error);
    }
  }

  onEndDeviceAnnounce() {
    this.log(`[${this._gangType}] End Device Announce - power restored`);
    this._markAliveFromAvailability?.('announce');
  }

  // ───────────────────────────────────────────────
  //  ATTRIBUTE REPORTING
  // ───────────────────────────────────────────────

  async _setupAttributeReporting() {
    try {
      await this.configureAttributeReporting([
        {
          endpointId: 1,
          cluster: CLUSTER.ON_OFF,
          attributeName: 'onOff',
          minInterval: 0,
          maxInterval: 600,
          minChange: 0
        }
      ]);
      this.log('[Gang 1] Attribute reporting configured (EP1 only)');
    } catch (err) {
      this.log('Could not configure reporting:', err.message);
    }
  }

  // ───────────────────────────────────────────────
  //  SETTINGS (abbreviated - key parts only)
  // ───────────────────────────────────────────────

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (!this._isMainDevice) return;

    this.log('Settings change detected:', changedKeys);

    for (const key of changedKeys) {
      if (key === 'health_monitoring_enabled') {
        // Handle availability enable/disable
        if (newSettings.health_monitoring_enabled) {
          this.log('Health monitoring enabled');
          await this._availability.install();
        } else {
          this.log('Health monitoring disabled');
          await this._availability.uninstall();
        }
      }
      // ... other settings handlers (abbreviated for brevity)
    }
  }

  async _syncFromConfig() {
    // Settings sync logic (keep existing implementation)
  }

  // ───────────────────────────────────────────────
  //  RETRY (keep existing)
  // ───────────────────────────────────────────────

  async _withRetry(fn, signal) {
    // Keep existing retry logic
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
        this.log(`Retry loop aborted at attempt ${i + 1}`);
        return 'aborted';
      }

      try {
        await fn();
        if (i > 0) this.log(`Retry succeeded on attempt ${i + 1} (policy=${stage})`);
        return true;
      } catch (err) {
        if (signal?.aborted || err.message === 'aborted') {
          this.log('Function aborted during execution');
          return 'aborted';
        }
        lastErr = err;

        if (i < policy.retries && policy.delayMs > 0) {
          this.log(`Retry ${i + 1}/${policy.retries} (policy=${stage}), waiting ${policy.delayMs}ms...`);
          await this._sleepWithAbort(policy.delayMs, signal);

          if (signal?.aborted) {
            this.log('Aborted after sleep');
            return 'aborted';
          }
        }
      }
    }

    if (policy.retries > 0) {
      const errorMsg = lastErr?.message || String(lastErr);
      if (errorMsg.includes('Could not reach device') || errorMsg.includes('not responding')) {
        this.log(`Failed after ${policy.retries} retries (policy=${stage}): ${errorMsg}`);
      } else {
        this.error(`Failed after ${policy.retries} retries (policy=${stage}):`, lastErr);
      }
    }
    throw lastErr;
  }

  _sleepWithAbort(ms, signal) {
    return new Promise((resolve) => {
      const timeout = setTimeout(resolve, ms);
      if (signal) {
        const handler = () => { clearTimeout(timeout); resolve(); };
        if (signal.aborted) { handler(); }
        else { signal.addEventListener('abort', handler, { once: true }); }
      }
    });
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ───────────────────────────────────────────────
  //  BASIC ATTRIBUTES
  // ───────────────────────────────────────────────

  async _readBasicAttributes(zclNode) {
    try {
      await zclNode.endpoints[1].clusters.basic.readAttributes([
        'manufacturerName', 'zclVersion', 'appVersion',
        'modelId', 'powerSource', 'attributeReportingStatus'
      ]).catch(err => this.error('Error when reading device attributes:', err));
    } catch (err) {
      this.error('Error reading basic attributes:', err);
    }
  }

  // ───────────────────────────────────────────────
  //  LIFECYCLE
  // ───────────────────────────────────────────────

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

    this.log(`${DRIVER_NAME} v${DRIVER_VERSION} - ${this._gangType} removed`);
  }
}

module.exports = NovaDigitalSwitch3Gang;
