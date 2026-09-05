import { z } from 'zod';

/**
 * The shared definition of every domain fact CaseLens publishes.
 *
 * This package is deliberately separate from `@caselens/contracts`, which describes the HTTP API.
 * An event is not a response shape: it is a statement that something happened, addressed to
 * nobody in particular, and its schema is the only thing a publisher and a consumer in different
 * services agree on. Keeping it in one package means the wire format has a single definition
 * rather than a copy on each side that can drift - the failure mode this codebase has already
 * seen once, when the case API and its declared contract described different models for weeks.
 */

/** Events are named for what happened, in the past tense. Never for what should happen next. */
export const DomainEventTypeSchema = z.enum(['case.created', 'case.decided', 'finding.raised']);
export type DomainEventType = z.infer<typeof DomainEventTypeSchema>;

export const CaseCreatedPayloadSchema = z.object({
  reference: z.string().min(1),
  domainPackId: z.string().min(1),
  domainPackVersion: z.string().min(1),
});

export const CaseDecidedPayloadSchema = z.object({
  reference: z.string().min(1),
  outcome: z.enum(['approve', 'reject', 'request_information']),
  decidedByUserId: z.string().min(1),
  /**
   * Carried on the event rather than looked up later. A consumer that had to query the case
   * service to interpret a fact would be coupled to it at read time, which is the coupling the
   * event exists to remove.
   */
  caseCreatedAt: z.iso.datetime(),
});

export const FindingRaisedPayloadSchema = z.object({
  caseId: z.string().min(1),
  ruleKey: z.string().min(1),
  severity: z.enum(['info', 'minor', 'major', 'critical']),
});

const payloadByType = {
  'case.created': CaseCreatedPayloadSchema,
  'case.decided': CaseDecidedPayloadSchema,
  'finding.raised': FindingRaisedPayloadSchema,
} as const;

/**
 * The envelope every event shares. `id` is the consumer's idempotency key: delivery is
 * at-least-once, so a consumer must be able to see the same event twice and act once.
 * `sequence` is assigned by the outbox, so a replay can be ordered even though `occurredAt`
 * is only as precise as the clock that wrote it.
 */
export const DomainEventEnvelopeSchema = z.object({
  id: z.string().min(1),
  type: DomainEventTypeSchema,
  tenantId: z.string().min(1),
  aggregateType: z.enum(['case', 'finding']),
  aggregateId: z.string().min(1),
  occurredAt: z.iso.datetime(),
  sequence: z.number().int().positive(),
  payload: z.unknown(),
});

export type DomainEventEnvelope = z.infer<typeof DomainEventEnvelopeSchema>;

export type DomainEvent = {
  [Type in DomainEventType]: Omit<DomainEventEnvelope, 'type' | 'payload'> & {
    type: Type;
    payload: z.infer<(typeof payloadByType)[Type]>;
  };
}[DomainEventType];

/**
 * Parses one delivered message into a typed event, validating the payload against the schema its
 * own `type` selects. A consumer must never trust the wire: a message can arrive from an older
 * publisher, a replay, or a hand-written test, and a malformed one belongs in the dead-letter
 * queue rather than in a projection.
 */
export function parseDomainEvent(input: unknown): DomainEvent {
  const envelope = DomainEventEnvelopeSchema.parse(input);
  const payload = payloadByType[envelope.type].parse(envelope.payload);
  return { ...envelope, payload } as DomainEvent;
}

/** The routing key an event is published with. The type is the key; bindings select on it. */
export function routingKeyFor(type: DomainEventType): string {
  return type;
}

export const EVENT_EXCHANGE = 'caselens.events';
