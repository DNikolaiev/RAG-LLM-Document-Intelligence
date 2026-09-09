'use client';

import { useCallback, useEffect, useState } from 'react';
import { CircleAlert, RefreshCw } from 'lucide-react';

interface ThroughputDay {
  day: string;
  domainPackId: string;
  created: number;
  decided: number;
  approved: number;
  rejected: number;
  informationRequested: number;
}

interface CycleTime {
  decided: number;
  medianSeconds: number | null;
  p90Seconds: number | null;
  approved: number;
  rejected: number;
  informationRequested: number;
}

interface RuleRow {
  ruleKey: string;
  severity: string;
  timesRaised: number;
  thenApproved: number;
  thenRejected: number;
  thenInformationRequested: number;
  decided: number;
}

interface Loaded {
  days: ThroughputDay[];
  cycle: CycleTime;
  rules: RuleRow[];
  /**
   * Both halves of consumer lag, or null for a reviewer who may not see them. They are global
   * sequence counters across every tenant, so a single-tenant reviewer reading them would learn how
   * much work everybody else is doing - lag is an operator's question.
   */
  lag: { projected: number; recorded: number } | null;
}

type Result = { ok: true; data: Loaded } | { ok: false };

/**
 * Pure I/O, no state. Keeping the fetch separate from the setState is what lets the effect below
 * update state only after an await - this project's React compiler lint rejects a setState that can
 * run synchronously inside an effect, because that is what makes a render cascade.
 */
async function fetchAnalytics(): Promise<Result> {
  try {
    const [throughput, cycle, rules, projected, recorded] = await Promise.all([
      fetch('/api/analytics/throughput', { cache: 'no-store' }),
      fetch('/api/analytics/cycle-time', { cache: 'no-store' }),
      fetch('/api/analytics/rules', { cache: 'no-store' }),
      fetch('/api/analytics/state', { cache: 'no-store' }),
      fetch('/api/events/state', { cache: 'no-store' }),
    ]);
    // The lag pair is allowed to be forbidden - that is a reviewer seeing the page, not an outage -
    // so only the projection queries decide whether the read model answered at all.
    if (!throughput.ok || !cycle.ok || !rules.ok) return { ok: false };
    // Defaulted rather than trusted. A response whose shape is not what this page expects - a
    // proxy error body, a version skew between console and service - should degrade to an empty
    // table, not throw during render and take the whole page down with it.
    const days = ((await throughput.json()) as { days?: ThroughputDay[] }).days ?? [];
    const summary = (await cycle.json()) as CycleTime;
    const ruleRows = ((await rules.json()) as { rules?: RuleRow[] }).rules ?? [];
    const lag =
      projected.ok && recorded.ok
        ? {
            projected: ((await projected.json()) as { lastProjectedSequence: number })
              .lastProjectedSequence,
            recorded: ((await recorded.json()) as { lastRecordedSequence: number })
              .lastRecordedSequence,
          }
        : null;
    return { ok: true, data: { days, cycle: summary, rules: ruleRows, lag } };
  } catch {
    return { ok: false };
  }
}

const UNREACHABLE = 'The analytics read model is not answering right now.';

