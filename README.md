# Document Intelligence [![verify](https://github.com/DNikolaiev/caselens/actions/workflows/ci.yml/badge.svg)](https://github.com/DNikolaiev/caselens/actions/workflows/ci.yml)

This is a domain-neutral document-intelligence and compliance-review application. It turns a business dossier into traceable facts, evidence-backed findings, and a human-reviewed decision. The included example evaluates a pharmaceutical supplier; domain packs let the same engine support legal, insurance, or manufacturing workflows.

## Run the deterministic demo

Requirements: Docker Desktop with Linux containers.

```bash
docker compose -f infra/docker-compose.demo.yml up --build -d
```

Open the app at <http://localhost:3000> and API documentation at <http://localhost:4100/docs>.

```bash
docker compose -f infra/docker-compose.demo.yml ps
docker compose -f infra/docker-compose.demo.yml down
```

The demo starts only the web and API containers. It uses memory persistence, queue, storage, and search plus deterministic model, OCR, and scanner providers. It requires no cloud credentials and does not start unused infrastructure.

## Run the local production stack

This profile runs the complete application with durable storage, a real queue, local AI, and local OCR:

```powershell
Copy-Item infra/.env.production-local.example infra/.env.production-local
docker compose --env-file infra/.env.production-local -f infra/docker-compose.production-local.yml up --build -d
```

- App: <http://localhost:3000>
- API docs: <http://localhost:4100/docs>
- MinIO console: <http://localhost:9001>. With the supplied example environment, sign in as `caselens-admin` with password `local_minio_7Jq3V8rM2xK5`. If you edit the environment file, use its `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD` instead.
- MinIO S3 API: <http://localhost:9000>

The first start downloads the Ollama runtime plus `qwen3:4b` and `embeddinggemma:300m-qat-q4_0`, so it can take several minutes and use roughly 3 GB. Follow progress with:

```powershell
docker compose --env-file infra/.env.production-local -f infra/docker-compose.production-local.yml ps
docker compose --env-file infra/.env.production-local -f infra/docker-compose.production-local.yml logs -f ollama-models api worker
```

For the CPU-local default, the worker processes one case and one model request at a time, with a five-minute request limit. This is deliberate: it is slower but avoids competing requests causing local-model timeouts. Deployments with dedicated model capacity can raise `WORKER_JOB_CONCURRENCY` and `WORKER_MODEL_CONCURRENCY` in the environment file.

Select a fictional identity from the profile menu: Lena administers the pharmacy tenant, Jonas the legal tenant, Amara the insurance tenant, and Mateo the manufacturing tenant. Mara Stein is the platform administrator and sees the cross-tenant queue. This is intentionally a local test impersonation mechanism, not authentication.

Stop the stack without losing data using `docker compose ... down`. To intentionally erase all local CaseLens data and downloaded models, use the same command with `down --volumes`.

### Seed the expanded multi-tenant fixture pack

The production-local stack includes seven pharmacy documents and four documents each for the legal, insurance, and manufacturing tenants. The companion evidence and the three policy PDFs are synthetic, repeatable fixtures:

```powershell
npm run fixtures:generate:multi-tenant
npm run fixtures:seed:multi-tenant
```

Generation is byte-stable, and `npm run fixtures:verify` checks both fixture corpora: recorded hashes, page counts, required phrases, evidence-page anchors, Poppler renders, and two consecutive generations producing identical SHA-256 values.

The seed command uses the public API: it uploads each policy, extracts and indexes its clauses, approves the already-valid synthetic proposal, activates the policy, then queues the matching tenant case. The local-only `FIXTURE_POLICY_CATALOG_ENABLED=true` setting makes the three marked policy proposals deterministic; it does not bypass PDF extraction, MinIO, pgvector embeddings, BullMQ, review/activation, or case processing. Keep this flag disabled outside the local synthetic demo.

### Policy lab fixtures

[`fixtures/documents/policy-lab/`](fixtures/documents/policy-lab) holds 13 synthetic PDFs for the legal, insurance, and manufacturing tenants, engineered so each reviewable outcome is provoked on purpose: an approvable rule, a rule blocked as ungrounded, a rule blocked as too weak, a new field proposal, and a field proposal that merges into an existing field by dedup, plus matching satisfying/violating case evidence. [`docs/testing/policy-lab-upload-runbook.md`](docs/testing/policy-lab-upload-runbook.md) drives the whole pipeline by hand, one upload at a time.

