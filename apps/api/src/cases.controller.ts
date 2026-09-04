import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { loadConfig } from '@caselens/config';
import type { Response as ExpressResponse } from 'express';
import { z } from 'zod';
import { CASES_RUNTIME, type CasesRuntime } from './cases-runtime.js';
import type { CaseStatus } from './demo-data.js';
import { Context, type RequestContext } from './request-context.js';
import { parseBody } from './validation.js';

// Read once at module load. `FilesInterceptor`'s count limit is a hard multipart-parsing cutoff
// enforced by Multer before a controller method ever runs, so it cannot itself raise the
// `TOO_MANY_DOCUMENTS` problem-details response - that check, with the friendly message naming
// the actual ceiling, happens in the service. This is only a generous backstop against a client
// attaching an absurd number of parts; it is set one above the real business ceiling so a request
// at or under that ceiling always reaches the service's own check.
const MAX_INTAKE_FILE_PARTS = loadConfig().WORKER_MAX_DOCUMENTS + 1;

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
  // Honoured only for a platform administrator, who must name one; ignored for a tenant user,
  // who is pinned to their own tenant. See `resolveTenant`.
  tenantId: z.string().trim().min(1).optional(),
});
const intakeCaseSchema = z.object({
  subjectName: z.string().trim().min(2).max(200),
  // Defaults to the tenant's active pack (`pack_<tenantId>`) when omitted - see
  // `CasesService.intake` / `ProductionCasesService.intake`.
  domainPackId: z.string().trim().min(1).optional(),
  // Required for a platform administrator, ignored for anyone else: `resolveTenant` locks a
  // non-platform-administrator to their own membership tenant regardless of what is sent here.
  tenantId: z.string().trim().min(1).optional(),
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
  constructor(@Inject(CASES_RUNTIME) private readonly cases: CasesRuntime) {}

  @Post()
  create(
    @Context() context: RequestContext,
    @Body() body: unknown,
    @Headers('idempotency-key') key = `implicit-${context.correlationId}`,
  ) {
    return this.cases.create(context, parseBody(createCaseSchema, body), key);
  }

  // Registered ahead of every `:id`-scoped route below for the same reason
  // `PoliciesController` registers `field-proposals` ahead of its own `:id` - there is no bare
  // `:id`-shaped POST on this controller today, but a literal segment must still win over any
  // future one-segment wildcard route by declaration order.
  @Post('intake')
  @UseInterceptors(
    FilesInterceptor('file', MAX_INTAKE_FILE_PARTS, { limits: { fileSize: 15 * 1024 * 1024 } }),
  )
  intake(
    @Context() context: RequestContext,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @Body() body: unknown,
    @Headers('idempotency-key') key = `implicit-${context.correlationId}`,
  ) {
    return this.cases.intake(context, files ?? [], parseBody(intakeCaseSchema, body), key);
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
    return this.cases.list(context, parsed.status, parsed.query, parsed.cursor, parsed.limit);
  }

  @Get(':id')
  get(@Context() context: RequestContext, @Param('id') id: string) {
    return this.cases.get(context, id);
  }

  @Get(':id/audit')
  async audit(@Context() context: RequestContext, @Param('id') id: string) {
    return { items: (await this.cases.get(context, id)).audit };
  }

  @Get(':id/export')
  export(@Context() context: RequestContext, @Param('id') id: string) {
    return this.cases.export(context, id);
  }

  @Get(':id/documents/:documentId/content')
  async documentContent(
    @Context() context: RequestContext,
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @Headers('range') rangeHeader: string | undefined,
    @Res({ passthrough: true }) response: ExpressResponse,
  ) {
    const source = await this.cases.getDocumentContent(context, id, documentId);
    const body = Buffer.from(source.body);
    const range = rangeHeader ? parseByteRange(rangeHeader, body.byteLength) : undefined;
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Cache-Control', 'private, no-store');

    if (rangeHeader && !range) {
      response.setHeader('Content-Range', `bytes */${body.byteLength}`);
      throw new HttpException(
        { code: 'INVALID_BYTE_RANGE', message: 'The requested document byte range is invalid.' },
        HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE,
      );
    }

    if (range) {
      const partial = body.subarray(range.start, range.end + 1);
      response.status(HttpStatus.PARTIAL_CONTENT);
      response.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${body.byteLength}`);
      return new StreamableFile(partial, {
        type: source.mediaType,
        disposition: `inline; filename="${safeHeaderFileName(source.fileName)}"`,
        length: partial.byteLength,
      });
    }

    return new StreamableFile(body, {
      type: source.mediaType,
      disposition: `inline; filename="${safeHeaderFileName(source.fileName)}"`,
      length: body.byteLength,
    });
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

  /**
   * Re-extracts one case against whatever pack version is active right now - typically because a
   * field proposal was just approved and widened the catalog. Idempotent per `(caseId,
   * packVersion)`: the durable job key is derived from those two alone, not from a client-supplied
   * idempotency key, so re-requesting a reprocess of the same case against the same pack version
   * always returns the same job instead of enqueueing a second one.
   */
  @Post(':id/reprocess')
  reprocess(@Context() context: RequestContext, @Param('id') id: string) {
    return this.cases.reprocess(context, id);
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

function safeHeaderFileName(fileName: string): string {
  return fileName.replaceAll(/[^\x20-\x7e]|[\r\n"\\]/g, '_').slice(0, 180) || 'document';
}

function parseByteRange(value: string, length: number): { start: number; end: number } | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || length < 1 || (!match[1] && !match[2])) return undefined;

  if (!match[1]) {
    const suffixLength = Number.parseInt(match[2]!, 10);
    if (!Number.isSafeInteger(suffixLength) || suffixLength < 1) return undefined;
    return { start: Math.max(0, length - suffixLength), end: length - 1 };
  }

  const start = Number.parseInt(match[1], 10);
  const requestedEnd = match[2] ? Number.parseInt(match[2], 10) : length - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= length ||
    requestedEnd < start
  ) {
    return undefined;
  }
  return { start, end: Math.min(requestedEnd, length - 1) };
}
