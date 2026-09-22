/** The deliberately bounded Chat Completions subset supported by this gateway. */
export const MAX_CHAT_BYTES = 192000;
const MAX_MESSAGES = 128;
const MAX_TOOLS = 64;
const REQUEST_FIELDS = new Set(['model', 'messages', 'stream', 'tools', 'tool_choice', 'n', 'stream_options']);
// Some OpenAI clients serialize unused generation options as null. An active
// generation override is rejected: the configured Pi profile owns these limits.
const NULLABLE_OPTIONS = new Set(['max_tokens', 'max_completion_tokens', 'temperature', 'top_p',
  'frequency_penalty', 'presence_penalty', 'stop', 'seed']);
const RESERVED_TOOLS = new Set(['read', 'grep', 'find', 'ls', 'powershell', 'bash', 'edit', 'write']);
const FUNCTION_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const own = (object, key) => Object.hasOwn(object, key);
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function invalid(message, param = null, code = 'invalid_value') {
  return Object.assign(new Error(message), { status: 400, type: 'invalid_request_error', param, code });
}
function keys(value, allowed, param) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw invalid(`Unsupported parameter: ${param ? `${param}.` : ''}${key}.`,
      param ? `${param}.${key}` : key, 'unsupported_parameter');
  }
}
function object(value, param) {
  if (!plainObject(value)) throw invalid(`${param} must be a JSON object.`, param);
}
function functionName(value, param) {
  if (typeof value !== 'string' || !FUNCTION_NAME.test(value))
    throw invalid(`${param} must contain 1–64 letters, digits, underscores, or hyphens.`, param);
  return value;
}
function textContent(value, param) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) throw invalid(`${param} must be a string or an array of text parts.`, param);
  return value.map((part, index) => {
    const path = `${param}[${index}]`;
    object(part, path); keys(part, ['type', 'text'], path);
    if (part.type !== 'text') throw invalid('Only text content parts are supported.', `${path}.type`, 'unsupported_content_type');
    if (typeof part.text !== 'string') throw invalid('Text content must be a string.', `${path}.text`);
    return { type: 'text', text: part.text };
  });
}
function joinedText(content) {
  return typeof content === 'string' ? content : content.map(part => part.text).join('\n');
}
function validateTools(value) {
  if (!Array.isArray(value) || value.length > MAX_TOOLS)
    throw invalid(`tools must be an array containing at most ${MAX_TOOLS} functions.`, 'tools');
  const names = new Set();
  return value.map((tool, index) => {
    const path = `tools[${index}]`;
    object(tool, path); keys(tool, ['type', 'function'], path);
    if (tool.type !== 'function') throw invalid('Only function tools are supported.', `${path}.type`, 'unsupported_tool_type');
    const definition = tool.function, functionPath = `${path}.function`;
    object(definition, functionPath); keys(definition, ['name', 'description', 'parameters'], functionPath);
    const name = functionName(definition.name, `${functionPath}.name`);
    if (RESERVED_TOOLS.has(name)) throw invalid('Client function names must not collide with gateway tools.', `${functionPath}.name`, 'reserved_tool_name');
    if (names.has(name)) throw invalid('Tool names must be unique.', `${functionPath}.name`);
    names.add(name);
    if (own(definition, 'description') && typeof definition.description !== 'string')
      throw invalid('Tool descriptions must be strings.', `${functionPath}.description`);
    object(definition.parameters, `${functionPath}.parameters`);
    if (definition.parameters.type !== 'object')
      throw invalid('Tool parameter schemas must have type "object".', `${functionPath}.parameters.type`);
    if (own(definition.parameters, 'properties') && !plainObject(definition.parameters.properties))
      throw invalid('Schema properties must be a JSON object.', `${functionPath}.parameters.properties`);
    if (own(definition.parameters, 'required') && (!Array.isArray(definition.parameters.required)
      || definition.parameters.required.some(key => typeof key !== 'string')
      || new Set(definition.parameters.required).size !== definition.parameters.required.length))
      throw invalid('Schema required must be an array of unique strings.', `${functionPath}.parameters.required`);
    return { type: 'function', function: { name,
      ...(own(definition, 'description') ? { description: definition.description } : {}),
      parameters: definition.parameters } };
  });
}
function validateMessages(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MESSAGES)
    throw invalid(`messages must contain 1–${MAX_MESSAGES} messages.`, 'messages');
  let prefix = true;
  const ids = new Set(), pending = new Set(), systems = [];
  const messages = value.map((message, index) => {
    const path = `messages[${index}]`;
    object(message, path);
    if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role))
      throw invalid('Unsupported message role.', `${path}.role`, 'unsupported_role');
    if (message.role !== 'tool' && pending.size)
      throw invalid('Every assistant tool call must have a tool result before the next non-tool message.', `${path}.role`, 'unresolved_tool_calls');
    const allowed = message.role === 'assistant' ? ['role', 'content', 'tool_calls']
      : message.role === 'tool' ? ['role', 'content', 'tool_call_id'] : ['role', 'content'];
    keys(message, allowed, path);
    if (message.role === 'system' || message.role === 'developer') {
      if (!prefix) throw invalid('System and developer messages are supported only at the start of a conversation.', `${path}.role`);
    } else prefix = false;
    const result = { role: message.role };
    const hasCalls = own(message, 'tool_calls');
    if (message.role === 'assistant' && hasCalls && (message.content === null || !own(message, 'content'))) result.content = null;
    else result.content = textContent(message.content, `${path}.content`);
    if (message.role === 'system' || message.role === 'developer') systems.push(joinedText(result.content));
    if (hasCalls) {
      if (!Array.isArray(message.tool_calls) || !message.tool_calls.length || message.tool_calls.length > MAX_TOOLS)
        throw invalid(`tool_calls must contain 1–${MAX_TOOLS} function calls.`, `${path}.tool_calls`);
      result.tool_calls = message.tool_calls.map((call, callIndex) => {
        const callPath = `${path}.tool_calls[${callIndex}]`;
        object(call, callPath); keys(call, ['id', 'type', 'function'], callPath);
        if (typeof call.id !== 'string' || !call.id.length || call.id.length > 128 || /[\x00-\x20\x7f]/.test(call.id))
          throw invalid('Tool call IDs must be nonempty strings of at most 128 characters without whitespace or control characters.', `${callPath}.id`);
        if (ids.has(call.id)) throw invalid('Tool call IDs must be unique throughout the conversation.', `${callPath}.id`);
        if (call.type !== 'function') throw invalid('Only function tool calls are supported.', `${callPath}.type`);
        object(call.function, `${callPath}.function`); keys(call.function, ['name', 'arguments'], `${callPath}.function`);
        functionName(call.function.name, `${callPath}.function.name`);
        if (typeof call.function.arguments !== 'string') throw invalid('Function arguments must be a JSON object encoded as a string.', `${callPath}.function.arguments`);
        let args;
        try { args = JSON.parse(call.function.arguments); } catch { throw invalid('Function arguments must be valid JSON.', `${callPath}.function.arguments`); }
        if (!plainObject(args)) throw invalid('Function arguments must decode to a JSON object.', `${callPath}.function.arguments`);
        ids.add(call.id); pending.add(call.id);
        // Historical calls may name tools that the client no longer exposes.
        return { id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments } };
      });
    }
    if (message.role === 'tool') {
      if (typeof message.tool_call_id !== 'string' || !pending.has(message.tool_call_id))
        throw invalid('Tool results must match an unresolved assistant tool call exactly once.', `${path}.tool_call_id`, 'unmatched_tool_result');
      pending.delete(message.tool_call_id);
      result.tool_call_id = message.tool_call_id;
    }
    return result;
  });
  if (pending.size) throw invalid('Every assistant tool call must have a tool result before requesting a completion.', 'messages', 'unresolved_tool_calls');
  if (!['user', 'tool'].includes(messages.at(-1).role)) throw invalid('The last message must be a user message or a resolved tool result.', 'messages');
  return { messages, system: systems.join('\n\n') };
}

