#!/usr/bin/env node
// Offline Pi RPC stand-in. Only this test fixture is allowed to synthesize audit hooks.
import { appendFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

const scenario = basename(process.cwd());
const auditPath = process.env.PI_GATEWAY_AUDIT;
const commandPath = resolve(dirname(auditPath), 'fixture-commands.jsonl');
const args = process.argv.slice(2);
const argument = name => args[args.indexOf(name) + 1];
const send = event => process.stdout.write(JSON.stringify(event) + '\n');
const response = (command, data = {}) => send({ type: 'response', id: command.id, command: command.type, success: true, data });
const record = command => appendFileSync(commandPath, JSON.stringify(command) + '\n');
record({ type: 'fixture_start', args, pid: process.pid });

async function onCommand(command) {
  record(command);
  if (command.type === 'get_state') {
    if (scenario === 'startup-hang') return;
    response(command, {
      model: { id: scenario === 'wrong-model' ? 'unexpected-model' : argument('--model'),
        provider: scenario === 'wrong-provider' ? 'unexpected-provider' : argument('--provider') },
      messageCount: scenario === 'stale-session' ? 3 : 0,
      sessionId: randomUUID(),
    });
    return;
  }
  if (command.type === 'clear_queue') return response(command);
  if (command.type === 'abort') {
    if (scenario === 'abort-hang') return;
    return response(command);
  }
  if (command.type !== 'prompt') throw new Error(`Unsupported test RPC command: ${command.type}`);
  if (scenario === 'early-exit') process.exit(7);
  if (scenario !== 'missing-hook') appendFileSync(auditPath, JSON.stringify({ hook: 'runtime.before_provider_request', fixture: true }) + '\n');
  if (scenario === 'prompt-rejected') {
    send({ type: 'response', id: command.id, success: false, error: 'Deliberately rejected by offline fixture.' });
    return;
  }
  response(command);
  if (scenario === 'stall' || scenario === 'abort-hang') return;
  if (scenario === 'provider-error') {
    send({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'Offline provider failure.' } });
    send({ type: 'agent_settled' });
    return;
  }
  if (scenario === 'invalid-json') return process.stdout.write('{invalid json}\n');
  if (scenario === 'event-flood') {
    for (let i = 0; i < 6100; i++) send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '.' } });
    send({ type: 'agent_settled' });
    return;
  }
  send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Review: ' } });
  await delay(20);
  const unicode = Buffer.from(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Café 👋' } }) + '\n');
  const accentAt = unicode.indexOf(Buffer.from('é'));
  const emojiAt = unicode.indexOf(Buffer.from('👋'));
  // Force a UTF-8 codepoint across multiple stdout writes and event-loop turns.
  process.stdout.write(unicode.subarray(0, accentAt + 1));
  await delay(20);
  process.stdout.write(unicode.subarray(accentAt + 1, emojiAt + 2));
  await delay(20);
  process.stdout.write(unicode.subarray(emojiAt + 2));
  send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: ' is clear.' } });
  send({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } });
  send({ type: 'agent_settled' });
}

createInterface({ input: process.stdin }).on('line', line => {
  Promise.resolve(onCommand(JSON.parse(line))).catch(error => { console.error(error); process.exit(1); });
});
