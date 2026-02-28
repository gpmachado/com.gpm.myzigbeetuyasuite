'use strict';

const { Cluster, debug } = require('zigbee-clusters');
const TuyaSpecificCluster = require('../../lib/TuyaSpecificCluster');
const TuyaSpecificClusterDevice = require('../../lib/TuyaSpecificClusterDevice');
const { AvailabilityManagerCluster0 } = require('../../lib/AvailabilityManager');

debug(false);

Cluster.addCluster(TuyaSpecificCluster);

const DRIVER_NAME = 'Zemismart 6-Gang';
const DRIVER_VERSION = '2.1.0';

const DP = {
  GANG1: 1,
  GANG2: 2,
  GANG3: 3,
  GANG4: 4,
  GANG5: 5,
  GANG6: 6,
};

/**
 * Zemismart 6-Gang Tuya Wall Switch Driver
 * 
 * Version: 2.1.0 - With AvailabilityManager
 * 
 * Architecture:
 * - 1 physical Zigbee device with 1 endpoint
 * - 6 virtual Homey devices (Gang 1-6) sharing the same node
 * - Datapoints: DP 1-6 (on/off for each gang)
 * 
 * Power-On Behavior:
 * - NOT CONFIGURABLE - firmware always restores to OFF after power outage
 * 
 * Settings:
 * - health_monitoring_enabled (global, Gang 1 only)
 */
class ZemismartSwitch6Gang extends TuyaSpecificClusterDevice {

  async onNodeInit({ zclNode }) {
    await super.onNodeInit({ zclNode });

    const { subDeviceId } = this.getData();
    this._gangName = this._getGangName(subDeviceId);
    this._myDp = this._getMyDp(subDeviceId);
    this._isMain = !subDeviceId;

    this.log(`${DRIVER_NAME} v${DRIVER_VERSION} - ${this._gangName}`);
    if (this._isMain) this.printNode();

    // Setup listeners (once per physical device)
    if (this._isMain) {
      this._setupTuyaListeners(zclNode);
      
      // Install availability monitoring
      this._availability = new AvailabilityManagerCluster0(this, {
        timeout: 25 * 60 * 1000,  // 25min
      });
      await this._availability.install();
    }

    // Register capability listeners (per gang)
    this.registerCapabilityListener('onoff', v => this._onCapabilityOnOff(v));

    this.log(`${this._gangName} ready`);
  }

  /**
   * Setup Tuya cluster event listeners
   */
  _setupTuyaListeners(zclNode) {
    const ep1 = zclNode.endpoints?.[1];
    const tuya = ep1?.clusters?.tuya;

    if (!ep1 || !tuya) {
      this.error('Endpoint 1 or Tuya cluster not found');
      return;
    }

    const handleTuya = async (data) => {
      const dp = data?.dp;
      const target = this._getNodeDevices().find(g => g._isMyDp(dp));
      
      if (target) {
        target._processDatapoint(data).catch(e => this.error('Datapoint error:', e));
      }
    };

    tuya.on('reporting', handleTuya);
    tuya.on('response', handleTuya);
    
    this.log('Tuya cluster listeners attached');
  }

  /**
   * Process incoming Tuya datapoint
   */
  async _processDatapoint(data) {
    const dp = data.dp;
    const value = this._parseDataValue(data);
    
    if (!this._isMyDp(dp)) return;
    
    // Handle on/off state change (DP 1-6)
    if (dp >= DP.GANG1 && dp <= DP.GANG6) {
      await this._handleOnOff(dp, value);
    }
  }

  /**
   * Handle on/off state change
   */
  async _handleOnOff(dp, value) {
    try {
      const currentValue = this.getCapabilityValue('onoff');
      
      // Anti-flicker
      if (currentValue === value) return;
      
      await this.setCapabilityValue('onoff', value);
      this.log(`${this._gangName} DP${dp}: ${currentValue ? 'ON' : 'OFF'} -> ${value ? 'ON' : 'OFF'}`);
      
    } catch (err) {
      this.error('Failed to update capability:', err);
    }
  }

  /**
   * Handle on/off command from Homey
   */
  async _onCapabilityOnOff(value) {
    // Anti-flicker
    if (this.getCapabilityValue('onoff') === value) return;
    
    this.log(`${this._gangName} command: ${value ? 'ON' : 'OFF'}`);
    
    try {
      await this.writeBool(this._myDp, value);
    } catch (err) {
      this.error(`${this._gangName} command failed:`, err.message);
      throw err;
    }
  }

  /**
   * Handle settings changes
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (!this._isMain) return;

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

  _getNodeDevices() {
    const myIeee = this.getData().ieeeAddress;
    return this.driver.getDevices().filter(d => {
      try { return d.getData().ieeeAddress === myIeee; } catch { return false; }
    });
  }

  /**
   * Get datapoint number for this gang
   */
  _getMyDp(subDeviceId) {
    const map = {
      secondGang: DP.GANG2,
      thirdGang: DP.GANG3,
      fourthGang: DP.GANG4,
      fifthGang: DP.GANG5,
      sixthGang: DP.GANG6,
    };
    return map[subDeviceId] || DP.GANG1;
  }

  /**
   * Get display name for this gang
   */
  _getGangName(subDeviceId) {
    const map = {
      secondGang: 'Gang 2',
      thirdGang: 'Gang 3',
      fourthGang: 'Gang 4',
      fifthGang: 'Gang 5',
      sixthGang: 'Gang 6',
    };
    return map[subDeviceId] || 'Gang 1';
  }

  /**
   * Check if this gang handles the given datapoint
   */
  _isMyDp(dp) {
    return dp === this._myDp;
  }

  /**
   * Parse a Tuya datapoint value into a JS type.
   *
   * @param {Object} dpValue
   * @param {number} dpValue.datatype - Tuya datatype (0=raw,1=bool,2=value,3=string,4=enum,5=bitmap)
   * @param {Buffer|Array<number>} dpValue.data
   * @returns {boolean|number|string|Buffer}
   */
  _parseDataValue(dpValue) {
    switch (dpValue.datatype) {
      case 0: return dpValue.data;
      case 1: return dpValue.data[0] === 1;
      case 2: return this._bufToUint32(dpValue.data);
      case 3: return String.fromCharCode(...dpValue.data);
      case 4: return dpValue.data[0];
      case 5: return this._bufToUint32(dpValue.data);
      default: throw new Error(`Unsupported datatype: ${dpValue.datatype}`);
    }
  }

  /**
   * Convert a big-endian byte array to an unsigned 32-bit integer.
   *
   * @param {Buffer|Array<number>} buf
   * @returns {number}
   */
  _bufToUint32(buf) {
    let value = 0;
    for (let i = 0; i < buf.length; i++) {
      value = (value << 8) + buf[i];
    }
    return value;
  }

  /**
   * Cleanup when device is deleted
   */
  onDeleted() {
    if (this._availability) {
      this._availability.uninstall();
    }
    this.log(`${this._gangName} removed`);
  }
}

module.exports = ZemismartSwitch6Gang;
