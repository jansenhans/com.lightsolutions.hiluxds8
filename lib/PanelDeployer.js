'use strict';

const ShellyRpcClient = require('./ShellyRpcClient');
const PanelScriptBuilder = require('./PanelScriptBuilder');

const KVS_KEY = 'hilux-panel-components';
const PUT_CODE_CHUNK = 900;

// Makes sure the panel's virtual components exist exactly once. Their ids are
// remembered in the display's KVS so redeploys adopt them instead of creating
// duplicates. The toggle's name follows the Homey group name.
async function ensureComponents(client, groupName) {
  let ids = null;
  try {
    const kv = await client.call('KVS.Get', { key: KVS_KEY });
    ids = JSON.parse(kv.value);
  } catch (e) { /* not seeded yet */ }

  if (!ids || typeof ids.sw !== 'number') {
    const sw = (await client.call('Virtual.Add', { type: 'boolean', config: { name: groupName, meta: { ui: { view: 'toggle' } } } })).id;
    const br = (await client.call('Virtual.Add', { type: 'number', config: { name: 'Brightness', min: 5, max: 100, meta: { ui: { view: 'slider', unit: '%' } } } })).id;
    const ct = (await client.call('Virtual.Add', { type: 'number', config: { name: 'Colour temperature', min: 2200, max: 6000, meta: { ui: { view: 'slider', unit: 'K', step: 50 } } } })).id;
    ids = { sw, br, ct };
    await client.call('KVS.Set', { key: KVS_KEY, value: JSON.stringify(ids) });
  }

  const cfg = await client.call('Boolean.GetConfig', { id: ids.sw });
  if (cfg && cfg.name !== groupName) {
    await client.call('Boolean.SetConfig', { id: ids.sw, config: { name: groupName } });
  }
  return ids;
}

// Deploys the panel script onto a Wall Display. Idempotent like the i4
// deployer: skips when the hash marker of the deployed code is unchanged.
async function deploy(address, { name, lights, fade }, log = () => {}) {
  const client = new ShellyRpcClient(address);

  const ids = await ensureComponents(client, name);
  const { code, hash } = PanelScriptBuilder.generate({ lights, fade, ids });

  const list = (await client.call('Script.List')).scripts || [];
  const existing = list.find((s) => s.name === PanelScriptBuilder.SCRIPT_NAME);
  if (existing) {
    const current = await client.call('Script.GetCode', { id: existing.id }).catch(() => null);
    if (current && typeof current.data === 'string' && current.data.includes(`hash:${hash}`)) {
      return { changed: false, id: existing.id };
    }
  }

  const id = existing ? existing.id : (await client.call('Script.Create', { name: PanelScriptBuilder.SCRIPT_NAME })).id;

  await client.call('Script.Stop', { id }).catch(() => {});
  for (let pos = 0; pos < code.length; pos += PUT_CODE_CHUNK) {
    await client.call('Script.PutCode', { id, code: code.slice(pos, pos + PUT_CODE_CHUNK), append: pos > 0 });
  }
  await client.call('Script.SetConfig', { id, config: { enable: true } });
  await client.call('Script.Start', { id });

  const status = await client.call('Script.GetStatus', { id });
  if (!status.running) throw new Error(`panel script deployed but not running on ${address}`);
  log(`panel ${address}: deployed script hash:${hash} (${code.length} bytes, ${lights.length} lights)`);
  return { changed: true, id };
}

module.exports = { deploy };
