import type { Metadata } from 'next';
import Link from 'next/link';

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

  return (
    <main id="main-content" className="queue-page">
      <section className="queue-intro" aria-labelledby="queue-title">
        <div>
          <p className="eyebrow">Qualification docket · 26 August 2026</p>
          <h1 id="queue-title">Cases that need a human eye</h1>
          <p className="intro-copy">
            Review exceptions, verify their source, and leave every decision with a traceable
            reason.
          </p>
        </div>
        <div className="queue-ledger" aria-label="Case totals">
          <div>
            <strong>{allCases.length}</strong>
            <span>Open cases</span>
          </div>
          <div>
            <strong>{counts.review_needed}</strong>
            <span>Need review</span>
          </div>
          <div>
            <strong>{materialFindings}</strong>
            <span>Material findings</span>
          </div>
        </div>
      </section>

      <section className="queue-workbench" aria-label="Case queue">
        <form className="queue-tools" action="/" method="get" role="search">
          <label className="search-field">
            <span>Find a subject or case</span>
            <input
              type="search"
              name="query"
              defaultValue={query}
              placeholder="Subject name or case reference"
            />
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
                <tr key={item.id}>
                  <td>
                    <Link className="case-name" href={`/cases/${item.id}`}>
                      <strong>{item.supplier}</strong>
                      <span>{item.subtitle}</span>
                      <code>{item.reference}</code>
                    </Link>
                  </td>
                  <td>
                    <StatusMark status={item.status} />
                    {item.openFindings > 0 ? (
                      <span className="finding-count">
                        {item.openFindings} material{' '}
                        {item.openFindings === 1 ? 'finding' : 'findings'}
                      </span>
                    ) : null}
                  </td>
                  <td>
                    <div className="evidence-progress">
                      <span>
                        {item.documents} documents · {item.progress}%
                      </span>
                      <progress value={item.progress} max="100">
                        {item.progress}%
                      </progress>
                    </div>
                  </td>
                  <td>{item.assignee}</td>
                  <td>{item.updatedAt}</td>
                  <td>
                    <Link className="row-action" href={`/cases/${item.id}`}>
                      Review <span aria-hidden="true">→</span>
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
