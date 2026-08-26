import { Injectable, Logger } from '@nestjs/common';

export interface CaseJob {
  id: string;
  tenantId: string;
  caseId: string;
  idempotencyKey: string;
  attempt: number;
  checkpoint?: { completedSteps: string[] };
}

export interface CaseJobResult {
  status: 'completed' | 'needs_review' | 'cancelled';
  completedSteps: string[];
  recommendation?: 'approve' | 'reject' | 'request_information';
}

export interface WorkflowRunner {
  run(
    job: CaseJob,
    onProgress: (progress: number, step: string) => Promise<void>,
  ): Promise<CaseJobResult>;
}

@Injectable()
export class DeterministicWorkflowRunner implements WorkflowRunner {
  async run(
    job: CaseJob,
    onProgress: (progress: number, step: string) => Promise<void>,
  ): Promise<CaseJobResult> {
    const steps = ['validate', 'extract', 'classify', 'reconcile', 'retrieve', 'evaluate'];
    const completed = new Set(job.checkpoint?.completedSteps ?? []);
    for (const [index, step] of steps.entries()) {
      if (!completed.has(step)) completed.add(step);
      await onProgress(Math.round(((index + 1) / steps.length) * 100), step);
    }
    return {
      status: 'needs_review',
      completedSteps: [...completed],
      recommendation: 'request_information',
    };
  }
}

@Injectable()
export class CaseProcessor {
  private readonly logger = new Logger(CaseProcessor.name);
  private readonly completed = new Map<string, CaseJobResult>();

  constructor(private readonly runner: DeterministicWorkflowRunner) {}

  async process(job: CaseJob): Promise<CaseJobResult> {
    const scope = `${job.tenantId}:${job.idempotencyKey}`;
    const cached = this.completed.get(scope);
    if (cached) return cached;

    const result = await this.runner.run(job, async (progress, step) => {
      this.logger.log(
        JSON.stringify({
          event: 'job.progress',
          jobId: job.id,
          caseId: job.caseId,
          progress,
          step,
        }),
      );
    });
    this.completed.set(scope, result);
    return result;
  }
}
