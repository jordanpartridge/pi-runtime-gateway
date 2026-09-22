import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Runtime, TERMINAL } from '../lib/runtime.mjs';
import { createGateway } from '../server.mjs';

const clientTool = { type: 'function', function: { name: 'lookup_status', description: 'Look up status.',
  parameters: { type: 'object', properties: { issue: { type: 'integer' } }, required: ['issue'] } } };
const history = [{ role: 'user', content: 'Look up issue 42.' }];
const chat = { messages: history, system: '', tools: [clientTool], clientTools: true, toolChoice: 'auto' };

function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'pi-chat-settlement-'));
  const stateDir = resolve(root, 'state');
  mkdirSync(resolve(root, 'project')); mkdirSync(resolve(root, 'agent'));
  writeFileSync(resolve(root, 'system.md'), 'Offline fixture.');
  const binary = resolve(root, 'fake-pi.mjs');
  writeFileSync(binary, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const args = process.argv.slice(2), audit = process.env.PI_GATEWAY_AUDIT;
writeFileSync(resolve(dirname(audit), 'argv.json'), JSON.stringify(args));
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\\n')) >= 0) {
    const command = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    handle(command).catch(() => process.exit(1));
  }
});
async function handle(command) {
  if (command.type === 'get_state') {
    send({ type: 'response', id: command.id, success: true, data: { messageCount: 0, sessionId: String(process.pid),
      model: { id: args[args.indexOf('--model') + 1], provider: args[args.indexOf('--provider') + 1] } } });
  } else if (command.type === 'abort' || command.type === 'clear_queue') send({ type: 'response', id: command.id, success: true });
  else if (command.type === 'prompt') {
    for (const hook of ['runtime.before_provider_request', 'chat.context']) appendFileSync(audit, JSON.stringify({ hook, fixture: true }) + '\\n');
    send({ type: 'response', id: command.id, success: true });
    send({ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse',
      content: [{ type: 'text', text: 'Provisional narration.' }, { type: 'toolCall', id: 'call_invalid', name: 'lookup_status', arguments: {} }],
      usage: { input: 10, output: 2, cacheRead: 1, cacheWrite: 0 } } });
    send({ type: 'tool_execution_end', toolName: 'lookup_status', toolCallId: 'call_invalid', isError: true });
    await delay(120);
    send({ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse',
      content: [{ type: 'toolCall', id: 'call_repaired', name: 'lookup_status', arguments: { issue: 42 } }],
      usage: { input: 15, output: 3, cacheRead: 0, cacheWrite: 2 } } });
    send({ type: 'agent_settled' });
  }
}
`, { mode: 0o755 });
  const profile = { id: 'settlement-test', provider: 'offline-test', model: 'offline-model', piVersion: '0.85.1',
    piBinary: binary, projects: { fixture: 'project' }, agentDir: 'agent', extension: 'fixture.ts',
    skill: 'skill.md', systemPrompt: 'system.md', tools: ['read'], maxRuns: 10,
    startupTimeoutMs: 2000, runTimeoutMs: 5000, cancelGraceMs: 150 };
  const runtime = new Runtime({ root, profile, stateDir });
  const context = { root, profile, stateDir, runtime, gateway: null };
  t.after(async () => {
    if (context.gateway) await context.gateway.close(); else await runtime.shutdown();
    rmSync(root, { recursive: true, force: true });
  });
  return context;
}
async function until(predicate, message) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await delay(5);
  }
  assert.fail(message);
}
function assertFinal(run) {
  assert.equal(run.status, 'completed');
  assert.equal(run.childExited, true);
  assert.throws(() => process.kill(run.pid, 0), error => error.code === 'ESRCH');
  assert.deepEqual(run.chatMessage, { role: 'assistant', content: null, tool_calls: [{ id: 'call_repaired', type: 'function',
    function: { name: 'lookup_status', arguments: '{"issue":42}' } }] });
  assert.equal(run.finishReason, 'tool_calls');
  assert.deepEqual(run.usage, { prompt_tokens: 28, completion_tokens: 5, total_tokens: 33 });
}

test('self-recovered client tool calls remain unpublished until Pi settles', { timeout: 10000 }, async t => {
  const c = fixture(t);
  const { id } = c.runtime.start({ project: 'fixture', prompt: 'Continue the supplied conversation.', chat });
  const run = c.runtime.runs.get(id);
  await until(() => run.chatMessage?.tool_calls?.[0]?.id === 'call_invalid', 'First assistant candidate was not observed.');
  assert.equal(run.status, 'running');
  assert.equal(run.events.filter(event => event.type === 'chat_delta').length, 0, 'Provisional candidates must not reach API streams.');
  await until(() => TERMINAL.has(run.status), 'Run did not settle.');
  assertFinal(run);
  const deltas = run.events.filter(event => event.type === 'chat_delta');
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].delta.tool_calls[0].id, 'call_repaired');
  assert.equal(JSON.stringify(deltas).includes('call_invalid'), false);
  assert.equal(JSON.stringify(deltas).includes('Provisional narration.'), false);
  const args = JSON.parse(readFileSync(resolve(run.directory, 'argv.json'), 'utf8'));
  assert.equal(args[args.indexOf('--tools') + 1], 'lookup_status', 'Pi CLI allowlist must contain the client function, not only native tools.');
});

test('buffered and SSE completions expose the same repaired call with no provisional duplicates', { timeout: 10000 }, async t => {
  const c = fixture(t), token = 'offline-settlement-token-0123456789';
  c.gateway = createGateway({ ...c, token });
  await new Promise((done, reject) => {
    c.gateway.server.once('error', reject);
    c.gateway.server.listen(0, '127.0.0.1', done);
  });
  const url = `http://127.0.0.1:${c.gateway.server.address().port}/v1/chat/completions`;
  const submit = stream => fetch(url, { method: 'POST', signal: AbortSignal.timeout(7000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'settlement-test/fixture', messages: history, tools: [clientTool], stream }) });
  const bufferedResponse = await submit(false);
  assert.equal(bufferedResponse.status, 200);
  const buffered = await bufferedResponse.json();
  assert.equal(buffered.choices[0].message.tool_calls[0].id, 'call_repaired');
  const streamedResponse = await submit(true);
  assert.equal(streamedResponse.status, 200);
  const wire = await streamedResponse.text();
  assert.equal(wire.includes('call_invalid'), false);
  assert.equal(wire.includes('Provisional narration.'), false);
  assert.equal(wire.match(/data: \[DONE\]/g)?.length, 1);
  const chunks = wire.split('\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]')).map(line => JSON.parse(line.slice(6)));
  const calls = chunks.flatMap(chunk => chunk.choices.flatMap(choice => choice.delta.tool_calls || []));
  assert.equal(calls.length, 1);
  const { index, ...streamedCall } = calls[0];
  assert.equal(index, 0);
  assert.deepEqual(streamedCall, buffered.choices[0].message.tool_calls[0]);
  const finishes = chunks.flatMap(chunk => chunk.choices.map(choice => choice.finish_reason).filter(Boolean));
  assert.deepEqual(finishes, ['tool_calls']);
  for (const run of c.runtime.runs.values()) assertFinal(run);
});
