import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { loadConfig } from '@caselens/config';
import { AppModule } from './app.module.js';
import { ProblemDetailsFilter } from './problem.filter.js';

export async function bootstrap(): Promise<void> {
  const config = loadConfig();
  if (config.APP_MODE === 'production') {
    throw new Error(
      'Production runtime composition is not enabled yet. Run APP_MODE=demo or bind durable repositories, verified OIDC, BullMQ, and object storage first.',
    );
  }
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.enableCors({
    origin: config.APP_MODE === 'demo' ? true : config.PUBLIC_API_URL,
    credentials: false,
  });
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.enableShutdownHooks();

  const openApi = new DocumentBuilder()
    .setTitle('CaseLens API')
    .setDescription('Evidence-backed, domain-configurable document review API')
    .setVersion('1.0.0')
    .addApiKey({ type: 'apiKey', in: 'header', name: 'x-tenant-id' }, 'tenant')
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, openApi));

  await app.listen(config.API_PORT, '0.0.0.0');
  Logger.log(`CaseLens API listening on ${config.API_PORT}`, 'Bootstrap');
}

if (process.env.NODE_ENV !== 'test') {
  void bootstrap();
}
