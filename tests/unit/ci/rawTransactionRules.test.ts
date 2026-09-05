/**
 * The raw-transaction-control rule.
 *
 * Every evasion form here is one a blind review found slipping past the first
 * version of this gate, which was a line-anchored grep. They are the point of
 * the file: a gate that only catches the spelling the last offender used is
 * theatre, and the multi-line template it missed is how every converted block
 * in this codebase is actually written.
 */
import { describe, it, expect } from 'vitest';
import { findRawTransactionControl, stripComments } from '../../../scripts/ci/rawTransactionRules';

const found = (src: string) => findRawTransactionControl(src).map((v) => v.text);

describe('findRawTransactionControl — the forms that must be caught', () => {
  it('catches the single-line tagged template', () => {
    expect(found('await sql`BEGIN`;')).toHaveLength(1);
    expect(found('await sql`COMMIT`;')).toHaveLength(1);
    expect(found('await sql`ROLLBACK`;')).toHaveLength(1);
  });

  it('catches the MULTI-LINE template — the form the grep version missed', () => {
    // Every converted block in this repo is written multi-line, so this is the
    // spelling a developer would most naturally reach for.
    expect(found('await sql`\n  BEGIN\n`;')).toHaveLength(1);
    expect(found('await sql`\n      COMMIT\n    `;')).toHaveLength(1);
  });

  it('catches sql.query and sql.unsafe — the same function under two names', () => {
    // createSql does `fn.query = fn.unsafe`, and both build the same LazyQuery.
    expect(found("await sql.query('COMMIT');")).toHaveLength(1);
    expect(found("await sql.unsafe('ROLLBACK');")).toHaveLength(1);
    expect(found('await sql.query("BEGIN");')).toHaveLength(1);
  });

  it('catches a tx alias — on the savepoint branch tx writes to the shared client', () => {
    expect(found('await tx`COMMIT`;')).toHaveLength(1);
    expect(found("await tx.query('ROLLBACK');")).toHaveLength(1);
  });

  it('catches a deferred statement that is not awaited on the spot', () => {
    expect(found('const p = sql`BEGIN`;')).toHaveLength(1);
    expect(found('void sql`ROLLBACK`;')).toHaveLength(1);
  });

  it('catches savepoint control, which has the same ownership problem', () => {
    expect(found('await sql`SAVEPOINT foo`;')).toHaveLength(1);
    expect(found('await sql`RELEASE SAVEPOINT foo`;')).toHaveLength(1);
    expect(found('await sql`START TRANSACTION`;')).toHaveLength(1);
  });

  it('is case-insensitive and tolerates a trailing semicolon in the body', () => {
    expect(found('await sql`begin`;')).toHaveLength(1);
    expect(found('await sql`COMMIT;`;')).toHaveLength(1);
  });

  it('reports the line number of each violation', () => {
    const v = findRawTransactionControl('const a = 1;\nconst b = 2;\nawait sql`BEGIN`;');
    expect(v).toHaveLength(1);
    expect(v[0]!.line).toBe(3);
  });
});

describe('findRawTransactionControl — what must NOT be flagged', () => {
  it('ignores a real query that merely contains the word', () => {
    // The body must be ONLY the keyword. A column named begin_date, or a WHERE
    // clause mentioning it, is not transaction control.
    expect(found('await sql`SELECT * FROM t WHERE begin_date > ${d}`;')).toEqual([]);
    expect(found('await sql`SELECT commit_hash FROM releases`;')).toEqual([]);
    expect(found('await sql`UPDATE t SET rollback_count = 1`;')).toEqual([]);
  });

  it('does NOT flag client.query on a pool client you own — that is the REMEDY', () => {
    // withTransaction, withAuth and bearerPipeline all open their real
    // transactions this way. An earlier draft of this rule flagged all 35 of
    // those call sites, condemning the fix along with the defect.
    expect(found("await client.query('BEGIN');")).toEqual([]);
    expect(found("await client.query('COMMIT');")).toEqual([]);
    expect(found("await client.query('BEGIN READ ONLY');")).toEqual([]);
  });

  it('ignores an empty template', () => {
    expect(found('await sql``;')).toEqual([]);
  });

  it('ignores a commented-out offender, in both comment styles', () => {
    // Commenting one out is how you REMOVE it; failing the build on that would
    // teach people to delete the evidence instead.
    expect(found('// await sql`BEGIN`;')).toEqual([]);
    expect(found('/* await sql`BEGIN`; */')).toEqual([]);
    expect(found('/**\n * await sql`COMMIT`;\n */')).toEqual([]);
  });

  it('keeps line numbers correct after stripping a multi-line comment', () => {
    const src = '/*\n line\n line\n*/\nawait sql`BEGIN`;';
    expect(stripComments(src).split('\n')).toHaveLength(5);
    expect(findRawTransactionControl(src)[0]!.line).toBe(5);
  });
});
