# CaseLens

CaseLens is a domain-configurable document intelligence and compliance review portfolio application. Its working demo reviews a pharmaceutical supplier dossier and produces evidence-backed findings; its architecture can be reused for legal, insurance, manufacturing, or other document-heavy decisions without coupling those domains to one model or cloud.

## What the demo proves

- mixed document intake with text/OCR strategy, provenance, confidence, and failure states;
- schema-constrained extraction and cross-document conflict detection;
- scoped policy retrieval plus deterministic rules;
- resumable conditional workflow with a human-review pause;
- reviewer corrections, finding resolution, final decision, and audit export;
- provider ports for models, OCR, storage, search, queues, scanners, and persistence;
- a read-only MCP interface for agent-assisted analysis.

The supplied MediSupply GmbH case intentionally reaches **Request information**: the GDP certificate is missing, €1m insurance is below the €2m requirement, and the contract party conflicts with the commercial register.

## Run the deterministic demo

Requirements: Node 24+, pnpm 11+, and Python with ReportLab/PyPDF/pdfplumber only when regenerating PDFs.

```bash
pnpm install
pnpm --filter @caselens/api dev
pnpm --filter @caselens/web dev
```

Open `http://localhost:3000`; API documentation is at `http://localhost:4100/docs`. Demo providers need no credentials. Run the worker independently with `pnpm --filter @caselens/worker dev`.

Infrastructure only:

```bash
docker compose -f infra/docker-compose.yml up -d postgres redis minio
```

The optional containerized deterministic demo is `docker compose -f infra/docker-compose.yml --profile demo up --build`. It deliberately keeps application state in memory; PostgreSQL, Redis, and MinIO are included for adapter development and integration testing, not presented as an end-to-end production deployment. Local passwords in Compose are deliberately non-production.

## Verification

```bash
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
python scripts/verify-fixtures.py
```

With the containerized demo running, install the browser once and run the desktop and mobile UI regression suite:

```bash
pnpm exec playwright install chromium
pnpm test:e2e
```

The suite defaults to `http://127.0.0.1:3000`. Set `PLAYWRIGHT_BASE_URL` to exercise another CaseLens deployment. Failure traces, screenshots, and videos are written under `test-results/`, with the HTML report under `playwright-report/`.

## Structure

- `apps/web`: Next.js review console
- `apps/api`: authoritative NestJS REST application
- `apps/worker`: separately scalable NestJS job worker
- `apps/mcp`: MCP SDK v2 read-only tools
- `packages/contracts`: shared runtime schemas and types
- `packages/domain`: versioned packs and safe deterministic rules
- `packages/providers`: ports, registries, and adapters
- `packages/document-pipeline`: validation, text/OCR, extraction, reconciliation
- `packages/retrieval`: scoped hybrid policy retrieval
- `packages/workflow`: conditional, resumable orchestration
- `packages/persistence`: PostgreSQL/pgvector schema and RLS migration
- `fixtures`: domain packs, documents, quarantined failures, and expected outputs

Read [the architecture overview](ARCHITECTURE.md), [the detailed product/architecture spec](docs/specs/caselens.md), [the living implementation plan](docs/superpowers/plans/2026-08-26-caselens.md), and [provider switching](docs/operations/provider-switching.md) before extending the system.

## Honest scope

Demo mode is fully deterministic and suitable for review without external services. External adapters and production infrastructure seams are implemented and contract-tested, but the demo API and worker are not yet composed end to end with PostgreSQL, BullMQ, or S3. A real deployment still needs a provider-composition module, durable repositories/checkpoints, organization-specific OIDC, secret management, malware/OCR/model endpoints, retention policy, labeled evaluation data, container smoke tests, and a security review.
