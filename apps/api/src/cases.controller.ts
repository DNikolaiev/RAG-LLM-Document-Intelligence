import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import { CasesService } from './cases.service.js';
import type { CaseStatus } from './demo-data.js';
import { Context, type RequestContext } from './request-context.js';
import { parseBody } from './validation.js';

const correctionSchema = z.object({
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  reason: z.string().trim().min(8).max(500),
  version: z.number().int().positive(),
});
const findingSchema = z.object({
  status: z.enum(['accepted', 'dismissed', 'resolved']),
  reason: z.string().trim().min(8).max(500),
  version: z.number().int().positive(),
});
const decisionSchema = z.object({
  outcome: z.enum(['approve', 'reject', 'request_information']),
  reason: z.string().trim().min(12).max(1000),
  version: z.number().int().positive(),
});
const createCaseSchema = z.object({
  subjectName: z.string().trim().min(2).max(200),
  domainPackId: z.string().min(1),
  reference: z.string().trim().min(3).max(80).optional(),
});
const listCasesSchema = z.object({
  status: z
    .enum(['processing', 'needs_review', 'request_information', 'approved', 'rejected'])
    .optional(),
  query: z.string().trim().max(200).optional(),
  cursor: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

@Controller('v1/cases')
export class CasesController {
  constructor(private readonly cases: CasesService) {}

  @Post()
  create(
    @Context() context: RequestContext,
    @Body() body: unknown,
    @Headers('idempotency-key') key = `implicit-${context.correlationId}`,
  ) {
    return this.cases.create(context, parseBody(createCaseSchema, body), key);
  }

  @Get()
  list(
    @Context() context: RequestContext,
    @Query('status') status?: CaseStatus,
    @Query('q') query?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const parsed = parseBody(listCasesSchema, { status, query, cursor, limit: limit ?? 20 });
    return this.cases.list(
      context.tenantId,
      parsed.status,
      parsed.query,
      parsed.cursor,
      parsed.limit,
    );
  }

  @Get(':id')
  get(@Context() context: RequestContext, @Param('id') id: string) {
    return this.cases.get(context.tenantId, id);
  }

  @Get(':id/audit')
  audit(@Context() context: RequestContext, @Param('id') id: string) {
    return { items: this.cases.get(context.tenantId, id).audit };
  }

  @Get(':id/export')
  export(@Context() context: RequestContext, @Param('id') id: string) {
    return this.cases.export(context.tenantId, id);
  }

  @Patch(':id/facts/:factId')
  correctFact(
    @Context() context: RequestContext,
    @Param('id') id: string,
    @Param('factId') factId: string,
    @Body() body: unknown,
  ) {
    return this.cases.correctFact(context, id, factId, parseBody(correctionSchema, body));
  }

  @Patch(':id/findings/:findingId')
  resolveFinding(
    @Context() context: RequestContext,
    @Param('id') id: string,
    @Param('findingId') findingId: string,
    @Body() body: unknown,
  ) {
    return this.cases.resolveFinding(context, id, findingId, parseBody(findingSchema, body));
  }

  @Post(':id/process')
  process(
    @Context() context: RequestContext,
    @Param('id') id: string,
    @Headers('idempotency-key') key = `implicit-${context.correlationId}`,
  ) {
    return this.cases.process(context, id, key);
  }

  @Post(':id/documents')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 15 * 1024 * 1024, files: 1 } }))
  upload(
    @Context() context: RequestContext,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Headers('idempotency-key') key = `implicit-${context.correlationId}`,
  ) {
    if (!file)
      throw new BadRequestException({
        code: 'FILE_REQUIRED',
        message: 'Attach one file in the multipart field named file.',
      });
    return this.cases.uploadDocument(context, id, file, key);
  }

  @Post(':id/re-evaluate')
  reEvaluate(
    @Context() context: RequestContext,
    @Param('id') id: string,
    @Headers('idempotency-key') key = `implicit-${context.correlationId}`,
  ) {
    return this.cases.reEvaluate(context, id, key);
  }

  @Post(':id/decisions')
  decide(@Context() context: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.cases.decide(context, id, parseBody(decisionSchema, body));
  }
}
