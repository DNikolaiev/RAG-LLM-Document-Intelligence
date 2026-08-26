import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadConfig } from '@caselens/config';
import { WorkerModule } from './worker.module.js';

export async function bootstrap(): Promise<void> {
  const config = loadConfig();
  if (config.APP_MODE === 'production') {
    throw new Error(
      'Production worker composition is not enabled yet. Run APP_MODE=demo or bind BullMQ and durable workflow checkpoints first.',
    );
  }
  const application = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });
  application.enableShutdownHooks();
  Logger.log(`Worker ready with queue provider ${config.QUEUE_PROVIDER}`, 'Bootstrap');
}

if (process.env.NODE_ENV !== 'test') void bootstrap();
