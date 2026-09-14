# Provider and model switching

CaseLens treats infrastructure choices as runtime configuration. Application and domain packages import only provider ports; an adapter registry validates capabilities during startup. A domain pack never names a vendor.

## Zero-credential demo

Use the defaults from `.env.example`: deterministic model/OCR/embedding/scanner providers plus memory persistence, storage, search, and queue. The same fixture always produces the same extracted facts and recommendation, which makes the portfolio demo and regression tests reproducible.

## External model

Set `MODEL_PROVIDER=openai-compatible` or `MODEL_PROVIDER=anthropic-compatible`, then provide `MODEL_BASE_URL`, `MODEL_API_KEY`, and `MODEL_NAME`. OpenAI-compatible means the adapter expects schema-constrained chat completions and embedding routes; it does not require one specific cloud. Use a gateway URL to route to OpenAI, Azure-hosted models, local vLLM, or another compatible service. The Anthropic-compatible adapter normalizes message blocks into the same structured-generation result.

Changing the extraction model requires an evaluation run before activation. Compare schema-valid rate, field precision/recall, evidence accuracy, abstention quality, latency, and cost against `fixtures/expected`. Pin the selected model and prompt version in every extraction run.

## OCR and storage

Set `OCR_PROVIDER=http` with `OCR_BASE_URL` for any service implementing the documented page OCR contract. Configure `STORAGE_PROVIDER=s3` for AWS S3, MinIO, or another S3-compatible service. Provider credentials remain deployment secrets and never enter a domain pack.

## Search, queue, and persistence

Use PostgreSQL/pgvector, BullMQ/Redis, and S3 in a production profile. The memory adapters are intentionally single-process and non-durable. To add another product, implement the relevant port and contract tests, register its key in the provider factory, extend the startup schema, and leave application services unchanged.

## Capability failure

Startup fails when a selected provider is missing a required URL, credential, or capability. Runtime failures are normalized into retryable, terminal, rate-limited, or invalid-output errors. The workflow applies bounded retries, preserves its checkpoint, and routes to human review rather than silently selecting a different model. Any configured fallback is explicit and recorded in provenance.

## Policy collection classifier

A policy uploaded without a collection is classified by the worker. `WORKER_COLLECTION_CLASSIFIER=model`, the default, asks the configured chat model; `lexical` scores each collection by the words its label and description share with the document, with no model at all - deterministic, for tests and model-free environments. Both answers pass the same checks: only an existing collection, a quotation found in the document, and confidence at or above `WORKER_COLLECTION_AUTO_FILE_CONFIDENCE` (default 0.8) file automatically. A model's answer also needs corroboration: the lexical matcher, run alongside it, must independently reach the same collection with a clear lead and at least two shared words. Measured on `qwen3:4b`, the model reports 0.95 confidence whether it is right or wrong, so its own number cannot be the gate. `WORKER_COLLECTION_NEAR_DUPLICATE_SIMILARITY` (default 0.8) is the embedding similarity above which a proposed new collection is flagged as close to an existing one. It only annotates the suggestion, because a new collection always waits for an administrator.

## Identity provider

Verified identity is standard OpenID Connect, so changing provider is configuration rather than code. The console needs `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` and its redirect URIs; the API and analytics need `OIDC_ISSUER`, `OIDC_AUDIENCE` and `OIDC_JWKS_URL`. The provider must issue RS256-signed access tokens carrying the service audiences, a `roles` claim (or `realm_access.roles`) with the CaseLens role names, and a `tenants` claim listing tenant ids. Set `OIDC_INTERNAL_ISSUER` only when the console reaches the provider at a different address from the one printed in its tokens. Every subject must exist as `users.external_subject`.
