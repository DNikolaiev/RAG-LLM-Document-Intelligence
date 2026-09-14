# Policy Collection Classification

**Goal:** Stop asking an administrator to know, before uploading, which collection a policy belongs to. CaseLens reads the document, files it into an existing collection when it clearly belongs there, and proposes a new collection when none fits - telling the administrator either way, and waiting for them when a decision is theirs to make.

**Decisions (user, 2026-09-14):**

- Both classification and manual choice. The model suggests; the administrator decides. Manual choice at upload remains and overrides classification.
- Both real starting collections for every tenant and classification that can propose new ones over time.
- Whenever an administrator has to act, they are notified.

## Where collections come from today

- **Hard-coded starting lists.** `packages/domain/src/pharmacy-supplier.ts:209` defines four real collections for the pharmaceutical pack. The other three packs are built by a template in `packages/domain/src/domain-catalog.ts:43` that emits one placeholder each - `commercial-contract-review-policy`, `insurance-claims-assessment-policy`, `supplier-quality-assurance-policy` - which are not categories, only a name derived from the pack id.
- **Manual creation.** The upload form lets an administrator name a new collection; `resolveUploadCollection` → `createPolicyCollection` (`apps/api/src/policies/policies.service.ts:495`) slugifies it and mints a new pack version.
- **No classification.** The worker takes the collection it is given and uses it for one thing, chunk size and overlap (`apps/worker/src/production-runtime.ts:838-872`).

## Defects found while reading

1. **The worker cannot see an administrator-created collection.** It resolves the pack through `resolvePersistedDomainPack`, an in-memory map of compiled packs (`packages/domain/src/domain-catalog.ts:147`), not the tenant's active definition in `domain_packs`. A collection minted at upload exists only there, so processing a policy uploaded into one should fail with `No policy collection exists`. Not yet observed - every tenant is still on its seeded 1.0.0 - so it is proven with a failing test before it is fixed.
2. **Case extraction ignores approved fields.** The case path builds its pack from the compiled catalog too (`installedPack = resolvePersistedDomainPack(item.domainPackId)` in `processJob`), merging in active policy _rules_ from the database but not the pack's extraction _vocabulary_. A field an administrator approves therefore exists in the tenant's pack and is never extracted from a case document, and a rule written against it sees the fact as permanently missing. Cases pin a pack version for provenance, so the fix must load the definition of the version the case was pinned to, not simply the active one.
3. **Seeding cannot upgrade a pack.** `PostgresCaseStore.seed` upserts each tenant's pack under the fixed id `pack_${tenant.id}` at the compiled version. Changing a compiled pack without bumping its version rewrites 1.0.0 in place - an unversioned edit of governed configuration - and bumping it collides on that fixed primary key. New starting collections need a real upgrade path.

## Design

### Classification is a proposal, like every other model output here

The pattern already exists twice: rule proposals and field proposals. A model reads an untrusted PDF and proposes; deterministic checks constrain the proposal; a person approves anything that changes governed configuration. Collections follow it.

After text extraction, before chunking, the worker asks the model to classify the document against the tenant's existing collections. The answer is schema-validated and takes one of two shapes:

- `{ decision: 'existing', collectionId, confidence, evidence }` - `collectionId` must be one of the tenant's collection ids (a closed vocabulary, like fact extraction), and `evidence` must be a verbatim quotation found in the document.
- `{ decision: 'new', label, rationale, evidence }` - a proposed collection name, checked for near-duplicates against existing collection labels with the same embedding-then-model judgement the field dictionary uses.

Collections gain an optional one-line `description`, because a label like "Insurance Requirements" alone is a weak signal to classify against.

### Who decides what

| Situation                                                                   | Outcome                                                                              | Administrator is told                                  |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| The administrator chose a collection at upload                              | That collection; no classification                                                   | Nothing new                                            |
| Confident match to an existing collection, with a verified quotation        | Filed automatically; processing continues                                            | Where it went, and how to move it                      |
| Low confidence, a quotation that is not in the document, or no match at all | Processing pauses                                                                    | **Action required**: choose or create                  |
| A new collection is proposed                                                | Processing pauses; the name is a suggestion, and nothing is minted until they accept | **Action required**: accept, rename, or choose another |

