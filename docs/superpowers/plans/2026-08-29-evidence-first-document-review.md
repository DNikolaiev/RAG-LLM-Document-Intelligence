# Evidence-First Document Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven development or execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the synthetic document representation with the authorized original PDF and make every supported fact/finding navigate to visible source and policy evidence.

**Architecture:** The API streams tenant-authorized source bytes; a dynamically loaded PDF.js client renders pages and text layers. One URL-addressable evidence selection coordinates the dossier, document page, highlight overlay, and review panel.

**Tech Stack:** Next.js 16, React 19, PDF.js, NestJS, MinIO/S3 provider, Zod, Vitest, Playwright.

**Spec:** `docs/specs/policy-evidence-and-job-feedback.md`

## Global Constraints

- The original document is primary and extracted text is secondary.
- Do not expose permanent storage credentials or cross-tenant source URLs.
- Evidence navigation must be deep-linkable, keyboard accessible, mobile usable, and explicit when approximate.
- Load the heavy PDF renderer dynamically and only when a real document is selected.

---

### Task 1: Authorized document source endpoint

**Files:**

- Modify: `apps/api/src/cases.controller.ts`
- Modify: `apps/api/src/production-cases.service.ts`
- Modify: `apps/api/src/cases.service.ts`
- Modify: `apps/web/app/api/cases/[...segments]/route.ts`
- Test: `apps/api/test/api.e2e.test.ts`

- [ ] Write tests for tenant access, platform access, missing source, inline headers, range requests, and cross-tenant denial.
- [ ] Implement server-side storage-key resolution and byte streaming through `ObjectStorageProvider`.
- [ ] Preserve demo fixture delivery without weakening production authorization.
- [ ] Run API tests and commit.

### Task 2: Evidence geometry and API projection

**Files:**

- Modify: `packages/contracts/src/core.ts`
- Modify: `packages/workflow/src/state.ts`
- Modify: `apps/worker/src/production-runtime.ts`
- Modify: `apps/web/lib/demo-data.ts`
- Test: `apps/worker/test/production-runtime.test.ts`
- Test: `apps/web/test/demo-data.test.ts`

- [ ] Write tests for multiple normalized boxes, page/quote fallback, OCR/native source, corrected evidence, and cross-document findings.
- [ ] Preserve page geometry from native extraction and OCR when available.
- [ ] Return stable document IDs instead of compacting identifiers in the client projection.
- [ ] Mark quote-only anchors as approximate.
- [ ] Run focused tests and commit.

### Task 3: Original PDF viewer

**Files:**

- Replace: `apps/web/components/document-surface.tsx`
- Modify: `apps/web/components/document-surface-loader.tsx`
- Create: `apps/web/components/pdf-document-viewer.tsx`
- Create: `apps/web/components/evidence-highlight-layer.tsx`
- Modify: `apps/web/app/workspace.css`
- Test: `apps/web/test/document-surface.test.tsx`

- [ ] Write tests for loading, page controls, zoom, search, rotation, corrupt source, missing source, exact boxes, and approximate quotes.
- [ ] Install and review the smallest maintained PDF.js integration compatible with React 19 and Next.js 16.
- [ ] Dynamically import the viewer and configure its worker without broad server traces.
- [ ] Render original/text modes, stable toolbar controls, evidence highlight, and accessible fallback messages.
- [ ] Run component tests and commit.

### Task 4: Coordinated evidence navigation

**Files:**

- Modify: `apps/web/app/cases/[caseId]/page.tsx`
- Modify: `apps/web/components/dossier-nav.tsx`
- Modify: `apps/web/components/review-panel.tsx`
- Create: `apps/web/components/evidence-workspace.tsx`
- Modify: `apps/web/app/evidence.css`
- Test: `apps/web/test/review-panel.test.tsx`
- Test: `apps/web/e2e/case-workspace.spec.ts`

- [ ] Write browser tests showing that fact and finding actions select the correct document/page/evidence URL and browser history restores prior selection.
- [ ] Replace fragment-only links with one selected-evidence state reflected in query parameters.
- [ ] Add source-fact and policy-clause actions, evidence Previous/Next, and clear selected/focus styles.
- [ ] Keep correction as an explicit secondary action.
- [ ] Verify responsive tabs, keyboard order, reduced motion, 200% zoom, and no overflow.
- [ ] Run component/Playwright tests and commit.
