/**
 * Census (audit 2026-10-18 S-02/S-03/S-05): every company-scoped API route that accepts a write method
 * carries a role gate. A viewer reached AFS sign-off, portal contacts and fiscal-period creation because
 * nothing failed when a mutating `withAuth` route shipped without one.
 *
 * Every file under pages/api is accounted for. Its default export (a `const` it names is resolved) either
 * goes through `withAuth` — a COMPANY route — or through another authentication (admin host, user session,
 * portal, invite or extension token), or the file is listed in OTHER_ENTRY with how it authenticates.
 * A company route is MUTATING unless it refuses every method but GET and names no write method. It is
 * GATED when its default export composes withWriteAccess (no allowedRoles, or only owner/admin/manager),
 * withRole at a level whose WITH_ROLE_ADMITS lists only writing roles, withPayrollDetailAccess or
 * withPlatformAdmin. Any other mutating company route must be in EXEMPT, with the reason a non-writing
 * role may call it. Files are read from
 * disk (not `git ls-files`), so an untracked new route is counted too. Named limits: routeRoleGateCensus.helpers.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, relative } from 'path';
import { walk, defaultExport, isMutating, isGated, stripComments, OTHER_AUTH_WRAPPER } from './routeRoleGateCensus.helpers';

const ROOT = join(__dirname, '../../..');
const API = join(ROOT, 'pages/api');

const EXEMPT: Record<string, string> = {
  // Checks the role inline.
  'pages/api/accounting/audit-check-runs.ts': 'inline: mayTakeAudit (owner/admin) on POST',
  'pages/api/accounting/audit-snapshots.ts': 'inline: mayTakeAudit (owner/admin) in post()',
  'pages/api/accounting/entity-changes-reveal.ts': 'inline: isHistoryAdmin (owner/admin)',
  'pages/api/accounting/companies.ts': 'inline: PUT needs owner/admin of the named company; POST set-default is the user\'s own default',
  'pages/api/accounting/company-documents.ts': 'inline: canWrite on the named company\'s role before POST/DELETE',
  'pages/api/accounting/company-logo.ts': 'inline: owner/admin membership probe before the write',
  'pages/api/accounting/company-groups.ts': 'inline: group write role and company write role (D4 round 9)',
  'pages/api/accounting/intercompany-transactions.ts': 'inline: group write role on POST',
  'pages/api/accounting/consolidated-reports.ts': 'inline: group write role on every POST action',
  'pages/api/accounting/supplier-rules/index.ts': 'inline: routedHandler wraps every non-GET in withWriteAccess',
  'pages/api/accounting/supplier-rules/[supplierId].ts': 'inline: routedHandler wraps every non-GET in withWriteAccess',
  'pages/api/invitations/index.ts': 'inline: owner/admin',
  'pages/api/invitations/revoke/[id].ts': 'inline: owner/admin',
  // Writes only the caller's own state, not the company's.
  'pages/api/accounting/page-visits.ts': 'the caller\'s own page-visit trail (allowedRoles: null)',
  'pages/api/auth/preferences.ts': 'the caller\'s own preferences',
  'pages/api/auth/profile.ts': 'the caller\'s own profile',
  'pages/api/auth/personal-tokens/index.ts': 'the caller\'s own tokens; write scopes refused to a non-writing role (scopesRoleMayNotHold)',
  'pages/api/auth/personal-tokens/[id].ts': 'revokes the caller\'s own token',
  'pages/api/oauth/consent.ts': 'the caller\'s own grant; write scopes dropped for a non-writing role in the target company',
  'pages/api/oauth/authorisations/[id].ts': 'revokes the caller\'s own OAuth grant',
  'pages/api/developer/oauth-apps/index.ts': 'the caller\'s own developer app registration',
  'pages/api/developer/oauth-apps/[id].ts': 'the caller\'s own developer app registration',
  'pages/api/onboarding/complete-setup.ts': 'creates the caller\'s new company (they become its owner)',
  'pages/api/onboarding/complete.ts': 'onboarding of the caller\'s new company',
  // Computes and returns; writes nothing.
  'pages/api/accounting/afs/[documentId]/compliance-check.ts': 'read-only IFRS checks over POST',
  'pages/api/accounting/exchange-rate-convert.ts': 'read-only conversion over POST',
  'pages/api/accounting/ar/dunning/templates/[id]/preview.ts': 'renders a preview, sends nothing',
  'pages/api/accounting/netcash/test-connection.ts': 'probes the Netcash API with a key in the body; stores nothing',
  'pages/api/onboarding/extract.ts': 'VLM extraction of an uploaded document; stores nothing',
  'pages/api/onboarding/extract-id.ts': 'VLM extraction of an uploaded ID; stores nothing',
  'pages/api/onboarding/validate-directors.ts': 'validation only',
  // GET-only, but in a shape the detector cannot prove (a GET branch, then a non-405 refusal).
  'pages/api/accounting/loans/portfolio/summary.ts': 'reads only; every other method answers 400',
  // GET routes that write: they sync a provider's status onto the company's own rows.
  'pages/api/accounting/netcash/status.ts': 'GET refreshes netcash_submissions.status from Netcash; idempotent sync, no user input written',
};

/** For each `inline:` exemption, the call that does the role check. Its absence from the code fails the census. */
const INLINE_CHECK: Record<string, string> = {
  'pages/api/accounting/audit-check-runs.ts': 'mayTakeAudit(companyRole)',
  'pages/api/accounting/audit-snapshots.ts': 'mayTakeAudit(',
  'pages/api/accounting/entity-changes-reveal.ts': 'isHistoryAdmin(companyRole)',
  'pages/api/accounting/companies.ts': "['owner', 'admin'].includes(membership.role)",
  'pages/api/accounting/company-documents.ts': 'canWrite(String(rows[0]!.role))',
  'pages/api/accounting/company-logo.ts': "['owner', 'admin'].includes(String(membership[0]!.role))",
  'pages/api/accounting/company-groups.ts': 'userCanWriteCompany(userId, companyId)',
  'pages/api/accounting/intercompany-transactions.ts': 'userCanWriteGroup(userId,',
  'pages/api/accounting/consolidated-reports.ts': 'userCanWriteGroup(userId, gId)',
  'pages/api/accounting/supplier-rules/index.ts': 'return withWriteAccess(handler',
  'pages/api/accounting/supplier-rules/[supplierId].ts': 'return withWriteAccess(handler',
  'pages/api/invitations/index.ts': "['owner', 'admin'].includes(companyRole)",
  'pages/api/invitations/revoke/[id].ts': "['owner', 'admin'].includes(request.companyRole)",
};

