import { expect } from 'vitest';
import type { z } from 'zod';
import { CursorPageSchema } from '@caselens/contracts';

/**
 * Asserts that `body` conforms to `schema`.
 *
 * Fails with the full list of Zod issues - path, message, and issue code for each - rather than a
 * bare "expected not to throw". A contract-drift failure that doesn't say which field diverged is
 * nearly useless: the whole point of asserting the wire format against `packages/contracts` is to
 * catch the field that silently changed, so the failure message has to name it.
 *
 * Returns the parsed value on success so a caller can chain into typed fields.
 */
export function expectMatchesSchema<Schema extends z.ZodType>(
  schema: Schema,
  body: unknown,
  label = 'response body',
): z.infer<Schema> {
  const result = schema.safeParse(body);
  if (!result.success) {
    const issues = result.error.issues
      .map(
        (issue) =>
          `  - [${issue.path.length ? issue.path.join('.') : '<root>'}] ${issue.message} (${issue.code})`,
      )
      .join('\n');
    expect.fail(
      `${label} does not match its contract schema (${result.error.issues.length} issue(s)):\n${issues}\n\nReceived body:\n${stringify(body)}`,
    );
  }
  return result.data;
}

/**
 * Applies `expectMatchesSchema` to every element of a list response, so a single bad item is
 * reported by its index instead of the whole array failing as one opaque blob.
 */
export function expectEachMatchesSchema<Schema extends z.ZodType>(
  itemSchema: Schema,
  items: readonly unknown[],
  label = 'item',
): void {
  items.forEach((item, index) => expectMatchesSchema(itemSchema, item, `${label}[${index}]`));
}

/**
 * Asserts a cursor-paginated response - `{ items, nextCursor, ...rest }` - against
 * `CursorPageSchema(itemSchema)`, so both the envelope and every item inside `items` are checked
 * together (a failing item is still reported with its own index via the wrapped array issue path).
 */
export function expectCursorPageMatchesSchema<Schema extends z.ZodType>(
  itemSchema: Schema,
  body: unknown,
  label = 'page',
): { items: Array<z.infer<Schema>>; nextCursor: string | null } {
  return expectMatchesSchema(CursorPageSchema(itemSchema), body, label);
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
