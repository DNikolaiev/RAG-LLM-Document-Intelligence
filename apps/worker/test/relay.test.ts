import { describe, expect, it } from 'vitest';
import { EVENT_EXCHANGE } from '@caselens/events';
import { MAX_PUBLISH_ATTEMPTS, type StoredDomainEvent } from '@caselens/persistence';
import { createEventRelay, type PublishOutcome, type RelayStore } from '../src/events/relay.js';

interface Published {
  exchange: string;
  routingKey: string;
  body: unknown;
  options: Record<string, unknown>;
}

/**
 * A broker stand-in that records what was published and can refuse a confirm, so the relay's
 * contract can be asserted without RabbitMQ: publish, wait for the confirm, and only then stamp.
 */
function fakeBroker(refuseFrom = Number.POSITIVE_INFINITY) {
  const published: Published[] = [];
  const asserted: Array<{ name: string; type: string }> = [];
  const channel = {
    async assertExchange(name: string, type: string) {
      asserted.push({ name, type });
    },
    publish(
      exchange: string,
      routingKey: string,
      content: Buffer,
      options: Record<string, unknown>,
      callback: (error?: Error) => void,
    ) {
      if (published.length >= refuseFrom) {
        callback(new Error('broker refused'));
        return true;
      }
      published.push({ exchange, routingKey, body: JSON.parse(content.toString()), options });
      callback();
      return true;
    },
    async close() {},
  };
  return {
    published,
    asserted,
    connect: async () =>
      ({
        createConfirmChannel: async () => channel,
        close: async () => {},
      }) as never,
  };
}

interface FakeRow {
  event: StoredDomainEvent;
  publishedAt: string | null;
  attempts: number;
  failedAt: string | null;
}

/**
 * Models the store's bookkeeping rather than just handing rows back, because the behaviour under
 * test lives in that bookkeeping: what a failed attempt costs a row, and when a row stops being
 * offered. The row locking itself is not modelled here - a fake would only agree with itself, so
 * that claim is asserted against a real transaction in the persistence integration suite.
 */
function storeWith(events: StoredDomainEvent[]): RelayStore & { rows: FakeRow[] } {
  const rows: FakeRow[] = events.map((event) => ({
    event,
    publishedAt: null,
    attempts: 0,
    failedAt: null,
  }));
  return {
    rows,
    async claimUnpublishedEvents(
      limit: number,
      publish: (batch: readonly StoredDomainEvent[]) => Promise<PublishOutcome>,
    ) {
      const claimed = rows
        .filter((row) => !row.publishedAt && !row.failedAt)
        .sort((a, b) => a.event.sequence - b.event.sequence)
        .slice(0, limit);
      if (!claimed.length) return 0;

      const outcome = await publish(claimed.map((row) => row.event));
      for (const row of claimed) {
        if (outcome.publishedIds.includes(row.event.id)) row.publishedAt = 'stamped';
        const failure = outcome.failures?.find((entry) => entry.id === row.event.id);
        if (failure) {
          row.attempts += 1;
          if (row.attempts >= MAX_PUBLISH_ATTEMPTS) row.failedAt = 'quarantined';
        }
      }
      return outcome.publishedIds.length;
    },
  };
}

function publishedIds(store: { rows: FakeRow[] }): string[] {
  return store.rows.filter((row) => row.publishedAt).map((row) => row.event.id);
}

function row(id: string, sequence: number, type = 'case.created'): StoredDomainEvent {
  return {
    id,
    sequence,
    tenantId: 'tenant_demo',
    type,
    aggregateType: 'case',
    aggregateId: `case_${id}`,
    occurredAt: '2026-09-06T10:00:00.000Z',
    payload: { reference: 'SUP-1', domainPackId: 'pack_tenant_demo', domainPackVersion: '1.0.0' },
  };
}

