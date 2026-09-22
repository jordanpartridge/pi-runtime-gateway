#!/usr/bin/env -S node --
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), '..');
const help = `Usage: pi-runtime-gateway [setup|doctor] [options]

Start the local Pi runtime HTTP gateway, or configure/check its prerequisites.

Commands:
  setup               Guided first-run configuration
  doctor              Check configuration, Pi, and selected inference backend

Options:
  --env-file PATH     Environment file (PI_GATEWAY_ENV_FILE)
  --profile PATH      Profile JSON file (PI_GATEWAY_PROFILE)
  --state-dir PATH    Runtime state directory (PI_GATEWAY_STATE_DIR)
  --port INT          Listen port, 0–65535 (PI_GATEWAY_PORT; 0 chooses a free port)
  --pi-binary PATH    Pi executable (PI_GATEWAY_PI_BINARY)
  --help              Show this help
  --version           Show the package version

CLI options override their corresponding environment variables.
`;
const variables = new Map([
  ['--env-file', 'PI_GATEWAY_ENV_FILE'],
  ['--profile', 'PI_GATEWAY_PROFILE'],
  ['--state-dir', 'PI_GATEWAY_STATE_DIR'],
  ['--port', 'PI_GATEWAY_PORT'],
  ['--pi-binary', 'PI_GATEWAY_PI_BINARY'],
]);
function expandHome(value) {
  if (value === '~') return homedir();
  return value.startsWith('~/') ? resolve(homedir(), value.slice(2)) : value;
}

async function main() {
  const command = process.argv[2];
  if (command === 'setup') {
    const { setup } = await import('../scripts/setup.mjs');
    const result = await setup({ args: process.argv.slice(3) });
    if (result?.ready === false) process.exitCode = 1;
    return;
  }
  if (command === 'doctor') {
    if (process.argv.length > 3) throw new Error('doctor reads configuration from the environment; it accepts no CLI flags.');
    const { main } = await import('../scripts/doctor.mjs');
    const result = await main({ root, env: process.env });
    if (!result.ok) process.exitCode = 1;
    return;
  }
  const env = { ...process.env };
  let action;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--help' || argument === '--version') {
      if (action && action !== argument) throw new Error('Choose either --help or --version.');
      action = argument;
      continue;
    }
    const separator = argument.indexOf('=');
    const flag = separator < 0 ? argument : argument.slice(0, separator);
    const variable = variables.get(flag);
    if (!variable) {
      if (flag === '--api-key') throw new Error('API keys are not accepted on the command line. Use setup or PI_GATEWAY_API_KEY.');
      throw new Error(`Unknown option: ${flag.startsWith('--') ? flag : '(positional argument)'}`);
    }
    const value = separator < 0 ? args[++index] : argument.slice(separator + 1);
    if (value === undefined || value === '' || (separator < 0 && value.startsWith('--')))
      throw new Error(`${flag} requires a value.`);
    if (flag === '--port') {
      if (!/^\d+$/.test(value) || Number(value) > 65535)
        throw new Error('--port must be an integer between 0 and 65535.');
      env[variable] = String(Number(value));
    } else {
      env[variable] = expandHome(value);
    }
  }
  if (action === '--help') { process.stdout.write(help); return; }
  if (action === '--version') {
    const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    if (typeof version !== 'string' || !version) throw new Error('Package version is missing.');
    console.log(version);
    return;
  }
  const { startServer } = await import(pathToFileURL(resolve(root, 'server.mjs')).href);
  await startServer({ root, env });
}

main().catch(error => {
  console.error(`pi-runtime-gateway: ${error.message}`);
  process.exitCode = 1;
});
