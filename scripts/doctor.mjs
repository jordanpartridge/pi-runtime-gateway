#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectSetup } from '../lib/doctor.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function main({ root = repositoryRoot, env = process.env, output = console.log } = {}) {
  const report = await inspectSetup({ root, env });
  for (const check of report.checks) output(`[${check.status.toUpperCase()}] ${check.name}: ${check.message}`);
  output(report.ok ? 'Setup checks passed. No inference was run.' : 'Setup needs attention. No inference was run.');
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(report => { process.exitCode = report.ok ? 0 : 1; }).catch(() => {
    console.error('Setup inspection could not finish. No inference was requested.');
    process.exitCode = 1;
  });
}
