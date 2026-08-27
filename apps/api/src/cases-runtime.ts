import type { CasesService } from './cases.service.js';
import type { ProductionCasesService } from './production-cases.service.js';

export const CASES_RUNTIME = Symbol('CASES_RUNTIME');
export type CasesRuntime = CasesService | ProductionCasesService;
