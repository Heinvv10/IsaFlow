/**
 * R-175: two call sites must not share a rate-limit key while disagreeing
 * about its limit.
 *
 * One key is one row with one window. pages/api/portal/auth.ts (5 per 15 min)
 * and pages/api/accounting/portal/auth.ts (5 per 60 s) both used
 * `portal-auth:${ip}`: the 60-second caller kept resetting the row, so the
 * password login allowed about 60 guesses per 15 minutes instead of 5.
 *
 * Scope: every tracked .ts/.tsx/.js/.mjs file outside tests/ (`git ls-files`,
 * so a new file counts once it is tracked). The app's runtime code is all in
 * pages/ and src/; scanning the rest as well means a script or config file
 * that starts calling the limiter is seen too.
 *
 * Every call is resolved to the key PATTERN it produces (`${...}` becomes `*`),
 * including the keys the wrappers build, so a hand-written
 * `report:reports-pdf:co:${id}` is compared with checkReportRateLimit(id,
 * 'reports-pdf'). It fails closed: a call it cannot read must be pinned below
 * by file and by the text of its key, with a reason.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTO, NAMES, OWN, census, collisions, limit, overlaps } from './rateLimitKeyCensus.helpers';

const ROOT = path.resolve(__dirname, '../../..');

/** Calls whose key or options are not literals at the call site: `file | key text` -> why it is safe. */
const PINNED: Record<string, string> = {
  'src/modules/accounting/services/share/shareResolver.ts | ipKey': 'share:ip: key built just above; options are file constants used nowhere else',
  'src/modules/accounting/services/share/shareResolver.ts | tokenKey': 'share:token: key built just above; options are file constants used nowhere else',
  "pages/api/accounting/annotations/index.ts | annotationRateLimitKey('list', user.id)": 'per-action, per-user name; default options',
  "pages/api/accounting/annotations/index.ts | annotationRateLimitKey('create', user.id)": 'per-action, per-user name; default options',
  "pages/api/accounting/annotations/[id]/resolve.ts | annotationRateLimitKey('resolve', user.id)": 'per-action, per-user name; default options',
  'src/lib/rateLimitQuota.ts | key': 'refunds a key this request charged, taken from the request context',
  'scripts/generate-closeout-report.mjs | ?': 'prose in a description string, not a call',
};

/**
 * Pairs of patterns where one, read as a glob, could produce the other's keys,
 * and why it cannot in fact. `A <> B` -> reason. Filled in below.
 */
const SAFE_OVERLAPS: Record<string, string> = {
  'portal-chat:* <> portal-chat:co:*:day': 'the first is keyed by an IP address, which is never `co:<uuid>:day`',
};

function trackedSources(): Record<string, string> {
  const listed = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const files: Record<string, string> = {};
  for (const file of listed.split('\n')) {
    if (!/\.(tsx?|m?js)$/.test(file) || file.startsWith('tests/') || OWN.slice(0, 2).includes(file)) continue;
    const text = readFileSync(path.join(ROOT, file), 'utf8');
    if (new RegExp(NAMES).test(text)) files[file] = text;
  }
  return files;
}

