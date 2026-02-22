/**
 * @file device.js
 * @description Smart Plug with Energy Metering (TS011F / TS0121)
 * @version 3.0.0
 *
 * Manufacturers: _TZ3000_88iqnhvd, _TZ3000_okaz9tjs, _TZ3210_fgwhjm9j
 *
 * Changelog:
 * - v2.1.0: Removed onCapabilityOnoff (SDK3 routes via cluster directly),
 *           removed ELECTRICAL_MEASUREMENT configureReporting (UNREPORTABLE_ATTRIBUTE loop),
 *           replaced availability poll with passive zclNode frame watchdog,
 *           onOff reporting only configured (works); polling handles measurements
 * - v2.2.0: _lastVoltage/_lastCurrent local cache (avoid getCapabilityValue overhead),
 *           _updateCalculatedPower() proactive publish on new V/A frame
 * - v2.3.0: Watchdog now parser-driven (_touchWatchdog in every reportParser);
 *           endpoint 'frame' event unreliable in SDK3 (silent in poll responses)
 * - v2.5.0: Fix indicatorMode sync map (off/status/position); JSON poll max 86400->3600s
 * - v2.6.0: Watchdog simplified — fixed WATCHDOG_MS anchored on onoff poll (60s);
 *           each reportParser feeds the watchdog; no dynamic calculation
 * - v3.0.0: Replaced custom setTimeout watchdog with AvailabilityManagerCluster0.
 *           handleFrame hook captures poll responses directly, so the device recovers
 *           availability as soon as any frame arrives — including responses to polls
 *           that succeed after a power cut, without requiring a physical button press.
 */
'use strict';

const { ZigBeeDevice } = require('homey-zigbeedriver');
const { CLUSTER, Cluster } = require('zigbee-clusters');
const TuyaOnOffCluster = require('../../lib/TuyaOnOffCluster');
const OnOffBoundCluster = require('../../lib/OnOffBoundCluster');
const { AvailabilityManagerCluster0 } = require('../../lib/AvailabilityManager');

Cluster.addCluster(TuyaOnOffCluster);

const DRIVER_VERSION = '3.0.0';
const DRIVER_NAME    = 'Smart Plug';

const ENDPOINT_ID      = 1;
const METERING_DIVISOR = 100.0;  // Wh → kWh
const CURRENT_DIVISOR  = 1000;   // mA → A
const DEBOUNCE_TIME    = 500;    // ms
const SECONDS_TO_MS    = 1000;

// 10 min: plug is AC-powered and polls every 60s; if 10 consecutive polls fail
// something is genuinely wrong.
const AVAILABILITY_TIMEOUT = 10 * 60 * SECONDS_TO_MS;

const TUYA_CONTROL_SETTINGS = [
  { key: 'relay_status',   attribute: 'relayStatus'   },
  { key: 'indicator_mode', attribute: 'indicatorMode' },
  { key: 'child_lock',     attribute: 'childLock'     },
];

class SmartPlugDevice extends ZigBeeDevice {

  constructor(...args) {
    super(...args);
    this._lastReportTime  = {};
    this._lastReportValue = {};
    this._lastVoltage     = 0;
    this._lastCurrent     = 0;
    this._availability    = null;
  }

  // ── Init ────────────────────────────────────────────────────────────────

  async onNodeInit({ zclNode }) {
    this.printNode();
    this.log(`${DRIVER_NAME} v${DRIVER_VERSION} – Init`);

    this._loadSettings();
    await this._addMissingCapabilities();
    this._registerCapabilities();
    this._setupBoundCluster();

    await this._safeReadAndSyncTuyaSettings();
    await this._safeSetupAttributeReporting();
    await this._safeReadDeviceInfo(zclNode);

    // Passive availability: handleFrame hook captures every inbound frame,
    // including poll responses — no manual _touchWatchdog calls needed.
    this._availability = new AvailabilityManagerCluster0(this, {
      timeout: AVAILABILITY_TIMEOUT,
    });
    await this._availability.install();

    zclNode.on('online', () => this.log('[Node] Online'));
    zclNode.on('offline', () => this.log('[Node] Offline'));

    this.log(`${DRIVER_NAME} initialized`);
  }

