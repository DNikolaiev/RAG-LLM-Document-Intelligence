import { describe, expect, it } from 'vitest';
import { parseDomainEvent, routingKeyFor, type DomainEvent } from '../src/index.js';

const decided = {
  id: 'evt_01',
  type: 'case.decided',
  tenantId: 'tenant_demo',
  aggregateType: 'case',
  aggregateId: 'case_01J67X4Q7B5E6QG4S9CY0F7R2K',
  occurredAt: '2026-09-06T10:00:00.000Z',
  sequence: 42,
  payload: {
    reference: 'SUP-2026-0142',
    outcome: 'approve',
    decidedByUserId: 'user_mara',
    caseCreatedAt: '2026-09-01T08:00:00.000Z',
  },
};

describe('domain events', () => {
  it('parses a well-formed event and narrows its payload by type', () => {
    const event: DomainEvent = parseDomainEvent(decided);
    expect(event.type).toBe('case.decided');
    if (event.type !== 'case.decided') throw new Error('expected a decision event');
    // Narrowed: this would not compile if the payload were still unknown.
    expect(event.payload.outcome).toBe('approve');
    expect(event.payload.caseCreatedAt).toBe('2026-09-01T08:00:00.000Z');
  });

  it('rejects a payload that does not match the schema its own type selects', () => {
    // A `case.decided` envelope carrying a `finding.raised` payload is exactly the kind of
    // message an older publisher or a bad replay produces. It must be refused at the edge so it
    // lands in the dead-letter queue instead of corrupting a projection.
    expect(() =>
      parseDomainEvent({ ...decided, payload: { caseId: 'c', ruleKey: 'r', severity: 'major' } }),
    ).toThrow();
  });

  it('refuses an unknown event type rather than passing it through', () => {
    expect(() => parseDomainEvent({ ...decided, type: 'case.exploded' })).toThrow();
  });

  it('routes on the event type', () => {
    expect(routingKeyFor('case.decided')).toBe('case.decided');
  });
});
