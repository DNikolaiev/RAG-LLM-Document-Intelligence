import { describe, expect, it } from 'vitest';
import { EVENT_EXCHANGE } from '@caselens/events';
import type { StoredDomainEvent } from '@caselens/persistence';
import { createEventRelay, type RelayStore } from '../src/events/relay.js';

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

function storeWith(rows: StoredDomainEvent[]): RelayStore & { marked: string[] } {
  const marked: string[] = [];
  return {
    marked,
    async readUnpublishedEvents() {
      return rows.filter((row) => !marked.includes(row.id));
    },
    async markEventsPublished(ids) {
      marked.push(...ids);
    },
  };
}

function row(id: string, sequence: number): StoredDomainEvent {
  return {
    id,
    sequence,
    tenantId: 'tenant_demo',
    type: 'case.created',
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
    expect(store.marked).toEqual(['evt_a']);
  });

  it('stamps only what the broker confirmed, and stops at the first refusal', async () => {
    // The broker takes the first event and refuses the second.
    const broker = fakeBroker(1);
    const store = storeWith([row('evt_a', 1), row('evt_b', 2), row('evt_c', 3)]);
    const relay = await createEventRelay({ url: 'amqp://x', store, connect: broker.connect });

    expect(await relay.drain()).toBe(1);
    // evt_b was refused, so it stays unpublished - and evt_c is held back with it rather than
    // jumping the queue, because consumers should not have to cope with reordering.
    expect(store.marked).toEqual(['evt_a']);
    expect(broker.published).toHaveLength(1);

    // The next pass retries from where it stopped.
    const recovered = fakeBroker();
    const relay2 = await createEventRelay({
      url: 'amqp://x',
      store,
      connect: recovered.connect,
    });
    expect(await relay2.drain()).toBe(2);
    expect(store.marked).toEqual(['evt_a', 'evt_b', 'evt_c']);
  });

  it('leaves an unparseable row in the outbox instead of shipping it to every consumer', async () => {
    const broker = fakeBroker();
    const bad = { ...row('evt_bad', 1), type: 'case.exploded' };
    const store = storeWith([bad, row('evt_good', 2)]);
    const errors: Error[] = [];
    const relay = await createEventRelay({
      url: 'amqp://x',
      store,
      connect: broker.connect,
      onError: (error) => errors.push(error),
    });

    expect(await relay.drain()).toBe(1);
    expect(broker.published.map((message) => message.options.messageId)).toEqual(['evt_good']);
    expect(store.marked).toEqual(['evt_good']);
    expect(errors[0]?.message).toContain('evt_bad');
  });
});
