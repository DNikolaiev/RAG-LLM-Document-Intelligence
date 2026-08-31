import postgres from 'postgres';
import type { AccessScope } from './case-store.js';

export interface StoredPolicyDocument {
  id: string;
  tenantId: string;
  domainPackId: string;
  title: string;
  policyVersion: string;
  collectionId: string;
  storageKey: string;
  originalName: string;
  mediaType: string;
  sha256: string;
  byteSize: number;
  pageCount: number | null;
  language: string;
  status: string;
  validFrom: string;
  validTo: string | null;
  revoked: boolean;
  uploadedByUserId: string;
  approvedByUserId: string | null;
  processingError: Record<string, unknown> | null;
  extractionMetadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface PolicyDocumentCreate {
  id: string;
  tenantId: string;
  domainPackId: string;
  title: string;
  policyVersion: string;
  collectionId: string;
  storageKey: string;
  originalName: string;
  mediaType: string;
  sha256: string;
  byteSize: number;
  pageCount: number | null;
  language: string;
  validFrom: string;
  validTo: string | null;
  uploadedByUserId: string;
}

export interface StoredPolicyPage {
  id: string;
  page: number;
  extractionMethod: 'native' | 'ocr' | 'blank';
  language: string | null;
  rotation: 0 | 90 | 180 | 270;
  text: string;
  quality: number;
  blocks: unknown[];
  warnings: string[];
}

export interface StoredPolicyChunk {
  id: string;
  ordinal: number;
  pageFrom: number;
  pageTo: number;
  heading: string | null;
  headingPath: string[];
  content: string;
  sourceQuote: string;
  embedding: number[];
  embeddingProvider: string;
  embeddingModel: string;
  tags: string[];
  metadata: Record<string, unknown>;
}

export interface StoredPolicyRuleProposal {
  id: string;
  tenantId: string;
  policyDocumentId: string;
  status: string;
  title: string;
  description: string;
  severity: string;
  condition: unknown;
  policyTags: string[];
  confidence: number;
  providerId: string;
  model: string;
  promptVersion: string;
  validationIssues: unknown[];
  proposedByUserId: string | null;
  reviewedByUserId: string | null;
  reviewReason: string | null;
  version: number;
}

export interface StoredPolicyCitation {
  id: string;
  policyChunkId: string | null;
  page: number;
  quote: string;
}

export interface StoredPolicyRuleTest {
  id: string;
  kind: 'match' | 'no_match' | 'missing_value' | 'boundary';
  name: string;
  input: Record<string, unknown>;
  expected: boolean;
  actual: boolean | null;
  passed: boolean | null;
}

export interface StoredPolicyProposalDetail extends StoredPolicyRuleProposal {
  citations: StoredPolicyCitation[];
  tests: StoredPolicyRuleTest[];
}

export interface StoredPolicyDetail extends StoredPolicyDocument {
  pages: StoredPolicyPage[];
  chunks: Array<Omit<StoredPolicyChunk, 'embedding'> & { embedding: number[] }>;
  proposals: StoredPolicyProposalDetail[];
}

export interface StoredActivePolicyRule {
  id: string;
  ruleKey: string;
  ruleVersion: number;
  policyDocumentId: string;
  policyVersion: string;
  title: string;
  description: string;
  severity: 'info' | 'minor' | 'major' | 'critical';
  condition: unknown;
  policyTags: string[];
  priority: number;
}

export interface StoredDomainPackDescriptor {
  id: string;
  domainKey: string;
  semanticVersion: string;
}

export interface PolicyProposalCreate {
  proposal: Omit<
    StoredPolicyRuleProposal,
    'tenantId' | 'policyDocumentId' | 'status' | 'reviewedByUserId' | 'reviewReason' | 'version'
  > & { status: 'proposed' | 'invalid' };
  citations: Array<{ id: string; policyChunkId: string | null; page: number; quote: string }>;
  tests: Array<{
    id: string;
    kind: 'match' | 'no_match' | 'missing_value' | 'boundary';
    name: string;
    input: Readonly<Record<string, unknown>>;
    expected: boolean;
    actual: boolean;
  }>;
}

export class PostgresPolicyStore {
  readonly #sql: ReturnType<typeof postgres>;

