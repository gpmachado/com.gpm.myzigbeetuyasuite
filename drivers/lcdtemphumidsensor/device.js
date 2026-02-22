'use strict';

/**
 * @file device.js
 * @description LCD Temperature & Humidity Sensor (TS0201 / _TZ3000_ywagc4rj)
 * @version 2.1.0
 *
 * Device: End Device (sleepy), battery CR2032.
 * Does NOT support configureAttributeReporting — reports autonomously on change.
 *
 * Conversions:
 *   Temperature : raw / 100  (ZCL standard)
 *   Humidity    : raw / 10   (Tuya-specific, not standard /100)
 *   Battery     : raw / 2    (ZCL standard, 0-200 → 0-100%)
 */

const { ZigBeeDevice } = require('homey-zigbeedriver');
const { AvailabilityManagerCluster6 } = require('../../lib/AvailabilityManager');
const { CLUSTER } = require('zigbee-clusters');

const DRIVER_VERSION    = '2.1.0';
const DRIVER_NAME       = 'LCD Temp/Humidity Sensor';

class LCDTempHumidSensor extends ZigBeeDevice {

  async onNodeInit({ zclNode }) {
    this.printNode();
    this.log(`${DRIVER_NAME} v${DRIVER_VERSION} - init`);

    this._availability = null;

    this._registerTemperature();
    this._registerHumidity();
    this._registerBattery();

    await this._initAvailability();
    this._markAliveFromAvailability?.('boot');

    await this.ready();
    this.log(`${DRIVER_NAME} - ready`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Capability registration
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Register temperature capability.
   * ZCL cluster: TEMPERATURE_MEASUREMENT, attribute: measuredValue
   * Conversion: raw / 100 → °C (ZCL standard).
   * No reportOpts — end device does not support configureAttributeReporting.
   */
  _registerTemperature() {
    this.registerCapability('measure_temperature', CLUSTER.TEMPERATURE_MEASUREMENT, {
      get: 'measuredValue',
      report: 'measuredValue',
      reportParser: (value) => {
        this._markAliveFromAvailability?.('temperature');
        const result = Math.round((value / 100) * 10) / 10;
        this.log(`[Temp] ${result}°C`);
        return result;
      },
      getOpts: { getOnStart: true },
    });
  }

  /**
   * Register humidity capability.
   * ZCL cluster: RELATIVE_HUMIDITY_MEASUREMENT, attribute: measuredValue
   * Conversion: raw / 10 → % (Tuya-specific, standard would be /100).
   * No reportOpts — end device does not support configureAttributeReporting.
   */
  _registerHumidity() {
    this.registerCapability('measure_humidity', CLUSTER.RELATIVE_HUMIDITY_MEASUREMENT, {
      get: 'measuredValue',
      report: 'measuredValue',
      reportParser: (value) => {
        this._markAliveFromAvailability?.('humidity');
        const result = Math.round(Math.min(100, Math.max(0, value / 10)) * 10) / 10;
        this.log(`[Humidity] ${result}%`);
        return result;
      },
      getOpts: { getOnStart: true },
    });
  }

  /**
   * Register battery capability.
   * ZCL cluster: POWER_CONFIGURATION, attribute: batteryPercentageRemaining
   * Conversion: raw / 2 → % (ZCL spec: 0-200 maps to 0-100%).
   * No reportOpts — end device does not support configureAttributeReporting.
   */
  _registerBattery() {
    this.registerCapability('measure_battery', CLUSTER.POWER_CONFIGURATION, {
      get: 'batteryPercentageRemaining',
      report: 'batteryPercentageRemaining',
      reportParser: (value) => {
        this._markAliveFromAvailability?.('battery');
        const result = Math.min(100, Math.max(0, Math.round(value / 2)));
        this.log(`[Battery] ${result}%`);
        if (this.hasCapability('alarm_battery') && this.getSetting('alarm_battery_enabled') !== false) {
          this.setCapabilityValue('alarm_battery', result < 20).catch(this.error);
        }
        return result;
      },
      getOpts: { getOnStart: true },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Availability monitoring
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Install AvailabilityManagerCluster6 with 24h timeout (battery device).
   * reportParsers call _markAliveFromAvailability() injected by the manager.
   */
  async _initAvailability() {
    this._availability = new AvailabilityManagerCluster6(this, {
      timeout: 24 * 60 * 60 * 1000,
    });
    await this._availability.install();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Settings
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Handle settings changes.
   * Health monitoring toggle starts or stops the watchdog.
   *
   * @param {Object} params
   * @param {Object} params.oldSettings
   * @param {Object} params.newSettings
   * @param {string[]} params.changedKeys
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('[Settings] Changed:', changedKeys);  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  onDeleted() {
    this._availability?.uninstall().catch(() => {});
    this.log(`${DRIVER_NAME} - removed`);
  }
}

module.exports = LCDTempHumidSensor;
