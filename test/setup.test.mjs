import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
