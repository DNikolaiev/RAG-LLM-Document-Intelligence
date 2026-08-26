import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { CasesController } from './cases.controller.js';
import { CasesService } from './cases.service.js';
import { ContextMiddleware } from './context.middleware.js';
import { DomainPacksController } from './domain-packs.controller.js';
import { HealthController } from './health.controller.js';
import { JobsController } from './jobs.controller.js';

@Module({
  controllers: [HealthController, DomainPacksController, CasesController, JobsController],
  providers: [CasesService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(ContextMiddleware).forRoutes('*');
  }
}
