import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProfile, prepareAgent } from '../lib/config.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function workspace(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'pi-config-test-'));
  const write = (path, value) => {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), typeof value === 'string' ? value : JSON.stringify(value));
  };
  write('config/profile.json', {});
  write('profile/harness.ts', '// portable hook');
  write('profile/reviewer.md', 'Portable reviewer.');
  write('profile/review-skill/SKILL.md', 'Portable review skill.');
  write('fixtures/review-project/AGENTS.md', 'Fixture project.');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, write, load: env => loadProfile({ root, env: env || {} }) };
}
function override(fixture, value, env = {}) {
  fixture.write('custom/config.json', value);
  return fixture.load({ PI_GATEWAY_PROFILE: resolve(fixture.root, 'custom/config.json'), ...env });
}

test('shipped profile is portable and defaults load without global Pi files or a Pi installation', t => {
  const fixture = workspace(t);
  const shippedSource = readFileSync(resolve(repository, 'config/profile.json'), 'utf8');
  fixture.write('config/profile.json', shippedSource);
  const { profile: shipped } = fixture.load();
  assert.equal(shipped.piBinary, 'pi');
  assert.equal(shipped.model, 'qwen3-coder-next:latest');
  assert.deepEqual(shipped.extensions, []);
  assert.ok(!Object.values(JSON.parse(shippedSource)).some(value => typeof value === 'string' && value.startsWith('/')), 'shipped configuration must not depend on absolute machine paths');
  const { profile, stateDir, port } = fixture.load();
  assert.equal(profile.id, 'pi-runtime-local');
  assert.equal(profile.provider, 'ollama');
  assert.equal(profile.piVersion, '0.85.1');
  assert.equal(profile.contextWindow, 48000);
  assert.equal(profile.maxTokens, 4096);
  assert.equal(profile.projectContextFile, 'AGENTS.md');
  assert.equal(profile.systemPrompt, resolve(fixture.root, 'profile/reviewer.md'));
  assert.equal(profile.projects.proof, resolve(fixture.root, 'fixtures/review-project'));
  assert.equal(profile.agentDir, undefined);
  assert.equal(stateDir, resolve(fixture.root, '.runtime'));
  assert.equal(port, 4319);
  assert.equal(existsSync(stateDir), false, 'loading configuration must not write files');
});

test('custom profile paths resolve beside that profile while inherited paths remain rooted at the project', t => {
  const fixture = workspace(t);
  fixture.write('custom/prompt.md', 'Custom prompt.');
  fixture.write('custom/project-a/AGENTS.md', 'Custom project.');
  fixture.write('custom/addon.ts', '// custom hook');
  fixture.write('custom/bin/pi-test', '#!/bin/sh\n');
  const { profile, stateDir, port } = override(fixture, {
    id: 'custom-review', piBinary: './bin/pi-test', systemPrompt: 'prompt.md',
    projects: { app: 'project-a' }, extensions: [{ name: 'addon', path: 'addon.ts' }],
    stateDir: 'private-state', port: 0,
  });
  assert.equal(profile.id, 'custom-review');
  assert.equal(profile.piBinary, resolve(fixture.root, 'custom/bin/pi-test'));
  assert.equal(profile.systemPrompt, resolve(fixture.root, 'custom/prompt.md'));
  assert.equal(profile.extension, resolve(fixture.root, 'profile/harness.ts'));
  assert.equal(profile.skill, resolve(fixture.root, 'profile/review-skill/SKILL.md'));
  assert.deepEqual(profile.projects, { app: resolve(fixture.root, 'custom/project-a') });
  assert.deepEqual(profile.extensions, [{ name: 'addon', path: resolve(fixture.root, 'custom/addon.ts') }]);
  assert.equal(stateDir, resolve(fixture.root, 'custom/private-state'));
  assert.equal(port, 0);
});

