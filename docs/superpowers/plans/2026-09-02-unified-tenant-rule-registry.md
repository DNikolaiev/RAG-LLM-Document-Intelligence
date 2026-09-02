# Unified Tenant Rule Registry Implementation Plan

**Goal:** Replace the split "Installed controls" and "Policy collections" cards with one rule registry per tenant, in which every active rule belongs to a policy collection and declares where it came from.

**Architecture:** A domain-pack rule gains an explicit `collectionId`, so built-in controls and policy-derived rules share one grouping key. The API returns a single `rules` array in which each entry carries a discriminated `origin`: a domain-pack rule names its pack and version, a policy-derived rule names its source policy document and policy version. The Policy Library renders one registry grouped by collection, badges each rule by origin, and links policy-derived rules to their source PDF.

**Tech Stack:** TypeScript, Zod, NestJS, Next.js 16, Vitest, Playwright.

**Source:** Design agreed with the user in the CaseLens Codex conversation of 2026-09-01/02.

## Global Constraints

- A rule's origin is authoritative data, never inferred in the browser.
- Do not weaken domain-pack strictness: a rule's `collectionId` must reference a declared collection.
- Policy-derived rules keep their exact-citation and approval gates unchanged.
- Preserve tenant scoping and administrator authorization on the domain-pack endpoint.
- Rules already activated must keep working; no database migration is in scope.
- Keep the registry usable at desktop and mobile widths with no horizontal overflow.

---

## Shared contract

Both tracks build against this exact response shape from `GET /v1/policies/domain-pack?tenantId=…`.
It **replaces** the current `baselineRules` and `policyRules` arrays.

```ts
type RuleOrigin =
  | { kind: 'domain_pack'; domainPackName: string; domainPackVersion: string }
  | { kind: 'policy_document'; policyId: string; policyTitle: string; policyVersion: string };

interface RegistryRule {
  id: string;
  title: string;
  description: string;
  severity: 'info' | 'minor' | 'major' | 'critical';
  collectionId: string;
  origin: RuleOrigin;
}

// domainPack.collections keeps { id, label } and gains no new fields.
// domainPack.rules: RegistryRule[]  <- new, replaces baselineRules + policyRules
```

Grouping key is `collectionId`. A domain-pack rule with no declared collection is assigned to the
synthetic collection `general-controls` labelled "General controls", which the API appends to
`collections` only when at least one rule lands in it.

---

### Track A — domain schema and API (owner: backend agent)

**Files owned:**

- `packages/domain/src/domain-pack/schema.ts`
- `packages/domain/src/pharmacy-supplier.ts`
- `packages/domain/test/domain.test.ts`
- `apps/api/src/policies/policies.service.ts`
- `apps/api/test/` (add coverage where a suite already exists)

**Step 1: Add an optional, validated `collectionId` to domain-pack rules**

Extend the rule object in `domainPackSchema` with `collectionId: z.string().min(1).optional()`.
Add a superRefine (or equivalent existing validation hook) rejecting a pack whose rule references a
`collectionId` absent from `policyCollections`. Add a failing test first that a pack with an unknown
rule `collectionId` fails `parseDomainPack`.

**Step 2: Assign every pharmacy baseline rule to a collection**

Use the existing `policyTags` as the guide, but write the assignment explicitly:

- `insurance-minimum` → `insurance`
- `legal-name-conflict` → `supplier-qualification`
- `iso-expired` → `supplier-qualification`
- `dpa-unsigned` → `data-protection`
- any remaining rule → the collection its tags already imply; if none applies, leave `collectionId`
  unset so it falls into `general-controls`.

The three `createReviewPack` packs in `domain-catalog.ts` declare `rules: []`, so they need no change.

**Step 3: Return one unified `rules` array from `domainPackConfiguration`**

Build `RegistryRule[]` from two sources and concatenate:

- `pack.rules` → `origin: { kind: 'domain_pack', domainPackName: pack.name, domainPackVersion: pack.version }`,
  `collectionId: rule.collectionId ?? 'general-controls'`.
- `activePolicyRules` → look up the policy in `activePolicies` by `rule.policyDocumentId` to get both
  `collectionId` and `title`; emit
  `origin: { kind: 'policy_document', policyId, policyTitle, policyVersion }`.
  Keep the existing behaviour of skipping a rule whose policy is not in the active list.

Append the `general-controls` collection to `collections` only if a rule uses it. Delete
`baselineRules` and `policyRules` from the response.

**Step 4: Test the service**

Assert that a domain-pack rule and a policy-derived rule both appear in `rules` with the correct
`origin.kind`, that a policy-derived rule carries its source policy title and version, and that
`general-controls` appears in `collections` only when populated.

**Do not touch** any file under `apps/web/`.

---

### Track B — Policy Library registry UI (owner: frontend agent)

**Files owned:**

- `apps/web/components/policy/policy-library.tsx`
- `apps/web/app/policies/policies.css`
- `apps/web/e2e/policy-library.spec.ts`

Build against the **Shared contract** above; treat it as already delivered. Update the local
`DomainPackConfiguration` interface to match it.

**Step 1: Collapse the Evidence gates section**

`Fact vocabulary` is already a `<details>` with no `open` attribute, so it is collapsed already.
Convert the Evidence gates `<article>` to a `<details>` using the same summary/toggle markup and
styling, so both sections start collapsed and the registry is what the page leads with.

**Step 2: Replace the two rule cards with one Rule registry**

Remove the "Installed controls" card and the "Policy collections" card. In their place render a
single "Rule registry" section listing every collection that has rules, each collection showing its
label, its rule count, and its rules.

**Step 3: Badge every rule by origin**

- `origin.kind === 'domain_pack'` → badge `SYSTEM DEFAULT`, source line naming the pack and version
  (e.g. "Pharmacy supplier qualification v1.0.0"). Not a link.
- `origin.kind === 'policy_document'` → badge `FROM POLICY REGISTER`, source line as a
  `next/link` to `/policies/{policyId}` showing the policy title and version.

The two badges must be visually distinct from each other and from the existing severity pill. Reuse
the existing `policy-*` token vocabulary; no decorative animation.

**Step 4: Keep the existing rule dialog working or remove it**

The dialog exists only to reveal rules that the registry now shows inline. Remove
`RuleDialogState`, the dialog element, and its handlers if the registry fully replaces it; otherwise
repoint it at the unified array. Do not leave dead state behind.

**Step 5: Extend browser coverage**

In `policy-library.spec.ts`, assert both origin badges are visible, that a policy-derived rule's
source link points at `/policies/`, and that Evidence gates and Fact vocabulary both start collapsed.

**Do not touch** any file under `packages/` or `apps/api/`.

---

### Integration (owner: orchestrator)

1. `npm run verify`
2. `npm run test:e2e -- policy-library.spec.ts policy-review.spec.ts` against the running demo stack
3. Review gate before commit.

## Self-Review

- The user's three asks map to: one registry (Track A step 3 + Track B step 2), origin badges with
  source references (Track A step 3 + Track B step 3), both sections collapsed (Track B step 1).
- Tracks share no files; the contract above is the only coupling.
