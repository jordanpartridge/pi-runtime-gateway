#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv, promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);
const providers = ['ollama', 'anthropic', 'openai', 'openrouter', 'google', 'xai'];
const help = `Usage: node scripts/setup.mjs [options]

Create private .env and config/local.json without replacing existing files.
The first run guides you when a terminal is available. Nothing is downloaded.

Options:
  --interactive        Ask setup questions (requires a terminal)
  --non-interactive    Write configuration without prompting
  --provider NAME      ollama, anthropic, openai, openrouter, google, or xai
  --model NAME         Installed Ollama model or cloud model ID
  --pi-binary PATH     Pi command or executable path
  --ollama-url URL     Ollama HTTP(S) base URL
  --project PATH       Existing repository to expose (default: built-in proof)
  --port INT           Gateway port, 0–65535
  --state-dir PATH     Runtime state directory
  --directory PATH     Destination directory (default: this repository)
  --install            Also install the optional launcher in ~/.local/bin
  --skip-check         Skip the readiness check after saving
  --help               Show this help

Cloud credentials come from PI_GATEWAY_API_KEY or a hidden terminal prompt.
There is no API-key command-line option. Run npm start after setup is ready.
`;
const variables = new Map([
  ['--provider', 'PI_GATEWAY_PROVIDER'], ['--model', 'PI_GATEWAY_MODEL'],
  ['--pi-binary', 'PI_GATEWAY_PI_BINARY'], ['--ollama-url', 'PI_GATEWAY_OLLAMA_URL'],
  ['--port', 'PI_GATEWAY_PORT'], ['--state-dir', 'PI_GATEWAY_STATE_DIR'],
]);
function expandHome(value) {
  if (value === '~') return homedir();
  return value.startsWith('~/') ? resolve(homedir(), value.slice(2)) : value;
}
function nonempty(value, field) {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value))
    throw new Error(`${field} requires a nonempty value without control characters.`);
  return value;
}
function validateUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('--ollama-url requires an HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /[?#]/.test(value))
    throw new Error('--ollama-url requires an HTTP(S) URL without credentials, query, or fragment.');
  return value;
}
function quoteEnvironment(value, key) {
  for (const quote of ['"', "'"]) {
    if (value.includes(quote)) continue;
    const encoded = quote + value + quote;
    if (parseEnv(`VALUE=${encoded}`).VALUE === value) return encoded;
  }
  throw new Error(`${key} cannot be represented safely with dotenv quoting. Use a value without both quote characters or conflicting escaped line breaks.`);
}
function parseOptions(args, root) {
  const options = { directory: root, overrides: new Map(), interactive: undefined, install: false, skipCheck: false };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--help') { options.help = true; continue; }
    if (argument === '--interactive' || argument === '--non-interactive') {
      const value = argument === '--interactive';
      if (options.interactive !== undefined && options.interactive !== value) throw new Error('Choose either --interactive or --non-interactive.');
      options.interactive = value; continue;
    }
    if (argument === '--install') { options.install = true; continue; }
    if (argument === '--skip-check') { options.skipCheck = true; continue; }
    const separator = argument.indexOf('=');
    const flag = separator < 0 ? argument : argument.slice(0, separator);
    if (!['--directory', '--project'].includes(flag) && !variables.has(flag)) {
      if (flag === '--api-key') throw new Error('API keys are not accepted on the command line. Use PI_GATEWAY_API_KEY or the hidden interactive prompt.');
      throw new Error(`Unknown option: ${flag}`);
    }
    let value = separator < 0 ? args[++index] : argument.slice(separator + 1);
    nonempty(value, flag);
    if (separator < 0 && value.startsWith('--')) throw new Error(`${flag} requires a value.`);
    if (flag === '--directory') { options.directory = resolve(expandHome(value)); continue; }
    if (flag === '--project') { options.project = value; continue; }
    if (flag === '--port') {
      if (!/^\d+$/.test(value) || Number(value) > 65535) throw new Error('--port must be an integer between 0 and 65535.');
      value = String(Number(value));
    }
    if (flag === '--ollama-url') validateUrl(value);
    if (flag === '--provider' && !providers.includes(value)) throw new Error(`--provider must be one of: ${providers.join(', ')}.`);
    options.overrides.set(variables.get(flag), value);
  }
  return options;
}

