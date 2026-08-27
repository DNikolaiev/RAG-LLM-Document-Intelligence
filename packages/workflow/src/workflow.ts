import { END, START, StateGraph } from '@langchain/langgraph';
import type { DomainPack } from '@caselens/domain';
import { evaluateRequiredDocuments, evaluateRules, mapDecision } from '@caselens/domain';
import type { RetrievalResult } from '@caselens/retrieval';
import { MemoryWorkflowCheckpointStore, type WorkflowCheckpointStore } from './checkpoints.js';
import {
  WorkflowState,
  type CaseWorkflowState,
  type DocumentClassification,
  type FactEvidence,
  type HumanResumeCommand,
} from './state.js';

export interface WorkflowDependencies {
  pack: DomainPack;
  validate(state: CaseWorkflowState): Promise<{ fatalErrors: string[]; warnings: string[] }>;
  extract(state: CaseWorkflowState): Promise<{
    facts: Record<string, unknown>;
    factEvidence?: Record<string, FactEvidence>;
    lowConfidencePaths: string[];
    warnings: string[];
  }>;
  classify(state: CaseWorkflowState): Promise<{
    availableDocumentTypes: string[];
    documentClassifications?: DocumentClassification[];
    reviewReasons: string[];
  }>;
  reconcile(
    state: CaseWorkflowState,
  ): Promise<{ identityConflict: boolean; reviewReasons: string[] }>;
  retrieve(state: CaseWorkflowState): Promise<RetrievalResult>;
  summarize(state: CaseWorkflowState): Promise<string>;
  timeoutMs?: number;
  maxAttempts?: number;
}

export interface WorkflowRunResult {
  state: CaseWorkflowState;
  duplicate: boolean;
  revision: number;
}

const defaultState = (
  input: Pick<CaseWorkflowState, 'tenantId' | 'caseId' | 'idempotencyKey'>,
): CaseWorkflowState => ({
  ...input,
  status: 'running',
  phase: 'queued',
  facts: {},
  factEvidence: {},
  availableDocumentTypes: [],
  documentClassifications: [],
  lowConfidencePaths: [],
  identityConflict: false,
  retrievalStatus: 'pending',
  citations: [],
  findings: [],
  reviewReasons: [],
  warnings: [],
  recommendation: null,
  advisorySummary: null,
  attempts: {},
  humanReview: null,
});

async function withRetry<T>(
  phase: string,
  operation: () => Promise<T>,
  attempts: Record<string, number>,
  maxAttempts: number,
  timeoutMs: number,
): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts[phase] = attempt;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`${phase} timed out`)), timeoutMs),
        ),
      ]);
    } catch (error) {
      last = error;
    }
  }
  throw last instanceof Error ? last : new Error(`${phase} failed`);
}

