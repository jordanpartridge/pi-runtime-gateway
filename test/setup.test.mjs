import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { setup, readSecret, listOllamaModels } from '../scripts/setup.mjs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = resolve(root, 'scripts/setup.mjs');
function temporary(t) {
  const directory = mkdtempSync(resolve(tmpdir(), 'pi-gateway-setup-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function run(directory, args = [], options = {}) {
  const result = spawnSync(process.execPath, [script, '--directory', directory, ...args], { encoding: 'utf8', timeout: 5000, ...options });
  assert.ifError(result.error);
  return result;
}
const parseEnvironment = contents => parseEnv(contents);

test('setup creates a private .env from the portable template and a minimal local profile', t => {
  const directory = temporary(t);
  const result = run(directory);
  assert.equal(result.status, 0, result.stderr);
  const path = resolve(directory, '.env');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readFileSync(path, 'utf8'), readFileSync(resolve(root, '.env.example'), 'utf8'));
  const values = parseEnvironment(readFileSync(path, 'utf8'));
  assert.equal(values.PI_GATEWAY_PROFILE, 'config/local.json');
  assert.equal(values.PI_GATEWAY_PI_BINARY, 'pi');
  assert.equal(values.PI_GATEWAY_OLLAMA_URL, 'http://127.0.0.1:11434');
  assert.deepEqual(JSON.parse(readFileSync(resolve(directory, 'config/local.json'), 'utf8')), { id: 'local-reviewer', extensions: [] });
});

test('setup dotenv values round-trip through the actual Node parser without evaluation', t => {
  const directory = temporary(t);
  const model = 'qwen-special:"quoted"$MODEL`literal`';
  const result = run(directory, ['--model', model, '--pi-binary', '~/bin/"quoted pi"', '--ollama-url', 'http://127.0.0.1:12345/v1', '--port', '0', '--state-dir', 'state with spaces/$(literal)/back\\nslash']);
  assert.equal(result.status, 0, result.stderr);
  const values = parseEnvironment(readFileSync(resolve(directory, '.env'), 'utf8'));
  assert.equal(values.PI_GATEWAY_MODEL, model);
  assert.equal(values.PI_GATEWAY_PI_BINARY, '~/bin/"quoted pi"');
  assert.equal(values.PI_GATEWAY_OLLAMA_URL, 'http://127.0.0.1:12345/v1');
  assert.equal(values.PI_GATEWAY_PORT, '0');
  assert.equal(values.PI_GATEWAY_STATE_DIR, 'state with spaces/$(literal)/back\\nslash');
});

test('setup preserves existing files and clearly reports unapplied overrides', t => {
  const directory = temporary(t);
  mkdirSync(resolve(directory, 'config'));
  const environment = 'PI_GATEWAY_MODEL="user-model"\n';
  const profile = '{"id":"user-profile","extensions":[]}\n';
  writeFileSync(resolve(directory, '.env'), environment);
  writeFileSync(resolve(directory, 'config/local.json'), profile);
  const result = run(directory, ['--model', 'requested-new-model']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Preserved existing .env/);
  assert.match(result.stdout, /Requested overrides were not applied/);
  assert.equal(readFileSync(resolve(directory, '.env'), 'utf8'), environment);
  assert.equal(readFileSync(resolve(directory, 'config/local.json'), 'utf8'), profile);
});

test('setup repeat is idempotent and can create a missing profile beside an existing .env', t => {
  const directory = temporary(t);
  writeFileSync(resolve(directory, '.env'), 'PI_GATEWAY_MODEL="existing"\n');
  const first = run(directory);
  assert.equal(first.status, 0, first.stderr);
  assert.ok(existsSync(resolve(directory, 'config/local.json')));
  const before = readFileSync(resolve(directory, 'config/local.json'), 'utf8');
  const second = run(directory);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(resolve(directory, '.env'), 'utf8'), 'PI_GATEWAY_MODEL="existing"\n');
  assert.equal(readFileSync(resolve(directory, 'config/local.json'), 'utf8'), before);
});

