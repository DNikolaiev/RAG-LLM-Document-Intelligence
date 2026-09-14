# Security and privacy operations

## Trust boundaries

Uploads, extracted text, OCR output, retrieved policy passages, and model responses are untrusted. Intake validates binary signatures separately from file extensions, enforces size/page limits, rejects encryption when no password workflow is authorized, and quarantines scanner failures. Derived artifacts use immutable object keys and SHA-256 provenance.

Document content is delimited as evidence in prompts. It cannot redefine system instructions, select tools, or change a domain pack. Model output must satisfy a versioned schema and include evidence for material facts. Policy thresholds and final decision gates remain deterministic. Final decisions require an approver.

Policy PDFs have the same untrusted status. Generated proposals are restricted to an allowlisted condition DSL and installed fact paths, require exact page quotations, and must pass match, no-match, missing-value, and boundary fixtures. They are stored as proposals, never activated by the model. Local test-profile mode may permit proposer self-approval so the portfolio stack is testable; the review reason records that exception, and public deployments must disable the identity switcher.

A policy's collection can be suggested by a model reading that policy, which makes the document an input to its own filing. The worker contains that: the model chooses only among the tenant's existing collections, its supporting quotation must be found in the document, the document is quoted as data with its enclosing tag stripped from its text, and only a confident match files without an administrator. A model cannot create a collection. What remains is a document written to steer the model into the wrong existing collection; the uploader is notified where every classified policy was filed.

## Tenant isolation and authorization

Every application command carries tenant, user, role, and correlation context. The service layer checks role invariants. PostgreSQL enables and forces RLS on tenant tables, with indexed tenant columns and least-privilege runtime/auditor roles. Production deployments must use a non-owner, non-superuser runtime account and set `app.tenant_id` on every checked-out transaction.

Queue notifications have a narrower boundary than tenant data: normal users may select only jobs/events whose enqueueing or recipient user ID matches `app.user_id`, including when two users share a tenant. Worker writes use a separately asserted system-actor transaction context. The browser receives no Redis password and no direct queue access.

## Identity and sessions

Under `AUTH_MODE=oidc` identity comes only from a verified bearer token. The API and the analytics service never read `x-test-profile-id`, `x-user-id`, `x-role` or `x-tenant-id` in that mode, and configuration refuses to run the test switcher alongside it. The `x-caselens-tenant` header can narrow a request to one of the tenants the token grants, never widen it.

- **Sign-in** is the authorisation code flow with PKCE (S256), `state` and `nonce`, by a confidential client. The realm disables the implicit flow, the password grant and service accounts for the console, allows exactly one redirect URI, blocks self-registration and slows password guessing.
- **Sessions** are encrypted `httpOnly`, `SameSite=Lax` cookies keyed from `SESSION_SECRET` (at least 32 characters; load it from the secret manager) and bound to their purpose. A fresh session is minted at every sign-in, so a planted cookie cannot be upgraded. `returnTo` is reduced to a same-site path, checked again after URL normalisation, and the callback refuses any destination off the configured origin.
- **Sign-out** ends the identity provider's session as well as ours, is POST-only and refuses cross-origin requests.
- **Tokens** are verified with the algorithm pinned to RS256 and issuer, audience and lifetime checked; each service requires its own audience. Health probes are the only unauthenticated API routes.
- **Production requirements**: TLS on every hop to the identity provider (the ID token is accepted over the direct channel to the token endpoint rather than by signature), Keycloak in `start` mode on its own database, `COOKIE_SECURE=true`, a rotated client secret, and alerting on repeated 401 and 403 responses.
- **Revocation** takes up to one access-token lifetime (five minutes) plus the API's five-minute subject cache. Treat that as the window when disabling an account.

## Data minimization

Domain packs identify PII fields and outbound redaction rules. External provider calls receive only required pages/chunks. Logs contain IDs and metrics, not document bodies, raw prompts, secrets, or extracted PII. Provider retention and training settings must be reviewed before activation.

## Secrets and encryption

Keep credentials in the deployment secret manager, rotate them, and never use `.env.example` values outside local development. Use TLS for every network boundary, server-side encryption for object storage, encrypted database disks/backups, and key-separation between environments.

## Retention and deletion

Define domain-specific retention for binaries, derived text, audit events, and exports. A deletion workflow first legal-hold checks the case, records an authorized tombstone, deletes mutable/derived artifacts, and uses provider deletion APIs. Immutable audit records retain only the minimum required provenance.

## Incident response

Alert on repeated authorization failures, cross-tenant policy denials, infected uploads, provider data-exfiltration indicators, unusual export volume, queue retry storms, and model schema-failure spikes. Preserve correlation IDs, disable the affected provider, rotate credentials, quarantine impacted cases, and reprocess from the last trusted checkpoint after remediation.
