/**
 * isaflow/no-raw-form-input — forms use the kit (src/components/ui), not raw <input>.
 *
 * Reports, in files outside src/components/ui:
 *   1. <input type="date">  -> use <DateField> (typed shortcuts, dd MMM yyyy, ISO out).
 *   2. an <input> with no accessible name: none of aria-label, a non-empty title, aria-labelledby at an id written
 *      in the same file, an `id` that a <label htmlFor> in the same file points at, or a wrapping <label> that
 *      has text, an expression or a component in it (an empty `<label><input /></label>` names nothing).
 *      Dynamic ids, dynamic aria-labelledby and {...spread} props are given the benefit of the doubt (the name
 *      may arrive through them). type="hidden" is exempt.
 *
 * Scope: <input> only. Unlabelled <select> and <textarea> are isaflow/no-unnamed-control (./no-unnamed-control.mjs),
 * which shares the name helpers below and keeps its own allowlist.
 *
 * `type` is read case-insensitively, and a conditional or logical `type={a ? 'date' : 'text'}` counts as a date
 * input if ANY branch is 'date'. A `type` the rule cannot see through (an identifier, a call) is given the
 * benefit of the doubt, as are {...spread} props.
 *
 * Files that already violate are listed in eslint/raw-input-allowlist.json as path -> number of reports. A
 * listed file may keep that many; the rule reports only what is beyond it (the later ones in the file), so a
 * NEW raw input in a listed file fails too. The list only shrinks: scripts/ci/check-raw-input-allowlist.ts
 * fails when a count is higher than the base ref's or no longer matches the file. Pass `{ allowlist: {} }`
 * to see every violation (that script does).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Paths in the allowlist and the kit prefix are relative to the repo root, wherever eslint was started from. */
export const REPO_ROOT = path.resolve(here, '..', '..');
export const ALLOWLIST_FILE = path.join(REPO_ROOT, 'eslint', 'raw-input-allowlist.json');

export const UI_DIR = 'src/components/ui/';

function defaultAllowlist() {
  return JSON.parse(readFileSync(ALLOWLIST_FILE, 'utf8'));
}

export function attr(node, name) {
  return node.attributes.find((a) => a.type === 'JSXAttribute' && a.name.name === name);
}

