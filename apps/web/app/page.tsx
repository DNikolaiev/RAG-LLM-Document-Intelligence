import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Activity,
  ArrowUpRight,
  CheckCircle2,
  CircleAlert,
  Clock3,
  FileSearch,
  Layers3,
  ListFilter,
  Search,
  ShieldAlert,
} from 'lucide-react';

import { StatusMark } from '@/components/status-mark';
import {
  countByStatus,
  filterCases,
  listCases,
  statusLabels,
  type CaseStatus,
} from '@/lib/demo-data';

export const metadata: Metadata = { title: 'Case queue' };

interface QueuePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const validStatuses = new Set<CaseStatus>([
  'review_needed',
  'processing',
  'ready_for_decision',
  'approved',
]);

const readinessStages = [
  { status: 'processing', label: 'Processing', icon: Clock3 },
  { status: 'review_needed', label: 'Review', icon: CircleAlert },
  { status: 'ready_for_decision', label: 'Ready', icon: Layers3 },
  { status: 'approved', label: 'Approved', icon: CheckCircle2 },
] as const;

export default async function QueuePage({ searchParams }: QueuePageProps) {
  const [allCases, params] = await Promise.all([listCases(), searchParams]);
  const rawStatus = typeof params.status === 'string' ? params.status : 'all';
  const status: CaseStatus | 'all' = validStatuses.has(rawStatus as CaseStatus)
    ? (rawStatus as CaseStatus)
    : 'all';
  const query = typeof params.query === 'string' ? params.query : '';
  const filteredCases = filterCases(allCases, query, status);
  const counts = countByStatus(allCases);
  const materialFindings = allCases.reduce((total, item) => total + item.openFindings, 0);
  const sourceDocuments = allCases.reduce((total, item) => total + item.documents, 0);
  const averageEvidence = allCases.length
    ? Math.round(allCases.reduce((total, item) => total + item.progress, 0) / allCases.length)
    : 0;
  const nextReview =
    allCases.find((item) => item.status === 'review_needed') ??
    allCases.find((item) => item.status === 'processing') ??
    allCases[0];
  const showTenant = new Set(allCases.map((item) => item.tenantId)).size > 1;

  return (
    <main id="main-content" className="queue-page">
      <section className="queue-intro" aria-labelledby="queue-title">
        <div className="queue-intro-copy">
          <p className="eyebrow">
            <span className="live-pulse" aria-hidden="true" />
            {showTenant ? 'Cross-tenant intelligence' : 'Tenant intelligence'} · Live workspace
          </p>
          <h1 id="queue-title">
            Every decision,
            <span>grounded in evidence.</span>
          </h1>
          <p className="intro-copy">
            Move from source document to defensible decision without losing the thread. Every
            exception stays linked to its exact evidence and policy.
          </p>
          <div className="intro-actions">
            <a className="button button-primary" href="#case-queue">
              Open review queue
              <ArrowUpRight aria-hidden="true" size={16} />
            </a>
            <span>
              <ShieldAlert aria-hidden="true" size={15} /> Human approval stays in control
            </span>
          </div>
        </div>
        <aside className="readiness-brief" aria-labelledby="readiness-title">
          <header className="readiness-header">
            <div>
              <p className="eyebrow">Queue intelligence</p>
              <h2 id="readiness-title">Decision readiness</h2>
            </div>
            <span className="readiness-live">
              <span aria-hidden="true" /> Live
            </span>
          </header>

          <div className="readiness-summary">
            <strong>{counts.review_needed}</strong>
            <div>
              <span>
                {counts.review_needed === 1 ? 'case needs' : 'cases need'} reviewer attention
              </span>
              <small>
                {sourceDocuments} source documents across {allCases.length} tracked cases
              </small>
            </div>
          </div>

          <nav className="readiness-route" aria-label="Filter cases by workflow stage">
            {readinessStages.map((stage) => {
              const StageIcon = stage.icon;
              const count = counts[stage.status];
              return (
                <Link
                  aria-label={`${stage.label}: ${count} ${count === 1 ? 'case' : 'cases'}`}
                  className={`readiness-stage readiness-${stage.status}`}
                  href={`/?status=${stage.status}#case-queue`}
                  key={stage.status}
                >
                  <span className="readiness-stage-icon" aria-hidden="true">
                    <StageIcon size={14} />
                  </span>
                  <strong>{count}</strong>
                  <span>{stage.label}</span>
                </Link>
              );
            })}
          </nav>

          {nextReview ? (
            <Link className="next-review-card" href={`/cases/${nextReview.id}`}>
              <span className="next-review-icon" aria-hidden="true">
                <ShieldAlert size={17} />
              </span>
              <span className="next-review-copy">
                <small>Next review</small>
                <strong>{nextReview.supplier}</strong>
                <span>
                  {nextReview.openFindings} material{' '}
                  {nextReview.openFindings === 1 ? 'finding' : 'findings'} · {nextReview.progress}%
                  evidence ready
                </span>
              </span>
              <ArrowUpRight aria-hidden="true" size={16} />
            </Link>
          ) : null}

          <footer className="readiness-coverage">
            <span>
              <span>Average evidence coverage</span>
              <strong>{averageEvidence}%</strong>
            </span>
            <progress value={averageEvidence} max="100">
              {averageEvidence}%
            </progress>
          </footer>
        </aside>
      </section>

      <section className="queue-ledger" aria-label="Case totals">
        <div>
          <Activity aria-hidden="true" size={18} />
          <span>
            <strong>{allCases.length}</strong>
            <small>Open cases</small>
          </span>
        </div>
        <div>
          <ShieldAlert aria-hidden="true" size={18} />
          <span>
            <strong>{counts.review_needed}</strong>
            <small>Need review</small>
          </span>
        </div>
        <div>
          <FileSearch aria-hidden="true" size={18} />
          <span>
            <strong>{sourceDocuments}</strong>
            <small>Sources indexed</small>
          </span>
        </div>
        <div>
          <Layers3 aria-hidden="true" size={18} />
          <span>
            <strong>{materialFindings}</strong>
            <small>Material findings</small>
          </span>
        </div>
      </section>

      <section className="queue-workbench" id="case-queue" aria-label="Case queue">
        <header className="workbench-heading">
          <div>
            <p className="eyebrow">Operational review</p>
            <h2>Case queue</h2>
          </div>
          <span className="workbench-signal">
            <span aria-hidden="true" /> {filteredCases.length} visible
          </span>
        </header>
        <form
          key={`${query}:${status}`}
          className="queue-tools"
          action="/"
          method="get"
          role="search"
        >
          <label className="search-field">
            <span>Find a subject or case</span>
            <span className="input-shell">
              <Search aria-hidden="true" size={16} />
              <input
                type="search"
                name="query"
                defaultValue={query}
                placeholder="Subject name or case reference"
              />
            </span>
          </label>
          <label className="select-field">
            <span>Status</span>
            <select name="status" defaultValue={status}>
              <option value="all">All statuses</option>
              {Array.from(validStatuses).map((value) => (
                <option key={value} value={value}>
                  {statusLabels[value]} · {counts[value]}
                </option>
              ))}
            </select>
          </label>
          <button className="button button-secondary" type="submit">
            <ListFilter aria-hidden="true" size={15} />
            Filter cases
          </button>
          {query || status !== 'all' ? (
            <Link className="text-action" href="/">
              Clear filters
            </Link>
          ) : null}
        </form>

        <div className="queue-table-wrap">
          <table className="queue-table">
            <thead>
              <tr>
                <th scope="col">Case</th>
                {showTenant ? <th scope="col">Tenant</th> : null}
                <th scope="col">Status</th>
                <th scope="col">Evidence set</th>
                <th scope="col">Owner</th>
                <th scope="col">Updated</th>
                <th scope="col">
                  <span className="sr-only">Open case</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredCases.map((item) => (
                <tr className={`queue-row row-${item.status}`} key={item.id}>
                  <td className="case-col">
                    <Link
                      className="case-name"
                      href={`/cases/${item.id}`}
                      aria-label={`${item.supplier}, ${item.reference}`}
                    >
                      <strong>{item.supplier}</strong>
                      <span>{item.subtitle}</span>
                      <code>{item.reference}</code>
                    </Link>
                  </td>
                  {showTenant ? (
                    <td className="tenant-col">
                      <span className="tenant-cell">{item.tenantName}</span>
                    </td>
                  ) : null}
                  <td className="status-col">
                    <StatusMark status={item.status} />
                    {item.openFindings > 0 ? (
                      <span className="finding-count">
                        {item.openFindings} material{' '}
                        {item.openFindings === 1 ? 'finding' : 'findings'}
                      </span>
                    ) : null}
                  </td>
                  <td className="evidence-col">
                    <div className="evidence-progress">
                      <span>
                        {item.documents} documents · {item.progress}%
                      </span>
                      <progress value={item.progress} max="100">
                        {item.progress}%
                      </progress>
                    </div>
                  </td>
                  <td className="owner-col">{item.assignee}</td>
                  <td className="updated-col">{item.updatedAt}</td>
                  <td className="action-col">
                    <Link className="row-action" href={`/cases/${item.id}`}>
                      Review <ArrowUpRight aria-hidden="true" size={14} />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filteredCases.length === 0 ? (
            <div className="empty-state">
              <span className="empty-index" aria-hidden="true">
                0
              </span>
              <div>
                <h2>No cases match these filters</h2>
                <p>Clear the filters or search by a different supplier name or case reference.</p>
              </div>
              <Link className="button button-secondary" href="/">
                Show every case
              </Link>
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}
