/**
 * Admin audit 2026-11-14 section 6 (WP14b): admin API status codes, by census over pages/api/admin/** (git ls-files).
 *
 * A request transaction COMMITS on any answer below 500 (withPlatformAdmin), so:
 *   1. a catch block that answers a 4xx must END by rethrowing the error it caught (`throw <err>` as its last
 *      statement, review #1405 L7): only the refusals it recognised above that line may be a 4xx, everything else
 *      must reach withErrorHandler's 500 and roll back. Pinned files below are the only exceptions, with reasons.
 *   2. a route with a dynamic id segment validates it before any SQL (adminUuid / isUuidParam / UUID.safeParse;
 *      adminUserId for users' TEXT ids): a malformed id is a 400, not a 500 from a Postgres cast.
 *   3. no route turns page / limit / offset into a number by hand (Number(page) / parseInt(page) is NaN for "abc",
 *      which reached SQL): adminPaging / adminPositiveInt / adminNonNegativeInt answer 400 for garbage.
 *   4. an admin validator (adminUuid, adminPaging, ...) is never called inside a try whose catch does not end by
 *      rethrowing: such a catch turned the validator's 400 into a 500 (breaker #1405 B2).
 *   5. no body field named like an id (`*_id`, `*Id`, `*_ids`) is a bare z.string(): a malformed id reached a uuid
 *      cast or foreign key as a 500 (review #1405 M2). UUID ids use UUID from @/lib/schemas/common.
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
      // res.status(4xx), and res.status(<variable>): a computed status may be a 4xx (review #1405 round 2).
      const arg = n.arguments[0];
      if (name === 'status' && arg && (ts.isNumericLiteral(arg) ? /^4\d\d$/.test(arg.text) : true)) found = true;
    }
    if (!ts.isFunctionLike(n) || n === node) ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/**
 * The catch's last statement is `throw <its own variable>` and is reachable: no earlier statement of the block
 * returns or throws unconditionally (`return badRequest(...); throw err;` is a dead throw, review #1405 round 2).
 * Whatever the catch did not answer above that line propagates.
 */
function endsByRethrowing(clause: ts.CatchClause): boolean {
  const name = clause.variableDeclaration?.name.getText();
  const statements = clause.block.statements;
  const last = statements[statements.length - 1];
  const exitsEarly = statements.slice(0, -1).some((st) => ts.isReturnStatement(st) || ts.isThrowStatement(st));
  return !!name && !!last && ts.isThrowStatement(last) && last.expression?.getText() === name && !exitsEarly;
}

/** Calls of the adminRequestErrors validators (adminUuid, adminPaging, adminOptionalDate, ...) inside `node`. */
function callsAdminValidator(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && ADMIN_VALIDATORS.has(n.expression.text)) found = true;
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

const ADMIN_VALIDATORS = new Set(
  [...readFileSync('src/modules/admin/middleware/adminRequestErrors.ts', 'utf8').matchAll(/export function (admin[A-Z]\w*)/g)]
    .map((m) => m[1]!),
);

function triesSwallowingAValidator(file: string): number {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  let n = 0;
  const visit = (node: ts.Node) => {
    if (ts.isTryStatement(node) && node.catchClause && !endsByRethrowing(node.catchClause)
      && callsAdminValidator(node.tryBlock)) n += 1;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return n;
}

function catchesAnswering4xxWithoutRethrow(file: string): number {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  let n = 0;
  const visit = (node: ts.Node) => {
    if (ts.isCatchClause(node) && answers4xx(node.block) && !endsByRethrowing(node)) n += 1;
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

  it('4. no admin validator runs inside a try whose catch swallows its 400', () => {
    expect(ADMIN_VALIDATORS.size).toBeGreaterThan(5);
    const found = Object.fromEntries(files.map((f) => [f, triesSwallowingAValidator(f)]).filter(([, n]) => n !== 0));
    expect(found).toEqual({});
  });

  it('5. no id-named body field is a bare z.string()', () => {
    const ID_AS_STRING = /\b\w*(?:_id|Id|_ids|Ids)\s*:\s*z\s*\.\s*(?:string\(|array\(\s*z\s*\.\s*string\()/;
    expect(files.filter((f) => ID_AS_STRING.test(readFileSync(f, 'utf8')))).toEqual([]);
  });
});
