'use strict';

const { Cluster, debug } = require('zigbee-clusters');
const TuyaSpecificCluster = require('../../lib/TuyaSpecificCluster');
const TuyaSpecificClusterDevice = require('../../lib/TuyaSpecificClusterDevice');
const { AvailabilityManagerCluster0 } = require('../../lib/AvailabilityManager');

debug(false);

Cluster.addCluster(TuyaSpecificCluster);

const DRIVER_NAME = 'NovaDigital 4-Gang';
const DRIVER_VERSION = '2.3.0';

/**
 * Retry configuration for Tuya commands
 * 
 * Exponential backoff formula: delay * 2^attempt
 * Example with retries=5, delay=300ms:
 *   Attempt 1: 0ms (immediate)
 *   Attempt 2: 300ms
 *   Attempt 3: 600ms
 *   Attempt 4: 1200ms
 *   Attempt 5: 2400ms
 *   Attempt 6: 4800ms
 *   Total: ~9.3s max
 */
const RETRY_CONFIG = {
  COMMANDS: { 
    retries: 5,    // User commands (onoff) - most critical
    delay: 300,    // Base delay in ms
  },
  SETTINGS: { 
    retries: 3,    // Settings changes - less critical
    delay: 400,    // Slightly longer delay
  },
};

const DP = {
  GANG1: 1,
  GANG2: 2,
  GANG3: 3,
  GANG4: 4,
  POWER_ON: 14,
};

const POWER_ON_MODE = {
  0: 'off',
  1: 'on',
  2: 'memory',
};

const POWER_ON_LABELS = {
  'off': 'Always Off',
  'on': 'Always On',
  'memory': 'Remember Last State'
};

/**
 * NovaDigital 4-Gang Tuya Wall Switch Driver
 * 
 * Version: 2.3.0 - With AvailabilityManager + Retry
 * 
 * Features:
 * - Automatic availability detection (handleFrame hook)
 * - Exponential backoff retry on commands
 * - Configurable retry per command type
 * - Command debouncing (prevent spam)
 * - Power-on behavior configuration
 */
class NovaDigitalSwitch4Gang extends TuyaSpecificClusterDevice {

  async onNodeInit({ zclNode }) {
    await super.onNodeInit({ zclNode });

    const { subDeviceId } = this.getData();
    this._gangName = this._getGangName(subDeviceId);
    this._myDp = this._getMyDp(subDeviceId);
    this._isMain = !subDeviceId;

    // Command debouncing
    this._commandPending = false;

    this.log(`${DRIVER_NAME} v${DRIVER_VERSION} - ${this._gangName}`);
    if (this._isMain) this.printNode();

    // Setup Tuya listeners (once per physical device)
    if (this._isMain) {
      this._setupTuyaListeners(zclNode);
      
      // Install availability monitoring
      this._availability = new AvailabilityManagerCluster0(this, {
        timeout: 25 * 60 * 1000,  // 25min for AC-powered Tuya
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
        target._processDatapoint(data).catch(e => this.error('Datapoint processing error:', e));
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
    
    switch (dp) {
      case DP.GANG1:
      case DP.GANG2:
      case DP.GANG3:
      case DP.GANG4:
        await this._handleOnOff(dp, value);
        break;
      case DP.POWER_ON:
        await this._handlePowerOn(value);
        break;
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
   * Handle power-on behavior report from device
   */
  async _handlePowerOn(value) {
    if (!this._isMain) return;
    
    const mode = POWER_ON_MODE[value];
    if (!mode) {
      this.error(`Invalid power-on value: ${value}`);
      return;
    }
    
    this.log(`Device reported powerOnBehavior: ${mode}`);
    
    const currentSetting = this.getSetting('power_on_behavior');
    if (currentSetting !== mode) {
      this.log(`Syncing Homey setting: ${currentSetting} -> ${mode}`);
      await this.setSettings({ 
        power_on_behavior: mode,
        power_on_current: POWER_ON_LABELS[mode]
      }).catch(err => {
        this.error('Failed to sync setting:', err);
      });
    } else {
      await this.setSettings({ 
        power_on_current: POWER_ON_LABELS[mode]
      }).catch(() => {});
    }
  }

  /**
   * Handle on/off command from Homey
   */
  async _onCapabilityOnOff(value) {
    // Anti-flicker
    if (this.getCapabilityValue('onoff') === value) return;
    
    // Debounce: prevent duplicate commands
    if (this._commandPending) {
      this.log(`${this._gangName} command already pending, skipping`);
      return;
    }
    
    this._commandPending = true;
    
    try {
      this.log(`${this._gangName} command: ${value ? 'ON' : 'OFF'}`);
      
      await this.writeBool(
        this._myDp, 
        value, 
        RETRY_CONFIG.COMMANDS.retries,
        RETRY_CONFIG.COMMANDS.delay
      );
      
    } catch (err) {
      this.error(`${this._gangName} command failed:`, err.message);
      throw err;
      
    } finally {
      this._commandPending = false;
    }
  }

  /**
   * Handle settings changes
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (!this._isMain) return;

    this.log('Settings change detected:', changedKeys);

    for (const key of changedKeys) {
      switch (key) {
        case 'power_on_behavior':
          await this._handlePowerOnBehaviorSetting(newSettings.power_on_behavior);
          break;
          
        case 'health_monitoring_enabled':
          if (newSettings.health_monitoring_enabled) {
            this.log('Health monitoring enabled');
            await this._availability.install();
          } else {
            this.log('Health monitoring disabled');
            await this._availability.uninstall();
          }
          break;
          
        case 'power_on_current':
          // Read-only label - ignore
          break;
          
        default:
          this.log(`Unhandled setting: ${key}`);
      }
    }
  }

  /**
   * Handle power_on_behavior setting change
   */
  async _handlePowerOnBehaviorSetting(newMode) {
    this.log(`Changing powerOnBehavior to: ${newMode}`);
    
    const enumValue = Object.entries(POWER_ON_MODE).find(([, v]) => v === newMode)?.[0];
    
    if (enumValue === undefined) {
      throw new Error(`Invalid power_on_behavior: ${newMode}`);
    }
    
    try {
      await this.writeEnum(
        DP.POWER_ON, 
        Number(enumValue),
        RETRY_CONFIG.SETTINGS.retries,
        RETRY_CONFIG.SETTINGS.delay
      );
      this.log(`✓ PowerOnBehavior changed to: ${newMode}`);
      
    } catch (err) {
      this.error('PowerOnBehavior command failed:', err.message);
      throw err;
    }
  }

  _getNodeDevices() {
    const myIeee = this.getData().ieeeAddress;
    return this.driver.getDevices().filter(d => {
      try { return d.getData().ieeeAddress === myIeee; } catch { return false; }
    });
  }

  _getMyDp(subDeviceId) {
    const map = {
      secondGang: DP.GANG2,
      thirdGang: DP.GANG3,
      fourthGang: DP.GANG4,
    };
    return map[subDeviceId] || DP.GANG1;
  }

  _getGangName(subDeviceId) {
    const map = {
      secondGang: 'Gang 2',
      thirdGang: 'Gang 3',
      fourthGang: 'Gang 4',
    };
    return map[subDeviceId] || 'Gang 1';
  }

  _isMyDp(dp) {
    if (this._isMain) {
      return dp === DP.GANG1 || dp === DP.POWER_ON;
    }
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

  onDeleted() {
    if (this._availability) {
      this._availability.uninstall();
    }
    this.log(`${this._gangName} removed`);
  }
}

module.exports = NovaDigitalSwitch4Gang;
