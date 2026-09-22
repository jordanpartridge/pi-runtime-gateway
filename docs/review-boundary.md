# Downstream review-service boundary

The gateway runs Pi. A caller owns the pull request workflow, repository checkout,
required checks, durable findings, and publishing credentials. A future Laravel
review service can use this runtime behind a narrow review tool; Lexi can call
that tool and continue submitting real GitHub reviews using its existing bot
identity. The Pi worker needs no GitHub posting credentials.

This is a proposed integration contract, not implemented by the runtime gateway.

## Gate order

1. Capture PR head/base revisions, branch freshness, and mergeability. Conflicts
   return to the builder for rebase/conflict repair. Unknown mergeability stays
   pending. Apply the repository's freshness policy explicitly.
2. Required CI must pass for that exact head. Red CI goes to a review/fix worker.
   Missing or pending checks remain pending.
3. Semantic review checks meaningful tests, edge cases, adequate coverage,
   fulfillment of PR intent, security, and completeness.
4. Findings reference the reviewed head SHA. The publisher rechecks state before
   publishing and deduplicates by request/head identity. New changes require a
   fresh verdict.

Return structured findings to the caller; keep posting identity, credential
management, retries, and review-state transitions outside the inference worker.
A worker that changes code must not reuse its own earlier approval for that code.

## Transport boundary

The current API is a run-oriented HTTP service over Pi stdio RPC. An
OpenAI-compatible adapter would require its own tested message/tool/streaming
contract. Provider credentials alone do not make this gateway API compatible with
Laravel AI or another OpenAI client.

Optional extensions may retrieve relevant knowledge or advise on failed tools.
Their presence does not imply a semantic review verdict. Keep learning candidates
separate from verified durable knowledge; promote them only after evidence and
applicability checks. See [review quality](review-quality.md).
