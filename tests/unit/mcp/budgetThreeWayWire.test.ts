/**
 * The three-way tools' money conversion is an ALLOWLIST (review round 1, M3): every numeric field of the answers
 * `centsDeep` converts (ThreeWayView's run sections, DeriveView's evidence) must be classified money or not-money,
 * and an unclassified number is refused, never guessed. This test walks those TYPES with the TypeScript compiler
 * (threeWayViews.ts and everything it references), so a numeric field added to the engine's output fails here
 * until it is classified. Plus the conversion itself, and the document's money fields both ways.
 */
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { join } from 'node:path';
import { centsDeep, docFromWire, docToWire, MONEY_KEYS, NOT_MONEY_KEYS } from '@/lib/mcp/tools/budgetThreeWayWire';

const FILE = join(process.cwd(), 'src/modules/accounting/services/budgets/threeWay/threeWayViews.ts');

/** Every property name whose type is (or contains) a number, under the named interface's listed properties. */
function numericKeys(interfaceName: string, only: readonly string[] | null, skip: readonly string[]): Set<string> {
  const program = ts.createProgram([FILE], { strict: true, baseUrl: process.cwd(), paths: { '@/*': ['src/*'] }, noEmit: true, skipLibCheck: true });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(FILE)!;
  let decl: ts.InterfaceDeclaration | undefined;
  ts.forEachChild(source, (n) => { if (ts.isInterfaceDeclaration(n) && n.name.text === interfaceName) decl = n; });
  if (!decl) throw new Error(`no interface ${interfaceName}`);
  const out = new Set<string>();
  const seen = new Set<ts.Type>();
  const walk = (t: ts.Type, name: string) => {
    if (t.flags & ts.TypeFlags.NumberLike) { out.add(name); return; }
    if (t.isUnion() || t.isIntersection()) { for (const u of t.types) walk(u, name); return; }
    if (seen.has(t)) return;
    seen.add(t);
    if (checker.isArrayType(t)) { for (const a of checker.getTypeArguments(t as ts.TypeReference)) walk(a, name); return; }
    if (t.flags & ts.TypeFlags.Object) for (const p of checker.getPropertiesOfType(t)) walk(checker.getTypeOfSymbolAtLocation(p, source), p.getName());
  };
  const top = checker.getTypeAtLocation(decl);
  for (const p of checker.getPropertiesOfType(top)) {
    if ((only && !only.includes(p.getName())) || skip.includes(p.getName())) continue;
    walk(checker.getTypeOfSymbolAtLocation(p, source), p.getName());
  }
  return out;
}

describe('every numeric field the three-way tools convert is classified', () => {
  it('ThreeWayView run sections (version, months and assumptions are not converted by centsDeep) and DeriveView evidence', () => {
    const keys = new Set([
      ...numericKeys('ThreeWayView', null, ['version', 'months', 'assumptions']),
      ...numericKeys('DeriveView', ['evidence'], []),
    ]);
    expect(keys.size).toBeGreaterThan(40);
    const unclassified = [...keys].filter((k) => !MONEY_KEYS.has(k) && !NOT_MONEY_KEYS.has(k)).sort();
    expect(unclassified).toEqual([]);
    expect([...MONEY_KEYS].filter((k) => NOT_MONEY_KEYS.has(k))).toEqual([]);
  }, 60_000);

  it('converts money keys to decimal text, keeps not-money numbers, refuses an unclassified number', () => {
    expect(centsDeep({ closingCash: -123456, days: 365, months: 12, nested: [{ turnover: 5 }] })).toEqual({ closingCash: '-1234.56', days: 365, months: 12, nested: [{ turnover: '0.05' }] });
    expect(() => centsDeep({ newShinyFigure: 1 })).toThrow(/unclassified three-way figure newShinyFigure/);
    expect(() => centsDeep({ closingCash: 1.5 })).toThrow(/not whole cents/);
  });

  it('the document: five money fields to decimal text and back; a number in one is refused', () => {
    const doc = { schemaVersion: 1, capex: [{ amountExVat: 150000 }], loans: { planned: [{ principal: 1 }] }, equity: { shareIssues: [{ amount: 2 }], dividends: [{ amount: 3 }] }, minimumCash: { value: -5, source: 'manual' } };
    const wire = docToWire(doc);
    expect(wire).toEqual({ schemaVersion: 1, capex: [{ amountExVat: '1500.00' }], loans: { planned: [{ principal: '0.01' }] }, equity: { shareIssues: [{ amount: '0.02' }], dividends: [{ amount: '0.03' }] }, minimumCash: { value: '-0.05', source: 'manual' } });
    expect(docFromWire(wire)).toEqual({ doc });
    expect(docFromWire({ overrides: { capex: [{ amountExVat: 5 }] } })).toEqual({ errors: ['overrides.capex[0].amountExVat: amounts are decimal strings such as "1500.00", never numbers'] });
  });
});
