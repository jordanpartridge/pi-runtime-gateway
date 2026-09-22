# Runtime proof — release 0.1.0

Final live proof: **31/31 assertions passed** at
2026-09-22T03:54:42.028Z. Offline suite: **74/74 tests passed**, zero failures,
on v26.7.0 on Linux. A separate real-model smoke test also passed with
**no optional extensions**, using the installed command from outside the checkout.

## Real Pi and Ollama

Pi 0.85.1 used Ollama with `qwen3-coder-next:48k`, selected by ignored local
configuration. The public default is configurable and selects
`qwen3-coder-next:latest`; the locally tested 48k tag is not required of other users.
The installed `~/.local/bin/pi-runtime-gateway` resolved Pi through PATH and found
its dotenv/profile configuration while launched from `/tmp`.

| Exercise | Run | Result | Wall time |
| --- | --- | --- | --- |
| Project context + skill | `21bebb6e-6d89-4063-8f89-d007374b77a1` | completed | 3.919s |
| Repository read + defect | `3ebfbfb8-ee8a-405c-bb4c-56257701a543` | completed | 7.511s |
| Live cancellation | `78e318a8-bbcb-47de-a256-70ab8072c142` | cancelled | 3.949s |
| Fresh recovery | `8bf6aca9-651f-4a2a-a76d-044c7b4d79f6` | completed | 3.833s |

The first run returned `PI_GATEWAY_CONTEXT_READY`, supplied by project guidance
rather than its user prompt. Audit receipts confirm the full project guidance and
review skill were present in the actual provider payload. All sessions began with
zero conversation messages. The second run executed a real read of `discount.php`
and identified the seeded percentage error: actual 190 versus intended 180.

Cancellation began after actual streamed model text. Pi acknowledged the abort,
and its child process was reaped in **16 ms**. The proof verified that each
child PID no longer existed after its terminal event. A new run then completed
with `RECOVERY_OK`.

This deployment explicitly loaded JIT retrieval and Jev tool-failure-advisor
extensions. Their callbacks appear in receipts. No context-changing JIT hit or Jev
failed-tool classification was exercised. Extension loading is not evidence of a
semantic review verdict or durable learning.

## Portable setup and lifecycle

The [extension-free smoke receipt](portable-smoke.json), recorded at
2026-09-22T03:55:09.503Z, verifies a real local-model response without either house
extension. It also verifies startup with Pi's existing empty auth state, a live
ownership lock, and lock release on graceful shutdown. The extra smoke server was
stopped after the test.

The [offline suite receipt](offline-proof.json) records `npm test`. Its
74 tests cover configuration and dotenv precedence, source-relative paths,
validation, setup without overwrites, executable installation from another working
directory, fresh sessions, provider/protocol failures, split UTF-8, cancellation,
process cleanup, HTTP authentication, concurrency, SSE replay/closure, event caps,
and exclusive state-directory ownership with restart and startup-failure cleanup.
The offline suite needs neither Pi nor a model. CI runs the same suite on Node 22
and 24; its result is available in GitHub Actions. macOS execution was not tested
in this environment.

## Evidence and limits

[Live receipts and events](live-proof.json) contain the assertions and four actual
model runs. [Source hashes](source-sha256.json) identify the final public runtime,
profile, CLI, setup, and test files. Private dotenv values, extension paths, tokens,
and generated Pi state are excluded from publication.

This proof establishes runtime behavior using synthetic code. It does not measure
real-world PR review accuracy or implement an OpenAI-compatible API, Laravel/Lexi
integration, or verified learning promotion. The source is an initial local
runtime release, not an Internet-facing service or operating-system sandbox.
