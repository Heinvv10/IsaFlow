/**
 * R-176 census — nothing sends a bare ROLLBACK.
 *
 * The release census (releaseCensus.test.ts) sees only `.release(`, so a transaction owner on a
 * dedicated pg.Client, which ends its client instead of releasing it, was invisible to it. Such
 * an owner cannot pool a dirty connection, but a bare ROLLBACK there still waits without bound,
 * sends no cancel, and when it fails it throws over the error that caused it. So every
 * `.query('ROLLBACK')` in src/, pages/, scripts/, middleware.ts and instrumentation.ts must be
 * the one inside rollbackFailed.ts, or be pinned below with the reason.
 *
 * Reads the tracked tree (git ls-files) and fails closed: a new bare ROLLBACK, an extra one in a
 * pinned file, or a pinned one that is gone, all turn this red.
 *
 * Every spelling that ends a transaction counts: ROLLBACK, ABORT, either with WORK or
 * TRANSACTION, and AND [NO] CHAIN, in any case. `ROLLBACK TO SAVEPOINT` does not end the
 * transaction and is not counted. A `{ text }` query config is read through its `text`; a
 * template is read by its leading words. In a file that owns a transaction (it sends BEGIN or
 * START TRANSACTION), a first argument whose text cannot be read (a variable, a call, a template
 * that starts with a substitution, a config without `text`) fails closed too: it must be pinned.
 *
 * Limits: text that reaches `.query(` through another module (the `sql` tag in src/lib/neon/, the
 * tag in scripts/_pg.ts) is not seen here; those modules are pinned as passing their callers' text on.
 * Also not seen: a literal with a leading comment or another statement before the ROLLBACK
 * ('-- why\nROLLBACK', 'SELECT 1; ROLLBACK'); a call through element access
 * (client['query']('ROLLBACK')); and unreadable text in a file whose own BEGIN is itself
 * unreadable or absent, which is therefore not seen as owning a transaction. Two such files exist,
 * both from the R-184 split of src/lib/neon.ts (which owned a transaction and was counted whole):
 * src/lib/neon/sql.ts (`sql.transaction` builds its BEGIN from clauses) and src/lib/neon/query.ts
 * (`LazyQuery.run` sends its caller's text on whichever client the transaction is on). Both are
 * named in COUNTED_ANYWAY so their queries are still counted.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import ts from 'typescript';

const HELPER_FILE = 'src/lib/rollbackFailed.ts';
const IN_A_HELPER = 'a migration tool whose ROLLBACK sits in a helper and whose release is in main, on a pool ended with the run (R-176 fix.md)';
const PASSES_TEXT_ON = "a query client that sends its caller's text: what the caller sends is the caller's to answer for";
const RUNS_SQL_FILE = 'runs the SQL text of a file it was given (a migration, a backfill)';
/** file -> bare ROLLBACKs, unreadable first arguments, and why each is allowed. */
const PINNED: Record<string, { rollbacks: number; unreadable: number; reason: string }> = {
  [HELPER_FILE]: { rollbacks: 1, unreadable: 0, reason: 'the one ROLLBACK every owner goes through: bounded, logged, cancels the backend' },
  'scripts/ap-backfill-supplier-payments.ts': {
    rollbacks: 2, unreadable: 1,
    reason: 'two ROLLBACK paths (dry run and catch) whose results the release census cannot tell apart, in a script no test can drive, so a conversion could not be proved; '
      + RUNS_SQL_FILE + ' (R-176 fix.md)',
  },
  'scripts/lib/migrationFiles.ts': {
    rollbacks: 1, unreadable: 1,
    reason: `${IN_A_HELPER} (apply-migrations: pool ended with the run; check-migration-parity: a dedicated Client ended in its finally, which also releases the session; migrations themselves are bounded by APPLY_STATEMENT_TIMEOUT_MS (15 min), the ROLLBACK itself is not separately bounded); ${RUNS_SQL_FILE}`,
  },
  'scripts/migrations/resolve-checksum-conflicts.ts': { rollbacks: 1, unreadable: 1, reason: `${IN_A_HELPER}; ${RUNS_SQL_FILE}` },
  'scripts/_pg.ts': { rollbacks: 0, unreadable: 3, reason: PASSES_TEXT_ON },
  'src/lib/neon/query.ts': { rollbacks: 0, unreadable: 3, reason: PASSES_TEXT_ON },
  'src/lib/neon/sql.ts': { rollbacks: 0, unreadable: 3, reason: PASSES_TEXT_ON },
  'src/lib/neon/transaction.ts': { rollbacks: 0, unreadable: 2, reason: PASSES_TEXT_ON },
};
/** Files counted as transaction owners although no readable BEGIN is in them (R-184). */
const COUNTED_ANYWAY = new Set(['src/lib/neon/query.ts', 'src/lib/neon/sql.ts']);

const sources = execFileSync('git', ['ls-files', 'src', 'pages', 'scripts', 'middleware.ts', 'instrumentation.ts'],
  { encoding: 'utf8' }).trim().split('\n').filter((f) => /\.(tsx?|mjs|cjs|js)$/.test(f));

