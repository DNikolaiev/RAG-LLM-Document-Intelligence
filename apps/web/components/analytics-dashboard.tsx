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

interface Loaded {
  days: ThroughputDay[];
  cycle: CycleTime;
  lastProjectedSequence: number;
}

type Result = { ok: true; data: Loaded } | { ok: false };

/**
 * Pure I/O, no state. Keeping the fetch separate from the setState is what lets the effect below
 * update state only after an await - this project's React compiler lint rejects a setState that can
 * run synchronously inside an effect, because that is what makes a render cascade.
 */
async function fetchAnalytics(): Promise<Result> {
  try {
    const [throughput, cycle, state] = await Promise.all([
      fetch('/api/analytics/throughput', { cache: 'no-store' }),
      fetch('/api/analytics/cycle-time', { cache: 'no-store' }),
      fetch('/api/analytics/state', { cache: 'no-store' }),
    ]);
    if (!throughput.ok || !cycle.ok || !state.ok) return { ok: false };
    const days = ((await throughput.json()) as { days: ThroughputDay[] }).days;
    const summary = (await cycle.json()) as CycleTime;
    const projected = (await state.json()) as { lastProjectedSequence: number };
    return {
      ok: true,
      data: { days, cycle: summary, lastProjectedSequence: projected.lastProjectedSequence },
    };
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
            <Tile
              label="Events projected"
              value={String(data.lastProjectedSequence)}
              hint="Highest outbox sequence this read model has applied"
            />
          </div>

          <h2>Outcomes</h2>
          <div className="analytics-tiles">
            <Tile label="Approved" value={String(data.cycle.approved)} />
            <Tile label="Rejected" value={String(data.cycle.rejected)} />
            <Tile label="Information requested" value={String(data.cycle.informationRequested)} />
          </div>

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

function duration(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 3_600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 172_800) return `${(seconds / 3_600).toFixed(1)} h`;
  return `${(seconds / 86_400).toFixed(1)} d`;
}