/** The attribute's string value when it is a literal ("x", {"x"}, {`x`}); undefined otherwise. */
export function literal(a) {
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

/** `{undefined}`, `{null}`, `{false}`, `{''}` and `{``}`: written out, but there is nothing in them. */
export function isNothing(a) {
  const e = a.value?.type === 'JSXExpressionContainer' ? a.value.expression : a.value;
  if (!e) return false;
  if (e.type === 'Identifier') return e.name === 'undefined';
  if (e.type === 'Literal') return e.value === null || e.value === false || (typeof e.value === 'string' && e.value.trim() === '');
  if (e.type === 'TemplateLiteral' && e.expressions.length === 0) return (e.quasis[0]?.value.cooked ?? '').trim() === '';
  return false;
}

/** True when the attribute is present and carries something (a literal, or an expression we cannot see through). */
export function hasValue(a) {
  if (!a) return false;
  if (a.value === null) return true; // bare `aria-label` is `true`
  return !isNothing(a);
}

export function isLabel(n) {
  return n.type === 'JSXElement' && n.openingElement.name.type === 'JSXIdentifier' && n.openingElement.name.name === 'label';
}

const CONTROL_TAGS = new Set(['input', 'select', 'textarea']);

/** True unless the expression is plainly empty: `{}`, `{''}`, `{null}`, `{undefined}`, `{false}`. Anything dynamic may render text. */
function expressionMayRender(e) {
  if (e.type === 'JSXEmptyExpression') return false;
  if (e.type === 'Identifier') return e.name !== 'undefined';
  if (e.type === 'Literal') return typeof e.value === 'number' || (typeof e.value === 'string' && e.value.trim() !== '');
  if (e.type === 'TemplateLiteral' && e.expressions.length === 0) return (e.quasis[0]?.value.cooked ?? '').trim() !== '';
  return true;
}

/**
 * Whether a wrapping <label> can give its control a name: text, an expression that may render text, a component
 * (which may render text) or {...spread} inside it, or an aria-label / aria-labelledby / title on the label itself.
 * Controls inside the label are not looked into: a <select>'s <option> text is not the label's text. A label with
 * none of these (`<label><select /></label>`) names nothing.
 *
 * Accepted limit: a capitalised component or an expression inside the label is given the benefit of the doubt
 * (`<label><Icon /><input /></label>` passes); an icon-only label is axe's job through n-a11y, not this rule's.
 */
export function labelNamesContent(label) {
  const open = label.openingElement;
  if (open.attributes.some((a) => a.type === 'JSXSpreadAttribute')) return true;
  if (['aria-label', 'aria-labelledby', 'title'].some((n) => hasValue(attr(open, n)))) return true;
  const visit = (c) => {
    switch (c.type) {
      case 'JSXText': return c.value.trim() !== '';
      case 'JSXExpressionContainer': return expressionMayRender(c.expression);
      case 'JSXSpreadChild': return true;
      case 'JSXFragment': return c.children.some(visit);
      case 'JSXElement': {
        const n = c.openingElement.name;
        if (n.type !== 'JSXIdentifier') return true;
        if (CONTROL_TAGS.has(n.name)) return false;
        if (/^[A-Z]/.test(n.name)) return true;
        return c.children.some(visit);
      }
      default: return false;
    }
  };
  return label.children.some(visit);
}

/** The message `overList` wraps: what the file has too many of, which file, and its allowed count. */
export const OVER_LIST_MESSAGE =
  '{{what}} ({{file}} may have {{allowed}} by {{list}} and now has more. The report lands on the first control past the count in file order; the one you added or changed may be earlier in the file.)';

/**
 * Reports `found` beyond the first `allowed` in file order. In a listed file each one names the file and its count,
 * because the report lands on whichever control is past the count, not necessarily the one that changed.
 */
export function reportBeyondAllowlist(context, found, allowed, list) {
  found.sort((a, b) => a.node.range[0] - b.node.range[0]);
  for (const report of found.slice(allowed)) {
    if (allowed === 0) { context.report(report); continue; }
    const template = list.messages[report.messageId];
    const what = template.replace(/\{\{(\w+)\}\}/g, (_, k) => report.data?.[k] ?? '');
    context.report({ node: report.node, messageId: 'overList', data: { what, file: list.rel, allowed: String(allowed), list: list.name } });
  }
}

/** @type {import('eslint').Rule.RuleModule} */
export const noRawFormInput = {
  meta: {
    type: 'problem',
    schema: [{ type: 'object', properties: { allowlist: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } } }, additionalProperties: false }],
    messages: {
      rawDate:
        'Use <DateField> from @/components/ui instead of <input type="date"> (typed shortcuts, dd MMM yyyy, ISO value out).',
      unlabelled:
        '<input> has no accessible name. Add aria-label or aria-labelledby, an id that a <label htmlFor> points at, or wrap it in a <label>. Prefer the kit: Input, MoneyField, DateField.',
      danglingLabelledby:
        '<input aria-labelledby="{{ids}}"> points at no id written in this file, so it has no name. Fix the id, or use aria-label.',
      orphanId:
        '<input id="{{id}}"> is not referenced by any <label htmlFor="{{id}}"> in this file. Add the label, or use aria-label.',
      overList: OVER_LIST_MESSAGE,
    },
  },
  create(context) {
    const rel = path.relative(REPO_ROOT, context.filename).split(path.sep).join('/');
    const allowlist = context.options[0]?.allowlist ?? defaultAllowlist();
    if (rel.startsWith(UI_DIR)) return {};
    // Own-property lookup: a file called "constructor" or "__proto__" must not read the prototype.
    const allowed = Object.prototype.hasOwnProperty.call(allowlist, rel) ? allowlist[rel] : 0;

    const labelTargets = new Set();
    const idInputs = [];
    const ids = new Set();
    const labelledby = [];
    const found = [];

    return {
      JSXOpeningElement(node) {
        if (node.name.type !== 'JSXIdentifier') return;
        const tag = node.name.name;

        const htmlFor = literal(attr(node, 'htmlFor') ?? attr(node, 'for'));
        if (htmlFor) labelTargets.add(htmlFor);
        const ownId = literal(attr(node, 'id'));
        if (ownId) ids.add(ownId);
        if (tag !== 'input') return;

        const types = typeCandidates(attr(node, 'type'));
        if (types.length > 0 && types.every((t) => t === 'hidden')) return;
        if (types.includes('date')) found.push({ node, messageId: 'rawDate' });

        if (node.attributes.some((a) => a.type === 'JSXSpreadAttribute')) return;
        if (hasValue(attr(node, 'aria-label')) || hasValue(attr(node, 'title'))) return;
        const by = attr(node, 'aria-labelledby');
        if (hasValue(by)) {
          const lit = literal(by);
          if (lit !== undefined) labelledby.push({ node, ids: lit.trim().split(/\s+/) });
          return;
        }
        if (context.sourceCode.getAncestors(node).some((a) => isLabel(a) && labelNamesContent(a))) return;

        const id = attr(node, 'id');
        if (!id || isNothing(id)) {
          found.push({ node, messageId: 'unlabelled' });
        } else if (literal(id) !== undefined) {
          idInputs.push({ node, id: literal(id) });
        }
      },
      'Program:exit'() {
        for (const { node, id } of idInputs) {
          if (!labelTargets.has(id)) found.push({ node, messageId: 'orphanId', data: { id } });
        }
        // Accepted limit: only literal `id`s written in THIS file count. An id rendered by a child component is
        // invisible here and reports as dangling; name that input with aria-label instead.
        for (const { node, ids: refs } of labelledby) {
          if (!refs.some((r) => ids.has(r))) found.push({ node, messageId: 'danglingLabelledby', data: { ids: refs.join(' ') } });
        }
        // The first `allowed` reports in file order are the ones the list already knows about.
        reportBeyondAllowlist(context, found, allowed, { rel, name: 'eslint/raw-input-allowlist.json', messages: noRawFormInput.meta.messages });
      },
    };
  },
};
