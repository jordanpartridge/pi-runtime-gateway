import http from 'node:http';
import { readFileSync, mkdirSync, writeFileSync, existsSync, chmodSync, openSync, closeSync, fstatSync, lstatSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Runtime, TERMINAL } from './lib/runtime.mjs';
import { loadProfile, prepareAgent } from './lib/config.mjs';

export function createGateway({ root, profile, stateDir, token, runtime } = {}) {
  runtime ||= new Runtime({ root, profile, stateDir });
  const digest = value => createHash('sha256').update(value).digest();
  const tokenDigest = digest(`Bearer ${token}`);
  const connections = new Set();
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  const server = http.createServer(async (req, res) => {
    try {
      if (req.headers.origin) return json(res, 403, { error: 'Browser origins are not enabled.' });
      if (!timingSafeEqual(tokenDigest, digest(req.headers.authorization || ''))) return json(res, 401, { error: 'Unauthorized.' });
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
      if (req.method === 'GET' && path === '/health') return json(res, 200, {
        status: 'ready', profile: profile.id, provider: profile.provider, model: profile.model,
        transport: 'pi-stdio-rpc', openaiCompatible: false, projects: Object.keys(profile.projects),
        piVersion: profile.piVersion, extensions: (profile.extensions || []).map(extension => extension.name),
      });
      if (req.method === 'POST' && path === '/runs') {
        if (!(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'Use application/json.' });
        const chunks = []; let length = 0;
        for await (const chunk of req) {
          length += chunk.length;
          if (length > 20000) { json(res, 413, { error: 'Request too large.' }); return; }
          chunks.push(chunk);
        }
        let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(res, 400, { error: 'Invalid JSON.' }); }
        if (!body || Array.isArray(body) || Object.keys(body).some(k => !['prompt','project'].includes(k))) return json(res, 400, { error: 'Only prompt and project are accepted.' });
        return json(res, 202, runtime.start(body));
      }
      const match = path.match(/^\/runs\/([a-f0-9-]{36})(?:\/(events|cancel))?$/);
      if (!match) return json(res, 404, { error: 'Not found.' });
      const run = runtime.runs.get(match[1]);
      if (!run) return json(res, 404, { error: 'Unknown run.' });
      if (req.method === 'GET' && !match[2]) return json(res, 200, runtime.snapshot(run));
      if (req.method === 'POST' && match[2] === 'cancel') return json(res, 202, runtime.cancel(run.id));
      if (req.method !== 'GET' || match[2] !== 'events') return json(res, 405, { error: 'Method not allowed.' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      const after = Number(req.headers['last-event-id'] || 0);
      const send = event => {
        if (res.writableLength > 1000000) return res.destroy();
        res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        if (event.type === 'terminal') res.end();
      };
      for (const event of run.events) if (event.seq > after) send(event);
      if (TERMINAL.has(run.status)) { res.end(); return; }
      const listener = (id, event) => { if (id === run.id) send(event); };
      runtime.on('event', listener);
      const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 10000);
      res.on('close', () => { clearInterval(heartbeat); runtime.off('event', listener); });
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'Internal server error.' });
      else res.destroy();
    }
  });
  server.requestTimeout = 15000;
  server.on('connection', socket => { connections.add(socket); socket.on('close', () => connections.delete(socket)); });
  return { server, runtime, async close() {
    await runtime.shutdown();
    for (const socket of connections) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  } };
}

function acquireStateLock(stateDir) {
  const path = resolve(stateDir, 'server.lock');
  const owner = { pid: process.pid, nonce: randomUUID() };
  let descriptor;
  try { descriptor = openSync(path, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`State directory is already owned: ${path}. Verify the recorded owner has stopped before manually removing a stale lock.`);
    throw error;
  }
  const identity = fstatSync(descriptor);
  const sameFile = () => {
    try {
      const current = lstatSync(path);
      return current.isFile() && current.dev === identity.dev && current.ino === identity.ino;
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  try { writeFileSync(descriptor, JSON.stringify(owner) + '\n'); }
  catch (error) {
    if (sameFile()) unlinkSync(path);
    throw error;
  } finally { closeSync(descriptor); }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (!sameFile()) return;
    let current;
    try { current = JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return;
      throw error;
    }
    if (current.pid === owner.pid && current.nonce === owner.nonce) unlinkSync(path);
  };
}

export async function startServer({ root = dirname(fileURLToPath(import.meta.url)), env = process.env } = {}) {
  if (process.platform === 'win32') throw new Error('This release requires Linux or macOS process-group support.');
  const config = loadProfile({ root, env });
  let version;
  try { version = execFileSync(config.profile.piBinary, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim(); }
  catch { throw new Error('Pi executable unavailable. Install Pi and set PI_GATEWAY_PI_BINARY or add pi to PATH.'); }
  if (version !== config.profile.piVersion) throw new Error(`Pi version mismatch: this profile requires ${config.profile.piVersion}.`);
  const { stateDir, port } = config;
  mkdirSync(stateDir, { recursive: true, mode: 0o700 }); chmodSync(stateDir, 0o700);
  const releaseLock = acquireStateLock(stateDir);
  let gateway;
  try {
    const profile = prepareAgent(config.profile, stateDir);
    const tokenPath = resolve(stateDir, 'token');
    if (!existsSync(tokenPath)) writeFileSync(tokenPath, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    chmodSync(tokenPath, 0o600);
    const token = readFileSync(tokenPath, 'utf8').trim();
    if (token.length < 32) throw new Error('Gateway token is too short.');
    gateway = createGateway({ root, profile, stateDir, token });
    const originalClose = gateway.close.bind(gateway);
    let closePromise, stop;
    gateway.close = () => {
      if (!closePromise) closePromise = (async () => {
        try { await originalClose(); }
        finally {
          if (stop) { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
          releaseLock();
        }
      })();
      return closePromise;
    };
    await new Promise((ready, reject) => {
      gateway.server.once('error', reject);
      gateway.server.listen(port, '127.0.0.1', () => { gateway.server.off('error', reject); ready(); });
    });
    const address = `http://127.0.0.1:${gateway.server.address().port}`;
    writeFileSync(resolve(stateDir, 'server.json'), JSON.stringify({ address, pid: process.pid, profile: profile.id }) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ address, profile: profile.id, model: profile.model, tokenFile: tokenPath }));
    stop = () => {
      void gateway.close().catch(error => { console.error(`Gateway shutdown failed: ${error.message}`); process.exitCode = 1; });
    };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    return gateway;
  } catch (error) {
    try { if (gateway) await gateway.close(); else releaseLock(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Gateway startup failed and cleanup also failed.'); }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().catch(error => { console.error(error.message); process.exitCode = 1; });
}
