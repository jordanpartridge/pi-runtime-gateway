# Runtime and onboarding proof — release 0.2.0

**108/108 offline tests passed** on v26.7.0 on Linux.
**31/31 live local-model assertions passed** at 2026-09-22T04:10:07.417Z.
Guided setup and doctor also passed against the real local installation.

## Real local inference

Pi 0.85.1 used Ollama with `qwen3-coder-next:48k`, selected by ignored local
configuration. The installed command starts from outside the checkout and resolves
Pi through PATH. The public setup discovers installed models instead of requiring
this deployment's custom tag.

| Exercise | Run | Result | Wall time |
| --- | --- | --- | --- |
| Project context + skill | `19a3a40f-4759-4fad-9a22-51ee54863a3c` | completed | 3.904s |
| Repository read + defect | `b7c34e1a-6c50-461f-84ae-7745c27c2a32` | completed | 8.282s |
| Live cancellation | `113ba120-1ae5-4022-9759-7796753b983a` | cancelled | 3.961s |
| Fresh recovery | `a014fac6-e4a7-4f5a-b019-115b1ffbd571` | completed | 3.840s |

The first run returned `PI_GATEWAY_CONTEXT_READY`, supplied only by configured
project guidance. Receipts confirm the guidance and complete review skill reached
the actual provider payload. Each session began with zero conversation messages.
The second run performed a real file read and found the synthetic discount defect:
actual 190 versus intended 180.

Cancellation followed real streamed output. Pi acknowledged the abort and its
child was reaped in **14 ms**. Every child PID was checked after termination;
a new session then returned `RECOVERY_OK`.

Optional JIT and Jev extension factories and callbacks were observed. No
context-changing JIT hit or Jev failed-tool classification was exercised. These
receipts do not establish semantic grading or successful durable learning.

## Guided setup and cloud configuration

[Setup evidence](setup-proof.json) records a real terminal run: Pi detection,
installed-model selection, project selection, and private configuration creation
in an isolated directory. Doctor passed both through npm and the installed command
from another directory. Rerunning setup preserved the existing private files.

[Cloud configuration evidence](cloud-config-proof.json) records actual Pi startup
with provider `anthropic` and model `claude-sonnet-4-5`. The generated auth
file contained an environment-variable reference; a synthetic key was used, and
only `get_state` was requested. **No prompt was submitted and no cloud inference
was tested.** This verifies configuration loading, not real key validity, model
access, billing, or cloud response behavior.

Offline tests cover cloud/local credential isolation, sanitized errors, absence
of keys from receipts, private auth references, provider switching, setup
cancellation and no-overwrite behavior, hidden terminal input, readiness failures,
model discovery, runtime failures, SSE, process cleanup, and state ownership.
See [the offline result](offline-proof.json). CI runs the same suite on Node 22
and 24. macOS was not executed in this environment.

## Evidence and scope

[Live receipts](live-proof.json) retain the four local model runs.
[Source hashes](source-sha256.json) identify the current runtime, setup, profile,
and test files. Private dotenv files, credentials, extension paths, and generated
Pi state are excluded. [The earlier extension-free smoke](portable-smoke.json)
remains historical evidence from release 0.1.0.

This release exposes the gateway's `/runs` API. OpenAI-compatible endpoints,
Laravel/Lexi integration, review-quality evaluation, and verified learning
promotion remain separate milestones. Runtime success on synthetic code is not a
real-world PR review benchmark.
