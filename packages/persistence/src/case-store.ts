import postgres from 'postgres';

export interface AccessScope {
  tenantIds: readonly string[];
  platformAdmin: boolean;
}

export interface PersistedCaseProjection {
  id: string;
  tenantId: string;
  reference: string;
  subjectName: string;
  domain: string;
  domainPackId?: string;
  domainPackVersion: string;
  status: string;
  recommendation: string | null;
  progress: number;
  createdAt: string;
  updatedAt: string;
  dueAt: string;
  assignedTo: string;
  assignedUserId?: string;
  version: number;
  documents: unknown[];
  facts: unknown[];
  findings: unknown[];
  audit: unknown[];
  decision: unknown;
}

export interface StoredJob {
  id: string;
  tenantId: string;
  caseId: string;
  status: string;
  progress: number;
  kind: string;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredDocument {
  id: string;
  tenantId: string;
  caseId: string;
  storageKey: string;
  originalName: string;
  mediaType: string;
  pageCount: number;
}

export interface SeedTenant {
  id: string;
  name: string;
  domain: string;
}

export interface SeedUser {
  id: string;
  displayName: string;
  email: string;
  tenantIds: readonly string[];
  role: string;
}

export class PostgresCaseStore {
  readonly #sql: ReturnType<typeof postgres>;

  constructor(connectionString: string) {
    if (!connectionString) throw new Error('PostgreSQL case store requires DATABASE_URL');
    this.#sql = postgres(connectionString, { max: 10, idle_timeout: 20, prepare: false });
  }

  async health(): Promise<void> {
    await this.#sql`select 1`;
  }

  async close(): Promise<void> {
    await this.#sql.end({ timeout: 5 });
  }

  async seed(
    tenants: readonly SeedTenant[],
    users: readonly SeedUser[],
    cases: readonly PersistedCaseProjection[],
  ): Promise<void> {
    await this.withScope(
      { tenantIds: tenants.map((tenant) => tenant.id), platformAdmin: true },
      async (tx) => {
        for (const tenant of tenants) {
          await tx`insert into tenants (id, name) values (${tenant.id}, ${tenant.name}) on conflict (id) do update set name = excluded.name, updated_at = now()`;
          await tx`insert into domain_packs (id, tenant_id, domain_key, semantic_version, status, definition, activated_at)
          values (${`pack_${tenant.id}`}, ${tenant.id}, ${tenant.domain.toLocaleLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}, '1.0.0', 'active', ${tx.json(asJson({ name: tenant.domain }))}::jsonb, now())
          on conflict (tenant_id, domain_key, semantic_version) do update set status = 'active', definition = excluded.definition, updated_at = now()`;
        }
        for (const user of users) {
          await tx`insert into users (id, external_subject, display_name, email) values (${user.id}, ${user.id}, ${user.displayName}, ${user.email})
          on conflict (id) do update set display_name = excluded.display_name, email = excluded.email, updated_at = now()`;
          for (const tenantId of user.tenantIds) {
            const role = user.role === 'platform_admin' ? 'admin' : user.role;
            await tx`insert into memberships (tenant_id, user_id, role) values (${tenantId}, ${user.id}, ${role})
            on conflict (tenant_id, user_id) do update set role = excluded.role, updated_at = now()`;
          }
        }
        for (const item of cases) {
          const assignedUser = users.find((user) => user.tenantIds.includes(item.tenantId));
          await tx`insert into cases (id, tenant_id, domain_pack_id, reference, subject_name, status, recommendation, assigned_user_id, due_at, metadata, created_at, updated_at, version)
          values (${item.id}, ${item.tenantId}, ${`pack_${item.tenantId}`}, ${item.reference}, ${item.subjectName}, ${item.status}, ${item.recommendation}, ${assignedUser?.id ?? null}, ${item.dueAt}::timestamptz, ${tx.json(asJson({ reviewProjection: item }))}::jsonb, ${item.createdAt}::timestamptz, ${item.updatedAt}::timestamptz, ${item.version})
          on conflict (id) do nothing`;
          await this.syncAuditEvents(tx, item);
        }
      },
    );
  }

  async list(
    scope: AccessScope,
    filters: { status?: string; query?: string },
  ): Promise<PersistedCaseProjection[]> {
    return this.withScope(scope, async (tx) => {
      const status = filters.status ?? null;
      const query = filters.query?.trim() ? `%${filters.query.trim()}%` : null;
      const rows = await tx<Array<{ projection: PersistedCaseProjection; domainPackId: string }>>`
        select metadata->'reviewProjection' as projection, domain_pack_id as "domainPackId"
        from cases
        where (${status}::text is null or status = ${status})
          and (${query}::text is null or subject_name ilike ${query} or reference ilike ${query})
        order by updated_at desc, id desc`;
      return rows.map((row) => ({ ...row.projection, domainPackId: row.domainPackId }));
    });
  }

