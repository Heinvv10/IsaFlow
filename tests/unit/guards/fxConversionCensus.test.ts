/**
 * FX PR0 census — a source RATCHET; the behaviour is proved by
 * tests/unit/accounting/functionalAmounts.test.ts and the parity test in
 * tests/integration/fx-pr0-db.int.test.ts.
 *
 * A document's rand figure is computed in ONE place: public.fx_functional in
 * SQL, or its exact-decimal twin toFunctional in TypeScript. A multiplication
 * by an exchange rate anywhere else is a second conversion, and the FX plan
 * rests on there being one: GL and subledger only foot if they round alike.
 *
 * Parsed, not grepped: every `*` / `*=` BinaryExpression and every
 * `.times(` / `.mul(` / `.multipliedBy(` call in src/ and pages/ is checked,
 * so line breaks, `Number(row.exchange_rate)`, `(inv.exchangeRate)`, casts and
 * non-null assertions do not hide one. An operand is rate-like when, with
 * Number()/parentheses/casts/`!` unwrapped, it is an identifier or property
 * named like a rate (/exchange_?rate|fx_?rate|\brate\b|\ber\b/i), or a local
 * whose initialiser is. SQL inside string and template literals is scanned
 * for `* exchange_rate` / `exchange_rate *` (any whitespace, newlines too).
 *
 * WHAT IT CANNOT SEE, stated rather than glossed: a rate reaching the
 * multiplication through a function return, a destructured parameter, an
 * object spread or a variable assigned after its declaration; a rate held in
 * a name that does not look like one (`const k = row.exchange_rate` IS caught,
 * `function f(k) { return x * k }; f(row.exchange_rate)` is not); SQL built
 * by string concatenation across literals; and anything outside src/ and
 * pages/. Read from disk, not git ls-files, so an untracked file is scanned.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

const ROOT = resolve(__dirname, '../../..');

/** The one TypeScript conversion. */
const ALLOWED = new Set(['src/modules/accounting/services/shared/functionalAmounts.ts']);

/**
 * Sites the pattern matches that multiply by a rate which is NOT an exchange
 * rate, each read and named. `\brate\b` is broad on purpose (it is what
 * catches `total * inv.rate`), so tax, interest, mileage and hourly rates land
 * here. Keyed by file and expression text, not line, so a moved line still
 * matches and any NEW site fails the census until someone reads it.
 */
const NOT_EXCHANGE_RATES: Record<string, string> = {
  'src/lib/amortisation/pmt.ts: rate.times(pv.times(q).plus(fv))': 'loan interest rate',
  'src/lib/taxCalculations.ts: taxable * bracket.rate': 'PAYE bracket rate',
  'src/modules/accounting/services/afs/complianceCheckerService.ts: rate * 10000': 'a percentage to basis points',
  'src/modules/accounting/services/core/timeTrackingService.ts: hours * rate': 'hourly billing rate',
  'src/modules/accounting/services/expense/expenseClaimService.ts: km * rate': 'mileage rate per km',
  'src/modules/accounting/services/items/depreciationMethods.ts: carrying * rate': 'depreciation rate',
  'src/modules/accounting/services/payroll/taxTables.ts: bracket.rate * (annualIncome - bracket.from + 1)': 'PAYE bracket rate',
  'src/modules/accounting/services/payroll/taxTables.ts: last.rate * (annualIncome - last.from + 1)': 'PAYE bracket rate',
  'src/modules/accounting/services/practice/wipInvoiceGuards.ts: hours * rate': 'hourly billing rate',
  'src/modules/accounting/services/reports/beeComplianceService.ts: base * rate': 'B-BBEE spend percentage',
  'src/modules/accounting/services/reports/timeTrackingReportService.ts: hours * rate': 'hourly billing rate',
  'src/modules/accounting/services/reports/vat201LedgerFields.ts: vat201.field1_standardRatedSupplies * vat201.rateCheck.rate': 'VAT rate',
  'src/modules/accounting/services/reports/vatInputOverclaim.ts: a.base * rate': 'VAT rate',
  'src/modules/accounting/services/reports/vatInputSupport.ts: f.bankAmount * rate': 'VAT fraction of a bank amount',
  'pages/payroll/batches/[id].tsx: km * rate': 'mileage rate per km',
};