describe('event relay', () => {
  it('publishes to the topic exchange with the type as the routing key', async () => {
    const broker = fakeBroker();
    const store = storeWith([row('evt_a', 1)]);
    const relay = await createEventRelay({ url: 'amqp://x', store, connect: broker.connect });

    expect(await relay.drain()).toBe(1);
    expect(broker.asserted).toEqual([{ name: EVENT_EXCHANGE, type: 'topic' }]);
    expect(broker.published[0]!.exchange).toBe(EVENT_EXCHANGE);
    // The routing key is the event type, which is what lets a consumer bind on `case.*`.
    expect(broker.published[0]!.routingKey).toBe('case.created');
    // Persistent, or a broker restart would discard what the outbox worked to make durable.
    expect(broker.published[0]!.options.persistent).toBe(true);
    expect(broker.published[0]!.options.messageId).toBe('evt_a');
    expect(publishedIds(store)).toEqual(['evt_a']);
  });

  it('stamps only what the broker confirmed, and stops at the first refusal', async () => {
    // The broker takes the first event and refuses the second.
    const broker = fakeBroker(1);
    const store = storeWith([row('evt_a', 1), row('evt_b', 2), row('evt_c', 3)]);
    const relay = await createEventRelay({ url: 'amqp://x', store, connect: broker.connect });

    expect(await relay.drain()).toBe(1);
    // evt_b was refused, so it stays unpublished - and evt_c is held back with it rather than
    // jumping the queue, because consumers should not have to cope with reordering.
    expect(publishedIds(store)).toEqual(['evt_a']);
    expect(broker.published).toHaveLength(1);
    // A refusal is the broker's problem, not the row's: only the event actually tried carries the
    // attempt, or a flapping broker would quarantine a whole healthy backlog.
    expect(store.rows.map((entry) => entry.attempts)).toEqual([0, 1, 0]);

    // The next pass retries from where it stopped.
    const recovered = fakeBroker();
    const relay2 = await createEventRelay({
      url: 'amqp://x',
      store,
      connect: recovered.connect,
    });
    expect(await relay2.drain()).toBe(2);
    expect(publishedIds(store)).toEqual(['evt_a', 'evt_b', 'evt_c']);
  });

  it('leaves an unparseable row in the outbox instead of shipping it to every consumer', async () => {
    const broker = fakeBroker();
    const store = storeWith([row('evt_bad', 1, 'case.exploded'), row('evt_good', 2)]);
    const errors: Error[] = [];
    const relay = await createEventRelay({
      url: 'amqp://x',
      store,
      connect: broker.connect,
      onError: (error) => errors.push(error),
    });

    expect(await relay.drain()).toBe(1);
    expect(broker.published.map((message) => message.options.messageId)).toEqual(['evt_good']);
    expect(publishedIds(store)).toEqual(['evt_good']);
    expect(errors[0]?.message).toContain('evt_bad');
    // Still in the outbox, unpublished - visible rather than vanished.
    expect(store.rows[0]!.publishedAt).toBeNull();
  });

  it('retires a poison row rather than letting it crowd out deliverable events forever', async () => {
    // The regression this guards: an unparseable row used to be skipped without being counted, so
    // it came back in every single batch. Enough of them and the batch is nothing but poison while
    // real events sit behind them and the relay still reports itself healthy.
    const store = storeWith([
      row('evt_poison_a', 1, 'case.exploded'),
      row('evt_poison_b', 2, 'case.exploded'),
      row('evt_real', 3),
    ]);
    const broker = fakeBroker();
    const relay = await createEventRelay({
      url: 'amqp://x',
      store,
      connect: broker.connect,
      // A batch of one, so a poison row genuinely occupies the whole batch.
      batchSize: 1,
    });

    // Each pass claims only the oldest poison row and gets nowhere.
    for (let attempt = 1; attempt < MAX_PUBLISH_ATTEMPTS; attempt += 1) {
      expect(await relay.drain()).toBe(0);
    }
    expect(store.rows[0]!.failedAt).toBeNull();

    // The attempt that exhausts the budget sets it aside, and the batch moves on.
    expect(await relay.drain()).toBe(0);
    expect(store.rows[0]!.failedAt).toBe('quarantined');
    // Nothing is deleted: the payload and its place in the sequence survive for a replay.
    expect(store.rows[0]!.publishedAt).toBeNull();

    // The second poison row now occupies the batch and is retired the same way.
    for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt += 1) await relay.drain();
    expect(store.rows[1]!.failedAt).toBe('quarantined');

    // And the real event, which was never reachable before, is delivered.
    expect(await relay.drain()).toBe(1);
    expect(publishedIds(store)).toEqual(['evt_real']);
  });
});