  constructor(connectionString: string) {
    if (!connectionString) throw new Error('PostgreSQL policy store requires DATABASE_URL');
    this.#sql = postgres(connectionString, { max: 8, idle_timeout: 20, prepare: false });
  }

  async close(): Promise<void> {
    await this.#sql.end({ timeout: 5 });
  }

  async create(input: PolicyDocumentCreate): Promise<StoredPolicyDocument> {
    return this.withScope({ tenantIds: [input.tenantId], platformAdmin: false }, async (tx) => {
      const rows = await tx<Array<Record<string, unknown>>>`
        insert into policy_documents (
          id, tenant_id, domain_pack_id, title, policy_version, collection_id, storage_key,
          original_name, media_type, sha256, byte_size, page_count, language, status,
          valid_from, valid_to, revoked, uploaded_by_user_id, extraction_metadata
        ) values (
          ${input.id}, ${input.tenantId}, ${input.domainPackId}, ${input.title},
          ${input.policyVersion}, ${input.collectionId}, ${input.storageKey}, ${input.originalName},
          ${input.mediaType}, ${input.sha256}, ${input.byteSize}, ${input.pageCount},
          ${input.language}, 'uploaded', ${input.validFrom}::timestamptz,
          ${input.validTo}::timestamptz, false, ${input.uploadedByUserId}, '{}'::jsonb
        )
        on conflict (id) do update set id = excluded.id
        returning *`;
      return mapPolicy(rows[0]!);
    });
  }

  async list(
    scope: AccessScope,
    filters: { domainPackId?: string; status?: string } = {},
  ): Promise<StoredPolicyDocument[]> {
    return this.withScope(scope, async (tx) => {
      const rows = await tx<Array<Record<string, unknown>>>`
        select * from policy_documents
        where (${filters.domainPackId ?? null}::text is null or domain_pack_id = ${filters.domainPackId ?? null})
          and (${filters.status ?? null}::text is null or status = ${filters.status ?? null})
        order by updated_at desc, id desc`;
      return rows.map(mapPolicy);
    });
  }

  async get(scope: AccessScope, id: string): Promise<StoredPolicyDocument | null> {
    return this.withScope(scope, async (tx) => {
      const rows = await tx<Array<Record<string, unknown>>>`
        select * from policy_documents where id = ${id} limit 1`;
      return rows[0] ? mapPolicy(rows[0]) : null;
    });
  }

  async getDetail(scope: AccessScope, id: string): Promise<StoredPolicyDetail | null> {
    return this.withScope(scope, async (tx) => {
      const documentRows = await tx<Array<Record<string, unknown>>>`
        select * from policy_documents where id = ${id} limit 1`;
      if (!documentRows[0]) return null;
      const [pageRows, chunkRows, proposalRows, citationRows, testRows] = await Promise.all([
        tx<Array<Record<string, unknown>>>`
          select * from policy_document_pages where policy_document_id = ${id}
          order by page_number`,
        tx<Array<Record<string, unknown>>>`
          select *, coalesce(embedding::text, '[]') as embedding_json from policy_chunks
          where policy_document_id = ${id} order by ordinal`,
        tx<Array<Record<string, unknown>>>`
          select * from policy_rule_proposals where policy_document_id = ${id}
          order by created_at, id`,
        tx<Array<Record<string, unknown>>>`
          select citation.* from policy_rule_proposal_citations citation
          join policy_rule_proposals proposal on proposal.id = citation.proposal_id
          where proposal.policy_document_id = ${id} order by citation.page_number, citation.id`,
        tx<Array<Record<string, unknown>>>`
          select test.* from policy_rule_proposal_tests test
          join policy_rule_proposals proposal on proposal.id = test.proposal_id
          where proposal.policy_document_id = ${id} order by test.kind, test.name`,
      ]);
      const citationsByProposal = groupRows(citationRows, 'proposal_id');
      const testsByProposal = groupRows(testRows, 'proposal_id');
      return {
        ...mapPolicy(documentRows[0]),
        pages: pageRows.map(mapPage),
        chunks: chunkRows.map(mapChunk),
        proposals: proposalRows.map((row) => ({
          ...mapProposal(row),
          citations: (citationsByProposal.get(String(row.id)) ?? []).map(mapCitation),
          tests: (testsByProposal.get(String(row.id)) ?? []).map(mapRuleTest),
        })),
      };
    });
  }

