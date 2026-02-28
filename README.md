# My Tuya Zigbee Suite

Adds support for Tuya-based Zigbee devices from brands like **NovaDigital** and **Zemismart** — with a focus on multi-gang wall switches, smart plugs, sensors, and accessories that require specific driver implementations to work correctly with Homey.

---

## Supported Devices

| Device | Brands | Model |
|---|---|---|
| Wall Switch — 1 gang | NovaDigital, Zemismart | TS0001 |
| Wall Switch — 2 gang | NovaDigital, Zemismart | TS0002 |
| Wall Switch — 3 gang | NovaDigital, Zemismart | TS0003 |
| Wall Switch — 4 gang | NovaDigital, Zemismart | TS0601 |
| Wall Switch — 6 gang | NovaDigital, Zemismart | TS0601 |
| 3-Gang Fan Controller / Dimmer | MOES | TS0601 |
| Smart Plug with Energy Metering | NovaDigital, Zemismart | TS011F |
| Power Strip — 4 Sockets + USB | NovaDigital, Zemismart | TS011F |
| Temperature & Humidity Sensor (LCD) | NovaDigital, Zemismart | TS0201 |
| Temperature, Humidity & Clock Sensor | Tuya | TS0601 |
| Gas Detector | Tuya | TS0204 |
| Siren | Tuya | TS0601 |
| Zigbee Repeater | Tuya | TS0207 |

---

## Features

**Multi-gang switches**
Each gang is an independent Homey device. Power-on behavior is configurable per gang — choose to turn on, turn off, or restore the last state after a power outage.

**Availability monitoring**
All devices report their online/offline status to Homey automatically. If a device stops responding it is marked unavailable, and restored as soon as it comes back — without requiring a restart.

**Energy metering**
Smart plugs report real-time power (W), current (A), voltage (V), and accumulated energy (kWh).

**Time synchronisation**
Devices with a clock display stay in sync with Homey's system time automatically.

---

## Notes

- Requires a **Homey Pro** with Zigbee support
- Devices pair directly to Homey — no Tuya gateway or cloud account needed
- If your device is not detected, open an issue on GitHub with the device interview from Homey's Zigbee developer tools
