# OpenAI-compatible Chat Completions

The same gateway serves `GET /v1/models` and `POST /v1/chat/completions`.
Use `http://127.0.0.1:4319/v1` as the base URL and the gateway's private token as
the API key. The configured Pi provider still determines where inference runs:
Ollama or an explicitly selected cloud provider. Client requests cannot change it.

This is a bounded **Chat Completions** adapter. It does not implement Responses,
embeddings, image/audio inputs, hosted tools, or the rest of the OpenAI API.
Unsupported options return an explicit error rather than being silently ignored.

## Official JavaScript client

In your client application, install `openai`, then:

```js
import OpenAI from 'openai';
import { readFileSync } from 'node:fs';

const client = new OpenAI({
  baseURL: 'http://127.0.0.1:4319/v1',
  apiKey: readFileSync(process.env.PI_GATEWAY_TOKEN_FILE, 'utf8').trim(),
  maxRetries: 0,
});
const models = await client.models.list();
const model = models.data[0].id;
const answer = await client.chat.completions.create({
  model,
  messages: [{ role: 'user', content: 'Read discount.php and identify a concrete bug.' }],
});
console.log(answer.choices[0].message);
```

Set `PI_GATEWAY_TOKEN_FILE` to your gateway state directory's token file.
Models are aliases of the form `<profile-id>/<project-key>`. Select the alias
for the project you intend to expose. The underlying configured model ID is also
accepted when exactly one project is configured. Discovery does not enumerate
other installed models or give clients arbitrary filesystem access.

## Conversations and tools

Each HTTP request starts a fresh Pi process. Send the conversation history on each
request; the bridge preserves user, assistant, and tool-result roles instead of
flattening them into a text prompt. Prefix system/developer messages become client
instructions appended to the configured harness instructions. Hooks, the project
AGENTS.md, and the approved skill still load before inference.

Tool ownership is explicit:

- Omit `tools` to let Pi use the profile's approved repository tools internally.
  The client receives the final answer, not Pi's internal tool calls or narration.
- Supply `tools` to let the client own execution. Pi exposes only those functions,
  returns standard `message.tool_calls` with `finish_reason: "tool_calls"`, and
  terminates without executing a client function. The client executes it and sends
  matching `role: "tool"` messages with `tool_call_id` on the next request.
- `tools: []` or `tool_choice: "none"` disables callable tools for that request.
  Harness instructions and explicitly configured extension hooks still run.

```js
const tools = [{ type: 'function', function: {
  name: 'lookup_issue',
  description: 'Look up an issue by number.',
  parameters: { type: 'object', properties: { number: { type: 'integer' } },
    required: ['number'] },
} }];
const messages = [{ role: 'user', content: 'Look up issue 42.' }];
const first = await client.chat.completions.create({ model, messages, tools });
const assistant = first.choices[0].message;
// Inspect and authorize the requested action in your application before executing it.
// Execute every returned call and append its actual result, using its own call ID.
```

Client tool names cannot shadow Pi's built-in read, grep, find, ls, bash, edit,
write, or powershell tools. Function schemas describe JSON objects. Strict structured output,
forced/required tool choice, and parallel-tool controls are not implemented.
Malformed model arguments may cause Pi validation/recovery before handoff.

## Streaming and limits

Set `stream: true` for standard `chat.completion.chunk` SSE records and `[DONE]`.
The entire final response is buffered until Pi settles and its process is reaped;
HTTP success headers and SSE chunks are sent together only after that succeeds.
This suppresses internal tool activity and superseded validation attempts. It is
fully buffered SSE, not token-by-token delivery. `stream_options: { include_usage:
true }` adds the standard final usage chunk. Usage aggregates Pi's reported tokens
across internal model turns; unavailable usage is `null`, never guessed. SSE
responses larger than 1,000,000 bytes fail before success headers are sent.

Disconnecting a pending completion or stream cancels its worker. Inference
failures return an OpenAI error envelope with HTTP 502 or 504, including when
`stream: true`. No SSE success is started for a failed run.

The accepted request fields are `model`, `messages`, `tools`, `tool_choice`
(`auto` or `none`), `stream`, `stream_options`, and `n` (only `1`). `max_tokens: null`
is accepted as unset for Prism clients; other null generation controls are also accepted as unset. Numeric generation
controls are not supported. Configure output limits on the Pi profile. Text may be a string or
an array of `{type: "text", text: "..."}` parts. System/developer messages must
precede the conversation. Tool results must resolve all preceding calls before
another conversation turn. The final input role must be user or tool.

Requests are bounded to 192,000 bytes, 128 messages, and 64 function definitions.
The existing single-worker, run-cap, deadline, authentication, and Origin rules
also apply. Chat input is saved privately as `runs/<id>/chat.json`; treat it and
receipts as sensitive. The response's `x-pi-run-id` identifies the runtime receipt.

## Laravel AI

The locally inspected Laravel AI **v0.3.2** / Prism **v0.99.22** OpenAI driver uses
`/responses`, which this gateway does not implement. In that version, its
OpenRouter driver offers a Chat Completions seam with a custom URL:

```php
// config/ai.php, inside providers:
'pi' => [
    'driver' => 'openrouter',
    'key' => env('PI_GATEWAY_TOKEN'),
    'url' => env('PI_GATEWAY_URL', 'http://127.0.0.1:4319/v1'),
],
```

Select provider `pi` and a discovered model alias in your agent call. Pass the
named argument `timeout: 300` to `prompt(...)` or `stream(...)` for a five-minute
client timeout; both methods support it in Laravel AI v0.3.2. Set the key to the
gateway token, not an OpenRouter cloud key. The overridden URL routes
requests to the local gateway. Laravel executes tools on its own side and sends
the results back. Explicitly configured sampling/max-token options are rejected
by this first adapter; leave them unset. Verify the driver contract when upgrading
Laravel AI/Prism. This configuration seam was inspected in source; it is separate
from the live official-SDK evidence documented in the proof report.

Protocol references: [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat),
[Pi RPC and extensions](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/docs).

## Reproduce the SDK proof

With the gateway running and the bundled `proof` project configured, install the
verification client separately (the gateway itself still has no npm dependencies):

```sh
npm install --prefix /tmp/pi-gateway-sdk --ignore-scripts --no-audit --no-fund openai@7.21.0
PI_GATEWAY_OPENAI_SDK_PATH=/tmp/pi-gateway-sdk/node_modules/openai/index.mjs npm run prove:openai
```

Use the same `PI_GATEWAY_PROFILE` and `PI_GATEWAY_STATE_DIR` settings as your
running gateway. The proof makes five inference requests and records redacted
receipts and source hashes in `evidence/openai-sdk-proof.json`. It covers SDK
model discovery, buffered text and SSE, client tool handoff and continuation,
and a real Pi repository read. A configured cloud provider may bill these calls.