const RATE_NAME = /exchange_?rate|fx_?rate|\brate\b|\ber\b/i;
const SQL_RATE = /(?:exchange_rate|fx_rate)\s*\*|\*\s*[\w."]*\b(?:exchange_rate|fx_rate)\b/i;
const MULTIPLY_CALLS = new Set(['times', 'mul', 'multipliedBy']);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function unwrap(node: ts.Expression): ts.Expression {
  let n = node;
  for (;;) {
    if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n)
      || ts.isTypeAssertionExpression(n) || ts.isSatisfiesExpression(n)) { n = n.expression; continue; }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && ['Number', 'parseFloat'].includes(n.expression.text)
      && n.arguments.length >= 1) { n = n.arguments[0]!; continue; }
    return n;
  }
}

/** Every `*` and multiply-call site in `source` whose operand is rate-like. */
export function conversionSites(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const tainted = new Set<string>();
  const rateLike = (e: ts.Expression): boolean => {
    const u = unwrap(e);
    if (ts.isIdentifier(u)) return RATE_NAME.test(u.text) || tainted.has(u.text);
    if (ts.isPropertyAccessExpression(u)) return RATE_NAME.test(u.name.text);
    if (ts.isElementAccessExpression(u) && ts.isStringLiteralLike(u.argumentExpression)) {
      return RATE_NAME.test(u.argumentExpression.text);
    }
    return false;
  };
  const sites: string[] = [];
  const at = (n: ts.Node) => `${fileName}: ${n.getText().replace(/\s+/g, ' ').slice(0, 120)}`;
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && rateLike(n.initializer)) tainted.add(n.name.text);
    if (ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.AsteriskToken
      || n.operatorToken.kind === ts.SyntaxKind.AsteriskEqualsToken) && (rateLike(n.left) || rateLike(n.right))) sites.push(at(n));
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && MULTIPLY_CALLS.has(n.expression.name.text)
      && (rateLike(n.expression.expression) || n.arguments.some(rateLike))) sites.push(at(n));
    if ((ts.isNoSubstitutionTemplateLiteral(n) || ts.isStringLiteral(n)) && SQL_RATE.test(n.text)) sites.push(at(n));
    if (ts.isTemplateExpression(n) && SQL_RATE.test([n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join(' '))) sites.push(at(n));
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return sites;
}

describe('exchange-rate conversions happen in one place', () => {
  it('no code in src/ or pages/ multiplies by an exchange rate outside functionalAmounts.ts', () => {
    const sites: string[] = [];
    for (const abs of ['src', 'pages'].flatMap((d) => walk(join(ROOT, d)))) {
      const rel = relative(ROOT, abs);
      if (!ALLOWED.has(rel)) sites.push(...conversionSites(rel, readFileSync(abs, 'utf8')));
    }
    expect(sites.filter((s) => !(s in NOT_EXCHANGE_RATES))).toEqual([]);
    // An entry that no longer matches anything is stale and must go.
    expect(Object.keys(NOT_EXCHANGE_RATES).filter((k) => !sites.includes(k))).toEqual([]);
  });

  it('catches the shapes it must (self-test)', () => {
    const caught = (code: string) => conversionSites('t.ts', code).length;
    for (const code of [
      'const f = Math.round(totalAmount * invExchangeRate * 100) / 100;',
      'const f = total * Number(row.exchange_rate);',
      'const f = total * inv.rate;',
      'const f = total * (inv.exchangeRate);',
      'const f = total * (inv.exchangeRate as number);',
      'const f = total * inv.fx_rate!;',
      'const f = new Decimal(total).times(exchangeRate);',
      'const f = total\n  *\n  form.exchangeRate;',
      'const k = row.exchange_rate; const f = total * k;',
      'let t = total; t *= er;',
      'const q = sql`SELECT total_amount\n  * exchange_rate FROM customer_invoices`;',
      "const q = 'SELECT total_amount * ci.exchange_rate';",
    ]) expect(caught(code), code).toBe(1);
  });

  it('does not flag what is not a conversion (self-test)', () => {
    for (const code of [
      'const t = subtotal * (taxRate / 100);',
      'const t = subtotal * (rate / 100);',
      'const x = { exchangeRate: Number(row.exchange_rate ?? 1) };',
      'const t = hours * hourlyRate;',
      "const q = sql`SELECT public.fx_functional(total_amount, exchange_rate)`;",
    ]) expect(conversionSites('t.ts', code), code).toEqual([]);
  });
});