## Components and why they exist

| Component                    | Purpose                                                                                            | Current runtime status                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `apps/web`                   | Next.js review console for cases, documents, evidence, findings, corrections, and decisions        | Used by both demo and local production                                 |
| `apps/api`                   | Authoritative NestJS API enforcing validation, tenant scope, and business invariants               | Memory-backed in demo; PostgreSQL-backed in local production           |
| `apps/worker`                | Consumes BullMQ jobs and runs document processing plus LangGraph                                   | Deterministic simulator in demo; durable consumer in local production  |
| `apps/analytics`             | Consumes domain facts into its own read model and serves the analytics API                         | Local production only; shares no schema or package with the pipeline   |
| `apps/mcp`                   | Read-only agent interface over the API                                                             | Optional; not started by Compose                                       |
| `packages/contracts`         | Shared Zod schemas, identifiers, and API/domain types                                              | Used across applications                                               |
| `packages/config`            | Validates environment variables and provider selections                                            | Used at startup                                                        |
| `packages/domain`            | Versioned domain packs and safe deterministic rule DSL                                             | Used by the workflow and demo data                                     |
| `packages/providers`         | Vendor-neutral ports plus deterministic, HTTP, S3, pgvector, and BullMQ adapters                   | Selected by environment in both runtime profiles                       |
| `packages/document-pipeline` | File validation, extraction/OCR strategy, structured facts, confidence, and provenance             | Implemented and tested as a package                                    |
| `packages/retrieval`         | Tenant/version/date-scoped policy indexing and retrieval for grounded decisions                    | Uses canonical policy chunks in PostgreSQL/pgvector                    |
| `packages/workflow`          | LangGraph state machine, retries, checkpoints, review pause, and resume                            | Memory checkpoints in demo; PostgreSQL checkpoints in local production |
| `packages/persistence`       | PostgreSQL/pgvector schema, repositories, indexes, and tenant RLS                                  | Active in local production                                             |
| `packages/events`            | Domain-event envelope and payload schemas shared by publisher and consumer                         | Used by the API outbox and the worker relay                            |
| PostgreSQL + pgvector        | Durable records plus hybrid/vector policy search                                                   | Internal production network service                                    |
| Redis + BullMQ               | Queue handoff, claim coordination, deduplication keys, and retry scheduling between API and worker | Internal production network service; not a business-data store         |
| RabbitMQ                     | Topic exchange carrying domain facts to independent consumers                                      | Internal production network service; delivering to `apps/analytics`    |
| MinIO                        | Local S3-compatible immutable source-document storage                                              | Active in local production; demo uses memory storage                   |
| Ollama                       | Free local structured generation and embeddings                                                    | Qwen3 + EmbeddingGemma by default; model names are configurable        |
| OCR service                  | Native PDF text extraction and Tesseract fallback                                                  | PyMuPDF + Tesseract, internal production network service               |

MinIO is not a business dependency. It is the local S3-compatible implementation of the replaceable `ObjectStorageProvider`; AWS S3, Cloudflare R2, another S3-compatible service, the filesystem adapter, or a new Azure Blob adapter can replace it without changing domain rules.

### What Redis does here

Redis is the transport behind BullMQ in local production. After the API has stored a job record in PostgreSQL, it places a small message in Redis containing the database job ID, tenant ID, case ID, and idempotency key. BullMQ lets one worker claim that message, limits the worker to two concurrent cases, attempts each failed job execution up to three times in total with exponential backoff, and prevents the same job ID from being enqueued twice. Completed queue entries are retained only as a bounded operational history, and Redis persistence uses append-only files on a Docker volume so an API or worker restart does not silently empty the queue.

Redis is **not** the source of truth for case progress and is not used as a general cache. PostgreSQL stores cases, document metadata, durable job status/progress, audit events, workflow checkpoints, and pgvector policy chunks. MinIO stores the uploaded file bytes. Ollama runs generation and embeddings. If Redis is unavailable, new processing work cannot be handed to a worker, but already persisted cases and documents remain in PostgreSQL and MinIO.

### What RabbitMQ does here, and why both brokers

BullMQ carries **commands**: "process this case", addressed to one worker that must exist. RabbitMQ
carries **facts**: "this case was decided", broadcast to whoever cares — or to nobody. They are not
redundant; they are two different shapes of message, and the second one is what lets a new service
be added without editing the API.

