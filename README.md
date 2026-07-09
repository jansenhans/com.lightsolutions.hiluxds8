# HiluX DS8 — Homey App

A Homey app for the LightSolutions HiluX DS8 (Powered by Shelly) tunable-white
downlight, using the Shelly Gen3 RPC API over the local network — plus fleet
management for Shelly i4 Gen3 wall buttons that control groups of these lights
without any cloud or hub round-trip.

## What it does

**Lights (driver: HiluX DS8)**

- On/off, brightness (`dim`), colour temperature (`light_temperature`,
  mapped to the device's native 2200 K–6000 K range via the `CCT` component)
- Pairing by automatic network discovery: scans the /23 around Homey's own
  address and finds devices reporting `app: "XMOD1"`
- Polls every 15 seconds to stay in sync with changes made elsewhere
- **Enforced settings**: each light's *default fade time* and *minimum
  turn-on brightness* are device settings in Homey; the app re-applies them
  if they drift — notably after firmware updates, which reset them

**Wall buttons (driver: HiluX Wall Button, Shelly i4 Gen3)**

- Each i4 **input** is paired as its own Homey device; **the zone you place
  it in is the group of lights it controls** (all HiluX lights in that zone).
  The physical location of the i4 is irrelevant — one i4 can drive up to four
  different rooms.
- The app generates a script per i4 and deploys it over the LAN
  automatically — on pairing, on settings changes, and within seconds of
  zone changes (realtime device events; a periodic sweep also heals an i4
  that was factory-reset). You never edit a script by hand.
- Button gestures (all local, i4 → lights directly):

  | Press        | Action                                                      |
  | ------------ | ----------------------------------------------------------- |
  | single push  | toggle the group on/off — the group comes on with one shared brightness *and* colour, re-aligning any light that drifted |
  | double push  | dim to preset 1 (default 20%, configurable, 0 disables)     |
  | triple push  | dim to preset 2 (default 50%, configurable, 0 disables)     |
  | long push    | fade brightness up/down, alternating per hold; configurable floor so it never fades to invisible |
  | tap + hold   | sweep colour temperature warm↔cool, alternating per use     |
  | release      | freeze the running fade exactly where it is (`CCT.DimStop`) |

- Per-button settings: dim speed and floor, colour sweep time, the two
  presets, and switch-on/off fade times.

Why device-side scripts instead of Homey flows: the Shelly Homey app exposes
no *button released* event, so hold-to-dim with release-to-stop can't be
built with flows — and direct i4→light control keeps working even while
Homey reboots. Every group action reads the lights' real state first, so
nothing can desync.

**Flow cards** (all fades run on the light's own firmware):

- **Fade to a brightness** / **Fade to a colour temperature** — over 1 s–3 h
- **Start dimming (hold-to-dim)** / **Stop dimming** — native
  `CCT.DimUp/DimDown/DimStop` on firmware 2.0+, automatic fallback on older
- **Start wake-up light** — 1% warm white to a target over up to 3 hours

## Requirements

- Homey Pro; the app uses the `homey:manager:api` permission (it reads
  device zones to compute button groups)
- Lights on Shelly firmware **>= 2.0.0** for native dimming (the flow cards
  fall back gracefully on older firmware; the button script requires it)
- **Fixed IP addresses** for lights and i4s (on-device static or DHCP
  reservation) — buttons address lights by IP
- Node.js + npm and the [Homey CLI](https://apps.developer.homey.app/the-basics/getting-started)
  (`npm install -g homey`) to install the app

## Setup

```bash
cd com.lightsolutions.hiluxds8
npm install
homey app install   # or `homey app run` for a dev session with live logs
```

## Getting started

1. Pair your lights: add device → HiluX DS8 → they're discovered
   automatically. Assign each light to the room (zone) it's in.
2. Pair your wall buttons: add device → HiluX Wall Button (Shelly i4) →
   add the inputs that are physically wired.
3. Move each button device to the zone it should control. Done — the app
   deploys the i4 script within seconds. Reorganize any time; the scripts
   follow.

The i4 inputs must be in *button* mode (they are by default on an input-only
device like the i4).

## Project structure

```
app.json                          App + drivers manifest
app.js                            Orchestrator: zones -> per-i4 script deploys
lib/ShellyRpcClient.js            Local Shelly Gen3 RPC client
lib/I4ScriptBuilder.js            Generates the per-i4 button script (mJS)
lib/I4Deployer.js                 Deploys scripts over RPC (hash-idempotent)
drivers/hilux-ds8/                Light driver: discovery pairing, polling,
                                  capability listeners, settings enforcement
drivers/hilux-i4-button/          Wall button driver: one device per i4 input
extras/shelly-i4-hold-to-dim.js   LEGACY standalone script (see below)
```

## Legacy: standalone i4 script (`extras/`)

Before v2.0.0 the button script was maintained by hand;
`extras/shelly-i4-hold-to-dim.js` is that standalone single-input version,
kept for reference and for running the button logic **without** this app
(paste into the i4's web UI → Scripts, enable *Run on startup*, edit the
`LIGHTS` array and constants at the top). When the app manages an i4, it
disables legacy scripts automatically and deploys its own
(`hilux-app-buttons`) — don't run both.

## Notes

- Shelly firmware updates reset the lights' `transition_duration` and
  `min_brightness_on_toggle` — the app's settings enforcement re-applies
  them automatically (on startup, hourly, and when a light recovers).
- Validating: `homey app validate`
