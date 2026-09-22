import { readFileSync, statSync, lstatSync, realpathSync, mkdirSync, chmodSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { resolve, dirname, isAbsolute, normalize } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { parseEnv } from 'node:util';

const DEFAULTS = {
  id: 'pi-runtime-local', piBinary: 'pi', piVersion: '0.85.1', provider: 'ollama',
  model: 'qwen3-coder-next:latest', ollamaUrl: 'http://127.0.0.1:11434',
  contextWindow: 48000, maxTokens: 4096,
  extension: 'profile/harness.ts', systemPrompt: 'profile/reviewer.md',
  skill: 'profile/review-skill/SKILL.md', extensions: [],
  projects: { proof: 'fixtures/review-project' }, projectContextFile: 'AGENTS.md',
  tools: ['read', 'grep', 'find', 'ls'], startupTimeoutMs: 20000,
  runTimeoutMs: 300000, cancelGraceMs: 3000, maxRuns: 30,
  stateDir: '.runtime', port: 4319,
};
const ALLOWED_KEYS = new Set(Object.keys(DEFAULTS));
const READ_TOOLS = new Set(['read', 'grep', 'find', 'ls']);
const own = (value, key) => Object.hasOwn(value, key);
const configError = message => new Error(`Invalid gateway configuration: ${message}`);
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function text(value, field, maximum = 4096) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x1f\x7f]/.test(value))
    throw configError(`${field} must be a nonempty string without control characters.`);
  return value;
}
function integer(value, field, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw configError(`${field} must be an integer between ${minimum} and ${maximum}.`);
  return value;
}
function expandHome(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return resolve(homedir(), value.slice(2));
  if (value.startsWith('~')) throw configError('Only ~/ home expansion is supported.');
  return value;
}
function pathAt(value, base, field) { return resolve(base, expandHome(text(value, field))); }
function existingPath(value, base, field, kind) {
  const path = pathAt(value, base, field);
  let stat;
  try { stat = statSync(path); } catch { throw configError(`${field} must reference an existing ${kind}.`); }
  if (!(kind === 'directory' ? stat.isDirectory() : stat.isFile()))
    throw configError(`${field} must reference an existing ${kind}.`);
  return path;
}
function binaryAt(value, base) {
  text(value, 'piBinary');
  if (!value.includes('/') && !value.startsWith('~')) {
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.+-]*$/.test(value)) throw configError('piBinary must be a command name or a file path.');
    return value; // Bare commands are deliberately resolved by spawn through PATH.
  }
  return existingPath(value, base, 'piBinary', 'file');
}
function readProfile(path) {
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw configError('The profile must be a readable JSON file.'); }
  if (!plainObject(parsed)) throw configError('The profile must be a JSON object.');
  if (Object.keys(parsed).some(key => !ALLOWED_KEYS.has(key))) throw configError('Unknown profile setting.');
  return parsed;
}
function numericEnv(value, field) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw configError(`${field} must contain an integer.`);
  return Number(value);
}

