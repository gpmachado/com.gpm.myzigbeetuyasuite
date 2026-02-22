'use strict';

const { Cluster, ZCLDataTypes } = require('zigbee-clusters');

/**
 * Tuya E001 Cluster (0xE001 / 57345)
 * 
 * Controls power-on behavior INDIVIDUALLY per endpoint/gang.
 * Present on all endpoints of multi-gang switches (TS0002, TS0003).
 *
 * This is separate from the GLOBAL power-on behavior in the
 * TuyaOnOffCluster (0x0006, attribute relayStatus 0x8002).
 *
 * Attributes:
 *  - powerOnstate (0xD010)  - per-gang power-on behavior
 *    0 = always off, 1 = always on, 2 = recover last state
 *  - tuyaMagic (0xD011) - Tuya magic value (pairing)
 *  - switchMode (0xD030) -  External switch type
 *    0 = Toggle, 1 = State, 2 = Momentary
 *
 * @extends Cluster
 */

const enum8PowerOnState = ZCLDataTypes.enum8({
  off: 0,
  on: 1,
  recover: 2,
});

const enum8SwitchMode = ZCLDataTypes.enum8({
  toggle: 0,
  state: 1,
  momentary: 2,
});

class TuyaPowerOnStateCluster extends Cluster {

  static get ID() {
    return 0xE001; // 57345
  }

  static get NAME() {
    return 'tuyaPowerOnState';
  }

  static get ATTRIBUTES() {
    return {
      /** Per-gang power-on behavior (0xD010) */
      powerOnstate: {
        id: 0xD010,
        type: enum8PowerOnState,
      },
      
      /** Tuya magic value (0xD011) - used during pairing */
      tuyaMagic: {
        id: 0xD011,
        type: ZCLDataTypes.uint8,
      },
      
      /** External switch type (0xD030) - Toggle/State/Momentary */
      switchMode: {
        id: 0xD030,
        type: enum8SwitchMode,
      },
    };
  }

  static get COMMANDS() {
    return {};
  }
}

// Export useful constants
TuyaPowerOnStateCluster.POWER_ON_BEHAVIOR = {
  OFF: 0,
  ON: 1,
  LAST_STATE: 2,
  RECOVER: 2, // Alias for LAST_STATE
};

TuyaPowerOnStateCluster.SWITCH_MODE = {
  TOGGLE: 0,
  STATE: 1,
  MOMENTARY: 2,
};

module.exports = TuyaPowerOnStateCluster;