  async listActiveRules(
    tenantId: string,
    domainPackId: string,
    at = new Date().toISOString(),
  ): Promise<StoredActivePolicyRule[]> {
    return this.withScope({ tenantIds: [tenantId], platformAdmin: false }, async (tx) => {
      const rows = await tx<Array<Record<string, unknown>>>`
        select rule.id, rule.rule_key, rule.rule_version, rule.policy_document_id,
          policy.policy_version, rule.title, rule.description, rule.severity, rule.condition,
          rule.policy_tags, rule.priority
        from policy_rules rule
        join policy_documents policy on policy.id = rule.policy_document_id
        where rule.tenant_id = ${tenantId}
          and rule.domain_pack_id = ${domainPackId}
          and rule.status = 'active'
          and policy.status = 'active'
          and policy.revoked = false
          and policy.valid_from <= ${at}::timestamptz
          and (policy.valid_to is null or policy.valid_to > ${at}::timestamptz)
        order by rule.priority desc, rule.rule_key, rule.rule_version desc`;
      return rows.map((row) => ({
        id: String(row.id),
        ruleKey: String(row.rule_key),
        ruleVersion: Number(row.rule_version),
        policyDocumentId: String(row.policy_document_id),
        policyVersion: String(row.policy_version),
        title: String(row.title),
        description: String(row.description),
        severity: row.severity as StoredActivePolicyRule['severity'],
        condition: row.condition,
        policyTags: Array.isArray(row.policy_tags) ? row.policy_tags.map(String) : [],
        priority: Number(row.priority),
      }));
    });
  }

  async getDomainPackDescriptor(
    tenantId: string,
    domainPackId: string,
  ): Promise<StoredDomainPackDescriptor | null> {
    return this.withScope({ tenantIds: [tenantId], platformAdmin: false }, async (tx) => {
      const rows = await tx<Array<Record<string, unknown>>>`
        select id, domain_key, semantic_version
        from domain_packs
        where id = ${domainPackId} and tenant_id = ${tenantId}
        limit 1`;
      const row = rows[0];
      return row
        ? {
            id: String(row.id),
            domainKey: String(row.domain_key),
            semanticVersion: String(row.semantic_version),
          }
        : null;
    });
  }

  async updateStatus(input: {
    tenantId: string;
    id: string;
    expectedVersion: number;
    status: string;
    processingError?: Record<string, unknown> | null;
    extractionMetadata?: Record<string, unknown>;
  }): Promise<StoredPolicyDocument> {
    return this.withScope({ tenantIds: [input.tenantId], platformAdmin: false }, async (tx) => {
      const rows = await tx<Array<Record<string, unknown>>>`
        update policy_documents
        set status = ${input.status}, processing_error = ${tx.json(asJson(input.processingError ?? null))}::jsonb,
          extraction_metadata = case when ${input.extractionMetadata === undefined}
            then extraction_metadata else ${tx.json(asJson(input.extractionMetadata ?? {}))}::jsonb end,
          updated_at = now(), version = version + 1
        where id = ${input.id} and version = ${input.expectedVersion}
        returning *`;
      if (!rows[0]) throw new Error(`VERSION_CONFLICT:${input.id}`);
      return mapPolicy(rows[0]);
    });
  }

