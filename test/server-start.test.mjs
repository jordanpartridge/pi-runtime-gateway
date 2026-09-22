import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startServer } from '../server.mjs';

function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'pi-gateway-start-test-'));
  for (const directory of ['config', 'profile/review-skill', 'fixtures/review-project']) mkdirSync(resolve(root, directory), { recursive: true });
  const binary = resolve(root, 'fake-pi');
  writeFileSync(binary, '#!/usr/bin/env node\nif (process.argv[2] !== "--version") process.exit(8);\nconsole.log("0.85.1");\n', { mode: 0o755 });
  writeFileSync(resolve(root, 'config/profile.json'), JSON.stringify({ piBinary: binary }));
  writeFileSync(resolve(root, 'profile/harness.ts'), 'export default function() {}');
  writeFileSync(resolve(root, 'profile/reviewer.md'), 'Synthetic startup test.');
  writeFileSync(resolve(root, 'profile/review-skill/SKILL.md'), 'Synthetic skill.');
  const stateDir = resolve(root, '.runtime');
  const gateways = [];
  t.after(async () => {
    for (const gateway of gateways) await gateway.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root, stateDir, lock: resolve(stateDir, 'server.lock'),
    async start(overrides = {}) {
      const gateway = await startServer({ root, env: { PI_GATEWAY_PORT: '0', PI_GATEWAY_STATE_DIR: stateDir, ...overrides } });
      gateways.push(gateway);
      return gateway;
    },
  };
}
function assertAbsent(path) { assert.throws(() => statSync(path), error => error.code === 'ENOENT'); }

test('a second server cannot mutate an owned state directory, even with another port or model', async t => {
  const context = fixture(t);
  const gateway = await context.start();
  const lock = JSON.parse(readFileSync(context.lock, 'utf8'));
  assert.equal(lock.pid, process.pid);
  assert.match(lock.nonce, /^[a-f0-9-]{36}$/);
  assert.deepEqual(Object.keys(lock).sort(), ['nonce', 'pid']);
  assert.equal(statSync(context.lock).mode & 0o777, 0o600);
  const modelFile = resolve(context.stateDir, 'agent/models.json');
  const before = readFileSync(modelFile, 'utf8');
  await assert.rejects(context.start({ PI_GATEWAY_MODEL: 'different-model', PI_GATEWAY_PORT: '0' }), /State directory is already owned/);
  assert.equal(readFileSync(modelFile, 'utf8'), before);
  assert.deepEqual(JSON.parse(readFileSync(context.lock, 'utf8')), lock);
  await gateway.close();
  assertAbsent(context.lock);
});

test('close removes its signal listeners and lock, allowing restart with Pi empty auth state', async t => {
  const context = fixture(t);
  const initialInt = process.listenerCount('SIGINT');
  const initialTerm = process.listenerCount('SIGTERM');
  const first = await context.start();
  const firstOwner = JSON.parse(readFileSync(context.lock, 'utf8'));
  assert.equal(process.listenerCount('SIGINT'), initialInt + 1);
  assert.equal(process.listenerCount('SIGTERM'), initialTerm + 1);
  writeFileSync(resolve(context.stateDir, 'agent/auth.json'), '{}\n', { mode: 0o600 });
  await Promise.all([first.close(), first.close()]);
  assertAbsent(context.lock);
  assert.equal(process.listenerCount('SIGINT'), initialInt);
  assert.equal(process.listenerCount('SIGTERM'), initialTerm);
  const second = await context.start();
  const secondOwner = JSON.parse(readFileSync(context.lock, 'utf8'));
  assert.notEqual(secondOwner.nonce, firstOwner.nonce);
  await second.close();
  assertAbsent(context.lock);
});

test('a bind failure releases the newly acquired state lock', async t => {
  const context = fixture(t);
  const occupied = createServer();
  await new Promise(resolvePromise => occupied.listen(0, '127.0.0.1', resolvePromise));
  t.after(() => new Promise(resolvePromise => occupied.close(resolvePromise)));
  await assert.rejects(context.start({ PI_GATEWAY_PORT: String(occupied.address().port) }), error => error.code === 'EADDRINUSE');
  assertAbsent(context.lock);
  const retry = await context.start();
  await retry.close();
});

test('configuration-generation and token failures release their newly acquired locks', async t => {
  const context = fixture(t);
  mkdirSync(resolve(context.stateDir, 'agent'), { recursive: true });
  writeFileSync(resolve(context.stateDir, 'agent/auth.json'), '{"provider":"not-empty"}');
  await assert.rejects(context.start(), /must not contain credentials/);
  assertAbsent(context.lock);
  writeFileSync(resolve(context.stateDir, 'agent/auth.json'), '{}');
  writeFileSync(resolve(context.stateDir, 'token'), 'short');
  await assert.rejects(context.start(), /Gateway token is too short/);
  assertAbsent(context.lock);
});

test('existing stale locks are preserved and require explicit operator cleanup', async t => {
  const context = fixture(t);
  mkdirSync(context.stateDir);
  const stale = JSON.stringify({ pid: 2147483647, nonce: 'stale-test-owner' });
  writeFileSync(context.lock, stale);
  await assert.rejects(context.start(), /Verify the recorded owner has stopped/);
  assert.equal(readFileSync(context.lock, 'utf8'), stale);
  assertAbsent(resolve(context.stateDir, 'agent'));
});

test('closing does not remove a lock file that has been replaced by another owner', async t => {
  const context = fixture(t);
  const gateway = await context.start();
  unlinkSync(context.lock);
  const replacement = JSON.stringify({ pid: process.pid, nonce: 'replacement-owner' });
  writeFileSync(context.lock, replacement);
  await gateway.close();
  assert.equal(readFileSync(context.lock, 'utf8'), replacement);
});
