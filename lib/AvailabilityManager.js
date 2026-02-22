'use strict';

/**
 * @file AvailabilityManager.js
 * @description Modular Zigbee device availability tracking.
 *
 * Strategies:
 * - {@link AvailabilityManagerCluster0}: Tuya EF00 devices — passive handleFrame hook,
 *   captures every inbound frame with zero network traffic.
 * - {@link AvailabilityManagerCluster6}: ZCL Standard devices — relies on the device
 *   calling `this._markAliveFromAvailability(source)` from its own reportParser / event
 *   handlers. Suitable when Cluster0 hook is unavailable (e.g. ZigBeeDevice subclass
 *   that does not expose the raw node).
 *
 * Multi-gang cascade:
 * {@link AvailabilityManagerBase#_getSiblings} resolves all Homey device instances that
 * share the same physical Zigbee node so that a single timeout marks / restores all
 * virtual gangs atomically.
 *
 * Sibling resolution strategy (in priority order):
 *   1. Same `ieeeAddress` in getData() — covers main + sub-devices that carry ieeeAddress.
 *   2. Same `token` in getData() — Homey stores a shared token on some sub-device
 *      configurations; used as fallback when ieeeAddress is absent on sub-devices.
 *   3. Self only — single-endpoint devices or any device whose getData() lacks both fields.
 *
 * @version 2.1.0
 *
 * @example Tuya EF00 (4-gang, 6-gang, dimmer)
 * ```js
 * const { AvailabilityManagerCluster0 } = require('../../lib/AvailabilityManager');
 *
 * class MyTuyaDevice extends TuyaSpecificClusterDevice {
 *   async onNodeInit({ zclNode }) {
 *     if (this._isMain) {
 *       this._availability = new AvailabilityManagerCluster0(this, {
 *         timeout: 25 * 60 * 1000,
 *       });
 *       await this._availability.install();
 *     }
 *   }
 * }
 * ```
 *
 * @example ZCL Standard (smart plug, 1-gang)
 * ```js
 * const { AvailabilityManagerCluster0 } = require('../../lib/AvailabilityManager');
 *
 * class MyDevice extends ZigBeeDevice {
 *   async onNodeInit({ zclNode }) {
 *     this._availability = new AvailabilityManagerCluster0(this, {
 *       timeout: 10 * 60 * 1000,
 *     });
 *     await this._availability.install();
 *   }
 * }
 * ```
 */

// ─────────────────────────────────────────────────────────────────────────────
// Base
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @class AvailabilityManagerBase
 * @abstract
 */
class AvailabilityManagerBase {

