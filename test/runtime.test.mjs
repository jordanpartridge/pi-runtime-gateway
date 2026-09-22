import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Runtime, TERMINAL } from '../lib/runtime.mjs';
import { createGateway } from '../server.mjs';

const testDir = dirname(fileURLToPath(import.meta.url));
const fixtureBinary = resolve(testDir, 'fixtures/fake-pi.mjs');
const expectedText = 'Review: Café 👋 is clear.';

function fixture(t, scenario = 'success', overrides = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'pi-gateway-test-'));
  mkdirSync(resolve(root, scenario));
  mkdirSync(resolve(root, 'agent'));
  writeFileSync(resolve(root, 'system.md'), 'Offline reviewer fixture.');
  writeFileSync(resolve(root, 'extension.ts'), '// Offline fixture placeholder.');
  writeFileSync(resolve(root, 'skill.md'), 'Offline fixture placeholder.');
  chmodSync(fixtureBinary, 0o755);
  const profile = { id: 'offline-reviewer', provider: 'offline-test', model: 'pinned-test-model',
    piBinary: fixtureBinary, projects: { fixture: scenario }, maxRuns: 20,
    startupTimeoutMs: 1500, runTimeoutMs: 4000, cancelGraceMs: 150,
    agentDir: 'agent', extension: 'extension.ts', skill: 'skill.md',
    systemPrompt: 'system.md', tools: ['read'], ...overrides };
  const stateDir = resolve(root, 'state');
  const runtime = new Runtime({ root, profile, stateDir });
  const result = { root, profile, stateDir, runtime, gateway: null };
  t.after(async () => {
    if (result.gateway) await result.gateway.close();
    else await runtime.shutdown();
    rmSync(root, { recursive: true, force: true });
  });
  return result;
}

async function until(predicate, label, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(10);
  }
  assert.fail(`Timed out waiting for ${label}`);
}
function start(context) { return context.runtime.start({ prompt: 'Review the fixture.', project: 'fixture' }); }
async function finished(context, id) {
  await until(() => TERMINAL.has(context.runtime.runs.get(id).status), `run ${id} to finish`);
  return context.runtime.runs.get(id);
}
function commands(run) {
  return readFileSync(resolve(run.directory, 'fixture-commands.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
}
function assertReaped(run) {
  assert.equal(run.childExited, true, 'terminal status must wait until the Pi child exits');
  assert.throws(() => process.kill(run.pid, 0), error => error.code === 'ESRCH', 'Pi process must not survive the terminal receipt');
}
async function serve(context) {
  context.token = 'offline-test-token-01234567890123456789';
  context.gateway = createGateway({ ...context, token: context.token });
  await new Promise((resolvePromise, reject) => {
    context.gateway.server.once('error', reject);
    context.gateway.server.listen(0, '127.0.0.1', resolvePromise);
  });
  context.url = `http://127.0.0.1:${context.gateway.server.address().port}`;
  context.request = (path, init = {}) => fetch(context.url + path, {
    ...init, signal: AbortSignal.timeout(6500),
    headers: { authorization: `Bearer ${context.token}`, ...init.headers },
  });
  context.submit = () => context.request('/runs', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'Review the fixture.', project: 'fixture' }) });
  return context;
}
function parseSse(text) {
  return text.split('\n\n').filter(block => block.includes('\ndata: ')).map(block => {
    const dataLine = block.split('\n').find(line => line.startsWith('data: '));
    return JSON.parse(dataLine.slice(6));
  });
}

test('each run checks fresh state and pinned model before prompting, then persists a complete receipt', { timeout: 12000 }, async t => {
  const context = fixture(t);
  const first = await finished(context, start(context).id);
  assert.equal(first.status, 'completed');
  assert.equal(first.initialMessageCount, 0);
  assert.equal(first.provider, context.profile.provider);
  assert.equal(first.model, context.profile.model);
  assert.deepEqual(commands(first).slice(1).map(command => command.type), ['get_state', 'prompt']);
  const args = commands(first)[0].args;
  for (const flag of ['--offline', '--no-session', '--no-extensions', '--no-skills', '--no-context-files']) assert.ok(args.includes(flag), flag);
  assert.ok(args.includes('--skill'));
  assert.ok(args.includes('-e'));
  assert.equal(first.events.at(-1).type, 'terminal');
  assert.ok(first.hooks.some(hook => hook.hook === 'runtime.before_provider_request'));
  assertReaped(first);
  const receipt = JSON.parse(readFileSync(resolve(first.directory, 'receipt.json'), 'utf8'));
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.childExited, true);
  const second = await finished(context, start(context).id);
  assert.equal(second.status, 'completed');
  assert.equal(second.initialMessageCount, 0);
  assert.notEqual(second.sessionId, first.sessionId);
  assert.notEqual(second.id, first.id);
  assertReaped(second);
});