export class CaseWorkflowRunner {
  readonly #graph;
  readonly #cancelled = new Set<string>();
  constructor(
    private readonly dependencies: WorkflowDependencies,
    private readonly checkpoints: WorkflowCheckpointStore = new MemoryWorkflowCheckpointStore(),
  ) {
    const maxAttempts = dependencies.maxAttempts ?? 2;
    const timeoutMs = dependencies.timeoutMs ?? 30_000;
    const assertActive = (state: CaseWorkflowState) => {
      if (this.#cancelled.has(this.key(state))) throw new WorkflowCancelledError();
    };
    const graph = new StateGraph(WorkflowState)
      .addNode('validate', async (state) => {
        assertActive(state);
        const attempts = { ...state.attempts };
        try {
          const result = await withRetry(
            'validate',
            () => dependencies.validate(state),
            attempts,
            maxAttempts,
            timeoutMs,
          );
          return {
            phase: 'validate',
            attempts,
            warnings: [...state.warnings, ...result.warnings],
            status: result.fatalErrors.length ? ('failed' as const) : ('running' as const),
            reviewReasons: result.fatalErrors,
          };
        } catch (error) {
          return {
            phase: 'validate',
            attempts,
            status: 'failed' as const,
            reviewReasons: [safeError(error, 'Validation failed')],
          };
        }
      })
      .addNode('extract', async (state) => {
        assertActive(state);
        const attempts = { ...state.attempts };
        try {
          const result = await withRetry(
            'extract',
            () => dependencies.extract(state),
            attempts,
            maxAttempts,
            timeoutMs,
          );
          return {
            phase: 'extract',
            attempts,
            facts: result.facts,
            factEvidence: result.factEvidence ?? {},
            lowConfidencePaths: result.lowConfidencePaths,
            warnings: [...state.warnings, ...result.warnings],
            reviewReasons: [
              ...state.reviewReasons,
              ...result.warnings.filter((warning) => warning.startsWith('Quarantined ')),
            ],
          };
        } catch (error) {
          return {
            phase: 'extract',
            attempts,
            status: 'failed' as const,
            reviewReasons: [safeError(error, 'Extraction failed')],
          };
        }
      })
      .addNode('classify', async (state) => {
        assertActive(state);
        const attempts = { ...state.attempts };
        try {
          const result = await withRetry(
            'classify',
            () => dependencies.classify(state),
            attempts,
            maxAttempts,
            timeoutMs,
          );
          return {
            phase: 'classify',
            attempts,
            availableDocumentTypes: result.availableDocumentTypes,
            documentClassifications: result.documentClassifications ?? [],
            reviewReasons: [...state.reviewReasons, ...result.reviewReasons],
          };
        } catch (error) {
          return {
            phase: 'classify',
            attempts,
            status: 'failed' as const,
            reviewReasons: [...state.reviewReasons, safeError(error, 'Classification failed')],
          };
        }
      })
      .addNode('reconcile', async (state) => {
        assertActive(state);
        const attempts = { ...state.attempts };
        try {
          const result = await withRetry(
            'reconcile',
            () => dependencies.reconcile(state),
            attempts,
            maxAttempts,
            timeoutMs,
          );
          return {
            phase: 'reconcile',
            attempts,
            identityConflict: result.identityConflict,
            reviewReasons: [...state.reviewReasons, ...result.reviewReasons],
          };
        } catch (error) {
          return {
            phase: 'reconcile',
            attempts,
            status: 'failed' as const,
            reviewReasons: [...state.reviewReasons, safeError(error, 'Reconciliation failed')],
          };
        }
      })
      .addNode('retrieve', async (state) => {
        assertActive(state);
        const attempts = { ...state.attempts };
        try {
          const result = await withRetry(
            'retrieve',
            () => dependencies.retrieve(state),
            attempts,
            maxAttempts,
            timeoutMs,
          );
          return result.status === 'found'
            ? {
                phase: 'retrieve',
                attempts,
                retrievalStatus: 'found' as const,
                citations: result.citations,
              }
            : {
                phase: 'retrieve',
                attempts,
                retrievalStatus: 'abstained' as const,
                reviewReasons: [
                  ...state.reviewReasons,
                  `Policy retrieval abstained: ${result.reason}.`,
                ],
              };
        } catch (error) {
          return {
            phase: 'retrieve',
            attempts,
            retrievalStatus: 'abstained' as const,
            reviewReasons: [
              ...state.reviewReasons,
              safeError(error, 'Policy retrieval unavailable'),
            ],
          };
        }
      })
      .addNode('evaluate', (state) => {
        assertActive(state);
        const context = {
          facts: state.facts,
          reconciliation: { supplierLegalNameConflict: state.identityConflict },
        };
        const findings = [
          ...evaluateRequiredDocuments(
            dependencies.pack,
            context,
            new Set(state.availableDocumentTypes),
          ),
          ...evaluateRules(dependencies.pack, context),
        ].sort(
          (a, b) =>
            ({ critical: 3, major: 2, minor: 1, info: 0 })[b.severity] -
              { critical: 3, major: 2, minor: 1, info: 0 }[a.severity] ||
            a.ruleId.localeCompare(b.ruleId),
        );
        const informationGap = findings.some((finding) =>
          finding.ruleId.startsWith('required_document:'),
        );
        const reviewReasons = [
          ...state.reviewReasons,
          ...state.lowConfidencePaths.map((path) => `Low-confidence fact: ${path}.`),
          ...(state.identityConflict
            ? ['Conflicting supplier identity requires confirmation.']
            : []),
          ...findings
            .filter((finding) => finding.severity === 'critical' || finding.severity === 'major')
            .map((finding) => `Material finding: ${finding.title}.`),
        ];
        const recommendation = mapDecision(dependencies.pack, {
          summary: {
            requestInformation: informationGap,
            reject: false,
            approvable: findings.length === 0 && reviewReasons.length === 0,
          },
        });
        return { phase: 'evaluate', findings, recommendation, reviewReasons };
      })
      .addNode('review', (state) => ({
        phase: 'review',
        status: 'needs_review' as const,
        reviewReasons: [...new Set(state.reviewReasons)],
      }))
      .addNode('summarize', async (state) => {
        assertActive(state);
        const attempts = { ...state.attempts };
        try {
          return {
            phase: 'summarize',
            attempts,
            advisorySummary: await withRetry(
              'summarize',
              () => dependencies.summarize(state),
              attempts,
              maxAttempts,
              timeoutMs,
            ),
          };
        } catch {
          return {
            phase: 'summarize',
            attempts,
            advisorySummary:
              'Advisory summary unavailable. Deterministic findings and recommendation remain authoritative.',
            warnings: [...state.warnings, 'Advisory summary provider unavailable.'],
          };
        }
      })
      .addNode('complete', () => ({ phase: 'complete', status: 'completed' as const }))
      .addConditionalEdges(START, (state) => resumeNode(state), [
        END,
        'validate',
        'extract',
        'classify',
        'reconcile',
        'retrieve',
        'evaluate',
        'review',
        'summarize',
        'complete',
      ])
      .addConditionalEdges('validate', (state) => (state.status === 'failed' ? END : 'extract'), [
        END,
        'extract',
      ])
      .addConditionalEdges('extract', (state) => (state.status === 'failed' ? END : 'classify'), [
        END,
        'classify',
      ])
      .addConditionalEdges('classify', (state) => (state.status === 'failed' ? END : 'reconcile'), [
        END,
        'reconcile',
      ])
      .addConditionalEdges('reconcile', (state) => (state.status === 'failed' ? END : 'retrieve'), [
        END,
        'retrieve',
      ])
      .addEdge('retrieve', 'evaluate')
      .addConditionalEdges(
        'evaluate',
        (state) =>
          state.reviewReasons.length > 0 ||
          state.recommendation === 'request_information' ||
          state.recommendation === 'manual_review'
            ? 'review'
            : 'summarize',
        ['review', 'summarize'],
      )
      .addEdge('review', END)
      .addEdge('summarize', 'complete')
      .addEdge('complete', END);
    this.#graph = graph.compile();
  }

  private key(state: Pick<CaseWorkflowState, 'tenantId' | 'caseId' | 'idempotencyKey'>): string {
    return `${state.tenantId}:${state.caseId}:${state.idempotencyKey}`;
  }

  async run(
    input: Pick<CaseWorkflowState, 'tenantId' | 'caseId' | 'idempotencyKey'>,
  ): Promise<WorkflowRunResult> {
    const key = this.key(input);
    const previous = await this.checkpoints.get(key);
    if (previous && previous.state.status !== 'running')
      return { state: previous.state, duplicate: true, revision: previous.revision };
    let state = previous?.state ?? defaultState(input);
    let revision = previous?.revision ?? 0;
    let checkpointWriteFailed = false;
    try {
      const stream = await this.#graph.stream(state, { streamMode: 'values' });
      for await (const snapshot of stream) {
        state = snapshot;
        const nextRevision = revision + 1;
        try {
          await this.checkpoints.save(
            { key, state, updatedAt: new Date().toISOString(), revision: nextRevision },
            revision === 0 ? null : revision,
          );
        } catch (error) {
          checkpointWriteFailed = true;
          throw error;
        }
        revision = nextRevision;
      }
    } catch (error) {
      if (checkpointWriteFailed) throw error;
      state = {
        ...state,
        status: error instanceof WorkflowCancelledError ? 'cancelled' : 'failed',
        phase: error instanceof WorkflowCancelledError ? 'cancelled' : 'failed',
        reviewReasons: [safeError(error, 'Workflow failed')],
      };
      const nextRevision = revision + 1;
      await this.checkpoints.save(
        { key, state, updatedAt: new Date().toISOString(), revision: nextRevision },
        revision === 0 ? null : revision,
      );
      revision = nextRevision;
    }
    return { state, duplicate: false, revision };
  }

  async resume(
    input: Pick<CaseWorkflowState, 'tenantId' | 'caseId' | 'idempotencyKey'>,
    command: HumanResumeCommand,
  ): Promise<WorkflowRunResult> {
    if (!command.reason.trim()) throw new Error('A review reason is required');
    const key = this.key(input);
    const checkpoint = await this.checkpoints.get(key);
    if (!checkpoint) throw new Error('Workflow checkpoint not found');
    if (checkpoint.state.status !== 'needs_review')
      throw new Error(`Workflow is not awaiting review: ${checkpoint.state.status}`);
    let state: CaseWorkflowState;
    if (command.action === 'cancel')
      state = {
        ...checkpoint.state,
        status: 'cancelled',
        phase: 'cancelled',
        humanReview: command,
      };
    else {
      const facts = command.factCorrections
        ? deepMerge(checkpoint.state.facts, command.factCorrections)
        : checkpoint.state.facts;
      const evaluated = {
        ...checkpoint.state,
        facts,
        lowConfidencePaths: [],
        identityConflict: command.action === 'confirm' ? false : checkpoint.state.identityConflict,
        reviewReasons: [],
        humanReview: command,
      };
      const context = {
        facts,
        reconciliation: { supplierLegalNameConflict: evaluated.identityConflict },
      };
      const findings = [
        ...evaluateRequiredDocuments(
          this.dependencies.pack,
          context,
          new Set(evaluated.availableDocumentTypes),
        ),
        ...evaluateRules(this.dependencies.pack, context),
      ];
      const infoGap = findings.some((finding) => finding.ruleId.startsWith('required_document:'));
      const reviewReasons = findings
        .filter((finding) => finding.severity === 'critical' || finding.severity === 'major')
        .map((finding) => `Material finding: ${finding.title}.`);
      const recommendation = mapDecision(this.dependencies.pack, {
        summary: { requestInformation: infoGap, reject: false, approvable: findings.length === 0 },
      });
      const needsReview =
        reviewReasons.length > 0 ||
        recommendation === 'request_information' ||
        recommendation === 'manual_review';
      state = {
        ...evaluated,
        findings,
        recommendation,
        reviewReasons,
        status: needsReview ? 'needs_review' : 'completed',
        phase: needsReview ? 'review' : 'complete',
        advisorySummary: needsReview
          ? evaluated.advisorySummary
          : await this.safeSummary({ ...evaluated, findings, recommendation }),
      };
    }
    const revision = checkpoint.revision + 1;
    await this.checkpoints.save(
      { key, state, updatedAt: new Date().toISOString(), revision },
      checkpoint.revision,
    );
    return { state, duplicate: false, revision };
  }

  cancel(input: Pick<CaseWorkflowState, 'tenantId' | 'caseId' | 'idempotencyKey'>): void {
    this.#cancelled.add(this.key(input));
  }
  private async safeSummary(state: CaseWorkflowState): Promise<string> {
    try {
      return await this.dependencies.summarize(state);
    } catch {
      return 'Advisory summary unavailable. Deterministic findings and recommendation remain authoritative.';
    }
  }
}

class WorkflowCancelledError extends Error {
  constructor() {
    super('Workflow cancelled');
  }
}
function resumeNode(state: CaseWorkflowState): string {
  if (state.status !== 'running') return END;
  if (state.phase === 'queued') return 'validate';
  if (state.phase === 'validate') return 'extract';
  if (state.phase === 'extract') return 'classify';
  if (state.phase === 'classify') return 'reconcile';
  if (state.phase === 'reconcile') return 'retrieve';
  if (state.phase === 'retrieve') return 'evaluate';
  if (state.phase === 'evaluate')
    return state.reviewReasons.length > 0 ||
      state.recommendation === 'request_information' ||
      state.recommendation === 'manual_review'
      ? 'review'
      : 'summarize';
  if (state.phase === 'summarize') return 'complete';
  return END;
}
function safeError(error: unknown, fallback: string): string {
  return error instanceof WorkflowCancelledError
    ? error.message
    : error instanceof Error && /timed out|unavailable|failed/i.test(error.message)
      ? `${fallback}: ${error.message}`
      : fallback;
}
function deepMerge(
  left: Record<string, unknown>,
  right: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const output = structuredClone(left);
  for (const [key, value] of Object.entries(right))
    output[key] =
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      output[key] &&
      typeof output[key] === 'object' &&
      !Array.isArray(output[key])
        ? deepMerge(output[key] as Record<string, unknown>, value as Record<string, unknown>)
        : structuredClone(value);
  return output;
}