  /**
   * @param {import('homey-zigbeedriver').ZigBeeDevice} device - Main (or only) device instance.
   * @param {Object} options
   * @param {number} options.timeout - Inactivity timeout in ms before marking unavailable.
   * @param {number} [options.checkInterval=60000] - Watchdog tick interval in ms.
   * @param {string} [options.settingKey='health_monitoring_enabled'] - Device setting key that
   *   enables/disables monitoring. Set to `false` to disable the check entirely.
   */
  constructor(device, options = {}) {
    if (!device) throw new Error('[Availability] device is required');
    if (!options.timeout || options.timeout <= 0) throw new Error('[Availability] timeout must be positive');

    this.device = device;
    this.options = {
      checkInterval: 60 * 1000,
      settingKey: 'health_monitoring_enabled',
      ...options,
    };

    this._watchdogInterval = null;
    this._installed = false;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Returns false only when the device setting explicitly disables monitoring.
   * @returns {boolean}
   */
  _isEnabled() {
    try {
      const settings = this.device.getSettings?.() ?? {};
      return settings[this.options.settingKey] !== false;
    } catch (err) {
      this.device.error('[Availability] _isEnabled error:', err.message);
      return true;
    }
  }

  /**
   * Record activity: persist timestamp, update Homey UI, restore availability if lost.
   *
   * @param {string} source - Human-readable label for log (e.g. 'cluster 0xef00').
   */
  async _markAlive(source) {
    try {
      await this.device.setStoreValue('last_seen_ts', Date.now()).catch(() => {});
      this.device.setLastSeenAt?.();

      if (!this.device.getAvailable()) {
        this.device.log(`[Availability] Restoring (${source})`);
        await this._markAllAvailable();
      }
    } catch (err) {
      this.device.error('[Availability] _markAlive error:', err.message);
    }
  }

  // ── Watchdog ──────────────────────────────────────────────────────────────

  /** Start the periodic inactivity watchdog. */
  _startWatchdog() {
    if (this._watchdogInterval) {
      this.device.error('[Availability] Watchdog already running');
      return;
    }

    this.device.log('[Availability] Watchdog started');

    this._watchdogInterval = this.device.homey.setInterval(async () => {
      try {
        if (!this._isEnabled()) return;

        let lastSeen;
        try {
          lastSeen = await this.device.getStoreValue('last_seen_ts');
        } catch {
          lastSeen = null;
        }

        if (!lastSeen) {
          await this.device.setStoreValue('last_seen_ts', Date.now()).catch(() => {});
          return;
        }

        const idle    = Date.now() - lastSeen;
        const idleMin = Math.round(idle / 60000);

        if (idleMin % 5 === 0 && idleMin > 0) {
          this.device.log(`[Availability] Idle: ${idleMin}min / ${Math.round(this.options.timeout / 60000)}min`);
        }

        if (this.device.getAvailable() && idle > this.options.timeout) {
          this.device.log(`[Availability] Timeout — no activity for ${idleMin}min`);
          await this._markAllUnavailable(`No activity for ${idleMin}min`);
        }
      } catch (err) {
        this.device.error('[Availability] Watchdog error:', err.message);
      }
    }, this.options.checkInterval);
  }

  /** Stop the watchdog interval. */
  _stopWatchdog() {
    if (this._watchdogInterval) {
      this.device.homey.clearInterval(this._watchdogInterval);
      this._watchdogInterval = null;
      this.device.log('[Availability] Watchdog stopped');
    }
  }

  // ── Sibling cascade ───────────────────────────────────────────────────────

  /**
   * Restore all sibling devices.
   */
  async _markAllAvailable() {
    for (const sibling of this._getSiblings()) {
      if (!sibling.getAvailable()) {
        sibling.log('[Availability] Available');
        await sibling.setAvailable().catch(() => {});
      }
    }
  }

  /**
   * Mark all sibling devices unavailable.
   *
   * @param {string} reason
   */
  async _markAllUnavailable(reason) {
    for (const sibling of this._getSiblings()) {
      if (sibling.getAvailable()) {
        sibling.log(`[Availability] Unavailable: ${reason}`);
        await sibling.setUnavailable(reason).catch(() => {});
      }
    }
  }

  /**
   * Resolve all Homey device instances that share this physical Zigbee node.
   *
   * Resolution order:
   *   1. ieeeAddress match — present on main and most sub-devices.
   *   2. token match — fallback for sub-devices that lack ieeeAddress.
   *   3. Self only — single-endpoint devices or unrecognised data shapes.
   *
   * @returns {Array<import('homey-zigbeedriver').ZigBeeDevice>}
   */
  _getSiblings() {
    try {
      const myData = this.device.getData();
      const myIeee = myData?.ieeeAddress;
      const myToken = myData?.token;

      const allDevices = this.device.driver.getDevices();

      // Strategy 1: ieeeAddress
      if (myIeee) {
        const byIeee = allDevices.filter(d => {
          try { return d.getData().ieeeAddress === myIeee; } catch { return false; }
        });
        if (byIeee.length > 0) return byIeee;
      }

      // Strategy 2: token (sub-device fallback)
      if (myToken) {
        const byToken = allDevices.filter(d => {
          try { return d.getData().token === myToken; } catch { return false; }
        });
        if (byToken.length > 0) return byToken;
      }

      // Strategy 3: self only
      return [this.device];
    } catch (err) {
      this.device.error('[Availability] _getSiblings error:', err.message);
      return [this.device];
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Stop watchdog and clean up.
   */
  async uninstall() {
    if (!this._installed) return;
    this._stopWatchdog();
    await this._cleanup();
    this._installed = false;
    this.device.log('[Availability] Uninstalled');
  }

  /**
   * Subclass cleanup hook.
   * @protected
   */
  async _cleanup() {}

  /**
   * Install monitoring. Must be implemented by subclasses.
   * @abstract
   */
  async install() {
    throw new Error('install() must be implemented by subclass');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cluster0 — passive handleFrame hook
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @class AvailabilityManagerCluster0
 * @extends AvailabilityManagerBase
 *
 * Hooks `node.handleFrame` to detect ANY inbound Zigbee frame (Basic cluster
 * keep-alives, Tuya EF00 events, poll responses, etc.) with zero extra traffic.
 *
 * Use for:
 * - Tuya EF00 multi-gang switches / dimmers
 * - ZCL devices where poll responses should count as activity (smart plugs)
 *
 * Note: `handleFrame` is called for every frame arriving at the node, including
 * responses to coordinator-initiated read attribute requests, so this strategy
 * correctly recovers availability as soon as a device responds to any poll.
 */
class AvailabilityManagerCluster0 extends AvailabilityManagerBase {

  /**
   * Install the handleFrame hook and start the watchdog.
   */
  async install() {
    if (this._installed) {
      this.device.error('[Availability] Already installed');
      return;
    }

    if (!this._isEnabled()) {
      this.device.log('[Availability] Disabled by setting');
      return;
    }

    try {
      await this._installHandleFrameHook();
      this._startWatchdog();
      this._installed = true;
      this.device.log('[Availability] Passive monitoring enabled (Cluster0)');
    } catch (err) {
      this.device.error('[Availability] Installation failed:', err.message);
      throw err;
    }
  }

  /**
   * Monkey-patch `node.handleFrame` to intercept all inbound frames.
   * The original handler is always called so normal cluster processing is unaffected.
   *
   * @private
   */
  async _installHandleFrameHook() {
    const node = await this.device.homey.zigbee.getNode(this.device);
    if (!node) throw new Error('[Availability] Failed to get ZigBee node');

    const original = node.handleFrame?.bind(node);

    node.handleFrame = async (endpointId, clusterId, frame, meta) => {
      try {
        await this._markAlive(`cluster 0x${clusterId.toString(16)}`);
      } catch (e) {
        this.device.error('[Availability] handleFrame hook error:', e.message);
      }
      return original ? original(endpointId, clusterId, frame, meta) : undefined;
    };

    this.device.log('[Availability] handleFrame hook installed');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cluster6 — callback-driven
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @class AvailabilityManagerCluster6
 * @extends AvailabilityManagerBase
 *
 * Injects `device._markAliveFromAvailability(source)` so the device can signal
 * activity from its own reportParser / event handlers.
 *
 * Use for:
 * - Battery-powered ZCL sensors that send periodic reports (temp/humidity)
 * - Any device where the handleFrame hook is inaccessible
 *
 * The device must call `this._markAliveFromAvailability?.('source')` in every
 * inbound data handler (reportParser, Tuya 'reporting' / 'response' / 'heartbeat',
 * zclNode 'online', etc.) to keep the watchdog fed.
 */
class AvailabilityManagerCluster6 extends AvailabilityManagerBase {

  /**
   * Inject the markAlive helper and start the watchdog.
   */
  async install() {
    if (this._installed) {
      this.device.error('[Availability] Already installed');
      return;
    }

    if (!this._isEnabled()) {
      this.device.log('[Availability] Disabled by setting');
      return;
    }

    try {
      this.device._markAliveFromAvailability = async (source = 'activity') => {
        await this._markAlive(source);
      };

      this._startWatchdog();
      this._installed = true;
      this.device.log('[Availability] Monitoring enabled (Cluster6)');
    } catch (err) {
      this.device.error('[Availability] Installation failed:', err.message);
      throw err;
    }
  }

  /** @protected */
  async _cleanup() {
    delete this.device._markAliveFromAvailability;
  }
}

module.exports = {
  AvailabilityManagerCluster0,
  AvailabilityManagerCluster6,
};
