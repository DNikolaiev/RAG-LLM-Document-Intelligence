import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { CasesController } from './cases.controller.js';
import { CasesService } from './cases.service.js';
import { CASES_RUNTIME } from './cases-runtime.js';
import { ContextMiddleware } from './context.middleware.js';
import { DomainPacksController } from './domain-packs.controller.js';
import { HealthController } from './health.controller.js';
import { JobsController } from './jobs.controller.js';
import { loadConfig } from '@caselens/config';
import { ProductionCasesService } from './production-cases.service.js';

@Module({
  controllers: [HealthController, DomainPacksController, CasesController, JobsController],
  providers: [
    {
      provide: CASES_RUNTIME,
      useFactory: () =>
        loadConfig().PERSISTENCE_PROVIDER === 'postgres'
          ? new ProductionCasesService()
          : new CasesService(),
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(ContextMiddleware).forRoutes('*');
  }
}
