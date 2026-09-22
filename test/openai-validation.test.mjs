import test from 'node:test';
import assert from 'node:assert/strict';
import { listModels, validateChat, openaiError, MAX_CHAT_BYTES } from '../lib/openai.mjs';

const profile = { id: 'reviewer', model: 'configured-model', projects: { app: '/synthetic/app' } };
const request = additions => ({ model: 'reviewer/app', messages: [{ role: 'user', content: 'Review this.' }], ...additions });
const tool = name => ({ type: 'function', function: { name, description: 'A client-owned operation.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } });
const call = (id = 'call_1', name = 'old_client_tool', args = '{"path":"readme"}') => ({ id, type: 'function', function: { name, arguments: args } });
const cycle = calls => [{ role: 'user', content: 'Look it up.' }, { role: 'assistant', content: null, tool_calls: calls }, ...calls.map(item => ({ role: 'tool', tool_call_id: item.id, content: 'Result.' }))];
function rejects(body, param, code = undefined) {
  assert.throws(() => validateChat(body, profile), error => {
    assert.equal(error.status, 400);
    assert.equal(error.type, 'invalid_request_error');
    if (param !== undefined) assert.equal(error.param, param);
    if (code !== undefined) assert.equal(error.code, code);
    assert.equal(openaiError(error).error.message, error.message);
    return true;
  });
}

test('model list exposes scoped aliases and raw configured model only resolves for one project', () => {
  assert.deepEqual(listModels(profile), { object: 'list', data: [{ id: 'reviewer/app', object: 'model', created: 0, owned_by: 'pi-runtime-gateway' }] });
  assert.equal(validateChat(request(), profile).project, 'app');
  assert.equal(validateChat(request({ model: profile.model }), profile).project, 'app');
  const multiple = { ...profile, projects: { app: '/app', docs: '/docs' } };
  assert.equal(validateChat(request({ model: 'reviewer/docs' }), multiple).project, 'docs');
  assert.throws(() => validateChat(request({ model: profile.model }), multiple), error => error.code === 'model_not_found');
  rejects(request({ model: '/arbitrary/path' }), 'model', 'model_not_found');
});

test('text parts and leading system/developer instructions stay in validated OpenAI shape', () => {
  const messages = [{ role: 'system', content: 'System.' }, { role: 'developer', content: [{ type: 'text', text: 'First.' }, { type: 'text', text: 'Second.' }] }, { role: 'user', content: [{ type: 'text', text: 'Question.' }] }];
  const result = validateChat(request({ messages }), profile);
  assert.deepEqual(result.chat.messages, messages);
  assert.equal(result.chat.system, 'System.\n\nFirst.\nSecond.');
  assert.equal(result.chat.clientTools, false);
  assert.deepEqual(result.chat.tools, []);
  assert.equal(result.chat.toolChoice, 'auto');
  assert.equal(result.stream, false);
  rejects(request({ messages: [{ role: 'user', content: 'Hi.' }, { role: 'system', content: 'Late.' }, { role: 'user', content: 'Again.' }] }), 'messages[1].role');
  rejects(request({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: {} }] }] }), 'messages[0].content[0].image_url', 'unsupported_parameter');
  rejects(request({ messages: [{ role: 'user', name: 'named-user', content: 'Hi.' }] }), 'messages[0].name', 'unsupported_parameter');
});

test('explicit client tools replace runtime tools and none disables supplied tools', () => {
  const tools = [tool('lookup_document')];
  const actual = validateChat(request({ tools }), profile);
  assert.deepEqual(actual.chat.tools, tools);
  assert.equal(actual.chat.clientTools, true);
  const disabled = validateChat(request({ tools, tool_choice: 'none' }), profile);
  assert.deepEqual(disabled.chat.tools, []);
  assert.equal(disabled.chat.toolChoice, 'none');
  assert.equal(disabled.chat.clientTools, true);
  assert.equal(validateChat(request({ tool_choice: 'none' }), profile).chat.clientTools, true);
  assert.equal(validateChat(request({ tools: [] }), profile).chat.clientTools, true);
  rejects(request({ tool_choice: 'required' }), 'tool_choice', 'unsupported_parameter');
  rejects(request({ tool_choice: { type: 'function', function: { name: 'lookup_document' } } }), 'tool_choice');
});

