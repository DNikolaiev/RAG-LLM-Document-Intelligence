import { loadConfig } from '@caselens/config';
import { PostgresCaseStore } from '@caselens/persistence';
import { replayOutbox } from './events/replay.js';

/**
 * Replay is an operational action, so it is a command rather than an API.
 *
 * Giving the worker an admin HTTP surface just to trigger this would mean authenticating it,
 * authorising it, and defending it - a permanent attack surface for something run by hand a few
 * times a year. `docker compose run --rm worker npm run replay` reaches it through the same access
 * control that already governs the deployment.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.RABBITMQ_URL) throw new Error('Replay requires RABBITMQ_URL');
  if (!config.DATABASE_URL) throw new Error('Replay requires DATABASE_URL');

  const replayId = process.env.REPLAY_ID ?? `replay_${Date.now().toString(36)}`;
  const store = new PostgresCaseStore(config.DATABASE_URL);
  process.stdout.write(`[replay] ${replayId}: republishing the outbox\n`);

  try {
    const result = await replayOutbox({
      url: config.RABBITMQ_URL,
      source: store,
      replayId,
      batchSize: config.EVENT_RELAY_BATCH_SIZE,
      onProgress: (message) => process.stdout.write(`[replay] ${message}\n`),
      onError: (error) => process.stderr.write(`[replay] ${error.message}\n`),
    });
    process.stdout.write(
      `[replay] ${replayId}: published ${result.published}, skipped ${result.skipped}, last sequence ${result.lastSequence}\n`,
    );
  } finally {
    await store.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`[replay] failed: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