  async replaceExtractedContent(input: {
    tenantId: string;
    policyDocumentId: string;
    pages: readonly StoredPolicyPage[];
    chunks: readonly StoredPolicyChunk[];
  }): Promise<void> {
    await this.withScope({ tenantIds: [input.tenantId], platformAdmin: false }, async (tx) => {
      await tx`delete from policy_rule_proposal_tests where proposal_id in
        (select id from policy_rule_proposals where policy_document_id = ${input.policyDocumentId})`;
      await tx`delete from policy_rule_proposal_citations where proposal_id in
        (select id from policy_rule_proposals where policy_document_id = ${input.policyDocumentId})`;
      await tx`delete from policy_rule_proposals where policy_document_id = ${input.policyDocumentId}`;
      await tx`delete from policy_chunks where policy_document_id = ${input.policyDocumentId}`;
      await tx`delete from policy_document_pages where policy_document_id = ${input.policyDocumentId}`;
      for (const page of input.pages) {
        await tx`insert into policy_document_pages (
          id, tenant_id, policy_document_id, page_number, extraction_method, language,
          rotation_degrees, text, quality, blocks, warnings
        ) values (
          ${page.id}, ${input.tenantId}, ${input.policyDocumentId}, ${page.page},
          ${page.extractionMethod}, ${page.language}, ${page.rotation}, ${page.text}, ${page.quality},
          ${tx.json(asJson(page.blocks))}::jsonb, ${tx.json(asJson(page.warnings))}::jsonb
        )`;
      }
      for (const chunk of input.chunks) {
        await tx`insert into policy_chunks (
          id, tenant_id, policy_document_id, ordinal, page_from, page_to, heading, heading_path,
          content, source_quote, embedding, embedding_provider, embedding_model, tags, metadata
        ) values (
          ${chunk.id}, ${input.tenantId}, ${input.policyDocumentId}, ${chunk.ordinal},
          ${chunk.pageFrom}, ${chunk.pageTo}, ${chunk.heading},
          ${tx.json(asJson(chunk.headingPath))}::jsonb, ${chunk.content}, ${chunk.sourceQuote},
          ${JSON.stringify(chunk.embedding)}::vector, ${chunk.embeddingProvider},
          ${chunk.embeddingModel}, ${chunk.tags}, ${tx.json(asJson(chunk.metadata))}::jsonb
        )`;
      }
      await tx`update policy_documents set page_count = ${input.pages.length}, updated_at = now(),
        version = version + 1 where id = ${input.policyDocumentId}`;
    });
  }

  async saveProposal(
    tenantId: string,
    policyDocumentId: string,
    input: PolicyProposalCreate,
  ): Promise<void> {
    await this.withScope({ tenantIds: [tenantId], platformAdmin: false }, async (tx) => {
      const proposal = input.proposal;
      await tx`insert into policy_rule_proposals (
        id, tenant_id, policy_document_id, status, title, description, severity, condition,
        policy_tags, confidence, provider_id, model, prompt_version, validation_issues,
        proposed_by_user_id
      ) values (
        ${proposal.id}, ${tenantId}, ${policyDocumentId}, ${proposal.status}, ${proposal.title},
        ${proposal.description}, ${proposal.severity}, ${tx.json(asJson(proposal.condition))}::jsonb,
        ${proposal.policyTags}, ${proposal.confidence}, ${proposal.providerId}, ${proposal.model},
        ${proposal.promptVersion}, ${tx.json(asJson(proposal.validationIssues))}::jsonb,
        ${proposal.proposedByUserId}
      ) on conflict (id) do update set
        status = excluded.status, title = excluded.title, description = excluded.description,
        severity = excluded.severity, condition = excluded.condition, policy_tags = excluded.policy_tags,
        confidence = excluded.confidence, provider_id = excluded.provider_id, model = excluded.model,
        prompt_version = excluded.prompt_version, validation_issues = excluded.validation_issues,
        updated_at = now(), version = policy_rule_proposals.version + 1`;
      await tx`delete from policy_rule_proposal_citations where proposal_id = ${proposal.id}`;
      await tx`delete from policy_rule_proposal_tests where proposal_id = ${proposal.id}`;
      for (const citation of input.citations) {
        await tx`insert into policy_rule_proposal_citations (
          id, tenant_id, proposal_id, policy_chunk_id, page_number, quote
        ) values (
          ${citation.id}, ${tenantId}, ${proposal.id}, ${citation.policyChunkId},
          ${citation.page}, ${citation.quote}
        )`;
      }
      for (const test of input.tests) {
        await tx`insert into policy_rule_proposal_tests (
          id, tenant_id, proposal_id, kind, name, input, expected, actual, passed, executed_at
        ) values (
          ${test.id}, ${tenantId}, ${proposal.id}, ${test.kind}, ${test.name},
          ${tx.json(asJson(test.input))}::jsonb, ${test.expected}, ${test.actual},
          ${test.expected === test.actual}, now()
        )`;
      }
    });
  }