test('function schemas reject collisions, duplicates, unsupported fields, and nonobject arguments', () => {
  for (const name of ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write']) rejects(request({ tools: [tool(name)] }), 'tools[0].function.name', 'reserved_tool_name');
  rejects(request({ tools: [tool('lookup'), tool('lookup')] }), 'tools[1].function.name');
  rejects(request({ tools: [{ ...tool('lookup'), strict: true }] }), 'tools[0].strict', 'unsupported_parameter');
  rejects(request({ tools: [{ type: 'function', function: { ...tool('lookup').function, strict: true } }] }), 'tools[0].function.strict', 'unsupported_parameter');
  rejects(request({ tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'array' } } }] }), 'tools[0].function.parameters.type');
  rejects(request({ tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', required: ['x', 'x'] } } }] }), 'tools[0].function.parameters.required');
  rejects(request({ messages: cycle([call('bad', 'lookup', '[]')]) }), 'messages[1].tool_calls[0].function.arguments');
  rejects(request({ messages: cycle([call('bad', 'lookup', '{')]) }), 'messages[1].tool_calls[0].function.arguments');
});

test('balanced historical client calls can reference functions absent from the next request', () => {
  const messages = cycle([call('first'), call('second')]);
  [messages[2], messages[3]] = [messages[3], messages[2]];
  const result = validateChat(request({ messages, tools: [tool('new_function')] }), profile);
  assert.deepEqual(result.chat.messages, messages);
  assert.equal(result.chat.messages[1].tool_calls[0].function.name, 'old_client_tool');
  assert.equal(result.chat.messages.at(-1).role, 'tool');
});

test('tool results must resolve each unique call once before any following non-tool message', () => {
  rejects(request({ messages: [{ role: 'tool', tool_call_id: 'orphan', content: 'No call.' }] }), 'messages[0].tool_call_id', 'unmatched_tool_result');
  rejects(request({ messages: cycle([call('same'), call('same')]) }), 'messages[1].tool_calls[1].id');
  const incomplete = cycle([call('one'), call('two')]).slice(0, -1);
  rejects(request({ messages: incomplete }), 'messages', 'unresolved_tool_calls');
  rejects(request({ messages: [...incomplete, { role: 'user', content: 'Too soon.' }] }), 'messages[3].role', 'unresolved_tool_calls');
  const complete = cycle([call()]);
  rejects(request({ messages: [...complete, complete.at(-1)] }), 'messages[3].tool_call_id', 'unmatched_tool_result');
  rejects(request({ messages: [...complete, { role: 'assistant', content: null, tool_calls: [call()] }, complete.at(-1)] }), 'messages[3].tool_calls[0].id');
});

test('unsupported active options fail while nullable Laravel generation options are harmless', () => {
  const nullable = { max_tokens: null, max_completion_tokens: null, temperature: null, top_p: null, frequency_penalty: null, presence_penalty: null, stop: null, seed: null };
  assert.equal(validateChat(request({ ...nullable, n: 1 }), profile).project, 'app');
  for (const key of Object.keys(nullable)) rejects(request({ [key]: 1 }), key, 'unsupported_parameter');
  rejects(request({ response_format: { type: 'json_object' } }), 'response_format', 'unsupported_parameter');
  rejects(request({ n: 2 }), 'n', 'unsupported_parameter');
  rejects(request({ stream: 'true' }), 'stream');
});

test('streaming usage option is explicit and bounded', () => {
  const result = validateChat(request({ stream: true, stream_options: { include_usage: true } }), profile);
  assert.equal(result.stream, true); assert.equal(result.includeUsage, true);
  assert.equal(validateChat(request({ stream: true, stream_options: { include_usage: false } }), profile).includeUsage, false);
  rejects(request({ stream_options: { include_usage: true } }), 'stream_options');
  rejects(request({ stream: true, stream_options: { include_usage: 'true' } }), 'stream_options.include_usage');
  rejects(request({ stream: true, stream_options: { include_usage: true, unknown: 1 } }), 'stream_options.unknown', 'unsupported_parameter');
});

test('bounded request sizes count UTF-8 bytes, messages, and function definitions', () => {
  rejects(request({ messages: Array.from({ length: 129 }, () => ({ role: 'user', content: 'x' })) }), 'messages');
  rejects(request({ tools: Array.from({ length: 65 }, (_, i) => tool(`tool_${i}`)) }), 'tools');
  rejects(request({ messages: [{ role: 'user', content: 'é'.repeat(MAX_CHAT_BYTES / 2) }] }), null, 'request_too_large');
  rejects(request({ messages: [] }), 'messages');
  rejects(request({ messages: [{ role: 'assistant', content: 'Already finished.' }] }), 'messages');
  rejects(request({ messages: [{ role: 'user', content: null }] }), 'messages[0].content');
});

test('untyped internal failures never disclose their message or exception code', () => {
  const internal = Object.assign(new Error('secret upstream URL and key'), { code: 'PRIVATE_CODE' });
  assert.deepEqual(openaiError(internal), { error: { message: 'Internal server error.', type: 'server_error', param: null, code: 'server_error' } });
  assert.deepEqual(openaiError(Object.assign(new Error('Local worker is busy.'), { status: 409 })), { error: { message: 'Local worker is busy.', type: 'invalid_request_error', param: null, code: null } });
});
