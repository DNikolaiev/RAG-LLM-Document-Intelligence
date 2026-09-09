import amqp, { type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib';
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
  const channel: Channel = await connection.createChannel();

  // Both sides assert the topology they depend on. The relay declares the exchange too, so either
  // service can start first, in any order, on an empty broker - and neither has to be taught about
  // the other's deployment.
  const exchange = options.exchange ?? EVENT_EXCHANGE;
  await channel.assertExchange(exchange, 'topic', { durable: true });
  await channel.assertExchange(EVENT_DLX, 'topic', { durable: true });

  const deadLetterQueue = `${options.queue}.dlq`;
  await channel.assertQueue(deadLetterQueue, { durable: true });
  await channel.bindQueue(deadLetterQueue, EVENT_DLX, '#');

  // `x-dead-letter-exchange` is set now, before anything uses it, because queue arguments are
  // immutable in RabbitMQ: redeclaring an existing queue with different arguments is refused with
  // PRECONDITION_FAILED, and the only remedy is deleting the queue along with whatever it holds.
  // Adding the argument later would therefore be a destructive migration rather than a config edit.
  await channel.assertQueue(options.queue, {
    durable: true,
    arguments: { 'x-dead-letter-exchange': EVENT_DLX },
  });
  for (const pattern of options.bindings ?? ANALYTICS_BINDINGS) {
    await channel.bindQueue(options.queue, exchange, pattern);
  }
  await channel.prefetch(options.prefetch);

  const onMessage = async (message: ConsumeMessage | null): Promise<void> => {
    // Null means the broker cancelled the consumer - the queue was deleted out from under it.
    if (!message) return;

    let event: DomainEvent;
    try {
      const body: unknown = JSON.parse(message.content.toString());
      if (options.onControl && isReplayControl(body)) {
        // Control is settled the same way a fact is: acknowledged only once acted on, so a crash
        // mid-reset redelivers the instruction rather than dropping it and replaying history onto a
        // projection that was never cleared.
        await options.onControl(body);
        channel.ack(message);
        return;
      }
      event = parseDomainEvent(body);
    } catch (error) {
      // Requeueing would be a hot loop: nothing about this message improves by trying it again.
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
      // Provisional: a transient failure - the projection database briefly unreachable - is not the
      // message's fault and deserves a retry, but retrying without an attempt counter is a hot
      // loop. Dead-lettering makes the failure visible instead of invisible while the retry queue
      // is still to be built.
      options.onError?.(
        new Error(`Projection failed for ${event.id}: ${(error as Error).message}`),
      );
      channel.nack(message, false, false);
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