/** Hidden input keeps secrets out of terminal output and restores raw mode on every exit. */
export function readSecret(prompt, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function')
    return Promise.reject(new Error('A terminal is required for hidden API-key entry. Use PI_GATEWAY_API_KEY for automation.'));
  return new Promise((resolvePromise, reject) => {
    let value = '', settled = false, escaping = false;
    const wasRaw = input.isRaw === true;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      input.off('data', onData); input.off('end', onEnd); input.off('error', onError);
      input.setRawMode(wasRaw); input.pause(); output.write('\n');
      if (error) reject(error); else resolvePromise(value);
    };
    const onEnd = () => finish(new Error('Setup cancelled; no configuration was written.'));
    const onError = () => finish(new Error('Unable to read API key from the terminal.'));
    const onData = chunk => {
      for (const character of String(chunk)) {
        if (character === '\x03' || character === '\x04') { finish(new Error('Setup cancelled; no configuration was written.')); return; }
        if (character === '\r' || character === '\n') { finish(); return; }
        if (character === '\x1b') { escaping = true; continue; }
        if (escaping) { if (/[A-Za-z~]/.test(character)) escaping = false; continue; }
        if (character === '\x7f' || character === '\b') value = [...value].slice(0, -1).join('');
        else if (!/[\x00-\x1f]/.test(character)) value += character;
      }
    };
    input.setRawMode(true); input.on('data', onData); input.once('end', onEnd); input.once('error', onError);
    output.write(prompt); input.resume();
  });
}
function terminalIO() {
  return {
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    log: message => console.log(message),
    ask: (label, fallback = '') => new Promise((resolvePromise, reject) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      let answered = false;
      const cancel = () => { if (!answered) { answered = true; rl.close(); reject(new Error('Setup cancelled; no configuration was written.')); } };
      rl.once('SIGINT', cancel); rl.once('close', cancel);
      rl.question(`${label}${fallback ? ` [${fallback}]` : ''}: `, value => { answered = true; rl.close(); resolvePromise(value.trim() || fallback); });
    }),
    secret: label => readSecret(`${label}: `),
  };
}
async function detectPi(binary) {
  try {
    const { stdout } = await execFileAsync(expandHome(binary), ['--version'], { timeout: 5000, encoding: 'utf8', maxBuffer: 64000 });
    return { available: true, version: stdout.trim() };
  } catch { return { available: false }; }
}

