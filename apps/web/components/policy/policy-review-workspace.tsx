'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  CircleDashed,
  ExternalLink,
  FlaskConical,
  Quote,
  ShieldAlert,
  XCircle,
} from 'lucide-react';

import { DocumentSurfaceLoader } from '@/components/document-surface-loader';
import type { CaseDocument, EvidenceAnchor } from '@/lib/demo-data';

interface ValidationIssue {
  code: string;
  path: string;
  message: string;
}

interface PolicyDetail {
  id: string;
  title: string;
  policyVersion: string;
  status: string;
  version: number;
  originalName: string;
  pageCount: number | null;
  extractionMetadata: Record<string, unknown>;
  proposals: Array<{
    id: string;
    title: string;
    description: string;
    severity: string;
    status: string;
    version: number;
    reviewedByUserId: string | null;
    reviewReason: string | null;
    condition: unknown;
    validationIssues: ValidationIssue[];
    citations: Array<{ id: string; page: number; quote: string }>;
    tests: Array<{
      id: string;
      kind: string;
      name: string;
      input: Record<string, unknown>;
      expected: boolean;
      actual: boolean | null;
      passed: boolean | null;
    }>;
  }>;
}

export function PolicyReviewWorkspace({ policyId }: { policyId: string }) {
  const [policy, setPolicy] = useState<PolicyDetail | null>(null);
  const [message, setMessage] = useState('');
  const [regenerating, setRegenerating] = useState(false);
  const [severityEdits, setSeverityEdits] = useState<Record<string, string>>({});
  const [page, setPage] = useState(1);
  const [selectedCitationId, setSelectedCitationId] = useState<string>();
  const load = useCallback(async () => {
    const response = await fetch(`/api/policies/${policyId}`, { cache: 'no-store' });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message ?? 'Policy could not be loaded.');
    setPolicy(body);
    setSeverityEdits({});
  }, [policyId]);
  useEffect(() => {
    const timer = setTimeout(() => {
      void load().catch((error: Error) => setMessage(error.message));
    }, 0);
    return () => clearTimeout(timer);
  }, [load]);
  const citations = useMemo(
    () =>
      (policy?.proposals ?? []).flatMap((proposal) =>
        proposal.citations.map((citation) => ({ ...citation, proposalTitle: proposal.title })),
      ),
    [policy?.proposals],
  );
  const evidence = useMemo<EvidenceAnchor[]>(
    () =>
      citations.map((citation, index) => ({
        id: citation.id,
        index: index + 1,
        documentId: policyId,
        page: citation.page,
        label: citation.proposalTitle,
        excerpt: citation.quote,
        severity: 'major',
      })),
    [citations, policyId],
  );
  const selectedEvidence = evidence.find((item) => item.id === selectedCitationId);
  const sourceDocument = useMemo<CaseDocument | null>(
    () =>
      policy
        ? {
            id: policy.id,
            label: policy.title,
            fileName: policy.originalName,
            state: 'verified',
            pages: policy.pageCount ?? Math.max(1, ...citations.map((item) => item.page)),
            kind: 'Policy source',
            sourceUrl: `/api/policies/${policy.id}/content`,
          }
        : null,
    [citations, policy],
  );
  async function review(
    proposalId: string,
    version: number,
    decision: 'approve' | 'reject',
    severity?: string,
  ) {
    const reason = window.prompt(
      decision === 'approve'
        ? 'Record why this validated rule should be approved'
        : 'Record why this rule should be dismissed',
    );
    if (!reason || reason.trim().length < 8) return;
    const response = await fetch(`/api/policies/${policyId}/proposals/${proposalId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision, reason, version, ...(severity ? { severity } : {}) }),
    });
    const body = await response.json().catch(() => ({}));
    setMessage(
      response.ok
        ? `Proposal ${decision === 'approve' ? 'approved' : 'rejected'}.`
        : (body.message ?? 'Review failed.'),
    );
    if (response.ok) await load();
  }
  async function activate() {
    if (!policy) return;
    const response = await fetch(`/api/policies/${policyId}/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: policy.version, priority: 0 }),
    });
    const body = await response.json().catch(() => ({}));
    setMessage(
      response.ok ? 'Policy and approved rules activated.' : (body.message ?? 'Activation failed.'),
    );
    if (response.ok) await load();
  }
  async function reprocess() {
    if (!policy || regenerating) return;
    setRegenerating(true);
    const response = await fetch(`/api/policies/${policyId}/reprocess`, {
      method: 'POST',
      headers: { 'idempotency-key': `regenerate-${policyId}-${policy.version}` },
    });
    const body = await response.json().catch(() => ({}));
    setMessage(
      response.ok
        ? 'Policy regeneration is queued. The refreshed rules will replace the blocked proposals.'
        : (body.message ?? 'Policy regeneration could not be queued.'),
    );
    if (response.ok) await load();
    setRegenerating(false);
  }
  if (!policy || !sourceDocument)
    return (
      <main id="main-content" className="policy-shell">
        <p className="policy-empty">{message || 'Loading policy evidence…'}</p>
      </main>
    );
  return (
    <main id="main-content" className="policy-shell policy-review">
      <div className="policy-review-heading">
        <Link href="/policies">
          <ArrowLeft size={16} /> Policy register
        </Link>
        <div>
          <span className={`policy-status policy-status-${policy.status}`}>
            {policy.status.replaceAll('_', ' ')}
          </span>
          <h1>{policy.title}</h1>
          <p>
            Version {policy.policyVersion} · {policy.originalName}
          </p>
        </div>
        <a
          className="policy-secondary"
          href={`/api/policies/${policy.id}/content`}
          target="_blank"
          rel="noreferrer"
        >
          Open original PDF <ExternalLink size={15} />
        </a>
      </div>
      <div className="policy-review-grid">
        <section className="policy-source" aria-label="Original policy document">
          <DocumentSurfaceLoader
            document={sourceDocument}
            evidence={evidence}
            onPageChange={setPage}
            page={page}
            selectedEvidence={selectedEvidence}
          />
        </section>
        <aside className="policy-proposals">
          <header>
            <div>
              <h2>All generated rules</h2>
              <p>
                Green means actual matched expected. Red means that specific expectation failed — it
                does not mean the test category itself is bad.
              </p>
            </div>
            <dl className="proposal-summary" aria-label="Rule proposal summary">
              <div>
                <dt>All</dt>
                <dd>{policy.proposals.length}</dd>
              </div>
              <div>
                <dt>Ready</dt>
                <dd>
                  {
                    policy.proposals.filter(
                      (proposal) =>
                        !proposal.validationIssues.length &&
                        ['proposed', 'under_review'].includes(proposal.status),
                    ).length
                  }
                </dd>
              </div>
              <div>
                <dt>Blocked</dt>
                <dd>
                  {policy.proposals.filter((proposal) => proposal.status === 'invalid').length}
                </dd>
              </div>
            </dl>
          </header>
          {canRegenerate(policy) ? (
            <div className="policy-regenerate">
              <div>
                <strong>Repair this policy</strong>
                <span>Regenerate deterministic rule proposals from the original evidence.</span>
              </div>
              <button
                className="policy-secondary"
                type="button"
                disabled={regenerating}
                onClick={() => void reprocess()}
              >
                {regenerating ? 'Queuing regeneration…' : 'Regenerate rules'}
              </button>
            </div>
          ) : null}
          {policy.proposals.length ? (
            policy.proposals.map((proposal) => (
              <article className="proposal-card" key={proposal.id}>
                <div className="proposal-title">
                  <span className={`severity-${proposal.severity}`}>{proposal.severity}</span>
                  <div>
                    <div className="proposal-title-line">
                      <h3>{proposal.title}</h3>
                      <span className={`policy-status policy-status-${proposal.status}`}>
                        {proposal.status.replaceAll('_', ' ')}
                      </span>
                    </div>
                    <p>{proposal.description}</p>
                  </div>
                </div>
                {['proposed', 'under_review'].includes(proposal.status) ? (
                  <label className="proposal-severity-control">
                    Finding severity
                    <select
                      aria-label={`Finding severity for ${proposal.title}`}
                      value={severityEdits[proposal.id] ?? proposal.severity}
                      onChange={(event) =>
                        setSeverityEdits((current) => ({
                          ...current,
                          [proposal.id]: event.target.value,
                        }))
                      }
                    >
                      <option value="info">Info</option>
                      <option value="minor">Minor</option>
                      <option value="major">Major</option>
                      <option value="critical">Critical</option>
                    </select>
                    <small>Saved with the approval record and used for future findings.</small>
                  </label>
                ) : null}
                {proposal.validationIssues.length ? (
                  <section className="proposal-validation" aria-label="Approval blockers">
                    <h4>
                      <ShieldAlert size={15} /> Why approval is blocked
                    </h4>
                    <ul>
                      {proposal.validationIssues.map((issue, index) => (
                        <li key={`${issue.code}-${issue.path}-${index}`}>
                          <strong>{humanize(issue.code)}</strong>
                          <span>{issue.message}</span>
                          <code>{issue.path}</code>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : (
                  <p className="proposal-ready">
                    <CheckCircle2 size={15} /> Validation complete — this rule can be approved.
                  </p>
                )}
                {proposal.reviewReason ? (
                  <p className="proposal-review-reason">
                    <strong>Review record</strong>
                    {proposal.reviewedByUserId ? ` · ${proposal.reviewedByUserId}` : ''}
                    <span>{proposal.reviewReason}</span>
                  </p>
                ) : null}
                <details>
                  <summary>Rule logic</summary>
                  <p className="proposal-rule-meaning">{describeCondition(proposal.condition)}</p>
                  <pre>{JSON.stringify(proposal.condition, null, 2)}</pre>
                </details>
                <div className="proposal-evidence">
                  <h4>
                    <Quote size={14} /> Source evidence
                  </h4>
                  {proposal.citations.length ? (
                    proposal.citations.map((citation) => (
                      <button
                        aria-current={selectedCitationId === citation.id ? 'location' : undefined}
                        className="citation-button"
                        key={citation.id}
                        onClick={() => {
                          setSelectedCitationId(citation.id);
                          setPage(citation.page);
                        }}
                        type="button"
                      >
                        <span>“{citation.quote}”</span>
                        <small>Show highlighted clause · page {citation.page}</small>
                      </button>
                    ))
                  ) : (
                    <p className="proposal-missing">No exact source citation was generated.</p>
                  )}
                </div>
                <div className="proposal-tests">
                  <h4>
                    <FlaskConical size={14} /> Rule tests
                  </h4>
                  {proposal.tests.map((test) => (
                    <div
                      key={test.id}
                      className={
                        test.passed === true
                          ? 'test-result test-pass'
                          : test.passed === false
                            ? 'test-result test-fail'
                            : 'test-result test-pending'
                      }
                    >
                      {test.passed === true ? (
                        <CheckCircle2 aria-hidden="true" size={15} />
                      ) : test.passed === false ? (
                        <XCircle aria-hidden="true" size={15} />
                      ) : (
                        <CircleDashed aria-hidden="true" size={15} />
                      )}
                      <span>
                        <strong>
                          {humanize(test.kind)} · {test.name}
                        </strong>
                        <small>Test value: {formatTestInput(test.input)}</small>
                        <small>{testMeaning(test)}</small>
                      </span>
                    </div>
                  ))}
                </div>
                {['proposed', 'under_review'].includes(proposal.status) &&
                !proposal.validationIssues.length ? (
                  <div className="proposal-actions">
                    <button
                      onClick={() => void review(proposal.id, proposal.version, 'reject')}
                      className="policy-secondary"
                    >
                      Reject
                    </button>
                    <button
                      onClick={() =>
                        void review(
                          proposal.id,
                          proposal.version,
                          'approve',
                          severityEdits[proposal.id] ?? proposal.severity,
                        )
                      }
                      className="policy-primary"
                    >
                      Approve proposal
                    </button>
                  </div>
                ) : proposal.status === 'invalid' ? (
                  <div className="proposal-actions">
                    <button
                      onClick={() => void review(proposal.id, proposal.version, 'reject')}
                      className="policy-secondary policy-danger"
                    >
                      Dismiss blocked rule
                    </button>
                  </div>
                ) : null}
              </article>
            ))
          ) : (
            <p className="policy-empty">Processing has not produced rule proposals yet.</p>
          )}
          {policy.status === 'approved' ? (
            <button className="policy-primary policy-activate" onClick={() => void activate()}>
              Activate policy and approved rules
            </button>
          ) : null}
          {message ? (
            <p className="policy-message" role="status">
              {message}
            </p>
          ) : null}
        </aside>
      </div>
    </main>
  );
}

function humanize(value: string): string {
  return value.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase());
}

function testMeaning(test: PolicyDetail['proposals'][number]['tests'][number]): string {
  if (test.actual === null) {
    return `Not run — expected the rule to ${test.expected ? 'trigger' : 'not trigger'}.`;
  }
  const expected = test.expected ? 'trigger' : 'not trigger';
  const actual = test.actual ? 'triggered' : 'did not trigger';
  return `${test.passed ? 'Passed' : 'Failed'} — expected the rule to ${expected}; it ${actual}.`;
}

function canRegenerate(policy: PolicyDetail): boolean {
  return (
    ['under_review', 'failed'].includes(policy.status) &&
    policy.proposals.some((proposal) => proposal.status === 'invalid') &&
    !policy.proposals.some((proposal) => ['approved', 'activated'].includes(proposal.status))
  );
}

function describeCondition(value: unknown): string {
  const predicates = collectConditionPredicates(value);
  const numeric = predicates.find(
    (predicate) => predicate.operator === 'lte' && typeof predicate.value === 'number',
  );
  if (numeric && typeof numeric.value === 'number') {
    return `Flag when ${humanizePath(numeric.path)} is below ${formatAmount(numeric.value + 0.01)}.`;
  }
  const exists = predicates.find((predicate) => predicate.operator === 'exists');
  return exists
    ? `Flag when ${humanizePath(exists.path)} is ${exists.value === false ? 'missing' : 'available'}.`
    : 'This proposal uses the structured condition shown below.';
}

function formatTestInput(input: Record<string, unknown>): string {
  const value = firstLeafValue(input);
  if (value === undefined) return 'No value supplied';
  return typeof value === 'number' ? formatAmount(value) : String(value);
}

function collectConditionPredicates(
  value: unknown,
): Array<{ operator: string; path: string; value?: unknown }> {
  if (!value || typeof value !== 'object') return [];
  const condition = value as Record<string, unknown>;
  if (Array.isArray(condition.conditions)) {
    return condition.conditions.flatMap((item) => collectConditionPredicates(item));
  }
  if (condition.condition) return collectConditionPredicates(condition.condition);
  return typeof condition.operator === 'string' && typeof condition.path === 'string'
    ? [{ operator: condition.operator, path: condition.path, value: condition.value }]
    : [];
}

function firstLeafValue(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  for (const child of Object.values(value as Record<string, unknown>)) {
    const leaf = firstLeafValue(child);
    if (leaf !== undefined) return leaf;
  }
  return undefined;
}

function humanizePath(path: string): string {
  return path
    .replace(/^facts\./, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replaceAll('.', ' ')
    .replace(/\s*Eur$/i, ' EUR');
}

function formatAmount(value: number): string {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 2,
  }).format(value);
}
