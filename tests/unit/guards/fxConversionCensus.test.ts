/**
 * FX PR0 census — a source RATCHET, not the guarantee. The guarantee is PR1a's
 * GENERATED functional_total; until then this keeps a second conversion from
 * creeping in. The behaviour is proved by functionalAmounts.test.ts and the
 * parity test in tests/integration/fx-pr0-db.int.test.ts.
 *
 * A document's rand figure is computed in ONE place: public.fx_functional in
 * SQL, or its exact-decimal twin toFunctional in TypeScript. Multiplying or
 * dividing by an exchange rate anywhere else is a second conversion, and the
 * FX plan rests on there being one: GL and subledger only foot if they round
 * alike.
 *
 * Parsed, not grepped: every `*`, `*=`, `/`, `/=` BinaryExpression and every
 * `.times(` / `.mul(` / `.multipliedBy(` / `.div(` / `.dividedBy(` call in
 * src/ and pages/ is checked. An operand is rate-like when, with
 * Number()/parseFloat()/parentheses/casts/`!` unwrapped, it is an identifier
 * or property named like a rate (/exchange_?rate|fx_?rate|\brate\b|\ber\b/i),
 * either side of `??` / `||` or either branch of `?:` is, or it is a local
 * initialised from one (destructured renames included:
 * `const { exchange_rate: k } = row`). SQL in string and template literals is
 * scanned for a rate (`exchange_rate`, `fx_rate`, `er.rate`,
 * `exchange_rates.rate`) multiplied or divided, across line breaks and
 * through a wrapping call or parenthesis (`* COALESCE(exchange_rate, 1)`,
 * `ROUND(total * er.rate, 2)`).
 *
 * NAMED LIMITS — what it cannot see:
 *   - a rate returned from a function (`total * rateFor(inv)`);
 *   - a `let` reassigned after its declaration (`let k = 1; k = row.exchange_rate`);
 *   - a rate held in a name that does not look like one and was not
 *     initialised from one in the same file (a parameter, an import, a
 *     field of an object built elsewhere);
 *   - an object spread or a destructured PARAMETER;
 *   - SQL assembled by concatenating separate literals, or with the rate
 *     interpolated (`sql\`... total * ${rate} ...\``: the literal holds only `*`);
 *   - camelCase rate names the pattern does not know (`zarRate`, `spotRate`,
 *     `conversionRate`): `\brate\b` matches a whole word only;
 *   - `Decimal.mul` / `.times` on a WRAPPED rate (`new Decimal(rate)`, a call result);
 *   - unary `+` coercion (`total * +row.exchange_rate`: the `+` is not unwrapped);
 *   - BigInt products (`BigInt(a) * BigInt(r)`, as toFunctional itself does);
 *   - anything outside src/ and pages/.
 * The census stops here; PR1a's GENERATED functional_total is the guarantee.
 * Files with no rate-like token at all are not parsed (they cannot contain a
 * site), which is what keeps this under a few seconds. Read from disk, not
 * git ls-files, so an untracked file is scanned.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

const ROOT = resolve(__dirname, '../../..');

/** The one TypeScript conversion. */
const ALLOWED = new Set(['src/modules/accounting/services/shared/functionalAmounts.ts']);

/**
 * Files whose matches are rates that are NOT exchange rates — tax, interest,
 * mileage, hourly, depreciation — each read, with the exact number of sites.
 * A count, not a list of lines: a new site in one of these files changes the
 * count and fails until someone reads it; a file not named here may have none.
 */
