import postgres from 'postgres';
import type { DomainEvent } from '@caselens/events';

/** The projection this service maintains. One name today; `projection_state` is keyed for more. */
export const PROJECTION_NAME = 'analytics';

export type ApplyOutcome = 'applied' | 'duplicate';

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