The API never publishes. It appends the event to the `domain_events` table **inside the same
transaction as the business change**, so a fact cannot survive a rolled-back change and a committed
change cannot lose its fact. A relay in the worker drains that table to the exchange
`caselens.events`, publishing on a confirm channel and stamping `published_at` only once RabbitMQ
confirms. The routing key is the event type, so a consumer picks what it wants with a binding like
`case.*` rather than the publisher deciding for it.

Delivery is at-least-once: a crash between the confirm and the stamp republishes the event, so
consumers dedupe on event id. Several relays can run at once — the batch is claimed with
`FOR UPDATE SKIP LOCKED`, so they partition the backlog instead of both publishing it. An event that
can never be published is counted and, after five attempts, quarantined out of the delivery index so
it cannot crowd out deliverable events; it is never deleted.

`apps/analytics` is the first consumer. It binds a durable queue to the exchange, one binding per
event type it has actually decided to handle — never `#`, which would silently adopt whatever a
publisher adds to the contract next. It acknowledges a delivery only after processing it, so a crash
mid-projection redelivers rather than loses; a message it cannot process is dead-lettered to
`analytics.events.dlq` instead of being discarded or retried in a hot loop.

It writes to its own PostgreSQL server, migrated separately — not a second database on the existing
server, which would make "analytics is down" and "the case pipeline is down" the same outage. The
idempotency check and the projection write share one transaction, so an event delivered twice moves
the read model once and a projection that fails leaves no record of having succeeded.

It answers **Decision analytics** in the console header: cases in and decisions out per day, median
and 90th-percentile time from creation to decision, how far the read model has consumed, and which
deterministic rules fire without changing the outcome — a rule raising a critical finding on cases
that are approved anyway costs reviewer attention daily and is invisible from the case list. The
console reaches it as a second upstream, never through `apps/api`, and does not wait for it to
start — if the read model is down that page says so and nothing else notices.

A projection can be rebuilt from history with
`docker compose ... run --rm --no-deps worker npm run replay --workspace=@caselens/worker`, which republishes the outbox to a
replay-specific exchange. That is what the outbox is for: a broker forgets an acknowledged message,
so a fact published before this service existed — accepted by RabbitMQ, matched to no queue,
discarded — is unrecoverable by any redelivery, and still sitting in `domain_events` in sequence
order.

It shares no schema, no repository and no workspace package with the case pipeline — only the wire
format in `packages/events`. `apps/api` does not know it exists.

## What is stored where

| Data                                                           | Durable owner         | Why                                                                                                |
| -------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------- |
| Users, tenants, memberships, cases, facts, findings, decisions | PostgreSQL            | Transactional business state, optimistic versions, tenant RLS, and reporting                       |
| Uploaded case and policy PDFs                                  | MinIO                 | Immutable binary storage with stable object keys and SHA-256 provenance                            |
| Extracted page text and evidence coordinates                   | PostgreSQL            | Searchable, reviewable provenance tied to document and page                                        |
| Policy chunks and embedding vectors                            | PostgreSQL + pgvector | Hybrid lexical/vector policy retrieval with tenant, domain, version, date, and revocation filters  |
| Approved deterministic policy rules and rule tests             | PostgreSQL            | Reviewed executable configuration with source citations and immutable history                      |
| Current job status and user-visible job events                 | PostgreSQL            | Notifications survive browser, API, worker, and Redis restarts                                     |
| Domain events (the outbox)                                     | PostgreSQL            | Append-only fact log written in the business transaction; the replay source, since a broker is not |
| Analytics projections and processed-event ids                  | Analytics PostgreSQL  | A separate server so the read model survives the case pipeline's database being unavailable        |
| Waiting/active/retry queue records                             | Redis through BullMQ  | Fast worker coordination, locks, retries, backoff, cancellation, and bounded operational retention |
| LangGraph checkpoints                                          | PostgreSQL            | A worker can resume a durable workflow after a restart                                             |
| Model weights                                                  | Ollama volume         | Free local chat and embedding models without sending documents to a cloud provider                 |

pgvector is not a second database: `vector(768)` columns and their HNSW indexes live inside the same PostgreSQL service as the policy metadata.

## Database schema map

The canonical TypeScript definition is [`packages/persistence/src/schema.ts`](packages/persistence/src/schema.ts). SQL bootstrap and forward migrations live under [`infra/postgres/init`](infra/postgres/init) and [`packages/persistence/migrations`](packages/persistence/migrations).

