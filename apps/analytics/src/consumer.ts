import amqp, { type ChannelModel, type ConfirmChannel, type ConsumeMessage } from 'amqplib';
import {
  EVENT_EXCHANGE,
  isReplayControl,
  parseDomainEvent,
  type DomainEvent,
  type ReplayStarted,
} from '@caselens/events';

/**
 * Where a message goes when analytics cannot process it.
 *
 * A rejected message with no dead-letter exchange is simply discarded, which is the worst of the
 * options: the fact is gone from the queue and nobody is told. Routing it here keeps it inspectable.
 */
export const EVENT_DLX = 'caselens.events.dlx';

/**
 * The event types analytics has decided it cares about.
 *
 * Listed rather than derived from `DomainEventTypeSchema`, and deliberately not `#`. Either of
 * those would mean a new event type added to the shared contract silently starts arriving here
 * before anyone has decided what the projection should do with it. A binding is a consumer stating
 * its interest; generating it from the publisher's vocabulary gives that decision back to the
 * publisher.
 */
export const ANALYTICS_BINDINGS = ['case.created', 'case.decided', 'finding.raised'] as const;

/**
 * A replay stream carries the same facts plus the control message that opens it, so its queue binds
 * one extra key. Still enumerated rather than `#`, for the same reason.
 */
export const ANALYTICS_REPLAY_BINDINGS = ['replay.started', ...ANALYTICS_BINDINGS] as const;

/**
 * How long a failed delivery waits before it is offered again, per attempt.
 *
 * RabbitMQ has no delayed redelivery - the one thing BullMQ provides for free and this does not.
 * The standard reconstruction is a queue whose messages expire and dead-letter back to the work
 * queue, so an expired message returns for another attempt.
 *
 * One queue per delay rather than a per-message TTL on a single queue. A queue only ever expires
 * the message at its head, so with mixed TTLs a message waiting 25 seconds holds up every message
 * behind it, however short their own wait. That is the classic trap in this pattern; separate
 * queues cannot hit it, because within each one every message waits the same amount of time.
 */
export const RETRY_DELAYS_MS = [1_000, 5_000, 25_000] as const;

/** The header a delivery carries its attempt count in, since a message body is a fact and must not
 * be edited to record what the transport did with it. */
export const ATTEMPT_HEADER = 'x-attempt';

export function retryQueueName(queue: string, delayMs: number): string {
  return `${queue}.retry.${delayMs / 1000}s`;
}

export interface AnalyticsConsumerOptions {
  url: string;
  queue: string;
  /** Defaults to the live exchange; a replay consumer points at the replay one instead. */
  exchange?: string;
  /**
   * How many unacknowledged messages the broker may have in flight. Without a limit RabbitMQ pushes
   * the entire backlog at once and a slow projection buffers it in memory instead of leaving it
   * durable in the queue.
   */
  prefetch: number;
  bindings?: readonly string[];
  handle: (event: DomainEvent) => Promise<void>;
  /**
   * Called for a control message rather than a fact. Absent on the live stream, where a control
   * message would be a publisher bug and is dead-lettered like anything else unreadable.
   */
  onControl?: (control: ReplayStarted) => Promise<void>;
  /** Injectable so a test can assert topology and ack behaviour without a broker. */
  connect?: (url: string) => Promise<ChannelModel>;
  onError?: (error: Error) => void;
}

export interface AnalyticsConsumer {
  close(): Promise<void>;
}

/**
 * The consuming half of the event backbone: a queue bound to the topic exchange, drained into a
 * projection.
 *
 * Delivery is at-least-once, so this will be handed the same event more than once - a relay that
 * crashed between the broker's confirm and its own `published_at` stamp republishes on the next
 * pass. Nothing here dedupes yet; that arrives with the projection store, where the check and the
 * write can share one transaction.
 */
