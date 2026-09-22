#!/usr/bin/env node
import { lstatSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function expandHome(value) {
  if (value === '~') return homedir();
  return value.startsWith('~/') ? resolve(homedir(), value.slice(2)) : value;
}
function install() {
  let binDir = resolve(homedir(), '.local/bin');
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node scripts/install.mjs [--bin-dir PATH]\n\nInstall a symlink in ~/.local/bin by default. Existing unrelated entries are never replaced.');
    return;
  }
  if (args.length) {
    if (args.length === 2 && args[0] === '--bin-dir' && args[1] && !args[1].startsWith('--')) {
      binDir = resolve(expandHome(args[1]));
    } else if (args.length === 1 && args[0].startsWith('--bin-dir=') && args[0].slice(10)) {
      binDir = resolve(expandHome(args[0].slice(10)));
    } else {
      throw new Error('Usage: node scripts/install.mjs [--bin-dir PATH]');
    }
  }
  const target = realpathSync(resolve(root, 'bin/pi-runtime-gateway.mjs'));
  const destination = resolve(binDir, 'pi-runtime-gateway');
  mkdirSync(binDir, { recursive: true });
  try {
    // symlinkSync creates the directory entry exclusively: it never replaces a file.
    symlinkSync(target, destination);
    console.log(`Installed ${destination} -> ${target}`);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let matches = false;
    try { matches = lstatSync(destination).isSymbolicLink() && realpathSync(destination) === target; }
    catch { /* A dangling or inaccessible symlink is still an existing entry. */ }
    if (!matches) throw new Error(`Refusing to overwrite existing entry: ${destination}`);
    console.log(`Already installed: ${destination}`);
  }
}

try { install(); }
catch (error) {
  console.error(`pi-runtime-gateway install: ${error.message}`);
  process.exitCode = 1;
}
