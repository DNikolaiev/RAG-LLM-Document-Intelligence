import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { CASES_RUNTIME, type CasesRuntime } from './cases-runtime.js';

@Controller('v1/health')
export class HealthController {
  constructor(@Inject(CASES_RUNTIME) private readonly cases: CasesRuntime) {}

  @Get('live')
  live() {
    return { status: 'ok', service: 'caselens-api', time: new Date().toISOString() };
  }

  @Get('ready')
  async ready() {
    try {
      const checks =
        'health' in this.cases
          ? await this.cases.health()
          : { persistence: 'ok', queue: 'ok', storage: 'ok' };
      return {
        status: 'ready',
        mode: process.env.APP_MODE ?? 'demo',
        checks,
      };
    } catch (error) {
      throw new ServiceUnavailableException({
        code: 'DEPENDENCY_UNAVAILABLE',
        message: error instanceof Error ? error.message : 'A required dependency is unavailable.',
      });
    }
  }
}