export async function startAnalyticsConsumer(
  options: AnalyticsConsumerOptions,
): Promise<AnalyticsConsumer> {
  const connect = options.connect ?? ((url: string) => amqp.connect(url));
  const connection = await connect(options.url);
  // A confirm channel, because a failed delivery is moved to a retry queue and only then
  // acknowledged. Without confirms, a publish that the broker never accepted would be followed by an
  // ack that discards the original, and the event would be lost with nothing to show for it.
  const channel: ConfirmChannel = await connection.createConfirmChannel();

  // Both sides assert the topology they depend on. The relay declares the exchange too, so either
  // service can start first, in any order, on an empty broker - and neither has to be taught about
  // the other's deployment.
  const exchange = options.exchange ?? EVENT_EXCHANGE;
  await channel.assertExchange(exchange, 'topic', { durable: true });
  await channel.assertExchange(EVENT_DLX, 'topic', { durable: true });

  // Bound to this queue's own name, not `#`. Two consumers sharing one dead-letter exchange with
  // wildcard bindings both receive every dead letter, so each one's DLQ fills with the other's
  // failures - which turns the first thing anyone looks at during an incident into a list of
  // problems that may belong to a different service. Measured, not theoretical: one unparseable
  // message on the live queue landed in the replay consumer's DLQ too.
  const deadLetterQueue = `${options.queue}.dlq`;
  await channel.assertQueue(deadLetterQueue, { durable: true });
  await channel.bindQueue(deadLetterQueue, EVENT_DLX, options.queue);

  // `x-dead-letter-exchange` is set now, before anything uses it, because queue arguments are
  // immutable in RabbitMQ: redeclaring an existing queue with different arguments is refused with
  // PRECONDITION_FAILED, and the only remedy is deleting the queue along with whatever it holds.
  // Adding the argument later would therefore be a destructive migration rather than a config edit.
  await channel.assertQueue(options.queue, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': EVENT_DLX,
      // Overrides the original routing key, which RabbitMQ would otherwise preserve - a dead
      // `case.created` would arrive at the exchange still keyed `case.created` and match any
      // consumer listening for it.
      'x-dead-letter-routing-key': options.queue,
    },
  });
  for (const pattern of options.bindings ?? ANALYTICS_BINDINGS) {
    await channel.bindQueue(options.queue, exchange, pattern);
  }

  // Each retry queue expires its messages back onto the work queue. The empty dead-letter exchange
  // is the default exchange, which routes by queue name, so the routing key is where the message
  // returns to.
  for (const delay of RETRY_DELAYS_MS) {
    await channel.assertQueue(retryQueueName(options.queue, delay), {
      durable: true,
      arguments: {
        'x-message-ttl': delay,
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': options.queue,
      },
    });
  }
  await channel.prefetch(options.prefetch);

  /**
   * Sends a failed delivery to the next retry tier, or to the dead-letter queue once the attempts
   * are spent.
   *
   * Republishing and then acknowledging is not atomic, so a crash between the two leaves the
   * original to be redelivered while the retry copy also exists. That produces a duplicate, which is
   * the same at-least-once bargain the whole pipeline already makes and which the consumer's
   * dedupe absorbs. The alternative - acknowledging first - would lose the event outright on the
   * same crash, and a lost fact cannot be absorbed by anything.
   */
  const retryOrDeadLetter = async (message: ConsumeMessage, reason: string): Promise<void> => {
    const attempt = Number(message.properties.headers?.[ATTEMPT_HEADER] ?? 0);
    const delay = RETRY_DELAYS_MS[attempt];

    if (delay === undefined) {
      options.onError?.(
        new Error(`Giving up after ${attempt} attempts, dead-lettering: ${reason}`),
      );
      channel.nack(message, false, false);
      return;
    }

    const accepted = await new Promise<boolean>((resolve) => {
      channel.sendToQueue(
        retryQueueName(options.queue, delay),
        message.content,
        {
          ...message.properties,
          persistent: true,
          headers: { ...message.properties.headers, [ATTEMPT_HEADER]: attempt + 1 },
        },
        (error) => resolve(!error),
      );
    });
    if (!accepted) {
      // The retry copy was refused, so the original must stay in the queue. Requeueing here is safe
      // precisely because nothing was published: this is not a hot loop, it is the only copy.
      options.onError?.(new Error(`Could not schedule a retry, requeueing: ${reason}`));
      channel.nack(message, false, true);
      return;
    }
    options.onError?.(new Error(`Retry ${attempt + 1} in ${delay}ms: ${reason}`));
    channel.ack(message);
  };

  const onMessage = async (message: ConsumeMessage | null): Promise<void> => {
    // Null means the broker cancelled the consumer - the queue was deleted out from under it.
    if (!message) return;

    let body: unknown;
    try {
      body = JSON.parse(message.content.toString());
    } catch (error) {
      // Permanent, and distinct from a failure to process: no retry will make this parse. Retrying
      // it would burn three delays to reach the conclusion already available now.
      options.onError?.(
        new Error(
          `Undeliverable message ${message.properties.messageId ?? 'unknown'}: ${(error as Error).message}`,
        ),
      );
      channel.nack(message, false, false);
      return;
    }

    if (options.onControl && isReplayControl(body)) {
      try {
        // Control is settled the same way a fact is: acknowledged only once acted on, so a crash
        // mid-reset redelivers the instruction rather than dropping it and replaying history onto a
        // projection that was never cleared.
        await options.onControl(body);
        channel.ack(message);
      } catch (error) {
        await retryOrDeadLetter(message, `replay reset failed: ${(error as Error).message}`);
      }
      return;
    }

    let event: DomainEvent;
    try {
      event = parseDomainEvent(body);
    } catch (error) {
      options.onError?.(
        new Error(
          `Undeliverable message ${message.properties.messageId ?? 'unknown'}: ${(error as Error).message}`,
        ),
      );
      channel.nack(message, false, false);
      return;
    }

    try {
      await options.handle(event);
      // Acked only after the handler succeeded. Acking on receipt would mean a crash mid-projection
      // loses the event, since the broker has already forgotten it.
      channel.ack(message);
    } catch (error) {
      // A projection failure is usually the projection's fault, not the message's - the database
      // briefly unreachable, a lock timeout - so it earns a delayed retry rather than immediate
      // dead-lettering. Only a message that has spent every attempt is set aside.
      await retryOrDeadLetter(
        message,
        `projection failed for ${event.id}: ${(error as Error).message}`,
      );
    }
  };

  // Deliveries are settled one at a time, in the order the broker sent them.
  //
  // `prefetch` bounds how many messages the broker may push, not how many this service may work on
  // at once. Launching the async handler per delivery and forgetting it - which is what
  // `void onMessage(message)` does - lets sixteen of them run concurrently, and two events about
  // the same case then race. That is not hypothetical: a `case.decided` transaction opened 2.5ms
  // after its `case.created` and before that one had committed, saw no case dimension under READ
  // COMMITTED, and attributed a real decision to an unknown domain pack.
  //
  // Chaining keeps the throughput benefit of prefetch - the next message is already in memory
  // rather than a round trip away - while removing the concurrency that broke causal order.
  let settling: Promise<void> = Promise.resolve();
  await channel.consume(
    options.queue,
    (message) => {
      settling = settling.then(() => onMessage(message)).catch(() => {});
    },
    { noAck: false },
  );

  return {
    async close(): Promise<void> {
      await channel.close().catch(() => {});
      await connection.close().catch(() => {});
    },
  };
}
