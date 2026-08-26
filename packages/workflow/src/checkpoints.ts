import type { CaseWorkflowState } from './state.js';

export interface WorkflowCheckpoint {
  key: string;
  state: CaseWorkflowState;
  updatedAt: string;
  revision: number;
}
export interface WorkflowCheckpointStore {
  get(key: string): Promise<WorkflowCheckpoint | null>;
  save(checkpoint: WorkflowCheckpoint, expectedRevision: number | null): Promise<void>;
}

export class MemoryWorkflowCheckpointStore implements WorkflowCheckpointStore {
  readonly #items = new Map<string, WorkflowCheckpoint>();
  async get(key: string): Promise<WorkflowCheckpoint | null> {
    const item = this.#items.get(key);
    return item ? structuredClone(item) : null;
  }
  async save(checkpoint: WorkflowCheckpoint, expectedRevision: number | null): Promise<void> {
    const existing = this.#items.get(checkpoint.key);
    if ((existing?.revision ?? null) !== expectedRevision)
      throw new Error(`Checkpoint conflict for ${checkpoint.key}`);
    this.#items.set(checkpoint.key, structuredClone(checkpoint));
  }
}
