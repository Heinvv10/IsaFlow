/**
 * R-184 evidence: every top-level declaration of src/lib/neon.ts at <base> is
 * present, byte-identical, in exactly one file of the split at <head>.
 * Compared text is the declaration itself (TS getText(): no leading comments),
 * with a leading `export ` removed on both sides, since the split had to export
 * LazyQuery and buildQuery to their sibling modules. Leading comments are
 * compared too, and reported separately.
 *
 * Run from the worktree root:
 *   bun docs/audits/remediation/R-184/bodyIdentity.mts <base-sha> <head-sha>
 */
import ts from 'typescript';
import { execFileSync } from 'node:child_process';

const [base, head] = process.argv.slice(2);
if (!base || !head) throw new Error('usage: bodyIdentity.mts <base-sha> <head-sha>');
const show = (rev: string, file: string) => execFileSync('git', ['show', `${rev}:${file}`], { encoding: 'utf8' });
const NEW_FILES = ['src/lib/neon.ts', 'src/lib/neon/pool.ts', 'src/lib/neon/query.ts', 'src/lib/neon/sql.ts', 'src/lib/neon/transaction.ts'];

interface Decl { name: string; text: string; comments: string; file: string; exported: boolean }
function decls(file: string, source: string): Decl[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out: Decl[] = [];
  for (const st of sf.statements) {
    const names = ts.isVariableStatement(st)
      ? st.declarationList.declarations.map((d) => d.name.getText())
      : (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) && st.name
        ? [st.name.text] : [];
    if (names.length === 0) continue;
    const raw = st.getText();
    const exported = /^export\s/.test(raw);
    const text = raw.replace(/^export\s+/, '');
    const comments = st.getFullText().slice(0, st.getStart() - st.getFullStart()).trim();
    for (const name of names) out.push({ name, text, comments, file, exported });
  }
  return out;
}

const before = decls('src/lib/neon.ts', show(base, 'src/lib/neon.ts'));
const after = NEW_FILES.flatMap((f) => decls(f, show(head, f)));
let bad = 0;
const lines: string[] = [`base ${base} (${before.length} declarations) -> head ${head} (${after.length} declarations)`];
for (const b of before) {
  const hits = after.filter((a) => a.name === b.name);
  if (hits.length !== 1) { bad += 1; lines.push(`MISSING-OR-DUPLICATED ${b.name}: ${hits.length} copies`); continue; }
  const a = hits[0]!;
  const same = a.text === b.text;
  if (!same) bad += 1;
  const exp = a.exported === b.exported ? '' : ` (export: ${b.exported} -> ${a.exported})`;
  const com = a.comments === b.comments ? 'comments identical' : 'comments CHANGED';
  lines.push(`${same ? 'IDENTICAL' : 'DIFFERENT'} ${b.name} -> ${a.file}${exp}; ${com}`);
}
for (const a of after) {
  if (!before.some((b) => b.name === a.name)) { bad += 1; lines.push(`NEW ${a.name} in ${a.file}`); }
}
lines.push(bad === 0 ? 'RESULT: every declaration moved byte-identical; none added' : `RESULT: ${bad} problem(s)`);
process.stdout.write(lines.join('\n') + '\n');
process.exit(bad === 0 ? 0 : 1);