  async get(scope: AccessScope, caseId: string): Promise<PersistedCaseProjection | null> {
    return this.withScope(scope, async (tx) => {
      const rows = await tx<Array<{ projection: PersistedCaseProjection; domainPackId: string }>>`
        select metadata->'reviewProjection' as projection, domain_pack_id as "domainPackId" from cases where id = ${caseId} limit 1`;
      return rows[0] ? { ...rows[0].projection, domainPackId: rows[0].domainPackId } : null;
    });
  }

  async insert(item: PersistedCaseProjection): Promise<boolean> {
    return this.withScope({ tenantIds: [item.tenantId], platformAdmin: false }, async (tx) => {
      const rows = await tx<
        Array<{ id: string }>
      >`insert into cases (id, tenant_id, domain_pack_id, reference, subject_name, status, recommendation, assigned_user_id, due_at, metadata, created_at, updated_at, version)
        values (${item.id}, ${item.tenantId}, ${`pack_${item.tenantId}`}, ${item.reference}, ${item.subjectName}, ${item.status}, ${item.recommendation}, ${item.assignedUserId ?? null}, ${item.dueAt}::timestamptz, ${tx.json(asJson({ reviewProjection: item }))}::jsonb, ${item.createdAt}::timestamptz, ${item.updatedAt}::timestamptz, ${item.version})
        on conflict (id) do nothing returning id`;
      if (rows.length) await this.syncAuditEvents(tx, item);
      return rows.length === 1;
    });
  }

  async save(item: PersistedCaseProjection, expectedVersion: number): Promise<void> {
    await this.withScope({ tenantIds: [item.tenantId], platformAdmin: false }, async (tx) => {
      await this.saveCase(tx, item, expectedVersion);
      await this.syncAuditEvents(tx, item);
    });
  }

  async saveWithJobUpdate(
    item: PersistedCaseProjection,
    expectedVersion: number,
    jobId: string,
    jobPatch: { status: string; progress: number; checkpoint?: unknown },
    documentStatus: 'ready' | 'needs_review',
  ): Promise<void> {
    await this.withScope({ tenantIds: [item.tenantId], platformAdmin: false }, async (tx) => {
      await this.saveCase(tx, item, expectedVersion);
      await this.syncAuditEvents(tx, item);
      await tx`update documents set processing_status = ${documentStatus}, updated_at = now(), version = version + 1 where case_id = ${item.id}`;
      await this.updateJobInTransaction(tx, jobId, jobPatch);
    });
  }

  async recordDocument(input: {
    id: string;
    tenantId: string;
    caseId: string;
    storageKey: string;
    originalName: string;
    mediaType: string;
    sha256: string;
    byteSize: number;
    pageCount: number;
    warning: string;
  }): Promise<void> {
    await this.withScope({ tenantIds: [input.tenantId], platformAdmin: false }, async (tx) => {
      await tx`insert into documents (id, tenant_id, case_id, storage_key, original_name, media_type, sha256, byte_size, page_count, processing_status, warnings)
        values (${input.id}, ${input.tenantId}, ${input.caseId}, ${input.storageKey}, ${input.originalName}, ${input.mediaType}, ${input.sha256}, ${input.byteSize}, ${input.pageCount}, 'queued', ${tx.json(asJson([input.warning]))}::jsonb)`;
    });
  }

  async listDocuments(scope: AccessScope, caseId: string): Promise<StoredDocument[]> {
    return this.withScope(scope, async (tx) => {
      const rows = await tx<Array<Record<string, unknown>>>`
        select id, tenant_id, case_id, storage_key, original_name, media_type, page_count
        from documents where case_id = ${caseId} order by created_at, id`;
      return rows.map((row) => ({
        id: String(row.id),
        tenantId: String(row.tenant_id),
        caseId: String(row.case_id),
        storageKey: String(row.storage_key),
        originalName: String(row.original_name),
        mediaType: String(row.media_type),
        pageCount: Number(row.page_count),
      }));
    });
  }

