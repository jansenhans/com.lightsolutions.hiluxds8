# HiluX DS8 — Homey App

A minimal Homey app to control the LightSolutions HiluX DS8 (Powered by Shelly)
tunable-white downlight over your local network, using the Shelly Gen3 RPC API.

## What it does

- On/off
- Brightness (`dim`)
- Color temperature (`light_temperature`), mapped to the device's native
  2200K–6000K range via the `CCT` component
- Polls the device every 10 seconds to keep Homey in sync with changes made
  from the LightSolutions/Shelly app or physical controls

## Requirements

- Node.js + npm
- The [Homey CLI](https://apps.developer.homey.app/the-basics/getting-started):
  `npm install -g homey`
- A Homey developer account (free) — sign up at https://tools.developer.homey.app

## Setup

```bash
cd com.lightsolutions.hiluxds8
npm install
```

## Running on your Homey (development mode)

```bash
homey app run
```

This installs and runs the app live on your Homey without publishing it.
Logs stream to your terminal.

## Pairing the device

1. In the Homey app, add a new device → HiluX DS8.
2. Enter the device's local IP address (find it in your router, or in the
   LightSolutions/Shelly app under device settings → Wi-Fi).
3. Homey verifies it's a HiluX DS8 by calling `Shelly.GetDeviceInfo` and
   checking for `app: "XMOD1"`, then creates the device.

**Note:** this assumes a static/reserved IP for the light. If your router
reassigns its IP, the app will lose contact until you update the address in
the device's settings in Homey (Advanced settings → Address). A future
improvement would be pairing by MAC + mDNS discovery instead.

## How it talks to the device

All communication is local HTTP JSON-RPC to `http://<device-ip>/rpc`,
calling the `CCT.Set` / `CCT.GetStatus` methods on component `cct:0`. See
`lib/ShellyRpcClient.js`.

## Validating before publishing

```bash
homey app validate
```

## Project structure

```
app.json                          App + driver manifest
app.js                            App entry point
lib/ShellyRpcClient.js            Local Shelly Gen3 RPC client
drivers/hilux-ds8/driver.js       Pairing logic
drivers/hilux-ds8/device.js       Capability listeners + polling
drivers/hilux-ds8/pair/start.html Pairing screen (IP address entry)
```
