import { Annotation } from '@langchain/langgraph';
import type { Decision } from '@caselens/contracts';
import type { DomainFinding } from '@caselens/domain';
import type { RetrievalCitation } from '@caselens/retrieval';

export type WorkflowStatus = 'running' | 'needs_review' | 'completed' | 'cancelled' | 'failed';
export interface HumanResumeCommand {
  action: 'confirm' | 'correct' | 'cancel';
  reviewerId: string;
  reason: string;
  factCorrections?: Readonly<Record<string, unknown>>;
}

export const WorkflowState = Annotation.Root({
  tenantId: Annotation<string>,
  caseId: Annotation<string>,
  idempotencyKey: Annotation<string>,
  status: Annotation<WorkflowStatus>,
  phase: Annotation<string>,
  facts: Annotation<Record<string, unknown>>,
  availableDocumentTypes: Annotation<string[]>,
  lowConfidencePaths: Annotation<string[]>,
  identityConflict: Annotation<boolean>,
  retrievalStatus: Annotation<'pending' | 'found' | 'abstained'>,
  citations: Annotation<RetrievalCitation[]>,
  findings: Annotation<DomainFinding[]>,
  reviewReasons: Annotation<string[]>,
  warnings: Annotation<string[]>,
  recommendation: Annotation<Decision | null>,
  advisorySummary: Annotation<string | null>,
  attempts: Annotation<Record<string, number>>,
  humanReview: Annotation<HumanResumeCommand | null>,
});

export type CaseWorkflowState = typeof WorkflowState.State;
export type CaseWorkflowUpdate = typeof WorkflowState.Update;
