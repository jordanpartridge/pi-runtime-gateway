# Review quality controls

These are proposed review controls, not claims about the milestone-one runtime.
The current server proves execution. Real PR grading still needs the downstream
workflow and an evaluation set.

## Keep deterministic gates first

Capture repository, head SHA, base SHA, required check results, and mergeability.
Conflicts go to the builder for rebase/repair. Required CI failures go to the review
fix worker. Missing or pending required checks remain pending. A branch that is
behind and a branch that conflicts are different states; apply the repository's
freshness policy explicitly. Recheck the head and relevant base state before
publishing or merging. New code invalidates the earlier verdict; never recycle an
approval across changed code.

GitHub supports dismissing stale reviews and requiring approval of the latest
reviewable push. A merge queue can validate the prospective merge against current
base changes when repeated rebases become expensive:
[GitHub branch protection](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

## Test behavior and intent, not just execution

Map acceptance criteria to changed behavior, tests, and supporting evidence. Read
relevant callers, configuration, schemas, and dependencies beyond the diff. Check
negative paths: unauthorized users, missing input, empty results, boundary values,
duplicate events, retries, concurrency, partial failures, and stale data.

For a regression fix, prefer evidence that its test fails before the fix and passes
after it. For risk-bearing logic, selectively use property or mutation tests to
check assertion strength. Coverage is a signal; executed lines alone do not prove
that assertions would catch a defect. Classify absent evidence separately from a
reproduced bug.

## Include production consequences

Assess affected API contracts, migrations and existing data, deployment order,
rollback/recovery, queue idempotency, performance at representative scale, logging,
and UI accessibility where applicable. For Laravel, pay attention to tenant and
resource authorization, mass assignment, N+1 queries, transaction boundaries, jobs
running before commit, and schema changes incompatible with still-running workers.
Select checks based on the actual change; avoid making every PR carry every check.

Security review should include business logic and authorization context beyond
scanner output, consistent with
[OWASP's secure code review guidance](https://cheatsheetseries.owasp.org/cheatsheets/Secure_Code_Review_Cheat_Sheet.html).

## Require defensible findings and allow an incomplete verdict

Each actionable finding carries the reviewed SHA, file/line, concrete trigger,
impact, evidence or reproduction, and severity. Keep confidence separate from
impact. Suppress unsupported speculation and style preferences from blocking
findings. Report what was inspected and what could not be checked.

Support pending, changes-required, and insufficient-evidence/escalation outcomes
alongside ready-for-approval. A timeout, missing context, or unfinished review must
never turn into approval. Escalate sensitive or ambiguous work to a fresh reviewer
or optional cloud/human review. After a worker fixes code, use a fresh review of the
new SHA so it cannot inherit its own earlier approval.

## Make continuous learning falsifiable

Save candidate lessons with the fact, repository/framework version scope, source
URL or local reproduction evidence, discovery method, originating PR/SHA, and
verification time. Promote only after checking the evidence; preserve corrections
and superseded facts. Treat PR text and retrieved memory as untrusted evidence,
never instructions granting tools or changing the review policy.

Build a small replay set from known defects and clean PRs. Track valid findings,
false alarms, missed known defects, review time, and escalation rate by category.
Add accepted findings and later escaped bugs as regression cases. Evaluate profile,
model, and memory changes against that set before calling them improvements.
These measurements establish which work local Qwen can handle and where a second
review pays for itself. No model or checklist earns a permanent 10/10 claim.