| Schema group             | Main tables                                                                                             | Responsibility                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Identity and tenancy     | `tenants`, `users`, `memberships`                                                                       | Fictional local identities now; tenant/user authorization boundary for every durable record                     |
| Domain configuration     | `domain_packs`                                                                                          | Immutable installed domain-pack versions, extraction fields, deterministic DSL, and thresholds                  |
| Case intake              | `cases`, `case_participants`, `documents`, `document_pages`                                             | Case state, original-object metadata, per-page extraction method/text/quality, and assignment                   |
| Evidence extraction      | `extraction_runs`, `evidence_spans`, `extracted_facts`                                                  | Model/prompt provenance, page quotations/coordinates, normalized facts, corrections, and confidence             |
| Policy library           | `policy_documents`, `policy_document_pages`, `policy_chunks`                                            | Immutable policy versions, source object metadata, extracted pages, searchable passages, and embeddings         |
| Policy governance        | `policy_rule_proposals`, `policy_rule_proposal_citations`, `policy_rule_proposal_tests`, `policy_rules` | AI proposals, exact source clauses, deterministic tests, review state, priority, activation, and revocation     |
| Evaluation and decisions | `rule_runs`, `findings`, `decisions`                                                                    | Pinned input/policy versions, deterministic results, reviewer resolution, and final human decision              |
| Async processing         | `jobs`, `job_events`, `workflow_checkpoints`                                                            | Current job snapshot, append-only per-user processing timeline, retry/cancel history, and workflow resume state |
| Audit                    | `audit_events`                                                                                          | Append-only business actions with actor, resource, tenant, correlation ID, and safe details                     |

Tenant-owned tables enable and force PostgreSQL row-level security. Application queries also enforce role, tenant, and—in the notification feed—the exact user who enqueued the job. The platform administrator is the explicit aggregate exception.

## What acts when a case is processed

| Step           | Active part                           | Action                                                                                    | Durable result                                                      |
| -------------- | ------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 1. Upload      | Web → API                             | Send one PDF with the selected profile and an idempotency key                             | MinIO object, `documents` row, audit event                          |
| 2. Queue       | API → PostgreSQL → BullMQ             | Create the durable job first, then place its small ID payload in Redis                    | `jobs` snapshot plus `job.created` and queue events                 |
| 3. Claim       | BullMQ → worker                       | One worker claims the job; concurrent processing is bounded                               | `worker.claimed`, attempt number, processing state                  |
| 4. Read        | Worker → MinIO → OCR service          | Load bytes, extract native text, and use Tesseract only for weak/scanned pages            | `document_pages`, extraction strategy, warnings                     |
| 5. Extract     | Worker → Ollama chat model            | Ask only for allowlisted domain fields; validate types and exact page quotes              | Evidence-linked fact candidates; invalid output becomes review work |
| 6. Reconcile   | LangGraph + domain package            | Normalize facts and expose identity/value conflicts without overwriting them              | Canonical facts, alternatives, review reasons                       |
| 7. Retrieve    | Worker → Ollama embeddings → pgvector | Embed the case query and rank only active in-scope policy passages                        | Cited policy chunks or an explicit retrieval abstention             |
| 8. Evaluate    | Deterministic rule engine             | Evaluate required documents and approved domain/policy rules                              | `rule_runs`, findings, pinned rule/policy versions                  |
| 9. Review gate | LangGraph                             | Pause when evidence is missing, conflicting, low-confidence, or policy retrieval abstains | PostgreSQL checkpoint and `needs_review` status                     |
| 10. Decide     | Reviewer/approver → API               | Correct facts, resolve findings, re-evaluate explicitly, and record a decision            | Versioned corrections, findings, decision, audit trail              |

The model extracts and summarizes; it does not approve. Threshold comparisons, required-document gates, rule tests, and final human decisions remain deterministic or human-owned.

## What acts when a policy is processed

```mermaid
flowchart LR
    admin[Administrator uploads PDF] --> api[NestJS validates and stores source]
    api --> minio[(MinIO)]
    api --> queue[BullMQ job]
    queue --> worker[Policy worker]
    worker --> pages[Native text and OCR pages]
    pages --> chunks[Clause-aware chunks and citations]
    chunks --> embed[Embedding provider]
    embed --> vector[(PostgreSQL + pgvector)]
    chunks --> propose[Schema-constrained rule proposals]
    propose --> validate[Field, operator, citation and fixture validation]
    validate --> review[Administrator reviews original clause]
    review --> activate[Activate immutable policy/rule version]
    activate --> evaluate[Future or explicitly re-evaluated cases]
```

