import { describe, expect, it } from 'vitest';
import { EVENT_EXCHANGE } from '@caselens/events';
import type { DomainEvent } from '@caselens/events';
import { ANALYTICS_BINDINGS, EVENT_DLX, startAnalyticsConsumer } from '../src/consumer.js';

interface Recorded {
  exchanges: Array<{ name: string; type: string; durable: boolean }>;
  queues: Array<{ name: string; options: Record<string, unknown> }>;
  bindings: Array<{ queue: string; exchange: string; pattern: string }>;
  prefetch: number | null;
  acked: string[];
  nacked: Array<{ id: string; requeue: boolean }>;
}

/**
 * A broker stand-in that records the topology the consumer asserts and how it settles each
 * delivery. Topology is worth asserting rather than eyeballing: a queue declared without its
 * dead-letter argument cannot be corrected later without deleting it.
 */
function fakeBroker() {
  const recorded: Recorded = {
    exchanges: [],
    queues: [],
    bindings: [],
    prefetch: null,
    acked: [],
    nacked: [],
  };
  let deliver: (message: unknown) => void = () => {};

  const channel = {
    async assertExchange(name: string, type: string, options: { durable?: boolean }) {
      recorded.exchanges.push({ name, type, durable: options.durable === true });
    },
    async assertQueue(name: string, options: Record<string, unknown>) {
      recorded.queues.push({ name, options });
    },
    async bindQueue(queue: string, exchange: string, pattern: string) {
      recorded.bindings.push({ queue, exchange, pattern });
    },
    async prefetch(count: number) {
      recorded.prefetch = count;
    },
    async consume(_queue: string, handler: (message: unknown) => void) {
      deliver = handler;
      return { consumerTag: 'test' };
    },
    ack(message: { properties: { messageId: string } }) {
      recorded.acked.push(message.properties.messageId);
    },
    nack(message: { properties: { messageId: string } }, _all: boolean, requeue: boolean) {
      recorded.nacked.push({ id: message.properties.messageId, requeue });
    },
    async close() {},
  };

  return {
    recorded,
    /** Hands the consumer a message without waiting, exactly as the broker would. */
    emit(body: unknown, messageId = 'evt_a') {
      deliver({ content: Buffer.from(JSON.stringify(body)), properties: { messageId } });
    },
    /** Hands the consumer a message and waits for its async settle to run. */
    async push(body: unknown, messageId = 'evt_a') {
      this.emit(body, messageId);
      await settle();
    },
    connect: async () =>
      ({
        createChannel: async () => channel,
        close: async () => {},
      }) as never,
  };
}

/**
 * Lets every pending promise resolve, without depending on wall-clock time.
 *
 * `setImmediate` runs after the microtask queue drains, so a few turns of it settle the consumer's
 * chain deterministically. A `setTimeout` version passes on an idle machine and fails under a loaded
 * test runner - which is exactly how this file first went red.
 */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function event(overrides: Partial<DomainEvent> = {}): Record<string, unknown> {
  return {
    id: 'evt_a',
    type: 'case.decided',
    tenantId: 'tenant_demo',
    aggregateType: 'case',
    aggregateId: 'case_a',
    occurredAt: '2026-09-09T10:00:00.000Z',
    sequence: 1,
    payload: {
      reference: 'SUP-1',
      outcome: 'approve',
      decidedByUserId: 'user_a',
      caseCreatedAt: '2026-09-08T10:00:00.000Z',
    },
    ...overrides,
  };
}

