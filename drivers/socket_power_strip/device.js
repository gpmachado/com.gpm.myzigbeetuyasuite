'use strict';

/**
 * @file device.js
 * @description Power Strip 4 Sockets + USB (TS011F / _TZ3000_cfnprab5)
 * @version 1.1.0
 *
 * Sub-device architecture — one device.js instance per socket/USB port.
 * subDeviceId from getData() determines which endpoint to use:
 *   undefined / main → endpoint 1 (Socket 1/4)
 *   socket2          → endpoint 2
 *   socket3          → endpoint 3
 *   socket4          → endpoint 4
 *   usb              → endpoint 5
 *
 * Uses TuyaOnOffCluster (same chip as TS011F smart plug).
 * No energy metering on this model — onoff only.
 *
 * Settings (main device only):
 *   relay_status    → relayStatus  attribute (0=off, 1=on, 2=remember)
 *   child_lock      → childLock    attribute (boolean)
 *
 * Watchdog on main device only — AvailabilityManagerCluster6._getSiblings()
 * propagates unavailable to all sub-devices automatically.
 */

const { ZigBeeDevice } = require('homey-zigbeedriver');
const { CLUSTER, Cluster } = require('zigbee-clusters');
const TuyaOnOffCluster = require('../../lib/TuyaOnOffCluster');
const { AvailabilityManagerCluster6 } = require('../../lib/AvailabilityManager');

Cluster.addCluster(TuyaOnOffCluster);

const DRIVER_VERSION = '1.1.0';
const DRIVER_NAME    = 'Power Strip';

/** @type {Object.<string, number>} Map subDeviceId to Zigbee endpoint */
const ENDPOINT_MAP = Object.freeze({
  socket2: 2,
  socket3: 3,
  socket4: 4,
  usb:     5,
});

const WATCHDOG_TIMEOUT = 10 * 60 * 1000; // 10 min — AC powered

/** Settings written to device — main device only */
const TUYA_CONTROL_SETTINGS = [
  { key: 'relay_status', attribute: 'relayStatus' },
  { key: 'child_lock',   attribute: 'childLock'   },
];

class PowerStripDevice extends ZigBeeDevice {

  async onNodeInit({ zclNode }) {
    this.printNode();

    const { subDeviceId } = this.getData();
    const endpoint = ENDPOINT_MAP[subDeviceId] || 1;
    const label    = subDeviceId || 'socket1';

    this.log(`${DRIVER_NAME} v${DRIVER_VERSION} - ${label} (endpoint ${endpoint})`);

    this.registerCapability('onoff', TuyaOnOffCluster, {
      reportParser: (value) => {
        this._markAliveFromAvailability?.(`onoff-${label}`);
        return value;
      },
      getOpts: {
        getOnStart:   true,
        pollInterval: 60 * 1000,
      },
      endpoint,
    });

    // Settings + watchdog only on main device
    if (!subDeviceId) {
      await this._safeReadAndSyncSettings();

      this._availability = new AvailabilityManagerCluster6(this, {
        timeout: WATCHDOG_TIMEOUT,
      });
      await this._availability.install();
    }

    await this.ready();
    this.log(`${DRIVER_NAME} - ${label} ready`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Settings
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Read relay_status and child_lock from device and sync to Homey settings.
   * Graceful — some firmware revisions reject readAttributes silently.
   */
  async _safeReadAndSyncSettings() {
    try {
      const attrs = await this.zclNode.endpoints[1].clusters.onOff
        .readAttributes(['relayStatus', 'childLock']);

      this.log('[Settings] From device:', attrs);

      const update = {};
      if (attrs.relayStatus !== undefined) {
        const map = { off: '0', on: '1', remember: '2' };
        update.relay_status = map[attrs.relayStatus] ?? '2';
      }
      if (attrs.childLock !== undefined) {
        update.child_lock = Boolean(attrs.childLock);
      }
      if (Object.keys(update).length > 0) {
        await this.setSettings(update);
        this.log('[Settings] Synced from device');
      }
    } catch (err) {
      this.log('[Settings] Could not read from device:', err.message);
    }
  }

  /**
   * Push changed settings to device.
   * Only runs on main device — sub-devices share the same physical hardware.
   *
   * @param {Object} params
   * @param {Object} params.newSettings
   * @param {string[]} params.changedKeys
   */
  async onSettings({ newSettings, changedKeys }) {
    const { subDeviceId } = this.getData();
    if (subDeviceId) return; // sub-devices don't write settings

    for (const { key, attribute } of TUYA_CONTROL_SETTINGS) {
      if (!changedKeys.includes(key)) continue;
      try {
        let val = newSettings[key];
        val = (typeof val === 'boolean') ? val : parseInt(val, 10);
        await this.zclNode.endpoints[1].clusters.onOff
          .writeAttributes({ [attribute]: val });
        this.log(`[Settings] Written: ${key} = ${val}`);
      } catch (err) {
        this.error(`[Settings] Failed to write ${key}:`, err.message);
        throw err;
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  onDeleted() {
    this._availability?.uninstall().catch(() => {});
    this.log(`${DRIVER_NAME} - removed`);
  }
}

module.exports = PowerStripDevice;
