import postgres from 'postgres';
import type { WorkflowCheckpoint, WorkflowCheckpointStore } from './checkpoints.js';

export class PostgresWorkflowCheckpointStore implements WorkflowCheckpointStore {
  readonly #sql: ReturnType<typeof postgres>;

  constructor(
    connectionString: string,
    private readonly tenantId: string,
  ) {
    if (!connectionString) throw new Error('PostgreSQL checkpoint store requires DATABASE_URL');
    this.#sql = postgres(connectionString, { max: 2, prepare: false });
  }

  async get(key: string): Promise<WorkflowCheckpoint | null> {
    return this.#sql.begin(async (tx) => {
      await setScope(tx, this.tenantId);
      const rows = await tx<
        Array<{ state: WorkflowCheckpoint['state']; updated_at: Date; revision: number }>
      >`
        select state, updated_at, revision from workflow_checkpoints where checkpoint_key = ${key} limit 1`;
      const row = rows[0];
      return row
        ? { key, state: row.state, updatedAt: row.updated_at.toISOString(), revision: row.revision }
        : null;
    }) as Promise<WorkflowCheckpoint | null>;
  }

  async save(checkpoint: WorkflowCheckpoint, expectedRevision: number | null): Promise<void> {
    await this.#sql.begin(async (tx) => {
      await setScope(tx, this.tenantId);
      if (expectedRevision === null) {
        const rows = await tx<Array<{ checkpoint_key: string }>>`
          insert into workflow_checkpoints (tenant_id, checkpoint_key, state, revision, updated_at)
          values (${this.tenantId}, ${checkpoint.key}, ${tx.json(asJson(checkpoint.state))}::jsonb, ${checkpoint.revision}, ${checkpoint.updatedAt}::timestamptz)
          on conflict (tenant_id, checkpoint_key) do nothing returning checkpoint_key`;
        if (!rows.length) throw new Error(`Checkpoint conflict for ${checkpoint.key}`);
        return;
      }
      const rows = await tx<Array<{ checkpoint_key: string }>>`
        update workflow_checkpoints set state = ${tx.json(asJson(checkpoint.state))}::jsonb,
          revision = ${checkpoint.revision}, updated_at = ${checkpoint.updatedAt}::timestamptz
        where tenant_id = ${this.tenantId} and checkpoint_key = ${checkpoint.key} and revision = ${expectedRevision}
        returning checkpoint_key`;
      if (!rows.length) throw new Error(`Checkpoint conflict for ${checkpoint.key}`);
    });
  }

  async close(): Promise<void> {
    await this.#sql.end({ timeout: 5 });
  }
}

async function setScope(tx: postgres.TransactionSql, tenantId: string): Promise<void> {
  await tx`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.platform_admin', 'false', true)`;
}

function asJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}