Policy PDF text is untrusted evidence. It cannot insert JavaScript, change prompts, create unknown fact fields, or activate itself. A proposal must use the allowlisted rule DSL, cite an exact policy page/quote, pass match/no-match/missing-value/boundary tests, and receive administrator approval. Existing cases retain the versions used during their original evaluation until someone explicitly requests re-evaluation. Upload targets a tenant's policy collection — an administrator picks an existing one or names a new one, which mints a pack version immediately.

The review screen always shows every generated rule. A green test means the actual result matched its expected result; red means that exact expectation failed, regardless of whether the category is `match`, `no_match`, `missing_value`, or `boundary`. Validation blockers list their code, field path, and explanation. Valid rules may be approved or dismissed; invalid rules may be dismissed with an audit reason but cannot be approved. Selecting a citation navigates the original PDF to its page and highlights the matching clause.

### Rule registry

Each tenant has one rule registry, grouped by policy collection. Every active rule states its origin: a domain-pack rule shows the pack name and version that shipped it; a policy-derived rule links to the source policy document and version it was cited from. A collection with no approved rule yet stays listed rather than disappearing.

### Field vocabulary and semantic dedup

A policy may also propose a new extraction field, not just a rule — but the closed-vocabulary invariant holds: extraction only ever runs against an approved catalog, so a policy proposes and an administrator approves. Approval mints a new version of `domain_packs.definition`, the authoritative per-tenant pack; a tenant that has never minted one still resolves reads against the compiled catalog.

Proposed fields are deduplicated by meaning, not wording. The candidate is embedded, the nearest existing fields are recalled from pgvector, and only above a similarity floor is the chat model asked to rule same-or-different over that short list. A duplicate becomes an alias on the existing field rather than a second path — "coverage amount" teaches the extractor another way to find the existing liability-limit field instead of creating a rival one. The floor is a recall guard, not a decision boundary: measured synonym and unrelated-field similarity bands overlap, so the model decides and post-model gates reject a path it invented or one of the wrong type. This also depends on EmbeddingGemma's documented task prefixes — without them, every pair in this vocabulary scores 0.86-0.96 and dedup cannot discriminate.

Neither a newly approved field nor rule reaches an existing case automatically; `POST /v1/cases/:id/reprocess` explicitly re-runs one against the widened pack.

## How it works

![CaseLens end-to-end pipeline: a versioned domain pack feeds policy upload, model proposal, governance, and case evaluation, with approval looping a new pack version back into the dictionary](docs/assets/pipeline.svg)

This draws the two pipelines above as one loop: a domain pack supplies fields, baseline rules, and collections; a policy upload proposes rules and fields against it; governance approves or blocks; approval mints a new pack version; and case documents are checked against that pack — known field, right type, real quote, best score — before producing findings and a decision.

```text
┌────────────────────────────────────────────────────────────────────────────┐
│                          Shared Low-Level Intake                           │
│    Validate MIME / Safety   ──▶   MinIO Storage   ──▶   PyMuPDF / OCR      │
└─────────────────┬───────────────────────────────────────┬──────────────────┘
                  │                                       │
                  ▼                                       ▼
┌────────────────────────────────────┐  ┌────────────────────────────────────┐
│      Case Ingestion Pipeline       │  │        Policy Lab Pipeline         │
├────────────────────────────────────┤  ├────────────────────────────────────┤
│ Input:                             │  │ Input:                             │
│   Case dossier (questionnaires,    │  │   Governance standards (insurance  │
│   certificates, contracts)         │  │   requirements, GDP rules)         │
│                                    │  │                                    │
│ Mission:                           │  │ Mission:                           │
│   Extract empirical facts about    │  │   Author rules and build the       │
│   an external entity               │  │   retrieval vector index           │
│                                    │  │                                    │
│ LLM Role:                          │  │ LLM Role:                          │
│   Schema-constrained facts with    │  │   Propose rule ASTs and            │
│   verbatim page citations          │  │   deduplicate vocabulary fields    │
│                                    │  │                                    │
│ Output:                            │  │ Output:                            │
│   Evidence-backed findings against │  │   pgvector chunks & tested rules   │
│   active rules ──▶ Human Decision  │  │   ready for admin activation       │
└─────────────────┬──────────────────┘  └─────────────────┬──────────────────┘
                  ▲                                       │
                  │       Retrieves Policy Context        │
                  └───────────────────────────────────────┘
```

