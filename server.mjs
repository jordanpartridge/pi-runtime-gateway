import http from 'node:http';
import { readFileSync, mkdirSync, writeFileSync, existsSync, chmodSync, openSync, closeSync, fstatSync, lstatSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Runtime, TERMINAL } from './lib/runtime.mjs';
import { loadProfile, prepareAgent } from './lib/config.mjs';
import { validateChat, listModels, openaiError, MAX_CHAT_BYTES } from './lib/openai.mjs';

export function createGateway({ root, profile, stateDir, token, runtime, workerEnv = {} } = {}) {
  runtime ||= new Runtime({ root, profile, stateDir, workerEnv });
  const digest = value => createHash('sha256').update(value).digest();
  const tokenDigest = digest(`Bearer ${token}`);
  const connections = new Set();
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  const server = http.createServer(async (req, res) => {
    let isOpenAI = false;
    try {
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
      isOpenAI = path === '/v1' || path.startsWith('/v1/');
      if (isOpenAI) {
        if (req.headers.origin) throw apiError('Browser origins are not enabled.', 403, 'permission_error', 'browser_origin_not_allowed');
        if (!timingSafeEqual(tokenDigest, digest(req.headers.authorization || '')))
          throw apiError('Unauthorized.', 401, 'authentication_error', 'invalid_api_key');
        if (req.method === 'GET' && path === '/v1/models') return json(res, 200, listModels(profile));
        if (req.method === 'POST' && path === '/v1/chat/completions') {
          if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || ''))
            throw apiError('Use application/json.', 415, 'invalid_request_error', 'unsupported_media_type');
          const body = await readChatBody(req);
          const request = validateChat(body, profile);
          if (req.aborted || res.destroyed) return;
          return serveChat({ res, body, request, runtime, json });
        }
        throw apiError('Not found.', 404, 'invalid_request_error', 'not_found');
      }
      if (req.headers.origin) return json(res, 403, { error: 'Browser origins are not enabled.' });
      if (!timingSafeEqual(tokenDigest, digest(req.headers.authorization || ''))) return json(res, 401, { error: 'Unauthorized.' });
      if (req.method === 'GET' && path === '/health') return json(res, 200, {
        status: 'ready', profile: profile.id, provider: profile.provider, model: profile.model,
        transport: 'pi-stdio-rpc', openaiCompatible: true,
        openaiEndpoints: ['/v1/models', '/v1/chat/completions'], projects: Object.keys(profile.projects),
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
      if (res.destroyed) return;
      if (!res.headersSent) json(res, error.status || 500, isOpenAI ? openaiError(error) : { error: error.status ? error.message : 'Internal server error.' });
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

function apiError(message, status, type, code) {
  return Object.assign(new Error(message), { status, type, code, param: null });
}

function readChatBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = []; let length = 0;
    const cleanup = () => {
      req.off('data', data); req.off('end', end); req.off('aborted', aborted);
    };
    const fail = error => { cleanup(); req.resume(); reject(error); };
    const failed = () => fail(apiError('Unable to read request.', 400, 'invalid_request_error', 'invalid_request'));
    const aborted = () => fail(apiError('Request disconnected.', 400, 'invalid_request_error', 'request_aborted'));
    const data = chunk => {
      length += chunk.length;
      if (length > MAX_CHAT_BYTES) return fail(apiError('Request too large.', 413, 'invalid_request_error', 'request_too_large'));
      chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(apiError('Invalid JSON.', 400, 'invalid_request_error', 'invalid_json')); }
    };
    req.on('data', data); req.once('end', end); req.once('error', failed); req.once('aborted', aborted);
    req.once('close', () => req.off('error', failed));
  });
}

function serveChat({ res, body, request, runtime, json }) {
  let started;
  try { started = runtime.start({ prompt: 'Continue the supplied conversation.', project: request.project, chat: request.chat }); }
  catch (error) {
    if (error.status === 409) throw apiError('Local worker is busy.', 409, 'server_error', 'worker_busy');
    if (error.status === 429) throw apiError('Run limit reached; archive receipts and restart the server.', 429, 'rate_limit_error', 'run_limit_reached');
    throw error;
  }
  const run = runtime.runs.get(started.id);
  res.setHeader('x-pi-run-id', run.id);
  const common = { id: `chatcmpl-${run.id}`, created: Math.floor(Date.parse(run.startedAt) / 1000), model: body.model };
  let ended = false;
  const cleanup = () => { runtime.off('event', listener); res.off('close', disconnected); };
  const disconnected = () => {
    if (ended) return;
    ended = true; cleanup();
    if (!TERMINAL.has(run.status)) runtime.cancel(run.id);
  };
  const failed = error => {
    const timeout = ['startup_timeout', 'run_timeout'].includes(run.error);
    error ||= apiError(timeout ? 'The Pi worker timed out.' : 'The Pi worker could not complete this request.',
      timeout ? 504 : 502, 'server_error', timeout ? 'worker_timeout' : 'worker_failed');
    ended = true; cleanup(); json(res, error.status, openaiError(error));
  };
  const finished = () => {
    if (ended) return;
    if (run.status !== 'completed' || !run.chatMessage) return failed();
    const finishReason = run.finishReason || (run.stopReason === 'length' ? 'length' : 'stop');
    if (request.stream) {
      // Pi has finished and exited before HTTP success is committed. Some PHP
      // clients otherwise treat even a broken, failed SSE connection as success.
      const frames = [];
      const chunk = (delta, finish_reason = null) => frames.push({ ...common, object: 'chat.completion.chunk',
        choices: [{ index: 0, delta, finish_reason }], ...(request.includeUsage ? { usage: null } : {}) });
      chunk({ role: 'assistant', content: '' });
      if (run.chatMessage.content) chunk({ content: run.chatMessage.content });
      if (run.chatMessage.tool_calls?.length)
        chunk({ tool_calls: run.chatMessage.tool_calls.map((call, index) => ({ index, ...call })) });
      chunk({}, finishReason);
      if (request.includeUsage) frames.push({ ...common, object: 'chat.completion.chunk', choices: [], usage: run.usage || null });
      const wire = frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n';
      if (Buffer.byteLength(wire) > 1000000)
        return failed(apiError('Completion exceeds the streaming response size limit.', 502, 'server_error', 'response_too_large'));
      ended = true; cleanup();
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'close', 'X-Accel-Buffering': 'no' });
      res.end(wire);
    } else {
      ended = true; cleanup();
      json(res, 200, { ...common, object: 'chat.completion',
        choices: [{ index: 0, message: run.chatMessage, finish_reason: finishReason }],
        ...(run.usage ? { usage: run.usage } : {}) });
    }
  };
  const listener = (id, event) => { if (id === run.id && event.type === 'terminal') finished(); };
  res.once('close', disconnected);
  runtime.on('event', listener);
  if (TERMINAL.has(run.status)) finished();
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
  const versionEnv = Object.fromEntries(['HOME', 'PATH', 'LANG', 'TMPDIR']
    .flatMap(key => typeof (env[key] ?? process.env[key]) === 'string' ? [[key, env[key] ?? process.env[key]]] : []));
  let version;
  try { version = execFileSync(config.profile.piBinary, ['--version'], { encoding: 'utf8', timeout: 5000,
    env: versionEnv, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
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
    gateway = createGateway({ root, profile, stateDir, token, workerEnv: config.workerEnv });
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
