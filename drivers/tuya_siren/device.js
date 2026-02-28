'use strict';

const { Cluster } = require('zigbee-clusters');
const TuyaSpecificCluster = require('../../lib/TuyaSpecificCluster');
const TuyaSpecificClusterDevice = require('../../lib/TuyaSpecificClusterDevice');
const { AvailabilityManagerCluster0 } = require('../../lib/AvailabilityManager');
/**
 * Parse a Tuya datapoint value into a JS type.
 *
 * @param {Object} dpValue
 * @param {number} dpValue.datatype - Tuya datatype (0=raw,1=bool,2=value,3=string,4=enum,5=bitmap)
 * @param {Buffer|Array<number>} dpValue.data
 * @returns {boolean|number|string|Buffer}
 */
function getDataValue(dpValue) {
  const data = dpValue.data;
  switch (dpValue.datatype) {
    case 0: return data;
    case 1: return data[0] === 1;
    case 2: return data.reduce((acc, b) => (acc << 8) | b, 0);
    case 3: return String.fromCharCode(...data);
    case 4: return data[0];
    case 5: return data.reduce((acc, b) => (acc << 8) | b, 0);
    default: throw new Error(`Unsupported datatype: ${dpValue.datatype}`);
  }
}


Cluster.addCluster(TuyaSpecificCluster);

const DRIVER_NAME = 'Tuya Siren';
const DRIVER_VERSION = '2.3.0';

/**
 * Retry configuration
 */
const RETRY_CONFIG = {
  CRITICAL: { retries: 5, delay: 300 },
  SETTINGS: { retries: 3, delay: 400 },
};

/**
 * Tuya datapoints
 */
const DP = {
  VOLUME: 5,
  DURATION: 7,
  ALARM: 13,
  BATTERY: 15,
  MELODY: 21,
};

/**
 * Tuya Neo Smart Siren Driver
 * 
 * Version: 2.3.0 - COMPLETE (balanced + condition)
 * 
 * Design:
 * - Settings = Default configuration
 * - Capability onoff = Use defaults
 * - Flow action = Override melody + duration
 * - Flow condition = Check if playing
 * - Flow triggers = When activated/deactivated
 */
class TuyaNeoSiren extends TuyaSpecificClusterDevice {

  async onNodeInit({ zclNode }) {
    this.log(`${DRIVER_NAME} v${DRIVER_VERSION} - Initializing`);
    this.printNode();

    // Setup Tuya listeners
    this._setupTuyaListeners(zclNode);

    // Install availability monitoring
    this._availability = new AvailabilityManagerCluster0(this, {
      timeout: 25 * 60 * 1000,
    });
    await this._availability.install();

    // Register capabilities
    if (!this.hasCapability('measure_battery')) {
      await this.addCapability('measure_battery');
    }

    this.registerCapabilityListener('onoff', v => this._onCapabilityOnOff(v));

    // Register flow cards
    this._registerFlowCards();

    this.log(`${DRIVER_NAME} ready`);
  }

  /**
   * Setup Tuya cluster event listeners
   */
  _setupTuyaListeners(zclNode) {
    const tuya = zclNode.endpoints?.[1]?.clusters?.tuya;

    if (!tuya) {
      this.error('Tuya cluster not found');
      return;
    }

    const handleTuya = (data) => this._processDatapoint(data);

    tuya.on('response', handleTuya);
    tuya.on('reporting', handleTuya);
    tuya.on('datapoint', handleTuya);

    this.log('Tuya listeners attached');
  }

  /**
   * Process incoming Tuya datapoint
   */
  _processDatapoint(data) {
    const dp = data?.dp;
    const value = getDataValue(data);

    switch (dp) {
      case DP.ALARM:
        this._handleAlarmState(value);
        break;

      case DP.VOLUME:
        this._syncSetting('alarmvolume', String(value));
        break;

      case DP.DURATION:
        this._syncSetting('alarmsoundtime', value);
        break;

      case DP.MELODY:
        this._syncSetting('alarmtune', String(value));
        break;

      case DP.BATTERY:
        if (typeof value === 'number' && value >= 0 && value <= 100) {
          this.setCapabilityValue('measure_battery', value).catch(this.error);
        }
        break;
    }
  }

  /**
   * Handle alarm state change from device
   */
  _handleAlarmState(value) {
    const currentValue = this.getCapabilityValue('onoff');
    if (currentValue === value) return;

    this.setCapabilityValue('onoff', value).catch(this.error);

    // Trigger flow cards
    if (value) {
      const duration = this.getSetting('alarmsoundtime') || 10;
      this._triggerFlow('siren_activated', { duration });
    } else {
      this._triggerFlow('siren_deactivated', { reason: 'auto' });
    }
  }

  /**
   * Sync setting from device
   */
  _syncSetting(key, value) {
    const current = this.getSetting(key);
    if (current != value) {
      this.setSettings({ [key]: value }).catch(this.error);
    }
  }