### Example: an insurance policy becomes a material finding

One real path through the seeded pharmacy tenant, Düsseldorf Health Operations (`tenant_demo`, administered by Lena Vogt), captured on the local production stack:

**1. Upload into a collection.** An administrator names or picks a collection and attaches the PDF. Here "Supplier Insurance Requirements" version `portfolio-2026.08.31` goes into the **Insurance Requirements** collection. The workspace switcher in the header re-scopes the whole page; only the platform administrator owns every workspace, everyone else sees a static label for their one.

![Policy library page: upload form, workspace switcher, and policy register](docs/assets/screenshots/policy-library.png)

**2. The model proposes, an administrator reviews.** The worker extracts clauses and proposes cited rules against them (see [above](#what-acts-when-a-policy-is-processed) for the grounding and test gates every proposal must clear). The screenshot below shows this same review screen on a different seeded policy — Rheinland Legal Services' governing-law control — the mechanics are identical for every tenant and policy:

![Policy review screen: original clause, rule logic, and rule tests for a governing-law rule](docs/assets/screenshots/policy-review.png)

**3. Approval lands in the registry.** Düsseldorf Health Operations' Insurance Requirements collection now shows both a long-standing rule badged **SYSTEM DEFAULT** and two rules badged **FROM POLICY REGISTER**, cited to "Supplier Insurance Requirements · portfolio-2026.08.31":

![Rule registry: four collections, system-default and policy-derived rules, and one empty collection](docs/assets/screenshots/rule-registry.png)

Note the empty **Pharmaceutical Distribution Policy** collection beside it — it stays listed with no rules rather than disappearing.

**4. A case runs against those rules.** The review queue tracks every open case; the platform administrator sees all four tenant workspaces at once:

![Case queue: cross-tenant review queue with decision-readiness stats](docs/assets/screenshots/case-queue.png)

Case `SUP-2026-0142`, MediSupply GmbH, is one of the cases needing review. Its extracted liability coverage is €1,000,000 against the €2,000,000 per-occurrence minimum both rules now share, so it fires as a major finding (`insurance.minimum_limit`) linked to the exact page and quote it came from:

![Case workspace: source documents, original PDF, and material findings with a request-information recommendation](docs/assets/screenshots/case-workspace.png)

**5. A reviewer records a decision.** From here a reviewer opens the cited page, adds the finding to follow-up, and sends or copies a **Request information** draft — see [Original-document evidence review](#original-document-evidence-review) next for how evidence navigation and follow-up drafting work.

To run this kind of path yourself, see [Policy lab fixtures](#policy-lab-fixtures): it drives the same upload-review-approve-run sequence by hand across three other tenants, deliberately provoking every reviewable outcome once.

## Original-document evidence review

The case workspace renders the authorised original PDF in the centre pane. “Extracted text” is a secondary review aid. Selecting a fact or finding updates a deep link containing `document`, `page`, and `evidence`, switches to the correct source, opens the page, and highlights matching text. The original is streamed through the API after tenant authorization; the browser never receives MinIO credentials. When exact geometry is unavailable, the UI labels and uses quote matching rather than pretending the highlight is exact.

For supplier follow-up, a reviewer marks one or more findings with **Add to follow-up**. **Request information** then opens a deterministic business-tone draft containing every selected finding and requested action. If the case documents expose a contact email, the primary action records the request and opens the operating system's email client through an encoded `mailto:` draft. Without an email, the complete subject and message remain visible and the primary action records and copies them for manual delivery. Draft generation is local and does not send case content to another model.

## Processing notifications and user isolation

The header notification centre reads the durable `jobs`/`job_events` feed. A tenant user sees only jobs whose `enqueued_by_user_id` matches the active profile—even another user in the same tenant cannot see them. Switching profiles closes the old event stream and clears its cached items before opening the new feed. Mara Stein, the platform administrator, may inspect the aggregate cross-tenant feed.

The UI distinguishes these events instead of calling all of them “deleted”:

```text
created → enqueue requested → queued → worker claimed → processing stages
        → completed / needs review / failed / cancelled
        → queue record removed by explicit retention or cancellation
```

Claiming a job means work started; it is not deletion. Removing a completed Redis record is operational cleanup and does not remove the PostgreSQL history. Important terminal events produce an in-app notification; the detailed ledger keeps stage, progress, attempts, safe errors, cancellation, retry, and cleanup history.

See [ARCHITECTURE.md](ARCHITECTURE.md) for system boundaries and [AGENTS.md](AGENTS.md) for contributor guidance.

## Current LangGraph process

This diagram mirrors the compiled graph in `packages/workflow/src/workflow.ts`:

```mermaid
flowchart TD
    start((START)) --> validate[Validate files and safety]
    validate -->|valid| extract[Extract text and structured facts]
    validate -->|fatal or retries exhausted| failed((END · failed))
    extract -->|success| classify[Classify document types]
    extract -->|retries exhausted| failed
    classify -->|success| reconcile[Reconcile facts and identities]
    classify -->|retries exhausted| failed
    reconcile -->|success| retrieve[Retrieve scoped policy evidence]
    reconcile -->|retries exhausted| failed
    retrieve --> evaluate[Evaluate required documents and deterministic rules]
    evaluate --> gate{Review reasons or manual/request-info recommendation?}
    gate -->|yes| review[Needs human review]
    review --> reviewEnd((END · checkpointed))
    gate -->|no| summarize[Generate advisory summary]
    summarize --> complete[Mark completed]
    complete --> completedEnd((END · completed))

    review -. correct or confirm with reason .-> reevaluate[Apply corrections and re-evaluate deterministic rules]
    reevaluate -. material issues remain .-> review
    reevaluate -. clear .-> complete
    review -. cancel .-> cancelled((END · cancelled))
```

Important behavior:

- Validate, extract, classify, reconcile, retrieve, and summarize use bounded retry and timeout handling.
- Extraction processes page-aware text in bounded, overlapping chunks so long dossiers do not overflow a model context window.
- The local Ollama adapter disables reasoning for extraction, requests JSON, and validates every response in the application against its Zod schema. Model output cannot change the schema or bypass validation.
- Policy proposal generation allows up to 300 seconds by default for CPU-only Ollama (`WORKER_POLICY_MODEL_TIMEOUT_MS` can be set from 30000 to 600000) and caps each response at three proposals.
- Every accepted fact citation must name the uploaded document, page, and an exact normalized quote present on that page; unsupported citations are rejected.
- Unknown fields, wrong value types, and unsupported model citations are quarantined as review warnings instead of crashing the whole case.
- Retrieval failure abstains and adds a review reason; it does not silently use an unrelated policy.
- Deterministic rules produce findings and the recommendation. The model-generated summary is advisory.
- Human corrections require a reason and create a new checkpoint revision before re-evaluation.
- `CaseWorkflowRunner` is used by the production worker. The deterministic demo keeps its simpler no-infrastructure progress runner.

See [LangGraph workflow](docs/architecture/langgraph-workflow.md) for every node, branch, state field, retry rule, and production wiring.

## Start for development

Requirements: Node.js 24+ and npm 11+.

```bash
npm install
npm run dev --workspace=@caselens/api
npm run dev --workspace=@caselens/web
```

Run the API and web commands in separate terminals. The worker can be run separately when developing its processor:

```bash
npm run dev --workspace=@caselens/worker
```

## Verify

```bash
npm run verify
python scripts/verify-fixtures.py
```

The database integration suites run automatically in CI. Against the local production stack, run the disposable test profile. It receives a runtime connection for RLS assertions and a local-only owner connection solely to remove its uniquely prefixed fixtures afterward; PostgreSQL remains private to Docker:

```powershell
docker compose --profile test --env-file infra/.env.production-local -f infra/docker-compose.production-local.yml run --rm integration-tests
```

With the demo running, install Chromium once and execute the browser suite:

```bash
npm exec -- playwright install chromium
npm run test:e2e
```

The suite runs desktop and mobile Chromium checks. `apps/web/e2e/notifications.spec.ts` guards the header bell, unread badge, open/close controls, keyboard dismissal, job timeline, clickability, and viewport overflow. `policy-review.spec.ts` covers rule visibility, validation/test semantics, citation highlighting, and blocked-rule dismissal; `case-workspace.spec.ts` covers the follow-up composer and case evidence navigation.

Playwright targets `http://127.0.0.1:3000` by default. Inspect the latest HTML report with:

```bash
npm exec -- playwright show-report playwright-report
```

A global Playwright installation is not required.
