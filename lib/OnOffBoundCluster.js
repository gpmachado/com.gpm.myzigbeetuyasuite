'use strict';
const { BoundCluster } = require('zigbee-clusters');

class OnOffBoundCluster extends BoundCluster {
  constructor({ onSetOn, onSetOff, onToggle } = {}) {
    super();
    this._onSetOn = onSetOn;
    this._onSetOff = onSetOff;
    this._onToggle = onToggle;
  }

  setOn() { if (this._onSetOn) this._onSetOn(); }
  on() { if (this._onSetOn) this._onSetOn(); }  // alias
  
  setOff() { if (this._onSetOff) this._onSetOff(); }
  off() { if (this._onSetOff) this._onSetOff(); }  // alias
  
  toggle() { if (this._onToggle) this._onToggle(); }
}

module.exports = OnOffBoundCluster;