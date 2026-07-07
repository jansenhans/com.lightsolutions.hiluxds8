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
extras/shelly-i4-hold-to-dim.js   Shelly i4 Gen3 button script (see below)
```

## Flow cards

Since v1.1.0 the app provides custom Flow action cards, all backed by the
Shelly firmware's native `transition_duration` so fades run on the light
itself (smooth even if Homey is busy):

- **Fade to a brightness** — fade to X% over 1 s – 3 h
- **Fade to a colour temperature** — fade to X Kelvin over a duration
- **Start dimming (hold-to-dim)** — fade toward full/minimum brightness,
  alternating direction per call like a classic dimmer (v1.2.0)
- **Stop dimming** — freeze the light at its current brightness (v1.2.0)
- **Start wake-up light** — from 1% warm white to a target brightness and
  colour temperature over up to 3 hours

## Extra: Shelly i4 wall-button script (`extras/shelly-i4-hold-to-dim.js`)

A companion mJS script that runs **on a Shelly i4 Gen3** (not on Homey) and
gives one wall button full control of a group of HiluX DS8 lights, entirely
over the local network:

| Press        | Action                                                     |
| ------------ | ---------------------------------------------------------- |
| single push  | toggle all lights on/off (based on the actual light state) |
| double push  | dim to 20% (only when on)                                  |
| triple push  | dim to 50% (only when on)                                  |
| long push    | fade brightness up/down, alternating direction each hold   |
| release      | freeze at the current brightness                           |

Why a device-side script instead of Homey flows: the Shelly Homey app exposes
no *button released* event, so true hold-to-dim/release-to-stop cannot be
built with flows. The script sees `btn_up` the instant the button is released
and halts all lights with the native `CCT.DimStop` — they freeze at exactly
the same brightness. It also can't desync: every action reads the lights'
real state first (no shadow variables).

**Requires light firmware >= 2.0.0** for `CCT.DimUp`/`DimDown`/`DimStop`.
(The Homey app's *Start/Stop dimming* flow cards use the same native calls
and fall back automatically to a timed fade + read-and-freeze on older
firmware.) Note: Shelly firmware updates reset the light's default
`transition_duration` to 3.0 s — re-apply your preferred value afterwards.

**Install:** open the i4's web UI → Scripts → create a script, paste the file,
enable *Run on startup*, and start it. Edit the `LIGHTS` array (the lights'
IP addresses) and `DIM_RATE` (1 = slow, ~25 s full sweep; 5 = fast, ~5 s) to
taste. The input must be in *button* mode. Give the lights and the i4 fixed
IP addresses (static or DHCP reservations) — the script addresses the lights
directly.

**Recommended light setting:** set `min_brightness_on_toggle` to ~10 on each
light (`CCT.SetConfig {"id":0,"config":{"min_brightness_on_toggle":10}}`).
After dimming down to 1% — which is invisible — a plain toggle-on would
otherwise restore that invisible 1% and the lights appear dead.
