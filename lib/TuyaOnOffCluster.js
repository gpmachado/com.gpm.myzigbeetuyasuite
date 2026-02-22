'use strict';

const { ZCLDataTypes, OnOffCluster } = require('zigbee-clusters');

/**
 * Extends standard OnOff cluster (0x0006) with Tuya-specific attributes.
 *
 * CRITICAL: This cluster MUST be registered via Cluster.addCluster() before
 * device init. Without it, the framework cannot parse Tuya-specific attributes
 * in reportAttributes frames, which causes crosslink between gangs on
 * multi-endpoint devices (TS0002, TS0003, etc.).
 *
 * Attribute map (from device interview + logs):
 *  - 0x0000 onOff          (standard ZCL)
 *  - 0x4001 onTime         (Tuya countdown - seconds until auto-off)
 *  - 0x4002 offWaitTime    (Tuya countdown - must match 0x4001!)
 *  - 0x5000 backlightControl
 *  - 0x8000 childLock
 *  - 0x8001 indicatorMode
 *  - 0x8002 relayStatus     (global power-on behavior)
 *
 * IMPORTANT: For countdown/inching mode on Tuya multi-gang switches:
 * - Set BOTH 0x4001 AND 0x4002 to the SAME value (seconds)
 * - Example: 10 seconds countdown = write { 0x4001: 10, 0x4002: 10 }
 * - Setting to 0 disables countdown
 *
 * @extends OnOffCluster
 */

// Backlight on/off
const enum8BacklightControl = ZCLDataTypes.enum8({
  off: 0x00,
  on: 0x01,
});

// LED indicator behavior (smart plugs)
const enum8IndicatorMode = ZCLDataTypes.enum8({
  off: 0x00,
  status: 0x01,
  position: 0x02,
});

// Global power-on behavior after power loss
const enum8RelayStatus = ZCLDataTypes.enum8({
  off: 0x00,
  on: 0x01,
  remember: 0x02,
});

class TuyaOnOffCluster extends OnOffCluster {

  static get ATTRIBUTES() {
    return {
      ...super.ATTRIBUTES,

      /** 
       * @description Tuya On Time (0x4001 / 16385) - Countdown timer
       * Time in SECONDS until auto-off after turning ON
       * MUST be set together with offWaitTime (0x4002) to same value!
       * 0 = disabled, >0 = countdown in seconds
       */
      onTime: {
        id: 0x4001,
        type: ZCLDataTypes.uint32,
      },

      /** 
       * @description Tuya Off Wait Time (0x4002 / 16386) - Countdown timer
       * Time in SECONDS until auto-off after turning ON
       * MUST be set together with onTime (0x4001) to same value!
       * 0 = disabled, >0 = countdown in seconds
       */
      offWaitTime: {
        id: 0x4002,
        type: ZCLDataTypes.uint32,
      },

      /** @description LED backlight toggle (0x5000 / 20480) */
      backlightControl: {
        id: 0x5000,
        type: enum8BacklightControl,
      },

      /** @description Physical button lock (0x8000 / 32768) */
      childLock: {
        id: 0x8000,
        type: ZCLDataTypes.bool,
      },

      /** @description LED indicator mode (0x8001 / 32769) — smart plugs */
      indicatorMode: {
        id: 0x8001,
        type: enum8IndicatorMode,
      },

      /** @description Global power-on behavior (0x8002 / 32770) — all gangs */
      relayStatus: {
        id: 0x8002,
        type: enum8RelayStatus,
      },
    };
  }
}

module.exports = TuyaOnOffCluster;