'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

/**
 * Driver for LCD Temperature & Humidity Sensor TS0201
 * Manufacturer: _TZ3000_ywagc4rj
 */
class LCDTempHumidSensorDriver extends ZigBeeDriver {

  onInit() {
    this.log('LCD Temp/Hum Sensor driver v1.1.0 initialized');
  }

}

module.exports = LCDTempHumidSensorDriver;