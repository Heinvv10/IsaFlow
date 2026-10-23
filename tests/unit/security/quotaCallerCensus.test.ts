/**
 * R-175: a usage-quota caller may ask for `refundUnused` only if its bounded
 * work is recorded somewhere it can reach.
 *
 * The rule is `charged - used` given back at the end of every request. A route
 * that asks for `refundUnused` but whose work never calls
 * `markQuotaUsed(<kind>)` would get its unit back every time, and its daily
 * quota would be dead. So:
 *
 *  - every caller of checkAiRateLimit / checkSendRateLimit is listed here,
 *    either as refundable or as keeping its charge, with the reason;
 *  - a caller in neither list fails the test (a new caller must be classified);
 *  - a refundable caller must reach, through its static imports, a file that
 *    calls markQuotaUsed for its kind;
 *  - a caller that keeps its charge must not pass `refundUnused`.
 *
 *  - a refundable caller must not reach code that leaves the request context
 *    (`als.exit`): use recorded there is invisible to the settle, so the route
 *    would be refunded for work it did. `runAfterCommit` is allowed, because
 *    it forfeits the refund at run time (`forfeitQuotaRefund`).
 *
 * This is reachability, read from source: it proves a path exists, not that
 * every success path takes it. The behaviour is tested where the use is
 * recorded (quotaUseChokepoints, aiRoutesQuotaUse, nlQueryQuotaRefund).
 * It reads `git ls-files`, so a new route counts once it is tracked.
 *
 * What it cannot see: a promise that is started and not awaited (it keeps the
 * request context but may record its use after the settle), work scheduled
 * with a bare timer, and an import it cannot resolve (a computed path, or a
 * package outside this repository).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');
const API = 'pages/api/';

/** Routes whose unused daily unit comes back, and where their work records its use. */
const REFUNDABLE: Record<string, { kind: 'ai' | 'send'; marksIn: string }> = {
  'accounting/nl-query.ts': { kind: 'ai', marksIn: 'pages/api/accounting/nl-query.ts' },
  'accounting/ai-narrative.ts': { kind: 'ai', marksIn: 'pages/api/accounting/ai-narrative.ts' },
  'accounting/ai-forecast.ts': { kind: 'ai', marksIn: 'pages/api/accounting/ai-forecast.ts' },
  'onboarding/extract.ts': { kind: 'ai', marksIn: 'src/modules/accounting/services/bank/vlmCore.ts' },
  'onboarding/extract-id.ts': { kind: 'ai', marksIn: 'src/modules/accounting/services/bank/vlmCore.ts' },
  'accounting/afs/[documentId]/sections/[sectionId]/ai-narrative.ts': { kind: 'ai', marksIn: 'src/modules/accounting/services/afs/noteAiService.ts' },
  'accounting/invoice-email.ts': { kind: 'send', marksIn: 'src/modules/accounting/services/core/emailService.ts' },
  'accounting/statement-bulk-email.ts': { kind: 'send', marksIn: 'src/modules/accounting/services/core/emailService.ts' },
  'accounting/customer-statements-send.ts': { kind: 'send', marksIn: 'src/modules/accounting/services/core/emailService.ts' },
  'accounting/company-invitations.ts': { kind: 'send', marksIn: 'src/modules/accounting/services/core/emailService.ts' },
  'accounting/ar/dunning/send.ts': { kind: 'send', marksIn: 'src/modules/accounting/services/core/emailService.ts' },
  'accounting/afs/[documentId]/send-for-signing.ts': { kind: 'send', marksIn: 'pages/api/accounting/afs/[documentId]/send-for-signing.ts' },
};

