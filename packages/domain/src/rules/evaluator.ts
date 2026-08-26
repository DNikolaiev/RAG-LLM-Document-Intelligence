import type { Decision, Severity } from '@caselens/contracts';
import type { Condition, DomainPack } from '../domain-pack/schema.js';

export type EvaluationContext = Readonly<Record<string, unknown>>;

export function resolvePath(context: EvaluationContext, path: string): unknown {
  let current: unknown = context;
  for (const segment of path.split('.')) {
    if (segment === '__proto__' || segment === 'prototype' || segment === 'constructor')
      return undefined;
    if (
      current === null ||
      typeof current !== 'object' ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    )
      return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function asComparable(value: unknown): string | number | boolean | null | undefined {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
    const instant = dateOnly ? Date.parse(`${value}T00:00:00.000Z`) : Date.parse(value);
    if ((dateOnly || value.includes('T')) && Number.isFinite(instant)) return instant;
  }
  return typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
    ? value
    : undefined;
}

function equals(left: unknown, right: unknown): boolean {
  if (typeof left === 'string' && typeof right === 'string')
    return (
      left.normalize('NFKC').trim().toLocaleLowerCase() ===
      right.normalize('NFKC').trim().toLocaleLowerCase()
    );
  return Object.is(left, right);
}

export function evaluateCondition(condition: Condition, context: EvaluationContext): boolean {
  if (condition.operator === 'all')
    return condition.conditions.every((child) => evaluateCondition(child, context));
  if (condition.operator === 'any')
    return condition.conditions.some((child) => evaluateCondition(child, context));
  if (condition.operator === 'not') return !evaluateCondition(condition.condition, context);

  const actual = resolvePath(context, condition.path);
  if (condition.operator === 'exists') {
    const present = actual !== undefined && actual !== null && actual !== '';
    return condition.value ? present : !present;
  }
  if (condition.operator === 'eq') return equals(actual, condition.value);
  if (condition.operator === 'neq') return !equals(actual, condition.value);
  if (condition.operator === 'in')
    return condition.value.some((candidate) => equals(actual, candidate));
  if (condition.operator === 'contains') {
    if (typeof actual === 'string')
      return actual.toLocaleLowerCase().includes(String(condition.value).toLocaleLowerCase());
    if (Array.isArray(actual)) return actual.some((item) => equals(item, condition.value));
    return false;
  }
  const left = asComparable(actual);
  const right = asComparable(condition.value);
  if (
    left === undefined ||
    right === undefined ||
    left === null ||
    right === null ||
    typeof left !== typeof right
  )
    return false;
  if (condition.operator === 'gte') return left >= right;
  if (condition.operator === 'lte') return left <= right;
  if (condition.operator === 'before')
    return typeof left === 'number' && typeof right === 'number' && left < right;
  if (condition.operator === 'after')
    return typeof left === 'number' && typeof right === 'number' && left > right;
  return false;
}

export const severityRank: Readonly<Record<Severity, number>> = {
  info: 0,
  minor: 1,
  major: 2,
  critical: 3,
};

export function normalizeLegalName(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeCurrency(value: string | number): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let cleaned = value.replace(/[^0-9,.-]/g, '').trim();
  if (!cleaned) return null;
  const comma = cleaned.lastIndexOf(',');
  const dot = cleaned.lastIndexOf('.');
  if (comma >= 0 && dot >= 0 && comma > dot) cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  else if (comma >= 0 && dot >= 0 && dot > comma) cleaned = cleaned.replace(/,/g, '');
  else if (dot >= 0)
    cleaned = /\.\d{3}(?:\.\d{3})*$/.test(cleaned) ? cleaned.replace(/\./g, '') : cleaned;
  else if (comma >= 0)
    cleaned = /,\d{1,2}$/.test(cleaned) ? cleaned.replace(',', '.') : cleaned.replace(/,/g, '');
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface DomainFinding {
  ruleId: string;
  title: string;
  description: string;
  severity: Severity;
  policyTags: string[];
}

export function evaluateRules(pack: DomainPack, context: EvaluationContext): DomainFinding[] {
  return pack.rules
    .filter((rule) => evaluateCondition(rule.when, context))
    .map(({ id: ruleId, title, description, severity, policyTags }) => ({
      ruleId,
      title,
      description,
      severity,
      policyTags,
    }))
    .sort(
      (a, b) =>
        severityRank[b.severity] - severityRank[a.severity] || a.ruleId.localeCompare(b.ruleId),
    );
}

export function evaluateRequiredDocuments(
  pack: DomainPack,
  context: EvaluationContext,
  availableTypes: ReadonlySet<string>,
): DomainFinding[] {
  return pack.requiredDocuments
    .filter(
      (required) =>
        (!required.when || evaluateCondition(required.when, context)) &&
        !availableTypes.has(required.documentType),
    )
    .map((required) => ({
      ruleId: `required_document:${required.id}`,
      title: `Missing ${pack.documentTypes.find((type) => type.id === required.documentType)?.label ?? required.documentType}`,
      description: required.message,
      severity: required.severity,
      policyTags: ['required-document'],
    }))
    .sort(
      (a, b) =>
        severityRank[b.severity] - severityRank[a.severity] || a.ruleId.localeCompare(b.ruleId),
    );
}

export function mapDecision(pack: DomainPack, context: EvaluationContext): Decision {
  return (
    [...pack.decisions]
      .sort((a, b) => b.priority - a.priority)
      .find((mapping) => evaluateCondition(mapping.when, context))?.decision ?? 'manual_review'
  );
}
