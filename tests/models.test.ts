import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverModels } from '../runner/models';
import { defaults, normalizeAgentSettings } from '../shared/types';

test('model discovery reads Claude initialization and paginated Codex catalogs', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'garnet-models-')); const executable = path.join(dir, 'cli');
  try {
    await writeFile(executable, `#!${process.execPath}
const {createInterface}=require('node:readline');
const send=value=>console.log(JSON.stringify(value));
createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);
if(q.type==='control_request') send({type:'control_response',response:{request_id:q.request_id,response:{models:[{value:'claude-test',displayName:'Claude Test'}]}}});
else if(q.method==='initialize') send({id:q.id,result:{}});
else if(q.method==='model/list') send({id:q.id,result:{data:[{model:q.params.cursor?'codex-second':'codex-first',displayName:'Codex Test'}],nextCursor:q.params.cursor?null:'page2'}});
});`, { mode: 0o700 });
    assert.deepEqual((await discoverModels('claude', executable)).models.map(m => m.id), ['claude-test']);
    assert.deepEqual((await discoverModels('codex', executable)).models.map(m => m.id), ['codex-first', 'codex-second']);
    await writeFile(executable, `#!${process.execPath}\nsetInterval(()=>{},1000);`, { mode: 0o700 });
    assert.match((await discoverModels('codex', executable, dir, undefined, 100)).error!, /timed out/);
    assert.match((await discoverModels('claude', path.join(dir, 'missing'))).error!, /not found/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('legacy model override migrates to its selected provider only', () => {
  const legacy = { ...defaults.agent, provider: 'claude', model: 'claude-custom', claudeModel: undefined, codexModel: undefined } as any;
  const updated = normalizeAgentSettings(legacy);
  assert.equal(updated.claudeModel, 'claude-custom'); assert.equal(updated.codexModel, ''); assert.ok(!('model' in updated));
  assert.equal(normalizeAgentSettings({ ...defaults.agent, claudeModel: 'claude-one', codexModel: 'codex-two' }).codexModel, 'codex-two');
});
