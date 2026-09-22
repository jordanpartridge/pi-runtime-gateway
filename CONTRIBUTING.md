# Contributing

Changes should preserve a small, inspectable HTTP-to-Pi runtime. Keep the core
server free of npm dependencies and keep private machine paths, credentials,
models, and extensions out of the default profile.

## Local development

Use Node.js 22+ on Linux or macOS:

```sh
npm test
```

The test suite uses a fake stdio RPC peer. It does not require Pi, Ollama, a model,
or network access. CI runs the offline suite on Node 22 and 24 on Ubuntu. The
runtime uses POSIX process groups; Windows is not a supported target.

For real runtime verification, install Pi 0.85.1 separately, make the configured
model available in Ollama, start the server, and run:

```sh
npm run prove
```

Read [the proof report](evidence/proof-report.md) before interpreting the result.
A live proof exercises real runtime behavior and can be slower or dependent on
local model capacity. Never include `.runtime`, `.env`, local profiles, bearer tokens, private extension
paths, or private project content in a contribution. Use `.env.example` for public
configuration examples.

## Changes and evidence

Keep PRs focused. Explain the observable behavior being changed and provide the
checks relevant to it. Test lifecycle or protocol changes using the fake RPC peer;
run the real proof when the change affects Pi integration and an appropriate
local environment is available.

Preserve these properties when changing the runtime:

- Verify the provider, model, and fresh conversation before submitting a prompt.
- Preserve UTF-8 output across arbitrary stdio chunk boundaries.
- Emit a terminal event and receipt for success, failure, and cancellation.
- Stop and reap the worker before reporting a terminal result.
- Keep authentication, project selection, and explicit extension loading intact.
- Treat absent evidence and partial output as incomplete results, not success.

Update the [API guide](docs/api.md) when changing the HTTP contract, and the
[extension guide](docs/extensions.md) when changing profile or hook behavior.
Keep proof claims scoped to the version and configuration actually exercised.

## Issues

For bugs, include the gateway revision, OS, Node/Pi versions, relevant redacted
profile fields, and a minimal reproduction. State the expected and actual result.
Follow [SECURITY.md](SECURITY.md) for vulnerabilities instead of posting sensitive
reproductions publicly.

Contributions are under the repository's [MIT license](LICENSE).