describe('analytics consumer', () => {
  it('declares a durable queue that dead-letters, and binds only the types it handles', async () => {
    const broker = fakeBroker();
    const consumer = await startAnalyticsConsumer({
      url: 'amqp://x',
      queue: 'analytics.events',
      prefetch: 16,
      handle: async () => {},
      connect: broker.connect,
    });

    expect(broker.recorded.exchanges).toEqual([
      { name: EVENT_EXCHANGE, type: 'topic', durable: true },
      { name: EVENT_DLX, type: 'topic', durable: true },
    ]);
    // The dead-letter argument is set at creation because queue arguments are immutable: adding it
    // later is refused with PRECONDITION_FAILED and can only be resolved by deleting the queue.
    const work = broker.recorded.queues.find((queue) => queue.name === 'analytics.events');
    expect(work?.options).toEqual({
      durable: true,
      arguments: { 'x-dead-letter-exchange': EVENT_DLX },
    });
    expect(broker.recorded.queues.map((queue) => queue.name)).toContain('analytics.events.dlq');

    // One binding per event type analytics has actually decided to handle - not `#`, which would
    // silently adopt whatever a publisher adds to the contract next.
    expect(
      broker.recorded.bindings
        .filter((binding) => binding.queue === 'analytics.events')
        .map((binding) => binding.pattern),
    ).toEqual([...ANALYTICS_BINDINGS]);
    expect(broker.recorded.prefetch).toBe(16);

    await consumer.close();
  });

  it('acks only after the projection succeeded', async () => {
    const broker = fakeBroker();
    const seen: string[] = [];
    await startAnalyticsConsumer({
      url: 'amqp://x',
      queue: 'analytics.events',
      prefetch: 16,
      handle: async (incoming) => {
        seen.push(incoming.id);
      },
      connect: broker.connect,
    });

    await broker.push(event());
    expect(seen).toEqual(['evt_a']);
    expect(broker.recorded.acked).toEqual(['evt_a']);
    expect(broker.recorded.nacked).toEqual([]);
  });

  it('dead-letters a message it cannot parse without offering it to the projection', async () => {
    const broker = fakeBroker();
    const seen: string[] = [];
    const errors: Error[] = [];
    await startAnalyticsConsumer({
      url: 'amqp://x',
      queue: 'analytics.events',
      prefetch: 16,
      handle: async (incoming) => {
        seen.push(incoming.id);
      },
      connect: broker.connect,
      onError: (error) => errors.push(error),
    });

    await broker.push({ id: 'evt_bad', type: 'case.exploded' }, 'evt_bad');

    expect(seen).toEqual([]);
    // requeue=false, or the same unparseable message comes straight back and spins.
    expect(broker.recorded.nacked).toEqual([{ id: 'evt_bad', requeue: false }]);
    expect(broker.recorded.acked).toEqual([]);
    expect(errors[0]?.message).toContain('evt_bad');
  });

  it('settles one delivery at a time, so events about the same aggregate cannot race', async () => {
    // The regression this guards was found in a live run, not in a test: prefetch bounds what the
    // broker pushes, not what the consumer works on. Handling deliveries concurrently let a
    // case.decided transaction open before the case.created it depends on had committed, and a real
    // decision was attributed to an unknown domain pack.
    //
    // Asserted with gates rather than delays. A sleep-based version passes on an idle machine and
    // fails under a loaded runner, which makes it a source of noise rather than a guard.
    const broker = fakeBroker();
    const started: string[] = [];
    const gates: Array<() => void> = [];

    await startAnalyticsConsumer({
      url: 'amqp://x',
      queue: 'analytics.events',
      prefetch: 16,
      handle: async (incoming) => {
        started.push(incoming.id);
        await new Promise<void>((resolve) => gates.push(resolve));
      },
      connect: broker.connect,
    });

    // Three deliveries pushed back to back, as a broker with prefetch 16 would.
    broker.emit(event({ id: 'evt_1' }), 'evt_1');
    broker.emit(event({ id: 'evt_2' }), 'evt_2');
    broker.emit(event({ id: 'evt_3' }), 'evt_3');
    await settle();

    // Only the first has been offered to the projection; the other two are waiting their turn.
    expect(started).toEqual(['evt_1']);

    gates[0]!();
    await settle();
    expect(started).toEqual(['evt_1', 'evt_2']);
    expect(broker.recorded.acked).toEqual(['evt_1']);

    gates[1]!();
    await settle();
    expect(started).toEqual(['evt_1', 'evt_2', 'evt_3']);

    gates[2]!();
    await settle();
    expect(broker.recorded.acked).toEqual(['evt_1', 'evt_2', 'evt_3']);
  });

  it('does not ack an event whose projection threw', async () => {
    const broker = fakeBroker();
    const errors: Error[] = [];
    await startAnalyticsConsumer({
      url: 'amqp://x',
      queue: 'analytics.events',
      prefetch: 16,
      handle: async () => {
        throw new Error('projection database unreachable');
      },
      connect: broker.connect,
      onError: (error) => errors.push(error),
    });

    await broker.push(event());

    // Acking on receipt would lose the fact outright; the broker has already forgotten it.
    expect(broker.recorded.acked).toEqual([]);
    expect(broker.recorded.nacked).toEqual([{ id: 'evt_a', requeue: false }]);
    expect(errors[0]?.message).toContain('projection database unreachable');
  });
});