/** Load and validate configuration without changing the filesystem or global Pi state. */
export function loadProfile({ root, env = process.env } = {}) {
  const rootPath = existingPath(root, process.cwd(), 'root', 'directory');
  const suppliedEnv = env;
  const envFile = own(suppliedEnv, 'PI_GATEWAY_ENV_FILE')
    ? pathAt(suppliedEnv.PI_GATEWAY_ENV_FILE, process.cwd(), 'PI_GATEWAY_ENV_FILE')
    : resolve(rootPath, '.env');
  let fileEnv = {};
  if (own(suppliedEnv, 'PI_GATEWAY_ENV_FILE') || existsSync(envFile)) {
    try { fileEnv = parseEnv(readFileSync(envFile, 'utf8')); }
    catch { throw configError('The environment file must be a readable dotenv file.'); }
  }
  env = { ...fileEnv, ...suppliedEnv };
  const envBaseFor = key => own(suppliedEnv, key) ? process.cwd() : dirname(envFile);
  const defaults = { ...DEFAULTS, ...readProfile(resolve(rootPath, 'config/profile.json')) };
  let custom = {}, customBase = rootPath;
  if (own(env, 'PI_GATEWAY_PROFILE')) {
    const profilePath = pathAt(env.PI_GATEWAY_PROFILE, envBaseFor('PI_GATEWAY_PROFILE'), 'PI_GATEWAY_PROFILE');
    custom = readProfile(profilePath);
    customBase = dirname(profilePath);
  }
  const profile = { ...defaults, ...custom };
  const baseFor = key => own(custom, key) ? customBase : rootPath;
  const envText = [['PI_GATEWAY_PI_BINARY', 'piBinary'], ['PI_GATEWAY_MODEL', 'model'], ['PI_GATEWAY_OLLAMA_URL', 'ollamaUrl']];
  for (const [name, key] of envText) if (own(env, name)) profile[key] = env[name];
  text(profile.id, 'id', 100);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(profile.id)) throw configError('id must use letters, digits, dots, underscores, or hyphens.');
  text(profile.piVersion, 'piVersion', 100);
  if (!/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(profile.piVersion)) throw configError('piVersion must be a pinned semantic version.');
  if (profile.provider !== 'ollama') throw configError('provider must be ollama.');
  text(profile.model, 'model', 300);
  profile.piBinary = binaryAt(profile.piBinary, own(env, 'PI_GATEWAY_PI_BINARY') ? envBaseFor('PI_GATEWAY_PI_BINARY') : baseFor('piBinary'));
  for (const key of ['extension', 'systemPrompt', 'skill']) profile[key] = existingPath(profile[key], baseFor(key), key, 'file');

  let url;
  try { url = new URL(text(profile.ollamaUrl, 'ollamaUrl')); } catch { throw configError('ollamaUrl must be an HTTP(S) URL without credentials, query, or fragment.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || /[?#]/.test(profile.ollamaUrl))
    throw configError('ollamaUrl must be an HTTP(S) URL without credentials, query, or fragment.');
  profile.ollamaUrl = url.toString().replace(/\/+$/, '');

  if (!plainObject(profile.projects) || !Object.keys(profile.projects).length || Object.keys(profile.projects).length > 100)
    throw configError('projects must map between 1 and 100 names to existing directories.');
  profile.projects = Object.fromEntries(Object.entries(profile.projects).map(([name, path]) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(name)) throw configError('Project names must use letters, digits, dots, underscores, or hyphens.');
    return [name, existingPath(path, baseFor('projects'), 'projects', 'directory')];
  }));
  text(profile.projectContextFile, 'projectContextFile');
  const contextPath = normalize(profile.projectContextFile);
  if (isAbsolute(profile.projectContextFile) || contextPath === '.' || contextPath === '..' || contextPath.startsWith('../') || profile.projectContextFile.startsWith('~'))
    throw configError('projectContextFile must be a file path within each project.');
  profile.projectContextFile = contextPath;

  if (!Array.isArray(profile.tools) || !profile.tools.length || profile.tools.some(tool => !READ_TOOLS.has(tool)) || new Set(profile.tools).size !== profile.tools.length)
    throw configError('tools must be a nonempty unique selection of read, grep, find, and ls.');
  profile.tools = [...profile.tools];
  if (!Array.isArray(profile.extensions) || profile.extensions.length > 30) throw configError('extensions must be an array of up to 30 named local files.');
  const extensionNames = new Set();
  profile.extensions = profile.extensions.map(item => {
    if (!plainObject(item) || Object.keys(item).some(key => !['name', 'path'].includes(key)) || typeof item.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(item.name) || extensionNames.has(item.name))
      throw configError('Each extension requires a unique name and local file path.');
    extensionNames.add(item.name);
    return { name: item.name, path: existingPath(item.path, baseFor('extensions'), 'extensions.path', 'file') };
  });
  integer(profile.contextWindow, 'contextWindow', 1024, 1048576);
  integer(profile.maxTokens, 'maxTokens', 1, profile.contextWindow);
  integer(profile.startupTimeoutMs, 'startupTimeoutMs', 1, 300000);
  integer(profile.runTimeoutMs, 'runTimeoutMs', 1, 86400000);
  integer(profile.cancelGraceMs, 'cancelGraceMs', 0, 30000);
  integer(profile.maxRuns, 'maxRuns', 1, 10000);
  const port = integer(own(env, 'PI_GATEWAY_PORT') ? numericEnv(env.PI_GATEWAY_PORT, 'PI_GATEWAY_PORT') : profile.port, 'port', 0, 65535);
  const stateDir = pathAt(own(env, 'PI_GATEWAY_STATE_DIR') ? env.PI_GATEWAY_STATE_DIR : profile.stateDir,
    own(env, 'PI_GATEWAY_STATE_DIR') ? envBaseFor('PI_GATEWAY_STATE_DIR') : baseFor('stateDir'), 'stateDir');
  if (existsSync(stateDir) && !statSync(stateDir).isDirectory()) throw configError('stateDir must be a directory.');
  delete profile.stateDir;
  delete profile.port;
  return { profile, stateDir, port };
}

function writePrivateJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally { try { unlinkSync(temporary); } catch { /* renamed or never created */ } }
}

/** Generate only the local Ollama configuration; never copy a user's Pi state or auth. */
export function prepareAgent(profile, stateDir) {
  const directory = pathAt(stateDir, process.cwd(), 'stateDir');
  const agentDir = resolve(directory, 'agent');
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const actualAgent = resolve(realpathSync(directory), 'agent');
    const globalAgentPath = resolve(homedir(), '.pi/agent');
    const globalAgent = existsSync(globalAgentPath) ? realpathSync(globalAgentPath) : globalAgentPath;
    if (actualAgent === globalAgent || (existsSync(agentDir) && lstatSync(agentDir).isSymbolicLink()))
      throw configError('The generated agent directory must be isolated from global Pi state.');
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    const authPath = resolve(agentDir, 'auth.json');
    let authStat;
    try { authStat = lstatSync(authPath); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (authStat) {
      if (!authStat.isFile() || authStat.isSymbolicLink() || authStat.size > 4096)
        throw configError('The isolated agent auth file must be a regular empty JSON object.');
      let auth;
      try { auth = JSON.parse(readFileSync(authPath, 'utf8')); }
      catch { throw configError('The isolated agent auth file must be a regular empty JSON object.'); }
      if (!plainObject(auth) || Object.keys(auth).length)
        throw configError('The isolated agent auth file must not contain credentials.');
    }
    chmodSync(directory, 0o700);
    chmodSync(agentDir, 0o700);
    const baseUrl = profile.ollamaUrl.endsWith('/v1') ? profile.ollamaUrl : `${profile.ollamaUrl}/v1`;
    writePrivateJson(resolve(agentDir, 'models.json'), { providers: { ollama: {
      baseUrl, api: 'openai-completions', apiKey: 'ollama',
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
      models: [{ id: profile.model, name: profile.model, reasoning: false, input: ['text'],
        contextWindow: profile.contextWindow, maxTokens: profile.maxTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } });
    writePrivateJson(resolve(agentDir, 'settings.json'), { defaultProvider: 'ollama', defaultModel: profile.model,
      compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } }, defaultProjectTrust: 'never' });
  } catch (error) {
    if (error.message?.startsWith('Invalid gateway configuration:')) throw error;
    throw configError('Unable to create the isolated Pi agent configuration.');
  }
  return { ...profile, agentDir };
}
