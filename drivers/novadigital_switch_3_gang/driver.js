/**
 * NovaDigital 3-Gang Wall Switch Driver
 * 
 * Pairing and sub-device configuration is handled in driver.compose.json
 * This driver class is intentionally minimal - all logic is in device.js
 */

'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

const BUILD = '2026-02-09.1';

class NovaDigitalSwitch3GangDriver extends ZigBeeDriver {
  
  async onInit() {
    await super.onInit();
    this.log(`NovaDigital 3-Gang Driver initialized (build=${BUILD})`);
  }

}

module.exports = NovaDigitalSwitch3GangDriver;
