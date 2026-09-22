import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = resolve(root, 'bin/pi-runtime-gateway.mjs');
const installer = resolve(root, 'scripts/install.mjs');
function temporary(t) {
  const directory = mkdtempSync(resolve(tmpdir(), 'pi-gateway-cli-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function run(script, args = [], options = {}) {
  const result = spawnSync(process.execPath, ['--', script, ...args], { encoding: 'utf8', timeout: 5000, ...options });
  assert.ifError(result.error);
  return result;
}
function cliFixture(t, withServer = false) {
  const directory = temporary(t);
  mkdirSync(resolve(directory, 'bin'));
  copyFileSync(cli, resolve(directory, 'bin/pi-runtime-gateway.mjs'));
  writeFileSync(resolve(directory, 'package.json'), JSON.stringify({ type: 'module', version: '7.8.9' }));
  if (withServer) writeFileSync(resolve(directory, 'server.mjs'), `export async function startServer({root, env}) {
    console.log(JSON.stringify({root, env: Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('PI_GATEWAY_')))}));
  }`);
  return { directory, cli: resolve(directory, 'bin/pi-runtime-gateway.mjs') };
}

test('CLI help and version work without importing a server or starting Pi', t => {
  const fixture = cliFixture(t);
  const help = run(fixture.cli, ['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: pi-runtime-gateway/);
  for (const option of ['--env-file', '--profile', '--state-dir', '--port', '--pi-binary']) assert.ok(help.stdout.includes(option));
  const version = run(fixture.cli, ['--version']);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), '7.8.9');
});

test('installed source CLI reports the actual package version', () => {
  const result = run(cli, ['--version']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version);
});

test('CLI rejects malformed options before importing the server', t => {
  const fixture = cliFixture(t);
  for (const args of [
    ['--unknown'], ['start'], ['--env-file'], ['--profile'], ['--state-dir'], ['--pi-binary'],
    ['--port'], ['--port', '--version'], ['--profile='], ['--port', '-1'],
    ['--port', '1.5'], ['--port', 'abc'], ['--port', '65536'], ['--port', ''],
    ['--help', '--surprise'], ['--help', '--version'],
  ]) {
    const result = run(fixture.cli, args);
    assert.notEqual(result.status, 0, JSON.stringify(args));
    assert.match(result.stderr, /pi-runtime-gateway:/);
    assert.doesNotMatch(result.stderr, /Cannot find module/);
  }
});

test('CLI forwards explicit options and inherited environment to startServer', t => {
  const fixture = cliFixture(t, true);
  const result = run(fixture.cli, ['--env-file', '~/runtime.env', '--profile', '~/profile.json', '--state-dir=~/state', '--port', '0', '--pi-binary', './pi'], {
    cwd: tmpdir(), env: { ...process.env, HOME: fixture.directory, PI_GATEWAY_PORT: '9999', PI_GATEWAY_CUSTOM: 'retained' },
  });
  assert.equal(result.status, 0, result.stderr);
  const invocation = JSON.parse(result.stdout);
  assert.equal(invocation.root, fixture.directory);
  assert.equal(invocation.env.PI_GATEWAY_ENV_FILE, resolve(fixture.directory, 'runtime.env'));
  assert.equal(invocation.env.PI_GATEWAY_PROFILE, resolve(fixture.directory, 'profile.json'));
  assert.equal(invocation.env.PI_GATEWAY_STATE_DIR, resolve(fixture.directory, 'state'));
  assert.equal(invocation.env.PI_GATEWAY_PORT, '0');
  assert.equal(invocation.env.PI_GATEWAY_PI_BINARY, './pi');
  assert.equal(invocation.env.PI_GATEWAY_CUSTOM, 'retained');
});

test('installer creates a usable executable symlink and is idempotent', t => {
  const directory = resolve(temporary(t), 'bin');
  const destination = resolve(directory, 'pi-runtime-gateway');
  const first = run(installer, ['--bin-dir', directory]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(lstatSync(destination).isSymbolicLink(), true);
  assert.equal(realpathSync(destination), realpathSync(cli));
  const help = spawnSync(destination, ['--help'], { encoding: 'utf8', timeout: 5000 });
  assert.ifError(help.error);
  assert.equal(help.status, 0, help.stderr);
  const before = readlinkSync(destination);
  const again = run(installer, ['--bin-dir', directory]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /Already installed/);
  assert.equal(readlinkSync(destination), before);
});

test('installer defaults to ~/.local/bin and expands an explicit ~/bin-dir', t => {
  const home = temporary(t);
  const env = { ...process.env, HOME: home };
  const defaultInstall = run(installer, [], { env });
  assert.equal(defaultInstall.status, 0, defaultInstall.stderr);
  assert.equal(realpathSync(resolve(home, '.local/bin/pi-runtime-gateway')), realpathSync(cli));
  const explicitInstall = run(installer, ['--bin-dir=~/other-bin'], { env });
  assert.equal(explicitInstall.status, 0, explicitInstall.stderr);
  assert.equal(realpathSync(resolve(home, 'other-bin/pi-runtime-gateway')), realpathSync(cli));
});

test('installer refuses to replace an existing file or unrelated dangling symlink', t => {
  const directory = temporary(t);
  const existingFileBin = resolve(directory, 'file-bin');
  mkdirSync(existingFileBin);
  const existingFile = resolve(existingFileBin, 'pi-runtime-gateway');
  writeFileSync(existingFile, 'user-owned file');
  const fileResult = run(installer, ['--bin-dir', existingFileBin]);
  assert.notEqual(fileResult.status, 0);
  assert.match(fileResult.stderr, /Refusing to overwrite/);
  assert.equal(readFileSync(existingFile, 'utf8'), 'user-owned file');
  const existingLinkBin = resolve(directory, 'link-bin');
  mkdirSync(existingLinkBin);
  const existingLink = resolve(existingLinkBin, 'pi-runtime-gateway');
  symlinkSync('unrelated-missing-target', existingLink);
  const linkResult = run(installer, ['--bin-dir', existingLinkBin]);
  assert.notEqual(linkResult.status, 0);
  assert.match(linkResult.stderr, /Refusing to overwrite/);
  assert.equal(readlinkSync(existingLink), 'unrelated-missing-target');
});

test('installer rejects malformed options without creating a default installation', t => {
  const home = temporary(t);
  for (const args of [['--unknown'], ['--bin-dir'], ['--bin-dir='], ['--bin-dir', '--help'], ['--bin-dir', 'x', 'extra']]) {
    const result = run(installer, args, { env: { ...process.env, HOME: home } });
    assert.notEqual(result.status, 0, JSON.stringify(args));
    assert.match(result.stderr, /Usage:/);
  }
  assert.throws(() => lstatSync(resolve(home, '.local')), error => error.code === 'ENOENT');
});


test('symlink launch keeps --env-file in the CLI and resolves the repository root', t => {
  const fixture = cliFixture(t, true);
  const launchDir = resolve(temporary(t), 'bin');
  mkdirSync(launchDir);
  const launch = resolve(launchDir, 'pi-runtime-gateway');
  symlinkSync(fixture.cli, launch);
  const result = spawnSync(launch, ['--env-file', '~/runtime.env'], {
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, HOME: fixture.directory, NODE_OPTIONS: '--preserve-symlinks-main' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const invocation = JSON.parse(result.stdout);
  assert.equal(invocation.root, fixture.directory);
  assert.equal(invocation.env.PI_GATEWAY_ENV_FILE, resolve(fixture.directory, 'runtime.env'));
});