  /**
   * Handle on/off capability (uses Settings defaults)
   */
  async _onCapabilityOnOff(value) {
    if (value) {
      await this._startSiren();
    } else {
      await this._stopSiren();
    }
  }

  /**
   * Start siren with Settings defaults
   */
  async _startSiren() {
    const melody = Number(this.getSetting('alarmtune') || '5');
    const volume = Number(this.getSetting('alarmvolume') || '2');
    const duration = Number(this.getSetting('alarmsoundtime') || 10);

    await this._playSiren(melody, volume, duration);
  }

  /**
   * Play siren with specific parameters
   * @param {number} melody - Melody ID (0-17)
   * @param {number} volume - Volume (0-2)
   * @param {number} duration - Duration in seconds
   */
  async _playSiren(melody, volume, duration) {
    this.log(`[Siren] Playing: melody=${melody}, volume=${volume}, duration=${duration}s`);

    // Send settings in bulk
    await this.sendBulkCommands([
      { type: 'enum', dp: DP.MELODY, value: melody },
      { type: 'enum', dp: DP.VOLUME, value: volume },
      { type: 'data32', dp: DP.DURATION, value: duration },
    ], 200);

    // Start alarm (critical)
    await this.writeBool(
      DP.ALARM,
      true,
      RETRY_CONFIG.CRITICAL.retries,
      RETRY_CONFIG.CRITICAL.delay
    );

    this.log('[Siren] Started');
  }

  /**
   * Stop siren
   */
  async _stopSiren() {
    await this.writeBool(
      DP.ALARM,
      false,
      RETRY_CONFIG.CRITICAL.retries,
      RETRY_CONFIG.CRITICAL.delay
    );

    this._triggerFlow('siren_deactivated', { reason: 'manual' });
    this.log('[Siren] Stopped');
  }

  /**
   * Check if siren is currently playing
   * Used by Flow condition card
   * @returns {boolean}
   */
  _isPlaying() {
    return this.getCapabilityValue('onoff') === true;
  }

  /**
   * Register flow cards
   */
  _registerFlowCards() {
    // Action: Play with specific melody + duration
    const actionPlay = this.homey.flow.getActionCard('siren_play');
    if (actionPlay) {
      actionPlay.registerRunListener(async (args) => {
        const melody = Number(args.melody);
        const duration = Number(args.duration);
        const volume = Number(this.getSetting('alarmvolume') || '2');

        await this._playSiren(melody, volume, duration);
      });
    }

    // Condition: Is siren playing?
    const conditionIsPlaying = this.homey.flow.getConditionCard('is_playing');
    if (conditionIsPlaying) {
      conditionIsPlaying.registerRunListener(async () => {
        return this._isPlaying();
      });
    }
  }

  /**
   * Trigger flow card
   */
  _triggerFlow(flowId, tokens = {}) {
    try {
      const trigger = this.homey.flow.getDeviceTriggerCard(flowId);
      if (trigger) {
        trigger.trigger(this, tokens, {});
      }
    } catch (err) {
      this.error('[Siren] Flow trigger failed:', flowId, err);
    }
  }

  /**
   * Handle settings changes
   */
  async onSettings({ newSettings, changedKeys }) {
    for (const key of changedKeys) {
      switch (key) {
        case 'alarmvolume':
          const volume = Number(newSettings[key]);
          if (volume < 0 || volume > 2) {
            throw new Error('Volume must be 0-2');
          }
          await this.writeEnum(
            DP.VOLUME,
            volume,
            RETRY_CONFIG.SETTINGS.retries,
            RETRY_CONFIG.SETTINGS.delay
          );
          break;

        case 'alarmsoundtime':
          const duration = Number(newSettings[key]);
          if (duration < 1 || duration > 1800) {
            throw new Error('Duration must be 1-1800 seconds');
          }
          await this.writeData32(
            DP.DURATION,
            duration,
            RETRY_CONFIG.SETTINGS.retries,
            RETRY_CONFIG.SETTINGS.delay
          );
          break;

        case 'alarmtune':
          const melody = Number(newSettings[key]);
          if (melody < 0 || melody > 17) {
            throw new Error('Melody must be 0-17');
          }
          await this.writeEnum(
            DP.MELODY,
            melody,
            RETRY_CONFIG.SETTINGS.retries,
            RETRY_CONFIG.SETTINGS.delay
          );
          break;

        case 'health_monitoring_enabled':
          if (newSettings.health_monitoring_enabled) {
            await this._availability.install();
          } else {
            await this._availability.uninstall();
          }
          break;
      }
    }
  }

  /**
   * Cleanup
   */
  onDeleted() {
    if (this._availability) {
      this._availability.uninstall();
    }
    this.log(`${DRIVER_NAME} removed`);
  }
}

module.exports = TuyaNeoSiren;
