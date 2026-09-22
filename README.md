# Pi Runtime Gateway

Run Pi as a local HTTP service with streamed output, cancellation, and receipts for
each run. The gateway starts a fresh Pi process over stdio RPC for every request,
checks its model and empty conversation, then stops and reaps it before reporting
a terminal result.

The server has no npm dependencies. It targets **Node.js 22+ on Linux and macOS**
and checks for **Pi 0.85.1**. The default profile uses Ollama with
`qwen3-coder-next:latest` at `http://127.0.0.1:11434`. Pi and Ollama are separate
prerequisites; the model must be available in your Ollama installation.

## Get started

```sh
git clone https://github.com/jordanpartridge/pi-runtime-gateway.git
cd pi-runtime-gateway
npm run setup
node scripts/install.mjs
pi-runtime-gateway
```

`npm run setup` creates a private `.env` and `config/local.json` when missing.
Edit `.env` for your model, Pi executable, Ollama address, port, and state
directory; edit `config/local.json` to select projects and extensions. Setup
preserves existing files. Both local configuration files are ignored by Git.

The installer creates `~/.local/bin/pi-runtime-gateway` as a symlink to this
checkout. Keep the checkout in place. If that directory is not on your shell's
PATH, add it for the current shell:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

You can also start directly from the checkout with
`node -- bin/pi-runtime-gateway.mjs`; no `npm install` is required. Pi is resolved as `pi` on PATH by default, including a
version-manager shim. The configured `piVersion` is checked at startup; the
bundled profile pins `0.85.1`. If a project selects a different version through
its version manager, use `--pi-binary` with the intended executable path.

The server listens on `http://127.0.0.1:4319`, creates a bearer token in
`.runtime/token`, and records its address and PID in `.runtime/server.json`.
The default `.runtime` directory is inside the checkout, regardless of the shell's
current directory. The server runs in the foreground; Ctrl-C or SIGTERM cancels
active work and reaps its child process before exit.

Each server owns its state directory through `server.lock`; concurrent servers
need distinct state directories. A forced termination can leave this lock behind.
Before removing a stale lock, inspect its recorded PID and verify that no gateway
is still using the directory. Normal shutdown and startup failure release the
server's own lock.

From another terminal in the checkout:

```sh
gateway_token="$(cat .runtime/token)"
curl --fail-with-body http://127.0.0.1:4319/health \
  -H "Authorization: Bearer $gateway_token"
curl --fail-with-body http://127.0.0.1:4319/runs \
  -H "Authorization: Bearer $gateway_token" \
  -H 'Content-Type: application/json' \
  --data '{"project":"proof","prompt":"Read discount.php and explain the percentage calculation."}'
```

The second request returns a run ID. Use it to fetch status, subscribe to server
sent events, or cancel the run; see [the API guide](docs/api.md).

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
| — | `PI_GATEWAY_MODEL` | `qwen3-coder-next:latest` |
| — | `PI_GATEWAY_OLLAMA_URL` | `http://127.0.0.1:11434` |

Use `pi-runtime-gateway --help` for options and `--version` for the gateway version.
Configuration precedence is CLI options, then existing environment variables,
then `.env`, then profile defaults. The service remains bound to loopback.

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

Setup also accepts `--model`, `--pi-binary`, `--ollama-url`, `--port`, and
`--state-dir`; for example:

```sh
npm run setup -- --model qwen3-coder-next:latest --port 4320
```

These options apply when creating missing files; they do not overwrite an existing
`.env` or local profile.

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
real Pi and Ollama:

```sh
npm run prove
```

Start the gateway first and consult [the proof report](evidence/proof-report.md)
for the tested configuration, checks, and limits of the evidence. A transport
proof establishes lifecycle behavior; review quality and memory retrieval need
their own evaluations.

See [CONTRIBUTING.md](CONTRIBUTING.md) to develop or report issues. OpenAI API
compatibility, Laravel clients, Lexi integration, and durable learning promotion
are future work. The current endpoint is the gateway's own HTTP API.

MIT licensed; see [LICENSE](LICENSE).
