/**
 * R-184 evidence: print every export of `@/lib/neon` (src/lib/neon.ts) as the
 * TypeScript checker sees it — name, value/type, and the full type text — so the
 * surface before and after the split can be diffed.
 *
 * Run from the worktree root: bun docs/audits/remediation/R-184/exportSurface.mts
 */
import ts from 'typescript';
import path from 'node:path';

const root = process.cwd();
const entry = path.join(root, 'src/lib/neon.ts');
const cfg = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, root);
const program = ts.createProgram([entry], { ...parsed.options, noEmit: true, incremental: false });
const checker = program.getTypeChecker();
const sf = program.getSourceFile(entry);
if (!sf) throw new Error('entry not in program');
const mod = checker.getSymbolAtLocation(sf);
if (!mod) throw new Error('entry has no module symbol');

const F = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias | ts.TypeFormatFlags.UseFullyQualifiedType;
const strip = (s: string) => s.replace(/import\("[^"]+"\)\./g, '');
const name = (s: string) => s.replace(/^(__@\w+)@\d+$/, '$1');
const out: string[] = [];
for (const exp of checker.getExportsOfModule(mod)) {
  const sym = exp.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exp) : exp;
  const isValue = (sym.flags & ts.SymbolFlags.Value) !== 0;
  const isType = (sym.flags & ts.SymbolFlags.Type) !== 0;
  if (isValue) {
    const t = checker.getTypeOfSymbol(sym);
    out.push(`${exp.name} [value] ${strip(checker.typeToString(t, undefined, F))}`);
    for (const sig of t.getCallSignatures()) {
      out.push(`${exp.name}() ${strip(checker.signatureToString(sig, undefined, F))}`);
      // One level into what a call returns (LazyQuery for `sql`), so a change to it shows.
      const ret = sig.getReturnType();
      const ownDecl = ret.getSymbol()?.declarations?.some((d) => d.getSourceFile().fileName.startsWith(path.join(root, 'src')));
      if (!ownDecl) continue;
      for (const p of ret.getProperties()) {
        out.push(`${exp.name}()=>.${name(p.name)}: ${strip(checker.typeToString(checker.getTypeOfSymbol(p), undefined, F))}`);
      }
    }
    for (const p of t.getProperties()) {
      const pt = checker.getTypeOfSymbol(p);
      out.push(`${exp.name}.${p.name}: ${strip(checker.typeToString(pt, undefined, F))}`);
    }
  }
  if (isType) {
    const t = checker.getDeclaredTypeOfSymbol(sym);
    out.push(`${exp.name} [type] ${strip(checker.typeToString(t, undefined, F | ts.TypeFormatFlags.InTypeAlias))}`);
  }
}
out.sort();
process.stdout.write(out.join('\n') + '\n');
