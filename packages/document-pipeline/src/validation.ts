import type { ProviderError, VirusScannerProvider } from '@caselens/providers';

export type ValidationCode =
  | 'empty'
  | 'too_large'
  | 'unsupported_media_type'
  | 'signature_mismatch'
  | 'corrupt'
  | 'encrypted'
  | 'too_many_pages'
  | 'infected'
  | 'scan_unavailable'
  | 'scan_inconclusive';
export interface ValidationIssue {
  code: ValidationCode;
  message: string;
  quarantine: boolean;
}
export interface FileValidationOptions {
  maxBytes: number;
  maxPages: number;
  allowEncrypted: boolean;
  supportedMediaTypes: readonly string[];
}
export interface FileValidationResult {
  accepted: boolean;
  quarantine: boolean;
  detectedMediaType: string | null;
  pageCount: number | null;
  issues: ValidationIssue[];
}

const signatures: ReadonlyArray<{ mediaType: string; matches: (bytes: Uint8Array) => boolean }> = [
  {
    mediaType: 'application/pdf',
    matches: (bytes) => new TextDecoder('latin1').decode(bytes.subarray(0, 5)) === '%PDF-',
  },
  {
    mediaType: 'image/png',
    matches: (bytes) =>
      bytes.length >= 8 &&
      [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value),
  },
  {
    mediaType: 'image/jpeg',
    matches: (bytes) =>
      bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9,
  },
  {
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    matches: (bytes) => bytes[0] === 0x50 && bytes[1] === 0x4b,
  },
];

function detectMediaType(bytes: Uint8Array, declared: string): string | null {
  const detected = signatures.find((signature) => signature.matches(bytes))?.mediaType;
  if (
    detected === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' &&
    declared.startsWith('application/vnd.openxmlformats-officedocument')
  )
    return declared;
  if (detected) return detected;
  if (declared.startsWith('text/') && !bytes.includes(0)) return declared;
  return null;
}

function inspectPdf(bytes: Uint8Array): {
  pageCount: number;
  corrupt: boolean;
  encrypted: boolean;
} {
  const text = new TextDecoder('latin1').decode(bytes);
  return {
    pageCount: Math.max(1, [...text.matchAll(/\/Type\s*\/Page(?!s)\b/g)].length),
    corrupt: !text.includes('%%EOF'),
    encrypted: /\/Encrypt\b/.test(text),
  };
}

export async function validateFile(
  bytes: Uint8Array,
  declaredMediaType: string,
  scanner: VirusScannerProvider,
  options: FileValidationOptions,
): Promise<FileValidationResult> {
  const issues: ValidationIssue[] = [];
  if (bytes.length === 0)
    issues.push({ code: 'empty', message: 'The file is empty.', quarantine: false });
  if (bytes.length > options.maxBytes)
    issues.push({
      code: 'too_large',
      message: `The file exceeds ${options.maxBytes} bytes.`,
      quarantine: false,
    });
  const detectedMediaType = bytes.length ? detectMediaType(bytes, declaredMediaType) : null;
  if (!options.supportedMediaTypes.includes(declaredMediaType))
    issues.push({
      code: 'unsupported_media_type',
      message: `Unsupported media type: ${declaredMediaType}.`,
      quarantine: false,
    });
  if (detectedMediaType && detectedMediaType !== declaredMediaType)
    issues.push({
      code: 'signature_mismatch',
      message: `Declared ${declaredMediaType}, detected ${detectedMediaType}.`,
      quarantine: true,
    });
  if (!detectedMediaType && bytes.length)
    issues.push({
      code: 'corrupt',
      message: 'The file signature is unknown or corrupt.',
      quarantine: true,
    });

  let pageCount: number | null = null;
  if (detectedMediaType === 'application/pdf') {
    const pdf = inspectPdf(bytes);
    pageCount = pdf.pageCount;
    if (pdf.corrupt)
      issues.push({
        code: 'corrupt',
        message: 'The PDF has no valid end marker.',
        quarantine: true,
      });
    if (pdf.encrypted && !options.allowEncrypted)
      issues.push({
        code: 'encrypted',
        message: 'Encrypted PDFs require reviewer-assisted decryption.',
        quarantine: true,
      });
    if (pdf.pageCount > options.maxPages)
      issues.push({
        code: 'too_many_pages',
        message: `The PDF exceeds ${options.maxPages} pages.`,
        quarantine: false,
      });
  }

  if (!issues.some((issue) => issue.code === 'empty' || issue.code === 'too_large')) {
    const scan = await scanner.scan(bytes);
    if (!scan.ok)
      issues.push({
        code: 'scan_unavailable',
        message: publicScanMessage(scan.error),
        quarantine: true,
      });
    else if (scan.value.status === 'infected')
      issues.push({
        code: 'infected',
        message: `Malware detected${scan.value.signature ? `: ${scan.value.signature}` : ''}.`,
        quarantine: true,
      });
    else if (scan.value.status === 'inconclusive')
      issues.push({
        code: 'scan_inconclusive',
        message: 'Malware scan was inconclusive.',
        quarantine: true,
      });
  }

  return {
    accepted: issues.length === 0,
    quarantine: issues.some((issue) => issue.quarantine),
    detectedMediaType,
    pageCount,
    issues,
  };
}

function publicScanMessage(error: ProviderError): string {
  return error.retryable
    ? 'Malware scanner is temporarily unavailable; the file remains quarantined.'
    : 'Malware scan could not be completed; the file remains quarantined.';
}

export { detectMediaType, inspectPdf };
