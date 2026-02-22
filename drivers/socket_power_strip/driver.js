/*
 * Driver for TS011F _TZ3000_cfnprab5 Power Strip
 * Version: 1.9
 * Author: Homey Driver
 * Description: Basic driver class with Tuya relay status support
 */

'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

class socket_power_strip extends ZigBeeDriver {

    async onInit() {
        this.log('Power Strip Driver version 1.9 initialized');
    }

}

module.exports = socket_power_strip;