# Pi Runtime Gateway

Run Pi as a local HTTP service with streamed output, cancellation, and receipts for
each run. The gateway starts a fresh Pi process over stdio RPC for every request,
checks its model and empty conversation, then stops and reaps it before reporting
a terminal result.

The gateway runs on your machine. Inference can use **local Ollama** or an
explicitly selected **cloud provider through Pi**. Hooks, project context, tools,
streaming, and cancellation use the same runtime in either case.

## Quick start

You need **Node.js 22+** and **Pi 0.85.1** on Linux or macOS. For local inference,
have Ollama running with an installed model that supports tool calls. For cloud
inference, have an API key and a model ID for your selected provider.

```sh
git clone https://github.com/jordanpartridge/pi-runtime-gateway.git
cd pi-runtime-gateway
npm run setup
npm start
```

No `npm install` is needed. The guided setup:

1. Detects Pi and offers local Ollama or cloud inference.
2. Lists installed Ollama models, or asks for the cloud model and a hidden API key.
3. Lets you choose a project, saves private configuration, and checks readiness.

Press Enter to try the built-in proof project first. Setup preserves existing
configuration and downloads nothing. Cloud inference sends prompts, project
guidance, retrieved context, and tool results to the selected provider; API usage
may be billed. There is no automatic local-to-cloud fallback.

If Pi is missing, install the pinned package using its supported npm distribution:

```sh
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.85.1
```

Check or troubleshoot at any time:

```sh
npm run doctor
```

Doctor checks configuration, the Pi version, local state access, and Ollama model
availability. For cloud configurations it checks that a key is configured; it
**does not validate that key or make a paid inference request**. Follow its
specific fixes, then run it again.

The server runs in the foreground at `http://127.0.0.1:4319`. Ctrl-C cancels active
work and reaps its Pi process. Authentication uses a generated token in
`.runtime/token`; the address and PID are in `.runtime/server.json`.

For a command available from any directory:

```sh
npm run install:local
pi-runtime-gateway doctor
pi-runtime-gateway
```

The installer links `~/.local/bin/pi-runtime-gateway` to this checkout. Keep the
checkout in place, and add `~/.local/bin` to PATH if needed. The command also accepts
`setup` for configuration. Pi itself is resolved through PATH or `--pi-binary`.

The API currently uses `/runs`, status, SSE events, and cancellation. It is **not
yet OpenAI-compatible**. See [the API guide](docs/api.md) for a complete request
example and the bearer-token requirement.

## Configure a profile

The bundled [profile](config/profile.json) defines the model, configured projects,
review instructions, tools, and time limits. Setup selects `config/local.json`
through `.env`. For a project beside the gateway checkout, edit that file to:

```json
{
  "id": "local-review",
  "projects": { "app": "../../my-app" },
  "extensions": []
}
```

```sh
pi-runtime-gateway --profile ./config/local.json
```

Send `"project":"app"` when starting a run. The project key is an allowlist entry;
clients cannot supply arbitrary paths. Project paths in an override are relative
to that profile file. The project's `AGENTS.md` is included when present; the
configured review skill is included in full.

A custom profile merges with the bundled defaults. Default file paths stay
relative to the gateway checkout; overridden paths are relative to the custom
profile's directory. Absolute paths and `~` paths are also supported. The default
`extensions` list is empty: no personal memory service or house extensions are
required. See [extensions](docs/extensions.md) for explicit loading and receipts.

| CLI option | Environment variable | Default |
| --- | --- | --- |
| `--env-file` | `PI_GATEWAY_ENV_FILE` | Checkout's `.env`, when present |
| `--profile` | `PI_GATEWAY_PROFILE` | Bundled `config/profile.json`; setup selects `config/local.json` |
| `--state-dir` | `PI_GATEWAY_STATE_DIR` | Checkout's `.runtime` directory |
| `--port` | `PI_GATEWAY_PORT` | `4319` |
| `--pi-binary` | `PI_GATEWAY_PI_BINARY` | `pi` on PATH |
| — | `PI_GATEWAY_PROVIDER` | `ollama` |
| — | `PI_GATEWAY_API_KEY` | Unset; required for cloud |
| — | `PI_GATEWAY_MODEL` | `qwen3-coder-next:latest` |
| — | `PI_GATEWAY_OLLAMA_URL` | `http://127.0.0.1:11434` |

