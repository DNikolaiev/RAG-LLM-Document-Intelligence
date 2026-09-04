import { describe, expect, it } from 'vitest';
import { CasesService } from '../src/cases.service.js';
import type { IntakeFile } from '../src/intake-validation.js';
import type { RequestContext } from '../src/request-context.js';

const context: RequestContext = {
  profileId: 'profile_lena_vogt',
  tenantId: 'tenant_demo',
  tenantIds: ['tenant_demo'],
  userId: 'reviewer_1',
  role: 'reviewer',
  platformAdmin: false,
  correlationId: 'cor_test',
};

const platformAdmin: RequestContext = {
  profileId: 'profile_platform_admin',
  tenantId: 'tenant_demo',
  tenantIds: ['tenant_demo', 'tenant_legal'],
  userId: 'platform_admin',
  role: 'admin',
  platformAdmin: true,
  correlationId: 'cor_platform_admin_test',
};

function pdf(body = '/Type /Page', filename = 'document.pdf'): IntakeFile {
  const buffer = Buffer.from(`%PDF-1.7\n${body}\n%%EOF`);
  return { originalname: filename, mimetype: 'application/pdf', buffer, size: buffer.byteLength };
}

/** Declares itself a PDF but has no PDF signature at all - `validateFile` quarantines it. */
function corruptPdf(filename: string): IntakeFile {
  const buffer = Buffer.from('not a pdf at all');
  return { originalname: filename, mimetype: 'application/pdf', buffer, size: buffer.byteLength };
}

/** Runs a rejecting promise and returns the NestJS problem-details `code` it threw with. */
async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { getResponse: () => { code: string } }).getResponse().code;
  }
  throw new Error('expected the call to reject');
}

describe('CasesService', () => {
  it('does not leak cases across tenants', () => {
    const service = new CasesService();
    expect(service.list('tenant_other').items).toEqual([]);
  });

  it('makes processing idempotent', () => {
    const service = new CasesService();
    const first = service.process(context, 'case_01J67X4Q7B5E6QG4S9CY0F7R2K', 'same-key');
    const second = service.process(context, 'case_01J67X4Q7B5E6QG4S9CY0F7R2K', 'same-key');
    expect(second).toEqual(first);
  });

  it('scopes processing idempotency keys to the case', () => {
    const service = new CasesService();
    const first = service.process(context, 'case_01J67X4Q7B5E6QG4S9CY0F7R2K', 'shared-key');
    const second = service.process(context, 'case_01J67Y7HFXCQ1D78Y09N8ZABPV', 'shared-key');
    expect(second).not.toEqual(first);
  });

  it('scopes processing notifications to the enqueueing user inside one tenant', () => {
    const service = new CasesService();
    const secondUser = {
      ...context,
      profileId: 'profile_second_reviewer',
      userId: 'reviewer_2',
      correlationId: 'cor_second_reviewer',
    };
    const firstJob = service.process(
      context,
      'case_01J67X4Q7B5E6QG4S9CY0F7R2K',
      'same-user-visible-key',
    );
    const secondJob = service.process(
      secondUser,
      'case_01J67X4Q7B5E6QG4S9CY0F7R2K',
      'same-user-visible-key',
    );

    expect(secondJob.id).not.toBe(firstJob.id);
    expect(service.listJobs(context).items.map((job) => job.id)).toEqual([firstJob.id]);
    expect(service.listJobs(secondUser).items.map((job) => job.id)).toEqual([secondJob.id]);
    expect(() => service.getJob(secondUser, firstJob.id)).toThrow(/job not found/i);
    expect(service.getJobEvents(context, firstJob.id).items).toHaveLength(3);
    expect(service.getJobEvents(secondUser, secondJob.id).items).toHaveLength(3);

    const platformAdmin = {
      ...context,
      profileId: 'profile_platform_admin',
      userId: 'platform_admin',
      tenantIds: ['tenant_demo', 'tenant_other'],
      platformAdmin: true,
      role: 'admin' as const,
    };
    expect(new Set(service.listJobs(platformAdmin).items.map((job) => job.id))).toEqual(
      new Set([firstJob.id, secondJob.id]),
    );
  });

  it('requires a correction reason and optimistic version through the service invariant', () => {
    const service = new CasesService();
    const corrected = service.correctFact(
      context,
      'case_01J67X4Q7B5E6QG4S9CY0F7R2K',
      'fact_contract_party',
      {
        value: 'MediSupply GmbH',
        reason: 'Verified against a signed amendment',
        version: 1,
      },
    );
    expect(corrected).toMatchObject({
      value: 'MediSupply GmbH',
      reviewStatus: 'corrected',
      version: 2,
    });
    expect(() =>
      service.correctFact(context, 'case_01J67X4Q7B5E6QG4S9CY0F7R2K', 'fact_contract_party', {
        value: 'x',
        reason: 'stale update',
        version: 1,
      }),
    ).toThrow(/version 2/i);
  });

  it('reserves final decisions for approvers', () => {
    const service = new CasesService();
    expect(() =>
      service.decide(context, 'case_01J67X4Q7B5E6QG4S9CY0F7R2K', {
        outcome: 'approve',
        reason: 'All requirements are satisfied.',
        version: 3,
      }),
    ).toThrow(/approver/i);
  });

  it('prevents approvers from bypassing deterministic material findings', () => {
    const service = new CasesService();
    expect(() =>
      service.decide({ ...context, role: 'approver' }, 'case_01J67X4Q7B5E6QG4S9CY0F7R2K', {
        outcome: 'approve',
        reason: 'Reviewer override was requested for the remaining findings.',
        version: 3,
      }),
    ).toThrow(/material findings/i);
  });

  it('counts only open findings in queue summaries', () => {
    const service = new CasesService();
    service.resolveFinding(context, 'case_01J67X4Q7B5E6QG4S9CY0F7R2K', 'finding_gdp', {
      status: 'resolved',
      reason: 'A current certificate was supplied.',
      version: 1,
    });

    const summary = service
      .list('tenant_demo')
      .items.find((item) => item.id === 'case_01J67X4Q7B5E6QG4S9CY0F7R2K');
    expect(summary?.findingCounts).toEqual({ major: 2 });
  });
});

