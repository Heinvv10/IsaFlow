/**
 * The pure half of scripts/ci/codemods/labelFor.ts: find `<label>` + control sibling pairs and name the control.
 *
 * Pattern: a `<label>` with no htmlFor (and no control inside it) whose next JSX sibling, whitespace aside, is an
 * <input>, <select> or <textarea> with no id, aria-label, aria-labelledby or {...spread}. The pair gets
 * `htmlFor="<id>"` and `id="<id>"`, where id is `<file-slug>-<name attr | label-text slug>`.
 *
 * Positional string insertion only: the source is never reprinted, so the output differs from the input only at
 * the returned insertion offsets. A second run is a no-op (the label now has htmlFor).
 *
 * Skipped, with a reason, because a static id would collide or could not be chosen:
 *   - the pair sits inside a .map/.flatMap/.forEach/.reduce/Array.from callback (`loop`);
 *   - the pair sits in a function nested inside another function, e.g. a renderRow helper (`nested-function`);
 *   - its top-level component is used as a JSX tag more than once in the same file, or once inside a loop
 *     callback, or, counting the `usesElsewhere` callback's answer, from 2+ places in all (`rendered-twice`);
 *   - the id is already used in the file, or two pairs would get the same one (`id-collision`);
 *   - neither a literal name attribute nor static label text to build the id from (`no-text`).
 * Uses in OTHER files come from `usesElsewhere` (the CLI counts them with git grep, by tag name, so a same-named
 * component elsewhere over-counts and the pair is skipped, the safe side). Skipped pairs are fixed by hand with useId.
 */
import ts from 'typescript';

export interface Insertion { offset: number; text: string }
export type SkipReason = 'loop' | 'nested-function' | 'rendered-twice' | 'id-collision' | 'no-text';
export interface PairReport { line: number; id: string; component: string | null; skip?: SkipReason }
export interface TransformResult { output: string; insertions: Insertion[]; pairs: PairReport[] }
export interface TransformOptions { /** JSX uses of a component name in files other than this one. */ usesElsewhere?: (component: string) => number }

const CONTROLS = new Set(['input', 'select', 'textarea']);
const LOOP_METHODS = new Set(['map', 'flatMap', 'forEach', 'reduce']);

type Tagged = ts.JsxElement | ts.JsxSelfClosingElement;
const opening = (n: Tagged): ts.JsxOpeningElement | ts.JsxSelfClosingElement => (ts.isJsxElement(n) ? n.openingElement : n);
const tagName = (n: Tagged): string => opening(n).tagName.getText();

function attrNamed(n: Tagged, ...names: string[]): ts.JsxAttribute | undefined {
  return opening(n).attributes.properties.find(
    (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && names.includes(p.name.getText()),
  );
}
const hasSpread = (n: Tagged): boolean => opening(n).attributes.properties.some(ts.isJsxSpreadAttribute);

function literalAttr(a: ts.JsxAttribute | undefined): string | undefined {
  const init = a?.initializer;
  if (!init) return undefined;
  if (ts.isStringLiteral(init)) return init.text;
  if (ts.isJsxExpression(init) && init.expression && ts.isStringLiteralLike(init.expression)) return init.expression.text;
  return undefined;
}

/** Kebab-case, at most 40 characters, cut at a word boundary. */
export function slug(text: string): string {
  const full = text
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (full.length <= 40) return full;
  const cut = full.slice(0, 41);
  return cut.slice(0, cut.lastIndexOf('-') > 0 ? cut.lastIndexOf('-') : 40);
}

/** `DetailsTab.tsx` -> `details-tab`; `index`, `new`, `edit` and `[id]` files take the directory's name too. */
export function fileSlug(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  const base = (parts.pop() ?? '').replace(/\.[jt]sx?$/, '');
  if (['index', 'new', 'edit'].includes(base) || base.startsWith('[')) return slug(`${parts.pop() ?? ''}-${base.replace(/[[\]]/g, '')}`);
  return slug(base);
}

function labelText(label: ts.JsxElement): string {
  let text = '';
  const visit = (n: ts.Node): void => {
    if (ts.isJsxText(n)) text += ` ${n.text}`;
    else if (ts.isJsxExpression(n) && n.expression && ts.isStringLiteralLike(n.expression)) text += ` ${n.expression.text}`;
    else n.forEachChild(visit);
  };
  label.children.forEach(visit);
  return text.replace(/\s+/g, ' ').trim();
}

function containsControl(label: ts.JsxElement): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if ((ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) && CONTROLS.has(tagName(n))) found = true;
    else if (!found) n.forEachChild(visit);
  };
  label.children.forEach(visit);
  return found;
}

const isFunctionLike = (n: ts.Node): boolean =>
  ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n);

