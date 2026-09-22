#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const help = `Usage: node scripts/setup.mjs [options]

Create .env and config/local.json without replacing existing files.
No packages are installed and no models are started.

Options:
  --model NAME         Ollama model name
  --pi-binary PATH     Pi command or executable path
  --ollama-url URL     Ollama HTTP(S) base URL
  --port INT           Gateway port, 0–65535
  --state-dir PATH     Runtime state directory
  --directory PATH     Destination directory (default: this repository)
  --help               Show this help
`;
const variables = new Map([
  ['--model', 'PI_GATEWAY_MODEL'],
  ['--pi-binary', 'PI_GATEWAY_PI_BINARY'],
  ['--ollama-url', 'PI_GATEWAY_OLLAMA_URL'],
  ['--port', 'PI_GATEWAY_PORT'],
  ['--state-dir', 'PI_GATEWAY_STATE_DIR'],
]);
function expandHome(value) {
  if (value === '~') return homedir();
  return value.startsWith('~/') ? resolve(homedir(), value.slice(2)) : value;
}
function quoteEnvironment(value, key) {
  for (const quote of ['"', "'"]) {
    if (value.includes(quote)) continue;
    const encoded = quote + value + quote;
    if (parseEnv(`VALUE=${encoded}`).VALUE === value) return encoded;
  }
  throw new Error(`${key} cannot be represented safely with dotenv quoting. Use a value without both quote characters or conflicting escaped line breaks.`);
}
function createOnce(path, contents, description) {
  try {
    writeFileSync(path, contents, { flag: 'wx', mode: 0o600 });
    console.log(`Created ${description}: ${path}`);
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    console.log(`Preserved existing ${description}: ${path}`);
    return false;
  }
}
function setup() {
  const args = process.argv.slice(2);
  let directory = root, showHelp = false;
  const overrides = new Map();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--help') { showHelp = true; continue; }
    const separator = argument.indexOf('=');
    const flag = separator < 0 ? argument : argument.slice(0, separator);
    if (flag !== '--directory' && !variables.has(flag)) throw new Error(`Unknown option: ${argument}`);
    let value = separator < 0 ? args[++index] : argument.slice(separator + 1);
    if (typeof value !== 'string' || !value.trim() || (separator < 0 && value.startsWith('--')) || /[\x00-\x1f\x7f]/.test(value))
      throw new Error(`${flag} requires a nonempty value without control characters.`);
    if (flag === '--directory') { directory = resolve(expandHome(value)); continue; }
    if (flag === '--port') {
      if (!/^\d+$/.test(value) || Number(value) > 65535) throw new Error('--port must be an integer between 0 and 65535.');
      value = String(Number(value));
    }
    if (flag === '--ollama-url') {
      let url;
      try { url = new URL(value); } catch { throw new Error('--ollama-url requires an HTTP(S) URL.'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /[?#]/.test(value))
        throw new Error('--ollama-url requires an HTTP(S) URL without credentials, query, or fragment.');
    }
    overrides.set(variables.get(flag), value);
  }
  if (showHelp) { process.stdout.write(help); return; }
  let environment = readFileSync(resolve(root, '.env.example'), 'utf8');
  for (const [key, value] of overrides) {
    const line = new RegExp(`^${key}=.*$`, 'm');
    if (!line.test(environment)) throw new Error(`Setup template is missing ${key}.`);
    const encoded = quoteEnvironment(value, key);
    environment = environment.replace(line, () => `${key}=${encoded}`);
  }
  mkdirSync(resolve(directory, 'config'), { recursive: true });
  createOnce(resolve(directory, 'config/local.json'), JSON.stringify({ id: 'local-reviewer', extensions: [] }, null, 2) + '\n', 'local profile');
  const created = createOnce(resolve(directory, '.env'), environment, '.env');
  if (!created && overrides.size) console.log('Requested overrides were not applied because .env already exists. Edit that file to change its settings.');
}

try { setup(); }
catch (error) {
  console.error(`pi-runtime-gateway setup: ${error.message}`);
  process.exitCode = 1;
}