describe('CasesService.intake', () => {
  it('creates a case from its documents and queues processing in one call', async () => {
    const service = new CasesService();
    const result = await service.intake(
      context,
      [pdf('/Type /Page', 'questionnaire.pdf'), pdf('/Type /Page', 'certificate.pdf')],
      { subjectName: 'Example Supplier GmbH' },
      'intake-happy-path',
    );

    expect(result.documentIds).toHaveLength(2);
    expect(result.jobIds).toHaveLength(1);

    const created = service.get(context, result.caseId);
    expect(created.subjectName).toBe('Example Supplier GmbH');
    expect(created.documents.map((document) => document.fileName)).toEqual([
      'questionnaire.pdf',
      'certificate.pdf',
    ]);
    expect(service.getJob(context, result.jobIds[0]!).status).toBe('queued');
  });

  it('locks a tenant user to their own tenant even if they name another one', async () => {
    const service = new CasesService();
    const result = await service.intake(
      context,
      [pdf()],
      { subjectName: 'Cross-Tenant Attempt GmbH', tenantId: 'tenant_legal' },
      'intake-tenant-lock',
    );

    expect(service.get(context, result.caseId).tenantId).toBe('tenant_demo');
    expect(() => service.get('tenant_legal', result.caseId)).toThrow(/case not found/i);
  });

  it('requires a platform administrator to name a tenant', async () => {
    const service = new CasesService();
    expect(
      await errorCode(
        service.intake(platformAdmin, [pdf()], { subjectName: 'No Tenant Named GmbH' }, 'k'),
      ),
    ).toBe('TENANT_REQUIRED');
  });

  it('lets a platform administrator file into a tenant they belong to', async () => {
    const service = new CasesService();
    const result = await service.intake(
      platformAdmin,
      [pdf()],
      { subjectName: 'Legal Tenant Filing GmbH', tenantId: 'tenant_legal' },
      'intake-platform-admin-choice',
    );

    expect(service.get('tenant_legal', result.caseId).tenantId).toBe('tenant_legal');
  });

  it('aborts the whole intake with nothing created when one of several files is bad', async () => {
    const service = new CasesService();
    const before = service.list(context).total;

    expect(
      await errorCode(
        service.intake(
          context,
          [
            pdf('/Type /Page', 'good-one.pdf'),
            corruptPdf('bad-two.pdf'),
            pdf('/Type /Page', 'good-three.pdf'),
          ],
          { subjectName: 'Partial Batch GmbH' },
          'intake-bad-file',
        ),
      ),
    ).toBe('UPLOAD_QUARANTINED');

    expect(service.list(context).total).toBe(before);
  });

  it('names the offending file when a file is rejected', async () => {
    const service = new CasesService();
    try {
      await service.intake(
        context,
        [pdf('/Type /Page', 'good.pdf'), corruptPdf('corrupted.pdf')],
        { subjectName: 'Named Failure GmbH' },
        'intake-named-failure',
      );
      throw new Error('expected the call to reject');
    } catch (error) {
      const response = (error as { getResponse: () => { fileName?: string } }).getResponse();
      expect(response.fileName).toBe('corrupted.pdf');
    }
  });

  it('replays the same idempotency key without creating a second case or job', async () => {
    const service = new CasesService();
    const first = await service.intake(
      context,
      [pdf()],
      { subjectName: 'Replay GmbH' },
      'intake-replay',
    );
    const before = service.list(context).total;
    const second = await service.intake(
      context,
      [pdf()],
      { subjectName: 'Replay GmbH' },
      'intake-replay',
    );

    expect(second).toEqual(first);
    expect(service.list(context).total).toBe(before);
  });

  it('requires at least one file', async () => {
    const service = new CasesService();
    expect(
      await errorCode(service.intake(context, [], { subjectName: 'No Files GmbH' }, 'k')),
    ).toBe('FILE_REQUIRED');
  });

  it('refuses more documents than the per-case ceiling', async () => {
    const service = new CasesService();
    const before = service.list(context).total;
    const tooMany = Array.from({ length: 33 }, (_, index) =>
      pdf('/Type /Page', `doc-${index}.pdf`),
    );

    expect(
      await errorCode(service.intake(context, tooMany, { subjectName: 'Too Many GmbH' }, 'k')),
    ).toBe('TOO_MANY_DOCUMENTS');
    expect(service.list(context).total).toBe(before);
  });
});
