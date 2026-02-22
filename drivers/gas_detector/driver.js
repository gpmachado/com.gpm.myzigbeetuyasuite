'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

/**
 * GasDetectorDriver
 * Smart Gas Detector (TS0204 / _TYZB01_0w3d5uw3).
 * Single device, no sub-devices. All logic in device.js.
 */
class GasDetectorDriver extends ZigBeeDriver {
  onInit()   { this.log('Smart Gas Detector Driver - Ready'); }
  onUninit() { this.log('Smart Gas Detector Driver - Stopped'); }
}

module.exports = GasDetectorDriver;
