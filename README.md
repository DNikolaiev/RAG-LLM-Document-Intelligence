# CaseLens

CaseLens is a document-intelligence and compliance-review demo. It turns a business dossier into traceable facts, evidence-backed findings, and a human-reviewed decision. The included example evaluates a pharmaceutical supplier, while the same architecture can support legal, insurance, or manufacturing workflows.

## Start with Docker

Requirements: Docker Desktop with Linux containers.

```bash
docker compose -f infra/docker-compose.yml --profile demo up --build -d
```

Then open:

- App: <http://localhost:3000>
- API documentation: <http://localhost:4100/docs>
- MinIO console: <http://localhost:9001>

Check or stop the stack:

```bash
docker compose -f infra/docker-compose.yml --profile demo ps
docker compose -f infra/docker-compose.yml --profile demo down
```

The Docker demo uses deterministic in-memory application adapters, so no AI credentials are required. PostgreSQL, Redis, and MinIO run alongside it for infrastructure and adapter development; they do not yet persist the demo application's state.

## Start for development

Requirements: Node.js 24+ and pnpm 11+.

```bash
pnpm install
pnpm --filter @caselens/api dev
pnpm --filter @caselens/web dev
```

Run those development commands in separate terminals. The worker is optional for the current deterministic demo:

```bash
pnpm --filter @caselens/worker dev
```

## Architecture in brief

The Next.js review console calls an authoritative NestJS API. Long-running document work belongs to a separate worker. Shared packages provide typed contracts, domain rules, document extraction, retrieval, workflow orchestration, provider adapters, and the PostgreSQL schema. AI, OCR, search, queues, storage, and persistence sit behind replaceable provider interfaces.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the system design. Contributor and coding-agent guidance lives in [AGENTS.md](AGENTS.md).

## Verify

```bash
pnpm verify
python scripts/verify-fixtures.py
```

With the app running, install Chromium once and run the browser suite:

```bash
pnpm exec playwright install chromium
pnpm test:e2e
```

Set `PLAYWRIGHT_BASE_URL` to test a deployment other than `http://127.0.0.1:3000`.