test('setup validates malformed options before creating any files', t => {
  const directory = temporary(t);
  for (const args of [['--unknown'], ['--model'], ['--model='], ['--model', 'bad\nline'], ['--port', '-1'], ['--port', '1.5'], ['--port', '65536'], ['--ollama-url', 'ftp://localhost'], ['--ollama-url', 'http://user:password@localhost'], ['--ollama-url', 'http://localhost?q=x']]) {
    const result = run(directory, args);
    assert.notEqual(result.status, 0, JSON.stringify(args));
    assert.match(result.stderr, /pi-runtime-gateway setup:/);
  }
  assert.equal(existsSync(resolve(directory, '.env')), false);
  assert.equal(existsSync(resolve(directory, 'config')), false);
});

test('setup help is read-only and destination supports ~/ expansion', t => {
  const home = temporary(t);
  const help = run(home, ['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: node scripts\/setup.mjs/);
  assert.equal(existsSync(resolve(home, '.env')), false);
  const result = run('~/gateway-config', [], { env: { ...process.env, HOME: home } });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(resolve(home, 'gateway-config/.env')));
});


test('setup rejects values whose quote characters prevent an exact dotenv round-trip', t => {
  const directory = temporary(t);
  const result = run(directory, ['--model', `both'"quotes`]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot be represented safely with dotenv quoting/);
  assert.equal(existsSync(resolve(directory, '.env')), false);
  assert.equal(existsSync(resolve(directory, 'config')), false);
});


function fakeIO(answers = [], { isTTY = true, key = 'synthetic-private-key' } = {}) {
  const messages = [], questions = [];
  return {
    isTTY, messages, questions,
    log: value => messages.push(value),
    ask: async (label, fallback = '') => {
      questions.push(label);
      assert.ok(answers.length, `Unexpected setup question: ${label}`);
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return answer || fallback;
    },
    secret: async label => { questions.push(label); return key; },
  };
}
const piProbe = async () => ({ available: true, version: '0.85.1' });

test('first terminal setup selects an exact installed tool model and prefers Qwen coder', async t => {
  const directory = temporary(t);
  const io = fakeIO(['1', '', '1', '']);
  let lookups = 0;
  const result = await setup({ args: ['--directory', directory], env: {}, io, probePi: piProbe,
    getModels: async url => { lookups++; assert.equal(url, 'http://127.0.0.1:11434'); return { models: [
      { name: 'small-general:actual', tools: true }, { name: 'qwen-coder:installed-tag', tools: true },
      { name: 'qwen-coder:unsupported', tools: false },
    ] }; } });
  assert.equal(result.createdEnvironment, true);
  assert.equal(lookups, 1);
  const values = parseEnvironment(readFileSync(resolve(directory, '.env'), 'utf8'));
  assert.equal(values.PI_GATEWAY_MODEL, 'qwen-coder:installed-tag');
  assert.equal(values.PI_GATEWAY_PROVIDER, 'ollama');
  assert.equal(values.PI_GATEWAY_API_KEY, undefined);
  assert.ok(io.messages.some(message => message.includes('supports tool calls')));
});

test('non-interactive setup never probes services or prompts even when a TTY exists', async t => {
  const directory = temporary(t);
  await setup({ args: ['--directory', directory, '--non-interactive'], env: {}, io: fakeIO(),
    probePi: async () => assert.fail('Must not probe Pi'), getModels: async () => assert.fail('Must not probe Ollama') });
  assert.ok(existsSync(resolve(directory, '.env')));
});

test('explicit interactive setup requires a terminal and conflicting modes are rejected', async t => {
  const directory = temporary(t);
  await assert.rejects(setup({ args: ['--directory', directory, '--interactive'], io: fakeIO([], { isTTY: false }) }), /requires a terminal/);
  const result = run(directory, ['--interactive', '--non-interactive']);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(resolve(directory, '.env')), false);
});

