import { DecisionSchema, SeveritySchema } from '@caselens/contracts';
import { z } from 'zod';

const PathSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/);
const ScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const ExistsConditionSchema = z.object({
  operator: z.literal('exists'),
  path: PathSchema,
  value: z.boolean().default(true),
});
const ComparisonConditionSchema = z.object({
  operator: z.enum(['eq', 'neq', 'contains', 'gte', 'lte', 'before', 'after']),
  path: PathSchema,
  value: ScalarSchema,
});
const InConditionSchema = z.object({
  operator: z.literal('in'),
  path: PathSchema,
  value: z.array(ScalarSchema).min(1),
});

export type Condition =
  | z.infer<typeof ExistsConditionSchema>
  | z.infer<typeof ComparisonConditionSchema>
  | z.infer<typeof InConditionSchema>
  | { operator: 'all'; conditions: Condition[] }
  | { operator: 'any'; conditions: Condition[] }
  | { operator: 'not'; condition: Condition };

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    ExistsConditionSchema,
    ComparisonConditionSchema,
    InConditionSchema,
    z.object({ operator: z.enum(['all', 'any']), conditions: z.array(ConditionSchema).min(1) }),
    z.object({ operator: z.literal('not'), condition: ConditionSchema }),
  ]),
);

export const ExtractionFieldSchema = z.object({
  path: PathSchema,
  label: z.string().min(1),
  type: z.enum(['string', 'number', 'boolean', 'date', 'currency', 'list']),
  required: z.boolean().default(false),
  aliases: z.array(z.string()).default([]),
});

export const DomainPackSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z][a-z0-9-]+$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  name: z.string().min(1),
  timezone: z.string().min(1),
  terminology: z.object({ case: z.string(), subject: z.string(), decision: z.string() }),
  thresholds: z.object({
    extractionReview: z.number().min(0).max(1),
    retrieval: z.number().min(0).max(1),
  }),
  documentTypes: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z][a-z0-9_]+$/),
        label: z.string().min(1),
        description: z.string().min(1),
        extractionFields: z.array(ExtractionFieldSchema),
      }),
    )
    .min(1),
  requiredDocuments: z.array(
    z.object({
      id: z.string().min(1),
      documentType: z.string().min(1),
      when: ConditionSchema.optional(),
      severity: SeveritySchema,
      message: z.string().min(1),
    }),
  ),
  reconciliation: z.array(
    z.object({
      canonicalPath: PathSchema,
      candidatePaths: z.array(PathSchema).min(2),
      normalizer: z.enum(['legal_name', 'text', 'registration', 'currency']),
    }),
  ),
  policyCollections: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      chunkSize: z.number().int().min(100),
      overlap: z.number().int().nonnegative(),
    }),
  ),
  rules: z.array(
    z.object({
      id: z.string().min(1),
      title: z.string().min(1),
      description: z.string().min(1),
      severity: SeveritySchema,
      when: ConditionSchema,
      policyTags: z.array(z.string()).default([]),
    }),
  ),
  decisions: z
    .array(
      z.object({
        decision: DecisionSchema,
        when: ConditionSchema,
        priority: z.number().int().nonnegative(),
      }),
    )
    .min(1),
  reviewerChecklist: z.array(
    z.object({ id: z.string().min(1), label: z.string().min(1), when: ConditionSchema.optional() }),
  ),
});

export type DomainPack = z.infer<typeof DomainPackSchema>;

export function parseDomainPack(value: unknown): DomainPack {
  const pack = DomainPackSchema.parse(value);
  const types = new Set(pack.documentTypes.map((item) => item.id));
  const duplicateTypes = pack.documentTypes.filter(
    (item, index) =>
      pack.documentTypes.findIndex((candidate) => candidate.id === item.id) !== index,
  );
  if (duplicateTypes.length) throw new Error(`Duplicate document type: ${duplicateTypes[0]?.id}`);
  for (const requirement of pack.requiredDocuments) {
    if (!types.has(requirement.documentType))
      throw new Error(`Unknown required document type: ${requirement.documentType}`);
  }
  const ruleIds = new Set<string>();
  for (const rule of pack.rules) {
    if (ruleIds.has(rule.id)) throw new Error(`Duplicate rule: ${rule.id}`);
    ruleIds.add(rule.id);
  }
  return pack;
}
