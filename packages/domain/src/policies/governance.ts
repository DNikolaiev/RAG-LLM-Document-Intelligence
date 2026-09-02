import type { Severity } from '@caselens/contracts';
import type { Condition, DomainPack } from '../domain-pack/schema.js';
import { evaluateCondition } from '../rules/evaluator.js';

export type PolicyVersionStatus =
  | 'draft'
  | 'uploaded'
  | 'processing'
  | 'under_review'
  | 'approved'
  | 'active'
  | 'superseded'
  | 'revoked'
  | 'failed';

export type RuleProposalStatus =
  'proposed' | 'invalid' | 'under_review' | 'approved' | 'rejected' | 'activated';

export type RuleTestKind = 'match' | 'no_match' | 'missing_value' | 'boundary';

export interface PolicyCitation {
  policyVersionId: string;
  page: number;
  quote: string;
  chunkId?: string;
}

export interface PolicyRuleTestCase {
  kind: RuleTestKind;
  name: string;
  input: Readonly<Record<string, unknown>>;
  expected: boolean;
}

export interface PolicyRuleProposal {
  id: string;
  title: string;
  description: string;
  severity: Severity;
  when: Condition;
  policyTags: string[];
  citations: PolicyCitation[];
  tests: PolicyRuleTestCase[];
  extraction: {
    providerId: string;
    model: string;
    promptVersion: string;
    confidence: number;
  };
  proposedByUserId: string | null;
}

export type ProposalValidationCode =
  | 'unknown_fact_path'
  | 'unsupported_operator'
  | 'incompatible_value'
  | 'citation_required'
  | 'invalid_citation'
  | 'test_match_required'
  | 'test_no_match_required'
  | 'test_missing_value_required'
  | 'test_boundary_required'
  | 'test_match_expected_true'
  | 'test_no_match_expected_false'
  | 'test_missing_value_input'
  | 'test_boundary_input'
  | 'test_result_mismatch'
  | 'numeric_requirement_missing'
  | 'citation_condition_mismatch'
  | 'condition_too_weak'
  | 'self_approval_forbidden';

export interface ProposalValidationIssue {
  code: ProposalValidationCode;
  path: string;
  message: string;
}

export interface ProposalApprovalContext {
  approverUserId?: string;
  allowSelfApproval?: boolean;
}

const policyTransitions: Readonly<Record<PolicyVersionStatus, readonly PolicyVersionStatus[]>> = {
  draft: ['uploaded'],
  uploaded: ['processing', 'failed'],
  processing: ['under_review', 'failed'],
  under_review: ['approved', 'failed'],
  approved: ['active'],
  active: ['superseded', 'revoked'],
  superseded: [],
  revoked: [],
  failed: ['processing'],
};

const proposalTransitions: Readonly<Record<RuleProposalStatus, readonly RuleProposalStatus[]>> = {
  proposed: ['invalid', 'under_review'],
  invalid: ['proposed', 'rejected'],
  under_review: ['approved', 'rejected'],
  approved: ['activated', 'rejected'],
  rejected: [],
  activated: [],
};

export function assertPolicyTransition(from: PolicyVersionStatus, to: PolicyVersionStatus): void {
  if (!policyTransitions[from].includes(to)) {
    throw new Error(`Policy version cannot transition from ${from} to ${to}`);
  }
}

export function assertProposalTransition(from: RuleProposalStatus, to: RuleProposalStatus): void {
  if (!proposalTransitions[from].includes(to)) {
    throw new Error(`Rule proposal cannot transition from ${from} to ${to}`);
  }
}