  async createJob(job: StoredJob): Promise<StoredJob> {
    return this.withScope({ tenantIds: [job.tenantId], platformAdmin: false }, async (tx) => {
      const rows = await tx<
        Array<Record<string, unknown>>
      >`insert into jobs (id, tenant_id, case_id, kind, status, idempotency_key, progress, attempts, checkpoint, created_at, updated_at)
        values (${job.id}, ${job.tenantId}, ${job.caseId}, ${job.kind}, ${job.status}, ${job.idempotencyKey}, ${job.progress}, 0, '{}'::jsonb, ${job.createdAt}::timestamptz, ${job.updatedAt}::timestamptz)
        on conflict (tenant_id, idempotency_key) do update set idempotency_key = excluded.idempotency_key
        returning id, tenant_id, case_id, status, progress, kind, idempotency_key, created_at, updated_at`;
      return mapJob(rows[0]!);
    });
  }

  async getJob(scope: AccessScope, jobId: string): Promise<StoredJob | null> {
    return this.withScope(scope, async (tx) => {
      const rows = await tx<
        Array<Record<string, unknown>>
      >`select id, tenant_id, case_id, status, progress, kind, idempotency_key, created_at, updated_at from jobs where id = ${jobId} limit 1`;
      return rows[0] ? mapJob(rows[0]) : null;
    });
  }

  async updateJob(
    jobId: string,
    tenantId: string,
    patch: { status: string; progress: number; checkpoint?: unknown },
  ): Promise<void> {
    await this.withScope({ tenantIds: [tenantId], platformAdmin: false }, async (tx) => {
      await this.updateJobInTransaction(tx, jobId, patch);
    });
  }

  private async saveCase(
    tx: postgres.TransactionSql,
    item: PersistedCaseProjection,
    expectedVersion: number,
  ): Promise<void> {
    const rows = await tx<
      Array<{ id: string }>
    >`update cases set status = ${item.status}, recommendation = ${item.recommendation}, due_at = ${item.dueAt}::timestamptz,
      metadata = jsonb_set(metadata, '{reviewProjection}', ${tx.json(asJson(item))}::jsonb, true), updated_at = ${item.updatedAt}::timestamptz, version = ${item.version}
      where id = ${item.id} and version = ${expectedVersion} returning id`;
    if (!rows.length) throw new Error(`VERSION_CONFLICT:${item.id}`);
  }

  private async syncAuditEvents(
    tx: postgres.TransactionSql,
    item: PersistedCaseProjection,
  ): Promise<void> {
    for (const raw of item.audit) {
      if (!raw || typeof raw !== 'object') continue;
      const event = raw as Record<string, unknown>;
      if (
        typeof event.id !== 'string' ||
        typeof event.at !== 'string' ||
        typeof event.actor !== 'string' ||
        typeof event.action !== 'string'
      )
        continue;
      await tx`insert into audit_events (id, tenant_id, case_id, actor_type, actor_id, action, resource_type, resource_id, correlation_id, details, occurred_at)
        values (${event.id}, ${item.tenantId}, ${item.id}, ${event.actor.includes('worker') || event.actor === 'workflow' ? 'system' : 'user'}, ${event.actor}, ${event.action}, 'case', ${item.id}, ${`projection:${event.id}`}, ${tx.json(asJson({ detail: event.detail ?? '' }))}::jsonb, ${event.at}::timestamptz)
        on conflict (id) do nothing`;
    }
  }

  private async updateJobInTransaction(
    tx: postgres.TransactionSql,
    jobId: string,
    patch: { status: string; progress: number; checkpoint?: unknown },
  ): Promise<void> {
    await tx`update jobs set status = ${patch.status}, progress = ${patch.progress}, checkpoint = ${tx.json(asJson(patch.checkpoint ?? {}))}::jsonb,
      attempts = case when ${patch.status} = 'processing' and status <> 'processing' then attempts + 1 else attempts end,
      updated_at = now(), version = version + 1 where id = ${jobId}`;
  }

  private async withScope<T>(
    scope: AccessScope,
    operation: (transaction: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> {
    return (await this.#sql.begin(async (transaction) => {
      await transaction`select set_config('app.tenant_id', ${scope.tenantIds[0] ?? ''}, true), set_config('app.platform_admin', ${scope.platformAdmin ? 'true' : 'false'}, true)`;
      return operation(transaction);
    })) as T;
  }
}

function asJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

function mapJob(row: Record<string, unknown>): StoredJob {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    caseId: String(row.case_id),
    status: String(row.status),
    progress: Number(row.progress),
    kind: String(row.kind),
    idempotencyKey: String(row.idempotency_key),
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString(),
  };
}