function isLoopCallback(fn: ts.Node): boolean {
  const call = fn.parent;
  if (!call || !ts.isCallExpression(call) || !call.arguments.includes(fn as ts.Expression)) return false;
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const method = callee.name.text;
  return LOOP_METHODS.has(method) || (method === 'from' && callee.expression.getText() === 'Array');
}

/** The name of the outermost function's binding, e.g. `DetailsTab` for `export default function DetailsTab()`. */
function componentName(fn: ts.Node): string | null {
  if (ts.isFunctionDeclaration(fn)) return fn.name?.text ?? null;
  const parent = fn.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  return null;
}

/** Times each tag is rendered in the file; one use inside a loop callback counts as two (it repeats). */
function jsxTagUses(sf: ts.SourceFile): Map<string, number> {
  const uses = new Map<string, number>();
  const visit = (n: ts.Node): void => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const name = n.tagName.getText(sf);
      let inLoop = false;
      for (let p: ts.Node | undefined = n.parent; p && !inLoop; p = p.parent) inLoop = isFunctionLike(p) && isLoopCallback(p);
      uses.set(name, (uses.get(name) ?? 0) + (inLoop ? 2 : 1));
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return uses;
}

function existingIds(sf: ts.SourceFile): Set<string> {
  const ids = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isJsxAttribute(n) && ['id', 'htmlFor'].includes(n.name.getText(sf))) {
      const v = literalAttr(n);
      if (v !== undefined) ids.add(v);
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return ids;
}

interface Candidate { label: ts.JsxElement; control: Tagged; report: PairReport }

export function transformLabelFor(source: string, filePath: string, opts: TransformOptions = {}): TransformResult {
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const uses = jsxTagUses(sf);
  const taken = existingIds(sf);
  const prefix = fileSlug(filePath);
  const candidates: Candidate[] = [];

  const consider = (label: ts.JsxElement, control: Tagged): void => {
    const line = sf.getLineAndCharacterOfPosition(label.getStart(sf)).line + 1;
    const fns: ts.Node[] = [];
    for (let n: ts.Node | undefined = label.parent; n; n = n.parent) if (isFunctionLike(n)) fns.push(n);
    const outer = fns[fns.length - 1];
    const component = outer ? componentName(outer) : null;
    const base = literalAttr(attrNamed(control, 'name')) ?? labelText(label);
    const id = base && slug(base) ? `${prefix}-${slug(base)}` : '';
    const report: PairReport = { line, id, component };
    if (fns.some(isLoopCallback)) report.skip = 'loop';
    else if (fns.length > 1) report.skip = 'nested-function';
    else if (component && (uses.get(component) ?? 0) + (opts.usesElsewhere?.(component) ?? 0) > 1) report.skip = 'rendered-twice';
    else if (!id) report.skip = 'no-text';
    candidates.push({ label, control, report });
  };

  const visitChildren = (children: ts.NodeArray<ts.JsxChild>): void => {
    const kids = children.filter((c) => !(ts.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces));
    for (let i = 0; i + 1 < kids.length; i++) {
      const label = kids[i];
      const next = kids[i + 1];
      if (!label || !next || !ts.isJsxElement(label) || tagName(label) !== 'label') continue;
      if (!(ts.isJsxElement(next) || ts.isJsxSelfClosingElement(next)) || !CONTROLS.has(tagName(next))) continue;
      if (attrNamed(label, 'htmlFor', 'for') || containsControl(label)) continue;
      if (attrNamed(next, 'id', 'aria-label', 'aria-labelledby') || hasSpread(next)) continue;
      if (tagName(next) === 'input' && literalAttr(attrNamed(next, 'type'))?.toLowerCase() === 'hidden') continue;
      consider(label, next);
    }
  };
  const walk = (n: ts.Node): void => {
    if (ts.isJsxElement(n) || ts.isJsxFragment(n)) visitChildren(n.children);
    n.forEachChild(walk);
  };
  walk(sf);

  const counts = new Map<string, number>();
  for (const c of candidates) if (!c.report.skip) counts.set(c.report.id, (counts.get(c.report.id) ?? 0) + 1);
  const insertions: Insertion[] = [];
  for (const c of candidates) {
    if (c.report.skip) continue;
    if (taken.has(c.report.id) || (counts.get(c.report.id) ?? 0) > 1) {
      c.report.skip = 'id-collision';
      continue;
    }
    insertions.push({ offset: opening(c.label).tagName.end, text: ` htmlFor="${c.report.id}"` });
    insertions.push({ offset: opening(c.control).tagName.end, text: ` id="${c.report.id}"` });
  }
  insertions.sort((a, b) => a.offset - b.offset);
  let output = '';
  let at = 0;
  for (const ins of insertions) {
    output += source.slice(at, ins.offset) + ins.text;
    at = ins.offset;
  }
  output += source.slice(at);
  return { output, insertions, pairs: candidates.map((c) => c.report).sort((a, b) => a.line - b.line) };
}
