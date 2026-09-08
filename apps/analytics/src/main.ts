import { loadConfig } from '@caselens/config';
import { startAnalyticsConsumer } from './consumer.js';

/**
 * A deliberately plain logger. This service imports no framework: the point of it is that a second
 * service can be built against nothing but the event contract, and pulling NestJS in here would
 * quietly make it look like another arm of the same application.
 */
function log(message: string): void {
  process.stdout.write(`[analytics] ${message}\n`);
}

export async function bootstrap(): Promise<void> {
  const config = loadConfig();
  if (!config.RABBITMQ_URL) throw new Error('Analytics requires RABBITMQ_URL');

  const consumer = await startAnalyticsConsumer({
    url: config.RABBITMQ_URL,
    queue: config.ANALYTICS_QUEUE_NAME,
    prefetch: config.ANALYTICS_PREFETCH,
    handle: async (event) => {
      // No projection yet. This step exists to close the gap where the exchange had no bindings at
      // all and every published fact was discarded on arrival, so what it proves is delivery: a
      // decision made in the API reaches a service the API knows nothing about.
      log(
        `${event.type} seq=${event.sequence} tenant=${event.tenantId} aggregate=${event.aggregateId}`,
      );
    },
    onError: (error) => process.stderr.write(`[analytics] ${error.message}\n`),
  });
  log(`Consuming ${config.ANALYTICS_QUEUE_NAME} with prefetch ${config.ANALYTICS_PREFETCH}`);

  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await consumer.close();
}

if (process.env.NODE_ENV !== 'test') void bootstrap();
