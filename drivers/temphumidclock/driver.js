'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

/**
 * Driver for LCD Temperature & Humidity Sensor with Clock
 */
class LCDTHClockDriver extends ZigBeeDriver {

  onInit() {
    this.log('LCD Temp/Hum Sensor driver v1.1.0 initialized');
  }

}

module.exports = LCDTHClockDriver;