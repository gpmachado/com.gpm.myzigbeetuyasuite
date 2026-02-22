/**
 * File: driver.js
 * Device: NovaDigital 4-Gang Wall Switch Driver
 * Version: 3.2.3
 * Date: 2026-02-13
 * 
 * Description:
 * - Driver for NovaDigital TS0601 4-gang Tuya switches
 * - Supports manufacturers: _TZE200_shkxsgis, _TZE204_aagrxlbd
 * - Single endpoint with Tuya cluster (4 sub-devices)
 * - Health monitoring + Retry policy + Clean logs
 */

'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

class NovaDigitalSwitch4GangDriver extends ZigBeeDriver {

    onInit() {
        this.log('NovaDigital 4-Gang Driver initialized (build=2026-02-13.1)');
    }

}

module.exports = NovaDigitalSwitch4GangDriver;
