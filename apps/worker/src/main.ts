import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadConfig } from '@caselens/config';
import { WorkerModule } from './worker.module.js';
import { runProductionWorker } from './production-runtime.js';

export async function bootstrap(): Promise<void> {
  const config = loadConfig();
  if (config.APP_MODE === 'production') {
    await runProductionWorker(config);
    return;
  }
  const application = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });
  Logger.log(`Worker ready with queue provider ${config.QUEUE_PROVIDER}`, 'Bootstrap');

  const keepAlive = setInterval(() => undefined, 60_000);
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  clearInterval(keepAlive);
  await application.close();
}

if (process.env.NODE_ENV !== 'test') void bootstrap();
