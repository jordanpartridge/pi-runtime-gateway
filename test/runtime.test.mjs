import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
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

test('a complete invalid audit line advances the cursor, records the error, and does not hide later hooks', { timeout: 8000 }, async t => {
  const context = fixture(t, 'invalid-audit');
  const run = await finished(context, start(context).id);
  assert.equal(run.status, 'failed');
  assert.equal(run.error, 'invalid_audit_json');
  assert.equal(run.auditLines, 2);
  assert.equal(run.auditErrorCount, 1);
  assert.equal(run.auditErrorLine, 1);
  assert.ok(run.hooks.some(hook => hook.hook === 'runtime.before_provider_request'));
  assert.deepEqual(run.events.filter(event => event.type === 'audit_error').map(event =>
    ({ error: event.error, line: event.line })), [{ error: 'invalid_audit_json', line: 1 }]);
  context.runtime.collectAudit(run);
  assert.equal(run.auditLines, 2);
  assert.equal(run.auditErrorCount, 1);
});

test('receipt hashes the complete stderr stream without storing its contents', { timeout: 8000 }, async t => {
  const context = fixture(t, 'stderr-chunks');
  const run = await finished(context, start(context).id);
  const stderr = 'first stderr chunk\nsecond stderr chunk\n';
  const receiptText = readFileSync(resolve(run.directory, 'receipt.json'), 'utf8');
  const receipt = JSON.parse(receiptText);
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.stderrBytes, Buffer.byteLength(stderr));
  assert.equal(receipt.stderrSha256, createHash('sha256').update(stderr).digest('hex'));
  assert.equal(receiptText.includes('first stderr chunk'), false);
  assert.equal(receiptText.includes('second stderr chunk'), false);
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
  assert.equal((await health.json()).openaiCompatible, true);
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


const chatBody = (context, extra = {}) => ({ model: context.profile.model,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Review the fixture.' }] }], ...extra });
const submitChat = (context, body) => context.request('/v1/chat/completions', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const clientTool = { type: 'function', function: { name: 'lookup_status', description: 'Get issue status',
  parameters: { type: 'object', properties: { issue: { type: 'integer' } }, required: ['issue'] } } };

test('OpenAI routes authenticate, expose only configured models, and reject unsupported controls before spawning', async t => {
  const c = await serve(fixture(t));
  const unauth = await fetch(c.url + '/v1/models');
  assert.equal(unauth.status, 401);
  assert.equal(typeof (await unauth.json()).error.message, 'string');
  const models = await (await c.request('/v1/models')).json();
  assert.equal(models.object, 'list');
  assert.deepEqual(models.data.map(m => m.id), ['offline-reviewer/fixture']);
  for (const extra of [{ model: 'unconfigured' }, { temperature: 0.5 }, { n: 2 }, { tools: [{ type: 'web_search' }] }]) {
    const response = await submitChat(c, chatBody(c, extra));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.type, 'invalid_request_error');
  }
  assert.equal(c.runtime.runs.size, 0);
  const missing = await c.request('/v1/responses');
  assert.equal(missing.status, 404);
  assert.equal(typeof (await missing.json()).error.message, 'string');
});

test('OpenAI completion waits for reaping and returns only final answer and aggregated usage', async t => {
  const c = await serve(fixture(t, 'internal-tool'));
  const response = await submitChat(c, chatBody(c));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.object, 'chat.completion');
  assert.equal(result.choices[0].message.content, expectedText);
  assert.equal(result.choices[0].finish_reason, 'stop');
  assert.deepEqual(result.usage, { prompt_tokens: 33, completion_tokens: 13, total_tokens: 46 });
  assertReaped([...c.runtime.runs.values()][0]);
});

test('OpenAI SSE has standard deltas, requested usage and DONE with no Pi internal events', async t => {
  const c = await serve(fixture(t, 'internal-tool'));
  const response = await submitChat(c, chatBody(c, { stream: true, stream_options: { include_usage: true } }));
  assert.equal(response.status, 200);
  const stream = await response.text();
  assert.equal(stream.includes('Private internal narration'), false);
  assert.equal(stream.includes('runtime.before_provider_request'), false);
  assert.equal(stream.includes('data: [DONE]'), true);
  const chunks = stream.split('\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]')).map(line => JSON.parse(line.slice(6)));
  assert.equal(chunks.filter(c => c.choices.length).map(c => c.choices[0].delta.content || '').join(''), expectedText);
  assert.equal(chunks.at(-1).choices.length, 0);
  assert.equal(chunks.at(-1).usage.total_tokens, 46);
  assert.equal(chunks.at(-2).choices[0].finish_reason, 'stop');
  assert.equal(c.runtime.listenerCount('event'), 0);
});

test('OpenAI client tool calls complete with no text and support structured tool-result history', async t => {
  const c = await serve(fixture(t, 'client-tool'));
  const body = chatBody(c, { tools: [clientTool] });
  const response = await submitChat(c, body);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.choices[0].finish_reason, 'tool_calls');
  assert.equal(result.choices[0].message.content, null);
  const call = result.choices[0].message.tool_calls[0];
  assert.deepEqual(JSON.parse(call.function.arguments), { issue: 42 });
  assert.equal(call.function.name, 'lookup_status');
  assertReaped([...c.runtime.runs.values()][0]);
  const continuation = await submitChat(c, { ...body, messages: [...body.messages, result.choices[0].message,
    { role: 'tool', tool_call_id: call.id, content: 'closed' }] });
  assert.equal(continuation.status, 200);
  await continuation.json();
  const second = [...c.runtime.runs.values()][1];
  assert.equal(second.initialMessageCount, 0);
  assert.equal(commands(second).find(e => e.type === 'chat_fixture').chat.messages.at(-1).content, 'closed');
});

for (const scenario of ['provider-error', 'missing-chat-hook']) {
  test(`OpenAI ${scenario} cannot masquerade as a successful completion`, async t => {
    const c = await serve(fixture(t, scenario));
    const response = await submitChat(c, chatBody(c));
    assert.equal(response.status, 502);
    assert.equal(typeof (await response.json()).error.message, 'string');
    assertReaped([...c.runtime.runs.values()][0]);
  });
}

test('disconnecting an OpenAI stream cancels and reaps its worker', async t => {
  const c = await serve(fixture(t, 'stall'));
  const controller = new AbortController();
  const pending = fetch(c.url + '/v1/chat/completions', { method: 'POST', signal: controller.signal,
    headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(chatBody(c, { stream: true })) });
  const rejected = assert.rejects(pending, error => error.name === 'AbortError');
  await until(() => c.runtime.runs.size === 1, 'chat request accepted');
  controller.abort();
  await rejected;
  const run = [...c.runtime.runs.values()][0];
  await finished(c, run.id);
  assert.equal(run.status, 'cancelled');
  assertReaped(run);
});
