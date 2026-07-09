'use strict';

const ShellyRpcClient = require('./ShellyRpcClient');
const { SCRIPT_NAME } = require('./I4ScriptBuilder');

// Scripts previously managed by hand — disabled (not deleted) on first deploy
const LEGACY_SCRIPT_NAMES = ['hold-to-dim-bathroom2'];
const PUT_CODE_CHUNK = 900;

// Deploys a generated button script onto an i4. Idempotent: compares the
// hash marker in the deployed code and skips when unchanged.
async function deploy(address, code, hash, log = () => {}) {
  const client = new ShellyRpcClient(address);

  const list = (await client.call('Script.List')).scripts || [];

  for (const s of list) {
    if (LEGACY_SCRIPT_NAMES.includes(s.name) && s.enable !== false) {
      await client.call('Script.Stop', { id: s.id }).catch(() => {});
      await client.call('Script.SetConfig', { id: s.id, config: { enable: false } });
      log(`i4 ${address}: disabled legacy script "${s.name}"`);
    }
  }

  const existing = list.find((s) => s.name === SCRIPT_NAME);
  if (existing) {
    const current = await client.call('Script.GetCode', { id: existing.id }).catch(() => null);
    if (current && typeof current.data === 'string' && current.data.includes(`hash:${hash}`)) {
      return { changed: false, id: existing.id };
    }
  }

  const id = existing ? existing.id : (await client.call('Script.Create', { name: SCRIPT_NAME })).id;

  await client.call('Script.Stop', { id }).catch(() => {});
  for (let pos = 0; pos < code.length; pos += PUT_CODE_CHUNK) {
    await client.call('Script.PutCode', { id, code: code.slice(pos, pos + PUT_CODE_CHUNK), append: pos > 0 });
  }
  await client.call('Script.SetConfig', { id, config: { enable: true } });
  await client.call('Script.Start', { id });

  const status = await client.call('Script.GetStatus', { id });
  if (!status.running) throw new Error(`script deployed but not running on ${address}`);
  log(`i4 ${address}: deployed script hash:${hash} (${code.length} bytes)`);
  return { changed: true, id };
}

module.exports = { deploy };
