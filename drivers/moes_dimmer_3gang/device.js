'use strict';

const { Cluster, debug } = require('zigbee-clusters');
const TuyaSpecificCluster = require('../../lib/TuyaSpecificCluster');
const TuyaSpecificClusterDevice = require('../../lib/TuyaSpecificClusterDevice');
const { AvailabilityManagerCluster0 } = require('../../lib/AvailabilityManager');

debug(false);

Cluster.addCluster(TuyaSpecificCluster);

const DRIVER_NAME = 'MOES 3-Gang Fan Controller';
const DRIVER_VERSION = '2.1.0';

const DP = {
  SWITCH_1: 1,
  SWITCH_2: 2,
  SWITCH_3: 3,
  SPEED_1: 4,
  SPEED_2: 5,
  SPEED_3: 6,
  POWER_ON: 16,
  BACKLIGHT: 17,
};

const POWER_ON_MODE = {
  0: 'off',
  1: 'on',
  2: 'memory',
};

const BACKLIGHT_MODE = {
  0: 'off',
  1: 'normal',
  2: 'inverted',
};

/**
 * MOES 3-Gang Fan Controller (Dimmer) Driver
 * 
 * Version: 2.1.0 - With AvailabilityManager
 * 
 * Architecture:
 * - 1 physical Zigbee device with 1 endpoint
 * - 3 virtual Homey devices (Gang 1-3) sharing the same node
 * - Capabilities: onoff + dim (fan speed control)
 * 
 * Settings:
 * - Per-gang: min/max speed, debouncing, motor protection
 * - Global (Gang 1 only): power-on, backlight, health_monitoring
 */
class MoesDimmer3Gang extends TuyaSpecificClusterDevice {

  async onNodeInit({ zclNode }) {
    await super.onNodeInit({ zclNode });

    const { subDeviceId } = this.getData();
    this._gangName = this._getGangName(subDeviceId);
    this._myDpSwitch = this._getMyDpSwitch(subDeviceId);
    this._myDpSpeed = this._getMyDpSpeed(subDeviceId);
    this._isMain = !subDeviceId;

    this.log(`${DRIVER_NAME} v${DRIVER_VERSION} - ${this._gangName}`);
    if (this._isMain) this.printNode();

    // Debounce state
    this._dimDebounceTimer = null;
    this._pendingDimValue = null;

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
    this.registerCapabilityListener('dim', v => this._onCapabilityDim(v));

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
    
    switch (dp) {
      case DP.SWITCH_1:
      case DP.SWITCH_2:
      case DP.SWITCH_3:
        await this._handleOnOff(dp, value);
        break;
      case DP.SPEED_1:
      case DP.SPEED_2:
      case DP.SPEED_3:
        await this._handleSpeed(dp, value);
        break;
      case DP.POWER_ON:
        await this._handlePowerOn(value);
        break;
      case DP.BACKLIGHT:
        await this._handleBacklight(value);
        break;
    }
  }

  /**
   * Handle on/off state change from device
   */
  async _handleOnOff(dp, value) {
    try {
      const currentValue = this.getCapabilityValue('onoff');
      
      // Anti-flicker
      if (currentValue === value) return;
      
      await this.setCapabilityValue('onoff', value);
      this.log(`${this._gangName} DP${dp}: ${currentValue ? 'ON' : 'OFF'} -> ${value ? 'ON' : 'OFF'}`);
      
    } catch (err) {
      this.error('Failed to update onoff:', err);
    }
  }

