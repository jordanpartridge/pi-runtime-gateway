# Chat Completions compatibility proof

This evidence covers the new adapter. The release 0.2.0 runtime/onboarding
artifacts remain historical evidence and are not relabeled as tests of this patch.

- **135 offline tests passed** on Node 26.7.0 / Linux. The suite includes request
  bounds and history validation, authentication, worker lifecycle, cancellation,
  tool handoff, repaired arguments, streamed/buffered parity, and error paths.
- The [official SDK proof](openai-sdk-proof.json) uses OpenAI Node 7.21.0 against
  real Pi 0.85.1 and Ollama `qwen3-coder-next:48k`. Five requests exercise text,
  buffered SSE with usage, a client function call, tool-result continuation, and
  a native Pi file read that identifies the fixture defect. Receipts verify fresh
  sessions, configured provider/model, required hooks, and reaped children. Source
  hashes bind the evidence to the tested implementation.
- The [Prism proof](prism-client-proof.json) uses the actual installed Prism
  0.99.22 PHP OpenRouter driver with a loopback gateway and synthetic Pi peer.
  Buffered text/usage, SSE text/finish/usage, and failed-stream HTTP 502 behavior
  passed. It makes **zero model calls**, does not boot Laravel, and is a client
  protocol test rather than evidence of a deployed Lexi integration.

The PHP test exposed a failure mode where Prism treated an interrupted SSE
connection as a successful stop. The adapter therefore commits SSE success only
after Pi settles and exits successfully; errors remain HTTP errors. SSE output is
fully buffered, not incremental token delivery. Native `/runs/:id/events` remains
incremental for clients that need progress and explicit lifecycle events.

Client functions are schema-only handoffs and run in the caller's application.
The proof executes no external action. Actual Pi startup probes also verified
that the CLI tool allowlist must include supplied client function names. An
actual-Pi synthetic-provider probe confirmed that malformed arguments can cause
Pi recovery turns; regression tests ensure only the settled result reaches clients.

Optional JIT and Jev hooks were observed. This does not establish successful
memory retrieval, semantic grading, or durable learning. Cloud inference and
Responses API compatibility are not claimed. Pi's local review of the PR is
recorded on the PR against its exact commit, separately from transport evidence.

Reproduce the SDK test with the instructions in [the compatibility guide](../docs/openai.md).
For the optional PHP proof, set `LARAVEL_VENDOR_AUTOLOAD` to an existing installation
with the tested Prism version and run:

```sh
node scripts/prove-prism.mjs "$PWD" "$LARAVEL_VENDOR_AUTOLOAD"
```