Automatic filing is limited to collections that already exist. Letting a model create collections unattended would make a policy document able to name its own category - a prompt-injection surface - and would grow near-duplicate collections under slightly different names.

A pause is safe for chunking: chunk size stays a property of the collection, and nothing is chunked until the collection is settled.

### Notifications

The durable job-event feed already scopes notifications to the person who enqueued the work, who for a policy upload is by definition an administrator of that tenant. Two new event types join it: `policy.collection_assigned` (informational) and `policy.collection_decision_required` (action). The job moves to the existing `paused` state for the second. The notification centre renders action-required events distinctly, with a link straight to the decision, and they stay at the top until resolved.

Notifying every administrator of the tenant, not only the uploader, is a later extension: it needs the membership table consulted per event.

### State

- `policy_documents.collection_id` becomes nullable - a policy awaiting classification genuinely has no collection yet - and a new status `awaiting_collection` joins its status set.
- The classification result is stored with the policy (`collection_suggestion`, jsonb): decision, collection or proposed label, confidence, quotation, model and version.
- Deciding is `POST /v1/policies/:id/collection` with exactly one of `collectionId` or `newCollectionLabel`, administrator-only, idempotent. It mints the collection if new, records the decision in the audit trail, and re-enqueues processing from chunking.

## Steps, in order

0. **Policy processing reads the tenant's active pack.** Done: `apps/worker/src/policy/policy-pack.ts` resolves the active definition for the collection lookup and for rule proposals, falling back to the compiled catalog only for a tenant that never minted a version. Its tests fail against the old compiled-only resolution.
   0b. **Case processing reads the pinned pack version**, so approved fields are extracted (defect 2). Done: `resolvePinnedCasePack` loads the exact version through `getPackDefinitionVersion` (same `domain_key` lineage as the active read), the worker's queue payload now declares the `domainPackVersion` a reprocess was already sending and silently dropping, and intake pins the tenant's active version instead of the literal `'1.0.0'`. A missing pinned version is an error, never a substitution; the compiled pack is used only when it _is_ the pinned version. Tests in `apps/worker/test/policy-pack.test.ts` and `apps/api/test/cases-intake.endpoint.test.ts` fail against the old behaviour.

   Found while doing it, left alone deliberately: retrieval scopes policy chunks by `pack_version`, and both sides of that comparison read the semantic version of the lineage's _root_ row (`pack_<tenant>`, always 1.0.0) - chunks through `policy_documents.domain_pack_id`, the case's query through `getDomainPackDescriptor`. It is consistent, so retrieval works, but the value is a lineage label rather than the governed version. Switching only the query side to the pinned version would silently return no policy evidence after the first minted version. Worth fixing on both sides together, or renaming, when step 1 changes how versions are minted.

1. **A pack upgrade path.** Compiled packs carry a version; the seed mints a new active version through `savePackVersion` when the compiled version is newer and the tenant has not diverged, and leaves a tenant that has minted its own versions alone.
2. **Real starting collections** for the legal, insurance and manufacturing packs, keeping each placeholder id so existing policies stay valid, with descriptions. Released as 1.1.0 through step 1.
3. **Contract and schema.** Collection optional at upload; nullable `collection_id`, `awaiting_collection`, `collection_suggestion`; migration with tenant RLS unchanged.
4. **Classification in the worker**, with a deterministic provider for demo and tests, the quotation check, the near-duplicate check, and the decision table above.
5. **Notifications**: the two event types, the paused job, and action-required rendering with a link.
6. **The decision endpoint** and resumption.
7. **Console**: "Let CaseLens classify" as the upload default, and the decision panel on the policy page showing the suggestion, its quotation, and accept / choose / create.
8. **Evaluation**: every policy-lab fixture classifies to its expected collection under the deterministic provider; a separate script runs the same set against the local model and reports agreement, without gating CI on a non-deterministic model.
9. **Documentation**: README, ARCHITECTURE, the product spec, and the security guide's untrusted-input section.

## Rejected

- **Fully automatic, including new collections.** Rejected for the injection and sprawl reasons above.
- **Manual only.** The current behaviour, and the reason for this work.
- **Classifying at upload, synchronously.** It needs text extraction and OCR first, which is the worker's job; a request handler that waited for it would move long-running processing into the API, which the architecture forbids.