  /**
   * Handle speed change from device
   */
  async _handleSpeed(dp, value) {
    try {
      const dimValue = Math.max(0, Math.min(1, value / 100));
      const currentDim = this.getCapabilityValue('dim');
      
      // Anti-flicker with tolerance
      if (Math.abs(currentDim - dimValue) < 0.01) return;
      
      await this.setCapabilityValue('dim', dimValue);
      this.log(`${this._gangName} DP${dp}: ${Math.round(currentDim * 100)}% -> ${value}%`);
      
    } catch (err) {
      this.error('Failed to update dim:', err);
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
    
    this.log(`Device reported powerOnState: ${mode}`);
    
    const currentSetting = this.getSetting('powerOnState');
    if (currentSetting !== mode) {
      this.log(`Syncing setting: ${currentSetting} -> ${mode}`);
      await this.setSettings({ powerOnState: mode }).catch(err => {
        this.error('Failed to sync powerOnState:', err);
      });
    }
  }

  /**
   * Handle backlight mode report from device
   */
  async _handleBacklight(value) {
    if (!this._isMain) return;
    
    const mode = BACKLIGHT_MODE[value];
    if (!mode) {
      this.error(`Invalid backlight value: ${value}`);
      return;
    }
    
    this.log(`Device reported backlightMode: ${mode}`);
    
    const currentSetting = this.getSetting('backlightMode');
    if (currentSetting !== mode) {
      this.log(`Syncing setting: ${currentSetting} -> ${mode}`);
      await this.setSettings({ backlightMode: mode }).catch(err => {
        this.error('Failed to sync backlightMode:', err);
      });
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
      // Motor protection: Set speed BEFORE turning on
      const motorProtection = this.getSetting('enableMotorProtection');
      const motorDelay = this.getSetting('motorStartupDelay') || 1500;
      
      if (value && motorProtection) {
        const currentDim = this.getCapabilityValue('dim');
        const speedPercent = Math.round(currentDim * 100);
        
        this.log(`Motor protection: ${speedPercent}% before ON`);
        await this.writeValue(this._myDpSpeed, speedPercent);
        await this._sleep(motorDelay);
      }
      
      await this.writeBool(this._myDpSwitch, value);
      
    } catch (err) {
      this.error(`${this._gangName} onoff failed:`, err.message);
      throw err;
    }
  }

  /**
   * Handle dim command from Homey (with debouncing)
   */
  async _onCapabilityDim(value) {
    const debouncing = this.getSetting('enableDebouncing');
    const debounceDelay = this.getSetting('debounceDelay') || 800;
    const minSpeed = this.getSetting('minimumBrightness') || 10;
    const maxSpeed = this.getSetting('maximumBrightness') || 100;
    
    // Clamp to min/max
    let speedPercent = Math.round(value * 100);
    speedPercent = Math.max(minSpeed, Math.min(maxSpeed, speedPercent));
    
    this._pendingDimValue = speedPercent;
    
    if (debouncing) {
      // Debounced
      if (this._dimDebounceTimer) {
        clearTimeout(this._dimDebounceTimer);
      }
      
      this._dimDebounceTimer = setTimeout(async () => {
        await this._applyDimValue(this._pendingDimValue);
        this._dimDebounceTimer = null;
      }, debounceDelay);
      
    } else {
      // Immediate
      await this._applyDimValue(speedPercent);
    }
  }

  /**
   * Apply dim value to device
   */
  async _applyDimValue(speedPercent) {
    this.log(`${this._gangName} speed: ${speedPercent}%`);
    
    try {
      await this.writeValue(this._myDpSpeed, speedPercent);
    } catch (err) {
      this.error(`${this._gangName} dim failed:`, err.message);
      throw err;
    }
  }

  /**
   * Handle settings changes
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (!this._isMain) return;

    this.log('Settings changed:', changedKeys);

    for (const key of changedKeys) {
      switch (key) {
        case 'powerOnState':
          await this._handlePowerOnStateSetting(newSettings.powerOnState);
          break;
        case 'backlightMode':
          await this._handleBacklightModeSetting(newSettings.backlightMode);
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
        case 'minimumBrightness':
        case 'maximumBrightness':
        case 'enableDebouncing':
        case 'debounceDelay':
        case 'enableMotorProtection':
        case 'motorStartupDelay':
          this.log(`Local setting: ${key} = ${newSettings[key]}`);
          break;
      }
    }
  }

  /**
   * Handle powerOnState setting change
   */
  async _handlePowerOnStateSetting(newMode) {
    this.log(`Changing powerOnState to: ${newMode}`);
    
    const enumValue = Object.entries(POWER_ON_MODE).find(([, v]) => v === newMode)?.[0];
    
    if (enumValue === undefined) {
      throw new Error(`Invalid powerOnState: ${newMode}`);
    }
    
    try {
      await this.writeEnum(DP.POWER_ON, Number(enumValue));
      this.log(`✓ PowerOnState changed to: ${newMode}`);
    } catch (err) {
      this.error('PowerOnState failed:', err.message);
      throw err;
    }
  }

  /**
   * Handle backlightMode setting change
   */
  async _handleBacklightModeSetting(newMode) {
    this.log(`Changing backlightMode to: ${newMode}`);
    
    const enumValue = Object.entries(BACKLIGHT_MODE).find(([, v]) => v === newMode)?.[0];
    
    if (enumValue === undefined) {
      throw new Error(`Invalid backlightMode: ${newMode}`);
    }
    
    try {
      await this.writeEnum(DP.BACKLIGHT, Number(enumValue));
      this.log(`✓ BacklightMode changed to: ${newMode}`);
    } catch (err) {
      this.error('BacklightMode failed:', err.message);
      throw err;
    }
  }

  /**
   * Get all gang devices for this physical node
   */
  _getNodeDevices() {
    const myIeee = this.getData().ieeeAddress;
    return this.driver.getDevices().filter(d => {
      try { return d.getData().ieeeAddress === myIeee; } catch { return false; }
    });
  }

  _getMyDpSwitch(subDeviceId) {
    const map = { secondGang: DP.SWITCH_2, thirdGang: DP.SWITCH_3 };
    return map[subDeviceId] || DP.SWITCH_1;
  }

  _getMyDpSpeed(subDeviceId) {
    const map = { secondGang: DP.SPEED_2, thirdGang: DP.SPEED_3 };
    return map[subDeviceId] || DP.SPEED_1;
  }

  _getGangName(subDeviceId) {
    const map = { secondGang: 'Gang 2', thirdGang: 'Gang 3' };
    return map[subDeviceId] || 'Gang 1';
  }

  _isMyDp(dp) {
    if (this._isMain) {
      return dp === this._myDpSwitch || 
             dp === this._myDpSpeed || 
             dp === DP.POWER_ON || 
             dp === DP.BACKLIGHT;
    }
    return dp === this._myDpSwitch || dp === this._myDpSpeed;
  }

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

  _bufToUint32(buf) {
    let value = 0;
    for (let i = 0; i < buf.length; i++) {
      value = (value << 8) + buf[i];
    }
    return value;
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  onDeleted() {
    if (this._availability) {
      this._availability.uninstall();
    }
    if (this._dimDebounceTimer) {
      clearTimeout(this._dimDebounceTimer);
    }
    this.log(`${this._gangName} removed`);
  }
}

module.exports = MoesDimmer3Gang;
