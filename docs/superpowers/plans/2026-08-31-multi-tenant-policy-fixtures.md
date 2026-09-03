# Multi-tenant policy fixture pack

> **For the implementer:** Follow the steps in order. Keep all fixture content explicitly synthetic and route imports through the production-local application APIs rather than inserting database rows directly.

**Goal:** Give every demo tenant a credible evidence set and an importable policy document whose extracted rule proposals validate cleanly, then process the new documents through the same worker pipeline used by the application.

**Scope:**

- Preserve the existing seven-document pharmacy supplier dossier.
- Expand legal, insurance, and manufacturing from one primary document to four documents each.
- Create one reviewable policy PDF for each of those three domains.
- Use deterministic fixture policy responses only for the synthetic seed flow when a local free model cannot guarantee repeatable structured proposals.
- Keep policies, cases, files, and notifications tenant-isolated.
- Do not add production schema changes unless the existing model cannot represent the seed data.

**Synthetic packs:**

| Tenant / domain      | Companion evidence                                                         | Policy intent                                                             |
| -------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Commercial contracts | agreement, commercial-register extract, DPA, authority confirmation        | approvals must record authority, governing law, and commercial terms      |
| Property claims      | claim form, repair estimate, contractor report, settlement instruction     | claims must include traceable loss, coverage, and repair evidence         |
| Supplier quality     | material certificate, purchase specification, PMI inspection, release note | releases require material identity, traceability, and inspection evidence |

**Validation requirements for every proposed rule:**

1. Citation points to the source policy text.
2. Condition targets an actual fact path in its domain pack.
3. `match` proves the rule triggers when it should.
4. `no_match` proves it does not trigger for a compliant value.
5. `missing_value` proves incomplete evidence is detected.
6. `boundary` states the exact threshold or permitted value where the condition has one.

## Implementation steps

- [x] Inventory existing domain fact paths, seeded case IDs, worker jobs, and policy import contracts.
- [x] Specify three policy proposals using exact domain fact paths and four semantic test cases each.
- [x] Add a dedicated PDF fixture generator for the three policies and nine companion documents.
- [x] Generate the twelve PDFs, render representative pages, and inspect them for readable layout.
- [x] Extend the fixture manifest and case/document mapping so files are materialized through the normal store/MinIO path.
- [x] Add a repeatable production-local seed/import command that uploads the policy PDFs, waits for reviewable proposals, approves the valid proposals, and queues each tenant case.
- [ ] Run the command against the production-local Docker stack and verify policy status, documents, extracted facts, findings, and tenant-scoped notifications.
- [x] Add focused automated coverage for fixture policy acceptance.
- [x] Update README/architecture notes with the fixture pack and seed command.
- [x] Cover the twelve PDFs in `scripts/verify-fixtures.py` with page counts, required phrases, evidence-page anchors, Poppler renders, and two-generation SHA-256 stability.

## Test and verification plan

- Unit-test the policy fixture catalog and its rule-test contracts.
- Run type-checking and focused worker/API tests.
- Execute the seed command against the running production-local stack.
- Query the authenticated API for each tenant and platform administrator to prove data isolation and complete administrator visibility.
- Run the existing Playwright suite, including notification-scoping checks.
- Run `python scripts/verify-fixtures.py` so both fixture corpora are rendered and asserted together.
