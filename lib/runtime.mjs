import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
export class Runtime extends EventEmitter {
  constructor({ root, profile, stateDir, workerEnv = {}, spawnProcess = spawn }) {
    super(); Object.assign(this, { root, profile, stateDir, workerEnv, spawnProcess });
    this.runs = new Map();
  }
  start({ prompt, project, chat }) {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 16000 || prompt.trimStart().startsWith('/'))
      throw Object.assign(new Error('Provide a plain-text prompt of 1–16000 characters.'), { status: 400 });
    if (typeof project !== 'string' || !Object.hasOwn(this.profile.projects, project))
      throw Object.assign(new Error('Unknown configured project.'), { status: 400 });
    if ([...this.runs.values()].some(r => !TERMINAL.has(r.status)))
      throw Object.assign(new Error('Local worker is busy.'), { status: 409 });
    if (this.runs.size >= this.profile.maxRuns)
      throw Object.assign(new Error('Run limit reached; archive receipts and restart the server.'), { status: 429 });
    const id = randomUUID(), cwd = realpathSync(resolve(this.root, this.profile.projects[project]));
    const directory = resolve(this.stateDir, 'runs', id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const auditPath = resolve(directory, 'hooks.jsonl');
    if (chat) writeFileSync(resolve(directory, 'chat.json'), JSON.stringify(chat), { mode: 0o600 });
    writeFileSync(auditPath, '', { mode: 0o600 });
    const run = { id, project, status: 'starting', startedAt: new Date().toISOString(),
      profile: this.profile.id, provider: this.profile.provider, model: this.profile.model,
      events: [], hooks: [], text: '', directory, auditPath, auditLines: 0, eventBytes: 0, chat,
      timers: [], buffer: '', decoder: new StringDecoder('utf8'), prompt, childExited: false, cancelled: false, error: null };
    const systemPrompt = readFileSync(resolve(this.root, this.profile.systemPrompt), 'utf8');
    let extensionPath = resolve(this.root, this.profile.extension);
    if (this.profile.extensions?.length) {
      const imports = this.profile.extensions.map((extension, i) =>
        `import factory${i} from ${JSON.stringify(resolve(this.root, extension.path))};`);
      const factories = this.profile.extensions.map((extension, i) =>
        `{name:${JSON.stringify(extension.name)},factory:factory${i}}`);
      const source = `import harness from ${JSON.stringify(extensionPath)};\n${imports.join('\n')}\nexport default pi => harness(pi, [${factories.join(',')}]);\n`;
      extensionPath = resolve(directory, 'harness.ts');
      writeFileSync(extensionPath, source, { mode: 0o600 });
    }
    this.runs.set(id, run);
    this.event(run, 'status', { status: run.status });
    const args = ['--mode', 'rpc', '--no-session', '--provider', this.profile.provider,
      '--model', this.profile.model, '--thinking', 'off', '--offline',
      '--no-extensions', '-e', extensionPath,
      '--no-skills', '--skill', resolve(this.root, this.profile.skill),
      '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve',
      ...(chat?.clientTools
        ? (chat.tools.length ? ['--tools', chat.tools.map(tool => tool.function.name).join(',')] : ['--no-tools'])
        : ['--tools', this.profile.tools.join(',')]),
      '--system-prompt', systemPrompt];
    // Pass only the selected credential explicitly; never inherit other provider keys.
    const env = Object.fromEntries(['HOME', 'PATH', 'LANG', 'TMPDIR'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
    if (this.profile.provider !== 'ollama' && typeof this.workerEnv.PI_GATEWAY_PROVIDER_API_KEY === 'string')
      env.PI_GATEWAY_PROVIDER_API_KEY = this.workerEnv.PI_GATEWAY_PROVIDER_API_KEY;
    Object.assign(env, { PI_CODING_AGENT_DIR: resolve(this.root, this.profile.agentDir), PI_OFFLINE: '1',
      PI_TELEMETRY: '0', PI_GATEWAY_AUDIT: auditPath, PI_GATEWAY_PROJECT: cwd, PI_GATEWAY_SKILL: resolve(this.root, this.profile.skill),
      PI_GATEWAY_CONTEXT_FILE: this.profile.projectContextFile || 'AGENTS.md' });
    if (chat) env.PI_GATEWAY_CHAT_FILE = resolve(directory, 'chat.json');
    try { run.child = this.spawnProcess(this.profile.piBinary, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { this.fail(run, 'spawn_failed'); this.finalize(run); return this.snapshot(run); }
    run.pid = run.child.pid;
    run.child.stdout.on('data', chunk => this.ingest(run, chunk));
    run.child.stderr.on('data', chunk => {
      // Save only a hash/size receipt; stderr may contain sensitive configuration.
      run.stderrBytes = (run.stderrBytes || 0) + chunk.length;
      run.stderrSha256 = createHash('sha256').update(chunk).digest('hex');
    });
    run.child.stdin.on('error', () => { if (!run.targetStatus) this.fail(run, 'rpc_pipe_failed'); });
    run.child.on('error', () => this.fail(run, 'spawn_failed'));
    run.child.on('close', (code, signal) => {
      run.childExited = true; run.exitCode = code; run.exitSignal = signal;
      if (!run.targetStatus) run.error = 'pi_exited_before_completion';
      this.finalize(run);
    });
    run.auditPoll = setInterval(() => this.collectAudit(run), 100);
    run.startupTimer = setTimeout(() => this.fail(run, 'startup_timeout'), this.profile.startupTimeoutMs);
    run.deadline = setTimeout(() => this.fail(run, 'run_timeout'), this.profile.runTimeoutMs);
    this.send(run, { id: 'boot', type: 'get_state' });
    return this.snapshot(run);
  }
  send(run, value) {
    if (run.child?.stdin.writable) run.child.stdin.write(JSON.stringify(value) + '\n');
  }
  ingest(run, chunk) {
    if (TERMINAL.has(run.status)) return;
    run.buffer += run.decoder.write(chunk);
    if (run.buffer.length > 4000000) return this.fail(run, 'rpc_frame_limit');
    let index;
    while ((index = run.buffer.indexOf('\n')) >= 0) {
      const line = run.buffer.slice(0, index).replace(/\r$/, ''); run.buffer = run.buffer.slice(index + 1);
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { this.fail(run, 'invalid_rpc_json'); continue; }
      this.collectAudit(run); this.handle(run, event);
    }
  }
  handle(run, e) {
    if (e.type === 'response' && e.id === 'boot') {
      clearTimeout(run.startupTimer);
      if (!e.success || e.data?.model?.id !== this.profile.model || e.data?.model?.provider !== this.profile.provider)
        return this.fail(run, 'unexpected_model');
      if (e.data.messageCount !== 0) return this.fail(run, 'session_not_fresh');
      run.sessionId = e.data.sessionId; run.initialMessageCount = e.data.messageCount;
      this.event(run, 'session', { sessionId: run.sessionId, initialMessageCount: 0, provider: run.provider, model: run.model });
      if (!run.cancelled) {
        run.status = 'running'; this.event(run, 'status', { status: run.status });
        this.send(run, { id: 'prompt', type: 'prompt', message: run.prompt });
      }
    } else if (e.type === 'response' && e.id === 'prompt' && !e.success) this.fail(run, 'prompt_rejected');
    else if (e.type === 'response' && e.id === 'abort' && e.success) {
      run.abortAcknowledged = true; this.event(run, 'cancel_ack', {}); this.stop(run);
    } else if (e.type === 'message_update' && e.assistantMessageEvent?.type === 'text_delta') {
      const text = e.assistantMessageEvent.delta;
      if (typeof text === 'string') { run.text += text; this.event(run, 'text_delta', { text }); }
    } else if (e.type === 'message_end' && e.message?.role === 'assistant') {
      run.stopReason = e.message.stopReason;
      if (['error', 'aborted'].includes(e.message.stopReason)) this.fail(run, 'provider_error');
      else if (run.chat) this.chatMessage(run, e.message);
    } else if (e.type === 'tool_execution_start' || e.type === 'tool_execution_end') {
      this.event(run, e.type, { tool: e.toolName, toolCallId: e.toolCallId, isError: e.isError === true });
    } else if (e.type === 'extension_error') this.fail(run, 'extension_error');
    else if (e.type === 'agent_settled' && !run.cancelled) {
      if (run.chatMessage && !run.chatPublished) this.publishChatMessage(run);
      const hasResult = run.chat ? Boolean(run.chatMessage) : Boolean(run.text);
      if (!run.targetStatus) run.targetStatus = hasResult ? 'completed' : 'failed';
      if (!hasResult && !run.error) run.error = 'empty_result';
      this.stop(run);
    }
  }
  chatMessage(run, message) {
    const content = message.content || [];
    const calls = content.filter(part => part.type === 'toolCall');
    const text = content.filter(part => part.type === 'text').map(part => part.text).join('');
    const usage = message.usage;
    if (usage) {
      const count = value => Number.isFinite(value) && value >= 0 ? value : 0;
      const prompt = count(usage.input) + count(usage.cacheRead) + count(usage.cacheWrite);
      const completion = count(usage.output);
      run.usage ||= { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      run.usage.prompt_tokens += prompt; run.usage.completion_tokens += completion;
      run.usage.total_tokens += prompt + completion;
    }
    // Internal tool turns belong to Pi. Only the final answer crosses the API.
    if (calls.length && !run.chat.clientTools) return;
    if (calls.length && (run.chat.toolChoice === 'none' || calls.some(call =>
      !run.chat.tools.some(tool => tool.function.name === call.name)))) return this.fail(run, 'unexpected_client_tool');
    const tool_calls = calls.map(call => ({ id: call.id, type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) } }));
    run.chatMessage = { role: 'assistant', content: text || null, ...(calls.length ? { tool_calls } : {}) };
    run.finishReason = calls.length ? 'tool_calls' : message.stopReason === 'length' ? 'length' : 'stop';
  }
  publishChatMessage(run) {
    run.chatPublished = true;
    const { content, tool_calls } = run.chatMessage;
    // Pi may recover malformed arguments across turns. Publish only the settled result.
    if (content) this.event(run, 'chat_delta', { delta: { content } });
    if (tool_calls?.length) this.event(run, 'chat_delta', { delta: { tool_calls: tool_calls.map((call, index) => ({ index, ...call })) } });
  }
  collectAudit(run) {
    try {
      const raw = readFileSync(run.auditPath, 'utf8');
      if (raw.length > 1000000) return this.fail(run, 'audit_limit');
      const lines = raw.split('\n'); lines.pop();
      for (const line of lines.slice(run.auditLines)) {
        const value = JSON.parse(line); run.hooks.push(value); this.event(run, 'hook', value);
      }
      run.auditLines = lines.length;
    } catch { /* append may be observed between writes; retry on the next poll */ }
  }
  event(run, type, data) {
    if (run.events.length >= 6000 && type !== 'terminal') { this.fail(run, 'event_limit'); return; }
    const value = { seq: run.events.length + 1, at: new Date().toISOString(), type, ...data };
    const line = JSON.stringify(value) + '\n';
    run.eventBytes += Buffer.byteLength(line);
    if (run.eventBytes > 4000000 && type !== 'terminal') { this.fail(run, 'event_limit'); return; }
    run.events.push(value);
    appendFileSync(resolve(run.directory, 'events.jsonl'), line, { mode: 0o600 });
    this.emit('event', run.id, value);
  }
  fail(run, code) {
    if (TERMINAL.has(run.status) || run.targetStatus) return;
    run.error = code; run.targetStatus = 'failed'; this.stop(run);
  }
  killGroup(run, signal) {
    if (!run.child?.pid || run.childExited) return;
    try { process.kill(-run.child.pid, signal); } catch { /* process already exited */ }
  }
  stop(run) {
    if (run.stopping) return;
    run.stopping = true;
    this.killGroup(run, 'SIGTERM');
    run.killTimer = setTimeout(() => this.killGroup(run, 'SIGKILL'), 1500);
  }
  cancel(id) {
    const run = this.runs.get(id);
    if (!run) throw Object.assign(new Error('Unknown run.'), { status: 404 });
    if (TERMINAL.has(run.status) || run.targetStatus) return this.snapshot(run);
    run.cancelled = true; run.targetStatus = 'cancelled'; run.status = 'cancelling';
    run.cancelRequestedAt = new Date().toISOString();
    this.event(run, 'status', { status: run.status });
    this.send(run, { id: 'clear', type: 'clear_queue' });
    this.send(run, { id: 'abort', type: 'abort' });
    run.cancelTimer = setTimeout(() => this.stop(run), this.profile.cancelGraceMs);
    return this.snapshot(run);
  }
  finalize(run) {
    if (TERMINAL.has(run.status)) return;
    for (const key of ['startupTimer','deadline','cancelTimer','killTimer']) clearTimeout(run[key]);
    clearInterval(run.auditPoll); this.collectAudit(run);
    run.status = run.targetStatus || 'failed'; run.finishedAt = new Date().toISOString();
    if (run.status === 'completed' && !run.hooks.some(h => h.hook === 'runtime.before_provider_request')) {
      run.status = 'failed'; run.error = 'required_hook_missing';
    }
    if (run.status === 'completed' && run.chat && !run.hooks.some(h => h.hook === 'chat.context')) {
      run.status = 'failed'; run.error = 'chat_hook_missing';
    }
    this.event(run, 'terminal', { status: run.status, error: run.error, childExited: run.childExited });
    writeFileSync(resolve(run.directory, 'receipt.json'), JSON.stringify(this.snapshot(run), null, 2) + '\n', { mode: 0o600 });
    delete run.prompt; delete run.chat;
    this.emit('finished', run.id);
  }
  snapshot(run) {
    const keys = ['id','project','status','startedAt','finishedAt','profile','provider','model','pid','sessionId',
      'initialMessageCount','text','error','stopReason','chatMessage','finishReason','usage','childExited','exitCode','exitSignal','cancelRequestedAt','abortAcknowledged'];
    return { ...Object.fromEntries(keys.filter(k => run[k] !== undefined).map(k => [k, run[k]])), hooks: run.hooks };
  }
  async shutdown() {
    const pending = [...this.runs.values()].filter(r => !TERMINAL.has(r.status));
    for (const run of pending) this.cancel(run.id);
    await Promise.all(pending.map(run => new Promise(resolve => {
      if (TERMINAL.has(run.status)) return resolve();
      const done = id => { if (id === run.id) { this.off('finished', done); resolve(); } };
      this.on('finished', done);
    })));
  }
}
export { TERMINAL };
