'use strict';

const Homey = require('homey');



class MyZigbeeTuyaSuiteApp extends Homey.App {
  onInit() {
    this.log("My Zigbee Tuya initiating...");
  }
};

module.exports = MyZigbeeTuyaSuiteApp;