  // ── Settings load ────────────────────────────────────────────────────────

  _loadSettings() {
    this.minReportPower   = this.getSetting('minReportPower')   * SECONDS_TO_MS;
    this.minReportCurrent = this.getSetting('minReportCurrent') * SECONDS_TO_MS;
    this.minReportVoltage = this.getSetting('minReportVoltage') * SECONDS_TO_MS;
    this._energyFactor    = parseFloat(this.getSetting('energyFactor')) || 1;
    this._powerFactor     = parseFloat(this.getSetting('powerFactor'))  || 1;
    this._calcPower       = this.getSetting('calcPower') === true;
  }

  // ── Capabilities ─────────────────────────────────────────────────────────

  async _addMissingCapabilities() {
    for (const cap of ['measure_current', 'measure_voltage']) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap).catch(err =>
          this.error(`addCapability ${cap}:`, err));
      }
    }
  }

  _registerCapabilities() {
    this.registerCapability('onoff', TuyaOnOffCluster, {
      reportParser: value => this._debouncedParser('onoff', value),
      getOpts: { getOnStart: true, pollInterval: 60 * SECONDS_TO_MS },
    });

    this.registerCapability('meter_power', CLUSTER.METERING, {
      reportParser: raw => this._parseMeter(raw),
      getParser:    raw => this._parseMeter(raw),
      getOpts: { getOnStart: true, pollInterval: 5 * 60 * SECONDS_TO_MS },
    });

    this.registerCapability('measure_power', CLUSTER.ELECTRICAL_MEASUREMENT, {
      reportParser: raw => this._parsePower(raw),
      getOpts: { getOnStart: true, pollInterval: this.minReportPower },
    });

    this.registerCapability('measure_current', CLUSTER.ELECTRICAL_MEASUREMENT, {
      reportParser: raw => {
        this._lastCurrent = raw / CURRENT_DIVISOR;
        this._updateCalculatedPower();
        return this._lastCurrent;
      },
      getOpts: { getOnStart: true, pollInterval: this.minReportCurrent },
    });

    this.registerCapability('measure_voltage', CLUSTER.ELECTRICAL_MEASUREMENT, {
      reportParser: raw => {
        this._lastVoltage = raw;
        this._updateCalculatedPower();
        return raw;
      },
      getOpts: { getOnStart: true, pollInterval: this.minReportVoltage },
    });
  }

  // ── Parsers ───────────────────────────────────────────────────────────────

  /**
   * @param {number} raw - Raw Wh value from metering cluster.
   * @returns {number} kWh rounded to 3 decimal places.
   */
  _parseMeter(raw) {
    const kWh = (raw / METERING_DIVISOR) * this._energyFactor;
    return Math.round(kWh * 1000) / 1000;
  }

  /**
   * @param {number} raw - Raw W value from electricalMeasurement cluster.
   * @returns {number} Corrected watts.
   */
  _parsePower(raw) {
    if (this._calcPower) {
      if (this._lastVoltage > 0 && this._lastCurrent > 0) {
        return Math.round(this._lastVoltage * this._lastCurrent * this._powerFactor * 100) / 100;
      }
      return 0;
    }
    return raw * this._powerFactor;
  }

  /**
   * Proactively publish measure_power when V or A arrives and calcPower is on.
   * Avoids waiting for the next measure_power poll cycle.
   */
  _updateCalculatedPower() {
    if (!this._calcPower) return;
    if (this._lastVoltage > 0 && this._lastCurrent > 0) {
      const power = Math.round(this._lastVoltage * this._lastCurrent * this._powerFactor * 100) / 100;
      this.setCapabilityValue('measure_power', power).catch(this.error);
    }
  }

  // ── Tuya attribute read / configure ──────────────────────────────────────

  async _safeReadAndSyncTuyaSettings() {
    try {
      const attrs = await this.zclNode.endpoints[ENDPOINT_ID].clusters.onOff
        .readAttributes(['relayStatus', 'indicatorMode', 'childLock']);

      this.log('Tuya settings from device:', attrs);

      const update = {};
      if (attrs.relayStatus  !== undefined) update.relay_status   = { off: '0', on: '1', remember: '2' }[attrs.relayStatus]  ?? '2';
      if (attrs.indicatorMode !== undefined) update.indicator_mode = { off: '0', status: '1', position: '2' }[attrs.indicatorMode] ?? '1';
      if (attrs.childLock     !== undefined) update.child_lock     = Boolean(attrs.childLock);

      if (Object.keys(update).length > 0) {
        await this.setSettings(update);
        this.log('Settings synced from device');
      }
    } catch (err) {
      this.log('Could not read device settings (device may not support it):', err.message);
    }
  }

  async _safeSetupAttributeReporting() {
    try {
      await this.configureAttributeReporting([{
        endpointId:    ENDPOINT_ID,
        cluster:       TuyaOnOffCluster,
        attributeName: 'onOff',
        minInterval:   0,
        maxInterval:   600,
        minChange:     1,
      }]);
      this.log('onOff attribute reporting configured');
    } catch (err) {
      this.log('Could not configure onOff reporting:', err.message);
    }
  }

  async _safeReadDeviceInfo(zclNode) {
    try {
      const info = await zclNode.endpoints[ENDPOINT_ID].clusters.basic
        .readAttributes(['manufacturerName', 'modelId', 'swBuildId', 'appVersion', 'powerSource']);

      this.log('Device info:', info);
      if (info.swBuildId) await this.setStoreValue('firmwareVersion', info.swBuildId).catch(() => {});
      await this.setStoreValue('driverVersion', DRIVER_VERSION).catch(() => {});
    } catch (err) {
      this.log('Could not read basic cluster info:', err.message);
    }
  }

  // ── Debounce helpers ──────────────────────────────────────────────────────

  /**
   * Returns null (suppress update) when the same value arrives within DEBOUNCE_TIME.
   *
   * @param {string} capability
   * @param {*} value
   * @returns {*|null}
   */
  _debouncedParser(capability, value) {
    const now       = Date.now();
    const lastTime  = this._lastReportTime[capability]  || 0;
    const lastValue = this._lastReportValue[capability];

    if (lastValue === value && (now - lastTime) < DEBOUNCE_TIME) return null;

    this._lastReportTime[capability]  = now;
    this._lastReportValue[capability] = value;
    return value;
  }

  /**
   * Debounced setCapabilityValue for BoundCluster callbacks.
   *
   * @param {string} capability
   * @param {*} value
   */
  _debouncedSetCapability(capability, value) {
    const now       = Date.now();
    const lastTime  = this._lastReportTime[capability]  || 0;
    const lastValue = this._lastReportValue[capability];

    if (lastValue === value && (now - lastTime) < DEBOUNCE_TIME) return;

    this._lastReportTime[capability]  = now;
    this._lastReportValue[capability] = value;
    this.setCapabilityValue(capability, value).catch(this.error);
  }

  // ── Physical button ───────────────────────────────────────────────────────

  _setupBoundCluster() {
    try {
      const bc = new OnOffBoundCluster({
        onSetOn:  () => this._debouncedSetCapability('onoff', true),
        onSetOff: () => this._debouncedSetCapability('onoff', false),
        onToggle: () => this._debouncedSetCapability('onoff', !this.getCapabilityValue('onoff')),
      });
      this.zclNode.endpoints[ENDPOINT_ID].bind(CLUSTER.ON_OFF.NAME, bc);
      this.log('BoundCluster registered');
    } catch (err) {
      this.error('BoundCluster registration failed:', err.message);
    }
  }

  // ── Settings changed ──────────────────────────────────────────────────────

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this._loadSettings();

    for (const { key, attribute } of TUYA_CONTROL_SETTINGS) {
      if (!changedKeys.includes(key)) continue;
      try {
        let val = newSettings[key];
        val = (typeof val === 'boolean') ? val : parseInt(val, 10);
        await this.zclNode.endpoints[ENDPOINT_ID].clusters.onOff
          .writeAttributes({ [attribute]: val });
        this.log(`Setting written: ${key} = ${val}`);
      } catch (err) {
        this.error(`Failed to write ${key}:`, err.message);
        throw err;
      }
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  onDeleted() {
    this._availability?.uninstall().catch(() => {});
    this.log(`${DRIVER_NAME} v${DRIVER_VERSION} removed`);
  }
}

module.exports = SmartPlugDevice;
