/**
 * File: driver.js
 * Driver: Smart Plug with Energy Metering (TS0121/TS011F)
 * Version: 3.0.0
 * Date: 2026-01-26
 * Manufacturers: Multiple Tuya manufacturers
 */
'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

class SmartPlugDriver extends ZigBeeDriver {

  async onInit() {
    this.log('Smart Plug Driver v3.0.0 initialized');
    this.log('Supported models: TS0121, TS011F (with energy metering)');
  }

}

module.exports = SmartPlugDriver;
