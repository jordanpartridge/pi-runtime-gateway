import { appendFileSync, readFileSync } from 'node:fs';

const KICKOFF = 'Continue the supplied conversation.';
const DELEGATED = 'Tool execution is delegated to the API client.';

type ChatMessage = {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content: string | { type: 'text'; text: string }[] | null;
  tool_call_id?: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
};
type ChatRequest = {
  messages: ChatMessage[];
  system: string;
  tools: { type: 'function'; function: { name: string; description?: string; parameters?: Record<string, unknown> } }[];
  clientTools: boolean;
  toolChoice: 'auto' | 'none';
};

function textContent(content: ChatMessage['content']) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => part.text).join('');
  return '';
}
function contentBlocks(content: ChatMessage['content']) {
  if (typeof content === 'string') return content.length ? [{ type: 'text', text: content }] : [];
  return Array.isArray(content) ? content.map(part => ({ type: 'text', text: part.text })) : [];
}
function convertMessages(messages: ChatMessage[], model: any, timestamp: number) {
  if (!model?.api || !model?.provider || !model?.id) throw new Error('Chat bridge requires an active Pi model.');
  const calls = new Map<string, string>();
  return messages.flatMap((message, index): any[] => {
    if (message.role === 'system' || message.role === 'developer') return [];
    const common = { timestamp: timestamp + index };
    if (message.role === 'user') return [{ role: 'user', content: contentBlocks(message.content), ...common }];
    if (message.role === 'tool') {
      const name = calls.get(message.tool_call_id!);
      if (!name) throw new Error('Chat tool result has no preceding assistant tool call.');
      return [{ role: 'toolResult', toolCallId: message.tool_call_id, toolName: name,
        content: contentBlocks(message.content), isError: false, ...common }];
    }
    const toolCalls = (message.tool_calls || []).map(call => {
      calls.set(call.id, call.function.name);
      return { type: 'toolCall', id: call.id, name: call.function.name, arguments: JSON.parse(call.function.arguments) };
    });
    return [{ role: 'assistant', content: [...contentBlocks(message.content), ...toolCalls],
      api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: toolCalls.length ? 'toolUse' : 'stop', ...common }];
  });
}

/** Adapt validated chat history and client-owned tools inside a fresh Pi run. */
export default async function chatBridge(pi: any) {
  const path = process.env.PI_GATEWAY_CHAT_FILE;
  if (!path) return;
  const chat: ChatRequest = JSON.parse(readFileSync(path, 'utf8'));
  const auditPath = process.env.PI_GATEWAY_AUDIT;
  if (!auditPath) throw new Error('Chat bridge requires its configured audit file.');
  const audit = (hook: string, data: Record<string, unknown>) => appendFileSync(auditPath,
    JSON.stringify({ at: new Date().toISOString(), hook, ...data }) + '\n');
  const timestamp = Date.now() - chat.messages.length;
  const clientTools = chat.clientTools ? chat.tools : [];
  const activeNames = chat.toolChoice === 'none' ? [] : clientTools.map(tool => tool.function.name);

  for (const tool of clientTools) {
    pi.registerTool({
      name: tool.function.name,
      label: tool.function.name,
      description: tool.function.description || 'A tool executed by the API client.',
      parameters: tool.function.parameters || { type: 'object', properties: {}, additionalProperties: false },
      // No client function is ever executed here. This terminating stub is also
      // harmless if the normal tool_call interception is bypassed by Pi.
      async execute() {
        return { content: [{ type: 'text', text: DELEGATED }], details: { delegatedToClient: true }, terminate: true };
      },
    });
  }
  pi.on('session_start', () => {
    if (chat.clientTools) pi.setActiveTools(activeNames);
    audit('chat.tools', { clientTools: chat.clientTools, toolChoice: chat.toolChoice, clientToolCount: activeNames.length });
  });
  pi.on('before_agent_start', (event: any) => ({
    systemPrompt: event.systemPrompt + (chat.system ? '\n\nClient conversation instructions:\n' + chat.system : ''),
  }));
  pi.on('context', (event: any, ctx: any) => {
    const messages = event.messages;
    const kickoff = messages.findIndex((message: any) => message.role === 'user' && textContent(message.content) === KICKOFF);
    if (kickoff < 0) throw new Error('Chat bridge kickoff message is missing from Pi context.');
    const imported = convertMessages(chat.messages, ctx.model, timestamp);
    const merged = [...messages.slice(0, kickoff), ...imported, ...messages.slice(kickoff + 1)];
    audit('chat.context', { importedMessages: imported.length, retainedMessages: messages.length - 1, sentinelReplaced: true });
    return { messages: merged };
  });
  pi.on('tool_call', () => {
    if (chat.clientTools) return { block: true, reason: DELEGATED, terminate: true };
  });
}