/** List project-scoped aliases; the configured provider/model remains server-owned. */
export function listModels(profile) {
  return { object: 'list', data: Object.keys(profile.projects).map(project => ({
    id: `${profile.id}/${project}`, object: 'model', created: 0, owned_by: 'pi-runtime-gateway',
  })) };
}

export function validateChat(body, profile) {
  object(body, 'body');
  let serialized;
  try { serialized = JSON.stringify(body); } catch { throw invalid('The request must be serializable JSON.', null, 'invalid_json'); }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CHAT_BYTES)
    throw invalid(`The request must not exceed ${MAX_CHAT_BYTES} JSON bytes.`, null, 'request_too_large');
  for (const key of Object.keys(body)) {
    if (NULLABLE_OPTIONS.has(key)) {
      if (body[key] !== null) throw invalid(`The configured profile controls ${key}; only null is accepted.`, key, 'unsupported_parameter');
    } else if (!REQUEST_FIELDS.has(key)) throw invalid(`Unsupported parameter: ${key}.`, key, 'unsupported_parameter');
  }
  if (typeof body.model !== 'string') throw invalid('model must identify a configured project alias.', 'model');
  const projects = Object.keys(profile.projects);
  const project = projects.find(name => body.model === `${profile.id}/${name}`)
    ?? (projects.length === 1 && body.model === profile.model ? projects[0] : undefined);
  if (project === undefined) throw invalid('Unknown model alias. Use a model returned by GET /v1/models.', 'model', 'model_not_found');
  if (own(body, 'stream') && typeof body.stream !== 'boolean') throw invalid('stream must be a boolean.', 'stream');
  if (own(body, 'n') && body.n !== 1) throw invalid('Only n=1 is supported.', 'n', 'unsupported_parameter');
  const stream = body.stream === true;
  let includeUsage = false;
  if (own(body, 'stream_options')) {
    object(body.stream_options, 'stream_options'); keys(body.stream_options, ['include_usage'], 'stream_options');
    if (own(body.stream_options, 'include_usage') && typeof body.stream_options.include_usage !== 'boolean')
      throw invalid('include_usage must be a boolean.', 'stream_options.include_usage');
    if (!stream) throw invalid('stream_options requires stream=true.', 'stream_options');
    includeUsage = body.stream_options.include_usage === true;
  }
  const toolChoice = own(body, 'tool_choice') ? body.tool_choice : 'auto';
  if (!['auto', 'none'].includes(toolChoice)) throw invalid('Only tool_choice "auto" or "none" is supported.', 'tool_choice', 'unsupported_parameter');
  const tools = own(body, 'tools') ? validateTools(body.tools) : [];
  const conversation = validateMessages(body.messages);
  return { project, chat: { ...conversation, tools: toolChoice === 'none' ? [] : tools,
    clientTools: own(body, 'tools') || toolChoice === 'none', toolChoice }, stream, includeUsage };
}

/** Format explicit public errors while avoiding accidental disclosure of internals. */
export function openaiError(error) {
  const publicError = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599;
  const serverError = !publicError || error.status >= 500;
  return { error: {
    message: publicError && typeof error.message === 'string' ? error.message : 'Internal server error.',
    type: publicError && typeof error.type === 'string' ? error.type : serverError ? 'server_error' : 'invalid_request_error',
    param: publicError && typeof error.param === 'string' ? error.param : null,
    code: publicError && typeof error.code === 'string' ? error.code : serverError ? 'server_error' : null,
  } };
}