test('streaming preserves multibyte UTF-8 split across stdout chunks', { timeout: 8000 }, async t => {
  const context = fixture(t);
  const run = await finished(context, start(context).id);
  assert.equal(run.text, expectedText);
  assert.deepEqual(run.events.filter(event => event.type === 'text_delta').map(event => event.text), ['Review: ', 'Café 👋', ' is clear.']);
  assert.equal(run.status, 'completed');
});

for (const [scenario, error] of [['wrong-model', 'unexpected_model'], ['wrong-provider', 'unexpected_model'], ['stale-session', 'session_not_fresh']]) {
  test(`rejects ${scenario} before sending the prompt`, { timeout: 8000 }, async t => {
    const context = fixture(t, scenario);
    const run = await finished(context, start(context).id);
    assert.equal(run.status, 'failed');
    assert.equal(run.error, error);
    assert.deepEqual(commands(run).slice(1).map(command => command.type), ['get_state']);
    assertReaped(run);
  });
}

for (const [scenario, error] of [['provider-error', 'provider_error'], ['early-exit', 'pi_exited_before_completion'], ['prompt-rejected', 'prompt_rejected'], ['missing-hook', 'required_hook_missing'], ['invalid-json', 'invalid_rpc_json']]) {
  test(`${scenario} produces a failed terminal receipt`, { timeout: 8000 }, async t => {
    const context = fixture(t, scenario);
    const run = await finished(context, start(context).id);
    assert.equal(run.status, 'failed');
    assert.equal(run.error, error);
    assert.equal(run.events.at(-1).type, 'terminal');
    assert.equal(run.events.at(-1).status, 'failed');
    if (scenario === 'early-exit') assert.equal(run.exitCode, 7);
    assertReaped(run);
  });
}

test('cancellation sends clear_queue then abort, records acknowledgement, and reaps Pi', { timeout: 8000 }, async t => {
  const context = fixture(t, 'stall');
  const { id } = start(context);
  await until(() => context.runtime.runs.get(id).hooks.length, 'provider hook');
  assert.equal(context.runtime.cancel(id).status, 'cancelling');
  const run = await finished(context, id);
  assert.equal(run.status, 'cancelled');
  assert.equal(run.abortAcknowledged, true);
  assert.deepEqual(commands(run).slice(-2).map(command => command.type), ['clear_queue', 'abort']);
  assert.equal(run.events.filter(event => event.type === 'cancel_ack').length, 1);
  assert.equal(run.events.filter(event => event.type === 'terminal').length, 1);
  assertReaped(run);
});

test('cancellation reaps an unresponsive RPC peer after its grace period', { timeout: 8000 }, async t => {
  const context = fixture(t, 'abort-hang');
  const { id } = start(context);
  await until(() => context.runtime.runs.get(id).hooks.length, 'provider hook');
  context.runtime.cancel(id);
  const run = await finished(context, id);
  assert.equal(run.status, 'cancelled');
  assert.notEqual(run.abortAcknowledged, true);
  assertReaped(run);
});

