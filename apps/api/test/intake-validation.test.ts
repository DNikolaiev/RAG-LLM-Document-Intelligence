import { describe, expect, it } from 'vitest';
import { validateIntakeFiles, type IntakeFile } from '../src/intake-validation.js';

function pdf(body = '/Type /Page', filename = 'document.pdf'): IntakeFile {
  const buffer = Buffer.from(`%PDF-1.7\n${body}\n%%EOF`);
  return { originalname: filename, mimetype: 'application/pdf', buffer, size: buffer.byteLength };
}

async function errorResponse(
  promise: Promise<unknown>,
): Promise<{ code: string; message: string; fileName?: string }> {
  try {
    await promise;
  } catch (error) {
    return (
      error as { getResponse: () => { code: string; message: string; fileName?: string } }
    ).getResponse();
  }
  throw new Error('expected the call to reject');
}

describe('validateIntakeFiles', () => {
  it("accepts every valid PDF and reports each one's sha256 and page count", async () => {
    const validated = await validateIntakeFiles([pdf('/Type /Page'), pdf('/Type /Page')], 32);
    expect(validated).toHaveLength(2);
    for (const file of validated) {
      expect(file.pageCount).toBe(1);
      expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('requires at least one file', async () => {
    expect(await errorResponse(validateIntakeFiles([], 32))).toMatchObject({
      code: 'FILE_REQUIRED',
    });
  });

  it('refuses more files than the per-case ceiling, before validating any of them', async () => {
    const files = Array.from({ length: 3 }, () => pdf());
    expect(await errorResponse(validateIntakeFiles(files, 2))).toMatchObject({
      code: 'TOO_MANY_DOCUMENTS',
    });
  });

  it('rejects on the first bad file and names it', async () => {
    // Encrypted PDFs are quarantined (`validation.ts` marks `encrypted` issues
    // `quarantine: true`), so the reported code is the generic `UPLOAD_QUARANTINED` - the
    // filename is what tells a reviewer uploading several documents which one was refused.
    const badFile = pdf('/Type /Page /Encrypt', 'encrypted-annex.pdf');
    const response = await errorResponse(
      validateIntakeFiles([pdf('/Type /Page', 'good.pdf'), badFile], 32),
    );
    expect(response.code).toBe('UPLOAD_QUARANTINED');
    expect(response.fileName).toBe('encrypted-annex.pdf');
    expect(response.message).toContain('encrypted-annex.pdf');
  });

  it('quarantines a file whose declared PDF signature does not match its bytes', async () => {
    const notReallyAPdf: IntakeFile = {
      originalname: 'spoofed.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('this has no PDF signature at all'),
      size: 33,
    };
    const response = await errorResponse(validateIntakeFiles([notReallyAPdf], 32));
    expect(response.code).toBe('UPLOAD_QUARANTINED');
    expect(response.fileName).toBe('spoofed.pdf');
  });

  it('refuses a declared media type other than PDF, unlike the looser single-document upload', async () => {
    const textFile: IntakeFile = {
      originalname: 'notes.txt',
      mimetype: 'text/plain',
      buffer: Buffer.from('plain text is accepted by /documents but not by intake'),
      size: 10,
    };
    expect(await errorResponse(validateIntakeFiles([textFile], 32))).toMatchObject({
      code: 'UNSUPPORTED_MEDIA_TYPE',
      fileName: 'notes.txt',
    });
  });

  it('allows up to 500 pages, unlike the 250-page single-document upload ceiling', async () => {
    const pages = Array.from({ length: 300 }, () => '/Type /Page').join(' ');
    const validated = await validateIntakeFiles([pdf(pages, 'large.pdf')], 32);
    expect(validated[0]!.pageCount).toBe(300);
  });

  it('rejects a PDF beyond the 500-page ceiling', async () => {
    const pages = Array.from({ length: 501 }, () => '/Type /Page').join(' ');
    expect(
      await errorResponse(validateIntakeFiles([pdf(pages, 'oversized.pdf')], 32)),
    ).toMatchObject({ code: 'TOO_MANY_PAGES', fileName: 'oversized.pdf' });
  });
});