describe('rate-limit key census (R-175)', () => {
  const found = census(trackedSources());

  it('finds the call sites, including the keys the wrappers build', () => {
    expect(found.charges.length).toBeGreaterThan(100);
    expect(found.charges.map((s) => s.pattern)).toEqual(expect.arrayContaining([
      'portal-auth:*', 'afs-portal-magic-link:*', 'login:ip:*', 'login:email:*', 'invite-accept:*',
      'ai:nl-query:co:*:day', 'send:invoice-email:ip:*', 'report:reports-pdf:co:*', 'statement-bulk-email:attempts:*',
    ]));
  });

  it('no key pattern is held to two different limits', () => {
    expect(collisions(found.charges)).toEqual([]);
  });

  it('no pattern can produce another pattern\'s keys at a different limit, except the reasoned pairs', () => {
    expect(overlaps(found.charges)).toEqual(Object.keys(SAFE_OVERLAPS).sort());
  });

  it('the wrapper-applied buckets are read from their one table', () => {
    expect(found.charges.filter((s) => s.where === `${AUTO} (table)`)).toEqual([
      { where: `${AUTO} (table)`, pattern: 'reports:*', options: limit(60, 60) },
    ]);
  });

  it('every refund is on a key that some call site charges', () => {
    const charged = new Set(found.charges.map((s) => s.pattern));
    expect(found.refunds.map((s) => s.pattern)).toEqual(['invite-accept:*']);
    expect(found.refunds.filter((s) => !charged.has(s.pattern))).toEqual([]);
  });

  it('every call it cannot read is pinned, and every pin still matches a call', () => {
    expect([...new Set(found.unreadable)].sort()).toEqual(Object.keys(PINNED).sort());
  });

  it('no file reaches the limiter under another name', () => {
    expect(found.aliased).toEqual([]);
  });

  it('the detector goes red on what it was written for', () => {
    const synthetic = census({
      'a.ts': "await checkRateLimit(`portal-auth:${ip}`, { max: 5, windowSecs: 15 * 60 });",
      'b.ts': "const allowed = await checkRateLimit(`portal-auth:${ip}`, { max: 5, windowSecs: 60 });",
      'c.ts': "export default withRateLimit(withUserAuth(withCsrf(handler)), { max: 10, windowSecs: 900 }, 'x');\n"
        + "const W = 900;\nawait checkRateLimit(`x:ip:${getClientIp(req)}`, {\n  max: 10, // per IP\n  windowSecs: W,\n});",
      'd.ts': "await checkAiRateLimit(req, companyId, 'n', { dailyMax: 300, refundUnused: true });\nawait checkAiRateLimit(req, companyId, 'n', { dailyMax: 100 });",
      'e.ts': 'await checkRateLimit(key, { max: 1, windowSecs: 1 });\nawait checkRateLimit(`k:${a}`, opts);\nawait checkRateLimit(`${a}:${b}`, { max: 1, windowSecs: 1 });',
      // A hand-written key that lands on a wrapper's key, at another limit.
      'f.ts': "await checkReportRateLimit(companyId, 'reports-pdf');\nawait checkRateLimit(`report:reports-pdf:co:${companyId}`, { max: 500, windowSecs: 900 });",
      'g.ts': "import { checkRateLimit as rl } from '@/lib/rateLimit';\nimport * as limiter from '@/lib/rateLimit';\nconst check = checkRateLimit;\nconst m = await import('@/lib/rateLimit');",
      // Passed as a value, in an object, bound: none of these is a direct call.
      'i.ts': "import { checkRateLimit, withRateLimit } from '@/lib/rateLimit';\nconst deps = { check: checkRateLimit };\nrun(checkRateLimit);\nconst b = checkRateLimit.bind(null);\n// checkRateLimit in a comment is fine\nawait checkRateLimit(`ok:${id}`, { max: 1, windowSecs: 1 });",
      'j.ts': "await checkRateLimit(`foo:${ip}`, { max: 5, windowSecs: 60 });\nawait checkRateLimit(`foo:bar:${id}`, { max: 9, windowSecs: 60 });\nawait checkRateLimit(`baz:${id}`, { max: 9, windowSecs: 60 });\nawait checkRateLimit(`baz:qux:${id}`, { max: 9, windowSecs: 60 });",
      'h.ts': 'await refundRateLimit(`never-charged:${id}`, 1);',
    });

    expect(collisions(synthetic.charges)).toEqual([
      'portal-auth:* -> a.ts:1 {max=5;windowSecs=900} vs b.ts:1 {max=5;windowSecs=60}',
      'ai:n:co:*:day -> d.ts:1 {max=300;windowSecs=86400} vs d.ts:2 {max=100;windowSecs=86400}',
      'report:reports-pdf:co:* -> f.ts:1 {max=25;windowSecs=900} vs f.ts:2 {max=500;windowSecs=900}',
    ]);
    expect(synthetic.charges.filter((s) => s.pattern === 'x:ip:*').map((s) => s.options)).toEqual([limit(10, 900), limit(10, 900)]);
    expect(synthetic.unreadable).toEqual(['e.ts | key', 'e.ts | `k:${a}`', 'e.ts | `${a}:${b}`']);
    expect(synthetic.aliased).toEqual([
      "g.ts | import * as limiter from '@/lib/rateLimit'",
      "g.ts | import('@/lib/rateLimit')",
      "g.ts | checkRateLimit as rl } from '@/lib/rat",
      'g.ts | checkRateLimit;',
      'i.ts | checkRateLimit };',
      'i.ts | checkRateLimit);',
      'i.ts | checkRateLimit.bind(null);',
    ]);
    // `foo:*` can produce `foo:bar:...` at another limit; the baz pair share a limit.
    expect(overlaps(synthetic.charges)).toEqual(['foo:* <> foo:bar:*']);
    expect(synthetic.refunds.map((s) => s.pattern)).toEqual(['never-charged:*']);
  });
});