export function AnalyticsDashboard() {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await fetchAnalytics();
      if (cancelled) return;
      // An unreachable read model must not render as an empty one. Zeroes during an outage look
      // like a quiet business day, which is the most expensive kind of wrong a dashboard can be.
      setData(result.ok ? result.data : null);
      setError(result.ok ? null : UNREACHABLE);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(() => {
    setLoading(true);
    void fetchAnalytics().then((result) => {
      setData(result.ok ? result.data : null);
      setError(result.ok ? null : UNREACHABLE);
      setLoading(false);
    });
  }, []);

  return (
    <section className="analytics-page">
      <header className="analytics-intro">
        <div>
          <p className="eyebrow">Read model</p>
          <h1>Decision analytics</h1>
          <p>
            Built entirely from published domain facts, in a separate service with its own database.
            It lags the review queue by design — a number here is what the event stream has been
            told, not what the case pipeline knows this instant.
          </p>
        </div>
        <button className="button button-secondary" onClick={refresh} type="button">
          <RefreshCw aria-hidden="true" size={16} className={loading ? 'spin' : undefined} />
          Refresh
        </button>
      </header>

      {error ? (
        <p className="analytics-error" role="status">
          <CircleAlert aria-hidden="true" size={16} />
          {error}
        </p>
      ) : null}

      {data ? (
        <>
          <div className="analytics-tiles">
            <Tile label="Decisions recorded" value={String(data.cycle.decided)} />
            <Tile label="Median time to decision" value={duration(data.cycle.medianSeconds)} />
            <Tile
              label="90th percentile"
              value={duration(data.cycle.p90Seconds)}
              hint="The slowest tenth, which an average would hide"
            />
            {data.lag ? (
              <Tile
                label="Read model lag"
                value={lagLabel(data.lag)}
                hint={`Projected ${data.lag.projected} of ${data.lag.recorded} recorded facts`}
              />
            ) : null}
          </div>

          <h2>Outcomes</h2>
          <div className="analytics-tiles">
            <Tile label="Approved" value={String(data.cycle.approved)} />
            <Tile label="Rejected" value={String(data.cycle.rejected)} />
            <Tile label="Information requested" value={String(data.cycle.informationRequested)} />
          </div>

          <h2>Rule effectiveness</h2>
          {data.rules.length ? (
            <div className="analytics-table-wrap">
              <table className="analytics-table">
                <thead>
                  <tr>
                    <th scope="col">Rule</th>
                    <th scope="col">Severity</th>
                    <th scope="col">Raised</th>
                    <th scope="col">Decided since</th>
                    <th scope="col">Approved anyway</th>
                    <th scope="col">Rejected</th>
                    <th scope="col">Info requested</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rules.map((rule) => (
                    <tr key={`${rule.ruleKey}:${rule.severity}`}>
                      <td>{rule.ruleKey}</td>
                      <td>{rule.severity}</td>
                      <td>{rule.timesRaised}</td>
                      <td>{rule.decided}</td>
                      <td
                        // A rule whose every decided case was approved regardless is costing
                        // reviewer attention and changing nothing. That is the finding worth
                        // reading, so it is the one the table calls out.
                        className={
                          rule.decided > 0 && rule.thenApproved === rule.decided
                            ? 'analytics-flag'
                            : undefined
                        }
                      >
                        {rule.thenApproved}
                      </td>
                      <td>{rule.thenRejected}</td>
                      <td>{rule.thenInformationRequested}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="analytics-empty">
              No findings have reached the read model yet. They arrive when a case is processed.
            </p>
          )}

          <h2>Daily throughput</h2>
          {data.days.length ? (
            <div className="analytics-table-wrap">
              <table className="analytics-table">
                <thead>
                  <tr>
                    <th scope="col">Day</th>
                    <th scope="col">Domain pack</th>
                    <th scope="col">Created</th>
                    <th scope="col">Decided</th>
                    <th scope="col">Approved</th>
                    <th scope="col">Rejected</th>
                    <th scope="col">Info requested</th>
                  </tr>
                </thead>
                <tbody>
                  {data.days.map((day) => (
                    <tr key={`${day.day}:${day.domainPackId}`}>
                      <td>{day.day}</td>
                      <td>
                        {day.domainPackId === 'unknown' ? (
                          <span
                            className="analytics-unknown"
                            title="Decided before this service existed; a replay would attribute it"
                          >
                            unattributed
                          </span>
                        ) : (
                          day.domainPackId
                        )}
                      </td>
                      <td>{day.created}</td>
                      <td>{day.decided}</td>
                      <td>{day.approved}</td>
                      <td>{day.rejected}</td>
                      <td>{day.informationRequested}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="analytics-empty">
              No facts have reached the read model yet. Decide a case and it will appear here a
              moment later.
            </p>
          )}
        </>
      ) : null}
    </section>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <article className="analytics-tile">
      <p>{label}</p>
      <strong>{value}</strong>
      {hint ? <small>{hint}</small> : null}
    </article>
  );
}

/**
 * The gap between what has been recorded and what has been projected.
 *
 * Negative is impossible by construction - the projection watermark only ever moves forward, and
 * only to sequences the outbox already assigned - so anything below zero would mean the two numbers
 * came from different systems than they claim to.
 */
function lagLabel(lag: { projected: number; recorded: number }): string {
  const behind = Math.max(0, lag.recorded - lag.projected);
  if (behind === 0) return 'Up to date';
  return behind === 1 ? '1 event behind' : `${behind} events behind`;
}

function duration(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 3_600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 172_800) return `${(seconds / 3_600).toFixed(1)} h`;
  return `${(seconds / 86_400).toFixed(1)} d`;
}