/** Read model metadata only; never load a model or issue an inference request. */
export async function listOllamaModels(baseUrl, { fetcher = fetch } = {}) {
  const base = baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '');
  const signal = AbortSignal.timeout(3000);
  try {
    const tags = await fetcher(`${base}/api/tags`, { signal });
    if (!tags.ok) return { models: [], unavailable: true };
    const body = await tags.json();
    const names = [...new Set((Array.isArray(body.models) ? body.models : []).map(model => model.name || model.model)
      .filter(name => typeof name === 'string' && name.trim() && !/[\x00-\x1f\x7f]/.test(name)))];
    names.sort((a, b) => Number(/qwen.*coder/i.test(b)) - Number(/qwen.*coder/i.test(a)) || a.localeCompare(b));
    const models = await Promise.all(names.slice(0, 30).map(async name => {
      try {
        const response = await fetcher(`${base}/api/show`, { method: 'POST', signal,
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: name }) });
        if (response.ok) {
          const metadata = await response.json();
          if (Array.isArray(metadata.capabilities)) return { name, tools: metadata.capabilities.includes('tools') };
        }
      } catch { /* Older or unreachable metadata endpoint leaves capability unverified. */ }
      return { name, tools: null };
    }));
    return { models: models.filter(model => model.tools !== false), unavailable: false };
  } catch { return { models: [], unavailable: true }; }
}
function projectPath(value) {
  nonempty(value, '--project');
  let path;
  try { path = realpathSync(resolve(expandHome(value))); }
  catch { throw new Error('--project must reference an existing directory.'); }
  if (!statSync(path).isDirectory()) throw new Error('--project must reference an existing directory.');
  return path;
}
async function wizard(values, options, { io, probePi, getModels }) {
  const pi = await probePi(values.PI_GATEWAY_PI_BINARY);
  io.log(pi.available ? `Pi detected: ${pi.version}${pi.version === '0.85.1' ? '.' : ' (gateway expects 0.85.1).'}` : 'Pi was not found. Configure or install Pi 0.85.1 before starting the gateway.');
  if (!options.overrides.has('PI_GATEWAY_PROVIDER')) {
    io.log('1. Local Ollama (recommended)\n2. Cloud provider\nOr type a provider name.');
    const choice = await io.ask('Provider', '1');
    if (choice === '1' || choice === 'ollama') values.PI_GATEWAY_PROVIDER = 'ollama';
    else if (choice === '2' || choice === 'cloud') {
      io.log('Cloud providers: anthropic, openai, openrouter, google, xai.');
      values.PI_GATEWAY_PROVIDER = await io.ask('Cloud provider', 'anthropic');
    } else values.PI_GATEWAY_PROVIDER = choice;
  }
  if (!providers.includes(values.PI_GATEWAY_PROVIDER)) throw new Error(`Choose a supported provider: ${providers.join(', ')}.`);
  if (values.PI_GATEWAY_PROVIDER === 'ollama') {
    if (!options.overrides.has('PI_GATEWAY_OLLAMA_URL')) values.PI_GATEWAY_OLLAMA_URL = await io.ask('Ollama URL', values.PI_GATEWAY_OLLAMA_URL);
    validateUrl(values.PI_GATEWAY_OLLAMA_URL);
    if (!options.overrides.has('PI_GATEWAY_MODEL')) {
      const result = await getModels(values.PI_GATEWAY_OLLAMA_URL);
      const models = result.models.filter(model => model.tools !== false);
      const choices = [...models].sort((a, b) => Number(/qwen.*coder/i.test(b.name)) - Number(/qwen.*coder/i.test(a.name))).slice(0, 4);
      if (choices.length) {
        io.log('Choose an installed model that supports tool calls:\n' + choices.map((model, index) => `${index + 1}. ${model.name}${model.tools === null ? ' (tool support unverified)' : ''}`).join('\n') + '\nOr type an exact installed model name.');
        const choice = await io.ask('Model', '1');
        const picked = /^\d+$/.test(choice) ? choices[Number(choice) - 1]?.name : choice;
        if (!picked) throw new Error('Choose a listed model number or an exact model name.');
        values.PI_GATEWAY_MODEL = picked;
      } else {
        io.log(result.unavailable ? 'Ollama could not be reached within the setup check. No models were loaded or downloaded.' : 'No installed models with confirmed or unreported tool support were found.');
        values.PI_GATEWAY_MODEL = await io.ask('Exact Ollama model name (must already be installed and support tools)');
      }
    }
  } else {
    io.log('This provider receives prompts, project guidance, and tool results. API usage may be billed.');
    if (!options.overrides.has('PI_GATEWAY_MODEL')) {
      io.log(`Find model IDs with: pi --list-models ${values.PI_GATEWAY_PROVIDER}`);
      values.PI_GATEWAY_MODEL = await io.ask('Cloud model ID');
    }
    if (!values.PI_GATEWAY_API_KEY) values.PI_GATEWAY_API_KEY = await io.secret('API key (hidden)');
    io.log('The key will be saved privately; setup does not validate it with the provider.');
  }
  if (!options.project) options.project = await io.ask('Repository to expose (Enter for the built-in proof project)');
}
function createOnce(path, contents, description, io) {
  try { writeFileSync(path, contents, { flag: 'wx', mode: 0o600 }); io.log(`Created ${description}: ${path}`); return true; }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    io.log(`Preserved existing ${description}: ${path}`); return false;
  }
}

