import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverOllamaModels, inspectSetup } from '../lib/doctor.mjs';
import { main } from '../scripts/doctor.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function fixture(t, { version = '0.85.1', profile = {} } = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'pi-gateway-doctor-test-'));
  for (const path of ['config', 'profile/review-skill', 'fixtures/review-project']) mkdirSync(resolve(root, path), { recursive: true });
  const piBinary = resolve(root, 'fake-pi');
  const calls = resolve(root, 'pi-calls.jsonl');
  writeFileSync(piBinary, `#!${process.execPath}
import {appendFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({args:process.argv.slice(2),hasKey:!!process.env.PI_GATEWAY_API_KEY||!!process.env.PI_GATEWAY_PROVIDER_API_KEY})+'\\n');
if (JSON.stringify(process.argv.slice(2)) !== '["--version"]') process.exit(9);
console.log(${JSON.stringify(version)});
`, { mode: 0o755 });
  // The extensionless executable uses the fixture package's explicit module mode.
  writeFileSync(resolve(root, 'package.json'), '{"type":"module"}');
  writeFileSync(resolve(root, 'config/profile.json'), JSON.stringify({ piBinary, model: 'test-model:latest', ...profile }));
  writeFileSync(resolve(root, 'profile/harness.ts'), 'export default function() {}');
  writeFileSync(resolve(root, 'profile/reviewer.md'), 'Synthetic doctor fixture.');
  writeFileSync(resolve(root, 'profile/review-skill/SKILL.md'), 'Synthetic skill.');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, piBinary, calls, stateDir: resolve(root, '.runtime'), env: {} };
}
async function ollama(t, models = ['test-model:latest'], status = 200) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: models.map(name => ({ name })) }));
  });
  await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
  t.after(() => new Promise(resolvePromise => server.close(resolvePromise)));
  return { requests, url: `http://127.0.0.1:${server.address().port}` };
}
function check(report, name) { return report.checks.find(item => item.name === name); }

test('discovery strips /v1 and uses one bounded GET without credentials or inference', async () => {
  let calls = 0;
  const names = await discoverOllamaModels({ url: 'http://localhost:11434/proxy/v1/', fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'http://localhost:11434/proxy/api/tags');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    assert.deepEqual(options.headers, { Accept: 'application/json' });
    return { ok: true, json: async () => ({ models: [{ name: 'one:latest' }, { model: 'two:small' }, { name: 'one:latest' }] }) };
  } });
  assert.equal(calls, 1);
  assert.deepEqual(names, ['one:latest', 'two:small']);
});

test('discovery sanitizes transport and payload errors and refuses credential-bearing URLs', async () => {
  const secret = 'must-not-appear-in-diagnostics';
  await assert.rejects(discoverOllamaModels({ url: `https://user:${secret}@example.invalid`, fetchImpl: async () => assert.fail('must not fetch') }), error => !error.message.includes(secret));
  await assert.rejects(discoverOllamaModels({ url: 'http://localhost', fetchImpl: async () => { throw new Error(secret); } }), error => !error.message.includes(secret));
  await assert.rejects(discoverOllamaModels({ url: 'http://localhost', fetchImpl: async () => ({ ok: false }) }), /unsuccessful HTTP response/);
  await assert.rejects(discoverOllamaModels({ url: 'http://localhost', fetchImpl: async () => ({ ok: true, json: async () => ({ models: 'invalid' }) }) }), /invalid model list/);
  await assert.rejects(discoverOllamaModels({ url: 'http://localhost', fetchImpl: async () => ({ ok: true, json: async () => ({ models: [{ name: 'unsafe\nname' }] }) }) }), /invalid model name/);
});

test('doctor validates saved setup and an installed model without creating runtime state', async t => {
  const context = fixture(t);
  const api = await ollama(t);
  const report = await inspectSetup({ root: context.root, env: { PI_GATEWAY_OLLAMA_URL: api.url + '/v1' } });
  assert.equal(report.ok, true, JSON.stringify(report));
  for (const name of ['Node.js', 'Configuration', 'Pi', 'State directory', 'Ollama', 'Selected model']) assert.equal(check(report, name).status, 'pass');
  assert.deepEqual(report.models, ['test-model:latest']);
  assert.deepEqual(api.requests, [{ method: 'GET', url: '/api/tags', authorization: undefined }]);
  assert.equal(existsSync(context.stateDir), false);
  const calls = readFileSync(context.calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls, [{ args: ['--version'], hasKey: false }]);
});

test('doctor accepts the default latest tag alias and does not match a different tag', async t => {
  const context = fixture(t, { profile: { model: 'test-model' } });
  const api = await ollama(t, ['test-model:latest']);
  const report = await inspectSetup({ root: context.root, env: { PI_GATEWAY_OLLAMA_URL: api.url } });
  assert.equal(report.ok, true);
  const different = await inspectSetup({ root: context.root, env: { PI_GATEWAY_OLLAMA_URL: api.url, PI_GATEWAY_MODEL: 'test-model:other' } });
  assert.equal(different.ok, false);
  assert.equal(check(different, 'Selected model').status, 'fail');
});

test('an empty Ollama installation explains the actual pull command and fails model readiness', async t => {
  const context = fixture(t);
  const api = await ollama(t, []);
  const report = await inspectSetup({ root: context.root, env: { PI_GATEWAY_OLLAMA_URL: api.url } });
  assert.equal(report.ok, false);
  assert.deepEqual(report.models, []);
  assert.equal(check(report, 'Installed models').status, 'warn');
  assert.match(check(report, 'Installed models').message, /ollama pull test-model:latest/);
  assert.equal(check(report, 'Selected model').status, 'fail');
});

