import { Module } from '@nestjs/common';
import { CaseProcessor, DeterministicWorkflowRunner } from './case.processor.js';

@Module({ providers: [CaseProcessor, DeterministicWorkflowRunner], exports: [CaseProcessor] })
export class WorkerModule {}
