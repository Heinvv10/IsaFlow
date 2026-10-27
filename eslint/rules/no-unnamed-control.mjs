/**
 * isaflow/no-unnamed-control — every <select> and <textarea> has an accessible name.
 *
 * The <input> half of this check is isaflow/no-raw-form-input; this rule uses the same name sources, outside
 * src/components/ui: aria-label, aria-labelledby, an `id` that a <label htmlFor> in the same file points at, or
 * a wrapping <label>. Dynamic ids and {...spread} props get the benefit of the doubt (the name may arrive
 * through them). A <label> next to the control that names nothing is NOT a name: axe's `label` rule (n-a11y)
 * catches what this syntax-only rule cannot.
 *
 * Files that already violate are listed in eslint/unnamed-control-allowlist.json as path -> number of reports;
 * a listed file may keep that many and the later ones in the file are reported. The list only shrinks
 * (scripts/ci/check-raw-input-allowlist.ts). A missing list reads as empty, so deleting it reports every
 * violation instead of switching the rule off. Pass `{ allowlist: {} }` to see every violation.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, UI_DIR, attr, literal, isNothing, hasValue } from './no-raw-form-input.mjs';

export const UNNAMED_CONTROL_ALLOWLIST_FILE = path.join(REPO_ROOT, 'eslint', 'unnamed-control-allowlist.json');

const CONTROLS = new Set(['select', 'textarea']);

/** The list at `file`, or {} when it does not exist. */
export function readControlAllowlist(file = UNNAMED_CONTROL_ALLOWLIST_FILE) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}

/** @type {import('eslint').Rule.RuleModule} */
export const noUnnamedControl = {
  meta: {
    type: 'problem',
    schema: [{ type: 'object', properties: { allowlist: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } } }, additionalProperties: false }],
    messages: {
      unnamed:
        '<{{tag}}> has no accessible name. Add aria-label or aria-labelledby, an id that a <label htmlFor> points at, or wrap it in a <label>. Prefer the kit: Select, Textarea.',
      orphanId:
        '<{{tag}} id="{{id}}"> is not referenced by any <label htmlFor="{{id}}"> in this file. Add the label, or use aria-label.',
    },
  },
  create(context) {
    const rel = path.relative(REPO_ROOT, context.filename).split(path.sep).join('/');
    if (rel.startsWith(UI_DIR)) return {};
    const allowlist = context.options[0]?.allowlist ?? readControlAllowlist();
    // Own-property lookup: a file called "constructor" or "__proto__" must not read the prototype.
    const allowed = Object.prototype.hasOwnProperty.call(allowlist, rel) ? allowlist[rel] : 0;

    const labelTargets = new Set();
    const idControls = [];
    const found = [];

    return {
      JSXOpeningElement(node) {
        if (node.name.type !== 'JSXIdentifier') return;
        const tag = node.name.name;

        const htmlFor = literal(attr(node, 'htmlFor') ?? attr(node, 'for'));
        if (htmlFor) labelTargets.add(htmlFor);
        if (!CONTROLS.has(tag)) return;

        if (node.attributes.some((a) => a.type === 'JSXSpreadAttribute')) return;
        if (hasValue(attr(node, 'aria-label')) || hasValue(attr(node, 'aria-labelledby'))) return;
        const inLabel = context.sourceCode
          .getAncestors(node)
          .some((a) => a.type === 'JSXElement' && a.openingElement.name.type === 'JSXIdentifier' && a.openingElement.name.name === 'label');
        if (inLabel) return;

        const id = attr(node, 'id');
        if (!id || isNothing(id)) {
          found.push({ node, messageId: 'unnamed', data: { tag } });
        } else if (literal(id) !== undefined) {
          idControls.push({ node, tag, id: literal(id) });
        }
      },
      'Program:exit'() {
        for (const { node, tag, id } of idControls) {
          if (!labelTargets.has(id)) found.push({ node, messageId: 'orphanId', data: { tag, id } });
        }
        // The first `allowed` reports in file order are the ones the list already knows about.
        found.sort((a, b) => a.node.range[0] - b.node.range[0]);
        for (const report of found.slice(allowed)) context.report(report);
      },
    };
  },
};
