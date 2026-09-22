# Explicit extensions

The default profile loads the gateway's built-in harness and no personal
extensions. Global Pi extension discovery is disabled for each worker.

A custom profile can add extensions by name and path:

```json
{
  "id": "review-with-context",
  "extensions": [
    { "name": "project-context", "path": "./extensions/project-context.ts" }
  ]
}
```

Paths in this override resolve relative to its profile file; absolute paths and
`~` paths are supported. Choose a stable, descriptive name because it appears in
hook receipts. Each extension must export the Pi extension entry point as its
default export.

For example, `extensions/project-context.ts` can contain:

```ts
export default function projectContext(pi: any) {
  pi.on('before_agent_start', (event: any) => ({
    systemPrompt: event.systemPrompt +
      '\n\nProject context: explain the evidence behind each review finding.',
  }));
}
```

Run the gateway with that custom profile. This example registers an ordinary Pi
hook; it requires no retrieval service. For substantial extensions, use the API
supported by the pinned Pi version and test with the actual worker runtime.

## What the wrapper observes

The gateway generates an explicit import wrapper at run startup, allowing Pi's
TypeScript loader to load the configured files. Extensions receive an observed
Pi API. An `extension.loaded` receipt records successful completion of its factory,
including factories that register no callbacks. When an extension registers a
callback through `pi.on`, the wrapper records:

- `registered` with the extension name and event.
- `<name>.<event>.start` when that callback begins.
- `<name>.<event>.end` when it returns, including whether it changed the system
  prompt and whether the input event reported a failed tool.
- `<name>.<event>.error` when the callback throws, including its error type.

The built-in harness records its own session, context, provider-request,
provider-response, and tool-policy receipts. These appear in SSE `hook` events,
run snapshots, and the persisted audit file. A callback receipt proves that the
callback ran; it does not prove that a retrieved memory was useful or that a
review judgment was correct.

## Instructions and tools

The harness includes the configured project's guidance file when it exists
(`projectContextFile`, default `AGENTS.md`) and injects the configured review skill
in full. An absent project guidance file is allowed. The configured system prompt
and skill are explicit profile inputs.

The built-in policy permits the read tools `read`, `grep`, `find`, and `ls` inside
the configured project, with a read exception for the configured skill. Requested
paths are checked against the project's real path. Custom extensions can execute
code outside those tool calls, so this policy does not confine an extension to
the project.

## Extension trust

Extensions are executable code running with the gateway user's privileges. Load
only extensions you have chosen to trust. They can read local files, make network
requests, or alter behavior directly; a clean API receipt is not a sandbox.

The worker receives a deliberately limited environment plus only its selected
cloud API key, when cloud inference is explicitly configured. It does not inherit
unrelated cloud credentials or global Pi settings. An extension that expects
arbitrary shell environment variables may need an explicit integration change;
do not assume the gateway forwards them. Extensions can still use filesystem
access with the user's privileges.

Memory retrieval, tool-failure advisors, and other private integrations can use
this extension seam. None is required by the default profile. Durable learning
needs separate verification and promotion rules; loading a memory extension alone
does not establish a continuous-learning system.
