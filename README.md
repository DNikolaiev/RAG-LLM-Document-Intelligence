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
- MinIO console: <http://localhost:9001> (`caselens` / `caselens-minio-local-only`)
- MinIO S3 API: <http://localhost:9000>

Check or stop the stack:

```bash
docker compose -f infra/docker-compose.yml --profile demo ps
docker compose -f infra/docker-compose.yml --profile demo down
```

The Docker demo uses deterministic in-memory application adapters, so no AI credentials are required. PostgreSQL, Redis, and MinIO run alongside it for infrastructure and adapter development; they do not yet persist the demo application's state.

## Start for development

Requirements: Node.js 24+ and npm 11+.

```bash
npm install
npm run dev --workspace=@caselens/api
npm run dev --workspace=@caselens/web
```

Run those development commands in separate terminals. The worker is optional for the current deterministic demo:

```bash
npm run dev --workspace=@caselens/worker
```

## Architecture in brief

The Next.js review console calls an authoritative NestJS API. Long-running document work belongs to a separate worker. Shared packages provide typed contracts, domain rules, document extraction, retrieval, workflow orchestration, provider adapters, and the PostgreSQL schema. AI, OCR, search, queues, storage, and persistence sit behind replaceable provider interfaces.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the system design. Contributor and coding-agent guidance lives in [AGENTS.md](AGENTS.md).

## Verify

```bash
npm run verify
python scripts/verify-fixtures.py
```

With the app running, install Chromium once and run the browser suite:

```bash
npm exec -- playwright install chromium
npm run test:e2e
```

Playwright uses `http://127.0.0.1:3000` by default. Set `PLAYWRIGHT_BASE_URL` to test another deployment.

To inspect the latest run in a browser:

```bash
npm exec -- playwright show-report playwright-report
```

### Playwright troubleshooting

Run Playwright from `C:\Projects\Codex\caselens` and use the project-local command:

```powershell
Set-Location C:\Projects\Codex\caselens
npm install
npm exec -- playwright install chromium
docker compose -f infra/docker-compose.yml --profile demo up -d
npm run test:e2e
```

- `Cannot find module '@playwright/test'`: run `npm install`.
- `Executable doesn't exist`: run `npm exec -- playwright install chromium`.
- `ECONNREFUSED 127.0.0.1:3000`: start the Docker demo first, or set `PLAYWRIGHT_BASE_URL` to a running deployment.
- `playwright is not recognized`: use `npm exec -- playwright ...`; a global CLI install is not required.