/** Injectable I/O and probes keep the guided flow testable without services or a TTY. */
export async function setup({ args = process.argv.slice(2), root = repositoryRoot, env = process.env, io = terminalIO(),
  probePi = detectPi, getModels = listOllamaModels, inspectSetup, installLauncher } = {}) {
  root = resolve(root);
  const options = parseOptions(args, root);
  if (options.help) { io.log(help); return { help: true }; }
  const { directory } = options;
  const environmentPath = resolve(directory, '.env');
  const profilePath = resolve(directory, 'config/local.json');
  const existingEnvironment = existsSync(environmentPath), existingProfile = existsSync(profilePath);
  const firstRun = !existingEnvironment && !existingProfile;
  const interactive = options.interactive ?? (io.isTTY && firstRun);
  if (interactive && !io.isTTY) throw new Error('--interactive requires a terminal; use --non-interactive for automation.');
  if (options.install && directory !== root) throw new Error('--install is only available when setting up this checkout, not with another --directory.');
  let template = readFileSync(resolve(root, '.env.example'), 'utf8');
  const values = parseEnv(template);
  for (const [key, value] of options.overrides) values[key] = value;
  // A key in the existing shell is an explicit input; never log or accept it in argv.
  if (values.PI_GATEWAY_PROVIDER !== 'ollama' && env.PI_GATEWAY_API_KEY) values.PI_GATEWAY_API_KEY = env.PI_GATEWAY_API_KEY;
  if (interactive && !existingEnvironment) {
    // Provider may change during the wizard; preserve the secret in memory only.
    if (env.PI_GATEWAY_API_KEY) values.PI_GATEWAY_API_KEY = env.PI_GATEWAY_API_KEY;
    await wizard(values, options, { io, probePi, getModels });
  }
  const profile = { id: 'local-reviewer', extensions: [] };
  if (options.project) profile.projects = { app: projectPath(options.project) };
  if (!providers.includes(values.PI_GATEWAY_PROVIDER)) throw new Error('Unsupported provider.');
  for (const key of ['PI_GATEWAY_MODEL', 'PI_GATEWAY_PI_BINARY', 'PI_GATEWAY_STATE_DIR']) nonempty(values[key], key);
  validateUrl(values.PI_GATEWAY_OLLAMA_URL);
  if (!existingEnvironment && values.PI_GATEWAY_PROVIDER !== 'ollama') {
    if (!interactive && !options.overrides.has('PI_GATEWAY_MODEL')) throw new Error('Cloud setup requires --model with the provider model ID.');
    nonempty(values.PI_GATEWAY_API_KEY, 'PI_GATEWAY_API_KEY for cloud setup');
    if (!interactive) io.log('This provider receives prompts, project guidance, and tool results. API usage may be billed. The key is not validated with the provider during setup.');
  }
  // Format and validate every new value before creating either configuration file.
  for (const [key, value] of Object.entries(values)) {
    if (key === 'PI_GATEWAY_API_KEY' && values.PI_GATEWAY_PROVIDER === 'ollama') continue;
    const encoded = quoteEnvironment(value, key);
    const line = new RegExp(`^${key}=.*$`, 'm');
    if (line.test(template)) template = template.replace(line, () => `${key}=${encoded}`);
    else template += `${key}=${encoded}\n`;
  }
  mkdirSync(resolve(directory, 'config'), { recursive: true });
  const createdProfile = createOnce(profilePath, JSON.stringify(profile, null, 2) + '\n', 'local profile', io);
  const createdEnvironment = createOnce(environmentPath, template, '.env', io);
  if (!createdEnvironment && options.overrides.size) io.log('Requested overrides were not applied because .env already exists. Edit that file to change its settings.');
  if (!createdProfile && options.project) io.log('The requested project was not applied because config/local.json already exists. Edit that file to change its projects.');
  const result = { directory, createdEnvironment, createdProfile };
  if (options.install) {
    const install = installLauncher || (async () => { await execFileAsync(process.execPath, ['--', resolve(repositoryRoot, 'scripts/install.mjs')], { timeout: 10000 }); });
    await install(); io.log('Installed the optional pi-runtime-gateway launcher.');
  }
  if (directory === root && !options.skipCheck) {
    const inspect = inspectSetup || (await import('../lib/doctor.mjs')).inspectSetup;
    const report = await inspect({ root, env });
    result.report = report;
    // The doctor formatter is shared with the CLI; its shape is intentionally small.
    const checks = report.checks || [];
    for (const check of checks) io.log(`[${check.status.toUpperCase()}] ${check.name}: ${check.message}`);
    result.ready = report.ok;
    if (!result.ready) {
      io.log('Configuration was saved or preserved, but the readiness check failed. Fix the reported prerequisites and run npm run doctor.');
      return result;
    }
  }
  io.log(directory === root ? 'Next: npm start' : `Configuration saved in ${directory}. Start from the gateway checkout with its --env-file option.`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setup().then(result => { if (result.ready === false) process.exitCode = 1; })
    .catch(error => { console.error(`pi-runtime-gateway setup: ${error.message}`); process.exitCode = 1; });
}
