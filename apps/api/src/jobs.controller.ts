import { Controller, Get, Param } from '@nestjs/common';
import { CasesService } from './cases.service.js';
import { Context, type RequestContext } from './request-context.js';

@Controller('v1/jobs')
export class JobsController {
  constructor(private readonly cases: CasesService) {}

  @Get(':id')
  get(@Context() context: RequestContext, @Param('id') id: string) {
    return this.cases.getJob(context.tenantId, id);
  }
}
