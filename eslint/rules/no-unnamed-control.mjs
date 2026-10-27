/**
 * isaflow/no-unnamed-control — every <select> and <textarea> has an accessible name.
 *
 * The <input> half of this check is isaflow/no-raw-form-input; this rule uses the same name sources, outside
 * src/components/ui: aria-label, a non-empty title, aria-labelledby at an id written in the same file, an `id`
 * that a <label htmlFor> in the same file points at, or a wrapping <label>. Dynamic ids, dynamic aria-labelledby
 * and {...spread} props get the benefit of the doubt (the name may arrive through them). `hidden` and
 * aria-hidden controls are skipped: they are not in the accessibility tree.
 *
 * Not a name, and reported:
 *   - a <label> next to the control that names nothing;
 *   - aria-labelledby whose literal ids are none of them written as an `id` in this file;
 *   - a second labelable control inside one wrapping <label> (a label names only its first);
 *   - a control wrapped by a <label htmlFor="x"> that is not the control with id "x".
 * What this syntax-only rule cannot see (ids built at runtime, labels in another component, the kit under
 * src/components/ui, whose Select has no aria-label prop yet) is caught by axe's `label` rule through n-a11y.
 *
 * Files that already violate are listed in eslint/unnamed-control-allowlist.json as path -> number of reports;
 * a listed file may keep that many and the later ones in the file are reported, with the file and its count in
 * the message. The list only shrinks (scripts/ci/check-raw-input-allowlist.ts). It is a count, so it has one
 * inherent hole: fixing one control and adding an unnamed one in the same file leaves the count unchanged and
 * passes; axe through n-a11y is the backstop there. A missing list reads as empty, so deleting it reports every
 * violation instead of switching the rule off. Pass `{ allowlist: {} }` to see every violation.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, UI_DIR, OVER_LIST_MESSAGE, attr, literal, isNothing, hasValue, reportBeyondAllowlist } from './no-raw-form-input.mjs';

export const UNNAMED_CONTROL_ALLOWLIST_FILE = path.join(REPO_ROOT, 'eslint', 'unnamed-control-allowlist.json');

const CONTROLS = new Set(['select', 'textarea']);
const LABELABLE = new Set(['input', 'select', 'textarea']);

/** True for `hidden`, `hidden={true}`, `aria-hidden`, `aria-hidden="true"`; false for `{false}` / "false". */
function isHidden(node) {
  return ['hidden', 'aria-hidden'].some((n) => {
    const a = attr(node, n);
    return hasValue(a) && (literal(a) ?? '').trim().toLowerCase() !== 'false';
  });
}

function isLabel(n) {
  return n.type === 'JSXElement' && n.openingElement.name.type === 'JSXIdentifier' && n.openingElement.name.name === 'label';
}

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
      danglingLabelledby:
        '<{{tag}} aria-labelledby="{{ids}}"> points at no id written in this file, so it has no name. Fix the id, or use aria-label.',
      secondInLabel:
        '<{{tag}}> is not the first control inside its <label>, and a label names only its first. Give it its own label or aria-label.',
      overList: OVER_LIST_MESSAGE,
    },
  },
  create(context) {
    const rel = path.relative(REPO_ROOT, context.filename).split(path.sep).join('/');
    if (rel.startsWith(UI_DIR)) return {};
    const allowlist = context.options[0]?.allowlist ?? readControlAllowlist();
    // Own-property lookup: a file called "constructor" or "__proto__" must not read the prototype.
    const allowed = Object.prototype.hasOwnProperty.call(allowlist, rel) ? allowlist[rel] : 0;

    const labelTargets = new Set();
    const ids = new Set();
    const idControls = [];
    const labelledby = [];
    const firstInLabel = new Map();
    const found = [];

    return {
      JSXOpeningElement(node) {
        if (node.name.type !== 'JSXIdentifier') return;
        const tag = node.name.name;

        const htmlFor = literal(attr(node, 'htmlFor') ?? attr(node, 'for'));
        if (htmlFor) labelTargets.add(htmlFor);
        const ownId = literal(attr(node, 'id'));
        if (ownId) ids.add(ownId);
        if (!LABELABLE.has(tag)) return;
        // Nodes are visited in document order, so the first labelable one seen inside a label is its first.
        const label = context.sourceCode.getAncestors(node).reverse().find(isLabel);
        const hiddenInput = tag === 'input' && literal(attr(node, 'type'))?.toLowerCase() === 'hidden';
        if (label && !hiddenInput && !firstInLabel.has(label)) firstInLabel.set(label, node);
        if (!CONTROLS.has(tag)) return;

        if (node.attributes.some((a) => a.type === 'JSXSpreadAttribute')) return;
        if (isHidden(node)) return;
        if (hasValue(attr(node, 'aria-label')) || hasValue(attr(node, 'title'))) return;
        const by = attr(node, 'aria-labelledby');
        if (hasValue(by)) {
          const lit = literal(by);
          if (lit !== undefined) labelledby.push({ node, tag, ids: lit.trim().split(/\s+/) });
          return;
        }

        if (label) {
          const forAttr = attr(label.openingElement, 'htmlFor') ?? attr(label.openingElement, 'for');
          if (!forAttr) {
            if (firstInLabel.get(label) === node) return;
            found.push({ node, messageId: 'secondInLabel', data: { tag } });
            return;
          }
          // A label with htmlFor names its target: this control only if it is that target, or we cannot tell.
          const target = literal(forAttr);
          if (target === undefined || target === ownId) return;
        }

        const id = attr(node, 'id');
        if (!id || isNothing(id)) {
          found.push({ node, messageId: 'unnamed', data: { tag } });
        } else if (ownId !== undefined) {
          idControls.push({ node, tag, id: ownId });
        }
      },
      'Program:exit'() {
        for (const { node, tag, id } of idControls) {
          if (!labelTargets.has(id)) found.push({ node, messageId: 'orphanId', data: { tag, id } });
        }
        for (const { node, tag, ids: refs } of labelledby) {
          if (!refs.some((r) => ids.has(r))) found.push({ node, messageId: 'danglingLabelledby', data: { tag, ids: refs.join(' ') } });
        }
        // The first `allowed` reports in file order are the ones the list already knows about.
        reportBeyondAllowlist(context, found, allowed, { rel, name: 'eslint/unnamed-control-allowlist.json', messages: noUnnamedControl.meta.messages });
      },
    };
  },
};
