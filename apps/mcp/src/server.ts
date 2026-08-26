import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { CaseLensApiClient, CaseLensApiError } from './api-client.js';

const jsonObjectSchema = z.record(z.string(), z.unknown());
const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function result(data: unknown) {
  const output = { data };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
    structuredContent: output,
  };
}

function failure(error: unknown) {
  const apiError =
    error instanceof CaseLensApiError
      ? error
      : new CaseLensApiError(
          500,
          'TOOL_FAILED',
          error instanceof Error ? error.message : 'Unknown failure',
        );
  const output = {
    error: { code: apiError.code, message: apiError.message, status: apiError.status },
  };
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

export function createServer(client: CaseLensApiClient): McpServer {
  const server = new McpServer({ name: 'caselens', version: '1.0.0' });

  server.registerTool(
    'caselens_list_cases',
    {
      title: 'List review cases',
      description:
        'List tenant-scoped CaseLens review cases. Use filters to find cases by workflow state or subject/reference text. Returns opaque pagination cursors.',
      inputSchema: z.object({
        status: z.string().optional(),
        query: z.string().min(1).optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(20),
      }),
      outputSchema: z.object({ data: jsonObjectSchema }),
      annotations,
    },
    async (input) => {
      try {
        return result(await client.listCases(input));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'caselens_get_case',
    {
      title: 'Get case dossier',
      description:
        'Get one complete tenant-scoped case dossier including documents, extracted facts, evidence links, findings, recommendation, and decision.',
      inputSchema: z.object({
        caseId: z.string().min(1).describe('Stable CaseLens case identifier'),
      }),
      outputSchema: z.object({ data: jsonObjectSchema }),
      annotations,
    },
    async ({ caseId }) => {
      try {
        return result(await client.getCase(caseId));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'caselens_search_evidence',
    {
      title: 'Search case evidence',
      description:
        'Search extracted facts and finding evidence within one authorized case. Returns evidence-bearing records and explicit truncation metadata.',
      inputSchema: z.object({
        caseId: z.string().min(1),
        query: z.string().min(2),
        limit: z.number().int().min(1).max(50).default(10),
      }),
      outputSchema: z.object({ data: jsonObjectSchema }),
      annotations,
    },
    async ({ caseId, query, limit }) => {
      try {
        return result(await client.searchEvidence(caseId, query, limit));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'caselens_list_findings',
    {
      title: 'List case findings',
      description:
        'List policy/rule findings for one case, optionally filtered by severity or resolution state. Each finding retains its rule key and evidence.',
      inputSchema: z.object({
        caseId: z.string().min(1),
        severity: z.enum(['critical', 'major', 'minor']).optional(),
        status: z.enum(['open', 'accepted', 'dismissed', 'resolved']).optional(),
      }),
      outputSchema: z.object({ data: jsonObjectSchema }),
      annotations,
    },
    async ({ caseId, severity, status }) => {
      try {
        return result(await client.listFindings(caseId, severity, status));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'caselens_get_audit',
    {
      title: 'Get case audit trail',
      description:
        'Get the immutable chronological audit trail for a case, including automated runs and human corrections or decisions.',
      inputSchema: z.object({ caseId: z.string().min(1) }),
      outputSchema: z.object({ data: jsonObjectSchema }),
      annotations,
    },
    async ({ caseId }) => {
      try {
        return result(await client.getAudit(caseId));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'caselens_export_case',
    {
      title: 'Export case audit package',
      description:
        'Return a read-only JSON audit package with case data and provenance. This does not mutate or finalize the case.',
      inputSchema: z.object({ caseId: z.string().min(1) }),
      outputSchema: z.object({ data: jsonObjectSchema }),
      annotations,
    },
    async ({ caseId }) => {
      try {
        return result(await client.exportCase(caseId));
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}
