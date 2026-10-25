/**
 * isaflow/no-raw-form-input — forms use the kit (src/components/ui), not raw <input>.
 *
 * Reports, in files outside src/components/ui:
 *   1. <input type="date">  -> use <DateField> (typed shortcuts, dd MMM yyyy, ISO out).
 *   2. an <input> with no accessible name: none of aria-label, aria-labelledby, an `id` that a
 *      <label htmlFor> in the same file points at, or a wrapping <label>. Dynamic ids and
 *      {...spread} props are given the benefit of the doubt (the label may arrive through them).
 *      type="hidden" is exempt.
 *
 * Scope: <input> only. Unlabelled <select> and <textarea> are not checked here: adding them would put many more
 * files on the allowlist, and the allowlist may only shrink. A follow-up PR can widen the rule together with a
 * deliberate, reviewed regeneration of the list.
 *
 * `type` is read case-insensitively, and a conditional or logical `type={a ? 'date' : 'text'}` counts as a date
 * input if ANY branch is 'date'. A `type` the rule cannot see through (an identifier, a call) is given the
 * benefit of the doubt, as are {...spread} props.
 *
 * Files that already violate are listed in eslint/raw-input-allowlist.json and skipped. The list
 * only shrinks: scripts/ci/check-raw-input-allowlist.ts fails on an entry that no longer violates.
 * Pass `{ allowlist: [] }` to see every violation (that script does).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Paths in the allowlist and the kit prefix are relative to the repo root, wherever eslint was started from. */
const REPO_ROOT = path.resolve(here, '..', '..');
export const ALLOWLIST_FILE = path.join(REPO_ROOT, 'eslint', 'raw-input-allowlist.json');

const UI_DIR = 'src/components/ui/';

function defaultAllowlist() {
  return JSON.parse(readFileSync(ALLOWLIST_FILE, 'utf8'));
}

function attr(node, name) {
  return node.attributes.find((a) => a.type === 'JSXAttribute' && a.name.name === name);
}

/** The attribute's string value when it is a literal ("x", {"x"}, {`x`}); undefined otherwise. */
function literal(a) {
  const v = a?.value;
  if (!v) return undefined;
  if (v.type === 'Literal') return typeof v.value === 'string' ? v.value : undefined;
  if (v.type === 'JSXExpressionContainer') {
    const e = v.expression;
    if (e.type === 'Literal' && typeof e.value === 'string') return e.value;
    if (e.type === 'TemplateLiteral' && e.expressions.length === 0) return e.quasis[0]?.value.cooked;
  }
  return undefined;
}

/** Every string literal a `type` value could take: "x", {"x"}, {a ? 'x' : 'y'}, {a && 'x'}, {`x`}. */
function typeCandidates(a) {
  const out = [];
  const visit = (e) => {
    if (!e) return;
    if (e.type === 'Literal' && typeof e.value === 'string') out.push(e.value.trim().toLowerCase());
    else if (e.type === 'TemplateLiteral' && e.expressions.length === 0) out.push((e.quasis[0]?.value.cooked ?? '').trim().toLowerCase());
    else if (e.type === 'ConditionalExpression') { visit(e.consequent); visit(e.alternate); }
    else if (e.type === 'LogicalExpression') { visit(e.left); visit(e.right); }
  };
  const v = a?.value;
  if (v?.type === 'Literal') visit(v);
  else if (v?.type === 'JSXExpressionContainer') visit(v.expression);
  return out;
}

/** True when the attribute is present and not an empty literal. */
function hasValue(a) {
  if (!a) return false;
  const lit = literal(a);
  return lit === undefined ? a.value !== null : lit.trim() !== '';
}

/** @type {import('eslint').Rule.RuleModule} */
export const noRawFormInput = {
  meta: {
    type: 'problem',
    schema: [{ type: 'object', properties: { allowlist: { type: 'array', items: { type: 'string' } } }, additionalProperties: false }],
    messages: {
      rawDate:
        'Use <DateField> from @/components/ui instead of <input type="date"> (typed shortcuts, dd MMM yyyy, ISO value out).',
      unlabelled:
        '<input> has no accessible name. Add aria-label or aria-labelledby, an id that a <label htmlFor> points at, or wrap it in a <label>. Prefer the kit: Input, MoneyField, DateField.',
      orphanId:
        '<input id="{{id}}"> is not referenced by any <label htmlFor="{{id}}"> in this file. Add the label, or use aria-label.',
    },
  },
  create(context) {
    const rel = path.relative(REPO_ROOT, context.filename).split(path.sep).join('/');
    const allowlist = new Set(context.options[0]?.allowlist ?? defaultAllowlist());
    if (rel.startsWith(UI_DIR) || allowlist.has(rel)) return {};

    const labelTargets = new Set();
    const idInputs = [];

    return {
      JSXOpeningElement(node) {
        if (node.name.type !== 'JSXIdentifier') return;
        const tag = node.name.name;

        const htmlFor = literal(attr(node, 'htmlFor') ?? attr(node, 'for'));
        if (htmlFor) labelTargets.add(htmlFor);
        if (tag !== 'input') return;

        const types = typeCandidates(attr(node, 'type'));
        if (types.length > 0 && types.every((t) => t === 'hidden')) return;
        if (types.includes('date')) context.report({ node, messageId: 'rawDate' });

        if (node.attributes.some((a) => a.type === 'JSXSpreadAttribute')) return;
        if (hasValue(attr(node, 'aria-label')) || hasValue(attr(node, 'aria-labelledby'))) return;
        const inLabel = context.sourceCode
          .getAncestors(node)
          .some((a) => a.type === 'JSXElement' && a.openingElement.name.type === 'JSXIdentifier' && a.openingElement.name.name === 'label');
        if (inLabel) return;

        const id = attr(node, 'id');
        if (!id) {
          context.report({ node, messageId: 'unlabelled' });
        } else if (literal(id) !== undefined) {
          idInputs.push({ node, id: literal(id) });
        }
      },
      'Program:exit'() {
        for (const { node, id } of idInputs) {
          if (!labelTargets.has(id)) context.report({ node, messageId: 'orphanId', data: { id } });
        }
      },
    };
  },
};
