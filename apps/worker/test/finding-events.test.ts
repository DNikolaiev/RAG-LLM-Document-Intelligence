import { describe, expect, it } from 'vitest';
import { parseDomainEvent } from '@caselens/events';
import { findingEvents } from '../src/production-runtime.js';

const item = {
  id: 'case_a',
  updatedAt: '2026-09-09T12:00:00.000Z',
  findings: [
    { id: 'finding_1', ruleKey: 'expired-certificate', severity: 'critical' },
    { id: 'finding_2', ruleKey: 'missing-insurance', severity: 'major' },
  ],
};

describe('finding.raised emission', () => {
  it('produces events the shared contract accepts', () => {
    // The assertion that matters. A payload the contract rejects would pass every check here and
    // then dead-letter on the consumer, which is the failure mode `packages/events` exists to make
    // impossible - so the publisher validates against the same schema the consumer will.
    const events = findingEvents(item);
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(() =>
        parseDomainEvent({ ...event, tenantId: 'tenant_demo', sequence: 1 }),
      ).not.toThrow();
    }
    expect(events[0]!.payload).toEqual({
      caseId: 'case_a',
      ruleKey: 'expired-certificate',
      severity: 'critical',
    });
    // The finding is the aggregate; the case travels in the payload so a consumer counting rules
    // never has to ask another service which case fired.
    expect(events[0]!.aggregateType).toBe('finding');
    expect(events[0]!.aggregateId).toBe('finding_1');
  });

  it('gives the same finding the same event id every run', () => {
    // Processing is retried automatically, unlike a decision. Without a deterministic id every
    // retry would raise the same finding again and a noisy rule would look far noisier than it is.
    expect(findingEvents(item).map((event) => event.id)).toEqual(
      findingEvents(item).map((event) => event.id),
    );
    // And different findings must not collide.
    const [first, second] = findingEvents(item);
    expect(first!.id).not.toBe(second!.id);
  });

  it('emits nothing for a case with no findings', () => {
    expect(findingEvents({ id: 'case_b', updatedAt: '2026-09-09T12:00:00.000Z' })).toEqual([]);
  });
});
