# Security

Pi Runtime Gateway is a trusted local service for explicitly configured projects
and extensions. It is not a sandbox for hostile code or an Internet-facing API.

## Trust boundary

The server binds to `127.0.0.1`, requires a bearer token on every route, and
rejects requests carrying a browser `Origin` header. The token and runtime files
are stored in a private state directory. Anyone who can read the token and reach
the service can request work on its configured projects. An exclusive
`server.lock` prevents concurrent gateways from sharing generated state. Use
different state directories for concurrent instances; remove a stale lock only
after verifying that its recorded owner has stopped and the directory is unused.

Clients choose project keys, not arbitrary working directories, providers,
or inference models. Chat clients can supply function schemas; these are handed
back for client execution, and replace the active Pi tool set for that request.
The gateway never executes client functions. Workers start with fresh conversations and an isolated Pi agent
directory. Automatic global discovery is disabled; the gateway explicitly loads
its profile, project guidance, skill, and configured extensions.

The default read-tool policy checks paths within the configured project and
permits reading the configured skill. This is an application policy, not an OS
sandbox. Pi, Ollama, and extensions run with their respective operating-system
permissions. Custom extensions execute as the gateway user and can access files
and networks independently of model tool calls. Do not rely on the policy to
contain malicious extensions or hostile repositories.

With cloud inference, the chosen provider receives prompts, project guidance,
retrieved content, and tool results. Local hosting does not imply local inference;
Ollama URLs can also point to another host. Provider selection is operator-controlled
and there is no automatic cloud fallback.

Model output and retrieved content are untrusted data. A completed run reports
successful execution; it does not certify that an answer is correct or authorize
an external action.

## Operational data

Keep the state directory, token, `.env`, and private local profiles out of version
control. Setup creates `.env` with mode `0600` and preserves existing files. The
gateway parses dotenv as data; it does not source or evaluate shell code. Saved chat inputs, run output, project
guidance, and extension audit data may contain sensitive project information.
Review and redact receipts before publishing them. Stderr is represented by
hash/size metadata rather than raw content, but that does not make other receipts
safe to publish automatically.

The gateway forwards only the explicitly configured key to the selected cloud
worker. It does not inherit unrelated provider credentials, and local Ollama
workers receive no cloud key. Generated Pi auth holds an environment reference;
the actual key stays in the private dotenv/process environment. This does not hide credentials accessible through the user's
filesystem or through a trusted extension. Use a separate operating-system user
or a suitable sandbox if your deployment needs stronger isolation.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting in this repository's Security tab
when available. If no private reporting channel is offered, open an issue asking
for a private contact without including exploit details, credentials, tokens, or
private project contents.

Include the gateway revision, Node/Pi versions, affected configuration, impact,
and a minimal reproduction that uses synthetic data. No response time or support
window is currently guaranteed.
