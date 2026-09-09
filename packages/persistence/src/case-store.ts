import { createHash } from 'node:crypto';
import { resolveDomainPack } from '@caselens/domain';
import postgres from 'postgres';

export interface AccessScope {
  tenantIds: readonly string[];
  platformAdmin: boolean;
  userId?: string;
  systemActor?: boolean;
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
  contact?: { name?: string; role?: string; email?: string };
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
  caseId: string | null;
  targetType: 'case' | 'case_document' | 'policy_version';
  targetId: string;
  enqueuedByUserId: string;
  correlationId: string;
  queueJobId: string | null;
  status: string;
  progress: number;
  attempts: number;
  errorCode: string | null;
  kind: string;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
  caseReference?: string | null;
  caseSubjectName?: string | null;
  targetName?: string | null;
  enqueuedByName?: string | null;
}

export interface StoredJobEvent {
  id: string;
  jobId: string;
  tenantId: string;
  recipientUserId: string;
  actorUserId: string | null;
  sequence: number;
  type: string;
  stage: string | null;
  status: string;
  progress: number;
  message: string;
  metadata: Record<string, unknown>;
  occurredAt: string;
  readAt: string | null;
}

export interface JobUpdate {
  status: string;
  progress: number;
  checkpoint?: unknown;
  queueJobId?: string;
  errorCode?: string | null;
  eventType?: string;
  stage?: string | null;
  message?: string;
  metadata?: Record<string, unknown>;
  actorUserId?: string | null;
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

export interface RuleRunSnapshot {
  id: string;
  domainPackId: string;
  status: string;
  inputSnapshot: Record<string, unknown>;
  completedAt: string;
  findings: ReadonlyArray<{
    id: string;
    ruleKey: string;
    severity: 'critical' | 'major' | 'minor';
    status: string;
    title: string;
    description: string;
    remediation: string | null;
  }>;
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
          const pack = resolveDomainPack(tenant.domain);
          await tx`insert into domain_packs (id, tenant_id, domain_key, semantic_version, status, definition, activated_at)
          values (${`pack_${tenant.id}`}, ${tenant.id}, ${tenant.domain.toLocaleLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}, ${pack.version}, 'active', ${tx.json(asJson(pack))}::jsonb, now())
          on conflict (tenant_id, domain_key, semantic_version) do update set
            status = case when domain_packs.status = 'superseded' then 'superseded' else 'active' end,
            definition = case when domain_packs.status = 'superseded' then domain_packs.definition else excluded.definition end,
            updated_at = now()`;
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
          if ('contact' in item && item.contact) {
            await tx`update cases
              set metadata = jsonb_set(metadata, '{reviewProjection,contact}', ${tx.json(asJson(item.contact))}::jsonb, true)
              where id = ${item.id} and tenant_id = ${item.tenantId}`;
          }
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
      if (rows.length) {
        await this.syncAuditEvents(tx, item);
        // Same transaction as the insert above. If the insert conflicted, `rows` is empty and no
        // event is written either - a case that already existed was not created a second time.
        await this.appendDomainEventInTransaction(tx, {
          id: domainEventId(item.id, 'case.created'),
          tenantId: item.tenantId,
          type: 'case.created',
          aggregateType: 'case',
          aggregateId: item.id,
          occurredAt: item.createdAt,
          payload: {
            reference: item.reference,
            domainPackId: `pack_${item.tenantId}`,
            domainPackVersion: item.domainPackVersion,
          },
        });
      }
      return rows.length === 1;
    });
  }

  async save(
    item: PersistedCaseProjection,
    expectedVersion: number,
    events: readonly PendingDomainEvent[] = [],
  ): Promise<void> {
    await this.withScope({ tenantIds: [item.tenantId], platformAdmin: false }, async (tx) => {
      await this.saveCase(tx, item, expectedVersion);
      await this.syncAuditEvents(tx, item);
      // Inside the same transaction as the change. An optimistic-concurrency conflict throws from
      // `saveCase` above, so a fact is never recorded for a write that lost the race.
      for (const event of events) {
        await this.appendDomainEventInTransaction(tx, { ...event, tenantId: item.tenantId });
      }
    });
  }

  async saveWithJobUpdate(
    item: PersistedCaseProjection,
    expectedVersion: number,
    jobId: string,
    jobPatch: JobUpdate,
    documentStatus: 'ready' | 'needs_review',
    ruleRun?: RuleRunSnapshot,
    events: readonly PendingDomainEvent[] = [],
  ): Promise<void> {
    await this.withScope(
      { tenantIds: [item.tenantId], platformAdmin: false, systemActor: true },
      async (tx) => {
        await this.saveCase(tx, item, expectedVersion);
        await this.syncAuditEvents(tx, item);
        if (ruleRun) await this.syncRuleRun(tx, item, ruleRun);
        await tx`update documents set processing_status = ${documentStatus}, updated_at = now(), version = version + 1 where case_id = ${item.id}`;
        await this.updateJobInTransaction(tx, jobId, jobPatch);
        // Same transaction as the findings themselves, for the same reason the API's events are:
        // a fact must not survive a write that rolled back, and a committed write must not lose it.
        for (const event of events) {
          await this.appendDomainEventInTransaction(tx, { ...event, tenantId: item.tenantId });
        }
      },
    );
  }

  private async syncRuleRun(
    tx: postgres.TransactionSql,
    item: PersistedCaseProjection,
    ruleRun: RuleRunSnapshot,
  ): Promise<void> {
    await tx`insert into rule_runs (
      id, tenant_id, case_id, domain_pack_id, status, input_snapshot, completed_at
    ) values (
      ${ruleRun.id}, ${item.tenantId}, ${item.id}, ${ruleRun.domainPackId}, ${ruleRun.status},
      ${tx.json(asJson(ruleRun.inputSnapshot))}::jsonb, ${ruleRun.completedAt}::timestamptz
    ) on conflict (id) do update set
      status = excluded.status, input_snapshot = excluded.input_snapshot,
      completed_at = excluded.completed_at, updated_at = now(), version = rule_runs.version + 1`;
    await tx`delete from findings where rule_run_id = ${ruleRun.id}`;
    for (const finding of ruleRun.findings) {
      await tx`insert into findings (
        id, tenant_id, case_id, rule_run_id, evidence_id, rule_key, severity, status,
        title, description, remediation
      ) values (
        ${finding.id}, ${item.tenantId}, ${item.id}, ${ruleRun.id}, null, ${finding.ruleKey},
        ${finding.severity}, ${finding.status}, ${finding.title}, ${finding.description},
        ${finding.remediation}
      )`;
    }
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
    processingStatus?: 'queued' | 'processing' | 'ready' | 'needs_review';
  }): Promise<void> {
    await this.withScope({ tenantIds: [input.tenantId], platformAdmin: false }, async (tx) => {
      await tx`insert into documents (id, tenant_id, case_id, storage_key, original_name, media_type, sha256, byte_size, page_count, processing_status, warnings)
        values (${input.id}, ${input.tenantId}, ${input.caseId}, ${input.storageKey}, ${input.originalName}, ${input.mediaType}, ${input.sha256}, ${input.byteSize}, ${input.pageCount}, ${input.processingStatus ?? 'queued'}, ${tx.json(asJson([input.warning]))}::jsonb)`;
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
    return this.withScope(
      { tenantIds: [job.tenantId], platformAdmin: false, userId: job.enqueuedByUserId },
      async (tx) => {
        const rows = await tx<
          Array<Record<string, unknown>>
        >`insert into jobs (id, tenant_id, case_id, target_type, target_id, enqueued_by_user_id, correlation_id, queue_job_id, kind, status, idempotency_key, progress, attempts, checkpoint, created_at, updated_at)
        values (${job.id}, ${job.tenantId}, ${job.caseId}, ${job.targetType}, ${job.targetId}, ${job.enqueuedByUserId}, ${job.correlationId}, ${job.queueJobId}, ${job.kind}, ${job.status}, ${job.idempotencyKey}, ${job.progress}, ${job.attempts}, '{}'::jsonb, ${job.createdAt}::timestamptz, ${job.updatedAt}::timestamptz)
        on conflict (tenant_id, idempotency_key) do update set idempotency_key = excluded.idempotency_key
        returning id, tenant_id, case_id, target_type, target_id, enqueued_by_user_id, correlation_id, queue_job_id, status, progress, attempts, error, kind, idempotency_key, created_at, updated_at`;
        const stored = mapJob(rows[0]!);
        if (stored.id === job.id) {
          await this.appendJobEventInTransaction(tx, stored.id, {
            eventType: 'job.created',
            status: 'queued',
            progress: 0,
            stage: 'intake',
            message: 'Processing request created.',
            actorUserId: stored.enqueuedByUserId,
          });
          await this.appendJobEventInTransaction(tx, stored.id, {
            eventType: 'queue.enqueue_requested',
            status: 'queued',
            progress: 0,
            stage: 'queue',
            message: 'Sending the request to the processing queue.',
            actorUserId: stored.enqueuedByUserId,
          });
        }
        return stored;
      },
    );
  }

  async getJob(scope: AccessScope, jobId: string): Promise<StoredJob | null> {
    return this.withScope(scope, async (tx) => {
      const rows = await tx<
        Array<Record<string, unknown>>
      >`select id, tenant_id, case_id, target_type, target_id, enqueued_by_user_id, correlation_id, queue_job_id, status, progress, attempts, error, kind, idempotency_key, created_at, updated_at
        from jobs where id = ${jobId} and (${scope.platformAdmin} or enqueued_by_user_id = ${scope.userId ?? ''}) limit 1`;
      return rows[0] ? mapJob(rows[0]) : null;
    });
  }

  async listJobs(scope: AccessScope, limit = 30): Promise<StoredJob[]> {
    return this.withScope(scope, async (tx) => {
      const rows = await tx<Array<Record<string, unknown>>>`
        select job.id, job.tenant_id, job.case_id, job.target_type, job.target_id,
          job.enqueued_by_user_id, job.correlation_id, job.queue_job_id, job.status,
          job.progress, job.attempts, job.error, job.kind, job.idempotency_key,
          job.created_at, job.updated_at, case_item.reference as case_reference,
          case_item.subject_name as case_subject_name,
          coalesce(document_item.original_name, policy_item.title, case_item.subject_name) as target_name,
          enqueuer.display_name as enqueued_by_name
        from jobs job
        left join cases case_item on case_item.id = job.case_id
        left join documents document_item
          on job.target_type = 'case_document' and document_item.id = job.target_id
        left join policy_documents policy_item
          on job.target_type = 'policy_version' and policy_item.id = job.target_id
        left join users enqueuer on enqueuer.id = job.enqueued_by_user_id
        where (${scope.platformAdmin} or job.enqueued_by_user_id = ${scope.userId ?? ''})
        order by job.updated_at desc, job.id desc limit ${limit}`;
      return rows.map(mapJob);
    });
  }

  async listJobEvents(scope: AccessScope, jobId?: string, limit = 100): Promise<StoredJobEvent[]> {
    return this.withScope(scope, async (tx) => {
      const rows = await tx<Array<Record<string, unknown>>>`
        select event.id, event.job_id, event.tenant_id, event.recipient_user_id, event.actor_user_id,
          event.sequence, event.event_type, event.stage, event.status, event.progress, event.message,
          event.metadata, event.occurred_at, event.read_at
        from job_events event
        join jobs job on job.id = event.job_id
        where (${jobId ?? null}::text is null or event.job_id = ${jobId ?? null})
          and (${scope.platformAdmin} or event.recipient_user_id = ${scope.userId ?? ''})
        order by event.occurred_at desc, event.sequence desc limit ${limit}`;
      return rows.map(mapJobEvent);
    });
  }

  async markJobEventsRead(scope: AccessScope, eventIds: readonly string[]): Promise<void> {
    if (!scope.userId || scope.platformAdmin || eventIds.length === 0) return;
    const userId = scope.userId;
    await this.withScope(scope, async (tx) => {
      await tx`update job_events set read_at = coalesce(read_at, now())
        where id = any(${eventIds}::text[]) and recipient_user_id = ${userId}`;
    });
  }

  async updateJob(jobId: string, tenantId: string, patch: JobUpdate): Promise<void> {
    await this.withScope(
      { tenantIds: [tenantId], platformAdmin: false, systemActor: true },
      async (tx) => {
        await this.updateJobInTransaction(tx, jobId, patch);
      },
    );
  }

  async recordQueueRecordRemoved(jobId: string, tenantId: string): Promise<void> {
    await this.withScope(
      { tenantIds: [tenantId], platformAdmin: false, systemActor: true },
      async (tx) => {
        const rows = await tx<Array<{ status: string; progress: number }>>`
          select status, progress from jobs
          where id = ${jobId} and tenant_id = ${tenantId}
          for update`;
        const job = rows[0];
        if (!job) return;
        const prior = await tx<Array<{ exists: boolean }>>`
          select exists(
            select 1 from job_events
            where job_id = ${jobId} and event_type = 'queue.record_removed'
          ) as exists`;
        if (prior[0]?.exists) return;
        await this.appendJobEventInTransaction(tx, jobId, {
          eventType: 'queue.record_removed',
          status: job.status,
          progress: job.progress,
          stage: 'queue',
          message: 'Queue record removed after processing completed.',
          actorUserId: null,
        });
      },
    );
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
    patch: JobUpdate,
  ): Promise<void> {
    await tx`update jobs set status = ${patch.status}, progress = ${patch.progress}, checkpoint = ${tx.json(asJson(patch.checkpoint ?? {}))}::jsonb,
      queue_job_id = coalesce(${patch.queueJobId ?? null}, queue_job_id),
      error = case
        when ${patch.errorCode === undefined} then error
        when ${patch.errorCode === null} then null
        else ${tx.json(asJson({ code: patch.errorCode ?? null }))}::jsonb
      end,
      attempts = case when ${patch.status} = 'processing' and status <> 'processing' then attempts + 1 else attempts end,
      updated_at = now(), version = version + 1 where id = ${jobId}`;
    if (patch.eventType && patch.message) {
      await this.appendJobEventInTransaction(tx, jobId, {
        eventType: patch.eventType,
        message: patch.message,
        status: patch.status,
        progress: patch.progress,
        ...(patch.stage === undefined ? {} : { stage: patch.stage }),
        ...(patch.metadata === undefined ? {} : { metadata: patch.metadata }),
        ...(patch.actorUserId === undefined ? {} : { actorUserId: patch.actorUserId }),
      });
    }
  }

  /**
   * Appends one domain event inside a caller's transaction. Taking the transaction rather than
   * opening its own is the entire point: the event row and the business row commit together, so a
   * fact can never survive a rolled-back change, and a committed change can never lose its fact.
   *
   * Publishing is somebody else's job. This only records that the fact happened.
   */
  private async appendDomainEventInTransaction(
    tx: postgres.TransactionSql,
    event: {
      id: string;
      tenantId: string;
      type: string;
      aggregateType: string;
      aggregateId: string;
      occurredAt: string;
      payload: unknown;
    },
  ): Promise<void> {
    await tx`insert into domain_events (id, tenant_id, type, aggregate_type, aggregate_id, payload, occurred_at)
      values (${event.id}, ${event.tenantId}, ${event.type}, ${event.aggregateType}, ${event.aggregateId},
        ${tx.json(asJson(event.payload))}::jsonb, ${event.occurredAt}::timestamptz)
      on conflict (id) do nothing`;
  }

  /**
   * Claims a batch of deliverable events and hands them to `publish` inside one transaction.
   *
   * `for update skip locked` is what makes this a claim rather than a read. Two relay instances
   * running the same query would otherwise both see the same rows and publish everything twice;
   * with the lock the second skips what the first holds and takes the next batch, so relays
   * partition the backlog instead of duplicating it.
   *
   * The lock exists only inside the transaction, so publishing has to happen here rather than
   * after a read returns - releasing the lock first would put the duplication straight back.
   *
   * Rows already given up on are excluded, so one permanently unpublishable event cannot keep
   * filling the batch and starving deliverable ones.
   */
  async claimUnpublishedEvents(
    limit: number,
    publish: (events: readonly StoredDomainEvent[]) => Promise<{
      publishedIds: readonly string[];
      failures?: ReadonlyArray<{ id: string; error: string }>;
    }>,
  ): Promise<number> {
    return this.withScope({ tenantIds: [], platformAdmin: true }, async (tx) => {
      const rows = await tx<Array<Record<string, unknown>>>`
        select id, sequence, tenant_id, type, aggregate_type, aggregate_id, payload, occurred_at,
          publish_attempts
        from domain_events
        where published_at is null and failed_at is null
        order by sequence asc limit ${limit}
        for update skip locked`;
      if (!rows.length) return 0;

      const events: StoredDomainEvent[] = rows.map((row) => ({
        id: String(row.id),
        sequence: Number(row.sequence),
        tenantId: String(row.tenant_id),
        type: String(row.type),
        aggregateType: String(row.aggregate_type),
        aggregateId: String(row.aggregate_id),
        payload: row.payload,
        occurredAt: new Date(row.occurred_at as string).toISOString(),
      }));
      const attempts = new Map(rows.map((row) => [String(row.id), Number(row.publish_attempts)]));

      const result = await publish(events);

      if (result.publishedIds.length) {
        await tx`update domain_events set published_at = now()
          where id in ${tx(result.publishedIds as string[])}`;
      }
      for (const failure of result.failures ?? []) {
        const nextAttempt = (attempts.get(failure.id) ?? 0) + 1;
        // Set aside only after repeated failures, so a transient problem - the broker restarting
        // mid-batch - does not quarantine a perfectly good event.
        const exhausted = nextAttempt >= MAX_PUBLISH_ATTEMPTS;
        await tx`update domain_events
          set publish_attempts = ${nextAttempt},
            last_error = ${failure.error.slice(0, 1000)},
            failed_at = ${exhausted ? new Date().toISOString() : null}::timestamptz
          where id = ${failure.id}`;
      }
      return result.publishedIds.length;
    });
  }

  /**
   * The highest sequence the outbox has recorded.
   *
   * The publisher's half of consumer lag. The consumer knows how far it has projected and nothing
   * else; this is the number it is behind. Neither service can compute the gap alone, which is not
   * an inconvenience but the honest shape of the thing: lag is a statement about two systems.
   *
   * Counts every event, published or not, because a fact the relay has not yet delivered is
   * genuinely something the read model is behind on.
   */
  async outboxHighWaterMark(): Promise<number> {
    return this.withScope({ tenantIds: [], platformAdmin: true }, async (tx) => {
      const rows = await tx<Array<{ high_water_mark: string | null }>>`
        select max(sequence)::text as high_water_mark from domain_events`;
      return Number(rows[0]?.high_water_mark ?? 0);
    });
  }

  /**
   * Reads history for a replay: every event in sequence order, whatever its delivery state.
   *
   * Deliberately ignores `published_at` and `failed_at`. Those columns record what the *relay* did
   * with a row; a replay is not re-delivery, it is re-derivation, and a consumer rebuilding its
   * projection needs the whole log - including facts that were published years ago to an exchange
   * with no bindings, which is exactly how a fact ends up recorded and yet never seen.
   *
   * Paged by sequence rather than offset so a long replay cannot skip or repeat rows if the table
   * grows underneath it.
   */
  async readEventsForReplay(afterSequence: number, limit: number): Promise<StoredDomainEvent[]> {
    return this.withScope({ tenantIds: [], platformAdmin: true }, async (tx) => {
      const rows = await tx<Array<Record<string, unknown>>>`
        select id, sequence, tenant_id, type, aggregate_type, aggregate_id, payload, occurred_at
        from domain_events
        where sequence > ${afterSequence}
        order by sequence asc limit ${limit}`;
      return rows.map((row) => ({
        id: String(row.id),
        sequence: Number(row.sequence),
        tenantId: String(row.tenant_id),
        type: String(row.type),
        aggregateType: String(row.aggregate_type),
        aggregateId: String(row.aggregate_id),
        payload: row.payload,
        occurredAt: new Date(row.occurred_at as string).toISOString(),
      }));
    });
  }

  private async appendJobEventInTransaction(
    tx: postgres.TransactionSql,
    jobId: string,
    event: Pick<JobUpdate, 'status' | 'progress'> &
      Required<Pick<JobUpdate, 'eventType' | 'message'>> &
      Pick<JobUpdate, 'stage' | 'metadata' | 'actorUserId'>,
  ): Promise<void> {
    const rows = await tx<
      Array<{ tenant_id: string; enqueued_by_user_id: string; next_sequence: number }>
    >`select job.tenant_id, job.enqueued_by_user_id,
        coalesce((select max(sequence) + 1 from job_events where job_id = job.id), 1)::int as next_sequence
      from jobs job where job.id = ${jobId} for update`;
    const job = rows[0];
    if (!job) return;
    const sequence = job.next_sequence;
    await tx`insert into job_events (id, tenant_id, job_id, recipient_user_id, actor_user_id, sequence, event_type, stage, status, progress, message, metadata)
      values (${`${jobId}:event:${sequence}`}, ${job.tenant_id}, ${jobId}, ${job.enqueued_by_user_id}, ${event.actorUserId ?? null}, ${sequence}, ${event.eventType}, ${event.stage ?? null}, ${event.status}, ${event.progress}, ${event.message}, ${tx.json(asJson(event.metadata ?? {}))}::jsonb)`;
  }

  private async withScope<T>(
    scope: AccessScope,
    operation: (transaction: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> {
    return (await this.#sql.begin(async (transaction) => {
      await transaction`select set_config('app.tenant_id', ${scope.tenantIds[0] ?? ''}, true), set_config('app.user_id', ${scope.userId ?? ''}, true), set_config('app.platform_admin', ${scope.platformAdmin ? 'true' : 'false'}, true), set_config('app.system_actor', ${scope.systemActor ? 'true' : 'false'}, true)`;
      return operation(transaction);
    })) as T;
  }
}

/**
 * A deterministic event id, so the same fact recorded twice is the same row. Combined with the
 * outbox's `on conflict (id) do nothing`, an idempotent retry of a business operation cannot
 * produce a duplicate event.
 *
 * `discriminator` separates facts of the same type about the same aggregate that are genuinely
 * different occurrences - a case decided twice, once to request information and later to approve,
 * is two facts, and passing the case version keeps them distinct while a retry of either stays
 * idempotent.
 */
export function domainEventId(aggregateId: string, type: string, discriminator = ''): string {
  const key = discriminator ? `${aggregateId}:${type}:${discriminator}` : `${aggregateId}:${type}`;
  return `evt_${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}

/**
 * A fact the caller wants recorded in the same transaction as the change it describes. The caller
 * decides what happened; the store only guarantees the two commit together.
 */
export interface PendingDomainEvent {
  id: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  occurredAt: string;
  payload: unknown;
}

/** How many times the relay tries an event before setting it aside. */
export const MAX_PUBLISH_ATTEMPTS = 5;

export interface StoredDomainEvent {
  id: string;
  sequence: number;
  tenantId: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  occurredAt: string;
}

function asJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

function mapJob(row: Record<string, unknown>): StoredJob {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    caseId: row.case_id === null ? null : String(row.case_id),
    targetType: String(row.target_type) as StoredJob['targetType'],
    targetId: String(row.target_id),
    enqueuedByUserId: String(row.enqueued_by_user_id),
    correlationId: String(row.correlation_id),
    queueJobId: row.queue_job_id === null ? null : String(row.queue_job_id),
    status: String(row.status),
    progress: Number(row.progress),
    attempts: Number(row.attempts),
    errorCode:
      row.error && typeof row.error === 'object' && 'code' in row.error
        ? String((row.error as { code: unknown }).code)
        : null,
    kind: String(row.kind),
    idempotencyKey: String(row.idempotency_key),
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString(),
    caseReference:
      row.case_reference === null || row.case_reference === undefined
        ? null
        : String(row.case_reference),
    caseSubjectName:
      row.case_subject_name === null || row.case_subject_name === undefined
        ? null
        : String(row.case_subject_name),
    targetName:
      row.target_name === null || row.target_name === undefined ? null : String(row.target_name),
    enqueuedByName:
      row.enqueued_by_name === null || row.enqueued_by_name === undefined
        ? null
        : String(row.enqueued_by_name),
  };
}

function mapJobEvent(row: Record<string, unknown>): StoredJobEvent {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    tenantId: String(row.tenant_id),
    recipientUserId: String(row.recipient_user_id),
    actorUserId: row.actor_user_id === null ? null : String(row.actor_user_id),
    sequence: Number(row.sequence),
    type: String(row.event_type),
    stage: row.stage === null ? null : String(row.stage),
    status: String(row.status),
    progress: Number(row.progress),
    message: String(row.message),
    metadata:
      row.metadata && typeof row.metadata === 'object'
        ? (row.metadata as Record<string, unknown>)
        : {},
    occurredAt: new Date(row.occurred_at as string | Date).toISOString(),
    readAt: row.read_at === null ? null : new Date(row.read_at as string | Date).toISOString(),
  };
}
