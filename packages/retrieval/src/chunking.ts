import { createHash } from 'node:crypto';
import type { PolicyChunkRecord } from '@caselens/providers';

export interface PolicyDocumentInput {
  tenantId: string;
  domainId: string;
  packVersion: string;
  documentId: string;
  documentVersion: string;
  collectionId: string;
  text: string;
  validFrom: string;
  validTo: string | null;
  revokedAt: string | null;
  tags: string[];
}

export interface ChunkingOptions {
  targetCharacters: number;
  overlapCharacters: number;
}

export function chunkPolicyDocument(
  document: PolicyDocumentInput,
  options: ChunkingOptions,
): Omit<PolicyChunkRecord, 'embedding'>[] {
  if (options.targetCharacters < 100) throw new Error('targetCharacters must be at least 100');
  if (options.overlapCharacters < 0 || options.overlapCharacters >= options.targetCharacters)
    throw new Error('overlapCharacters must be non-negative and smaller than targetCharacters');
  const normalized = document.text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    const idealEnd = Math.min(normalized.length, start + options.targetCharacters);
    let end = idealEnd;
    if (idealEnd < normalized.length) {
      const candidates = [
        normalized.lastIndexOf('\n\n', idealEnd),
        normalized.lastIndexOf('. ', idealEnd),
        normalized.lastIndexOf(' ', idealEnd),
      ];
      const boundary = Math.max(...candidates);
      if (boundary > start + Math.floor(options.targetCharacters * 0.55))
        end = boundary + (normalized[boundary] === '.' ? 1 : 0);
    }
    chunks.push(normalized.slice(start, end).trim());
    if (end >= normalized.length) break;
    start = Math.max(start + 1, end - options.overlapCharacters);
  }
  return chunks.map((text, index) => ({
    ...document,
    id: `pch_${createHash('sha256').update(`${document.tenantId}:${document.documentId}:${document.documentVersion}:${index}:${text}`).digest('hex').slice(0, 24)}`,
    text,
    tags: [...document.tags],
  }));
}
