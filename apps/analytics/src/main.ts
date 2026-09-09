import { loadConfig } from '@caselens/config';
import { startAnalyticsConsumer } from './consumer.js';
import { AnalyticsStore } from './store.js';
import { project } from './projections.js';
import { startReadApi } from './read-api.js';

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
  if (!config.ANALYTICS_DATABASE_URL) throw new Error('Analytics requires ANALYTICS_DATABASE_URL');

  const store = new AnalyticsStore(config.ANALYTICS_DATABASE_URL);
  const consumer = await startAnalyticsConsumer({
    url: config.RABBITMQ_URL,
    queue: config.ANALYTICS_QUEUE_NAME,
    prefetch: config.ANALYTICS_PREFETCH,
    handle: async (event) => {
      // The claim and the projection share one transaction, so a projection that throws leaves no
      // trace of having succeeded and the event stays deliverable.
      const outcome = await store.apply(event, (tx) => project(tx, event));
      log(`${event.type} seq=${event.sequence} tenant=${event.tenantId} ${outcome}`);
    },
    onError: (error) => process.stderr.write(`[analytics] ${error.message}\n`),
  });
  log(`Consuming ${config.ANALYTICS_QUEUE_NAME} with prefetch ${config.ANALYTICS_PREFETCH}`);

  const api = startReadApi({
    store,
    port: config.ANALYTICS_PORT,
    onError: (error) =>
      process.stderr.write(`[analytics] ${error.message}
`),
  });
  log(`Read API listening on ${config.ANALYTICS_PORT}`);

  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await new Promise<void>((resolve) => api.close(() => resolve()));
  await consumer.close();
  await store.close();
}

if (process.env.NODE_ENV !== 'test') void bootstrap();
