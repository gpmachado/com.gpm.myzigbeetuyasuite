'use strict';

/**
 * TuyaHelpers - Utility library for Tuya Zigbee device drivers.
 *
 * Provides standardized methods for:
 * - Parsing Tuya datapoint values
 * - Multi-byte number conversion
 * - Device configuration (dimmer, power-on, switch type)
 *
 * @version 3.2.0 - Removed unused schedule functions (parseSchedule, marshalSchedule)
 */

/**
 * Tuya datapoint type constants.
 * @enum {number}
 */
const TUYA_DATA_TYPES = {
  raw:    0,
  bool:   1,
  value:  2,
  string: 3,
  enum:   4,
  bitmap: 5,
};

// ─────────────────────────────────────────────────────────────────────────────
// Data conversion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a multi-byte big-endian array to a single decimal number.
 * Algorithm: each byte is shifted left by 8 bits and OR'd with accumulator.
 * Example: [0x01, 0x2C] → 300
 *
 * @param {Array<number>|Buffer} chunks - Byte array from Tuya device
 * @returns {number}
 */
const convertMultiByteNumberPayloadToSingleDecimalNumber = (chunks) => {
  if (!chunks || chunks.length === 0) return 0;
  return chunks.reduce((acc, byte) => (acc << 8) | byte, 0);
};

/**
 * Parse a Tuya datapoint value object into a JavaScript type.
 * Automatically detects datatype and returns bool, number, string, or Buffer.
 *
 * @param {Object} dpValue - Datapoint value from cluster
 * @param {number} dpValue.datatype - Tuya datatype ID (0-5)
 * @param {Buffer|Array<number>} dpValue.data - Raw data bytes
 * @returns {boolean|number|string|Buffer|Array}
 * @throws {Error} If input is invalid or datatype is unsupported
 *
 * @example
 * // Boolean (on/off)
 * getDataValue({ datatype: 1, data: [0x01] }) // true
 *
 * @example
 * // 32-bit value (temperature x 10)
 * getDataValue({ datatype: 2, data: [0x00, 0x00, 0x00, 0xDC] }) // 220
 */
const getDataValue = (dpValue) => {
  if (!dpValue || dpValue.data === undefined) {
    throw new Error('Invalid datapoint value: missing data');
  }
  if (!Array.isArray(dpValue.data) && !Buffer.isBuffer(dpValue.data)) {
    throw new Error('Invalid datapoint data: must be array or buffer');
  }

  switch (dpValue.datatype) {
    case TUYA_DATA_TYPES.raw:
      return dpValue.data;
    case TUYA_DATA_TYPES.bool:
      return dpValue.data[0] === 1;
    case TUYA_DATA_TYPES.value:
      return convertMultiByteNumberPayloadToSingleDecimalNumber(dpValue.data);
    case TUYA_DATA_TYPES.string:
      return String.fromCharCode(...dpValue.data);
    case TUYA_DATA_TYPES.enum:
      return dpValue.data[0];
    case TUYA_DATA_TYPES.bitmap:
      return convertMultiByteNumberPayloadToSingleDecimalNumber(dpValue.data);
    default:
      throw new Error(`Unsupported datatype: ${dpValue.datatype}`);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Device configuration helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Set minimum brightness level for a dimmer switch.
 *
 * @param {TuyaSpecificClusterDevice} device
 * @param {number} value - Brightness level 0-1000 (1000 = 100%)
 * @param {'One'|'Two'} [gang='One']
 * @returns {Promise<void>}
 */
async function setMinimumBrightness(device, value, gang = 'One') {
  const dp = gang === 'One' ? 3 : 9;
  await device.writeData32(dp, value);
}

/**
 * Set maximum brightness level for a dimmer switch.
 *
 * @param {TuyaSpecificClusterDevice} device
 * @param {number} value - Brightness level 0-1000 (1000 = 100%)
 * @param {'One'|'Two'} [gang='One']
 * @returns {Promise<void>}
 */
async function setMaximumBrightness(device, value, gang = 'One') {
  const dp = gang === 'One' ? 5 : 11;
  await device.writeData32(dp, value);
}

/**
 * Set the light source type for a dimmer switch.
 * Typical values: 0=LED, 1=Incandescent, 2=Halogen
 *
 * @param {TuyaSpecificClusterDevice} device
 * @param {number} value - Light source enum value
 * @param {'One'|'Two'} [gang='One']
 * @returns {Promise<void>}
 */
async function setTypeOfLightSource(device, value, gang = 'One') {
  const dp = gang === 'One' ? 4 : 10;
  await device.writeEnum(dp, value);
}

/**
 * Set power-on behavior for a Tuya EF00 device (DP14).
 * Values: 0=always off, 1=always on, 2=restore last state
 *
 * @param {TuyaSpecificClusterDevice} device
 * @param {number} value - Power-on enum value (0-2)
 * @returns {Promise<void>}
 */
async function setPowerOnStatus(device, value) {
  await device.writeEnum(14, value);
}

/**
 * Set physical switch type for a Tuya EF00 device (DP17).
 * Values: 0=toggle/rocker, 1=momentary/push-button
 *
 * @param {TuyaSpecificClusterDevice} device
 * @param {number} value - Switch type enum value
 * @returns {Promise<void>}
 */
async function setSwitchType(device, value) {
  await device.writeEnum(17, value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  TUYA_DATA_TYPES,
  getDataValue,
  convertMultiByteNumberPayloadToSingleDecimalNumber,
  setMinimumBrightness,
  setMaximumBrightness,
  setTypeOfLightSource,
  setPowerOnStatus,
  setSwitchType,
};
