import amqp, { type ChannelModel, type ConfirmChannel } from 'amqplib';
import {
  parseDomainEvent,
  REPLAY_EXCHANGE,
  type DomainEvent,
  type ReplayStarted,
} from '@caselens/events';
import type { StoredDomainEvent } from '@caselens/persistence';

/**
 * Republishes the outbox so a consumer can rebuild a projection from history.
 *
 * This is the payoff of deciding that the outbox is the log and RabbitMQ is only delivery. A broker
 * forgets an acknowledged message, so a projection could never be rebuilt from it; the table
 * remembers, and a fact published to an exchange that had no bindings - discarded on arrival,
 * unrecoverable by any redelivery - is still right there in sequence order.
 *
 * It runs on the publisher's side on purpose. The alternative, letting the analytics service read
 * `domain_events` directly, would be less code and would quietly break the invariant that makes it
 * an independent service: a consumer that can select from another service's tables is coupled to
 * that schema whether or not it currently joins on it. Replaying through the broker also means the
 * rebuild exercises the same consumer code as live traffic, which is what makes it trustworthy.
 */
export interface ReplaySource {
  readEventsForReplay(afterSequence: number, limit: number): Promise<StoredDomainEvent[]>;
}

export interface ReplayOptions {
  url: string;
  source: ReplaySource;
  replayId: string;
  batchSize?: number;
  connect?: (url: string) => Promise<ChannelModel>;
  onProgress?: (message: string) => void;
  onError?: (error: Error) => void;
}

export interface ReplayResult {
  published: number;
  skipped: number;
  lastSequence: number;
}

export async function replayOutbox(options: ReplayOptions): Promise<ReplayResult> {
  const connect = options.connect ?? ((url: string) => amqp.connect(url));
  const connection = await connect(options.url);
  const channel: ConfirmChannel = await connection.createConfirmChannel();
  await channel.assertExchange(REPLAY_EXCHANGE, 'topic', { durable: true });

  const batchSize = options.batchSize ?? 200;
  let cursor = 0;
  let published = 0;
  let skipped = 0;

  try {
    // The control message goes first, on the same exchange and therefore the same queue. Ordering
    // between "discard what you derived" and "here is the history" is then the broker's guarantee,
    // rather than a race between two services agreeing to do things in turn.
    const started: ReplayStarted = {
      control: 'replay.started',
      replayId: options.replayId,
      startedAt: new Date().toISOString(),
    };
    await publish(channel, 'replay.started', started, options.replayId);

    for (;;) {
      const rows = await options.source.readEventsForReplay(cursor, batchSize);
      if (!rows.length) break;

      for (const row of rows) {
        cursor = row.sequence;
        let event: DomainEvent;
        try {
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
          // A row the current contract cannot read is skipped rather than aborting the rebuild.
          // History accumulates across schema versions, and refusing to replay anything because one
          // ancient row no longer parses would make the whole mechanism unusable exactly when it
          // matters most.
          skipped += 1;
          options.onError?.(
            new Error(
              `Skipped unreadable event ${row.id} (${row.type}): ${(error as Error).message}`,
            ),
          );
          continue;
        }
        await publish(channel, event.type, event, event.id);
        published += 1;
      }
      options.onProgress?.(`Replayed up to sequence ${cursor} (${published} published)`);
    }
  } finally {
    await channel.close().catch(() => {});
    await connection.close().catch(() => {});
  }

  return { published, skipped, lastSequence: cursor };
}

async function publish(
  channel: ConfirmChannel,
  routingKey: string,
  body: unknown,
  messageId: string,
): Promise<void> {
  const accepted = await new Promise<boolean>((resolve) => {
    channel.publish(
      REPLAY_EXCHANGE,
      routingKey,
      Buffer.from(JSON.stringify(body)),
      { contentType: 'application/json', persistent: true, messageId },
      (error) => resolve(!error),
    );
  });
  // A refusal mid-replay must stop the run. Continuing would leave the consumer with a projection
  // rebuilt from a hole in the middle of history, which is worse than the stale one it replaced.
  if (!accepted) throw new Error(`Broker refused replay message ${messageId}`);
}