export function validateRuleProposal(
  proposal: PolicyRuleProposal,
  pack: DomainPack,
  approval: ProposalApprovalContext = {},
): { valid: boolean; issues: ProposalValidationIssue[] } {
  const issues: ProposalValidationIssue[] = [];
  const catalog = buildFactCatalog(pack);
  validateCondition(proposal.when, 'when', catalog, issues);

  if (!proposal.citations.length) {
    issues.push({
      code: 'citation_required',
      path: 'citations',
      message: 'At least one exact policy citation is required.',
    });
  }
  proposal.citations.forEach((citation, index) => {
    if (
      !citation.policyVersionId.trim() ||
      !Number.isInteger(citation.page) ||
      citation.page < 1 ||
      !citation.quote.trim()
    ) {
      issues.push({
        code: 'invalid_citation',
        path: `citations.${index}`,
        message: 'A citation requires a policy version, positive page number, and exact quote.',
      });
    }
  });

  const requiredTests: ReadonlyArray<readonly [RuleTestKind, ProposalValidationCode]> = [
    ['match', 'test_match_required'],
    ['no_match', 'test_no_match_required'],
    ['missing_value', 'test_missing_value_required'],
    ['boundary', 'test_boundary_required'],
  ];
  for (const [kind, code] of requiredTests) {
    if (!proposal.tests.some((test) => test.kind === kind)) {
      issues.push({
        code,
        path: 'tests',
        message: `A ${kind.replace('_', ' ')} test is required.`,
      });
    }
  }
  proposal.tests.forEach((test, index) => {
    validateTestKindSemantics(proposal.when, test, index, issues);
    const actual = evaluateCondition(proposal.when, test.input);
    if (actual !== test.expected) {
      issues.push({
        code: 'test_result_mismatch',
        path: `tests.${index}.expected`,
        message: `${test.name} expected ${String(test.expected)} but evaluated to ${String(actual)}.`,
      });
    }
  });

  if (
    approval.approverUserId &&
    proposal.proposedByUserId === approval.approverUserId &&
    !approval.allowSelfApproval
  ) {
    issues.push({
      code: 'self_approval_forbidden',
      path: 'approverUserId',
      message: 'The rule proposer cannot approve their own proposal.',
    });
  }
  return { valid: issues.length === 0, issues };
}

function validateTestKindSemantics(
  condition: Condition,
  test: PolicyRuleTestCase,
  index: number,
  issues: ProposalValidationIssue[],
): void {
  if (test.kind === 'match' && test.expected !== true) {
    issues.push({
      code: 'test_match_expected_true',
      path: `tests.${index}.expected`,
      message: 'A match test must expect the rule to match (true).',
    });
  }
  if (test.kind === 'no_match' && test.expected !== false) {
    issues.push({
      code: 'test_no_match_expected_false',
      path: `tests.${index}.expected`,
      message: 'A no-match test must expect the rule not to match (false).',
    });
  }
  const predicates = collectPredicates(condition);
  if (
    test.kind === 'missing_value' &&
    !predicates.some((predicate) => getPathValue(test.input, predicate.path) === undefined)
  ) {
    issues.push({
      code: 'test_missing_value_input',
      path: `tests.${index}.input`,
      message: 'A missing-value test must omit at least one fact referenced by the rule.',
    });
  }
  if (test.kind === 'boundary' && !hasBoundaryValue(test.input, predicates)) {
    issues.push({
      code: 'test_boundary_input',
      path: `tests.${index}.input`,
      message:
        'A boundary test must use a rule comparison value, or supply a referenced fact for an existence-only rule.',
    });
  }
}

type Predicate = Extract<Condition, { path: string }>;

function collectPredicates(condition: Condition): Predicate[] {
  if (condition.operator === 'all' || condition.operator === 'any') {
    return condition.conditions.flatMap(collectPredicates);
  }
  if (condition.operator === 'not') return collectPredicates(condition.condition);
  return [condition];
}

function getPathValue(input: Readonly<Record<string, unknown>>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object' || !(segment in current)) return undefined;
    return (current as Record<string, unknown>)[segment];
  }, input);
}

function hasBoundaryValue(
  input: Readonly<Record<string, unknown>>,
  predicates: readonly Predicate[],
): boolean {
  const valuePredicates = predicates.filter((predicate) => predicate.operator !== 'exists');
  const candidates = valuePredicates.length ? valuePredicates : predicates;
  return candidates.some((predicate) => {
    const actual = getPathValue(input, predicate.path);
    if (actual === undefined) return predicate.operator === 'exists' && predicate.value === false;
    if (predicate.operator === 'exists') return predicate.value === true;
    if (predicate.operator === 'in') {
      return (
        Array.isArray(predicate.value) && predicate.value.some((value) => Object.is(actual, value))
      );
    }
    if (predicate.operator === 'contains') {
      return Array.isArray(actual)
        ? actual.some((value) => Object.is(value, predicate.value))
        : typeof actual === 'string' && typeof predicate.value === 'string'
          ? actual.includes(predicate.value)
          : false;
    }
    return Object.is(actual, predicate.value);
  });
}

