import postgres from 'postgres';
import type { DomainEvent } from '@caselens/events';
import type { CallerContext } from './caller.js';

/**
 * Tenant scope for a query.
 *
 * A platform administrator sees every tenant, which is the one shape the transactional schema is
 * genuinely awkward for - row-level security there exists to prevent exactly this, so a
 * cross-tenant aggregate has to be deliberately bypassed into. There is no RLS to fight here,
 * because the projection holds counts rather than anybody's documents.
 *
 * An empty membership list must match nothing rather than everything, which `= any('{}')` already
 * does correctly - unlike `in ()`, which is not valid SQL at all.
 */
function tenantScope(caller: CallerContext): string[] {
  return caller.platformAdmin ? [] : [...caller.tenantIds];
}

/** The projection this service maintains. One name today; `projection_state` is keyed for more. */
export const PROJECTION_NAME = 'analytics';

export type ApplyOutcome = 'applied' | 'duplicate';

export interface ThroughputRow {
  day: string;
  domainPackId: string;
  created: number;
  decided: number;
  approved: number;
  rejected: number;
  informationRequested: number;
}

export interface CycleTimeSummary {
  decided: number;
  medianSeconds: number | null;
  p90Seconds: number | null;
  approved: number;
  rejected: number;
  informationRequested: number;
}

/**
 * The analytics database.
 *
 * Deliberately raw `postgres.js` and hand-written SQL migrations rather than the Drizzle schema in
 * `packages/persistence`: that package describes the *case pipeline's* database. Importing it here
 * would give this service a compile-time dependency on a schema it must never read, and the
 * independence would last exactly until someone found it convenient to join.
 */
export class AnalyticsStore {
  readonly #sql: postgres.Sql;

  constructor(connectionString: string) {
    this.#sql = postgres(connectionString, { prepare: false });
  }

  /**
   * Applies one event exactly once, no matter how many times it is delivered.
   *
   * The idempotency check and the projection write share a single transaction, and that is the
   * entire design. Recording the event id first and projecting afterwards would be two writes to
   * two places with a crash window between them - the dual-write problem the outbox removed on the
   * publisher side, quietly rebuilt on the consumer side. A crash there would mark an event
   * processed that never was, and no redelivery would ever fix it because the id is already
   * recorded.
   *
   * `on conflict do nothing` makes the insert itself the claim: if it changed no row, another
   * delivery of this event already won, and this one has nothing to do.
   */
  async apply(
    event: DomainEvent,
    project: (tx: postgres.TransactionSql) => Promise<void>,
  ): Promise<ApplyOutcome> {
    return (await this.#sql.begin(async (tx) => {
      const claimed = await tx`
        insert into processed_events (event_id, sequence, event_type)
        values (${event.id}, ${event.sequence}, ${event.type})
        on conflict (event_id) do nothing
        returning event_id`;
      if (!claimed.length) return 'duplicate';

      await project(tx);

      // `greatest` because events are not guaranteed to arrive in sequence order - a redelivery of
      // an older event must not drag the watermark backwards and make lag read as negative.
      await tx`
        insert into projection_state (name, last_sequence, updated_at)
        values (${PROJECTION_NAME}, ${event.sequence}, now())
        on conflict (name) do update
          set last_sequence = greatest(projection_state.last_sequence, excluded.last_sequence),
            updated_at = now()`;
      return 'applied';
    })) as ApplyOutcome;
  }

  /**
   * Intake and decisions per day. Rows are already aggregated by the projection, so this sums a
   * handful of counters rather than scanning every case that ever existed - the difference between
   * a dashboard that is free to refresh and one that competes with the reviewers using the console.
   */
  async throughput(
    caller: CallerContext,
    range: { from?: string; to?: string } = {},
  ): Promise<ThroughputRow[]> {
    const from = range.from ?? null;
    const to = range.to ?? null;
    const tenantIds = tenantScope(caller);
    const rows = await this.#sql<
      Array<{
        day: string;
        domain_pack_id: string;
        created: number;
        decided: number;
        approved: number;
        rejected: number;
        information_requested: number;
      }>
    >`
      select day::text as day, domain_pack_id,
        sum(created)::int as created,
        sum(decided)::int as decided,
        sum(approved)::int as approved,
        sum(rejected)::int as rejected,
        sum(information_requested)::int as information_requested
      from case_throughput_daily
      where (${caller.platformAdmin} or tenant_id = any(${tenantIds}::text[]))
        and (${from}::date is null or day >= ${from}::date)
        and (${to}::date is null or day <= ${to}::date)
      group by day, domain_pack_id
      order by day desc, domain_pack_id`;
    return rows.map((row) => ({
      day: row.day,
      domainPackId: row.domain_pack_id,
      created: row.created,
      decided: row.decided,
      approved: row.approved,
      rejected: row.rejected,
      informationRequested: row.information_requested,
    }));
  }

  /**
   * Median and p90 time from creation to decision.
   *
   * Percentiles rather than an average, computed from the retained per-case rows. An average of two
   * days hides whether the slowest tenth waited three weeks, and the slowest tenth is the part
   * anyone would actually act on.
   */
  async cycleTime(caller: CallerContext): Promise<CycleTimeSummary> {
    const tenantIds = tenantScope(caller);
    const rows = await this.#sql<
      Array<{
        decided: number;
        median_seconds: string | null;
        p90_seconds: string | null;
        approved: number;
        rejected: number;
        information_requested: number;
      }>
    >`
      select count(*)::int as decided,
        percentile_cont(0.5) within group (order by seconds_to_decision) as median_seconds,
        percentile_cont(0.9) within group (order by seconds_to_decision) as p90_seconds,
        count(*) filter (where outcome = 'approve')::int as approved,
        count(*) filter (where outcome = 'reject')::int as rejected,
        count(*) filter (where outcome = 'request_information')::int as information_requested
      from case_cycle_time
      where (${caller.platformAdmin} or tenant_id = any(${tenantIds}::text[]))`;
    const row = rows[0];
    return {
      decided: row?.decided ?? 0,
      medianSeconds: row?.median_seconds == null ? null : Number(row.median_seconds),
      p90Seconds: row?.p90_seconds == null ? null : Number(row.p90_seconds),
      approved: row?.approved ?? 0,
      rejected: row?.rejected ?? 0,
      informationRequested: row?.information_requested ?? 0,
    };
  }

  /** The highest sequence this projection has applied; the consumer half of the lag measurement. */
  async lastSequence(): Promise<number> {
    const rows = await this.#sql<Array<{ last_sequence: string }>>`
      select last_sequence from projection_state where name = ${PROJECTION_NAME}`;
    return rows.length ? Number(rows[0]!.last_sequence) : 0;
  }

  async close(): Promise<void> {
    await this.#sql.end();
  }
}
