import amqp, { type ChannelModel, type ConfirmChannel } from 'amqplib';
import { EVENT_EXCHANGE, parseDomainEvent, type DomainEvent } from '@caselens/events';
import type { StoredDomainEvent } from '@caselens/persistence';

/**
 * The outbox relay: the only thing that turns a recorded fact into a delivered message.
 *
 * It is deliberately separate from the code that records facts. The API appends an event inside
 * the transaction that changed the business state and then forgets about it; nothing in a request
 * path ever talks to the broker. That is what makes the write atomic - there is no second system
 * to fail halfway.
 *
 * Delivery is at-least-once and cannot be otherwise. The relay publishes, waits for the broker to
 * confirm, then stamps `published_at`. A crash in the window between the confirm and the stamp
 * republishes the event on the next pass. Trying to close that window is the classic mistake:
 * whichever order you choose, some crash loses or duplicates. Duplicating is the recoverable one,
 * so consumers dedupe on event id instead.
 *
 * Several relays can run at once. The claim they take is a row lock, not a marker, so two of them
 * partition the backlog rather than both publishing it.
 */
export interface PublishOutcome {
  /** Events the broker confirmed. Only these get stamped. */
  publishedIds: readonly string[];
  /**
   * Events that were tried and could not be delivered. Each one records an attempt; enough
   * attempts and the store sets the row aside so it stops occupying a slot in every batch.
   * An event that was never reached - held back behind a refusal - belongs in neither list.
   */
  failures?: ReadonlyArray<{ id: string; error: string }>;
}

export interface RelayStore {
  /**
   * Claims a batch under `for update skip locked` and publishes it inside that transaction.
   *
   * The callback shape is not incidental. A plain read would release the rows the moment it
   * returned, so a second relay would claim the same batch and publish everything twice; holding
   * the transaction open across the publish is what makes the claim mean anything.
   */
  claimUnpublishedEvents(
    limit: number,
    publish: (events: readonly StoredDomainEvent[]) => Promise<PublishOutcome>,
  ): Promise<number>;
}

export interface RelayOptions {
  url: string;
  store: RelayStore;
  batchSize?: number;
  /** Injectable so a test can assert publish behaviour without a broker. */
  connect?: (url: string) => Promise<ChannelModel>;
  onError?: (error: Error) => void;
}

export interface EventRelay {
  /** Drains the outbox once. Returns how many events the broker confirmed. */
  drain(): Promise<number>;
  close(): Promise<void>;
}

export async function createEventRelay(options: RelayOptions): Promise<EventRelay> {
  const connect = options.connect ?? ((url: string) => amqp.connect(url));
  const connection = await connect(options.url);
  // A confirm channel, not a plain one. Without confirms, `publish` only means "handed to the
  // socket": the relay would stamp published_at for events the broker never accepted, and the
  // outbox would say delivered while nothing was. Confirms are what make the stamp truthful.
  const channel: ConfirmChannel = await connection.createConfirmChannel();
  // Durable topic exchange. Topic because a consumer should choose what it cares about with a
  // binding pattern - `case.*`, `finding.raised`, `#` - rather than the publisher choosing for it.
  await channel.assertExchange(EVENT_EXCHANGE, 'topic', { durable: true });

  return {
    async drain(): Promise<number> {
      return options.store.claimUnpublishedEvents(options.batchSize ?? 100, async (rows) => {
        const publishedIds: string[] = [];
        const failures: Array<{ id: string; error: string }> = [];

        for (const row of rows) {
          let event: DomainEvent;
          try {
            // Validated on the way out. A row that cannot be parsed is a bug in a publisher, and
            // shipping it would push the failure into every consumer instead of the one place that
            // can still see where it came from.
            event = parseDomainEvent({
              id: row.id,
              type: row.type,
              tenantId: row.tenantId,
              aggregateType: row.aggregateType,
              aggregateId: row.aggregateId,
              occurredAt: row.occurredAt,
              sequence: row.sequence,
              payload: row.payload,
            });
          } catch (error) {
            // Recorded as a failed attempt rather than skipped silently. Skipping was the old
            // behaviour and it meant an unpublishable row came back in every batch forever, so a
            // handful of them could fill the batch and starve deliverable events while the relay
            // still reported itself healthy. Counting the attempt lets the store retire the row.
            //
            // Not a `break`: this event can never be delivered, so holding the batch behind it
            // would trade one stuck event for all of them.
            const message = `Unpublishable event ${row.id} (${row.type}): ${(error as Error).message}`;
            failures.push({ id: row.id, error: message });
            options.onError?.(new Error(message));
            continue;
          }

          const refusal = await new Promise<Error | undefined>((resolve) => {
            channel.publish(
              EVENT_EXCHANGE,
              event.type,
              Buffer.from(JSON.stringify(event)),
              {
                contentType: 'application/json',
                // Survives a broker restart. An in-memory message would make the outbox's
                // durability pointless the moment RabbitMQ bounced.
                persistent: true,
                messageId: event.id,
                type: event.type,
                timestamp: Math.floor(new Date(event.occurredAt).getTime() / 1000),
              },
              (error) => resolve(error ?? undefined),
            );
          });

          if (refusal) {
            // Stop at the first refusal rather than skipping ahead. Events are drained in sequence
            // order, and a consumer that sees event 5 before event 4 has to cope with reordering it
            // did not need to. Unlike a parse failure this one is usually the broker, not the row,
            // so the rest of the batch is left untouched - no attempt counted against events that
            // were never tried.
            failures.push({ id: event.id, error: refusal.message });
            options.onError?.(new Error(`Broker refused event ${event.id}: ${refusal.message}`));
            break;
          }
          publishedIds.push(event.id);
        }

        return { publishedIds, failures };
      });
    },

    async close(): Promise<void> {
      await channel.close().catch(() => {});
      await connection.close().catch(() => {});
    },
  };
}

/**
 * Runs `drain` on an interval until the returned handle is stopped. Polling rather than listening
 * for a database notification keeps the relay recoverable: if it was down for an hour, the next
 * tick simply finds an hour of unpublished rows and works through them in order.
 */
export function startEventRelay(
  relay: EventRelay,
  intervalMs: number,
  onError?: (error: Error) => void,
): { stop: () => Promise<void> } {
  let stopped = false;
  let running: Promise<void> = Promise.resolve();

  const tick = async () => {
    if (stopped) return;
    try {
      let drained = await relay.drain();
      // Keep going while a full batch comes back: a backlog should clear as fast as the broker
      // accepts it, not one batch per interval.
      while (!stopped && drained > 0) drained = await relay.drain();
    } catch (error) {
      onError?.(error as Error);
    }
  };

  const timer = setInterval(() => {
    running = running.then(tick);
  }, intervalMs);

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
      await relay.close();
    },
  };
}