test('environment overrides win, bare executables stay bare, and explicit env paths use cwd', t => {
  const fixture = workspace(t);
  fixture.write('custom/bin/pi-test', '#!/bin/sh\n');
  const piPath = resolve(fixture.root, 'custom/bin/pi-test');
  const { profile, stateDir, port } = override(fixture, { model: 'profile-model', port: 80 }, {
    PI_GATEWAY_MODEL: 'environment-model:tag', PI_GATEWAY_PI_BINARY: relative(process.cwd(), piPath),
    PI_GATEWAY_OLLAMA_URL: 'https://ollama.example:8443/prefix/',
    PI_GATEWAY_STATE_DIR: 'relative-private-state', PI_GATEWAY_PORT: '65535',
  });
  assert.equal(profile.model, 'environment-model:tag');
  assert.equal(profile.piBinary, piPath);
  assert.equal(profile.ollamaUrl, 'https://ollama.example:8443/prefix');
  assert.equal(stateDir, resolve(process.cwd(), 'relative-private-state'));
  assert.equal(port, 65535);
  assert.equal(override(fixture, {}, { PI_GATEWAY_PI_BINARY: 'pi-custom' }).profile.piBinary, 'pi-custom');
});

test('home paths expand using the OS home directory', t => {
  const fixture = workspace(t);
  const result = override(fixture, { projects: { home: '~/' }, stateDir: '~/pi-test-state' });
  assert.equal(result.profile.projects.home, homedir());
  assert.equal(result.stateDir, resolve(homedir(), 'pi-test-state'));
  assert.throws(() => override(fixture, { stateDir: '~someone/state' }), /home expansion/);
});

test('.env parsing honors quotes without expanding shell or variable expressions', t => {
  const fixture = workspace(t);
  fixture.write('.env', [
    '# local setup',
    'PI_GATEWAY_MODEL="model with spaces:tag"',
    'PI_GATEWAY_STATE_DIR="./state ${HOME} $(touch SHOULD_NOT_EXIST)"',
    "PI_GATEWAY_OLLAMA_URL='http://127.0.0.1:11435'",
    'PI_GATEWAY_PORT=0',
    '',
  ].join('\n'));
  const { profile, stateDir, port } = fixture.load();
  assert.equal(profile.model, 'model with spaces:tag');
  assert.equal(profile.ollamaUrl, 'http://127.0.0.1:11435');
  assert.equal(stateDir, resolve(fixture.root, 'state ${HOME} $(touch SHOULD_NOT_EXIST)'));
  assert.equal(port, 0);
  assert.equal(existsSync(resolve(fixture.root, 'SHOULD_NOT_EXIST')), false);
});

test('dotenv paths follow their env file while process env takes precedence and follows cwd', t => {
  const fixture = workspace(t);
  fixture.write('setup/private.env', 'PI_GATEWAY_PROFILE=./review.json\nPI_GATEWAY_STATE_DIR=./state\nPI_GATEWAY_PI_BINARY=./bin/pi-test\nPI_GATEWAY_MODEL=dotenv-model\nPI_GATEWAY_PORT=4000\n');
  fixture.write('setup/review.json', { id: 'dotenv-profile', model: 'profile-model' });
  fixture.write('setup/bin/pi-test', '#!/bin/sh\n');
  const env = { PI_GATEWAY_ENV_FILE: resolve(fixture.root, 'setup/private.env') };
  const fromFile = fixture.load(env);
  assert.equal(fromFile.profile.id, 'dotenv-profile');
  assert.equal(fromFile.profile.model, 'dotenv-model');
  assert.equal(fromFile.profile.piBinary, resolve(fixture.root, 'setup/bin/pi-test'));
  assert.equal(fromFile.stateDir, resolve(fixture.root, 'setup/state'));
  const fromProcess = fixture.load({ ...env, PI_GATEWAY_MODEL: 'process-model', PI_GATEWAY_PORT: '0', PI_GATEWAY_STATE_DIR: './process-state' });
  assert.equal(fromProcess.profile.model, 'process-model');
  assert.equal(fromProcess.port, 0);
  assert.equal(fromProcess.stateDir, resolve(process.cwd(), 'process-state'));
});

test('an explicit missing env file fails without disclosing its contents or path', t => {
  const fixture = workspace(t);
  assert.throws(() => fixture.load({ PI_GATEWAY_ENV_FILE: resolve(fixture.root, 'secret-token-not-a-file') }), error => {
    assert.match(error.message, /environment file/);
    assert.equal(error.message.includes('secret-token'), false);
    return true;
  });
});