/** The whole statement ends the transaction. */
const ENDS_TX = /^\s*(?:ROLLBACK|ABORT)(?:\s+(?:WORK|TRANSACTION))?(?:\s+AND\s+(?:NO\s+)?CHAIN)?\s*;?\s*$/i;
/** A template's leading words that may end the transaction (anything but ... TO SAVEPOINT). */
const MAY_END_TX = /^\s*(?:ROLLBACK|ABORT)\b(?!(?:\s+(?:WORK|TRANSACTION))?\s+TO\b)/i;
const OPENS_TX = /^\s*(?:BEGIN|START\s+TRANSACTION)\b/i;

type Kind = 'rollback' | 'begin' | 'unreadable' | null;
function classify(a: ts.Expression | undefined): Kind {
  if (a === undefined) return null;
  if (ts.isParenthesizedExpression(a)) return classify(a.expression);
  if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) {
    return ENDS_TX.test(a.text) ? 'rollback' : OPENS_TX.test(a.text) ? 'begin' : null;
  }
  if (ts.isTemplateExpression(a)) {
    if (!/\S/.test(a.head.text)) return 'unreadable';
    return MAY_END_TX.test(a.head.text) ? 'rollback' : OPENS_TX.test(a.head.text) ? 'begin' : null;
  }
  if (ts.isObjectLiteralExpression(a)) {
    const text = a.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText().replace(/['"]/g, '') === 'text');
    return text && ts.isPropertyAssignment(text) ? classify(text.initializer) : 'unreadable';
  }
  return 'unreadable';
}

function census(text: string, ownsTxAnyway = false): { rollbacks: number; unreadable: number } {
  const kinds: Kind[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'query') kinds.push(classify(node.arguments[0]));
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile('s.ts', text, ts.ScriptTarget.Latest, true));
  const ownsTx = ownsTxAnyway || kinds.includes('begin');
  return { rollbacks: kinds.filter((k) => k === 'rollback').length, unreadable: ownsTx ? kinds.filter((k) => k === 'unreadable').length : 0 };
}

describe('R-176: no bare ROLLBACK', () => {
  it('the tracked tree was read', () => {
    expect(sources.length).toBeGreaterThan(500);
    expect(sources).toEqual(expect.arrayContaining([HELPER_FILE, 'scripts/fixes/backfill-je-fiscal-periods.ts']));
  });

  it.each(["await c.query('ROLLBACK');", 'await c.query("rollback");', 'await c.query(`ROLLBACK`);', "c.query('ROLLBACK;')",
    "await client.query(' ROLLBACK ').catch(() => undefined);", "(async () => client.query('ROLLBACK'))()",
    "c.query('ABORT')", "c.query('abort;')", "c.query('ABORT WORK')", "c.query('ROLLBACK WORK')", "c.query('rollback transaction')",
    "c.query('ROLLBACK AND CHAIN')", "c.query('ROLLBACK AND NO CHAIN')", "c.query('ROLLBACK TRANSACTION AND NO CHAIN;')",
    "c.query({ text: 'ROLLBACK' })", "c.query({ 'text': 'abort' })", 'c.query(`ROLLBACK ${suffix}`)'])(
    'counts %s', (snippet) => { expect(census(snippet).rollbacks).toBe(1); });

  it.each(["await c.query('ROLLBACK TO SAVEPOINT sp1');", "c.query('ROLLBACK TRANSACTION TO SAVEPOINT x')",
    'c.query(`ROLLBACK TO SAVEPOINT ${sp}`)', "await c.query('SELECT 1');", "await rollbackFailed(c, 'x');",
    "log.info('ROLLBACK');", "await c.query('COMMIT');", "c.query({ text: 'SELECT 1' })", 'c.query(`SAVEPOINT ${sp}`)',
    "c.query('ROLLBACK PREPARED x')"])(
    'does not count %s', (snippet) => { expect(census(snippet).rollbacks).toBe(0); });

  it.each(["await c.query('BEGIN'); await c.query(sqlText);", "c.query('BEGIN'); c.query({ values: [] });",
    "c.query('BEGIN'); c.query(`${verb} x`);", "c.query('START TRANSACTION'); c.query(build());",
    "c.query({ text: 'BEGIN' }); c.query(statement);"])(
    'in a file that owns a transaction, an unreadable first argument fails closed: %s', (snippet) => {
      expect(census(snippet).unreadable).toBe(1);
    });

  it.each(['c.query(sqlText);', "c.query(`SELECT ${x}`); c.query('SELECT 1');"])(
    'outside one, it is not counted: %s', (snippet) => { expect(census(snippet).unreadable).toBe(0); });

  it('every bare ROLLBACK and unreadable query is a pinned one', () => {
    const found: Record<string, { rollbacks: number; unreadable: number }> = {};
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      if (!/rollback|abort|begin|start transaction/i.test(text)) continue;
      const c = census(text, COUNTED_ANYWAY.has(file));
      if (c.rollbacks + c.unreadable > 0) found[file] = c;
    }
    expect(found, 'roll back with rollbackFailed(client, source), or pin the file in PINNED with the reason')
      .toEqual(Object.fromEntries(Object.entries(PINNED).map(([file, e]) => [file, { rollbacks: e.rollbacks, unreadable: e.unreadable }])));
    for (const e of Object.values(PINNED)) expect(e.reason.length).toBeGreaterThan(20);
  });
});
