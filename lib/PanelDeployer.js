'use strict';

const ShellyRpcClient = require('./ShellyRpcClient');
const PanelScriptBuilder = require('./PanelScriptBuilder');

const KVS_KEY = 'hilux-panel-components';

// Makes sure the panel's virtual components exist exactly once. Their ids are
// remembered in the display's KVS so redeploys adopt them instead of creating
// duplicates. The toggle's name follows the Homey group name.
//
// Only a definite "Key not found" counts as unseeded: any other read failure
// (timeout, display still booting) aborts the deploy so the next sweep
// retries — treating those as "unseeded" piled up 74 duplicate toggles and
// ~100 sliders on the display (found 2026-10-02). Unseeded with our
// components already present (KVS wiped) adopts them instead of adding more.
async function readIds(client) {
  try {
    const kv = await client.call('KVS.Get', { key: KVS_KEY });
    return JSON.parse(kv.value);
  } catch (e) {
    if (/Key not found/i.test(e.message)) return null;
    throw new Error(`panel component ids unreadable (${e.message}) — retrying next sweep`);
  }
}

async function findOurComponents(client) {
  const res = await client.call('Shelly.GetComponents', { dynamic_only: true });
  const comps = (res && res.components) || [];
  const idOf = (c) => Number(c.key.split(':')[1]);
  const first = (pred) => comps.filter(pred).map(idOf).sort((x, y) => x - y)[0];
  const sw = first((c) => c.key.startsWith('boolean:') && c.config && c.config.meta && c.config.meta.ui && c.config.meta.ui.view === 'toggle');
  const br = first((c) => c.key.startsWith('number:') && c.config && c.config.name === 'Brightness');
  const ct = first((c) => c.key.startsWith('number:') && c.config && c.config.name === 'Colour temperature');
  return typeof sw === 'number' && typeof br === 'number' && typeof ct === 'number' ? { sw, br, ct } : null;
}

async function ensureComponents(client, groupName) {
  let ids = await readIds(client);

  if (!ids || typeof ids.sw !== 'number') {
    ids = await findOurComponents(client);
    if (!ids) {
      const sw = (await client.call('Virtual.Add', { type: 'boolean', config: { name: groupName, meta: { ui: { view: 'toggle' } } } })).id;
      const br = (await client.call('Virtual.Add', { type: 'number', config: { name: 'Brightness', min: 5, max: 100, meta: { ui: { view: 'slider', unit: '%' } } } })).id;
      const ct = (await client.call('Virtual.Add', { type: 'number', config: { name: 'Colour temperature', min: 2200, max: 6000, meta: { ui: { view: 'slider', unit: 'K', step: 50 } } } })).id;
      ids = { sw, br, ct };
    }
    await client.call('KVS.Set', { key: KVS_KEY, value: JSON.stringify(ids) });
  }

  const cfg = await client.call('Boolean.GetConfig', { id: ids.sw });
  if (cfg && cfg.name !== groupName) {
    await client.call('Boolean.SetConfig', { id: ids.sw, config: { name: groupName } });
  }
  return ids;
}

// Motion webhooks so the app learns instantly when someone approaches the
// display (used to dismiss the panel's screensaver). Best effort per event —
// some sensors are stubs depending on hardware.
async function ensureMotionWebhooks(client, motionUrl, log) {
  const hooks = (await client.call('Webhook.List')).hooks || [];
  for (const event of ['motion.motion_start', 'occupancy.object_enter']) {
    const name = `hilux-motion-${event.split('.')[1]}`;
    try {
      const existing = hooks.find((h) => h.name === name);
      if (existing) {
        if (!existing.enable || !(existing.urls || []).includes(motionUrl)) {
          await client.call('Webhook.Update', { id: existing.id, enable: true, urls: [motionUrl] });
          log(`panel webhook ${name} updated`);
        }
      } else {
        await client.call('Webhook.Create', { cid: 0, enable: true, event, name, urls: [motionUrl] });
        log(`panel webhook ${name} created`);
      }
    } catch (err) {
      log(`panel webhook ${name} failed: ${err.message}`);
    }
  }
}

// Deploys the panel script onto a Wall Display. Idempotent like the i4
// deployer: skips when the hash marker of the deployed code is unchanged.
async function deploy(address, { name, lights, fade, motionUrl }, log = () => {}) {
  const client = new ShellyRpcClient(address);

  const ids = await ensureComponents(client, name);
  if (motionUrl) await ensureMotionWebhooks(client, motionUrl, log);
  const { code, hash } = PanelScriptBuilder.generate({ lights, fade, ids });

  const list = (await client.call('Script.List')).scripts || [];
  const existing = list.find((s) => s.name === PanelScriptBuilder.SCRIPT_NAME);
  if (existing) {
    // Full-code comparison, not just the hash marker: the display has been
    // seen persisting only part of an upload, which leaves the marker intact
    // in the surviving head of a corrupt script.
    const current = await client.call('Script.GetCode', { id: existing.id }).catch(() => null);
    if (current && current.data === code) {
      const status = await client.call('Script.GetStatus', { id: existing.id });
      if (!status.running) {
        // The display loses the enabled/running state on some reboots —
        // the periodic sweep lands here and heals it
        await client.call('Script.SetConfig', { id: existing.id, config: { enable: true } });
        await client.call('Script.Start', { id: existing.id });
        log(`panel ${address}: restarted stopped script`);
      }
      return { changed: false, id: existing.id };
    }
  }

  const id = existing ? existing.id : (await client.call('Script.Create', { name: PanelScriptBuilder.SCRIPT_NAME })).id;

  await client.call('Script.Stop', { id }).catch(() => {});
  // One PutCode call, no chunking: the display persists chunked appends
  // unreliably (runs the full code from memory but stores a truncated file,
  // which only surfaces as a syntax error after the next reboot)
  await client.call('Script.PutCode', { id, code, append: false });
  const stored = await client.call('Script.GetCode', { id }).catch(() => null);
  if (!stored || stored.data !== code) throw new Error(`stored code verification failed on ${address}`);
  await client.call('Script.SetConfig', { id, config: { enable: true } });
  await client.call('Script.Start', { id });

  const status = await client.call('Script.GetStatus', { id });
  if (!status.running) throw new Error(`panel script deployed but not running on ${address}`);
  log(`panel ${address}: deployed script hash:${hash} (${code.length} bytes, ${lights.length} lights)`);
  return { changed: true, id };
}

module.exports = { deploy };
