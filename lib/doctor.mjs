import { accessSync, constants, lstatSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadProfile } from './config.mjs';

function ollamaTagsUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Ollama needs an HTTP(S) base URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('Ollama needs an HTTP(S) base URL without credentials, query, or fragment.');
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '') + '/api/tags';
  return url.href;
}

/** List installed Ollama models with a bounded metadata-only GET; never run inference. */
export async function discoverOllamaModels({ url, fetchImpl = globalThis.fetch } = {}) {
  const endpoint = ollamaTagsUrl(url);
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'GET', headers: { Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(3000),
    });
  } catch { throw new Error('Could not reach Ollama model discovery within its 3-second request limit. Check that Ollama is running and its URL is reachable.'); }
  if (!response.ok) throw new Error('Ollama model discovery returned an unsuccessful HTTP response.');
  let body;
  try { body = await response.json(); }
  catch { throw new Error('Ollama model discovery returned invalid JSON.'); }
  if (!body || !Array.isArray(body.models)) throw new Error('Ollama model discovery returned an invalid model list.');
  const names = body.models.map(model => model?.name ?? model?.model);
  if (names.some(name => typeof name !== 'string' || !name.trim() || name.length > 300 || /[\x00-\x1f\x7f]/.test(name)))
    throw new Error('Ollama model discovery returned an invalid model name.');
  return [...new Set(names)];
}

function modelIdentity(name) {
  return name.lastIndexOf(':') > name.lastIndexOf('/') ? name : `${name}:latest`;
}
function shellWord(value) {
  return /^[a-zA-Z0-9_./:@+-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\"'\"'") + "'";
}
function stateWriteAccess(directory) {
  let parent = resolve(directory);
  for (;;) {
    try {
      if (!statSync(parent).isDirectory()) return false;
      accessSync(parent, constants.W_OK | constants.X_OK);
      return true;
    } catch (error) {
      if (error.code !== 'ENOENT') return false;
      // A dangling symlink cannot be created as a directory, even if its parent is writable.
      try { lstatSync(parent); return false; }
      catch (linkError) { if (linkError.code !== 'ENOENT') return false; }
      const next = dirname(parent);
      if (next === parent) return false;
      parent = next;
    }
  }
}
function executableEnvironment(env) {
  return Object.fromEntries(['HOME', 'PATH', 'LANG', 'TMPDIR'].flatMap(key => {
    const value = env[key] ?? process.env[key];
    return typeof value === 'string' ? [[key, value]] : [];
  }));
}

/**
 * Inspect saved setup without inference, credential disclosure, or agent-state writes.
 * `profile`, when supplied, is an already validated loadProfile() result.
 */
export async function inspectSetup({ root, env = process.env, profile: loaded } = {}) {
  const checks = [];
  const add = (name, status, message) => checks.push({ name, status, message });
  const result = (models) => ({ ok: checks.every(check => check.status !== 'fail'), checks, ...(models === undefined ? {} : { models }) });
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add('Node.js', nodeMajor >= 22 ? 'pass' : 'fail', nodeMajor >= 22 ? `Node.js ${process.versions.node} meets the Node 22+ requirement.` : 'Install Node.js 22 or newer.');
  let config;
  try {
    config = loaded ?? loadProfile({ root, env });
    if (!config?.profile || typeof config.stateDir !== 'string') throw new Error('Invalid loaded setup.');
    add('Configuration', 'pass', 'Gateway configuration and configured project paths are valid.');
  } catch (error) {
    const message = error.message?.startsWith('Invalid gateway configuration:')
      ? error.message : 'Gateway configuration could not be loaded. Check the selected profile and environment file.';
    add('Configuration', 'fail', message);
    return result();
  }
  const { profile, stateDir, workerEnv = {} } = config;
  try {
    const version = execFileSync(profile.piBinary, ['--version'], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 65536, env: executableEnvironment(env),
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    add('Pi', version === profile.piVersion ? 'pass' : 'fail', version === profile.piVersion
      ? `Pi ${profile.piVersion} matches the pinned version.`
      : `Pi does not match the required version ${profile.piVersion}. Select the intended executable with --pi-binary.`);
  } catch {
    add('Pi', 'fail', `Pi could not report its version. Install Pi ${profile.piVersion} and put it on PATH or set --pi-binary.`);
  }
  const writable = stateWriteAccess(stateDir);
  add('State directory', writable ? 'pass' : 'fail', writable
    ? 'The state directory or its existing parent has write access; no agent files were changed.'
    : 'The state directory cannot be created or written. Select a writable --state-dir.');
  if (profile.provider !== 'ollama') {
    const key = workerEnv.PI_GATEWAY_PROVIDER_API_KEY;
    const hasKey = typeof key === 'string' && key.trim().length > 0;
    add('Cloud credentials', hasKey ? 'pass' : 'fail', hasKey
      ? 'The selected provider has credentials configured; the key was not sent or displayed.'
      : 'Configure PI_GATEWAY_API_KEY for the selected cloud provider.');
    add('Cloud inference', 'warn', 'Inference, key validity, and model access were not tested. No cloud provider request was made.');
    return result();
  }
  let models;
  try {
    models = await discoverOllamaModels({ url: profile.ollamaUrl });
    add('Ollama', 'pass', 'Ollama model discovery is reachable; only GET /api/tags was requested.');
  } catch (error) {
    add('Ollama', 'fail', error.message);
    return result();
  }
  const pull = `ollama pull ${shellWord(profile.model)}`;
  if (!models.length) add('Installed models', 'warn', `Ollama has no installed models. On the configured Ollama host, run: ${pull}`);
  const available = models.some(name => modelIdentity(name) === modelIdentity(profile.model));
  add('Selected model', available ? 'pass' : 'fail', available
    ? `The configured model ${profile.model} is installed. No inference was run.`
    : `The configured model is not installed. On the configured Ollama host, run: ${pull}`);
  return result(models);
}