test('cloud wizard hides the API key and records only the chosen provider and exact model', async t => {
  const directory = temporary(t);
  const secret = 'synthetic-cloud-secret';
  const io = fakeIO(['2', 'openai', 'selected-provider-model', ''], { key: secret });
  await setup({ args: ['--directory', directory], env: {}, io, probePi: piProbe,
    getModels: async () => assert.fail('Cloud setup must not query Ollama') });
  const values = parseEnvironment(readFileSync(resolve(directory, '.env'), 'utf8'));
  assert.equal(values.PI_GATEWAY_PROVIDER, 'openai');
  assert.equal(values.PI_GATEWAY_MODEL, 'selected-provider-model');
  assert.equal(values.PI_GATEWAY_API_KEY, secret);
  assert.equal(statSync(resolve(directory, '.env')).mode & 0o777, 0o600);
  assert.ok(io.questions.includes('API key (hidden)'));
  assert.ok(io.messages.some(message => message.includes('API usage may be billed')));
  assert.equal(io.messages.join(' ').includes(secret), false);
});

test('non-interactive cloud setup requires provider model and key before writing files', t => {
  const directory = temporary(t);
  const env = { ...process.env }; delete env.PI_GATEWAY_API_KEY;
  for (const args of [['--provider', 'openai'], ['--provider', 'openai', '--model', 'cloud-model'], ['--provider', 'unsupported']]) {
    const result = run(directory, ['--non-interactive', ...args], { env });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(resolve(directory, 'config')), false);
  }
  const success = run(directory, ['--non-interactive', '--provider', 'anthropic', '--model', 'cloud-model'], { env: { ...env, PI_GATEWAY_API_KEY: 'synthetic-environment-key' } });
  assert.equal(success.status, 0, success.stderr);
  assert.equal(parseEnvironment(readFileSync(resolve(directory, '.env'), 'utf8')).PI_GATEWAY_API_KEY, 'synthetic-environment-key');
  assert.doesNotMatch(success.stdout + success.stderr, /synthetic-environment-key/);
});

test('API keys supplied through argv are rejected without echoing the value', t => {
  const directory = temporary(t);
  for (const args of [['--api-key', 'must-not-print'], ['--api-key=must-not-print']]) {
    const result = run(directory, args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not accepted on the command line/);
    assert.doesNotMatch(result.stdout + result.stderr, /must-not-print/);
  }
  assert.equal(existsSync(resolve(directory, '.env')), false);
});

test('project selection saves an absolute real directory and rejects missing projects before writes', t => {
  const directory = temporary(t), project = temporary(t);
  const invalid = run(directory, ['--project', resolve(project, 'missing')]);
  assert.notEqual(invalid.status, 0);
  assert.equal(existsSync(resolve(directory, 'config')), false);
  const valid = run(directory, ['--project', project]);
  assert.equal(valid.status, 0, valid.stderr);
  assert.deepEqual(JSON.parse(readFileSync(resolve(directory, 'config/local.json'), 'utf8')).projects, { app: project });
});

test('wizard cancellation and a missing model leave no partial configuration', async t => {
  const directory = temporary(t);
  await assert.rejects(setup({ args: ['--directory', directory], env: {}, io: fakeIO([new Error('Setup cancelled')]), probePi: piProbe }), /cancelled/);
  assert.equal(existsSync(resolve(directory, 'config')), false);
  await assert.rejects(setup({ args: ['--directory', directory], env: {}, io: fakeIO(['1', '', '', '']), probePi: piProbe,
    getModels: async () => ({ unavailable: true, models: [] }) }), /PI_GATEWAY_MODEL requires/);
  assert.equal(existsSync(resolve(directory, '.env')), false);
  assert.equal(existsSync(resolve(directory, 'config')), false);
});