for (const [name, value] of [
  ['unknown profile settings', { unknown: 'secret-value' }],
  ['invalid provider slugs', { provider: '../cloud' }],
  ['an arbitrary agent directory', { agentDir: '/secret-global-agent' }],
  ['write tools', { tools: ['read', 'write'] }],
  ['duplicate tools', { tools: ['read', 'read'] }],
  ['empty tools', { tools: [] }],
  ['fractional limits', { maxRuns: 1.5 }],
  ['negative limits', { startupTimeoutMs: -1 }],
  ['excessive deadlines', { runTimeoutMs: 86400001 }],
  ['token budget beyond context', { contextWindow: 2048, maxTokens: 4096 }],
  ['invalid ports', { port: 65536 }],
  ['noninteger ports', { port: '4319' }],
  ['missing prompt', { systemPrompt: 'missing-prompt.md' }],
  ['missing project', { projects: { app: 'missing-project' } }],
  ['empty projects', { projects: {} }],
  ['escaping context files', { projectContextFile: '../private.md' }],
  ['absolute context files', { projectContextFile: '/private.md' }],
  ['invalid extension entries', { extensions: [{ name: 'unsafe', path: 'missing.ts', enabled: true }] }],
]) {
  test(`configuration rejects ${name}`, t => {
    const fixture = workspace(t);
    assert.throws(() => override(fixture, value), /^Error: Invalid gateway configuration:/);
  });
}

for (const url of ['file:///secret-value', 'http://user:secret-value@localhost:11434', 'http://localhost:11434?key=secret-value', 'http://localhost:11434#secret-value', 'http://localhost:11434?', 'http://localhost:11434#']) {
  test(`Ollama URL rejects unsupported credentials or URL components (${url.split(':')[0]})`, t => {
    const fixture = workspace(t);
    assert.throws(() => override(fixture, { ollamaUrl: url }), error => {
      assert.match(error.message, /HTTP\(S\) URL/);
      assert.equal(error.message.includes('secret-value'), false);
      return true;
    });
  });
}

test('environment port validation rejects coercible junk instead of silently using it', t => {
  const fixture = workspace(t);
  for (const port of ['', ' ', '-1', '4.2', '1e3', '65536', 'Infinity'])
    assert.throws(() => fixture.load({ PI_GATEWAY_PORT: port }), /integer/);
});

