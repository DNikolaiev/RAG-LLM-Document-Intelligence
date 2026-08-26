import { createHash } from 'node:crypto';
import type { DocumentBinaryRepository } from '@caselens/providers';
import type { DocumentId, TenantId } from '@caselens/contracts';

export interface IngestIdentity {
  sha256: string;
  duplicateOf: DocumentId | null;
  versionOf: DocumentId | null;
  uploadPreserved: true;
}

export async function recordIngestion(
  input: {
    tenantId: TenantId;
    documentId: DocumentId;
    bytes: Uint8Array;
    previousDocumentId?: DocumentId;
  },
  repository: DocumentBinaryRepository,
): Promise<IngestIdentity> {
  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  const duplicate = await repository.findByHash(input.tenantId, sha256);
  const duplicateOf = duplicate?.documentId ?? null;
  const versionOf = duplicateOf ? null : (input.previousDocumentId ?? null);
  await repository.recordUpload({
    tenantId: input.tenantId,
    documentId: input.documentId,
    sha256,
    duplicateOf,
  });
  return { sha256, duplicateOf, versionOf, uploadPreserved: true };
}
