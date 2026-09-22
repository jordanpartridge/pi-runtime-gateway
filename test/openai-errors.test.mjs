import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Runtime, TERMINAL } from '../lib/runtime.mjs';
import { createGateway } from '../server.mjs';

const fixtureBinary = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-pi.mjs');
const token = 'offline-errors-token-01234567890123456789';
async function serve(t, scenario = 'stall', overrides = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'pi-gateway-http-errors-'));
  mkdirSync(resolve(root, scenario)); mkdirSync(resolve(root, 'agent'));
  for (const name of ['system.md', 'extension.ts', 'skill.md']) writeFileSync(resolve(root, name), 'Offline HTTP error fixture.');
  chmodSync(fixtureBinary, 0o755);
  const profile = { id: 'offline-reviewer', provider: 'offline-test', model: 'pinned-test-model',
    piBinary: fixtureBinary, projects: { fixture: scenario }, maxRuns: 10,
    startupTimeoutMs: 1500, runTimeoutMs: 4000, cancelGraceMs: 150,
    agentDir: 'agent', extension: 'extension.ts', skill: 'skill.md',
    systemPrompt: 'system.md', tools: ['read'], ...overrides };
  const stateDir = resolve(root, 'state');
  const runtime = new Runtime({ root, profile, stateDir });
  const gateway = createGateway({ root, profile, stateDir, token, runtime });
  t.after(async () => { await gateway.close(); rmSync(root, { recursive: true, force: true }); });
  await new Promise((ready, reject) => { gateway.server.once('error', reject); gateway.server.listen(0, '127.0.0.1', ready); });
  const url = `http://127.0.0.1:${gateway.server.address().port}`;
  const body = { model: 'offline-reviewer/fixture', messages: [{ role: 'user', content: 'Review the fixture.' }] };
  const request = (path, init = {}) => fetch(url + path, { ...init, signal: init.signal || AbortSignal.timeout(6000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers } });
  const submit = (extra = {}, init = {}) => request('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ ...body, ...extra }), ...init });
  return { runtime, gateway, request, submit };
}
async function until(predicate, label) {
  const deadline = Date.now() + 5500;
  while (Date.now() < deadline) { const value = predicate(); if (value) return value; await delay(10); }
  assert.fail(`Timed out waiting for ${label}`);
}
function assertReaped(run) {
  assert.equal(run.childExited, true);
  assert.throws(() => process.kill(run.pid, 0), error => error.code === 'ESRCH');
}
async function expectError(response, status, code) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(typeof body.error.message, 'string');
  assert.equal(typeof body.error.type, 'string');
  assert.equal(body.error.param, null);
  assert.equal(body.error.code, code);
}

test('OpenAI malformed JSON, content type, and oversized bodies fail before starting Pi', async t => {
  const c = await serve(t);
  await expectError(await c.submit({}, { headers: { 'content-type': 'text/plain' } }), 415, 'unsupported_media_type');
  await expectError(await c.submit({}, { body: '{malformed' }), 400, 'invalid_json');
  await expectError(await c.submit({}, { body: ' '.repeat(192001) }), 413, 'request_too_large');
  assert.equal(c.runtime.runs.size, 0);
});

test('OpenAI unsupported routes and browser origins retain the OpenAI error envelope', async t => {
  const c = await serve(t);
  await expectError(await c.request('/v1/responses', { method: 'POST', body: '{}' }), 404, 'not_found');
  await expectError(await c.request('/v1/models', { headers: { origin: 'https://example.test' } }), 403, 'browser_origin_not_allowed');
  assert.equal(c.runtime.runs.size, 0);
});

test('a busy worker returns a shaped conflict without starting another process', async t => {
  const c = await serve(t);
  const started = c.runtime.start({ prompt: 'Hold this worker.', project: 'fixture' });
  await expectError(await c.submit(), 409, 'worker_busy');
  assert.equal(c.runtime.runs.size, 1);
  c.runtime.cancel(started.id);
  const run = await until(() => { const run = c.runtime.runs.get(started.id); return TERMINAL.has(run.status) && run; }, 'busy worker cancellation');
  assertReaped(run);
});

test('run capacity returns a shaped rate-limit response without spawning', async t => {
  const c = await serve(t, 'stall', { maxRuns: 0 });
  await expectError(await c.submit(), 429, 'run_limit_reached');
  assert.equal(c.runtime.runs.size, 0);
});

test('failed streaming requests remain HTTP errors and never commit an SSE success', async t => {
  const c = await serve(t, 'provider-error');
  const response = await c.submit({ stream: true });
  await expectError(response, 502, 'worker_failed');
  assert.equal(response.headers.get('content-type'), 'application/json');
  const run = [...c.runtime.runs.values()][0];
  assert.equal(run.status, 'failed'); assertReaped(run);
  assert.equal(response.headers.get('x-pi-run-id'), run.id);
  assert.equal(c.runtime.listenerCount('event'), 0);
});

test('disconnecting a buffered OpenAI request cancels and reaps Pi', async t => {
  const c = await serve(t);
  const controller = new AbortController();
  const pending = c.submit({}, { signal: controller.signal });
  const rejected = assert.rejects(pending, error => error.name === 'AbortError');
  const run = await until(() => [...c.runtime.runs.values()].find(run => run.status === 'running'), 'buffered worker startup');
  controller.abort(); await rejected;
  await until(() => TERMINAL.has(run.status), 'buffered disconnect cancellation');
  assert.equal(run.status, 'cancelled'); assertReaped(run);
  assert.equal(c.runtime.listenerCount('event'), 0);
});

test('oversized SSE output fails before success headers and after reaping its worker', async t => {
  const c = await serve(t);
  const pending = c.submit({ stream: true });
  const run = await until(() => [...c.runtime.runs.values()].find(run => run.hooks.some(hook => hook.hook === 'chat.context')), 'chat provider hooks');
  c.runtime.handle(run, { type: 'message_end', message: { role: 'assistant', stopReason: 'stop',
    content: [{ type: 'text', text: 'x'.repeat(1000001) }] } });
  c.runtime.handle(run, { type: 'agent_settled' });
  await expectError(await pending, 502, 'response_too_large');
  assert.equal(run.status, 'completed'); assertReaped(run);
  assert.equal(c.runtime.listenerCount('event'), 0);
});

test('buffered startup timeouts report a gateway timeout after Pi exits', async t => {
  const c = await serve(t, 'startup-hang', { startupTimeoutMs: 150 });
  await expectError(await c.submit(), 504, 'worker_timeout');
  const run = [...c.runtime.runs.values()][0];
  assert.equal(run.status, 'failed'); assertReaped(run);
});