  async listProposals(
    scope: AccessScope,
    policyDocumentId: string,
  ): Promise<StoredPolicyRuleProposal[]> {
    return this.withScope(scope, async (tx) => {
      const rows = await tx<Array<Record<string, unknown>>>`
        select * from policy_rule_proposals where policy_document_id = ${policyDocumentId}
        order by created_at, id`;
      return rows.map(mapProposal);
    });
  }

  async reviewProposal(input: {
    tenantId: string;
    policyDocumentId: string;
    proposalId: string;
    expectedVersion: number;
    reviewerUserId: string;
    status: 'approved' | 'rejected';
    reason: string;
  }): Promise<StoredPolicyRuleProposal> {
    return this.withScope({ tenantIds: [input.tenantId], platformAdmin: false }, async (tx) => {
      const currentRows = await tx<Array<Record<string, unknown>>>`
        select * from policy_rule_proposals where id = ${input.proposalId}
          and policy_document_id = ${input.policyDocumentId} and version = ${input.expectedVersion}
          and status in ('proposed','under_review','invalid') for update`;
      const current = currentRows[0];
      if (!current) throw new Error(`VERSION_OR_STATE_CONFLICT:${input.proposalId}`);
      if (current.status === 'proposed') {
        await tx`update policy_rule_proposals set status = 'under_review', updated_at = now(),
          version = version + 1 where id = ${input.proposalId}`;
      }
      const reviewState = current.status === 'invalid' ? 'invalid' : 'under_review';
      const rows = await tx<Array<Record<string, unknown>>>`
        update policy_rule_proposals set status = ${input.status},
          reviewed_by_user_id = ${input.reviewerUserId}, review_reason = ${input.reason},
          reviewed_at = now(), updated_at = now(), version = version + 1
        where id = ${input.proposalId} and policy_document_id = ${input.policyDocumentId}
          and version = ${input.expectedVersion + (current.status === 'proposed' ? 1 : 0)}
          and status = ${reviewState}
        returning *`;
      if (!rows[0]) throw new Error(`VERSION_OR_STATE_CONFLICT:${input.proposalId}`);
      if (input.status === 'approved') {
        await tx`update policy_documents set status = 'approved', approved_by_user_id = ${input.reviewerUserId},
          reviewed_at = coalesce(reviewed_at, now()), approved_at = now(), updated_at = now(),
          version = version + 1 where id = ${input.policyDocumentId} and status = 'under_review'`;
      }
      return mapProposal(rows[0]);
    });
  }

