/**
 * Admin audit 2026-11-14 section 6 (WP14b): admin API status codes, by census over pages/api/admin/** (git ls-files).
 *
 * A request transaction COMMITS on any answer below 500 (withPlatformAdmin), so:
 *   1. a catch block that answers a 4xx must also rethrow the error it caught (`throw <err>`): only known refusals
 *      may be a 4xx, everything else must reach withErrorHandler's 500 and roll back. Pinned files below are the
 *      only exceptions, each with its reason.
 *   2. a route with a dynamic id segment validates it before any SQL (adminUuid / isUuidParam / UUID.safeParse;
 *      adminUserId for users' TEXT ids): a malformed id is a 400, not a 500 from a Postgres cast.
 *   3. no route turns page / limit / offset into a number by hand (Number(page) / parseInt(page) is NaN for "abc",
 *      which reached SQL): adminPaging / adminPositiveInt / adminNonNegativeInt answer 400 for garbage.
 * Limits: a catch is judged by its own text (a helper that answers 4xx for it is not seen); rule 2 sees that a
 * validator is called in the file, not that it runs before the first query. The routes' behaviour is pinned by
 * tests/integration/admin-route-statuses.int.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import ts from 'typescript';

const PINNED_CATCH: Record<string, { catches: number; reason: string }> = {
  'pages/api/admin/migration/sage-pull-server.ts': {
    catches: 1,
    reason: 'an outbound proxy to Sage with no database write: every error is the Sage call failing, answered with its message',
  },
};

/** Dynamic segments that are not UUIDs (a 4-digit SARS source code). */
const NON_UUID_SEGMENTS = new Set(['[code]']);

const files = execFileSync('git', ['ls-files', 'pages/api/admin'], { encoding: 'utf8' })
  .split('\n').filter((f) => f.endsWith('.ts'));

const FOUR_XX_HELPERS = new Set(['badRequest', 'badRequestFromError', 'notFound', 'conflict', 'forbidden',
  'validationError', 'zodValidationError', 'error']);

function answers4xx(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const target = n.expression.expression.getText();
      const name = n.expression.name.text;
      if (target === 'apiResponse' && FOUR_XX_HELPERS.has(name)) {
        // apiResponse.error(res, ErrorCode.X, ...): a 4xx unless the code is a server one.
        const codeArg = name === 'error' ? n.arguments[1]?.getText() ?? '' : '';
        if (name !== 'error' || !/SERVICE_UNAVAILABLE|INTERNAL_ERROR|DATABASE_ERROR|GATEWAY_TIMEOUT/.test(codeArg)) found = true;
      }
      if (name === 'status' && n.arguments[0] && ts.isNumericLiteral(n.arguments[0]) && /^4\d\d$/.test(n.arguments[0].text)) found = true;
    }
    if (!ts.isFunctionLike(n) || n === node) ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function rethrows(clause: ts.CatchClause): boolean {
  const name = clause.variableDeclaration?.name.getText();
  if (!name) return false;
  let found = false;
  const visit = (n: ts.Node) => {
    if (ts.isThrowStatement(n) && n.expression?.getText() === name) found = true;
    if (!ts.isFunctionLike(n)) ts.forEachChild(n, visit);
  };
  visit(clause.block);
  return found;
}

function catchesAnswering4xxWithoutRethrow(file: string): number {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  let n = 0;
  const visit = (node: ts.Node) => {
    if (ts.isCatchClause(node) && answers4xx(node.block) && !rethrows(node)) n += 1;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return n;
}

describe('admin route status census (audit section 6)', () => {
  it('reads the admin routes', () => {
    expect(files.length).toBeGreaterThan(60);
  });

  it('1. a catch that answers 4xx rethrows what it does not recognise (only pinned files differ)', () => {
    const found: Record<string, number> = {};
    for (const f of files) {
      const n = catchesAnswering4xxWithoutRethrow(f);
      if (n > 0) found[f] = n;
    }
    const expected = Object.fromEntries(Object.entries(PINNED_CATCH).map(([f, p]) => [f, p.catches]));
    expect(found).toEqual(expected);
  });

  it('2. every dynamic UUID segment is validated before SQL', () => {
    const unvalidated = files.filter((f) => {
      const segments = f.match(/\[[^\]]+\]/g) ?? [];
      if (segments.length === 0 || segments.every((s) => NON_UUID_SEGMENTS.has(s))) return false;
      return !/\badminUuid\(|\badminUserId\(|\bisUuidParam\(|\bUUID\.safeParse\(/.test(readFileSync(f, 'utf8'));
    });
    expect(unvalidated).toEqual([]);
  });

  it('3. no route parses page / limit / offset with a bare Number() or parseInt()', () => {
    const raw = files.filter((f) => /\b(?:Number|parseInt)\(\s*\(?\s*(?:page|limit|offset)\w*/.test(readFileSync(f, 'utf8')));
    expect(raw).toEqual([]);
  });
});