test('prepareAgent generates private Ollama models/settings without inheriting auth or global identity', t => {
  const fixture = workspace(t);
  const { profile, stateDir } = override(fixture, { model: 'portable-model:tag', contextWindow: 32768, maxTokens: 2048 });
  const prepared = prepareAgent(profile, stateDir);
  assert.equal(prepared.agentDir, resolve(stateDir, 'agent'));
  assert.equal(profile.agentDir, undefined, 'prepare must not mutate the input profile');
  assert.deepEqual(readdirSync(prepared.agentDir).sort(), ['models.json', 'settings.json']);
  const models = JSON.parse(readFileSync(resolve(prepared.agentDir, 'models.json'), 'utf8'));
  assert.deepEqual(Object.keys(models.providers), ['ollama']);
  assert.equal(models.providers.ollama.baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(models.providers.ollama.api, 'openai-completions');
  assert.equal(models.providers.ollama.apiKey, 'ollama');
  assert.equal(models.providers.ollama.models[0].id, 'portable-model:tag');
  assert.equal(models.providers.ollama.models[0].contextWindow, 32768);
  assert.equal(models.providers.ollama.models[0].maxTokens, 2048);
  const settings = JSON.parse(readFileSync(resolve(prepared.agentDir, 'settings.json'), 'utf8'));
  assert.equal(settings.defaultProvider, 'ollama');
  assert.equal(settings.defaultModel, 'portable-model:tag');
  assert.equal(settings.defaultProjectTrust, 'never');
  assert.equal(settings.compaction.enabled, false);
  assert.equal(settings.retry.enabled, false);
  assert.equal(statSync(prepared.agentDir).mode & 0o777, 0o700);
  for (const name of ['models.json', 'settings.json']) assert.equal(statSync(resolve(prepared.agentDir, name)).mode & 0o777, 0o600);
  prepareAgent({ ...profile, model: 'replacement-model', ollamaUrl: 'http://127.0.0.1:11434/v1' }, stateDir);
  const updated = JSON.parse(readFileSync(resolve(prepared.agentDir, 'models.json'), 'utf8'));
  assert.equal(updated.providers.ollama.baseUrl.endsWith('/v1/v1'), false);
  assert.equal(updated.providers.ollama.models[0].id, 'replacement-model');
});

test('prepareAgent refuses an existing credential file or linked global agent directory', t => {
  const fixture = workspace(t);
  const { profile, stateDir } = fixture.load();
  fixture.write('.runtime/agent/auth.json', { credential: 'must-not-read-or-copy' });
  assert.throws(() => prepareAgent(profile, stateDir), /must not contain credentials/);
  assert.equal(existsSync(resolve(stateDir, 'agent/models.json')), false);
  const linkState = resolve(fixture.root, 'linked-state');
  mkdirSync(linkState);
  mkdirSync(resolve(fixture.root, 'foreign-agent'));
  symlinkSync(resolve(fixture.root, 'foreign-agent'), resolve(linkState, 'agent'));
  assert.throws(() => prepareAgent(profile, linkState), /isolated/);
  assert.deepEqual(readdirSync(resolve(fixture.root, 'foreign-agent')), []);
});


test('prepareAgent supports restarts with Pi-generated empty auth and models-store files', t => {
  const fixture = workspace(t);
  const { profile, stateDir } = fixture.load();
  const first = prepareAgent(profile, stateDir);
  fixture.write('.runtime/agent/auth.json', '{}\n');
  fixture.write('.runtime/agent/models-store.json', '{}\n');
  const restarted = prepareAgent(profile, stateDir);
  assert.equal(restarted.agentDir, first.agentDir);
  assert.equal(readFileSync(resolve(first.agentDir, 'auth.json'), 'utf8'), '{}\n');
  assert.equal(readFileSync(resolve(first.agentDir, 'models-store.json'), 'utf8'), '{}\n');
  assert.equal(JSON.parse(readFileSync(resolve(first.agentDir, 'settings.json'), 'utf8')).defaultModel, profile.model);
});

test('prepareAgent rejects an auth symlink even if its target contains an empty object', t => {
  const fixture = workspace(t);
  const { profile, stateDir } = fixture.load();
  mkdirSync(resolve(stateDir, 'agent'), { recursive: true });
  fixture.write('external-auth.json', '{}');
  symlinkSync(resolve(fixture.root, 'external-auth.json'), resolve(stateDir, 'agent/auth.json'));
  assert.throws(() => prepareAgent(profile, stateDir), /regular JSON file/);
  assert.equal(existsSync(resolve(stateDir, 'agent/models.json')), false);
});


test('prepareAgent also refuses a dangling auth symlink instead of leaving it for Pi to follow', t => {
  const fixture = workspace(t);
  const { profile, stateDir } = fixture.load();
  mkdirSync(resolve(stateDir, 'agent'), { recursive: true });
  symlinkSync(resolve(fixture.root, 'does-not-exist.json'), resolve(stateDir, 'agent/auth.json'));
  assert.throws(() => prepareAgent(profile, stateDir), /regular JSON file/);
  assert.equal(existsSync(resolve(fixture.root, 'does-not-exist.json')), false);
});


test('cloud configuration separates the provider credential from the serializable profile', t => {
  const fixture = workspace(t);
  const key = 'cloud-secret-must-never-be-persisted';
  const result = override(fixture, { provider: 'anthropic', model: 'claude-test-model' }, { PI_GATEWAY_API_KEY: key });
  assert.equal(result.profile.provider, 'anthropic');
  assert.equal(result.profile.model, 'claude-test-model');
  assert.deepEqual(result.workerEnv, { PI_GATEWAY_PROVIDER_API_KEY: key });
  assert.equal(JSON.stringify(result.profile).includes(key), false);
  assert.equal(Object.hasOwn(result.profile, 'apiKey'), false);
  assert.equal(Object.hasOwn(result.profile, 'workerEnv'), false);
});

test('dotenv cloud provider/model/key are overridden only by explicit process values', t => {
  const fixture = workspace(t);
  fixture.write('.env', 'PI_GATEWAY_PROVIDER=anthropic\nPI_GATEWAY_MODEL=claude-dotenv\nPI_GATEWAY_API_KEY=dotenv-secret\n');
  const fromFile = fixture.load();
  assert.equal(fromFile.profile.provider, 'anthropic');
  assert.equal(fromFile.profile.model, 'claude-dotenv');
  assert.deepEqual(fromFile.workerEnv, { PI_GATEWAY_PROVIDER_API_KEY: 'dotenv-secret' });
  const fromProcess = fixture.load({ PI_GATEWAY_PROVIDER: 'openai', PI_GATEWAY_MODEL: 'gpt-explicit', PI_GATEWAY_API_KEY: 'process-secret' });
  assert.equal(fromProcess.profile.provider, 'openai');
  assert.equal(fromProcess.profile.model, 'gpt-explicit');
  assert.deepEqual(fromProcess.workerEnv, { PI_GATEWAY_PROVIDER_API_KEY: 'process-secret' });
  assert.equal(JSON.stringify(fromProcess.profile).includes('secret'), false);
});

test('cloud requires an explicit provider model and gateway API key with safe error messages', t => {
  const fixture = workspace(t);
  assert.throws(() => fixture.load({ PI_GATEWAY_PROVIDER: 'openai', PI_GATEWAY_API_KEY: 'never-show-this-secret' }), error => {
    assert.match(error.message, /Select a model supported/);
    assert.equal(error.message.includes('never-show-this-secret'), false);
    return true;
  });
  for (const env of [{}, { OPENAI_API_KEY: 'unapproved-global-secret' }, { PI_GATEWAY_API_KEY: '' }, { PI_GATEWAY_API_KEY: ' ' }])
    assert.throws(() => override(fixture, { provider: 'openai', model: 'gpt-test' }, env), /PI_GATEWAY_API_KEY is required/);
  assert.throws(() => override(fixture, { provider: 'openai', model: 'gpt-test' }, { PI_GATEWAY_API_KEY: 'never-show-this-secret\ninvalid' }), error => {
    assert.match(error.message, /PI_GATEWAY_API_KEY/);
    assert.equal(error.message.includes('never-show-this-secret'), false);
    return true;
  });
  for (const value of [{ apiKey: 'never-show-this-secret' }, { PI_GATEWAY_API_KEY: 'never-show-this-secret' }, { workerEnv: { PI_GATEWAY_PROVIDER_API_KEY: 'never-show-this-secret' } }])
    assert.throws(() => override(fixture, value), /Unknown profile setting/);
});

test('local Ollama configuration neither requires nor forwards a cloud credential', t => {
  const fixture = workspace(t);
  const result = fixture.load({ PI_GATEWAY_API_KEY: 'irrelevant-secret', OPENAI_API_KEY: 'global-secret' });
  assert.equal(result.profile.provider, 'ollama');
  assert.deepEqual(result.workerEnv, {});
  assert.equal(JSON.stringify(result.profile).includes('secret'), false);
  const prepared = prepareAgent(result.profile, result.stateDir);
  assert.equal(existsSync(resolve(prepared.agentDir, 'auth.json')), false);
  assert.equal(JSON.parse(readFileSync(resolve(prepared.agentDir, 'models.json'), 'utf8')).providers.ollama.apiKey, 'ollama');
});

test('cloud preparation uses Pi catalogs and persists only the fixed environment reference', t => {
  const fixture = workspace(t);
  const key = 'cloud-secret-must-never-be-written';
  const { profile, stateDir } = fixture.load({ PI_GATEWAY_PROVIDER: 'openai', PI_GATEWAY_MODEL: 'gpt-test', PI_GATEWAY_API_KEY: key });
  const prepared = prepareAgent(profile, stateDir);
  assert.deepEqual(JSON.parse(readFileSync(resolve(prepared.agentDir, 'models.json'), 'utf8')), { providers: {} });
  assert.deepEqual(JSON.parse(readFileSync(resolve(prepared.agentDir, 'auth.json'), 'utf8')), {
    openai: { type: 'api_key', key: '$PI_GATEWAY_PROVIDER_API_KEY' },
  });
  const settings = JSON.parse(readFileSync(resolve(prepared.agentDir, 'settings.json'), 'utf8'));
  assert.equal(settings.defaultProvider, 'openai');
  assert.equal(settings.defaultModel, 'gpt-test');
  for (const file of readdirSync(prepared.agentDir)) {
    assert.equal(readFileSync(resolve(prepared.agentDir, file), 'utf8').includes(key), false);
    assert.equal(statSync(resolve(prepared.agentDir, file)).mode & 0o777, 0o600);
  }
  prepareAgent(profile, stateDir);
  assert.equal(JSON.stringify(prepared).includes(key), false);
});

test('switching providers replaces managed auth references and clears obsolete provider configuration', t => {
  const fixture = workspace(t);
  const cloud = fixture.load({ PI_GATEWAY_PROVIDER: 'anthropic', PI_GATEWAY_MODEL: 'claude-test', PI_GATEWAY_API_KEY: 'secret-a' });
  const agent = prepareAgent(cloud.profile, cloud.stateDir).agentDir;
  const second = fixture.load({ PI_GATEWAY_PROVIDER: 'openai', PI_GATEWAY_MODEL: 'gpt-test', PI_GATEWAY_API_KEY: 'secret-b' });
  prepareAgent(second.profile, second.stateDir);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(resolve(agent, 'auth.json'), 'utf8'))), ['openai']);
  const local = fixture.load();
  prepareAgent(local.profile, local.stateDir);
  assert.deepEqual(JSON.parse(readFileSync(resolve(agent, 'auth.json'), 'utf8')), {});
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(resolve(agent, 'models.json'), 'utf8')).providers), ['ollama']);
  assert.equal(JSON.parse(readFileSync(resolve(agent, 'settings.json'), 'utf8')).defaultProvider, 'ollama');
  prepareAgent(cloud.profile, cloud.stateDir);
  assert.deepEqual(JSON.parse(readFileSync(resolve(agent, 'models.json'), 'utf8')), { providers: {} });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(resolve(agent, 'auth.json'), 'utf8'))), ['anthropic']);
});

