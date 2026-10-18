/**
 * Every template literal in a TypeScript source, each with its OWN text.
 *
 * A regex over backticks pairs the wrong ones as soon as a template nests another
 * (`${cond ? sql`...` : sql`...`}`), so the per-statement ratchets that read SQL out of
 * source (tests/unit/guards/yearEndJournalCensus.test.ts) use this scanner instead. It knows
 * comments, quoted strings, `${...}` expressions and nested templates.
 *
 * `text` is the literal's direct text: its nested templates are replaced by `` `…` `` and its
 * `${expr}` interpolations are kept as written, so a marker such as
 * `${YEAR_END_JOURNAL_SOURCE}` is visible but belongs only to the statement that holds it.
 */

export interface TemplateLiteral {
  /** The identifier directly before the opening backtick ('sql', 'tx', ...), or '' when untagged. */
  tag: string;
  text: string;
  /** 1-based line of the opening backtick. */
  line: number;
}

export function templateLiterals(src: string): TemplateLiteral[] {
  const out: TemplateLiteral[] = [];
  let i = 0;

  const lineAt = (pos: number): number => src.slice(0, pos).split('\n').length;

  function skipQuoted(q: string): void {
    i += 1;
    while (i < src.length && src[i] !== q) i += src[i] === '\\' ? 2 : 1;
    i += 1;
  }

  /** Parse a template whose opening backtick is at `i`; leaves `i` after the closing one. */
  function template(): void {
    let j = i - 1;
    while (j >= 0 && src[j] === ' ') j -= 1;
    // A generic argument (`sql<Row[]>`...) ends in '>', which is part of the tag expression.
    if (src[j] === '>') {
      while (j >= 0 && src[j] !== '<') j -= 1;
      j -= 1;
    }
    let k = j;
    while (k >= 0 && /[\w$.]/.test(src[k]!)) k -= 1;
    const tag = src.slice(k + 1, j + 1);
    const line = lineAt(i);
    const slot = out.length;
    out.push({ tag, text: '', line });
    let text = '';
    i += 1;
    while (i < src.length && src[i] !== '`') {
      if (src[i] === '\\') { text += src.slice(i, i + 2); i += 2; continue; }
      if (src[i] === '$' && src[i + 1] === '{') {
        text += '${';
        i += 2;
        text += expression();
        text += '}';
        continue;
      }
      text += src[i];
      i += 1;
    }
    i += 1;
    out[slot]!.text = text;
  }

  /** Source of a `${ ... }` body; leaves `i` after its closing brace. */
  function expression(): string {
    let depth = 1;
    let text = '';
    while (i < src.length) {
      const c = src[i]!;
      if (c === '`') { template(); text += '`…`'; continue; }
      if (c === '"' || c === "'") { const s = i; skipQuoted(c); text += src.slice(s, i); continue; }
      if (c === '{') depth += 1;
      if (c === '}') { depth -= 1; if (depth === 0) { i += 1; return text; } }
      text += c;
      i += 1;
    }
    return text;
  }

  while (i < src.length) {
    const c = src[i]!;
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (c === '"' || c === "'") { skipQuoted(c); continue; }
    if (c === '`') { template(); continue; }
    i += 1;
  }
  return out;
}
