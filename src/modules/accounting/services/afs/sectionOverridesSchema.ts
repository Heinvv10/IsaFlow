// src/modules/accounting/services/afs/sectionOverridesSchema.ts
// The shape of `afs_sections.overrides` (Partial<NoteContent>): exactly what the renderers read. The overrides
// route refuses anything else, naming the field, so no tenant-written JSON reaches the PDF, DOCX, app or portal
// in a shape they cannot print. (Rows already stored in another shape are tolerated by `normaliseBlocks`.)
import { z } from 'zod';

const figure = z.union([z.string(), z.number()]);
/** A table cell: text, a number, or empty. */
const cell = z.union([z.string(), z.number(), z.null()]);
const rowKind = z.enum(['heading', 'line', 'subtotal', 'total']);

const block = z.discriminatedUnion('type', [
  z.object({ type: z.literal('paragraph'), text: z.string() }).strict(),
  z.object({ type: z.literal('heading'), text: z.string(), level: z.union([z.literal(2), z.literal(3)]).optional() }).strict(),
  z.object({ type: z.literal('list'), items: z.array(figure) }).strict(),
  z.object({
    type: z.literal('table'),
    headers: z.array(figure),
    rows: z.array(z.array(cell)),
    rowKinds: z.array(rowKind).optional(),
  }).strict(),
]);

export const sectionOverridesSchema = z.object({
  title: z.string().optional(),
  blocks: z.array(block).optional(),
}).strict();

export type SectionOverrides = z.infer<typeof sectionOverridesSchema>;

/** Zod issues as `{ "overrides.blocks.1.rows.0.1": ["..."] }`: the path of every refused field, which flatten() drops below the top level. */
export function overridesFieldErrors(error: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    // The route parses `{ overrides }`, so the path already starts at `overrides`.
    const path = issue.path.map(String).join('.') || 'overrides';
    // A strict object reports its unknown key as an issue on the parent with the key in `keys`.
    const keys = issue.code === 'unrecognized_keys' ? issue.keys.map((k) => `${path}.${k}`) : [path];
    for (const key of keys) (out[key] ??= []).push(issue.message);
  }
  return out;
}