/** Routes that keep their charge whatever happens, and why a refund cannot be proven. */
const KEEPS_CHARGE: Record<string, string> = {
  'accounting/ai-invoice-pipeline.ts': 'calls no AI provider; the bucket bounds requests to a heavy pipeline',
  'accounting/multi-doc-match.ts': 'calls no AI provider; the bucket bounds requests',
  'accounting/verify-payslip.ts': 'calls no AI provider; the bucket bounds requests',
  'accounting/document-validation.ts': 'calls no AI provider; the bucket bounds requests',
  'accounting/smart-categorize.ts': 'its LLM pass runs after COMMIT, outside the request, where use cannot be recorded',
  'accounting/vlm-extract.ts': 'its read runs after COMMIT (runAfterCommit), outside the request, where use cannot be recorded',
  'accounting/document-capture.ts': 'its read runs after COMMIT (runAfterCommit), outside the request, where use cannot be recorded',
  'accounting/document-capture-action.ts': "its 'retry' read runs after COMMIT (runAfterCommit), outside the request, where use cannot be recorded",
};

function tracked(dir: string): string[] {
  return execFileSync('git', ['ls-files', '--', dir], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((f) => /\.tsx?$/.test(f));
}

const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

function resolveImport(spec: string, from: string): string | null {
  const base = spec.startsWith('@/') ? `src/${spec.slice(2)}` : spec.startsWith('.') ? path.posix.join(path.posix.dirname(from), spec) : null;
  if (!base) return null;
  return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, base].find((c) => /\.tsx?$/.test(c) && existsSync(path.join(ROOT, c))) ?? null;
}

/** Every file reachable from `start` through value imports (type-only imports carry no code). */
function reachable(start: string): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = read(file).replace(/import\s+type\s[^;]*;/g, '');
    for (const m of source.matchAll(/(?:from\s+|import\(\s*)['"]([^'"]+)['"]/g)) {
      const next = resolveImport(m[1]!, file);
      if (next) stack.push(next);
    }
  }
  return seen;
}

