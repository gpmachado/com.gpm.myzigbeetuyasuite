'use strict';

/**
 * @file device.js
 * @description Tuya Temperature & Humidity Sensor with Clock (TS0601)
 * @version 3.3.1
 *
 * Manufacturers: _TZE200_cirvgep4, _TZE204_cirvgep4
 * Protocol: Tuya EF00 (cluster 0xEF00)
 * Battery: 3×AAA
 *
 * DataPoints:
 *   DP1: Temperature (int, 0.1°C → value/10)
 *   DP2: Humidity    (int, %)
 *   DP3: Battery     (enum: 0=33%, 1=66%, 2=100%)
 *   DP9: Temp unit   (enum: 0=Celsius, 1=Fahrenheit — informational only)
 *
 * Time sync: device sends 0x24 timeRequest on wake; also synced proactively
 * every 10 min via interval. sendTimeResponse() handled by TuyaSpecificClusterDevice.
 */

// Must be required before ZigBeeDevice initializes the node so that
// Cluster.addCluster(TuyaSpecificCluster) runs in time for endpoint binding.
require('../../lib/TuyaSpecificCluster');
const TuyaSpecificClusterDevice = require('../../lib/TuyaSpecificClusterDevice');
const { AvailabilityManagerCluster6 } = require('../../lib/AvailabilityManager');

const DRIVER_VERSION = '3.3.1';
const DRIVER_NAME    = 'Tuya Temp/Humidity Clock';

/** @enum {number} Tuya datapoint IDs */
const DP = Object.freeze({
  temperature: 1,
  humidity:    2,
  battery:     3,
  tempUnit:    9,
});

/** @type {Object.<number, number>} Battery enum → percentage */
const BATTERY_PCT = Object.freeze({ 0: 33, 1: 66, 2: 100 });

const QUERY_THROTTLE     = 60  * 1000;       // 60s between dataQuery (battery saving)
const TIME_SYNC_INTERVAL = 10 * 60 * 1000;  // 10 min proactive sync

// ─────────────────────────────────────────────────────────────────────────────
// Inline getDataValue (no external dependency)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a Tuya datapoint value object into a JS type.
 *
 * @param {Object} dpValue
 * @param {number} dpValue.datatype
 * @param {Buffer|Array<number>} dpValue.data
 * @returns {boolean|number|string|Buffer}
 */