const NOT_EXCHANGE_RATES: Record<string, { sites: number; why: string }> = {
  'src/lib/amortisation/engine.ts': { sites: 1, why: 'annual interest rate to a monthly fraction' },
  'src/lib/amortisation/pmt.ts': { sites: 1, why: 'loan interest rate' },
  'src/lib/taxCalculations.ts': { sites: 1, why: 'PAYE bracket rate' },
  'src/modules/accounting/services/afs/complianceCheckerService.ts': { sites: 1, why: 'a percentage to basis points' },
  'src/modules/accounting/services/core/timeTrackingService.ts': { sites: 1, why: 'hourly billing rate' },
  'src/modules/accounting/services/expense/expenseClaimService.ts': { sites: 1, why: 'mileage rate per km' },
  'src/modules/accounting/services/items/depreciationMethods.ts': { sites: 1, why: 'depreciation rate' },
  'src/modules/accounting/services/payroll/taxTables.ts': { sites: 2, why: 'PAYE bracket rates' },
  'src/modules/accounting/services/practice/wipInvoiceGuards.ts': { sites: 1, why: 'hourly billing rate' },
  'src/modules/accounting/services/reports/beeComplianceService.ts': { sites: 1, why: 'B-BBEE spend percentage' },
  'src/modules/accounting/services/reports/timeTrackingReportService.ts': { sites: 1, why: 'hourly billing rate' },
  'src/modules/accounting/services/reports/vat201LedgerFields.ts': { sites: 1, why: 'VAT rate' },
  'src/modules/accounting/services/reports/vatInputOverclaim.ts': { sites: 1, why: 'VAT rate' },
  'src/modules/accounting/services/reports/vatInputSupport.ts': { sites: 2, why: 'VAT fraction of a bank amount' },
  'pages/api/accounting/time-entries-invoice.ts': { sites: 3, why: 'hourly billing rate (twice) and the VAT rate percentage' },
  'pages/payroll/batches/[id].tsx': { sites: 1, why: 'mileage rate per km' },
};

const RATE_NAME = /exchange_?rate|fx_?rate|\brate\b|\ber\b/i;
const ANY_RATE_TOKEN = /exchange_?rate|fx_?rate|\brate\b|\ber\b/i;
const SQL_RATE_ID = String.raw`\b(?:exchange_rate|fx_rate|er\.rate|exchange_rates\.rate)\b`;
const SQL_RATE = new RegExp(
  String.raw`[*/]\s*(?:[A-Za-z_][\w.]*\s*\(\s*|\(\s*)*[\w."]*?${SQL_RATE_ID}`
  + String.raw`|${SQL_RATE_ID}(?:\s*(?:,[^()]*)?\))*\s*[*/]`, 'i');
const OPERATORS = new Set([ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashToken, ts.SyntaxKind.SlashEqualsToken]);
const ARITHMETIC_CALLS = new Set(['times', 'mul', 'multipliedBy', 'div', 'dividedBy']);

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

/** Every rate-multiplying (or dividing) site in `source`, as `file: expression`. */
export function conversionSites(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const tainted = new Set<string>();
  const rateLike = (e: ts.Expression): boolean => {
    const u = unwrap(e);
    if (ts.isIdentifier(u)) return RATE_NAME.test(u.text) || tainted.has(u.text);
    if (ts.isPropertyAccessExpression(u)) return RATE_NAME.test(u.name.text);
    if (ts.isElementAccessExpression(u) && ts.isStringLiteralLike(u.argumentExpression)) return RATE_NAME.test(u.argumentExpression.text);
    if (ts.isBinaryExpression(u) && (u.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      || u.operatorToken.kind === ts.SyntaxKind.BarBarToken)) return rateLike(u.left) || rateLike(u.right);
    if (ts.isConditionalExpression(u)) return rateLike(u.whenTrue) || rateLike(u.whenFalse);
    return false;
  };
  const sites: string[] = [];
  const at = (n: ts.Node) => `${fileName}: ${n.getText().replace(/\s+/g, ' ').slice(0, 120)}`;
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && n.initializer) {
      if (ts.isIdentifier(n.name) && rateLike(n.initializer)) tainted.add(n.name.text);
      if (ts.isObjectBindingPattern(n.name)) {
        for (const el of n.name.elements) {
          const key = el.propertyName && (ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName))
            ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : '';
          if (ts.isIdentifier(el.name) && RATE_NAME.test(key)) tainted.add(el.name.text);
        }
      }
    }
    if (ts.isBinaryExpression(n) && OPERATORS.has(n.operatorToken.kind) && (rateLike(n.left) || rateLike(n.right))) sites.push(at(n));
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ARITHMETIC_CALLS.has(n.expression.name.text)
      && (rateLike(n.expression.expression) || n.arguments.some(rateLike))) sites.push(at(n));
    if ((ts.isNoSubstitutionTemplateLiteral(n) || ts.isStringLiteral(n)) && SQL_RATE.test(n.text)) sites.push(at(n));
    if (ts.isTemplateExpression(n) && SQL_RATE.test([n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join(' '))) sites.push(at(n));
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return sites;
}