test('managed auth accepts only exact gateway reference entries and never overwrites arbitrary credentials', t => {
  const fixture = workspace(t);
  const { profile, stateDir } = fixture.load({ PI_GATEWAY_PROVIDER: 'openai', PI_GATEWAY_MODEL: 'gpt-test', PI_GATEWAY_API_KEY: 'secret' });
  for (const existing of [
    { openai: { type: 'api_key', key: 'real-secret' } },
    { openai: { type: 'api_key', key: '$OPENAI_API_KEY' } },
    { openai: { type: 'api_key', key: '$PI_GATEWAY_PROVIDER_API_KEY', env: { EXTRA: 'secret' } } },
    { openai: { type: 'oauth', key: '$PI_GATEWAY_PROVIDER_API_KEY' } },
    { 'invalid/provider': { type: 'api_key', key: '$PI_GATEWAY_PROVIDER_API_KEY' } },
    [],
  ]) {
    fixture.write('.runtime/agent/auth.json', existing);
    assert.throws(() => prepareAgent(profile, stateDir), /credentials or unmanaged references/);
    assert.deepEqual(JSON.parse(readFileSync(resolve(stateDir, 'agent/auth.json'), 'utf8')), existing);
  }
  fixture.write('.runtime/agent/auth.json', {
    anthropic: { type: 'api_key', key: '$PI_GATEWAY_PROVIDER_API_KEY' },
    openai: { type: 'api_key', key: '$PI_GATEWAY_PROVIDER_API_KEY' },
  });
  prepareAgent(profile, stateDir);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(resolve(stateDir, 'agent/auth.json'), 'utf8'))), ['openai']);
});