function getDataValue(dpValue) {
  const data = dpValue.data;
  switch (dpValue.datatype) {
    case 0: return data;                                                   // raw
    case 1: return data[0] === 1;                                          // bool
    case 2: return data.reduce((acc, b) => (acc << 8) | b, 0);            // value
    case 3: return String.fromCharCode(...data);                           // string
    case 4: return data[0];                                                // enum
    case 5: return data.reduce((acc, b) => (acc << 8) | b, 0);            // bitmap
    default: throw new Error(`Unsupported datatype: ${dpValue.datatype}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Device class
// ─────────────────────────────────────────────────────────────────────────────

class TempHumidityClockSensor extends TuyaSpecificClusterDevice {

  async onNodeInit({ zclNode }) {
    await super.onNodeInit({ zclNode });

    this.log(`${DRIVER_NAME} v${DRIVER_VERSION}`);

    this._lastQueryTime  = 0;
    this._availability   = null;
    this._timeSyncTimer  = null;

    this._setupTuyaListeners(zclNode);
    await this._initAvailability();
    this._startTimeSyncTimer();

    // Initial query + time sync after 2s
    this.homey.setTimeout(() => this._initialSetup(), 2000);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Setup
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Run after node is ready: query all DPs and send time sync.
   */
  async _initialSetup() {
    try {
      await this._requestDatapoints();
      await this.sendTimeResponse();
      this.log('[Init] Ready — TZ:', this.homey.clock.getTimezone());
    } catch (err) {
      this.error('[Init] Setup failed:', err.message);
    }
  }

  /**
   * Send dataQuery (cmd 0x03) to request all DPs from device.
   * Throttled to QUERY_THROTTLE to save battery.
   */
  async _requestDatapoints() {
    const now = Date.now();
    if (now - this._lastQueryTime < QUERY_THROTTLE) return;
    this._lastQueryTime = now;
    try {
      await this.zclNode.endpoints[1].clusters.tuya.dataQuery({});
      this.log('[Query] Datapoints requested');
    } catch (err) {
      this.error('[Query] Failed:', err.message);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Listeners
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Attach all Tuya cluster and node event handlers.
   *
   * @param {Object} zclNode
   */
  _setupTuyaListeners(zclNode) {
    const tuya = zclNode.endpoints[1]?.clusters?.tuya;
    if (!tuya) {
      this.error('[Listeners] tuya cluster not available on endpoint 1 — skipping setup');
      return;
    }

    tuya.on('reporting', frame => {
      this._markAliveFromAvailability?.('reporting');
      this._processDatapoint(frame);
    });

    tuya.on('response', frame => {
      this._markAliveFromAvailability?.('response');
      this._processDatapoint(frame);
    });

    tuya.on('heartbeat', () => {
      this._markAliveFromAvailability?.('heartbeat');
      this._requestDatapoints().catch(err =>
        this.error('[Heartbeat] Query failed:', err.message));
    });

    tuya.on('timeRequest', async (request) => {
      this._markAliveFromAvailability?.('timeRequest');
      await this.sendTimeResponse(request).catch(err =>
        this.error('[Time] Sync failed:', err.message));
    });

    zclNode.on('online',  () => { this.log('[Node] Online');  this._markAliveFromAvailability?.('online'); });
    zclNode.on('offline', () => { this.log('[Node] Offline'); });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DP processing
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Parse and dispatch a single Tuya datapoint frame.
   *
   * @param {Object} frame - Tuya cluster frame with dp and datatype/data fields
   */
  _processDatapoint(frame) {
    if (!frame?.dp) return;
    try {
      const value = getDataValue(frame);
      switch (frame.dp) {
        case DP.temperature: this._handleTemperature(value); break;
        case DP.humidity:    this._handleHumidity(value);    break;
        case DP.battery:     this._handleBattery(value);     break;
        case DP.tempUnit:    this.log(`[Unit] ${value === 0 ? 'Celsius' : 'Fahrenheit'}`); break;
        default:             this.log(`[DP] Unknown DP${frame.dp}=${value}`);
      }
    } catch (err) {
      this.error(`[DP${frame.dp}] Parse error:`, err.message);
    }
  }

  /**
   * Handle temperature datapoint (DP1).
   * Raw value is in 0.1°C units → divide by 10.
   *
   * @param {number} raw
   */
  _handleTemperature(raw) {
    const temp = raw / 10;
    this.log(`[Temp] ${temp.toFixed(1)}°C`);
    this.setCapabilityValue('measure_temperature', temp).catch(this.error);
  }

  /**
   * Handle humidity datapoint (DP2).
   * Raw value is direct percentage.
   *
   * @param {number} raw
   */
  _handleHumidity(raw) {
    this.log(`[Humidity] ${raw}%`);
    this.setCapabilityValue('measure_humidity', raw).catch(this.error);
  }

  /**
   * Handle battery datapoint (DP3).
   * Enum: 0=33%, 1=66%, 2=100%.
   * Sets alarm_battery true when below 50% (enum 0).
   *
   * @param {number} enumValue - 0, 1, or 2
   */
  _handleBattery(enumValue) {
    const pct = BATTERY_PCT[enumValue];
    if (pct === undefined) {
      this.error(`[Battery] Unknown enum value: ${enumValue}`);
      return;
    }
    this.log(`[Battery] ${pct}% (enum ${enumValue})`);
    this.setCapabilityValue('measure_battery', pct).catch(this.error);
    this.setCapabilityValue('alarm_battery', pct < 50).catch(this.error);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Availability monitoring
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Install AvailabilityManagerCluster6 with 8h timeout (battery device).
   * Tuya listeners call _markAliveFromAvailability() injected by the manager.
   */
  async _initAvailability() {
    this._availability = new AvailabilityManagerCluster6(this, {
      timeout: 8 * 60 * 60 * 1000,
    });
    await this._availability.install();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Time sync
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Start proactive time sync interval (every 10 min).
   * Device clock drifts — periodic sync keeps the display accurate.
   */
  _startTimeSyncTimer() {
    this._timeSyncTimer = this.homey.setInterval(async () => {
      await this.sendTimeResponse().catch(err =>
        this.error('[Time] Proactive sync failed:', err.message));
    }, TIME_SYNC_INTERVAL);
    this.log('[Time] Proactive sync enabled (every 10 min)');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Settings
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * @param {Object} params
   * @param {Object} params.newSettings
   * @param {string[]} params.changedKeys
   */
  async onSettings({ newSettings, changedKeys }) {
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  onDeleted() {
    this._availability?.uninstall().catch(() => {});
    this.homey.clearInterval(this._timeSyncTimer);
    this._timeSyncTimer = null;
    this.log(`${DRIVER_NAME} - removed`);
  }

}

module.exports = TempHumidityClockSensor;