Use `pi-runtime-gateway --help` for options and `--version` for the gateway version.
Configuration precedence is CLI options, then existing environment variables,
then `.env`, then the selected profile and bundled defaults. The service remains bound to loopback.

The gateway reads the checkout's `.env` automatically. Select another dotenv file
with `--env-file` or `PI_GATEWAY_ENV_FILE`. When invoking Node directly, put `--`
before the script so Node does not consume the gateway's `--env-file` option:

```sh
node -- bin/pi-runtime-gateway.mjs --env-file ./.env
```

Dotenv values are parsed as data, never
executed as shell code. Start with [.env.example](.env.example) for the supported
settings. Relative paths read from a dotenv file resolve against that file's
directory. Relative paths supplied through the existing environment or CLI resolve
against the current working directory, including the path selecting an explicit
dotenv file. Paths inside a custom JSON profile still resolve against that profile.

For scripts, use `--non-interactive` with explicit configuration. Setup also
accepts `--provider`, `--model`, `--pi-binary`, `--ollama-url`, `--project`, `--port`,
`--state-dir`, `--install`, and `--skip-check`; for example:

```sh
npm run setup -- --non-interactive --model qwen3-coder-next:latest --port 4320
```

These options apply when creating missing files; they do not overwrite an existing
`.env` or local profile. Use `--interactive` to explicitly request the wizard.
Cloud keys are accepted through the hidden prompt or `PI_GATEWAY_API_KEY`, never
as a CLI argument. They are stored only in private dotenv configuration when
setup creates it; generated Pi auth contains an environment reference. Gateway
clients use a separate bearer token.

The guided cloud choices are Anthropic, OpenAI, OpenRouter, Google, and xAI.
Advanced profiles can select other Pi provider IDs with a single API key and
built-in model catalog. Provider-specific OAuth, subscription login, and additional
cloud settings are not handled by this setup flow. Pi owns provider protocols and
model catalogs; the gateway does not duplicate their SDKs. Only the selected key
is passed to a cloud worker. Ollama workers receive no cloud key.

## Execution and trust

Each run uses an isolated agent directory with automatic global extension,
skill, context-file, and saved-session loading disabled. Only explicitly
configured instructions and extensions are loaded. The default tool policy
allows `read`, `grep`, `find`, and `ls` within the configured project, with access
to the configured skill file.

This is a trusted local service. The tool policy is **not an operating-system
sandbox**. Project instructions, model output, and extension code need appropriate
trust; extensions execute as your user and can access files or networks directly.
Keep the bearer token private. See [SECURITY.md](SECURITY.md) for the boundary.

One run executes at a time. By default, each server lifetime accepts up to 30
runs, with a five-minute run deadline. Run events and receipts remain under the
state directory; the HTTP run index resets when the server restarts.

## Verify and contribute

```sh
npm test
```

The offline suite uses a fake Pi RPC peer and needs no model, Pi installation, or
external service. CI runs it on Node 22 and 24. The separate live proof exercises
real Pi and the configured inference provider (cloud requests may be billed):

```sh
npm run prove
```

Live inference has been verified with local Ollama. Cloud setup, credential
isolation, and real Pi cloud-profile initialization are tested; successful cloud
inference with a real API key has **not** been verified in this release.

Start the gateway first and consult [the proof report](evidence/proof-report.md)
for the tested configuration, checks, and limits of the evidence. A transport
proof establishes lifecycle behavior; review quality and memory retrieval need
their own evaluations.

See [CONTRIBUTING.md](CONTRIBUTING.md) to develop or report issues. OpenAI API
compatibility, Laravel clients, Lexi integration, and durable learning promotion
are future work. The current endpoint is the gateway's own HTTP API.

MIT licensed; see [LICENSE](LICENSE).
