/**
 * NovaDigital 3-Gang Wall Switch Driver
 *
 * Pairing and sub-device configuration handled by driver.compose.json.
 * All device logic lives in device.js.
 */
'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

const BUILD = '2026-02-10.1';

class NovaDigitalSwitch2GangDriver extends ZigBeeDriver {

  async onInit() {
    await super.onInit();
    this.log(`NovaDigital 2-Gang Driver initialized (build=${BUILD})`);
  }
}

module.exports = NovaDigitalSwitch2GangDriver;
