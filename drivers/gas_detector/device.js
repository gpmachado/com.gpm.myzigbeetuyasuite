'use strict';

const { ZigBeeDevice } = require('homey-zigbeedriver');
const { CLUSTER } = require('zigbee-clusters');

const DRIVER_NAME    = 'Smart Gas Detector';
const DRIVER_VERSION = '1.5.0';

/**
 * Heiman Smart Gas Detector (TS0204 / _TYZB01_0w3d5uw3)
 *
 * Protocol: ZCL IAS Zone (cluster 0x0500), AC powered (direct socket).
 * Zone type: carbonMonoxideSensor.
 *
 * IAS Zone zoneStatus bitmap (ZCL spec 8.2.2.2.1.6):
 *   Bit 0 (0x0001) alarm1   → alarm_gas
 *   Bit 3 (0x0008) trouble  → alarm_problem
 *   Bit 5 (0x0020) test     → logged only
 *
 * Note: test button activates alarm1 identical to real gas detection.
 * Use native Homey Flow condition "alarm is on AND stays on for X seconds"
 * to filter test button activations — no driver-level suppression needed.
 *
 * alarm_problem only fires if alarm_problem_enabled setting is true.
 *
 * Enrollment: device ships as notEnrolled (zoneId=255).
 * zoneEnrollResponse sent on every init. onZoneEnrollRequest handles post-reset.
 *
 * zoneStatus arrives as Buffer [lo, hi] — parsed via readUInt16LE.
 */
class GasDetector extends ZigBeeDevice {

  async onNodeInit({ zclNode }) {
    this.log(`${DRIVER_NAME} v${DRIVER_VERSION} - init`);
    this.printNode();

    // Cache flow trigger cards
    this._triggerGasOn  = this.homey.flow.getDeviceTriggerCard('gas_alarm_on');
    this._triggerGasOff = this.homey.flow.getDeviceTriggerCard('gas_alarm_off');

    await this._setupIASZone(zclNode);

    await this.ready();
    this.log(`${DRIVER_NAME} - ready`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // IAS Zone
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Setup IAS Zone: attach handlers, read initial state, enroll.
   *
   * @param {Object} zclNode
   */
  async _setupIASZone(zclNode) {
    const iasZone = zclNode.endpoints[1].clusters[CLUSTER.IAS_ZONE.NAME];
    if (!iasZone) {
      this.error('[IAS] Cluster missing on endpoint 1');
      return;
    }

    iasZone.onZoneStatusChangeNotification = ({ zoneStatus }) => {
      this.log('[IAS] Status change — raw:', zoneStatus);
      this._applyZoneStatus(zoneStatus);
    };

    iasZone.onZoneEnrollRequest = () => {
      this.log('[IAS] Enroll request — post-reset');
      this._sendEnrollResponse(iasZone);
    };

    try {
      const attrs = await iasZone.readAttributes(['zoneState', 'zoneStatus', 'zoneId']);
      this.log(`[IAS] zoneState=${attrs.zoneState} zoneId=${attrs.zoneId}`);
      if (attrs.zoneStatus !== undefined) {
        this._applyZoneStatus(attrs.zoneStatus);
      }
    } catch (err) {
      this.log('[IAS] Could not read initial attributes:', err.message);
    }

    await this._sendEnrollResponse(iasZone);
  }

  /**
   * Send IAS Zone enroll response with zoneId=1.
   *
   * @param {Object} iasZone
   */
  async _sendEnrollResponse(iasZone) {
    try {
      await iasZone.zoneEnrollResponse({ enrollResponseCode: 0x00, zoneId: 1 });
      this.log('[IAS] Enroll response sent (zoneId=1)');
    } catch (err) {
      this.error('[IAS] Enroll response failed:', err.message);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Zone status
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Parse IAS zoneStatus and update capabilities.
   * Fires flow triggers and notification on alarm_gas transitions.
   * alarm_problem is gated by alarm_problem_enabled setting.
   *
   * @param {Buffer|number|Object} zoneStatus
   */
  _applyZoneStatus(zoneStatus) {
    const bitmap = this._toUint16(zoneStatus);

    const gasDetected = !!(bitmap & 0x0001); // bit 0 — alarm1
    const fault       = !!(bitmap & 0x0008); // bit 3 — trouble
    const test        = !!(bitmap & 0x0020); // bit 5 — test

    this.log(`[IAS] gas=${gasDetected} fault=${fault} test=${test} (0x${bitmap.toString(16).padStart(4, '0')})`);

    const previousGas = this.getCapabilityValue('alarm_gas');

    // Only act on transitions to avoid duplicate triggers
    if (gasDetected !== previousGas) {
      this._setCapabilitySafe('alarm_gas', gasDetected);

      if (gasDetected) {
        this.log('[IAS] Gas alarm ON — triggering flow + notification');

        // Fire flow trigger card
        if (this._triggerGasOn) {
          this._triggerGasOn.trigger(this).catch(err =>
            this.error('[Flow] gas_alarm_on trigger failed:', err.message)
          );
        }

        // Notify all users
        this.homey.notifications.createNotification({
          excerpt: `${this.getName()}: Gas detected!`,
        }).catch(err => this.error('[Notification] Failed:', err.message));

      } else {
        this.log('[IAS] Gas alarm OFF — triggering flow');

        if (this._triggerGasOff) {
          this._triggerGasOff.trigger(this).catch(err =>
            this.error('[Flow] gas_alarm_off trigger failed:', err.message)
          );
        }
      }
    } else {
      // No transition — just keep capability in sync (e.g. repeated reports)
      this._setCapabilitySafe('alarm_gas', gasDetected);
    }

    if (this.getSetting('alarm_problem_enabled') !== false) {
      this._setCapabilitySafe('alarm_problem', fault);
    } else if (!fault) {
      this._setCapabilitySafe('alarm_problem', false);
    }
  }

  /**
   * Normalise zoneStatus to uint16.
   * Handles Buffer, Buffer-like object {type:'Buffer',data:[]}, number, named-key object.
   *
   * @param {Buffer|number|Object} value
   * @returns {number}
   */
  _toUint16(value) {
    if (Buffer.isBuffer(value)) return value.readUInt16LE(0);
    if (value && value.type === 'Buffer' && Array.isArray(value.data)) {
      return Buffer.from(value.data).readUInt16LE(0);
    }
    if (typeof value === 'number') return value;
    const bits = {
      alarm1: 0x0001, alarm2: 0x0002, tamper:       0x0004,
      trouble: 0x0008, acMains: 0x0010, test:        0x0020,
      batteryDefect: 0x0040,
    };
    return Object.entries(bits).reduce((acc, [k, mask]) => value[k] ? acc | mask : acc, 0);
  }

  /**
   * Set capability only when value changes. Skips missing capabilities.
   *
   * @param {string} capability
   * @param {*} value
   */
  _setCapabilitySafe(capability, value) {
    if (!this.hasCapability(capability)) return;
    if (this.getCapabilityValue(capability) === value) return;
    this.setCapabilityValue(capability, value)
      .catch(err => this.error(`Failed to set ${capability}:`, err.message));
  }

  onDeleted() {
    this.log(`${DRIVER_NAME} - removed`);
  }
}

module.exports = GasDetector;