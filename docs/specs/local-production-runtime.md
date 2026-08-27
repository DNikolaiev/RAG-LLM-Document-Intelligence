# Local production runtime

## Decisions

- The first production target is a production-like Docker network running on one developer workstation. Public hosting, TLS, managed identity, backups, and internet hardening are deferred.
- Durable application data uses PostgreSQL 17 with pgvector. Work dispatch uses Redis/BullMQ. Immutable document bytes use MinIO through the existing S3-compatible provider port.
- AI runs locally without API charges through Ollama. The default structured-generation model is `qwen3:4b`; the default embedding model is `embeddinggemma:300m-qat-q4_0` with 768-dimensional vectors. Both names remain environment-configurable.
- OCR runs locally through an HTTP service backed by Tesseract. Native PDF text remains the first strategy; OCR is used only when native page text is insufficient.
- Authentication is not implemented in this phase. A catalog of fictional test profiles is held in application memory. The browser stores only the selected profile ID in an HTTP-only cookie, and the server maps it to a known profile.
- The profile switcher is always available in demo mode. In the production-like runtime it is available only with `ENABLE_TEST_IDENTITY_SWITCHER=true`.
- Tenant administrators are scoped to one tenant. A distinct `platform_admin` profile may read and mutate every tenant and receives an aggregated cross-tenant queue.
- Seed tenants demonstrate pharmaceutical supplier qualification, legal contract review, insurance claims, and manufacturing supplier quality.
- Existing local Docker volumes may be recreated while this runtime is established.

## Security boundary

The profile switcher is an impersonation mechanism for local evaluation, not authentication. `APP_MODE=production` must still reject startup unless either verified OIDC is configured or the explicit local test-identity flag is enabled. Public deployment is forbidden with the test switcher enabled.

PostgreSQL row-level security remains the second tenant boundary. Normal profiles set one transaction-local `app.tenant_id`. The platform administrator sets the transaction-local `app.platform_admin=true` flag only after the API resolves the selected profile from its trusted in-memory catalog.

## Acceptance criteria

- `docker compose` starts web, API, worker, PostgreSQL/pgvector, Redis, MinIO, bucket initialization, Ollama, model initialization, and OCR.
- API readiness checks real dependencies in the production-like runtime.
- Case reads and mutations survive API/container restart.
- Uploaded document bytes are present in MinIO and processing jobs are visible in PostgreSQL and BullMQ.
- The worker consumes BullMQ jobs and invokes the real LangGraph runner with local model/OCR/storage/search adapters.
- Switching profiles changes tenant, role, queue contents, and permitted actions without leaking another tenant’s cases.
- The platform administrator sees an aggregated board with tenant labels and can open every seeded case.
- Demo mode remains zero-credential and deterministic.
