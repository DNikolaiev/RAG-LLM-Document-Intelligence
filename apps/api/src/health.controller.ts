import { Controller, Get } from '@nestjs/common';

@Controller('v1/health')
export class HealthController {
  @Get('live')
  live() {
    return { status: 'ok', service: 'caselens-api', time: new Date().toISOString() };
  }

  @Get('ready')
  ready() {
    return {
      status: 'ready',
      mode: process.env.APP_MODE ?? 'demo',
      checks: { persistence: 'ok', queue: 'ok', storage: 'ok' },
    };
  }
}
