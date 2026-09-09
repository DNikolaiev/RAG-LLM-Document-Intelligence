import { describe, expect, it } from 'vitest';
import { REPLAY_EXCHANGE } from '@caselens/events';
import type { StoredDomainEvent } from '@caselens/persistence';
import { replayOutbox, type ReplaySource } from '../src/events/replay.js';

interface Published {
  exchange: string;
  routingKey: string;
  body: Record<string, unknown>;
}

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
      _options: unknown,
      callback: (error?: Error) => void,
    ) {
      if (published.length >= refuseFrom) {
        callback(new Error('broker refused'));
        return true;
      }
      published.push({ exchange, routingKey, body: JSON.parse(content.toString()) });
      callback();
      return true;
    },
    async close() {},
  };
  return {
    published,
    asserted,
    connect: async () =>
      ({ createConfirmChannel: async () => channel, close: async () => {} }) as never,
  };
}

/** Pages by sequence, the way the real store does, so the paging itself is exercised. */
function sourceOf(rows: StoredDomainEvent[]): ReplaySource {
  return {
    async readEventsForReplay(afterSequence: number, limit: number) {
      return rows.filter((row) => row.sequence > afterSequence).slice(0, limit);
    },
  };
}

function row(id: string, sequence: number, type = 'case.created'): StoredDomainEvent {
  return {
    id,
    sequence,
    tenantId: 'tenant_demo',
    type,
    aggregateType: 'case',
    aggregateId: `case_${id}`,
    occurredAt: '2026-09-09T10:00:00.000Z',
    // The payload has to match the type, because the replay validates against the same contract the
    // live path does - which is the point: a rebuild that shipped rows the live path would reject
    // would put the failure into every consumer instead of the one place that can still see it.
    payload:
      type === 'case.decided'
        ? {
            reference: 'R-1',
            outcome: 'approve',
            decidedByUserId: 'user_a',
            caseCreatedAt: '2026-09-08T10:00:00.000Z',
          }
        : { reference: 'R-1', domainPackId: 'pack_a', domainPackVersion: '1.0.0' },
  };
}

describe('outbox replay', () => {
  it('opens with the control message, then history in sequence order', async () => {
    const broker = fakeBroker();
    const result = await replayOutbox({
      url: 'amqp://x',
      source: sourceOf([row('evt_a', 1), row('evt_b', 2), row('evt_c', 3)]),
      replayId: 'replay_1',
      // Small enough that the loop has to page, which is where an off-by-one would show.
      batchSize: 2,
      connect: broker.connect,
    });

    expect(broker.asserted).toEqual([{ name: REPLAY_EXCHANGE, type: 'topic' }]);
    // Not the live exchange: republishing history there would deliver it to every bound consumer,
    // so one service rebuilding would flood services that never asked for a replay.
    expect(broker.published.every((message) => message.exchange === REPLAY_EXCHANGE)).toBe(true);

    // Control first, and on the same queue as the facts, so ordering is the broker's guarantee
    // rather than two services agreeing to take turns.
    expect(broker.published[0]!.routingKey).toBe('replay.started');
    expect(broker.published[0]!.body).toMatchObject({
      control: 'replay.started',
      replayId: 'replay_1',
    });
    expect(broker.published.slice(1).map((message) => message.body.id)).toEqual([
      'evt_a',
      'evt_b',
      'evt_c',
    ]);
    expect(result).toEqual({ published: 3, skipped: 0, lastSequence: 3 });
  });

  it('replays a fact the live path can never redeliver', async () => {
    // The case this exists for: an event published when the exchange had no bindings. RabbitMQ
    // discarded it, `published_at` is stamped so the relay will never send it again, and the only
    // remaining copy is the outbox row.
    const broker = fakeBroker();
    const result = await replayOutbox({
      url: 'amqp://x',
      source: sourceOf([row('evt_orphaned', 1, 'case.decided')]),
      replayId: 'replay_2',
      connect: broker.connect,
    });
    // `readEventsForReplay` ignores published_at entirely - delivery state is the relay's business,
    // and a rebuild is re-derivation rather than re-delivery.
    expect(result.published).toBe(1);
  });

  it('skips a row the current contract cannot read instead of abandoning the rebuild', async () => {
    // History accumulates across schema versions. Refusing to replay anything because one ancient
    // row no longer parses would make the mechanism unusable exactly when it is needed.
    const broker = fakeBroker();
    const errors: Error[] = [];
    const result = await replayOutbox({
      url: 'amqp://x',
      source: sourceOf([row('evt_old', 1, 'case.retired'), row('evt_good', 2)]),
      replayId: 'replay_3',
      connect: broker.connect,
      onError: (error) => errors.push(error),
    });

    expect(result).toEqual({ published: 1, skipped: 1, lastSequence: 2 });
    expect(broker.published.slice(1).map((message) => message.body.id)).toEqual(['evt_good']);
    expect(errors[0]?.message).toContain('evt_old');
  });

  it('stops on a refusal rather than rebuilding from a hole in history', async () => {
    // A projection rebuilt from a partial replay is worse than the stale one it replaced, because
    // it looks complete.
    const broker = fakeBroker(2);
    await expect(
      replayOutbox({
        url: 'amqp://x',
        source: sourceOf([row('evt_a', 1), row('evt_b', 2), row('evt_c', 3)]),
        replayId: 'replay_4',
        connect: broker.connect,
      }),
    ).rejects.toThrow('Broker refused');
    expect(broker.published).toHaveLength(2);
  });
});