test('Ollama HTTP failures are actionable setup failures without inference attempts', async t => {
  const context = fixture(t);
  const api = await ollama(t, [], 503);
  const report = await inspectSetup({ root: context.root, env: { PI_GATEWAY_OLLAMA_URL: api.url } });
  assert.equal(report.ok, false);
  assert.equal(check(report, 'Ollama').status, 'fail');
  assert.equal(api.requests.length, 1);
  assert.equal(api.requests[0].url, '/api/tags');
});

test('Pi version errors never echo executable output or credentials', async t => {
  const secret = 'synthetic-private-output';
  const context = fixture(t, { version: secret });
  const api = await ollama(t);
  const report = await inspectSetup({ root: context.root, env: { PI_GATEWAY_OLLAMA_URL: api.url, PI_GATEWAY_API_KEY: secret } });
  assert.equal(report.ok, false);
  assert.equal(check(report, 'Pi').status, 'fail');
  assert.equal(JSON.stringify(report).includes(secret), false);
  assert.equal(JSON.parse(readFileSync(context.calls, 'utf8').trim()).hasKey, false);
});

test('cloud doctor checks explicit credentials without contacting any provider', async t => {
  const context = fixture(t, { profile: { provider: 'openai', model: 'synthetic-cloud-model' } });
  const secret = 'synthetic-cloud-secret-never-display';
  const api = await ollama(t);
  const report = await inspectSetup({ root: context.root, env: { PI_GATEWAY_API_KEY: secret, PI_GATEWAY_OLLAMA_URL: api.url } });
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(check(report, 'Cloud credentials').status, 'pass');
  assert.equal(check(report, 'Cloud inference').status, 'warn');
  assert.match(check(report, 'Cloud inference').message, /No cloud provider request was made/);
  assert.equal(api.requests.length, 0);
  assert.equal(JSON.stringify(report).includes(secret), false);
  assert.equal(existsSync(context.stateDir), false);
  assert.equal(JSON.parse(readFileSync(context.calls, 'utf8').trim()).hasKey, false);
});

test('missing cloud credentials and invalid projects fail configuration before execution', async t => {
  const cloud = fixture(t, { profile: { provider: 'openai', model: 'synthetic-cloud-model' } });
  const report = await inspectSetup({ root: cloud.root, env: {} });
  assert.equal(report.ok, false);
  assert.match(check(report, 'Configuration').message, /PI_GATEWAY_API_KEY is required/);
  assert.equal(existsSync(cloud.calls), false);
  const badProject = fixture(t, { profile: { projects: { missing: 'does-not-exist' } } });
  const invalid = await inspectSetup({ root: badProject.root, env: {} });
  assert.equal(invalid.ok, false);
  assert.equal(check(invalid, 'Configuration').status, 'fail');
  assert.equal(existsSync(badProject.calls), false);
});

test('doctor preserves active agent files, token, and ownership lock', async t => {
  const context = fixture(t);
  const api = await ollama(t);
  mkdirSync(resolve(context.stateDir, 'agent'), { recursive: true });
  const files = new Map([
    ['agent/models.json', '{"sentinel":"active-models"}'],
    ['agent/auth.json', '{"sentinel":"active-auth-do-not-read"}'],
    ['server.lock', '{"pid":123,"nonce":"active"}'],
    ['token', 'synthetic-active-token-do-not-display'],
  ]);
  for (const [path, contents] of files) writeFileSync(resolve(context.stateDir, path), contents);
  const before = readdirSync(context.stateDir).sort();
  const report = await inspectSetup({ root: context.root, env: { PI_GATEWAY_OLLAMA_URL: api.url } });
  assert.equal(report.ok, true);
  assert.deepEqual(readdirSync(context.stateDir).sort(), before);
  for (const [path, contents] of files) assert.equal(readFileSync(resolve(context.stateDir, path), 'utf8'), contents);
  assert.equal(JSON.stringify(report).includes('synthetic-active-token-do-not-display'), false);
});

test('doctor main prints a concise report and direct script failures return nonzero', async t => {
  const context = fixture(t);
  const api = await ollama(t);
  const lines = [];
  const report = await main({ root: context.root, env: { PI_GATEWAY_OLLAMA_URL: api.url }, output: line => lines.push(line) });
  assert.equal(report.ok, true);
  assert.ok(lines.some(line => line.startsWith('[PASS] Pi:')));
  assert.equal(lines.at(-1), 'Setup checks passed. No inference was run.');
  const child = spawnSync(process.execPath, [resolve(repositoryRoot, 'scripts/doctor.mjs')], {
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, PI_GATEWAY_ENV_FILE: resolve(context.root, 'missing.env'), PI_GATEWAY_API_KEY: 'synthetic-script-secret' },
  });
  assert.ifError(child.error);
  assert.equal(child.status, 1);
  assert.match(child.stdout, /\[FAIL\] Configuration:/);
  assert.equal((child.stdout + child.stderr).includes('synthetic-script-secret'), false);
});


test('doctor detects a blocked or dangling state path without creating directories', async t => {
  const context = fixture(t);
  const api = await ollama(t);
  const blocked = resolve(context.root, 'not-a-directory');
  writeFileSync(blocked, 'existing file');
  const dangling = resolve(context.root, 'dangling');
  symlinkSync('missing-target', dangling);
  for (const state of [resolve(blocked, 'state'), resolve(dangling, 'state')]) {
    const report = await inspectSetup({ root: context.root, env: { PI_GATEWAY_OLLAMA_URL: api.url, PI_GATEWAY_STATE_DIR: state } });
    assert.equal(report.ok, false);
    assert.equal(check(report, 'State directory').status, 'fail');
  }
  assert.equal(existsSync(resolve(context.root, 'missing-target')), false);
  assert.equal(readFileSync(blocked, 'utf8'), 'existing file');
});
