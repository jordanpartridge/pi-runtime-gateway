import chatBridge from './chat.ts';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { createHash } from 'node:crypto';

const auditPath = process.env.PI_GATEWAY_AUDIT!;
const clientTools = process.env.PI_GATEWAY_CHAT_FILE
  ? JSON.parse(readFileSync(process.env.PI_GATEWAY_CHAT_FILE, 'utf8')).clientTools === true : false;
const root = realpathSync(process.env.PI_GATEWAY_PROJECT!);
const skillPath = realpathSync(process.env.PI_GATEWAY_SKILL!);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const insideProject = (path: string) => {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
};
function audit(hook: string, data: Record<string, unknown> = {}) {
  appendFileSync(auditPath, JSON.stringify({ at: new Date().toISOString(), hook, ...data }) + '\n');
}
function observed(pi: any, name: string) {
  return new Proxy(pi, {
    get(target, key) {
      if (key === 'on') return (event: string, handler: any) => {
        audit('registered', { extension: name, event });
        target.on(event, async (...args: any[]) => {
          audit(`${name}.${event}.start`);
          try {
            const result = await handler(...args);
            audit(`${name}.${event}.end`, {
              contextChanged: typeof result?.systemPrompt === 'string' && result.systemPrompt !== args[0]?.systemPrompt,
              toolFailed: args[0]?.isError === true,
            });
            return result;
          } catch (error) {
            audit(`${name}.${event}.error`, { errorType: error?.constructor?.name || 'Error' });
            throw error;
          }
        });
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

// Optional factories are imported by a generated run-local module. Pi's loader
// handles TypeScript imports; the gateway itself has no Pi SDK dependency.
export default async function harness(pi: any, extensions: { name: string; factory: any }[] = []) {
  for (const extension of extensions) {
    if (typeof extension.factory !== 'function') throw new Error('Extension must export a default factory.');
    await extension.factory(observed(pi, extension.name));
    audit('extension.loaded', { extension: extension.name });
  }

  let instructions = '';
  const contextPath = resolve(root, process.env.PI_GATEWAY_CONTEXT_FILE || 'AGENTS.md');
  try {
    const actual = realpathSync(contextPath);
    if (!insideProject(actual)) throw new Error('Project guidance must be inside the configured project.');
    instructions = readFileSync(actual, 'utf8');
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const skill = readFileSync(skillPath, 'utf8');
  const contains = (payload: string, source: string) => source.length > 0
    ? payload.includes(JSON.stringify(source).slice(1, -1)) : null;

  pi.on('session_start', (_event: any, ctx: any) => {
    audit('runtime.session_start', { provider: ctx.model?.provider, model: ctx.model?.id });
  });
  pi.on('before_agent_start', (event: any) => {
    const skillNames = (event.systemPromptOptions?.skills || []).map((s: any) => s.name);
    audit('runtime.before_agent_start', {
      contextSha256: hash(instructions), skillSha256: hash(skill), skillNames,
      projectContextLoaded: instructions.length > 0,
    });
    return {
      systemPrompt: event.systemPrompt
        + (instructions ? '\n\nConfigured project guidance:\n' + instructions : '')
        + '\n\nFull approved review skill (already loaded):\n' + skill,
    };
  });
  pi.on('before_provider_request', (event: any, ctx: any) => {
    const payloadText = JSON.stringify(event.payload);
    audit('runtime.before_provider_request', {
      provider: ctx.model?.provider, model: ctx.model?.id,
      projectContextPresent: contains(payloadText, instructions),
      reviewSkillPresent: contains(payloadText, skill),
      payloadSha256: hash(payloadText),
    });
  });
  pi.on('after_provider_response', (event: any) => {
    audit('runtime.after_provider_response', { status: event.status });
  });
  pi.on('tool_call', (event: any) => {
    if (clientTools) return; // The chat bridge blocks and terminates every client-owned call.
    const allowed = ['read', 'grep', 'find', 'ls'];
    let permitted = allowed.includes(event.toolName);
    const requested = resolve(root, String(event.input?.path || '.'));
    let actual: string;
    try { actual = realpathSync(requested); }
    catch {
      try { actual = resolve(realpathSync(dirname(requested)), requested.split('/').pop()!); }
      catch { actual = '/'; }
    }
    permitted = permitted && (insideProject(actual) || (event.toolName === 'read' && actual === skillPath));
    audit('runtime.tool_call', { tool: event.toolName, permitted });
    if (!permitted) return { block: true, reason: 'Read-only tools are restricted to the configured project.' };
  });
  await chatBridge(pi);
}