/** Not company-scoped, or authenticated some other way; a prefix ending in '/' covers the directory. */
const OTHER_ENTRY: Record<string, string> = {
  'pages/api/auth/': 'login, session, MFA and the caller\'s own account',
  'pages/api/oauth/': 'OAuth metadata, registration and token exchange (consent is a withAuth route)',
  'pages/api/portal/': 'AR customer portal: invoice tokens and the portal session',
  'pages/api/accounting/portal/': 'AFS portal contacts: magic link and portal JWT',
  'pages/api/health/': 'health checks, read-only',
  'pages/api/cron/': 'CRON_SECRET, timing-safe',
  'pages/api/accounting/afs/cron/': 'CRON_SECRET, timing-safe',
  'pages/api/webhooks/': 'provider HMAC / secret',
  'pages/api/accounting/capture/upload.ts': 'capture API key, else withAuth(withWriteAccess) inside authAndHandle',
  'pages/api/accounting/capture/inbound-email.ts': 'inbound mail webhook secret',
  'pages/api/accounting/capture/inbound/whatsapp.ts': 'Twilio signature',
  'pages/api/audit-portal/download.ts': 'audit-portal share token',
  'pages/api/mcp/index.ts': 'PAT/OAuth bearer; every write tool is role-fenced in the registry (roleFence.ts)',
  'pages/api/accounting/gl-lines-export.ts': 'GET only; withBearerOrCookieAuth: a cookie session is withAuth, a PAT/OAuth bearer the shared pipeline, both under withScope(read:reports)',
  'pages/api/invite/[token].ts': 'public GET by token; POST withUserAuth with an email match',
  'pages/api/contact.ts': 'public contact form, rate-limited',
  'pages/api/waitlist.ts': 'public waitlist form',
  'pages/api/landing-stats.ts': 'public aggregate (audit S-12)',
  'pages/api/track/event.ts': 'public analytics beacon',
};
const otherEntry = (path: string) =>
  Object.keys(OTHER_ENTRY).some((k) => (k.endsWith('/') ? path.startsWith(k) || path.includes(`/${k.slice('pages/api/'.length)}`) : path === k));

