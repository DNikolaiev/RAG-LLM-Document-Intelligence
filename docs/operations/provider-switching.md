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
