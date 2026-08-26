# LangGraph workflow

The implemented workflow lives in `packages/workflow/src/workflow.ts`. `CaseWorkflowRunner` compiles a LangGraph `StateGraph` over the state declared in `packages/workflow/src/state.ts`.

## Graph

```mermaid
flowchart TD
    start((START)) --> validate[validate]
    validate -->|running| extract[extract]
    validate -->|failed| failed((END · failed))
    extract -->|running| classify[classify]
    extract -->|failed| failed
    classify -->|running| reconcile[reconcile]
    classify -->|failed| failed
    reconcile -->|running| retrieve[retrieve]
    reconcile -->|failed| failed
    retrieve --> evaluate[evaluate]
    evaluate --> gate{review required?}
    gate -->|yes| review[review · needs_review]
    review --> reviewEnd((END · checkpointed))
    gate -->|no| summarize[summarize]
    summarize --> complete[complete]
    complete --> completedEnd((END · completed))

    review -. resume: correct or confirm .-> reevaluate[merge corrections and re-run deterministic evaluation]
    reevaluate -. unresolved .-> review
    reevaluate -. resolved .-> safeSummary[safe advisory summary]
    safeSummary -.-> complete
    review -. resume: cancel .-> cancelled((END · cancelled))
```

The dashed human-resume path is implemented by `CaseWorkflowRunner.resume()` outside the compiled graph. It loads the saved checkpoint, requires a reviewer reason, applies fact corrections, re-runs required-document and deterministic domain rules, and saves the next optimistic revision.

## Node responsibilities

| Node        | Input/output responsibility                                                                                  | Failure behavior                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `validate`  | Runs file/safety validation and appends warnings                                                             | Fatal validation results or exhausted retries set `status=failed` and end the graph                                      |
| `extract`   | Produces structured facts, low-confidence paths, and extraction warnings                                     | Exhausted retries set `status=failed` and end the graph                                                                  |
| `classify`  | Records available document types and ambiguity review reasons                                                | Exhausted retries set `status=failed` and end the graph                                                                  |
| `reconcile` | Detects cross-document identity conflicts and other reconciliation review reasons                            | Exhausted retries set `status=failed` and end the graph                                                                  |
| `retrieve`  | Retrieves tenant/domain/version/date-scoped policy citations                                                 | Missing/stale policy or provider failure becomes `retrievalStatus=abstained` plus a review reason; evaluation still runs |
| `evaluate`  | Runs required-document checks and the deterministic rule engine, sorts findings, and maps the recommendation | It does not call a model; material findings, conflicts, low confidence, and information gaps route to review             |
| `review`    | De-duplicates review reasons and sets `status=needs_review`                                                  | Ends the current run at a checkpoint awaiting a human command                                                            |
| `summarize` | Requests a non-authoritative human-readable summary                                                          | Provider failure produces a fixed fallback warning and does not change findings or recommendation                        |
| `complete`  | Sets `status=completed`                                                                                      | Ends the graph                                                                                                           |

## Retry and timeout policy

`validate`, `extract`, `classify`, `reconcile`, `retrieve`, and `summarize` run through the same bounded retry wrapper:

- default maximum attempts: `2`;
- default timeout per attempt: `30,000 ms`;
- attempt counts are retained in `state.attempts`;
- provider details are converted into safe workflow-level reasons;
- cancellation is checked before each node starts.

The graph deliberately treats retrieval differently from validation or extraction. A retrieval outage must not invent policy evidence, but it should preserve extracted facts and route the case to a reviewer instead of discarding the whole run.

## State carried between nodes

The graph state contains:

- scope and idempotency: `tenantId`, `caseId`, `idempotencyKey`;
- execution: `status`, `phase`, `attempts`, warnings;
- document results: facts, document types, and low-confidence paths;
- reconciliation: identity-conflict flag and review reasons;
- retrieval: status and citations;
- decision material: deterministic findings and recommendation;
- human/model output: review command and advisory summary.

## Idempotency and checkpoints

The checkpoint key is `tenantId:caseId:idempotencyKey`. A duplicate `run()` returns the existing state instead of repeating provider calls. Saves use an expected revision, so two reviewers cannot silently overwrite the same checkpoint.

The default checkpoint store is process-local memory. A durable production deployment still needs a PostgreSQL-backed checkpoint implementation shared by API and worker processes.

## Current runtime wiring

There are currently two different workflow-related implementations:

1. `packages/workflow/CaseWorkflowRunner` is the LangGraph implementation described above and is covered by workflow tests.
2. `apps/worker/DeterministicWorkflowRunner` is a simpler progress simulator that walks `validate`, `extract`, `classify`, `reconcile`, `retrieve`, and `evaluate` names and always returns the deterministic demo recommendation.

The worker application does not yet instantiate `CaseWorkflowRunner`, consume BullMQ jobs, or share durable checkpoints with the API. The production startup guard exists specifically to prevent that scaffold from being presented as a finished durable workflow.

## Production composition required

Before the production application profile can be enabled, the worker must:

- consume idempotent BullMQ jobs from Redis;
- construct `CaseWorkflowRunner` with real pipeline, retrieval, domain-pack, and summary dependencies;
- load/store checkpoints and job status in PostgreSQL transactionally;
- fetch immutable source documents from S3-compatible storage;
- expose dependency-backed readiness and graceful shutdown;
- preserve tenant identity and audit correlation across every job.