test('hidden terminal input never echoes the key and restores raw mode on success and cancellation', async () => {
  for (const cancelled of [false, true]) {
    const input = new EventEmitter();
    Object.assign(input, { isTTY: true, isRaw: false, setRawMode(value) { this.isRaw = value; }, pause() {}, resume() {} });
    let output = '';
    const answer = readSecret('API key: ', { input, output: { isTTY: true, write: value => { output += value; } } });
    assert.equal(input.isRaw, true);
    input.emit('data', Buffer.from(cancelled ? 'private-key\x03' : 'private-key\r'));
    if (cancelled) await assert.rejects(answer, /cancelled/);
    else assert.equal(await answer, 'private-key');
    assert.equal(input.isRaw, false);
    assert.equal(input.listenerCount('data'), 0);
    assert.equal(output.includes('private-key'), false);
  }
});

test('Ollama discovery reads metadata only and filters models that report no tool support', async () => {
  const calls = [];
  const result = await listOllamaModels('http://localhost:11434/v1', { fetcher: async (url, options) => {
    calls.push({ url, options });
    assert.ok(options.signal instanceof AbortSignal);
    if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: 'qwen-coder:exact' }, { name: 'embed:latest' }, { name: 'legacy:tag' }] }) };
    const { model } = JSON.parse(options.body);
    return { ok: true, json: async () => model === 'legacy:tag' ? {} : { capabilities: model === 'embed:latest' ? ['embedding'] : ['completion', 'tools'] } };
  } });
  assert.deepEqual(result.models, [{ name: 'qwen-coder:exact', tools: true }, { name: 'legacy:tag', tools: null }]);
  assert.equal(calls.length, 4);
  assert.ok(calls.every(call => /\/api\/(tags|show)$/.test(call.url)));
  const unavailable = await listOllamaModels('http://localhost:11434', { fetcher: async () => { throw new Error('offline'); } });
  assert.equal(unavailable.unavailable, true);
});

test('setup runs doctor on the actual preserved settings and reports failure without claiming ready', async t => {
  const directory = temporary(t);
  writeFileSync(resolve(directory, '.env.example'), readFileSync(resolve(root, '.env.example'), 'utf8'));
  const io = fakeIO([], { isTTY: false });
  const report = { ok: false, checks: [{ name: 'Pi', status: 'fail', message: 'Pi is missing.' }, { name: 'Key', status: 'warn', message: 'Not validated remotely.' }] };
  let inspected = 0;
  const inspectSetup = async options => { inspected++; assert.equal(options.root, directory); assert.ok(existsSync(resolve(directory, '.env'))); return report; };
  const result = await setup({ args: [], root: directory, io, env: {}, inspectSetup });
  assert.equal(result.ready, false);
  assert.equal(inspected, 1);
  assert.ok(io.messages.includes('[FAIL] Pi: Pi is missing.'));
  assert.equal(io.messages.includes('Next: npm start'), false);
  const before = readFileSync(resolve(directory, '.env'), 'utf8');
  await setup({ args: ['--model', 'must-not-replace'], root: directory, io, env: {}, inspectSetup });
  assert.equal(inspected, 2);
  assert.equal(readFileSync(resolve(directory, '.env'), 'utf8'), before);
});

test('skip-check works for automation and alternate-directory setup never installs a launcher', async t => {
  const directory = temporary(t);
  writeFileSync(resolve(directory, '.env.example'), readFileSync(resolve(root, '.env.example'), 'utf8'));
  await setup({ args: ['--skip-check', '--non-interactive'], root: directory, io: fakeIO(), env: {}, inspectSetup: async () => assert.fail('Doctor should be skipped') });
  const alternate = temporary(t);
  await assert.rejects(setup({ args: ['--directory', alternate, '--install'], root: directory, io: fakeIO([], { isTTY: false }) }), /only available when setting up this checkout/);
  assert.equal(existsSync(resolve(alternate, '.env')), false);
});
