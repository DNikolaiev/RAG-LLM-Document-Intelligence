import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { validateFile } from '@caselens/document-pipeline';
import { DeterministicVirusScanner } from '@caselens/providers';

/**
 * The shape Nest/Multer hands a controller for one attached file, duck-typed the way the
 * existing single-document upload endpoints already accept it (`CasesController.upload`,
 * `PoliciesController.upload`).
 */
export interface IntakeFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface ValidatedIntakeFile {
  file: IntakeFile;
  sha256: string;
  pageCount: number;
}

/**
 * Same `validateFile` settings as `PoliciesService.upload` (15 MB, 500 pages, no encrypted PDFs,
 * PDF only) - not the looser single-document `.../documents` endpoint, which also accepts
 * `text/plain` at a 250-page ceiling. The intake contract is PDF-only, so it mirrors the policy
 * upload path rather than that endpoint.
 */
const INTAKE_FILE_VALIDATION = {
  maxBytes: 15 * 1024 * 1024,
  maxPages: 500,
  allowEncrypted: false,
  supportedMediaTypes: ['application/pdf'],
} as const;

/**
 * Validates every attached file before intake writes anything. A rejected file must not leave a
 * half-built case behind, so this throws on the FIRST rejected file - naming it, so a reviewer
 * uploading five documents knows exactly which one was refused - rather than collecting every
 * issue across the batch. Nothing here touches a store, queue, or object storage: it is pure
 * given the file bytes, which is what lets it be unit tested directly and reused, unchanged, by
 * both `CasesService` (demo) and `ProductionCasesService` (durable).
 *
 * `maxDocuments` is the caller's per-case ceiling (`config.WORKER_MAX_DOCUMENTS` in both
 * services) rather than a constant here, so it stays a single source of truth.
 */
export async function validateIntakeFiles(
  files: readonly IntakeFile[],
  maxDocuments: number,
): Promise<ValidatedIntakeFile[]> {
  if (files.length === 0) {
    throw new BadRequestException({
      code: 'FILE_REQUIRED',
      message: 'Attach at least one PDF in the multipart field named file.',
    });
  }
  if (files.length > maxDocuments) {
    throw new BadRequestException({
      code: 'TOO_MANY_DOCUMENTS',
      message: `A case may not be created with more than ${maxDocuments} documents at once (received ${files.length}).`,
    });
  }

  const validated: ValidatedIntakeFile[] = [];
  for (const file of files) {
    const scanner = new DeterministicVirusScanner(
      file.buffer.includes(Buffer.from('EICAR-STANDARD-ANTIVIRUS-TEST-FILE'))
        ? 'infected'
        : 'clean',
    );
    // Sequential on purpose: files are checked in order so the first rejected one is the one
    // reported, and nothing may be written until every file in the batch has passed.
    const validation = await validateFile(
      file.buffer,
      file.mimetype,
      scanner,
      INTAKE_FILE_VALIDATION,
    );
    if (!validation.accepted) {
      const issue = validation.issues[0]!;
      throw new BadRequestException({
        code: issue.quarantine ? 'UPLOAD_QUARANTINED' : issue.code.toUpperCase(),
        message: `${file.originalname}: ${issue.message}`,
        fileName: file.originalname,
      });
    }
    validated.push({
      file,
      sha256: createHash('sha256').update(file.buffer).digest('hex'),
      pageCount: validation.pageCount ?? 0,
    });
  }
  return validated;
}
