/**
 * File: driver.js (6-Gang)
 * Device: NovaDigital 6-Gang Wall Switch Driver
 * Version: 3.2.4
 * Date: 2026-02-14
 *
 * Supports: TS0601 / _TZE200_r731zlxk
 * Architecture: Single EP1 Tuya cluster, 6 sub-devices (Gang 1–6)
 */

'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

class NovaDigitalSwitch6GangDriver extends ZigBeeDriver {

  onInit() {
    this.log('NovaDigital 6-Gang Driver v3.2.4 - Ready');
    this.log('Supporting TS0601: _TZE200_r731zlxk');
  }

  async onPairListDevices() {
    return [];
  }
}

module.exports = NovaDigitalSwitch6GangDriver;
