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
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import { Context, type RequestContext } from '../request-context.js';
import { parseBody } from '../validation.js';
import { PoliciesService } from './policies.service.js';

const uploadSchema = z.object({
  tenantId: z.string().min(1).optional(),
  title: z.string().trim().min(2).max(200),
  policyVersion: z.string().trim().min(1).max(40),
  collectionId: z.string().trim().min(1).max(80),
  domainPackId: z.string().trim().min(1).optional(),
  language: z.string().trim().min(2).max(20).default('und'),
  validFrom: z.string().min(1),
  validTo: z.string().optional(),
});
const reviewSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().trim().min(8).max(1_000),
  version: z.number().int().positive(),
  severity: z.enum(['info', 'minor', 'major', 'critical']).optional(),
});
const activateSchema = z.object({
  version: z.number().int().positive(),
  priority: z.number().int().min(0).max(10_000).default(0),
});
const fieldProposalStatusSchema = z.enum(['proposed', 'invalid', 'approved', 'rejected']);
const fieldProposalActionSchema = z.object({
  tenantId: z.string().min(1).optional(),
  reason: z.string().trim().min(1).max(1_000).optional(),
});

@Controller('v1/policies')
export class PoliciesController {
  constructor(private readonly policies: PoliciesService) {}

  @Get()
  list(
    @Context() context: RequestContext,
    @Query('status') status?: string,
    @Query('domainPackId') domainPackId?: string,
  ) {
    return this.policies.list(context, {
      ...(status ? { status } : {}),
      ...(domainPackId ? { domainPackId } : {}),
    });
  }

  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 15 * 1024 * 1024, files: 1 } }))
  upload(
    @Context() context: RequestContext,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: unknown,
    @Headers('idempotency-key') key = `implicit-${context.correlationId}`,
  ) {
    if (!file) {
      throw new BadRequestException({
        code: 'FILE_REQUIRED',
        message: 'Attach one PDF in the multipart field named file.',
      });
    }
    return this.policies.upload(context, file, parseBody(uploadSchema, body), key);
  }

  @Get('domain-pack')
  domainPack(@Context() context: RequestContext, @Query('tenantId') tenantId?: string) {
    return this.policies.domainPackConfiguration(context, tenantId);
  }

  // Registered before `:id` - Nest/Express matches routes in registration order, so a literal
  // segment like `field-proposals` must be declared ahead of the single-segment `:id` wildcard
  // or a GET to this path would be misrouted to `get()` with `id: 'field-proposals'`.
  @Get('field-proposals')
  fieldProposals(
    @Context() context: RequestContext,
    @Query('tenantId') tenantId?: string,
    @Query('status') status?: string,
  ) {
    return this.policies.fieldProposals(context, {
      ...(tenantId ? { tenantId } : {}),
      ...(status ? { status: parseBody(fieldProposalStatusSchema, status) } : {}),
    });
  }

  @Post('field-proposals/:id/approve')
  approveFieldProposal(
    @Context() context: RequestContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.policies.approveFieldProposal(
      context,
      id,
      parseBody(fieldProposalActionSchema, body ?? {}),
    );
  }

  @Post('field-proposals/:id/reject')
  rejectFieldProposal(
    @Context() context: RequestContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.policies.rejectFieldProposal(
      context,
      id,
      parseBody(fieldProposalActionSchema, body ?? {}),
    );
  }

  @Get(':id')
  get(@Context() context: RequestContext, @Param('id') id: string) {
    return this.policies.get(context, id);
  }

  @Get(':id/content')
  async content(@Context() context: RequestContext, @Param('id') id: string) {
    const source = await this.policies.content(context, id);
    return new StreamableFile(Buffer.from(source.body), {
      type: source.mediaType,
      disposition: `inline; filename="${source.fileName.replaceAll(/[\r\n"\\]/g, '_')}"`,
      length: source.body.byteLength,
    });
  }

  @Post(':id/reprocess')
  reprocess(
    @Context() context: RequestContext,
    @Param('id') id: string,
    @Headers('idempotency-key') key = `reprocess-${context.correlationId}`,
  ) {
    return this.policies.reprocess(context, id, key);
  }

  @Patch(':id/proposals/:proposalId')
  review(
    @Context() context: RequestContext,
    @Param('id') id: string,
    @Param('proposalId') proposalId: string,
    @Body() body: unknown,
  ) {
    const input = parseBody(reviewSchema, body);
    return this.policies.reviewProposal(context, id, proposalId, {
      decision: input.decision,
      reason: input.reason,
      version: input.version,
      ...(input.severity ? { severity: input.severity } : {}),
    });
  }

  @Post(':id/activate')
  activate(@Context() context: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.policies.activate(context, id, parseBody(activateSchema, body));
  }
}
