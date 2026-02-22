/**
 * File: driver.js - MOES 3-Gang Fan Controller Driver
 * Version: 2.1.0 - Optimized
 * Author: Gabriel
 */

'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

class Fan3GangMoesDriver extends ZigBeeDriver {

  async onInit() {
    this.log('MOES 3-Gang Fan Controller Driver initialized');
  }

}

module.exports = Fan3GangMoesDriver;
