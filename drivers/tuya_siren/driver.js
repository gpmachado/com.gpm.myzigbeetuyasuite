'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

const DRIVER_NAME = 'Tuya Siren';
const DRIVER_VERSION = '2.3.0';

/**
 * TuyaSirenDriver
 *
 * Driver for the NEO Smart Siren (TS0601 / _TZE204_q76rtoa9).
 * Single-device driver — no sub-devices, no pairing list required.
 * All logic lives in device.js (TuyaNeoSiren).
 */
class TuyaSirenDriver extends ZigBeeDriver {

  async onInit() {
    this.log(`${DRIVER_NAME} Driver v${DRIVER_VERSION} - Ready`);
  }

  onUninit() {
    this.log(`${DRIVER_NAME} Driver - Stopped`);
  }
}

module.exports = TuyaSirenDriver;
