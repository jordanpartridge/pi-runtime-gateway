import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProfile } from '../lib/config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { stateDir, profile } = loadProfile({ root });
const address = JSON.parse(readFileSync(resolve(stateDir, 'server.json'))).address;
const token = readFileSync(resolve(stateDir, 'token'), 'utf8').trim();
const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
const checks = [], runs = [];
const evidence = resolve(root, 'evidence'); mkdirSync(evidence, { recursive: true });
async function request(path, body) {
  const res = await fetch(address + path, { method: body === undefined ? 'GET' : 'POST', headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
  const result = await res.json();
  assert.ok(res.ok, JSON.stringify({ status: res.status, result })); return result;
}
function check(name, condition, detail) {
  assert.ok(condition, name + ': ' + JSON.stringify(detail));
  checks.push({ name, passed: true, detail }); console.log(JSON.stringify({ check: name, passed: true }));
}
async function execute(prompt, { cancelOnDelta = false } = {}) {
  const run = await request('/runs', { project: 'proof', prompt });
  const events = []; let liveDelta = false, cancelResponse;
  console.log(JSON.stringify({ run: run.id, phase: cancelOnDelta ? 'cancellation' : 'completion' }));
  const res = await fetch(address + '/runs/' + run.id + '/events', { headers, signal: AbortSignal.timeout(320000) });
  assert.equal(res.status, 200);
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      const data = frame.split('\n').find(line => line.startsWith('data: '));
      if (!data) continue;
      const event = JSON.parse(data.slice(6)); events.push(event);
      if (event.type === 'text_delta' && !liveDelta) {
        liveDelta = true;
        console.log(JSON.stringify({ run: run.id, firstDeltaAt: event.at }));
        if (cancelOnDelta) cancelResponse = await request('/runs/' + run.id + '/cancel', {});
      }
    }
  }
  const receipt = await request('/runs/' + run.id);
  runs.push({ receipt, events });
  check('SSE delivered terminal event', events.at(-1)?.type === 'terminal', run.id);
  check('Pi child was reaped', receipt.childExited === true, run.id);
  try { process.kill(receipt.pid, 0); throw new Error('Pi child still exists'); }
  catch (error) { assert.equal(error.code, 'ESRCH'); }
  if (cancelOnDelta) {
    check('Cancelled after actual streamed model output', liveDelta && !!cancelResponse, run.id);
    check('RPC abort acknowledged', receipt.abortAcknowledged === true, run.id);
    check('Cancelled terminal state', receipt.status === 'cancelled', receipt.status);
    const elapsed = Date.parse(receipt.finishedAt) - Date.parse(receipt.cancelRequestedAt);
    check('Cancellation and reap within five seconds', elapsed < 5000, elapsed);
  } else {
    check('Configured model completed', receipt.status === 'completed' && receipt.provider === profile.provider && receipt.model === profile.model, receipt.status);
    check('Actual text arrived through SSE', liveDelta, run.id);
  }
  return receipt;
}
try {
  const health = await request('/health');
  check('Explicit configured profile', health.provider === profile.provider && health.openaiCompatible === false, health);
  const first = await execute('What is the project proof phrase supplied in your configured project guidance? Return only that phrase.');
  check('Model used context injected by hook', first.text.trim() === 'PI_GATEWAY_CONTEXT_READY', first.text);
  const names = first.hooks.map(h => h.hook);
  for (const name of ['runtime.session_start','runtime.before_agent_start','runtime.before_provider_request'])
    check('Hook executed: ' + name, names.includes(name), first.id);
  for (const extension of profile.extensions)
    check('Optional extension loaded: ' + extension.name, first.hooks.some(h => h.hook === 'extension.loaded' && h.extension === extension.name), extension.name);
  const providerHook = first.hooks.find(h => h.hook === 'runtime.before_provider_request');
  check('Context present in actual provider payload', providerHook?.projectContextPresent === true, providerHook);
  check('Full review skill present in actual provider payload', providerHook?.reviewSkillPresent === true, providerHook);
  const second = await execute('Read discount.php and identify the arithmetic bug for subtotal 200 and percent 10. State the actual total and intended percentage-discount total. Do not modify anything.');
  check('Fresh context for each review', first.sessionId !== second.sessionId && first.initialMessageCount === 0 && second.initialMessageCount === 0,
    { first: first.sessionId, second: second.sessionId });
  check('Read tool actually executed', runs.at(-1).events.some(e => e.type === 'tool_execution_end' && e.tool === 'read' && !e.isError), second.id);
  check('Review identified concrete defect', /190/.test(second.text) && /180/.test(second.text), second.text);
  await execute('Write a numbered list of 250 distinct edge cases for a percentage discount function. Give a detailed sentence for each. Continue until all 250 entries are written.', { cancelOnDelta: true });
  const recovery = await execute('Reply with exactly RECOVERY_OK.');
  check('Server accepts fresh work after cancellation', recovery.text.trim() === 'RECOVERY_OK', recovery.text);
  const report = { provedAt: new Date().toISOString(), result: 'passed', profile: profile.id, model: profile.model, provider: profile.provider,
    extensions: profile.extensions.map(e => e.name), checks, runs,
    limitations: ['This synthetic fixture verifies runtime behavior, not real-world review accuracy.',
      'Optional extension loading does not prove successful memory retrieval or semantic review grading.',
      'OpenAI API compatibility and downstream review integrations are not implemented in this release.'] };
  writeFileSync(resolve(evidence, 'live-proof.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ result: 'passed', checks: checks.length, evidence: resolve(evidence, 'live-proof.json') }));
} catch (error) {
  writeFileSync(resolve(evidence, 'live-proof-failure.json'), JSON.stringify({ at: new Date().toISOString(), error: error.message, checks, runs }, null, 2));
  console.error(error.message); process.exitCode = 1;
}