/** Source with comments removed: a comment that mentions markQuotaUsed records nothing. */
const code = (file: string) => read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[ \t])\/\/.*$/gm, '');
/** Leaving the request context by hand. `runAfterCommit` is not here: it forfeits the refund itself. */
const leavesContext = (source: string) => /\bals\s*\.\s*exit\s*\(|\.exit\s*\(\s*(?:async\s*)?\(\)\s*=>|setImmediate\s*\(|process\.nextTick\s*\(/.test(source);
/** The one place that may: it is how runAfterCommit detaches work, after forfeiting the refund. */
const MAY_LEAVE_CONTEXT = ['src/lib/afterCommit.ts'];

/**
 * Registering work to run after the request (`runAfterCommit`) forfeits the
 * request's refund at run time (`forfeitQuotaRefund`): safe, but silent. So a
 * refundable route may reach such a file only if it is listed here with why
 * its refund is not lost.
 */
const registersAfterCommit = (source: string) => /\brunAfterCommit\s*\(\s*['"`\w]/.test(source);
const AFTER_COMMIT_ALLOWED: Record<string, string> = {
  'src/lib/afterCommit.ts': 'defines runAfterCommit',
  'src/modules/accounting/services/core/emailNotificationService.ts':
    'registers the invoice.sent webhook only after a successful send, when the unit is already used',
};

/** quotaUse.ts defines the marking functions (and its classifiers call markQuotaUsed); it records nothing by itself. */
const marks = (file: string, kind: string) => file !== 'src/lib/quotaUse.ts' && new RegExp(`markQuotaUsed\\('${kind}'`).test(code(file));

describe('usage-quota caller census (R-175)', () => {
  const callers = tracked('pages').concat(tracked('src'))
    .filter((f) => !f.startsWith('src/lib/rateLimit') && /\bcheck(Ai|Send)RateLimit\(/.test(read(f)));

  it('every quota caller is classified, and every classification still names a caller', () => {
    expect(callers.every((f) => f.startsWith(API))).toBe(true);
    expect(callers.map((f) => f.slice(API.length)).sort())
      .toEqual([...Object.keys(REFUNDABLE), ...Object.keys(KEEPS_CHARGE)].sort());
  });

  it.each(Object.entries(REFUNDABLE))('%s asks for refundUnused and can reach where its use is recorded', (route, { kind, marksIn }) => {
    const file = API + route;
    const fn = kind === 'ai' ? 'checkAiRateLimit' : 'checkSendRateLimit';
    const call = new RegExp(`${fn}\\([^;]*?refundUnused: true[^;]*?\\)`, 's');

    expect(call.test(read(file))).toBe(true);
    expect(marks(marksIn, kind)).toBe(true);
    const reached = reachable(file);
    expect(reached.has(marksIn)).toBe(true);
    // Fail closed: nothing it can reach may run its work outside the request.
    expect([...reached].filter((f) => !MAY_LEAVE_CONTEXT.includes(f) && leavesContext(code(f)))).toEqual([]);
    // Fail closed: no after-commit work it can reach, unless listed with a reason.
    expect([...reached].filter((f) => !(f in AFTER_COMMIT_ALLOWED) && registersAfterCommit(code(f)))).toEqual([]);
  });

  it('every after-commit exception still registers after-commit work and is reached by a refundable route', () => {
    const reachedByAny = new Set(Object.keys(REFUNDABLE).flatMap((r) => [...reachable(API + r)]));
    for (const file of Object.keys(AFTER_COMMIT_ALLOWED)) {
      expect({ file, registers: registersAfterCommit(code(file)), reached: reachedByAny.has(file) })
        .toEqual({ file, registers: true, reached: true });
    }
  });

  it('the after-commit check goes red on a registration and stays green without one', () => {
    expect(registersAfterCommit("runAfterCommit('send later', () => sendEmail(mail));")).toBe(true);
    expect(registersAfterCommit('await runAfterCommit (label, fn);')).toBe(true);
    expect(registersAfterCommit("'must be registered with runAfterCommit (@/lib/afterCommit)'")).toBe(false);
    expect(registersAfterCommit("import { runAfterCommit } from '@/lib/afterCommit';\nawait sendEmail(mail);")).toBe(false);
    expect(registersAfterCommit(code('src/modules/accounting/services/core/emailNotificationService.ts'))).toBe(true);
  });

  it.each(Object.entries(KEEPS_CHARGE))('%s keeps its charge: it does not ask for refundUnused', (route) => {
    expect(read(API + route)).not.toContain('refundUnused');
  });

  it('use is recorded only in the places listed above', () => {
    const marking = tracked('pages').concat(tracked('src'))
      .filter((f) => f !== 'src/lib/quotaUse.ts' && /markQuotaUsed\(/.test(code(f)));

    expect(marking.sort()).toEqual([...new Set(Object.values(REFUNDABLE).map((r) => r.marksIn))].sort());
  });

  it('a route that reaches no recording site would fail: the walk is not vacuous', () => {
    const reached = reachable(`${API}accounting/document-validation.ts`);

    expect(reached.size).toBeGreaterThan(5);
    expect([...reached].some((f) => marks(f, 'ai') || marks(f, 'send'))).toBe(false);
    expect(reachable(`${API}accounting/invoice-email.ts`).has('src/modules/accounting/services/core/emailService.ts')).toBe(true);
  });

  it('the context check goes red on exited-context code and stays green without it', () => {
    expect(leavesContext("await als.exit(() => sendEmail(mail));")).toBe(true);
    expect(leavesContext("const outside = als .exit (async () => { await callVlmChat(c, p, u); });")).toBe(true);
    expect(leavesContext("store.exit(() => sendEmail(mail));")).toBe(true);
    expect(leavesContext("setImmediate(() => { void sendEmail(mail); });")).toBe(true);
    expect(leavesContext("const result = await sendEmail(mail);\nrunAfterCommit('webhook', () => fire());")).toBe(false);
    expect(leavesContext("process.exit(1);")).toBe(false);
    // The real tree: afterCommit.ts leaves the context, and is the only allowed file that does.
    expect(leavesContext(code('src/lib/afterCommit.ts'))).toBe(true);
    expect(code('src/lib/afterCommit.ts')).toContain('forfeitQuotaRefund()');
  });
});
