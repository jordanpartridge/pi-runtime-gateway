# HTTP API

The gateway serves HTTP on `127.0.0.1:4319` by default. All routes require
`Authorization: Bearer` followed by the token from the configured state directory's
`token` file. Requests carrying an `Origin` header are rejected, including requests
with a valid token. This API is intended for trusted local service clients.

## Routes

| Method | Route | Successful response |
| --- | --- | --- |
| GET | `/health` | `200`, configured profile, model, transport, and project keys |
| POST | `/runs` | `202`, initial run snapshot |
| GET | `/runs/:id` | `200`, current or final run snapshot |
| GET | `/runs/:id/events` | `200`, `text/event-stream` |
| POST | `/runs/:id/cancel` | `202`, run snapshot |

`GET /health` reports configured service state. It does not run inference or prove
that the configured inference provider can currently serve the model. Its `transport` is `pi-stdio-rpc` and
`openaiCompatible` is `false`.

## Start a run

Use `Content-Type: application/json`. Only `project` and `prompt` are accepted:

```json
{
  "project": "proof",
  "prompt": "Read discount.php and explain the percentage calculation."
}
```

`project` must match a configured project key. `prompt` must be a nonempty plain
text string of at most 16,000 JavaScript string units, and cannot start with `/`.
The entire request body is limited to 20,000 bytes. A request cannot select a
model, provider, path, tool list, or profile.

A run starts in `starting`, then enters `running` after the gateway verifies the
Pi provider, model, and zero-message conversation. Cancellation sets `cancelling`.
Terminal states are `completed`, `failed`, and `cancelled`.

Snapshots include these fields when available:

| Fields | Meaning |
| --- | --- |
| `id`, `project`, `profile` | Run identity and configured execution scope |
| `status`, `error` | Lifecycle status and machine-readable failure code |
| `startedAt`, `finishedAt` | ISO timestamps |
| `provider`, `model`, `sessionId`, `initialMessageCount` | Verified runtime identity |
| `text`, `stopReason` | Accumulated assistant text and reported stopping reason |
| `pid`, `childExited`, `exitCode`, `exitSignal` | Pi process lifecycle |
| `cancelRequestedAt`, `abortAcknowledged` | Cancellation request and RPC acknowledgement |
| `hooks` | Hook receipts collected so far |

Read the terminal status before accepting the result. A failed or cancelled run
can contain partial text. `completed` describes execution success, not an
independent correctness judgment about the model's answer.

## Stream events

`GET /runs/:id/events` replays recorded events and then streams new ones. Every
SSE record contains an `id` sequence number, an `event` type, and JSON `data`.
The JSON includes `seq`, `at`, and `type` plus fields for that event.

| Event | Additional fields |
| --- | --- |
| `status` | `status` |
| `session` | `sessionId`, `initialMessageCount`, `provider`, `model` |
| `text_delta` | `text` |
| `tool_execution_start`, `tool_execution_end` | `tool`, `toolCallId`, `isError` |
| `hook` | Hook receipt fields |
| `cancel_ack` | No additional fields |
| `terminal` | `status`, `error`, `childExited` |

For example, a text event has this shape:

```text
id: 8
event: text_delta
data: {"seq":8,"at":"2026-09-22T00:00:00.000Z","type":"text_delta","text":"The calculation subtracts the raw percentage."}
```

Send `Last-Event-ID` with the last received sequence to replay later events.
Replay is available only during the current server lifetime. A terminal event
closes the stream; subscribing to an already finished run replays its remaining
events and closes. The server sends keepalive comments during an active stream.

A client that falls too far behind can have its stream closed. Reconnect with
`Last-Event-ID` or fetch the run snapshot. The runtime also bounds total event
volume; exceeding that limit fails the run and still produces a terminal receipt.

## Cancel and stop

`POST /runs/:id/cancel` requests `clear_queue` and `abort` over Pi RPC. The gateway
records an acknowledgement when received and terminates the worker; an
unresponsive worker is terminated after the cancellation grace period. Repeating
cancellation after a terminal state returns the existing snapshot.

Completion uses Pi's `agent_settled` event. The gateway then terminates and reaps
the disposable process before emitting the terminal event. A signal-related exit
code, including 143, can therefore accompany a successfully completed run. Use
`status` and `error` to interpret the result instead of the exit code alone.

SIGINT and SIGTERM shut down the service and cancel active work. A forced host
or service kill does not provide the same graceful-shutdown guarantee and can
leave the state directory's `server.lock` in place.

## Errors and limits

Errors are JSON objects with an `error` string. Common HTTP responses:

| Status | Cause |
| --- | --- |
| `400` | Invalid JSON, unsupported fields, invalid prompt, or unknown project |
| `401` | Missing or incorrect bearer token |
| `403` | An `Origin` header is present |
| `404` | Unknown route or run ID |
| `405` | Unsupported method on a recognized run route |
| `409` | Another run is active |
| `413` | Request body exceeds the byte limit |
| `415` | Run request is not `application/json` |
| `429` | The server lifetime's run cap has been reached |
| `500` | Internal service error |

A run accepted with `202` can fail later. Failure codes include
`unexpected_model`, `session_not_fresh`, `spawn_failed`, `startup_timeout`,
`run_timeout`, `provider_error`, `prompt_rejected`, `invalid_rpc_json`,
`pi_exited_before_completion`, `extension_error`, `required_hook_missing`,
`empty_result`, `rpc_pipe_failed`, `rpc_frame_limit`, `audit_limit`, and `event_limit`.
Clients should retain the code and support unrecognized codes without assuming
success.

The default profile permits one active run, 30 runs per server lifetime, a
20-second startup timeout, a five-minute run deadline, and a three-second
cancellation grace period. Profile settings can change the run cap and timeouts.

## Receipts and persistence

The state directory contains:

- `token`: shared bearer token; keep private.
- `server.json`: address, PID, and profile information for the server.
- `server.lock`: exclusive ownership record containing the server PID and a nonce.
- `runs/<run-id>/hooks.jsonl`: hook receipts.
- `runs/<run-id>/events.jsonl`: streamed events.
- `runs/<run-id>/receipt.json`: final run snapshot.

The HTTP run index is in memory and resets on restart. Persisted receipts are for
local inspection; the server does not reload them into the API. Review receipts
before sharing: model output and extension data can include project information.

Use a distinct state directory for each concurrent server. Startup refuses an
existing `server.lock` before changing the generated agent configuration, token,
or server address record. Normal close and startup failure release the server's
own lock; stale locks are never removed automatically. After forced termination,
inspect the recorded PID and verify that the owner has stopped and no gateway is
using the directory before manually removing the stale lock.