/** Every site in a file whose count is not EXACTLY the reviewed count (a file not listed has a count of 0). */
export function unexplainedSites(perFile: ReadonlyMap<string, string[]>, allowed = NOT_EXCHANGE_RATES): string[] {
  return [...perFile].filter(([file, sites]) => (allowed[file]?.sites ?? 0) !== sites.length).flatMap(([, s]) => s);
}

describe('exchange-rate conversions happen in one place', () => {
  it('no code in src/ or pages/ multiplies or divides by an exchange rate outside functionalAmounts.ts', () => {
    const perFile = new Map<string, string[]>();
    for (const abs of ['src', 'pages'].flatMap((d) => walk(join(ROOT, d)))) {
      const rel = relative(ROOT, abs);
      if (ALLOWED.has(rel)) continue;
      const source = readFileSync(abs, 'utf8');
      if (!ANY_RATE_TOKEN.test(source)) continue;
      const sites = conversionSites(rel, source);
      if (sites.length > 0) perFile.set(rel, sites);
    }
    expect(unexplainedSites(perFile)).toEqual([]);
    // An entry that no longer matches anything is stale and must go.
    expect(Object.keys(NOT_EXCHANGE_RATES).filter((f) => !perFile.has(f))).toEqual([]);
  }, 20_000);

  it('catches the shapes it must (self-test)', () => {
    for (const code of [
      'const f = Math.round(totalAmount * invExchangeRate * 100) / 100;',
      'const f = total * Number(row.exchange_rate);',
      'const f = total * Number(x.exchange_rate ?? 1);',
      'const f = total * (inv.exchangeRate || 1);',
      'const f = total * (fx ? inv.fxRate : 1);',
      'const f = total * inv.rate;',
      'const f = total * (inv.exchangeRate as number);',
      'const f = total * inv.fx_rate!;',
      'const f = total / inv.exchange_rate;',
      'let t = total; t /= er;',
      'const f = new Decimal(total).times(exchangeRate);',
      'const f = new Decimal(total).div(exchangeRate);',
      'const f = total\n  *\n  form.exchangeRate;',
      'const k = row.exchange_rate; const f = total * k;',
      'const { exchange_rate: k } = row; const f = total * k;',
      'const { exchangeRate: k } = input; const f = total * k;',
      'let t = total; t *= er;',
      'const q = sql`SELECT total_amount\n  * exchange_rate FROM customer_invoices`;',
      'const q = sql`SELECT total_amount *\n         ci.exchange_rate FROM customer_invoices ci`;',
      'const q = sql`SELECT ci.exchange_rate\n  * total_amount FROM customer_invoices ci`;',
      'const q = sql`SELECT total_amount * COALESCE(ci.exchange_rate, 1) FROM customer_invoices ci`;',
      'const q = sql`SELECT total_amount * (exchange_rate) FROM customer_invoices`;',
      'const q = sql`SELECT COALESCE(exchange_rate, 1) * total_amount FROM customer_invoices`;',
      'const q = sql`SELECT ROUND(total * er.rate, 2) FROM exchange_rates er`;',
      'const q = sql`SELECT total / exchange_rates.rate FROM exchange_rates`;',
      "const q = 'SELECT total_amount * NULLIF(ci.exchange_rate, 0)';",
    ]) expect(conversionSites('t.ts', code), code).toHaveLength(1);
  });

  it('the allowlist is a COUNT: one more site in a listed file fails (self-test)', () => {
    const allowed = { 'a.ts': { sites: 1, why: 'tax rate' } };
    expect(unexplainedSites(new Map([['a.ts', ['a.ts: x * rate']]]), allowed)).toEqual([]);
    expect(unexplainedSites(new Map([['a.ts', ['a.ts: x * rate', 'a.ts: y * er']]]), allowed)).toHaveLength(2);
    expect(unexplainedSites(new Map([['b.ts', ['b.ts: y * er']]]), allowed)).toEqual(['b.ts: y * er']);
  });

  it('does not flag what is not a conversion (self-test)', () => {
    for (const code of [
      'const t = subtotal * (taxRate / 100);',
      'const x = { exchangeRate: Number(row.exchange_rate ?? 1) };',
      'const t = hours * hourlyRate;',
      "const q = sql`SELECT public.fx_functional(total_amount, exchange_rate)`;",
      "const q = sql`SELECT count(*)::INT AS n, exchange_rate FROM customer_invoices`;",
    ]) expect(conversionSites('t.ts', code), code).toEqual([]);
  });
});
