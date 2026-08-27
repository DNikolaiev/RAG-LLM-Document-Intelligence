import { Controller, Get, Inject, Param } from '@nestjs/common';
import { CASES_RUNTIME, type CasesRuntime } from './cases-runtime.js';
import { Context, type RequestContext } from './request-context.js';

@Controller('v1/jobs')
export class JobsController {
  constructor(@Inject(CASES_RUNTIME) private readonly cases: CasesRuntime) {}

  @Get(':id')
  get(@Context() context: RequestContext, @Param('id') id: string) {
    return this.cases.getJob(context, id);
  }
}