type FieldType = DomainPack['documentTypes'][number]['extractionFields'][number]['type'];

export interface PolicyRuleFact {
  path: string;
  type: FieldType;
  label: string;
  aliases: readonly string[];
}

export function reconciliationConflictPath(canonicalPath: string): string {
  const segments = canonicalPath.split('.');
  const [first = 'entity', ...rest] = segments;
  return `reconciliation.${first}${rest
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join('')}Conflict`;
}

export function policyRuleFacts(pack: DomainPack): PolicyRuleFact[] {
  const documentFacts = pack.documentTypes.flatMap((documentType) =>
    documentType.extractionFields.map((field) => ({
      path: `facts.${field.path}`,
      type: field.type,
      label: field.label,
      aliases: field.aliases,
    })),
  );
  const factsByPath = new Map(documentFacts.map((fact) => [fact.path, fact]));
  return [
    ...documentFacts,
    ...pack.reconciliation.map((rule) => ({
      path: reconciliationConflictPath(rule.canonicalPath),
      type: 'boolean' as const,
      label: `${rule.canonicalPath.replaceAll('.', ' ')} conflict`,
      aliases: [
        'identity mismatch',
        'name matching',
        'does not match',
        ...rule.candidatePaths.flatMap((path) => {
          const fact = factsByPath.get(path);
          return fact ? [fact.label, ...fact.aliases] : [];
        }),
      ],
    })),
  ];
}

function buildFactCatalog(pack: DomainPack): Map<string, FieldType> {
  return new Map(policyRuleFacts(pack).map((field) => [field.path, field.type]));
}

function validateCondition(
  condition: Condition,
  path: string,
  catalog: ReadonlyMap<string, FieldType>,
  issues: ProposalValidationIssue[],
): void {
  if (condition.operator === 'all' || condition.operator === 'any') {
    condition.conditions.forEach((child, index) =>
      validateCondition(child, `${path}.conditions.${index}`, catalog, issues),
    );
    return;
  }
  if (condition.operator === 'not') {
    validateCondition(condition.condition, `${path}.condition`, catalog, issues);
    return;
  }

  const fieldType = catalog.get(condition.path);
  if (!fieldType) {
    issues.push({
      code: 'unknown_fact_path',
      path: `${path}.path`,
      message: `The domain pack does not define ${condition.path}.`,
    });
    return;
  }
  if (!operatorAllowed(fieldType, condition.operator)) {
    issues.push({
      code: 'unsupported_operator',
      path: `${path}.operator`,
      message: `${condition.operator} cannot be used with a ${fieldType} fact.`,
    });
    return;
  }
  if (
    condition.operator !== 'exists' &&
    !valueAllowed(fieldType, condition.operator, condition.value)
  ) {
    issues.push({
      code: 'incompatible_value',
      path: `${path}.value`,
      message: `The comparison value is incompatible with ${condition.path} (${fieldType}).`,
    });
  }
}

function operatorAllowed(fieldType: FieldType, operator: string): boolean {
  if (operator === 'exists' || operator === 'eq' || operator === 'neq' || operator === 'in') {
    return true;
  }
  if (operator === 'contains') return fieldType === 'string' || fieldType === 'list';
  if (operator === 'gte' || operator === 'lte') {
    return fieldType === 'number' || fieldType === 'currency';
  }
  if (operator === 'before' || operator === 'after') return fieldType === 'date';
  return false;
}

function valueAllowed(fieldType: FieldType, operator: string, value: unknown): boolean {
  if (operator === 'in') {
    return (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((item) => scalarAllowed(fieldType, item))
    );
  }
  if (fieldType === 'list' && operator === 'contains') {
    return value === null || ['string', 'number', 'boolean'].includes(typeof value);
  }
  return scalarAllowed(fieldType, value);
}

function scalarAllowed(fieldType: FieldType, value: unknown): boolean {
  if (fieldType === 'number' || fieldType === 'currency') {
    return typeof value === 'number' && Number.isFinite(value);
  }
  if (fieldType === 'boolean') return typeof value === 'boolean';
  if (fieldType === 'date') {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value);
  }
  if (fieldType === 'list') return Array.isArray(value);
  return typeof value === 'string';
}