test('HTTP requires bearer auth, refuses browser origins, validates projects, and enforces one active run', { timeout: 12000 }, async t => {
  const context = await serve(fixture(t, 'stall'));
  const unauthorized = await fetch(context.url + '/health', { signal: AbortSignal.timeout(3000) });
  assert.equal(unauthorized.status, 401);
  assert.equal((await context.request('/health', { headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await context.request('/health', { headers: { origin: 'http://localhost:8000' } })).status, 403);
  const health = await context.request('/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).openaiCompatible, false);
  const unknownProject = await context.request('/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'Review.', project: '../unconfigured' }) });
  assert.equal(unknownProject.status, 400);
  assert.equal(context.runtime.runs.size, 0, 'invalid requests must not spawn a worker');
  const submitted = await context.submit();
  assert.equal(submitted.status, 202);
  const run = await submitted.json();
  const busy = await context.submit();
  assert.equal(busy.status, 409);
  assert.equal(context.runtime.runs.size, 1);
  const cancelled = await context.request(`/runs/${run.id}/cancel`, { method: 'POST' });
  assert.equal(cancelled.status, 202);
  assertReaped(await finished(context, run.id));
});

test('SSE streams text and a terminal event, closes, and replays from Last-Event-ID', { timeout: 12000 }, async t => {
  const context = await serve(fixture(t));
  const response = await context.submit();
  const { id } = await response.json();
  const stream = await context.request(`/runs/${id}/events`);
  assert.equal(stream.status, 200);
  assert.equal(stream.headers.get('content-type'), 'text/event-stream');
  const events = parseSse(await stream.text());
  assert.equal(events.filter(event => event.type === 'text_delta').map(event => event.text).join(''), expectedText);
  assert.equal(events.at(-1).type, 'terminal');
  assert.equal(events.at(-1).status, 'completed');
  assert.equal(events.at(-1).childExited, true);
  assert.equal(new Set(events.map(event => event.seq)).size, events.length);
  assert.equal(events.filter(event => event.type === 'terminal').length, 1);
  const after = events.find(event => event.type === 'text_delta').seq;
  const replay = await context.request(`/runs/${id}/events`, { headers: { 'last-event-id': String(after) } });
  assert.deepEqual(parseSse(await replay.text()).map(event => event.seq), events.filter(event => event.seq > after).map(event => event.seq));
  const nothingLeft = await context.request(`/runs/${id}/events`, { headers: { 'last-event-id': String(events.at(-1).seq) } });
  assert.equal(await nothingLeft.text(), '');
  assert.equal(context.runtime.listenerCount('event'), 0, 'closed SSE streams must release listeners');
});

test('event saturation fails closed and still emits a terminal SSE event and receipt', { timeout: 12000 }, async t => {
  const context = await serve(fixture(t, 'event-flood'));
  const response = await context.submit();
  const { id } = await response.json();
  const stream = await context.request(`/runs/${id}/events`);
  const events = parseSse(await stream.text());
  const run = await finished(context, id);
  assert.equal(run.status, 'failed');
  assert.equal(run.error, 'event_limit');
  assert.equal(events.at(-1).type, 'terminal');
  assert.equal(events.at(-1).status, 'failed');
  assert.equal(run.events.filter(event => event.type === 'terminal').length, 1);
  assertReaped(run);
});


test('only the explicitly selected cloud key reaches Pi and no key enters receipts', { timeout: 8000 }, async t => {
  const context = fixture(t);
  const secret = 'synthetic-private-provider-key';
  context.runtime.workerEnv = { PI_GATEWAY_PROVIDER_API_KEY: secret, ANTHROPIC_API_KEY: 'unselected-key' };
  const spawnProcess = context.runtime.spawnProcess;
  let childEnv;
  context.runtime.spawnProcess = (command, args, options) => {
    childEnv = options.env;
    return spawnProcess(command, args, options);
  };
  const run = await finished(context, start(context).id);
  assert.equal(run.status, 'completed');
  assert.equal(childEnv.PI_GATEWAY_PROVIDER_API_KEY, secret);
  assert.equal(childEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(JSON.stringify(context.runtime.snapshot(run)).includes(secret), false);
  assert.equal(readFileSync(resolve(run.directory, 'receipt.json'), 'utf8').includes(secret), false);
  assert.equal(readFileSync(resolve(run.directory, 'events.jsonl'), 'utf8').includes(secret), false);
});

test('Ollama workers receive no cloud credential even when the caller supplies one', { timeout: 8000 }, async t => {
  const context = fixture(t, 'success', { provider: 'ollama' });
  context.runtime.workerEnv = { PI_GATEWAY_PROVIDER_API_KEY: 'unselected-key' };
  const spawnProcess = context.runtime.spawnProcess;
  let childEnv;
  context.runtime.spawnProcess = (command, args, options) => {
    childEnv = options.env;
    return spawnProcess(command, args, options);
  };
  const run = await finished(context, start(context).id);
  assert.equal(run.status, 'completed');
  assert.equal(childEnv.PI_GATEWAY_PROVIDER_API_KEY, undefined);
});
