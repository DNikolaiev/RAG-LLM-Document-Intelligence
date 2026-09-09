import { loadConfig } from '@caselens/config';
import { ANALYTICS_REPLAY_BINDINGS, startAnalyticsConsumer } from './consumer.js';
import { AnalyticsStore } from './store.js';
import { project } from './projections.js';
import { startReadApi } from './read-api.js';
import { REPLAY_EXCHANGE } from '@caselens/events';

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

  // A second queue on a second exchange, so a rebuild does not interleave with live traffic and a
  // replay published for this service is never delivered to consumers that did not ask for one.
  const replayQueue = `${config.ANALYTICS_QUEUE_NAME}.replay`;
  const replayConsumer = await startAnalyticsConsumer({
    url: config.RABBITMQ_URL,
    queue: replayQueue,
    exchange: REPLAY_EXCHANGE,
    bindings: ANALYTICS_REPLAY_BINDINGS,
    prefetch: config.ANALYTICS_PREFETCH,
    onControl: async (control) => {
      // Everything derived is discarded here, `processed_events` included. Keeping the ids would
      // make the rebuild a no-op: every event would report itself already applied and the stale
      // projection would survive the replay untouched.
      await store.reset();
      log(`${control.replayId}: projection cleared, rebuilding from history`);
    },
    handle: async (event) => {
      const outcome = await store.apply(event, (tx) => project(tx, event));
      if (outcome === 'applied') return;
      // Expected during a replay that overlaps live traffic; worth seeing rather than silent.
      log(`replay skipped ${event.id}, already applied`);
    },
    onError: (error) => process.stderr.write(`[analytics] replay: ${error.message}\n`),
  });
  log(`Consuming ${replayQueue} for projection rebuilds`);

  const api = startReadApi({
    store,
    port: config.ANALYTICS_PORT,
    onError: (error) => process.stderr.write(`[analytics] ${error.message}\n`),
  });
  log(`Read API listening on ${config.ANALYTICS_PORT}`);

  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await new Promise<void>((resolve) => api.close(() => resolve()));
  await consumer.close();
  await replayConsumer.close();
  await store.close();
}

if (process.env.NODE_ENV !== 'test') void bootstrap();
