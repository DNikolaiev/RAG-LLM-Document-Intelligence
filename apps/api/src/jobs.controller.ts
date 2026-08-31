import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CASES_RUNTIME, type CasesRuntime } from './cases-runtime.js';
import { Context, type RequestContext } from './request-context.js';
import { parseBody } from './validation.js';

const readEventsSchema = z.object({
  eventIds: z.array(z.string().min(1)).min(1).max(100),
});

@Controller('v1/jobs')
export class JobsController {
  constructor(@Inject(CASES_RUNTIME) private readonly cases: CasesRuntime) {}

  @Get()
  list(@Context() context: RequestContext, @Query('limit') rawLimit?: string) {
    const limit = Number(rawLimit ?? 30);
    return this.cases.listJobs(
      context,
      Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 30,
    );
  }

  @Get(':id')
  get(@Context() context: RequestContext, @Param('id') id: string) {
    return this.cases.getJob(context, id);
  }

  @Post('events/read')
  markRead(@Context() context: RequestContext, @Body() body: unknown) {
    return this.cases.markJobEventsRead(context, parseBody(readEventsSchema, body).eventIds);
  }

  @Get(':id/events')
  events(@Context() context: RequestContext, @Param('id') id: string) {
    return this.cases.getJobEvents(context, id);
  }

  @Post(':id/cancel')
  cancel(@Context() context: RequestContext, @Param('id') id: string) {
    return this.cases.cancelJob(context, id);
  }

  @Post(':id/retry')
  retry(@Context() context: RequestContext, @Param('id') id: string) {
    return this.cases.retryJob(context, id);
  }
}