  async activate(input: {
    tenantId: string;
    policyDocumentId: string;
    expectedVersion: number;
    approverUserId: string;
    rules: ReadonlyArray<{ id: string; proposalId: string; ruleKey: string; priority: number }>;
  }): Promise<StoredPolicyDocument> {
    return this.withScope({ tenantIds: [input.tenantId], platformAdmin: false }, async (tx) => {
      const policyRows = await tx<Array<Record<string, unknown>>>`
        select * from policy_documents where id = ${input.policyDocumentId}
          and version = ${input.expectedVersion} and status = 'approved' for update`;
      const policy = policyRows[0];
      if (!policy) throw new Error(`VERSION_OR_STATE_CONFLICT:${input.policyDocumentId}`);
      const proposalRows = await tx<Array<Record<string, unknown>>>`
        select proposal.* from policy_rule_proposals proposal
        where proposal.policy_document_id = ${input.policyDocumentId} and proposal.status = 'approved'
        order by proposal.created_at, proposal.id`;
      const proposals = new Map(proposalRows.map((row) => [String(row.id), row]));
      if (!input.rules.length || input.rules.some((rule) => !proposals.has(rule.proposalId))) {
        throw new Error(`APPROVED_RULES_REQUIRED:${input.policyDocumentId}`);
      }
      const failedTests = await tx<Array<Record<string, unknown>>>`
        select test.id from policy_rule_proposal_tests test
        where test.proposal_id = any(${input.rules.map((rule) => rule.proposalId)}::text[])
          and test.passed is not true limit 1`;
      if (failedTests.length) throw new Error(`RULE_TESTS_FAILED:${input.policyDocumentId}`);

      await tx`update policy_documents set status = 'superseded', updated_at = now(),
        version = version + 1 where tenant_id = ${input.tenantId}
        and domain_pack_id = ${String(policy.domain_pack_id)}
        and collection_id = ${String(policy.collection_id)} and title = ${String(policy.title)}
        and status = 'active' and id <> ${input.policyDocumentId}`;
      await tx`update policy_rules set status = 'superseded', updated_at = now(), version = version + 1
        where tenant_id = ${input.tenantId} and domain_pack_id = ${String(policy.domain_pack_id)}
          and status = 'active' and policy_document_id <> ${input.policyDocumentId}`;

      for (const rule of input.rules) {
        const proposal = proposals.get(rule.proposalId)!;
        const versionRows = await tx<Array<{ next_version: number }>>`
          select coalesce(max(rule_version), 0) + 1 as next_version from policy_rules
          where tenant_id = ${input.tenantId} and rule_key = ${rule.ruleKey}`;
        await tx`insert into policy_rules (
          id, tenant_id, domain_pack_id, policy_document_id, proposal_id, rule_key, rule_version,
          status, title, description, severity, condition, policy_tags, priority,
          approved_by_user_id, activated_at
        ) values (
          ${rule.id}, ${input.tenantId}, ${String(policy.domain_pack_id)}, ${input.policyDocumentId},
          ${rule.proposalId}, ${rule.ruleKey}, ${Number(versionRows[0]!.next_version)}, 'active',
          ${String(proposal.title)}, ${String(proposal.description)}, ${String(proposal.severity)},
          ${tx.json(asJson(proposal.condition))}::jsonb, ${proposal.policy_tags as string[]},
          ${rule.priority}, ${input.approverUserId}, now()
        )`;
      }
      await tx`update policy_rule_proposals set status = 'activated', updated_at = now(),
        version = version + 1 where id = any(${input.rules.map((rule) => rule.proposalId)}::text[])`;
      const activatedRows = await tx<Array<Record<string, unknown>>>`
        update policy_documents set status = 'active', approved_by_user_id = ${input.approverUserId},
          approved_at = coalesce(approved_at, now()), activated_at = now(), updated_at = now(),
          version = version + 1 where id = ${input.policyDocumentId} returning *`;
      return mapPolicy(activatedRows[0]!);
    });
  }

  private async withScope<T>(
    scope: AccessScope,
    operation: (transaction: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> {
    return (await this.#sql.begin(async (transaction) => {
      await transaction`select set_config('app.tenant_id', ${scope.tenantIds[0] ?? ''}, true),
        set_config('app.user_id', ${scope.userId ?? ''}, true),
        set_config('app.platform_admin', ${scope.platformAdmin ? 'true' : 'false'}, true)`;
      return operation(transaction);
    })) as T;
  }
}

function asJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

function mapPolicy(row: Record<string, unknown>): StoredPolicyDocument {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    domainPackId: String(row.domain_pack_id),
    title: String(row.title),
    policyVersion: String(row.policy_version),
    collectionId: String(row.collection_id),
    storageKey: String(row.storage_key),
    originalName: String(row.original_name),
    mediaType: String(row.media_type),
    sha256: String(row.sha256),
    byteSize: Number(row.byte_size),
    pageCount: row.page_count === null ? null : Number(row.page_count),
    language: String(row.language),
    status: String(row.status),
    validFrom: new Date(row.valid_from as string | Date).toISOString(),
    validTo: row.valid_to === null ? null : new Date(row.valid_to as string | Date).toISOString(),
    revoked: Boolean(row.revoked),
    uploadedByUserId: String(row.uploaded_by_user_id),
    approvedByUserId: row.approved_by_user_id === null ? null : String(row.approved_by_user_id),
    processingError:
      row.processing_error && typeof row.processing_error === 'object'
        ? (row.processing_error as Record<string, unknown>)
        : null,
    extractionMetadata:
      row.extraction_metadata && typeof row.extraction_metadata === 'object'
        ? (row.extraction_metadata as Record<string, unknown>)
        : {},
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString(),
    version: Number(row.version),
  };
}