interface Route { path: string; exp: string; src: string }
const FILES: Route[] = walk(API).map((file) => {
  const src = readFileSync(file, 'utf8');
  return { path: relative(ROOT, file), exp: defaultExport(src), src };
});
const COMPANY = FILES.filter((f) => /\bwithAuth\(/.test(f.exp));
const UNGATED = COMPANY.filter((r) => isMutating(r.src) && !isGated(r.exp)).map((r) => r.path).sort();

const exp = (body: string) => `export default ${body};`;

describe('mutating withAuth route role-gate census', () => {
  it('sees the route tree (a bad path would pass every assertion vacuously)', () => {
    expect(COMPANY.length).toBeGreaterThan(600);
    expect(COMPANY.filter((r) => isMutating(r.src) && isGated(r.exp)).length).toBeGreaterThan(300);
  });

  it('every pages/api file is a company route, another authentication, or a listed entry point', () => {
    const unknown = FILES
      .filter((f) => !/\bwithAuth\(/.test(f.exp) && !OTHER_AUTH_WRAPPER.test(f.exp) && !otherEntry(f.path))
      .map((f) => f.path);
    expect(unknown, 'A route whose default export is not withAuth(...) must say how it authenticates in OTHER_ENTRY').toEqual([]);
  });

  it('every mutating company route has a role gate or a stated exemption', () => {
    const missing = UNGATED.filter((p) => !(p in EXEMPT));
    expect(missing, 'Add withWriteAccess (or a stricter gate) to these routes, or an EXEMPT entry saying why a viewer may call them').toEqual([]);
  });

  it('every exemption is still a live, ungated, mutating route (no stale entries)', () => {
    const stale = Object.keys(EXEMPT).filter((p) => !UNGATED.includes(p));
    expect(stale).toEqual([]);
  });

  it('every inline exemption still contains its role check (comments do not count)', () => {
    const inline = Object.entries(EXEMPT).filter(([, why]) => why.startsWith('inline:')).map(([p]) => p).sort();
    expect(inline).toEqual(Object.keys(INLINE_CHECK).sort());
    const lost = inline.filter((p) => !stripComments(FILES.find((f) => f.path === p)?.src ?? '').includes(INLINE_CHECK[p]!));
    expect(lost).toEqual([]);
  });

  it('every OTHER_ENTRY file still exists and is still not a withAuth route', () => {
    const files = Object.keys(OTHER_ENTRY).filter((k) => !k.endsWith('/'));
    const stale = files.filter((k) => !FILES.some((f) => f.path === k && !/\bwithAuth\(/.test(f.exp)));
    expect(stale).toEqual([]);
  });
});

describe('the detector', () => {
  const gated = (s: string) => isGated(defaultExport(s));

  it('catches the S-03 shape and accepts the gated one', () => {
    expect(gated(exp('withAuth(withErrorHandler(withCsrf(handler as never)))'))).toBe(false);
    expect(gated(exp('withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))))'))).toBe(true);
    expect(gated(exp("withAuth(withRole('admin')(withErrorHandler(handler)))"))).toBe(true);
    expect(gated(`/** withWriteAccess( in a comment */\n${exp('withAuth(handler)')}`)).toBe(false);
  });

  it('refuses an allowedRoles that lets a non-writing role through', () => {
    expect(gated(exp('withAuth(withWriteAccess(handler, { allowedRoles: null }))'))).toBe(false);
    expect(gated(exp("withAuth(withWriteAccess(handler, { allowedRoles: ['owner', 'viewer'] }))"))).toBe(false);
    expect(gated(exp("withAuth(withWriteAccess(handler, { allowedRoles: ['storeman'] }))"))).toBe(false);
    expect(gated(exp('withAuth(withWriteAccess(handler, { allowedRoles: ROLES }))'))).toBe(false);
    expect(gated(exp("withAuth(withWriteAccess(handler, { allowedRoles: ['owner', 'admin'] }))"))).toBe(true);
    expect(gated(exp("withAuth(withRole('viewer')(handler))"))).toBe(false);
    // withRole has no 'manager' or 'owner' level; a name it would throw on is no gate.
    expect(gated(exp("withAuth(withRole('manager')(handler))"))).toBe(false);
    expect(gated(exp("withAuth(withRole('owner')(handler))"))).toBe(false);
  });

  it('refuses options it cannot read: a variable or a spread (breaker REPRO 5)', () => {
    expect(gated("const opts = { allowedRoles: ['viewer'] };\nexport default withAuth(withWriteAccess(handler, opts));")).toBe(false);
    expect(gated(exp('withAuth(withWriteAccess(handler, { ...OPEN }))'))).toBe(false);
    expect(gated(exp('withAuth(withWriteAccess(handler, { allowedRoles: DEFAULT_WRITE_ROLES }))'))).toBe(true);
    expect(gated(exp('withAuth(withWriteAccess(withFlowMeter(a, b)(handler) as never))'))).toBe(true);
  });

  it('refuses an allowedRoles array it cannot read element by element (REPRO 9); a regex apostrophe holds no string open (REPRO 10)', () => {
    expect(gated(exp("withAuth(withWriteAccess(handler, { allowedRoles: ['owner'].concat(['viewer']) }))"))).toBe(false);
    expect(gated(exp("withAuth(withWriteAccess(handler, { allowedRoles: ['owner', VIEWER] }))"))).toBe(false);
    expect(gated(exp("withAuth(withWriteAccess(handler, { allowedRoles: ['owner', ...MORE] }))"))).toBe(false);
    expect(gated(exp("withAuth(withWriteAccess(handler, { allowedRoles: ['owner', 'admin'], other: 1 }))"))).toBe(true);
    expect(gated("const re = /don't/;\nexport default withAuth(handler /* withWriteAccess(h) */);")).toBe(false);
  });

  it('reads write SQL in any case and with a quoted table; a // inside a string is not a comment (REPRO 6, 7)', () => {
    const guard = "if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method, ['GET']);\n";
    expect(isMutating(`${guard}await sql\`update invoices set status = 'void'\`;`)).toBe(true);
    expect(isMutating(`${guard}await sql\`UPDATE "Invoices" SET x = 1\`;`)).toBe(true);
    expect(isMutating(`${guard}const base = 'a//b'; await sql\`DELETE FROM t\`;`)).toBe(true);
    expect(stripComments("const u = 'https://x'; // gone\n/* gone */ y")).toBe("const u = 'https://x'; \n y");
  });

  it('resolves `export default x` and reads a multi-statement export to its end', () => {
    expect(defaultExport('const x = withAuth(withCsrf(handler));\nexport default x;')).toMatch(/^withAuth\(/);
    expect(gated('const x = withAuth(withWriteAccess(handler));\nexport default x;')).toBe(true);
    expect(gated(exp('withAuth(async (req, res) => { const a = 1; return withWriteAccess(h)(req, res); })'))).toBe(true);
    expect(defaultExport('export default async function router(req, res) {}')).toBe('function');
  });

  it('a GET-only guard with inline write SQL is still mutating', () => {
    expect(isMutating("if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method, ['GET']);\nawait sql`\n  UPDATE invoices\n  SET x = 1`;")).toBe(true);
  });

  it('a GET early-return with a write path is still mutating', () => {
    expect(isMutating("if (req.method === 'GET') return list(); await sql`DELETE FROM x`;")).toBe(true);
    expect(isMutating("if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method, ['GET']);")).toBe(false);
    expect(isMutating("if (req.method === 'GET') { return x; } if (req.method === 'POST') {}")).toBe(true);
  });
});
