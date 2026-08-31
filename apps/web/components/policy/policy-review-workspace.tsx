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
      expected: boolean;
      actual: boolean | null;
      passed: boolean | null;
    }>;
  }>;
}

export function PolicyReviewWorkspace({ policyId }: { policyId: string }) {
  const [policy, setPolicy] = useState<PolicyDetail | null>(null);
  const [message, setMessage] = useState('');
  const [page, setPage] = useState(1);
  const [selectedCitationId, setSelectedCitationId] = useState<string>();
  const load = useCallback(async () => {
    const response = await fetch(`/api/policies/${policyId}`, { cache: 'no-store' });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message ?? 'Policy could not be loaded.');
    setPolicy(body);
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
  async function review(proposalId: string, version: number, decision: 'approve' | 'reject') {
    const reason = window.prompt(
      decision === 'approve'
        ? 'Record why this validated rule should be approved'
        : 'Record why this rule should be dismissed',
    );
    if (!reason || reason.trim().length < 8) return;
    const response = await fetch(`/api/policies/${policyId}/proposals/${proposalId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision, reason, version }),
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
                  <summary>Structured condition</summary>
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
                      onClick={() => void review(proposal.id, proposal.version, 'approve')}
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