function mapProposal(row: Record<string, unknown>): StoredPolicyRuleProposal {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    policyDocumentId: String(row.policy_document_id),
    status: String(row.status),
    title: String(row.title),
    description: String(row.description),
    severity: String(row.severity),
    condition: row.condition,
    policyTags: Array.isArray(row.policy_tags) ? row.policy_tags.map(String) : [],
    confidence: Number(row.confidence),
    providerId: String(row.provider_id),
    model: String(row.model),
    promptVersion: String(row.prompt_version),
    validationIssues: Array.isArray(row.validation_issues) ? row.validation_issues : [],
    proposedByUserId: row.proposed_by_user_id === null ? null : String(row.proposed_by_user_id),
    reviewedByUserId: row.reviewed_by_user_id === null ? null : String(row.reviewed_by_user_id),
    reviewReason: row.review_reason === null ? null : String(row.review_reason),
    version: Number(row.version),
  };
}

function mapPage(row: Record<string, unknown>): StoredPolicyPage {
  return {
    id: String(row.id),
    page: Number(row.page_number),
    extractionMethod: row.extraction_method as StoredPolicyPage['extractionMethod'],
    language: row.language === null ? null : String(row.language),
    rotation: Number(row.rotation_degrees) as StoredPolicyPage['rotation'],
    text: String(row.text),
    quality: Number(row.quality),
    blocks: Array.isArray(row.blocks) ? row.blocks : [],
    warnings: Array.isArray(row.warnings) ? row.warnings.map(String) : [],
  };
}

function mapChunk(row: Record<string, unknown>): StoredPolicyChunk {
  return {
    id: String(row.id),
    ordinal: Number(row.ordinal),
    pageFrom: Number(row.page_from),
    pageTo: Number(row.page_to),
    heading: row.heading === null ? null : String(row.heading),
    headingPath: Array.isArray(row.heading_path) ? row.heading_path.map(String) : [],
    content: String(row.content),
    sourceQuote: String(row.source_quote),
    embedding:
      typeof row.embedding_json === 'string' ? (JSON.parse(row.embedding_json) as number[]) : [],
    embeddingProvider: row.embedding_provider === null ? '' : String(row.embedding_provider),
    embeddingModel: row.embedding_model === null ? '' : String(row.embedding_model),
    tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
    metadata:
      row.metadata && typeof row.metadata === 'object'
        ? (row.metadata as Record<string, unknown>)
        : {},
  };
}

function mapCitation(row: Record<string, unknown>): StoredPolicyCitation {
  return {
    id: String(row.id),
    policyChunkId: row.policy_chunk_id === null ? null : String(row.policy_chunk_id),
    page: Number(row.page_number),
    quote: String(row.quote),
  };
}

function mapRuleTest(row: Record<string, unknown>): StoredPolicyRuleTest {
  return {
    id: String(row.id),
    kind: row.kind as StoredPolicyRuleTest['kind'],
    name: String(row.name),
    input: row.input && typeof row.input === 'object' ? (row.input as Record<string, unknown>) : {},
    expected: Boolean(row.expected),
    actual: row.actual === null ? null : Boolean(row.actual),
    passed: row.passed === null ? null : Boolean(row.passed),
  };
}

function groupRows(
  rows: readonly Record<string, unknown>[],
  key: string,
): Map<string, Record<string, unknown>[]> {
  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const value = String(row[key]);
    grouped.set(value, [...(grouped.get(value) ?? []), row]);
  }
  return grouped;
}
