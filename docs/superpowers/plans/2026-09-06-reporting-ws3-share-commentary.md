# Reporting WS3: Share Links, Approved Commentary and Annotations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A report pack can be shared outside IsaFlow through a signed, expiring, revocable link that renders read-only and audited; AI commentary is a draft until a named user approves it and only approved text reaches that link; internal users can leave threaded notes on a statement row that never leave the tenant.

**Architecture:** Three tables, four services, one public page. `share_links` stores a SHA-256 hash of a 256-bit token — never the token — plus the report kind and its parameters; the public route resolves the company **from the link row only** and rebuilds the pack server-side with the same `buildReportPack` the authenticated route uses, so a share link can never render a company the link does not name. `report_commentary` holds `draft_text` and `approved_text` as separate columns with a three-state machine; the share loader and the PDF select `approved_text` and nothing else, which makes an unapproved sentence structurally unable to leak rather than conditionally hidden. `report_annotations` is internal-only and is never read by any code path the share loader can reach.

**Tech Stack:** Next.js 14 Pages Router · TypeScript strict · React 18 · Postgres (Supabase, self-hosted) with RLS · Vitest 4 (node for services, happy-dom for components, integration against a live `DATABASE_URL`) · Node `crypto` for HMAC/hashing. **No new dependencies.**

**Spec:** `docs/superpowers/plans/2026-09-05-reporting-programme.md` (its Global Constraints apply to every task here) plus the WS3 controller rulings reproduced under Global Constraints below.

---

## Global Constraints

- **No new dependencies.** `bun add` is not run in this workstream. Token generation and hashing use `node:crypto`.
- **Share links are signed, expiring URLs with no login.** Default expiry 30 days. Token is shown once at creation and never stored in plaintext. Revocation and expiry are enforced server-side on every view.
- **The share loader resolves the company from the link row, never from the request.** No `companyId` may be read from a query string, header, cookie or body on any route under `pages/share/**` or `pages/api/share/**`.
- **AI commentary is a draft until a named user approves it.** `aiCommentaryService` writes drafts only. Approval is a POST that copies `draft_text` into `approved_text` with the approver's id and an audit row. Share links and the PDF read `approved_text` only.
- **Commentary is placed inline**, as a sentence under the figure it explains, not in a side panel.
- **Annotations are internal only.** No annotation, and no annotation count, is ever returned by a share route or rendered on a share page.
- **Every write is `withAuth(withErrorHandler(...))`**, company-scoped, with an audit `log.info`.
- **Every migration**: `IF NOT EXISTS` on `CREATE TABLE` / `CREATE INDEX`, `company_id` on every tenant table, RLS enabled + forced + a `tenant_isolation` policy in a `DO $$` block (`CREATE POLICY` has no `IF NOT EXISTS`), next unused 3-digit prefix. Never edit an applied migration.
- **The pool connection is a superuser and therefore bypasses RLS.** `SET LOCAL ROLE app_user` inside `withAuth`'s transaction is what puts a request under RLS; an unauthenticated query (which is every share-page query) runs *outside* it. RLS is defence in depth here, not the control. Every share query carries its own `company_id` predicate derived from the link row, and that predicate is the control.
- **Repo rules:** max 300 lines per file, no `any` outside the Next.js patterns that require it, `log` from `@/lib/logger` never `console`, no empty `catch`, `sql` tagged template from `@/lib/neon` and never string concatenation.
- **Branch** `feat/reporting-ws3-share`, its own worktree. Stage by explicit path. No `git stash`. No `git add -A`. Commit after every task; `bun run type-check` before each commit; `bun run ci` before the PR.
- **Adversarial review is mandatory** on Tasks 1–6 and 8–9 (see Task 14 for the attack list).

---

## Migration prefix

`610` and `611`. Verified two ways at plan time against `master` @ `114dbc10`:

```bash
ls scripts/migrations/sql/ | tail -3      # → 608_, 609_ are the highest
for b in $(git branch -r --format='%(refname:short)'); do
  git ls-tree --name-only "$b" scripts/migrations/sql/ | grep -E '^61[0-9]_'
done | sort -u                            # → empty across all 132 remote branches
```

**Re-run both commands immediately before Task 1**, and again before pushing. A PR that merges first steals the prefix; if 610 or 611 is taken by then, renumber both files to the next free pair and keep them adjacent.

---

## File Structure

```
scripts/migrations/sql/610_report_share_links.sql        share_links, share_link_views, RLS
scripts/migrations/sql/611_report_commentary.sql         report_commentary, report_annotations, RLS

src/modules/accounting/services/share/
  shareToken.ts              mintShareToken, hashShareToken, isShareTokenShape   (pure, no DB)
  shareLinkService.ts        createShareLink, listShareLinks, revokeShareLink     (authenticated side)
  shareResolver.ts           resolveShareLink, recordShareView                    (public side, no auth)
  sharedPackService.ts       buildSharedPack — pack + approved commentary for a resolved link
  shareParams.ts             SharePackParams type, parseSharePackParams, canonicalParamsHash

src/modules/accounting/services/commentary/
  commentaryState.ts         the state machine: nextStatus(), pure, no DB
  commentaryService.ts       generateDraft, approveCommentary, rejectCommentary, listCommentary
  commentaryDraft.ts         buildDraftSentences(packSections) — wraps aiCommentaryService

src/modules/accounting/services/annotations/
  annotationService.ts       createAnnotation, listAnnotations, resolveAnnotation

pages/api/accounting/share/links.ts                  GET list, POST create
pages/api/accounting/share/links/[id]/revoke.ts      POST revoke
pages/api/accounting/commentary/index.ts             GET list, POST generate draft
pages/api/accounting/commentary/[id]/approve.ts      POST approve
pages/api/accounting/commentary/[id]/reject.ts       POST reject
pages/api/accounting/annotations/index.ts            GET list, POST create
pages/api/accounting/annotations/[id]/resolve.ts     POST resolve

pages/share/[token].tsx                              public, getServerSideProps, no AppLayout

src/components/accounting/share/ShareLinkDialog.tsx  create / list / revoke, token shown once
src/components/accounting/share/SharedPackView.tsx   read-only pack renderer used by pages/share
src/components/accounting/commentary/CommentaryBlock.tsx   inline text + approve/reject controls
src/components/accounting/annotations/NoteMarker.tsx       the icon on the row
src/components/accounting/annotations/AnnotationThread.tsx popover thread
src/components/accounting/annotations/attachNotes.ts       pure: rows × annotations → rows with .note

tests/unit/services/share/shareToken.test.ts
tests/unit/services/share/shareParams.test.ts
tests/unit/services/commentary/commentaryState.test.ts
tests/unit/services/commentary/commentaryDraft.test.ts
tests/unit/services/annotations/attachNotes.test.ts
tests/unit/components/commentary/CommentaryBlock.test.tsx
tests/unit/components/annotations/NoteMarker.test.tsx
tests/integration/share-link-lifecycle.int.test.ts
tests/integration/share-commentary-rls.int.test.ts
```

Modified (additive only, exact diffs in Task 12):
- `src/modules/accounting/services/reports/statementRows/statementModel.ts` — `+ note?: StatementRowNote` on `StatementRow`, `+ export interface StatementRowNote`.
- `src/components/accounting/statement/StatementRowView.tsx` — `+ onOpenNote?` prop, renders `<NoteMarker>` in the label cell when `row.note` is set.
- `src/components/accounting/statement/StatementGrid.tsx` — `+ onOpenNote?` prop, passed straight through.

---

### Task 1: Migration 610 — `share_links` and `share_link_views`

**Files:**
- Create: `scripts/migrations/sql/610_report_share_links.sql`

**Interfaces:**
- Produces: tables `share_links` and `share_link_views`, both with `company_id`, RLS enabled + forced + `tenant_isolation` policy. Every later task in this plan reads or writes them.

- [ ] **Step 1: Re-verify the prefix**

Run the two commands under "Migration prefix" above. If `610` is taken, use the next free pair and rename both files consistently.

- [ ] **Step 2: Write the migration**

```sql
-- scripts/migrations/sql/610_report_share_links.sql
-- WS3: signed, expiring, revocable share links for report packs.
--
-- The TOKEN IS NEVER STORED. `token_hash` is sha256(token) hex; the raw token
-- is returned exactly once, at creation, and is thereafter only ever presented
-- by a viewer. A database dump therefore does not hand anyone a working link.
--
-- `report_kind` + `params` rather than a foreign key to a saved pack: a pack in
-- this codebase is BUILT per request from (type, from, to) by
-- reportPackService.buildReportPack and is not persisted. Storing the inputs
-- means a link renders the same figures on every view without WS3 depending on
-- WS2's pack storage, and it keeps the link's blast radius to one report.
--
-- No FK on created_by / revoked_by: users.id is character varying(255) with a
-- gen_random_uuid()::text default, so a uuid-typed FK to it fails at apply
-- time. TEXT, unconstrained, as everywhere else in this schema (see mig 595).

CREATE TABLE IF NOT EXISTS share_links (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id),
  report_kind   TEXT NOT NULL,
  params        JSONB NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  label         TEXT,
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 days',
  revoked_at    TIMESTAMPTZ,
  revoked_by    TEXT,
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  view_count    INTEGER NOT NULL DEFAULT 0,
  last_viewed_at TIMESTAMPTZ,
  CONSTRAINT share_links_kind_chk CHECK (report_kind IN ('pack'))
);

CREATE INDEX IF NOT EXISTS idx_share_links_company
  ON share_links (company_id, created_at DESC);

-- Every view, including views of a dead link. `outcome` separates a successful
-- render from a hit on an expired or revoked link, which is the difference
-- between "a client read the pack" and "someone is using a link we withdrew".
CREATE TABLE IF NOT EXISTS share_link_views (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id),
  share_link_id UUID NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
  outcome       TEXT NOT NULL,
  ip_address    TEXT,
  user_agent    TEXT,
  viewed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT share_link_views_outcome_chk CHECK (outcome IN ('ok', 'expired', 'revoked'))
);

CREATE INDEX IF NOT EXISTS idx_share_link_views_link
  ON share_link_views (share_link_id, viewed_at DESC);

CREATE INDEX IF NOT EXISTS idx_share_link_views_company
  ON share_link_views (company_id, viewed_at DESC);

-- Tenant isolation. Shape copied verbatim from 596_gl_account_merges_rls.sql.
-- Note this does NOT constrain the public share route: that route runs on the
-- pool connection as a superuser, which bypasses RLS. It constrains every
-- AUTHENTICATED path, which is where a cross-tenant read of another company's
-- links would otherwise be possible.
ALTER TABLE share_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE share_links FORCE ROW LEVEL SECURITY;
ALTER TABLE share_link_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE share_link_views FORCE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['share_links', 'share_link_views'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t AND policyname = 'tenant_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON public.%I TO app_user '
        'USING (company_id IN (SELECT auth.user_companies())) '
        'WITH CHECK (company_id = app.current_company_id())', t);
    END IF;
  END LOOP;
END $$;
```

- [ ] **Step 3: Apply it and prove the policies exist**

```bash
cd <worktree> && bun run db:migrate
psql "$DATABASE_URL" -c "SELECT tablename, policyname FROM pg_policies WHERE tablename IN ('share_links','share_link_views')"
```
Expected: two rows, both `tenant_isolation`.

```bash
psql "$DATABASE_URL" -c "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('share_links','share_link_views')"
```
Expected: both `t`/`t`.

- [ ] **Step 4: Commit**

```bash
git add scripts/migrations/sql/610_report_share_links.sql
git commit -m "feat(share): share_links and share_link_views with tenant isolation"
```

---

### Task 2: `shareToken.ts` — mint, hash, shape-check

**Files:**
- Create: `src/modules/accounting/services/share/shareToken.ts`
- Test: `tests/unit/services/share/shareToken.test.ts`

**Interfaces:**
- Produces: `mintShareToken(): string` (43-char base64url, 256 bits), `hashShareToken(token: string): string` (64-char lowercase hex), `isShareTokenShape(token: unknown): token is string`.
- Consumed by: Tasks 3, 5, 6.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/services/share/shareToken.test.ts
import { describe, it, expect } from 'vitest';
import { mintShareToken, hashShareToken, isShareTokenShape } from '@/modules/accounting/services/share/shareToken';

describe('mintShareToken', () => {
  it('returns 43 base64url characters, which is 256 bits', () => {
    const t = mintShareToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('never repeats across a thousand mints', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(mintShareToken());
    expect(seen.size).toBe(1000);
  });
});

describe('hashShareToken', () => {
  it('is sha256 hex and is stable', () => {
    const h = hashShareToken('abc');
    expect(h).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('gives different hashes for tokens differing in one character', () => {
    expect(hashShareToken('a'.repeat(43))).not.toBe(hashShareToken('a'.repeat(42) + 'b'));
  });
});

describe('isShareTokenShape', () => {
  it('accepts a minted token', () => {
    expect(isShareTokenShape(mintShareToken())).toBe(true);
  });

  it('rejects the wrong length, the wrong alphabet, and non-strings', () => {
    expect(isShareTokenShape('a'.repeat(42))).toBe(false);
    expect(isShareTokenShape('a'.repeat(44))).toBe(false);
    expect(isShareTokenShape('a'.repeat(42) + '+')).toBe(false);
    expect(isShareTokenShape('a'.repeat(42) + '/')).toBe(false);
    expect(isShareTokenShape(null)).toBe(false);
    expect(isShareTokenShape(undefined)).toBe(false);
    expect(isShareTokenShape(12345)).toBe(false);
    expect(isShareTokenShape(['a'.repeat(43)])).toBe(false);
  });

  it("rejects a SQL-ish and a path-traversal payload so the route's 404 is unconditional", () => {
    expect(isShareTokenShape("' OR 1=1 --")).toBe(false);
    expect(isShareTokenShape('../../etc/passwd')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd <worktree> && ./node_modules/.bin/vitest run tests/unit/services/share/shareToken.test.ts`
Expected: FAIL, cannot find module `@/modules/accounting/services/share/shareToken`.

> Use `./node_modules/.bin/vitest`, not `npx vitest`. In a worktree `npx` can resolve a cached binary from `~/.npm/_npx/**` instead of this repo's, and you get a phantom pass.

- [ ] **Step 3: Implement**

```ts
// src/modules/accounting/services/share/shareToken.ts
/**
 * Share-link token primitives.
 *
 * 256 bits of CSPRNG output, base64url, 43 characters. Guessing one is not a
 * threat model we mitigate with rate limits — it is infeasible — but the shape
 * check exists so that a malformed token is rejected BEFORE it reaches a query,
 * making the 404 for an unknown link unconditional and constant-shaped.
 *
 * Only the sha256 of the token is ever persisted (share_links.token_hash), so
 * a database read does not yield a working link. There is no HMAC and no
 * embedded expiry: expiry and revocation are columns, checked server-side on
 * every view, so withdrawing a link is immediate rather than waiting out a TTL.
 */
import { createHash, randomBytes } from 'node:crypto';

const TOKEN_BYTES = 32;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function mintShareToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashShareToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function isShareTokenShape(token: unknown): token is string {
  return typeof token === 'string' && TOKEN_SHAPE.test(token);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/vitest run tests/unit/services/share/shareToken.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/accounting/services/share/shareToken.ts tests/unit/services/share/shareToken.test.ts
git commit -m "feat(share): 256-bit share tokens, stored only as a sha256 hash"
```

---

### Task 3: `shareParams.ts` — what a link is allowed to point at

**Files:**
- Create: `src/modules/accounting/services/share/shareParams.ts`
- Test: `tests/unit/services/share/shareParams.test.ts`

**Interfaces:**
- Produces: `interface SharePackParams { type: 'board' | 'management' | 'monthly'; from: string; to: string }`, `parseSharePackParams(raw: unknown): SharePackParams | null`, `canonicalParamsHash(p: SharePackParams): string`.
- Consumed by: Tasks 4, 6, 8 (commentary keys a report by the same hash).

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/services/share/shareParams.test.ts
import { describe, it, expect } from 'vitest';
import { parseSharePackParams, canonicalParamsHash } from '@/modules/accounting/services/share/shareParams';

describe('parseSharePackParams', () => {
  it('accepts the three pack types with ISO dates', () => {
    expect(parseSharePackParams({ type: 'board', from: '2026-03-01', to: '2026-08-31' }))
      .toEqual({ type: 'board', from: '2026-03-01', to: '2026-08-31' });
    expect(parseSharePackParams({ type: 'management', from: '2026-03-01', to: '2026-08-31' })).not.toBeNull();
    expect(parseSharePackParams({ type: 'monthly', from: '2026-03-01', to: '2026-08-31' })).not.toBeNull();
  });

  it('drops any extra key rather than carrying it into the stored params', () => {
    expect(parseSharePackParams({ type: 'board', from: '2026-03-01', to: '2026-08-31', companyId: 'other-tenant' }))
      .toEqual({ type: 'board', from: '2026-03-01', to: '2026-08-31' });
  });

  it('rejects an unknown type, a bad date, a reversed range, and a non-object', () => {
    expect(parseSharePackParams({ type: 'annual', from: '2026-03-01', to: '2026-08-31' })).toBeNull();
    expect(parseSharePackParams({ type: 'board', from: '01/03/2026', to: '2026-08-31' })).toBeNull();
    expect(parseSharePackParams({ type: 'board', from: '2026-08-31', to: '2026-03-01' })).toBeNull();
    expect(parseSharePackParams(null)).toBeNull();
    expect(parseSharePackParams('board')).toBeNull();
  });
});

describe('canonicalParamsHash', () => {
  it('is key-order independent', () => {
    const a = canonicalParamsHash({ to: '2026-08-31', from: '2026-03-01', type: 'board' });
    const b = canonicalParamsHash({ type: 'board', from: '2026-03-01', to: '2026-08-31' });
    expect(a).toBe(b);
  });

  it('changes when any field changes', () => {
    const base = canonicalParamsHash({ type: 'board', from: '2026-03-01', to: '2026-08-31' });
    expect(canonicalParamsHash({ type: 'monthly', from: '2026-03-01', to: '2026-08-31' })).not.toBe(base);
    expect(canonicalParamsHash({ type: 'board', from: '2026-03-02', to: '2026-08-31' })).not.toBe(base);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/vitest run tests/unit/services/share/shareParams.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement**

```ts
// src/modules/accounting/services/share/shareParams.ts
/**
 * The only thing a share link is allowed to point at, and the canonical key
 * commentary is filed under.
 *
 * `parseSharePackParams` REBUILDS the object field by field rather than
 * validating in place. That is deliberate: a caller who posts
 * `{ type, from, to, companyId }` must not have `companyId` end up inside
 * `share_links.params`, where a later reader might trust it. The company on a
 * link comes from the authenticated session at creation and from the link row
 * at read time, never from params.
 */
import { createHash } from 'node:crypto';

const PACK_TYPES = ['board', 'management', 'monthly'] as const;
export type SharePackType = (typeof PACK_TYPES)[number];

export interface SharePackParams {
  type: SharePackType;
  from: string;
  to: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string' || !ISO_DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export function parseSharePackParams(raw: unknown): SharePackParams | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const type = r.type;
  if (typeof type !== 'string' || !(PACK_TYPES as readonly string[]).includes(type)) return null;
  if (!isIsoDate(r.from) || !isIsoDate(r.to)) return null;
  if (r.from > r.to) return null;
  return { type: type as SharePackType, from: r.from, to: r.to };
}

/** sha256 over the fields in a fixed order — the key commentary is filed under,
 *  so the same pack for the same period always resolves the same commentary. */
export function canonicalParamsHash(p: SharePackParams): string {
  return createHash('sha256').update(`${p.type}|${p.from}|${p.to}`).digest('hex');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/vitest run tests/unit/services/share/shareParams.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/accounting/services/share/shareParams.ts tests/unit/services/share/shareParams.test.ts
git commit -m "feat(share): parse and canonically hash the parameters a link points at"
```

---

### Task 4: `shareLinkService.ts` and the authenticated share API

**Files:**
- Create: `src/modules/accounting/services/share/shareLinkService.ts`
- Create: `pages/api/accounting/share/links.ts`
- Create: `pages/api/accounting/share/links/[id]/revoke.ts`

**Interfaces:**
- Consumes: `mintShareToken`, `hashShareToken` (Task 2); `parseSharePackParams`, `SharePackParams` (Task 3).
- Produces: `createShareLink(input): Promise<{ link: ShareLinkRow; token: string }>`, `listShareLinks(companyId): Promise<ShareLinkRow[]>`, `revokeShareLink(companyId, id, userId): Promise<boolean>`, `interface ShareLinkRow`.

- [ ] **Step 1: Write the service**

```ts
// src/modules/accounting/services/share/shareLinkService.ts
/**
 * The authenticated side of share links: create, list, revoke. The public side
 * lives in shareResolver.ts and shares no code path with this file beyond the
 * token hash function.
 *
 * The raw token is returned by createShareLink and NEVER again — not by
 * listShareLinks, not by any route. A lost link is re-created, not recovered.
 */
import { sql, type DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { mintShareToken, hashShareToken } from './shareToken';
import type { SharePackParams } from './shareParams';

export interface ShareLinkRow {
  id: string;
  reportKind: 'pack';
  params: SharePackParams;
  label: string | null;
  expiresAt: string;
  revokedAt: string | null;
  createdBy: string;
  createdAt: string;
  viewCount: number;
  lastViewedAt: string | null;
}

const MAX_TTL_DAYS = 90;
const DEFAULT_TTL_DAYS = 30;

function toRow(r: DbRow): ShareLinkRow {
  return {
    id: String(r.id),
    reportKind: 'pack',
    params: r.params as SharePackParams,
    label: r.label === null || r.label === undefined ? null : String(r.label),
    expiresAt: new Date(r.expires_at).toISOString(),
    revokedAt: r.revoked_at ? new Date(r.revoked_at).toISOString() : null,
    createdBy: String(r.created_by),
    createdAt: new Date(r.created_at).toISOString(),
    viewCount: Number(r.view_count),
    lastViewedAt: r.last_viewed_at ? new Date(r.last_viewed_at).toISOString() : null,
  };
}

/** Clamp to [1, 90] days. A caller-supplied ttl is a convenience, not a way to
 *  mint a link that outlives the engagement. */
export function clampTtlDays(days: number | undefined): number {
  const n = Math.trunc(days ?? DEFAULT_TTL_DAYS);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_TTL_DAYS;
  return Math.min(n, MAX_TTL_DAYS);
}

export async function createShareLink(input: {
  companyId: string;
  userId: string;
  params: SharePackParams;
  label?: string;
  ttlDays?: number;
}): Promise<{ link: ShareLinkRow; token: string }> {
  const token = mintShareToken();
  const ttl = clampTtlDays(input.ttlDays);
  const rows = (await sql`
    INSERT INTO share_links (company_id, report_kind, params, token_hash, label, expires_at, created_by)
    VALUES (
      ${input.companyId}::uuid, 'pack', ${JSON.stringify(input.params)}::jsonb,
      ${hashShareToken(token)}, ${input.label ?? null},
      NOW() + (${ttl} || ' days')::interval, ${input.userId}
    )
    RETURNING *
  `) as DbRow[];
  const link = toRow(rows[0]!);
  log.info('Share link created', {
    companyId: input.companyId, userId: input.userId, shareLinkId: link.id,
    packType: input.params.type, from: input.params.from, to: input.params.to, ttlDays: ttl,
  }, 'share');
  return { link, token };
}

export async function listShareLinks(companyId: string): Promise<ShareLinkRow[]> {
  const rows = (await sql`
    SELECT id, params, label, expires_at, revoked_at, created_by, created_at, view_count, last_viewed_at
    FROM share_links
    WHERE company_id = ${companyId}::uuid
    ORDER BY created_at DESC
    LIMIT 200
  `) as DbRow[];
  return rows.map(toRow);
}

/** Returns false when the id does not belong to this company — the caller
 *  answers 404, so a cross-company id and a missing id are indistinguishable. */
export async function revokeShareLink(companyId: string, id: string, userId: string): Promise<boolean> {
  const rows = (await sql`
    UPDATE share_links
    SET revoked_at = NOW(), revoked_by = ${userId}
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid AND revoked_at IS NULL
    RETURNING id
  `) as DbRow[];
  if (rows.length === 0) return false;
  log.info('Share link revoked', { companyId, userId, shareLinkId: id }, 'share');
  return true;
}
```

- [ ] **Step 2: Write the list/create route**

```ts
// pages/api/accounting/share/links.ts
/**
 * GET  /api/accounting/share/links        — this company's links (never the token)
 * POST /api/accounting/share/links        — create; returns the token ONCE
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { parseSharePackParams } from '@/modules/accounting/services/share/shareParams';
import { createShareLink, listShareLinks } from '@/modules/accounting/services/share/shareLinkService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, user } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    return apiResponse.success(res, { links: await listShareLinks(companyId) });
  }

  if (req.method === 'POST') {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const params = parseSharePackParams(body.params);
    if (!params) {
      return apiResponse.badRequest(res, 'params must be { type: board|management|monthly, from: YYYY-MM-DD, to: YYYY-MM-DD }');
    }
    const label = typeof body.label === 'string' ? body.label.slice(0, 120) : undefined;
    const ttlDays = typeof body.ttlDays === 'number' ? body.ttlDays : undefined;

    const { link, token } = await createShareLink({ companyId, userId: user.id, params, label, ttlDays });
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3200';
    log.info('Share link issued to user', { companyId, userId: user.id, shareLinkId: link.id }, 'share');
    // `token` and `url` appear in this response and nowhere else, ever.
    return apiResponse.success(res, { link, token, url: `${appUrl}/share/${token}` });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
```

- [ ] **Step 3: Write the revoke route**

```ts
// pages/api/accounting/share/links/[id]/revoke.ts
/** POST /api/accounting/share/links/[id]/revoke — immediate, server-side withdrawal. */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { revokeShareLink } from '@/modules/accounting/services/share/shareLinkService';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  const { companyId, user } = req as CompanyAuthedRequest;
  const id = req.query.id;
  if (typeof id !== 'string' || !UUID.test(id)) return apiResponse.notFound(res, 'Share link');
  const revoked = await revokeShareLink(companyId, id, user.id);
  // A link belonging to another company, an already-revoked link and a
  // non-existent id all answer 404: no probe distinguishes them.
  if (!revoked) return apiResponse.notFound(res, 'Share link');
  return apiResponse.success(res, { revoked: true });
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
```

- [ ] **Step 4: Type-check and check for duplicate routes**

Run: `bun run type-check && bun run check:routes`
Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add src/modules/accounting/services/share/shareLinkService.ts pages/api/accounting/share/links.ts pages/api/accounting/share/links/\[id\]/revoke.ts
git commit -m "feat(share): create, list and revoke share links from an authenticated session"
```

---

### Task 5: `shareResolver.ts` — the public side

**Files:**
- Create: `src/modules/accounting/services/share/shareResolver.ts`

**Interfaces:**
- Consumes: `hashShareToken`, `isShareTokenShape` (Task 2); `SharePackParams` (Task 3); `checkRateLimit` from `@/lib/rateLimit`.
- Produces: `type ShareResolution = { status: 'ok'; link: ResolvedShareLink } | { status: 'expired' | 'revoked' | 'not_found' | 'rate_limited' }`, `resolveShareLink(token, ctx): Promise<ShareResolution>`, `interface ResolvedShareLink { id: string; companyId: string; params: SharePackParams }`.
- Consumed by: Tasks 6, 7.

- [ ] **Step 1: Write the resolver**

```ts
// src/modules/accounting/services/share/shareResolver.ts
/**
 * Resolving a share token, for callers with NO authenticated session.
 *
 * Three rules this file exists to enforce, in order:
 *  1. The company comes from the LINK ROW. Nothing this function returns is
 *     derived from the request, so a caller cannot steer it at another tenant.
 *  2. Expiry and revocation are checked here, on every view, in the same query
 *     that finds the row. Withdrawal is immediate.
 *  3. Every hit that matches a row is written to share_link_views, including a
 *     hit on a dead link — that record is how a withdrawn link being circulated
 *     becomes visible.
 *
 * Note this runs on the pool connection, which is a superuser and therefore
 * bypasses RLS. The company_id predicate carried by every downstream query IS
 * the tenancy control here; RLS is the second line, not the first.
 */
import { sql, type DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { checkRateLimit } from '@/lib/rateLimit';
import { hashShareToken, isShareTokenShape } from './shareToken';
import type { SharePackParams } from './shareParams';

export interface ResolvedShareLink {
  id: string;
  companyId: string;
  params: SharePackParams;
}

export type ShareResolution =
  | { status: 'ok'; link: ResolvedShareLink }
  | { status: 'expired' | 'revoked' | 'not_found' | 'rate_limited' };

export interface ShareViewContext {
  ip: string | null;
  userAgent: string | null;
}

const IP_MAX = 60;
const IP_WINDOW_SECS = 300;
const TOKEN_MAX = 120;
const TOKEN_WINDOW_SECS = 3600;

export async function resolveShareLink(token: unknown, ctx: ShareViewContext): Promise<ShareResolution> {
  if (!isShareTokenShape(token)) return { status: 'not_found' };

  const tokenHash = hashShareToken(token);

  // Two limits: per-IP bounds a scanner, per-token bounds one link being hammered.
  // Keyed on the HASH so no raw token reaches the rate-limit table.
  const ipKey = `share:ip:${ctx.ip ?? 'unknown'}`;
  const tokenKey = `share:token:${tokenHash}`;
  const [ipOk, tokenOk] = await Promise.all([
    checkRateLimit(ipKey, { max: IP_MAX, windowSecs: IP_WINDOW_SECS }),
    checkRateLimit(tokenKey, { max: TOKEN_MAX, windowSecs: TOKEN_WINDOW_SECS }),
  ]);
  if (!ipOk || !tokenOk) {
    log.warn('Share link rate limit', { ip: ctx.ip, perIp: !ipOk, perToken: !tokenOk }, 'share');
    return { status: 'rate_limited' };
  }

  const rows = (await sql`
    SELECT id, company_id, params, expires_at, revoked_at
    FROM share_links
    WHERE token_hash = ${tokenHash}
    LIMIT 1
  `) as DbRow[];

  const row = rows[0];
  if (!row) {
    log.warn('Share link not found', { ip: ctx.ip }, 'share');
    return { status: 'not_found' };
  }

  const linkId = String(row.id);
  const companyId = String(row.company_id);

  if (row.revoked_at) {
    await recordShareView(companyId, linkId, 'revoked', ctx);
    log.warn('Revoked share link presented', { companyId, shareLinkId: linkId, ip: ctx.ip }, 'share');
    return { status: 'revoked' };
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await recordShareView(companyId, linkId, 'expired', ctx);
    return { status: 'expired' };
  }

  await recordShareView(companyId, linkId, 'ok', ctx);
  await sql`
    UPDATE share_links
    SET view_count = view_count + 1, last_viewed_at = NOW()
    WHERE id = ${linkId}::uuid AND company_id = ${companyId}::uuid
  `;
  log.info('Share link viewed', { companyId, shareLinkId: linkId }, 'share');

  return { status: 'ok', link: { id: linkId, companyId, params: row.params as SharePackParams } };
}

export async function recordShareView(
  companyId: string,
  shareLinkId: string,
  outcome: 'ok' | 'expired' | 'revoked',
  ctx: ShareViewContext,
): Promise<void> {
  await sql`
    INSERT INTO share_link_views (company_id, share_link_id, outcome, ip_address, user_agent)
    VALUES (${companyId}::uuid, ${shareLinkId}::uuid, ${outcome}, ${ctx.ip}, ${ctx.userAgent})
  `;
}
```

- [ ] **Step 2: Type-check**

Run: `bun run type-check`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/modules/accounting/services/share/shareResolver.ts
git commit -m "feat(share): resolve a token to its company, enforcing expiry, revocation and rate limits"
```

---

### Task 6: `sharedPackService.ts` — the pack a link renders

**Files:**
- Create: `src/modules/accounting/services/share/sharedPackService.ts`

**Interfaces:**
- Consumes: `ResolvedShareLink` (Task 5); `getFinancialFigures`, `unclassifiedWarning`, `totalEquity` from `@/modules/accounting/services/gl/financialFiguresService`; `buildReportPack`, `type ReportPackInput` from `@/modules/accounting/services/reports/reportPackService`; `canonicalParamsHash` (Task 3).
- Produces: `buildSharedPack(link: ResolvedShareLink): Promise<SharedPack>`, `interface SharedPack { companyName: string; period: { from: string; to: string }; pack: ReportPack; commentary: PublishedCommentary[] }`, `interface PublishedCommentary { sectionRef: string; rowRef: string; text: string }`.
- Consumed by: Task 7. Task 8 creates the `report_commentary` table this reads; until Task 8 lands, `loadApprovedCommentary` returns `[]` because the table does not exist — so **Task 8's migration is a prerequisite for running this file**. Implement Task 8's migration first if you are executing out of order.

- [ ] **Step 1: Write the service**

```ts
// src/modules/accounting/services/share/sharedPackService.ts
/**
 * Builds exactly what a share link renders.
 *
 * Same builder as the authenticated route (pages/api/accounting/reports-pack.ts)
 * so a shared pack and an on-screen pack cannot drift: one figure source, one
 * assembler. What differs is the commentary query, which selects approved_text
 * and filters on status = 'approved'. A draft has no path into this function's
 * return value — not a hidden field, not a flag the caller could flip.
 */
import { sql, type DbRow } from '@/lib/neon';
import {
  getFinancialFigures, unclassifiedWarning, totalEquity,
} from '@/modules/accounting/services/gl/financialFiguresService';
import {
  buildReportPack, type ReportPack, type ReportPackInput,
} from '@/modules/accounting/services/reports/reportPackService';
import { canonicalParamsHash } from './shareParams';
import type { ResolvedShareLink } from './shareResolver';

export interface PublishedCommentary {
  sectionRef: string;
  rowRef: string;
  text: string;
}

export interface SharedPack {
  companyName: string;
  period: { from: string; to: string };
  pack: ReportPack;
  commentary: PublishedCommentary[];
  unclassifiedAccounts: ReturnType<typeof unclassifiedWarning>;
}

/** APPROVED TEXT ONLY. The status filter and the column are both required:
 *  the column is empty until an approval writes it, and the status filter stops
 *  a withdrawn approval (status moved back to 'draft') still being served. */
async function loadApprovedCommentary(companyId: string, paramsHash: string): Promise<PublishedCommentary[]> {
  const rows = (await sql`
    SELECT section_ref, row_ref, approved_text
    FROM report_commentary
    WHERE company_id = ${companyId}::uuid
      AND report_kind = 'pack'
      AND params_hash = ${paramsHash}
      AND status = 'approved'
      AND approved_text IS NOT NULL
    ORDER BY section_ref, row_ref
  `) as DbRow[];
  return rows.map(r => ({
    sectionRef: String(r.section_ref),
    rowRef: String(r.row_ref),
    text: String(r.approved_text),
  }));
}

async function getCompanyName(companyId: string): Promise<string> {
  const rows = (await sql`SELECT name FROM companies WHERE id = ${companyId}::uuid LIMIT 1`) as DbRow[];
  return rows[0] ? String(rows[0]!.name) : 'Company';
}

export async function buildSharedPack(link: ResolvedShareLink): Promise<SharedPack> {
  const { companyId, params } = link;
  const [figures, companyName, commentary] = await Promise.all([
    getFinancialFigures(companyId, params.from, params.to),
    getCompanyName(companyId),
    loadApprovedCommentary(companyId, canonicalParamsHash(params)),
  ]);

  const { period, cumulative } = figures;
  const input: ReportPackInput = {
    companyName,
    period: `${params.from} to ${params.to}`,
    revenue: period.revenue,
    costOfSales: period.costOfSales,
    operatingExpenses: period.operatingExpenses,
    netProfit: period.netProfit,
    totalAssets: cumulative.totalAssets,
    totalLiabilities: cumulative.totalLiabilities,
    totalEquity: totalEquity(figures),
    currentAssets: cumulative.currentAssets,
    currentLiabilities: cumulative.currentLiabilities,
    cash: cumulative.cash,
    accountsReceivable: cumulative.accountsReceivable,
    accountsPayable: cumulative.accountsPayable,
    inventory: cumulative.inventory,
    otherIncome: period.otherIncome,
    otherExpenses: period.otherExpenses,
  };

  return {
    companyName,
    period: { from: params.from, to: params.to },
    pack: buildReportPack(params.type, input, params.from, params.to),
    commentary,
    unclassifiedAccounts: unclassifiedWarning(cumulative),
  };
}
```

- [ ] **Step 2: Type-check**

Run: `bun run type-check`
Expected: clean. If `report_commentary` does not exist yet, type-check still passes (SQL is not checked); the runtime failure appears in Task 13's integration test.

- [ ] **Step 3: Commit**

```bash
git add src/modules/accounting/services/share/sharedPackService.ts
git commit -m "feat(share): build a shared pack from the link's own company and approved text only"
```

---

### Task 7: `pages/share/[token].tsx` — the public page

**Files:**
- Create: `pages/share/[token].tsx`
- Create: `src/components/accounting/share/SharedPackView.tsx`

**Interfaces:**
- Consumes: `resolveShareLink` (Task 5), `buildSharedPack` + `SharedPack` (Task 6); `ManagementPandLRows`, `ManagementBalanceSheetRows` from `@/components/accounting/ManagementPandLRows`; `packToTotals`, `packToMargins`, `packToBsTotals`, `packToBsDetail` from `@/modules/accounting/services/reports/statementRows/packMappers`; `formatMoney` from `@/lib/format/money`.
- Produces: the public route `/share/<token>`.

- [ ] **Step 1: Write the view component**

```tsx
// src/components/accounting/share/SharedPackView.tsx
/**
 * Read-only pack, rendered for someone with no session. No AppLayout, no nav,
 * no links back into the app, no annotations, no draft commentary — the props
 * this component accepts cannot express any of those.
 */
import { Fragment } from 'react';
import { formatMoney } from '@/lib/format/money';
import { ManagementPandLRows, ManagementBalanceSheetRows } from '@/components/accounting/ManagementPandLRows';
import {
  packToTotals, packToMargins, packToBsTotals, packToBsDetail,
} from '@/modules/accounting/services/reports/statementRows/packMappers';
import type { SharedPack, PublishedCommentary } from '@/modules/accounting/services/share/sharedPackService';

function CommentaryFor({ sectionRef, commentary }: { sectionRef: string; commentary: PublishedCommentary[] }) {
  const notes = commentary.filter(c => c.sectionRef === sectionRef);
  if (notes.length === 0) return null;
  return (
    <div className="mt-3 space-y-1">
      {notes.map(n => (
        <p key={`${n.sectionRef}:${n.rowRef}`} className="text-sm leading-relaxed text-[var(--ff-text-secondary)]">
          {n.text}
        </p>
      ))}
    </div>
  );
}

export function SharedPackView({ data }: { data: SharedPack }) {
  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      <header className="mb-8 border-b border-[var(--ff-border-light)] pb-4">
        <h1 className="text-2xl font-semibold text-[var(--ff-text-primary)]">{data.companyName}</h1>
        <p className="text-sm text-[var(--ff-text-tertiary)]">
          {data.pack.type.charAt(0).toUpperCase() + data.pack.type.slice(1)} pack · {data.period.from} to {data.period.to}
        </p>
      </header>

      {data.pack.sections.map(section => (
        <section key={section.type} className="mb-8" data-section={section.type}>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-[var(--ff-text-tertiary)]">
            {section.title}
          </h2>
          {section.type === 'income_statement' && (
            <Fragment>
              <ManagementPandLRows is={packToTotals(section.data)} />
              <p className="mt-2 text-xs text-[var(--ff-text-tertiary)]">
                Gross margin {packToMargins(section.data).grossMargin.toFixed(1)}% ·
                {' '}Net margin {packToMargins(section.data).netMargin.toFixed(1)}%
              </p>
            </Fragment>
          )}
          {section.type === 'balance_sheet' && (
            <ManagementBalanceSheetRows bs={packToBsTotals(section.data)} detail={packToBsDetail(section.data)} />
          )}
          {section.type !== 'income_statement' && section.type !== 'balance_sheet' && (
            <dl className="grid grid-cols-2 gap-2 text-sm md:grid-cols-3">
              {Object.entries(section.data)
                .filter(([, v]) => typeof v === 'number')
                .map(([k, v]) => (
                  <div key={k} className="rounded border border-[var(--ff-border-light)] p-2">
                    <dt className="text-xs text-[var(--ff-text-tertiary)]">{k}</dt>
                    <dd className="tabular-nums text-[var(--ff-text-primary)]">{formatMoney(v as number)}</dd>
                  </div>
                ))}
            </dl>
          )}
          <CommentaryFor sectionRef={section.type} commentary={data.commentary} />
        </section>
      ))}

      <footer className="mt-10 border-t border-[var(--ff-border-light)] pt-4 text-xs text-[var(--ff-text-tertiary)]">
        Shared read-only from IsaFlow. This link expires and can be withdrawn at any time.
      </footer>
    </main>
  );
}
```

- [ ] **Step 2: Write the page**

```tsx
// pages/share/[token].tsx
/**
 * Public share page. No login, no cookie, no company in the URL beyond the
 * token. getServerSideProps does all the work so nothing about the link or the
 * company reaches the client bundle except the rendered pack.
 */
import type { GetServerSideProps, NextApiRequest } from 'next';
import Head from 'next/head';
import { resolveShareLink } from '@/modules/accounting/services/share/shareResolver';
import { buildSharedPack, type SharedPack } from '@/modules/accounting/services/share/sharedPackService';
import { SharedPackView } from '@/components/accounting/share/SharedPackView';

type PageProps = { state: 'ok'; data: SharedPack } | { state: 'expired' | 'revoked' | 'rate_limited' };

const MESSAGES: Record<'expired' | 'revoked' | 'rate_limited', string> = {
  expired: 'This link has expired. Ask the sender for a new one.',
  revoked: 'This link has been withdrawn.',
  rate_limited: 'Too many requests. Try again in a few minutes.',
};

export default function SharePage(props: PageProps) {
  if (props.state !== 'ok') {
    return (
      <>
        <Head><title>Link unavailable</title><meta name="robots" content="noindex,nofollow" /></Head>
        <main className="mx-auto max-w-md px-4 py-24 text-center">
          <h1 className="text-lg font-medium text-[var(--ff-text-primary)]">Link unavailable</h1>
          <p className="mt-2 text-sm text-[var(--ff-text-secondary)]">{MESSAGES[props.state]}</p>
        </main>
      </>
    );
  }
  return (
    <>
      <Head>
        <title>{`${props.data.companyName} — ${props.data.pack.type} pack`}</title>
        <meta name="robots" content="noindex,nofollow" />
      </Head>
      <SharedPackView data={props.data} />
    </>
  );
}

function clientIp(req: NextApiRequest['headers'] extends never ? never : { headers: Record<string, string | string[] | undefined>; socket: { remoteAddress?: string } }): string | null {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length) return xf.split(',')[0]!.trim();
  if (Array.isArray(xf) && xf[0]) return xf[0]!.split(',')[0]!.trim();
  return req.socket.remoteAddress ?? null;
}

export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  // noindex is also sent as a header so a crawler that ignores the meta tag
  // still sees it on a 200.
  ctx.res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  ctx.res.setHeader('Cache-Control', 'no-store, private');

  const ua = ctx.req.headers['user-agent'];
  const resolution = await resolveShareLink(ctx.params?.token, {
    ip: clientIp(ctx.req as never),
    userAgent: typeof ua === 'string' ? ua.slice(0, 400) : null,
  });

  if (resolution.status === 'not_found') return { notFound: true };
  if (resolution.status !== 'ok') return { props: { state: resolution.status } };

  return { props: { state: 'ok', data: JSON.parse(JSON.stringify(await buildSharedPack(resolution.link))) as SharedPack } };
};
```

- [ ] **Step 3: Type-check and route-check**

Run: `bun run type-check && bun run check:routes`
Expected: clean. If the `clientIp` parameter type above is awkward under strict mode, replace its signature with `(req: { headers: Record<string, string | string[] | undefined>; socket: { remoteAddress?: string } })` and drop the `NextApiRequest` import — do not reach for `any`.

- [ ] **Step 4: Commit**

```bash
git add pages/share/\[token\].tsx src/components/accounting/share/SharedPackView.tsx
git commit -m "feat(share): public read-only pack page resolved from the link alone"
```

---

### Task 8: Migration 611 — `report_commentary` and `report_annotations`

**Files:**
- Create: `scripts/migrations/sql/611_report_commentary.sql`

**Interfaces:**
- Produces: tables `report_commentary` and `report_annotations`, both `company_id`-scoped with RLS. Read by Task 6, written by Tasks 9 and 11.

- [ ] **Step 1: Re-verify the prefix** (same two commands as Task 1; `611` must still be free).

- [ ] **Step 2: Write the migration**

```sql
-- scripts/migrations/sql/611_report_commentary.sql
-- WS3: AI commentary as a draft until a named user approves it, plus internal
-- row annotations.
--
-- draft_text and approved_text are SEPARATE COLUMNS on purpose. A single `text`
-- column plus a status flag makes "publish only approved text" a filter that
-- every future reader must remember to apply; two columns make it structural —
-- the share loader selects approved_text and there is no draft in the result to
-- forget to exclude.
--
-- row_ref is NOT NULL DEFAULT '' rather than nullable so the uniqueness key is
-- a plain unique index. A nullable column in a unique index does not collide
-- with itself in Postgres, and the expression-index workaround then forces
-- every ON CONFLICT to reproduce the expression exactly — a trap this schema
-- does not need to walk into for one optional field.
--
-- params_hash is sha256(type|from|to) computed by
-- src/modules/accounting/services/share/shareParams.ts. Storing the hash rather
-- than the three fields keeps the uniqueness key one column and lets a future
-- report kind with different parameters reuse the table unchanged.

CREATE TABLE IF NOT EXISTS report_commentary (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id),
  report_kind   TEXT NOT NULL,
  params_hash   TEXT NOT NULL,
  period_start  DATE NOT NULL,
  period_end    DATE NOT NULL,
  section_ref   TEXT NOT NULL,
  row_ref       TEXT NOT NULL DEFAULT '',
  draft_text    TEXT NOT NULL,
  approved_text TEXT,
  status        TEXT NOT NULL DEFAULT 'draft',
  generated_by  TEXT NOT NULL,
  approved_by   TEXT,
  approved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT report_commentary_status_chk CHECK (status IN ('draft', 'approved', 'rejected')),
  -- An approved row must carry both the text and the approver. This is the
  -- invariant the share loader depends on; enforce it in the schema, not only
  -- in the service.
  CONSTRAINT report_commentary_approved_chk CHECK (
    status <> 'approved'
    OR (approved_text IS NOT NULL AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_report_commentary_ref
  ON report_commentary (company_id, report_kind, params_hash, section_ref, row_ref);

CREATE INDEX IF NOT EXISTS idx_report_commentary_published
  ON report_commentary (company_id, params_hash, status);

CREATE TABLE IF NOT EXISTS report_annotations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id),
  row_id        TEXT NOT NULL,
  period_start  DATE NOT NULL,
  period_end    DATE NOT NULL,
  body          TEXT NOT NULL,
  author        TEXT NOT NULL,
  author_name   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at   TIMESTAMPTZ,
  resolved_by   TEXT
);

CREATE INDEX IF NOT EXISTS idx_report_annotations_row
  ON report_annotations (company_id, row_id, period_start, period_end);

ALTER TABLE report_commentary ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_commentary FORCE ROW LEVEL SECURITY;
ALTER TABLE report_annotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_annotations FORCE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['report_commentary', 'report_annotations'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t AND policyname = 'tenant_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON public.%I TO app_user '
        'USING (company_id IN (SELECT auth.user_companies())) '
        'WITH CHECK (company_id = app.current_company_id())', t);
    END IF;
  END LOOP;
END $$;
```

- [ ] **Step 3: Apply and prove**

```bash
bun run db:migrate
psql "$DATABASE_URL" -c "SELECT tablename, policyname FROM pg_policies WHERE tablename IN ('report_commentary','report_annotations')"
```
Expected: two `tenant_isolation` rows.

Prove the approved-row constraint bites:
```bash
psql "$DATABASE_URL" -c "INSERT INTO report_commentary (company_id, report_kind, params_hash, period_start, period_end, section_ref, draft_text, status, generated_by) SELECT id, 'pack', 'x', '2026-03-01', '2026-08-31', 's', 'd', 'approved', 'u' FROM companies LIMIT 1"
```
Expected: `ERROR: new row for relation "report_commentary" violates check constraint "report_commentary_approved_chk"`.

- [ ] **Step 4: Commit**

```bash
git add scripts/migrations/sql/611_report_commentary.sql
git commit -m "feat(commentary): draft/approved commentary and internal annotations, tenant-isolated"
```

---

### Task 9: The commentary state machine

**Files:**
- Create: `src/modules/accounting/services/commentary/commentaryState.ts`
- Test: `tests/unit/services/commentary/commentaryState.test.ts`

**Interfaces:**
- Produces: `type CommentaryStatus = 'draft' | 'approved' | 'rejected'`, `type CommentaryAction = 'generate' | 'regenerate' | 'approve' | 'reject'`, `type Transition = { ok: true; next: CommentaryStatus; clearsApproval: boolean } | { ok: false; reason: string }`, `nextStatus(current: CommentaryStatus | null, action: CommentaryAction): Transition`.
- Consumed by: Task 10.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/services/commentary/commentaryState.test.ts
import { describe, it, expect } from 'vitest';
import { nextStatus } from '@/modules/accounting/services/commentary/commentaryState';

describe('nextStatus', () => {
  it('creates a draft when nothing exists', () => {
    expect(nextStatus(null, 'generate')).toEqual({ ok: true, next: 'draft', clearsApproval: false });
  });

  it('approves a draft', () => {
    expect(nextStatus('draft', 'approve')).toEqual({ ok: true, next: 'approved', clearsApproval: false });
  });

  it('rejects a draft', () => {
    expect(nextStatus('draft', 'reject')).toEqual({ ok: true, next: 'rejected', clearsApproval: false });
  });

  it('re-drafts a rejected row', () => {
    expect(nextStatus('rejected', 'generate')).toEqual({ ok: true, next: 'draft', clearsApproval: false });
  });

  it('refuses to silently overwrite approved text with a new draft', () => {
    const t = nextStatus('approved', 'generate');
    expect(t.ok).toBe(false);
    if (!t.ok) expect(t.reason).toContain('approved');
  });

  it('withdraws an approval only under the explicit regenerate action, and says so', () => {
    expect(nextStatus('approved', 'regenerate')).toEqual({ ok: true, next: 'draft', clearsApproval: true });
  });

  it('refuses to approve twice, so a second approver cannot overwrite the first', () => {
    expect(nextStatus('approved', 'approve').ok).toBe(false);
  });

  it('refuses to approve a rejected row', () => {
    expect(nextStatus('rejected', 'approve').ok).toBe(false);
  });

  it('refuses to reject anything that is not a draft', () => {
    expect(nextStatus('approved', 'reject').ok).toBe(false);
    expect(nextStatus('rejected', 'reject').ok).toBe(false);
    expect(nextStatus(null, 'reject').ok).toBe(false);
  });

  it('refuses to approve a row that does not exist', () => {
    expect(nextStatus(null, 'approve').ok).toBe(false);
  });

  it('refuses regenerate on a draft — there is no approval to withdraw', () => {
    expect(nextStatus('draft', 'regenerate').ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/vitest run tests/unit/services/commentary/commentaryState.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement**

```ts
// src/modules/accounting/services/commentary/commentaryState.ts
/**
 * The only place a commentary status changes.
 *
 * The rule this encodes: text that a named person approved is not replaced by
 * a machine without a second, explicit human act. `generate` on an approved row
 * FAILS; `regenerate` succeeds and returns clearsApproval, which the caller
 * turns into approved_text = NULL. So an approved sentence is either still on
 * the share link or was deliberately withdrawn — it is never quietly swapped
 * for a newer one the approver has not read.
 */
export type CommentaryStatus = 'draft' | 'approved' | 'rejected';
export type CommentaryAction = 'generate' | 'regenerate' | 'approve' | 'reject';

export type Transition =
  | { ok: true; next: CommentaryStatus; clearsApproval: boolean }
  | { ok: false; reason: string };

export function nextStatus(current: CommentaryStatus | null, action: CommentaryAction): Transition {
  switch (action) {
    case 'generate':
      if (current === 'approved') {
        return { ok: false, reason: 'This commentary is approved. Use regenerate to withdraw the approval first.' };
      }
      return { ok: true, next: 'draft', clearsApproval: false };

    case 'regenerate':
      if (current !== 'approved') {
        return { ok: false, reason: 'Nothing to withdraw: this commentary is not approved.' };
      }
      return { ok: true, next: 'draft', clearsApproval: true };

    case 'approve':
      if (current !== 'draft') {
        return { ok: false, reason: `Only a draft can be approved (this one is ${current ?? 'missing'}).` };
      }
      return { ok: true, next: 'approved', clearsApproval: false };

    case 'reject':
      if (current !== 'draft') {
        return { ok: false, reason: `Only a draft can be rejected (this one is ${current ?? 'missing'}).` };
      }
      return { ok: true, next: 'rejected', clearsApproval: false };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/vitest run tests/unit/services/commentary/commentaryState.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/accounting/services/commentary/commentaryState.ts tests/unit/services/commentary/commentaryState.test.ts
git commit -m "feat(commentary): the draft/approved/rejected state machine, as a pure function"
```

---

### Task 10: Draft generation, the commentary service, and its routes

**Files:**
- Create: `src/modules/accounting/services/commentary/commentaryDraft.ts`
- Create: `src/modules/accounting/services/commentary/commentaryService.ts`
- Create: `pages/api/accounting/commentary/index.ts`
- Create: `pages/api/accounting/commentary/[id]/approve.ts`
- Create: `pages/api/accounting/commentary/[id]/reject.ts`
- Test: `tests/unit/services/commentary/commentaryDraft.test.ts`

**Interfaces:**
- Consumes: `nextStatus`, `CommentaryStatus` (Task 9); `SharePackParams`, `canonicalParamsHash` (Task 3); `identifyKeyDrivers`, `assessRiskAreas`, `type ManagementPackData` from `@/modules/accounting/services/reports/aiCommentaryService`.
- Produces: `buildDraftSentences(data: ManagementPackData): DraftSentence[]` with `interface DraftSentence { sectionRef: string; rowRef: string; text: string }`; `generateDrafts`, `approveCommentary`, `rejectCommentary`, `listCommentary` in `commentaryService.ts`; `interface CommentaryRow`.
- Consumed by: Task 11 (`CommentaryBlock` renders `CommentaryRow[]`).

- [ ] **Step 1: Write the failing draft test**

```ts
// tests/unit/services/commentary/commentaryDraft.test.ts
import { describe, it, expect } from 'vitest';
import { buildDraftSentences } from '@/modules/accounting/services/commentary/commentaryDraft';
import type { ManagementPackData } from '@/modules/accounting/services/reports/aiCommentaryService';

const data: ManagementPackData = {
  companyName: 'Britech',
  period: '2026-03-01 to 2026-08-31',
  incomeStatement: { revenue: 1_000_000, costOfSales: 600_000, grossProfit: 400_000, operatingExpenses: 250_000, netProfit: 150_000 },
  balanceSheet: { totalAssets: 2_000_000, totalLiabilities: 800_000, equity: 1_200_000, currentRatio: 0.9, debtEquityRatio: 0.67 },
  priorPeriod: { revenue: 800_000, costOfSales: 500_000, grossProfit: 300_000, operatingExpenses: 220_000, netProfit: 80_000 },
  ratios: { grossMargin: 40, netMargin: 15, currentRatio: 0.9, quickRatio: 0.7 },
};

describe('buildDraftSentences', () => {
  it('files the biggest driver under the income statement section', () => {
    const s = buildDraftSentences(data);
    const is = s.filter(x => x.sectionRef === 'income_statement');
    expect(is.length).toBeGreaterThan(0);
    expect(is[0]!.text).toContain('Revenue');
    expect(is[0]!.rowRef).toBe('revenue');
  });

  it('files a liquidity risk under the balance sheet section', () => {
    const s = buildDraftSentences(data);
    const bs = s.filter(x => x.sectionRef === 'balance_sheet');
    expect(bs.some(x => x.text.includes('Current ratio') || x.text.includes('current ratio'))).toBe(true);
  });

  it('produces no prior-period sentences when there is no prior period', () => {
    const s = buildDraftSentences({ ...data, priorPeriod: undefined });
    expect(s.filter(x => x.sectionRef === 'income_statement')).toEqual([]);
  });

  it('never returns an empty sentence, and every sentence has a unique section+row key', () => {
    const s = buildDraftSentences(data);
    expect(s.every(x => x.text.trim().length > 0)).toBe(true);
    const keys = s.map(x => `${x.sectionRef}:${x.rowRef}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/vitest run tests/unit/services/commentary/commentaryDraft.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement the draft builder**

```ts
// src/modules/accounting/services/commentary/commentaryDraft.ts
/**
 * Turns the existing pure analysers in aiCommentaryService into placed
 * sentences: a sectionRef (which pack section the sentence sits under) and a
 * rowRef (which figure it explains), so the UI can print it directly beneath
 * that figure rather than in a side panel.
 *
 * This produces DRAFTS ONLY. Nothing here writes approved_text, and nothing
 * here reaches a share link until a person approves it in commentaryService.
 */
import {
  identifyKeyDrivers, assessRiskAreas, type ManagementPackData,
} from '@/modules/accounting/services/reports/aiCommentaryService';

export interface DraftSentence {
  sectionRef: string;
  rowRef: string;
  text: string;
}

const TOP_DRIVERS = 3;

export function buildDraftSentences(data: ManagementPackData): DraftSentence[] {
  const out: DraftSentence[] = [];

  if (data.priorPeriod) {
    for (const d of identifyKeyDrivers(data.incomeStatement, data.priorPeriod).slice(0, TOP_DRIVERS)) {
      out.push({ sectionRef: 'income_statement', rowRef: d.metric, text: `${d.explanation}.` });
    }
  }

  for (const r of assessRiskAreas(data)) {
    out.push({
      sectionRef: 'balance_sheet',
      rowRef: r.area.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
      text: `${r.description}.`,
    });
  }

  return out.filter(s => s.text.trim().length > 1);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/vitest run tests/unit/services/commentary/commentaryDraft.test.ts`
Expected: PASS (4 tests). If the liquidity assertion fails, read `assessRiskAreas` and align the expected substring with the wording it actually emits — do not weaken the assertion to `.length > 0`.

- [ ] **Step 5: Implement the service**

```ts
// src/modules/accounting/services/commentary/commentaryService.ts
/**
 * Persistence and approval for commentary. Every function is company-scoped;
 * the company_id predicate is on every statement, including the UPDATEs, so a
 * commentary id from another tenant matches zero rows rather than being
 * approved by someone who is not a member of its company.
 */
import { sql, type DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { nextStatus, type CommentaryStatus } from './commentaryState';
import { buildDraftSentences } from './commentaryDraft';
import type { ManagementPackData } from '@/modules/accounting/services/reports/aiCommentaryService';
import { canonicalParamsHash, type SharePackParams } from '@/modules/accounting/services/share/shareParams';

export interface CommentaryRow {
  id: string;
  sectionRef: string;
  rowRef: string;
  draftText: string;
  approvedText: string | null;
  status: CommentaryStatus;
  approvedBy: string | null;
  approvedAt: string | null;
}

function toRow(r: DbRow): CommentaryRow {
  return {
    id: String(r.id),
    sectionRef: String(r.section_ref),
    rowRef: String(r.row_ref),
    draftText: String(r.draft_text),
    approvedText: r.approved_text === null || r.approved_text === undefined ? null : String(r.approved_text),
    status: String(r.status) as CommentaryStatus,
    approvedBy: r.approved_by ? String(r.approved_by) : null,
    approvedAt: r.approved_at ? new Date(r.approved_at).toISOString() : null,
  };
}

export async function listCommentary(companyId: string, params: SharePackParams): Promise<CommentaryRow[]> {
  const rows = (await sql`
    SELECT * FROM report_commentary
    WHERE company_id = ${companyId}::uuid
      AND report_kind = 'pack'
      AND params_hash = ${canonicalParamsHash(params)}
    ORDER BY section_ref, row_ref
  `) as DbRow[];
  return rows.map(toRow);
}

/** Upserts one draft per sentence. `replace` maps to the regenerate action and
 *  is the ONLY way an approved row is re-drafted; without it an approved row is
 *  left exactly as it stands and reported in `skipped`. */
export async function generateDrafts(input: {
  companyId: string; userId: string; params: SharePackParams; data: ManagementPackData; replace?: boolean;
}): Promise<{ written: number; skipped: string[] }> {
  const hash = canonicalParamsHash(input.params);
  const existing = new Map(
    (await listCommentary(input.companyId, input.params)).map(r => [`${r.sectionRef}:${r.rowRef}`, r.status]),
  );

  let written = 0;
  const skipped: string[] = [];

  for (const s of buildDraftSentences(input.data)) {
    const key = `${s.sectionRef}:${s.rowRef}`;
    const current = existing.get(key) ?? null;
    const t = nextStatus(current, current === 'approved' && input.replace ? 'regenerate' : 'generate');
    if (!t.ok) { skipped.push(key); continue; }

    await sql`
      INSERT INTO report_commentary
        (company_id, report_kind, params_hash, period_start, period_end,
         section_ref, row_ref, draft_text, status, generated_by)
      VALUES
        (${input.companyId}::uuid, 'pack', ${hash}, ${input.params.from}::date, ${input.params.to}::date,
         ${s.sectionRef}, ${s.rowRef}, ${s.text}, 'draft', ${input.userId})
      ON CONFLICT (company_id, report_kind, params_hash, section_ref, row_ref)
      DO UPDATE SET
        draft_text = EXCLUDED.draft_text,
        status = 'draft',
        approved_text = CASE WHEN ${t.clearsApproval} THEN NULL ELSE report_commentary.approved_text END,
        approved_by = CASE WHEN ${t.clearsApproval} THEN NULL ELSE report_commentary.approved_by END,
        approved_at = CASE WHEN ${t.clearsApproval} THEN NULL ELSE report_commentary.approved_at END,
        generated_by = EXCLUDED.generated_by,
        updated_at = NOW()
    `;
    written += 1;
    if (t.clearsApproval) {
      log.info('Commentary approval withdrawn by regeneration', {
        companyId: input.companyId, userId: input.userId, sectionRef: s.sectionRef, rowRef: s.rowRef,
      }, 'commentary');
    }
  }

  log.info('Commentary drafts generated', {
    companyId: input.companyId, userId: input.userId, written, skipped: skipped.length,
  }, 'commentary');
  return { written, skipped };
}

async function currentStatus(companyId: string, id: string): Promise<CommentaryStatus | null> {
  const rows = (await sql`
    SELECT status FROM report_commentary WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid LIMIT 1
  `) as DbRow[];
  return rows[0] ? (String(rows[0].status) as CommentaryStatus) : null;
}

export async function approveCommentary(companyId: string, id: string, userId: string): Promise<
  { ok: true; row: CommentaryRow } | { ok: false; reason: string }
> {
  const t = nextStatus(await currentStatus(companyId, id), 'approve');
  if (!t.ok) return t;

  const rows = (await sql`
    UPDATE report_commentary
    SET status = 'approved', approved_text = draft_text, approved_by = ${userId}, approved_at = NOW(), updated_at = NOW()
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid AND status = 'draft'
    RETURNING *
  `) as DbRow[];
  // status = 'draft' in the WHERE, not only in the check above: two approvals
  // racing must not both write, and the second one finds no row.
  if (!rows[0]) return { ok: false, reason: 'This commentary is no longer a draft.' };

  log.info('Commentary approved', { companyId, userId, commentaryId: id }, 'commentary');
  return { ok: true, row: toRow(rows[0]) };
}

export async function rejectCommentary(companyId: string, id: string, userId: string): Promise<
  { ok: true; row: CommentaryRow } | { ok: false; reason: string }
> {
  const t = nextStatus(await currentStatus(companyId, id), 'reject');
  if (!t.ok) return t;

  const rows = (await sql`
    UPDATE report_commentary
    SET status = 'rejected', updated_at = NOW()
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid AND status = 'draft'
    RETURNING *
  `) as DbRow[];
  if (!rows[0]) return { ok: false, reason: 'This commentary is no longer a draft.' };

  log.info('Commentary rejected', { companyId, userId, commentaryId: id }, 'commentary');
  return { ok: true, row: toRow(rows[0]) };
}
```

- [ ] **Step 6: Write the three routes**

```ts
// pages/api/accounting/commentary/index.ts
/**
 * GET  /api/accounting/commentary?type=&from=&to=   — drafts and approvals for a pack
 * POST /api/accounting/commentary                   — generate drafts (never approves)
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { parseSharePackParams } from '@/modules/accounting/services/share/shareParams';
import { listCommentary, generateDrafts } from '@/modules/accounting/services/commentary/commentaryService';
import { buildManagementPackData } from '@/modules/accounting/services/commentary/packData';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, user } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const params = parseSharePackParams({ type: req.query.type, from: req.query.from, to: req.query.to });
    if (!params) return apiResponse.badRequest(res, 'type, from and to are required');
    return apiResponse.success(res, { commentary: await listCommentary(companyId, params) });
  }

  if (req.method === 'POST') {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const params = parseSharePackParams(body.params);
    if (!params) return apiResponse.badRequest(res, 'params must be { type, from, to }');
    const data = await buildManagementPackData(companyId, params);
    const result = await generateDrafts({
      companyId, userId: user.id, params, data, replace: body.replace === true,
    });
    return apiResponse.success(res, result);
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
```

`buildManagementPackData` is a small companion in `src/modules/accounting/services/commentary/packData.ts` that calls `getFinancialFigures` and shapes a `ManagementPackData`; write it alongside, mirroring the field mapping in `sharedPackService.buildSharedPack` and using `calculateExtendedRatios` from `@/modules/accounting/services/reports/reportingEngineService` for the `ratios` block. It has no branching worth its own test; the integration test in Task 13 exercises it.

```ts
// pages/api/accounting/commentary/[id]/approve.ts
/** POST — copies draft_text to approved_text under a named approver. */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { approveCommentary } from '@/modules/accounting/services/commentary/commentaryService';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  const { companyId, user } = req as CompanyAuthedRequest;
  const id = req.query.id;
  if (typeof id !== 'string' || !UUID.test(id)) return apiResponse.notFound(res, 'Commentary');
  const result = await approveCommentary(companyId, id, user.id);
  if (!result.ok) return apiResponse.conflict(res, result.reason);
  return apiResponse.success(res, { commentary: result.row });
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
```

`pages/api/accounting/commentary/[id]/reject.ts` is the same file with `approveCommentary` replaced by `rejectCommentary` and the success key unchanged. Write it out in full; do not import one from the other.

- [ ] **Step 7: Type-check, route-check, commit**

```bash
bun run type-check && bun run check:routes
git add src/modules/accounting/services/commentary pages/api/accounting/commentary tests/unit/services/commentary/commentaryDraft.test.ts
git commit -m "feat(commentary): drafts from the existing analysers, approval under a named user"
```

---

### Task 11: `CommentaryBlock` — the inline placement

**Files:**
- Create: `src/components/accounting/commentary/CommentaryBlock.tsx`
- Test: `tests/unit/components/commentary/CommentaryBlock.test.tsx`

**Interfaces:**
- Consumes: `CommentaryRow` (Task 10).
- Produces: `<CommentaryBlock sectionRef rows mode onApprove? onReject? />` with `mode: 'internal' | 'published'`.

- [ ] **Step 1: Write the failing test**

```tsx
// tests/unit/components/commentary/CommentaryBlock.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CommentaryBlock } from '@/components/accounting/commentary/CommentaryBlock';
import type { CommentaryRow } from '@/modules/accounting/services/commentary/commentaryService';

const rows: CommentaryRow[] = [
  { id: 'a', sectionRef: 'income_statement', rowRef: 'revenue', draftText: 'DRAFT REVENUE SENTENCE',
    approvedText: null, status: 'draft', approvedBy: null, approvedAt: null },
  { id: 'b', sectionRef: 'income_statement', rowRef: 'netProfit', draftText: 'OLD DRAFT',
    approvedText: 'APPROVED PROFIT SENTENCE', status: 'approved', approvedBy: 'u1', approvedAt: '2026-09-01T00:00:00Z' },
  { id: 'c', sectionRef: 'balance_sheet', rowRef: 'liquidity', draftText: 'OTHER SECTION',
    approvedText: null, status: 'draft', approvedBy: null, approvedAt: null },
];

describe('CommentaryBlock in published mode', () => {
  it('renders approved text only, never a draft', () => {
    render(<CommentaryBlock sectionRef="income_statement" rows={rows} mode="published" />);
    expect(screen.getByText('APPROVED PROFIT SENTENCE')).toBeTruthy();
    expect(screen.queryByText('DRAFT REVENUE SENTENCE')).toBeNull();
    expect(screen.queryByText('OLD DRAFT')).toBeNull();
  });

  it('renders nothing at all when the section has no approved text', () => {
    const { container } = render(
      <CommentaryBlock sectionRef="balance_sheet" rows={rows} mode="published" />,
    );
    expect(container.textContent).toBe('');
  });

  it('shows no approve or reject control', () => {
    render(<CommentaryBlock sectionRef="income_statement" rows={rows} mode="published" onApprove={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
  });
});

describe('CommentaryBlock in internal mode', () => {
  it('shows the draft with an unpublished badge and an approve control', () => {
    render(<CommentaryBlock sectionRef="income_statement" rows={rows} mode="internal" onApprove={vi.fn()} onReject={vi.fn()} />);
    expect(screen.getByText('DRAFT REVENUE SENTENCE')).toBeTruthy();
    expect(screen.getByText(/not published/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /approve/i })).toBeTruthy();
  });

  it('shows approved text rather than the stale draft on an approved row', () => {
    render(<CommentaryBlock sectionRef="income_statement" rows={rows} mode="internal" onApprove={vi.fn()} />);
    expect(screen.getByText('APPROVED PROFIT SENTENCE')).toBeTruthy();
    expect(screen.queryByText('OLD DRAFT')).toBeNull();
  });

  it('does not show an approve control on an already-approved row', () => {
    render(<CommentaryBlock sectionRef="income_statement" rows={[rows[1]!]} mode="internal" onApprove={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
  });

  it('calls onApprove with the row id', () => {
    const onApprove = vi.fn();
    render(<CommentaryBlock sectionRef="income_statement" rows={[rows[0]!]} mode="internal" onApprove={onApprove} />);
    screen.getByRole('button', { name: /approve/i }).click();
    expect(onApprove).toHaveBeenCalledWith('a');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/vitest run --config vitest.components.config.ts tests/unit/components/commentary/CommentaryBlock.test.tsx`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement**

```tsx
// src/components/accounting/commentary/CommentaryBlock.tsx
/**
 * Commentary printed directly under the figure it explains.
 *
 * `mode` is the whole safety story. In 'published' the component reads
 * approvedText and there is no code path to draftText — not a conditional, an
 * absent branch. The share page and the PDF pass 'published'; the app passes
 * 'internal', which adds the draft, the badge and the approve/reject controls.
 */
import type { CommentaryRow } from '@/modules/accounting/services/commentary/commentaryService';

export interface CommentaryBlockProps {
  sectionRef: string;
  rows: CommentaryRow[];
  mode: 'internal' | 'published';
  onApprove?: (id: string) => void;
  onReject?: (id: string) => void;
}

function PublishedList({ rows }: { rows: CommentaryRow[] }) {
  const published = rows.filter(r => r.status === 'approved' && r.approvedText !== null);
  if (published.length === 0) return null;
  return (
    <div className="mt-3 space-y-1" data-commentary="published">
      {published.map(r => (
        <p key={r.id} className="text-sm leading-relaxed text-[var(--ff-text-secondary)]">{r.approvedText}</p>
      ))}
    </div>
  );
}

export function CommentaryBlock({ sectionRef, rows, mode, onApprove, onReject }: CommentaryBlockProps) {
  const mine = rows.filter(r => r.sectionRef === sectionRef && r.status !== 'rejected');
  if (mine.length === 0) return null;
  if (mode === 'published') return <PublishedList rows={mine} />;

  return (
    <div className="mt-3 space-y-2" data-commentary="internal">
      {mine.map(r => {
        const approved = r.status === 'approved' && r.approvedText !== null;
        return (
          <div key={r.id} className="flex items-start gap-2">
            <p className="flex-1 text-sm leading-relaxed text-[var(--ff-text-secondary)]">
              {approved ? r.approvedText : r.draftText}
            </p>
            {!approved && (
              <span className="shrink-0 rounded bg-[var(--ff-bg-tertiary)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--ff-text-tertiary)]">
                Draft — not published
              </span>
            )}
            {!approved && onApprove && (
              <button type="button" onClick={() => onApprove(r.id)}
                className="shrink-0 rounded border border-[var(--ff-border-light)] px-2 py-0.5 text-xs text-[var(--ff-text-secondary)] hover:border-[var(--ff-brand-500)]">
                Approve
              </button>
            )}
            {!approved && onReject && (
              <button type="button" onClick={() => onReject(r.id)}
                className="shrink-0 rounded border border-[var(--ff-border-light)] px-2 py-0.5 text-xs text-[var(--ff-text-tertiary)] hover:border-[var(--ff-unfav)]">
                Reject
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/vitest run --config vitest.components.config.ts tests/unit/components/commentary/CommentaryBlock.test.tsx`
Expected: PASS (8 tests).

- [ ] **Step 5: Mutation proof**

Change `PublishedList`'s `r.approvedText` to `r.draftText`, re-run, and confirm the first published-mode test goes red. Revert.

- [ ] **Step 6: Commit**

```bash
git add src/components/accounting/commentary/CommentaryBlock.tsx tests/unit/components/commentary/CommentaryBlock.test.tsx
git commit -m "feat(commentary): inline block that cannot render a draft in published mode"
```

---

### Task 12: Annotations — service, routes, `StatementRow.note`, UI

**Files:**
- Create: `src/modules/accounting/services/annotations/annotationService.ts`
- Create: `pages/api/accounting/annotations/index.ts`
- Create: `pages/api/accounting/annotations/[id]/resolve.ts`
- Create: `src/components/accounting/annotations/attachNotes.ts`
- Create: `src/components/accounting/annotations/NoteMarker.tsx`
- Create: `src/components/accounting/annotations/AnnotationThread.tsx`
- Modify: `src/modules/accounting/services/reports/statementRows/statementModel.ts` (additive)
- Modify: `src/components/accounting/statement/StatementRowView.tsx` (additive)
- Modify: `src/components/accounting/statement/StatementGrid.tsx` (additive)
- Test: `tests/unit/services/annotations/attachNotes.test.ts`, `tests/unit/components/annotations/NoteMarker.test.tsx`

**Interfaces:**
- Produces: `interface Annotation { id; rowId; periodStart; periodEnd; body; author; authorName; createdAt; resolvedAt }`, `createAnnotation`, `listAnnotations`, `resolveAnnotation`; `attachNotes(rows: StatementRow[], annotations: Annotation[]): StatementRow[]`; `interface StatementRowNote { count: number; hasOpen: boolean }`.

- [ ] **Step 1: Write the failing `attachNotes` test**

```ts
// tests/unit/services/annotations/attachNotes.test.ts
import { describe, it, expect } from 'vitest';
import { attachNotes } from '@/components/accounting/annotations/attachNotes';
import type { StatementRow } from '@/modules/accounting/services/reports/statementRows/statementModel';
import type { Annotation } from '@/modules/accounting/services/annotations/annotationService';

const rows: StatementRow[] = [
  { id: 'line:4000', kind: 'line', label: 'Sales', depth: 1, accountCode: '4000', actual: 100 },
  { id: 'line:5000', kind: 'line', label: 'Cost', depth: 1, accountCode: '5000', actual: 60 },
];

const ann = (id: string, rowId: string, resolvedAt: string | null): Annotation => ({
  id, rowId, periodStart: '2026-03-01', periodEnd: '2026-08-31',
  body: 'note', author: 'u1', authorName: 'A', createdAt: '2026-09-01T00:00:00Z', resolvedAt,
});

describe('attachNotes', () => {
  it('counts annotations onto the matching row only', () => {
    const out = attachNotes(rows, [ann('a', 'line:4000', null), ann('b', 'line:4000', null)]);
    expect(out[0]!.note).toEqual({ count: 2, hasOpen: true });
    expect(out[1]!.note).toBeUndefined();
  });

  it('reports hasOpen false when every annotation on the row is resolved', () => {
    const out = attachNotes(rows, [ann('a', 'line:4000', '2026-09-02T00:00:00Z')]);
    expect(out[0]!.note).toEqual({ count: 1, hasOpen: false });
  });

  it('returns new row objects and does not mutate the input', () => {
    const out = attachNotes(rows, [ann('a', 'line:4000', null)]);
    expect(rows[0]!.note).toBeUndefined();
    expect(out[0]).not.toBe(rows[0]);
  });

  it('ignores an annotation whose rowId matches nothing', () => {
    const out = attachNotes(rows, [ann('a', 'line:9999', null)]);
    expect(out.every(r => r.note === undefined)).toBe(true);
  });

  it('changes no figure on any row', () => {
    const out = attachNotes(rows, [ann('a', 'line:4000', null)]);
    expect(out.map(r => r.actual)).toEqual([100, 60]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `./node_modules/.bin/vitest run tests/unit/services/annotations/attachNotes.test.ts`
Expected: FAIL, cannot find module (and a type error on `.note`, which Step 3 adds).

- [ ] **Step 3: The two additive diffs**

In `src/modules/accounting/services/reports/statementRows/statementModel.ts`, add the interface and one optional field. Nothing else in that file changes:

```ts
/** WS3: annotation presence on a row. Presentation only — it carries no figure
 *  and is never summed. Populated client-side by attachNotes, never by an
 *  adapter, so the adapters stay pure functions of the service report. */
export interface StatementRowNote {
  count: number;
  hasOpen: boolean;
}
```

and inside `export interface StatementRow { ... }`, directly after the `href?: string;` field:

```ts
  /** WS3: set by attachNotes when this row has internal annotations. Never set
   *  on a share link — the share loader does not read annotations. */
  note?: StatementRowNote;
```

In `src/components/accounting/statement/StatementRowView.tsx`, add `onOpenNote` to the props and render the marker in the label cell. Exactly two edits:

```tsx
// 1. the props destructure and its type
export function StatementRowView({ row, columns, maxVariance, cents, expanded, onToggle, onEvidence, onOpenNote, drill }: {
  row: StatementRow; columns: StatementColumns; maxVariance: Record<ComparatorKey, number>; cents: boolean;
  expanded: boolean; onToggle?: (code: string) => void; onEvidence?: (code: string) => void;
  onOpenNote?: (rowId: string) => void; drill?: ReactNode;
}) {

// 2. the label cell — was:
//   <td className={`${pad} py-1.5`}><RowLabel row={row} expanded={expanded} onToggle={onToggle} /></td>
        <td className={`${pad} py-1.5`}>
          <span className="flex items-center gap-1">
            <RowLabel row={row} expanded={expanded} onToggle={onToggle} />
            {row.note && onOpenNote && (
              <NoteMarker note={row.note} onClick={() => onOpenNote(row.id)} label={row.label} />
            )}
          </span>
        </td>
```

plus the import `import { NoteMarker } from '@/components/accounting/annotations/NoteMarker';`.

In `src/components/accounting/statement/StatementGrid.tsx`, add `onOpenNote?: (rowId: string) => void;` to `StatementGridProps`, to the destructure, and pass `onOpenNote={onOpenNote}` to `<StatementRowView>`. No other change.

- [ ] **Step 4: Implement `attachNotes`, `NoteMarker`, `AnnotationThread`**

```ts
// src/components/accounting/annotations/attachNotes.ts
/**
 * Merges annotation counts onto rows. Pure, and returns new objects: the grid
 * renders what it is given, and an adapter's output must not be mutated behind
 * its back. It touches no figure — only `note`.
 */
import type { StatementRow } from '@/modules/accounting/services/reports/statementRows/statementModel';
import type { Annotation } from '@/modules/accounting/services/annotations/annotationService';

export function attachNotes(rows: StatementRow[], annotations: Annotation[]): StatementRow[] {
  if (annotations.length === 0) return rows.map(r => ({ ...r }));
  const byRow = new Map<string, Annotation[]>();
  for (const a of annotations) {
    const list = byRow.get(a.rowId);
    if (list) list.push(a); else byRow.set(a.rowId, [a]);
  }
  return rows.map(r => {
    const list = byRow.get(r.id);
    if (!list || list.length === 0) return { ...r };
    return { ...r, note: { count: list.length, hasOpen: list.some(a => a.resolvedAt === null) } };
  });
}
```

```tsx
// src/components/accounting/annotations/NoteMarker.tsx
/** The note icon on a statement row. Internal surfaces only — the share page
 *  never imports it, and the share loader never returns annotations. */
import { MessageSquare } from 'lucide-react';
import type { StatementRowNote } from '@/modules/accounting/services/reports/statementRows/statementModel';

export function NoteMarker({ note, onClick, label }: {
  note: StatementRowNote; onClick: () => void; label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${note.count} ${note.count === 1 ? 'note' : 'notes'} on ${label}`}
      className="inline-flex shrink-0 items-center gap-0.5 rounded px-1 text-[10px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ff-brand-500)]"
      style={{ color: note.hasOpen ? 'var(--ff-brand-500)' : 'var(--ff-text-tertiary)' }}
    >
      <MessageSquare className="h-3 w-3" />
      {note.count}
    </button>
  );
}
```

`AnnotationThread.tsx` is a small popover: it takes `{ rowId, annotations, onCreate, onResolve, onClose }`, lists each body with its `authorName` and `createdAt`, offers a textarea and a Save button that calls `onCreate(body)`, and a Resolve button per open annotation. Keep it under 120 lines and use the same token classes as `CommentaryBlock`.

- [ ] **Step 5: Write the `NoteMarker` test**

```tsx
// tests/unit/components/annotations/NoteMarker.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NoteMarker } from '@/components/accounting/annotations/NoteMarker';

describe('NoteMarker', () => {
  it('labels itself for a screen reader with the count and the row', () => {
    render(<NoteMarker note={{ count: 2, hasOpen: true }} onClick={vi.fn()} label="Sales" />);
    expect(screen.getByRole('button', { name: '2 notes on Sales' })).toBeTruthy();
  });

  it('uses the singular for one note', () => {
    render(<NoteMarker note={{ count: 1, hasOpen: false }} onClick={vi.fn()} label="Sales" />);
    expect(screen.getByRole('button', { name: '1 note on Sales' })).toBeTruthy();
  });

  it('calls back on click', () => {
    const onClick = vi.fn();
    render(<NoteMarker note={{ count: 1, hasOpen: true }} onClick={onClick} label="Sales" />);
    screen.getByRole('button').click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 6: Write the service and routes**

`annotationService.ts` follows `shareLinkService.ts` exactly: `company_id` on every statement, `log.info` on every write, `listAnnotations(companyId, rowIds, periodStart, periodEnd)` filtering with `row_id = ANY(${rowIds})`, `createAnnotation({ companyId, userId, authorName, rowId, periodStart, periodEnd, body })` with `body.slice(0, 4000)`, and `resolveAnnotation(companyId, id, userId)` returning `false` when nothing matched so the route answers 404. Both routes are `withAuth(withErrorHandler(withWriteAccess(handler)))` with the same UUID guard used in Task 4.

- [ ] **Step 7: Run every affected suite**

```bash
./node_modules/.bin/vitest run tests/unit/services/annotations/attachNotes.test.ts
./node_modules/.bin/vitest run --config vitest.components.config.ts tests/unit/components/annotations/NoteMarker.test.tsx
./node_modules/.bin/vitest run --config vitest.components.config.ts tests/unit/components/statement/
bun run type-check
```
Expected: all PASS. The existing `StatementGrid` component tests must stay green — the three diffs are additive and must not change any existing render.

- [ ] **Step 8: Commit**

```bash
git add src/modules/accounting/services/annotations src/components/accounting/annotations \
  pages/api/accounting/annotations \
  src/modules/accounting/services/reports/statementRows/statementModel.ts \
  src/components/accounting/statement/StatementRowView.tsx \
  src/components/accounting/statement/StatementGrid.tsx \
  tests/unit/services/annotations/attachNotes.test.ts tests/unit/components/annotations/NoteMarker.test.tsx
git commit -m "feat(annotations): internal row notes, with an additive note slot on the statement row"
```

---

### Task 13: `ShareLinkDialog` — create, show once, revoke

**Files:**
- Create: `src/components/accounting/share/ShareLinkDialog.tsx`

**Interfaces:**
- Consumes: `ShareLinkRow` (Task 4); `apiFetch` from `@/lib/apiFetch`.
- Produces: `<ShareLinkDialog params={SharePackParams} onClose={() => void} />`.

- [ ] **Step 1: Implement**

The dialog does four things and nothing else:

1. On open, `GET /api/accounting/share/links` and list this company's links with label, expiry, view count and a Revoke button. **The list never shows a URL**, because the server does not have one to give.
2. A Create button posts `{ params, label, ttlDays }` and, on success, shows the returned `url` **once**, in a read-only input with a copy button, above the sentence: *"This link is shown once. Copy it now — it cannot be shown again."*
3. Revoke posts to `/api/accounting/share/links/<id>/revoke` and re-fetches the list.
4. It checks `res.ok` on every call. Per `feedback_apifetch_resolves_on_4xx`, `apiFetch` resolves on a 4xx; a bare `try/catch` around it is decorative. Read the status, and surface the server's message rather than swallowing it.

Keep the component under 200 lines. Use `useState`/`useEffect` only; no new dependency, no form library.

- [ ] **Step 2: Type-check and lint**

Run: `bun run type-check && bun run lint`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/accounting/share/ShareLinkDialog.tsx
git commit -m "feat(share): dialog that shows a new link's URL exactly once"
```

---

### Task 14: Integration tests — lifecycle, cross-tenant, published-only

**Files:**
- Create: `tests/integration/share-link-lifecycle.int.test.ts`
- Create: `tests/integration/share-commentary-rls.int.test.ts`

**Interfaces:**
- Consumes: every service in this plan.

Both files **throw** without `DATABASE_URL` rather than skipping. A test that scores PASSED by not running is not a test (`feedback_db_gated_tests_pass_when_skipped`).

- [ ] **Step 1: Write the lifecycle test**

```ts
// tests/integration/share-link-lifecycle.int.test.ts
/**
 * The share link, end to end, against a real database: a minted token resolves
 * to its own company and nothing else; an expired one, a revoked one and a
 * wrong one all fail; and the view audit records every attempt.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { createShareLink, revokeShareLink, listShareLinks } from '@/modules/accounting/services/share/shareLinkService';
import { resolveShareLink } from '@/modules/accounting/services/share/shareResolver';
import { mintShareToken, hashShareToken } from '@/modules/accounting/services/share/shareToken';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('share-link-lifecycle requires DATABASE_URL; it does not skip');

const CA = '00000000-0000-0000-0000-0000000053aa';
const CB = '00000000-0000-0000-0000-0000000053bb';
const UA = 'ws3-share-user-A';
const CTX = { ip: '203.0.113.9', userAgent: 'vitest' };
const PARAMS = { type: 'board', from: '2026-03-01', to: '2026-08-31' } as const;

let admin: Pool;

beforeAll(async () => {
  admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
  await admin.query(
    `INSERT INTO companies (id, name, is_active) VALUES ($1,'WS3-A',true), ($2,'WS3-B',true) ON CONFLICT (id) DO NOTHING`, [CA, CB]);
  await admin.query(`INSERT INTO users (id, email, is_active) VALUES ($1,'ws3a@test.local',true) ON CONFLICT (id) DO NOTHING`, [UA]);
  await admin.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1,$2,'admin') ON CONFLICT DO NOTHING`, [CA, UA]);
});

afterAll(async () => {
  await admin.query(`DELETE FROM share_link_views WHERE company_id IN ($1,$2)`, [CA, CB]);
  await admin.query(`DELETE FROM share_links WHERE company_id IN ($1,$2)`, [CA, CB]);
  await admin.query(`DELETE FROM company_users WHERE user_id = $1`, [UA]);
  await admin.query(`DELETE FROM users WHERE id = $1`, [UA]);
  await admin.query(`DELETE FROM companies WHERE id IN ($1,$2)`, [CA, CB]);
  await admin.end();
});

describe('share link lifecycle', () => {
  it('a fresh token resolves to the company that created it', async () => {
    const { link, token } = await createShareLink({ companyId: CA, userId: UA, params: PARAMS });
    const r = await resolveShareLink(token, CTX);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.link.companyId).toBe(CA);
      expect(r.link.id).toBe(link.id);
      expect(r.link.params).toEqual(PARAMS);
    }
  });

  it('the raw token is never persisted anywhere in the row', async () => {
    const { link, token } = await createShareLink({ companyId: CA, userId: UA, params: PARAMS });
    const { rows } = await admin.query(`SELECT * FROM share_links WHERE id = $1`, [link.id]);
    expect(JSON.stringify(rows[0])).not.toContain(token);
    expect(rows[0].token_hash).toBe(hashShareToken(token));
  });

  it('listShareLinks never returns a token or a hash to the caller', async () => {
    await createShareLink({ companyId: CA, userId: UA, params: PARAMS });
    const links = await listShareLinks(CA);
    expect(JSON.stringify(links)).not.toContain('token');
  });

  it('an unminted token is not_found, and records no view', async () => {
    const before = (await admin.query(`SELECT COUNT(*)::int c FROM share_link_views`)).rows[0].c;
    expect((await resolveShareLink(mintShareToken(), CTX)).status).toBe('not_found');
    expect((await admin.query(`SELECT COUNT(*)::int c FROM share_link_views`)).rows[0].c).toBe(before);
  });

  it('a revoked token stops resolving immediately and the attempt is audited', async () => {
    const { link, token } = await createShareLink({ companyId: CA, userId: UA, params: PARAMS });
    expect((await resolveShareLink(token, CTX)).status).toBe('ok');
    expect(await revokeShareLink(CA, link.id, UA)).toBe(true);
    expect((await resolveShareLink(token, CTX)).status).toBe('revoked');
    const { rows } = await admin.query(
      `SELECT outcome FROM share_link_views WHERE share_link_id = $1 ORDER BY viewed_at`, [link.id]);
    expect(rows.map((r: { outcome: string }) => r.outcome)).toEqual(['ok', 'revoked']);
  });

  it('an expired token does not resolve', async () => {
    const { link, token } = await createShareLink({ companyId: CA, userId: UA, params: PARAMS });
    await admin.query(`UPDATE share_links SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [link.id]);
    expect((await resolveShareLink(token, CTX)).status).toBe('expired');
  });

  it('company B cannot revoke company A\'s link', async () => {
    const { link, token } = await createShareLink({ companyId: CA, userId: UA, params: PARAMS });
    expect(await revokeShareLink(CB, link.id, 'attacker')).toBe(false);
    expect((await resolveShareLink(token, CTX)).status).toBe('ok');
  });

  it('view_count and last_viewed_at advance on a successful view only', async () => {
    const { link, token } = await createShareLink({ companyId: CA, userId: UA, params: PARAMS });
    await resolveShareLink(token, CTX);
    await resolveShareLink(token, CTX);
    const { rows } = await admin.query(`SELECT view_count, last_viewed_at FROM share_links WHERE id = $1`, [link.id]);
    expect(rows[0].view_count).toBe(2);
    expect(rows[0].last_viewed_at).not.toBeNull();
  });
});
```

- [ ] **Step 2: Write the RLS and published-only test**

```ts
// tests/integration/share-commentary-rls.int.test.ts
/**
 * Two properties, both of which a unit test cannot establish:
 *  1. Under RLS (role app_user, GUCs set for tenant A), tenant A sees zero of
 *     tenant B's share links, commentary and annotations.
 *  2. A share page renders APPROVED text only. A draft on the same pack, for
 *     the same period, is absent from buildSharedPack's output.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { createShareLink } from '@/modules/accounting/services/share/shareLinkService';
import { resolveShareLink } from '@/modules/accounting/services/share/shareResolver';
import { buildSharedPack } from '@/modules/accounting/services/share/sharedPackService';
import { canonicalParamsHash } from '@/modules/accounting/services/share/shareParams';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('share-commentary-rls requires DATABASE_URL; it does not skip');

const CA = '00000000-0000-0000-0000-0000000054aa';
const CB = '00000000-0000-0000-0000-0000000054bb';
const UA = 'ws3-rls-user-A';
const UB = 'ws3-rls-user-B';
const PARAMS = { type: 'board', from: '2026-03-01', to: '2026-08-31' } as const;

let admin: Pool;

beforeAll(async () => {
  admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
  await admin.query(`INSERT INTO companies (id,name,is_active) VALUES ($1,'WS3R-A',true),($2,'WS3R-B',true) ON CONFLICT (id) DO NOTHING`, [CA, CB]);
  await admin.query(`INSERT INTO users (id,email,is_active) VALUES ($1,'r-a@test.local',true),($2,'r-b@test.local',true) ON CONFLICT (id) DO NOTHING`, [UA, UB]);
  await admin.query(`INSERT INTO company_users (company_id,user_id,role) VALUES ($1,$3,'admin'),($2,$4,'admin') ON CONFLICT DO NOTHING`, [CA, CB, UA, UB]);

  const hash = canonicalParamsHash(PARAMS);
  // Tenant B: one link, one approved commentary, one annotation.
  await createShareLink({ companyId: CB, userId: UB, params: PARAMS });
  await admin.query(
    `INSERT INTO report_commentary (company_id, report_kind, params_hash, period_start, period_end, section_ref, row_ref, draft_text, approved_text, status, generated_by, approved_by, approved_at)
     VALUES ($1,'pack',$2,'2026-03-01','2026-08-31','income_statement','revenue','B DRAFT','B APPROVED','approved',$3,$3,NOW())`,
    [CB, hash, UB]);
  await admin.query(
    `INSERT INTO report_annotations (company_id,row_id,period_start,period_end,body,author)
     VALUES ($1,'line:4000','2026-03-01','2026-08-31','B NOTE',$2)`, [CB, UB]);
});

afterAll(async () => {
  for (const t of ['share_link_views', 'share_links', 'report_commentary', 'report_annotations']) {
    await admin.query(`DELETE FROM ${t} WHERE company_id IN ($1,$2)`, [CA, CB]);
  }
  await admin.query(`DELETE FROM company_users WHERE user_id IN ($1,$2)`, [UA, UB]);
  await admin.query(`DELETE FROM users WHERE id IN ($1,$2)`, [UA, UB]);
  await admin.query(`DELETE FROM companies WHERE id IN ($1,$2)`, [CA, CB]);
  await admin.end();
});

describe('RLS on the WS3 tables', () => {
  it('tenant A reads none of tenant B rows on any of the four tables', async () => {
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      await client.query(`SELECT set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ sub: UA })]);
      await client.query(`SELECT set_config('app.current_company_id',$1,true)`, [CA]);
      for (const t of ['share_links', 'share_link_views', 'report_commentary', 'report_annotations']) {
        const r = await client.query<{ c: number }>(
          `SELECT COUNT(*)::int AS c FROM public."${t}" WHERE company_id = $1::uuid`, [CB]);
        expect(r.rows[0]!.c, `${t} leaked tenant B rows to tenant A`).toBe(0);
      }
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('tenant A cannot INSERT a share link for tenant B', async () => {
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      await client.query(`SELECT set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ sub: UA })]);
      await client.query(`SELECT set_config('app.current_company_id',$1,true)`, [CA]);
      await expect(client.query(
        `INSERT INTO share_links (company_id, report_kind, params, token_hash, created_by)
         VALUES ($1,'pack','{}'::jsonb,'deadbeef',$2)`, [CB, UA])).rejects.toThrow();
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});

describe('a share link publishes approved text only', () => {
  it('renders the approved sentence and not the draft on the same row', async () => {
    const hash = canonicalParamsHash(PARAMS);
    await admin.query(
      `INSERT INTO report_commentary (company_id, report_kind, params_hash, period_start, period_end, section_ref, row_ref, draft_text, approved_text, status, generated_by, approved_by, approved_at)
       VALUES ($1,'pack',$2,'2026-03-01','2026-08-31','income_statement','netProfit','SHOULD NOT APPEAR','APPROVED SENTENCE','approved',$3,$3,NOW()),
              ($1,'pack',$2,'2026-03-01','2026-08-31','income_statement','revenue','DRAFT SHOULD NOT APPEAR',NULL,'draft',$3,NULL,NULL)`,
      [CA, hash, UA]);

    const { token } = await createShareLink({ companyId: CA, userId: UA, params: PARAMS });
    const r = await resolveShareLink(token, { ip: '203.0.113.10', userAgent: 'vitest' });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;

    const shared = await buildSharedPack(r.link);
    const text = JSON.stringify(shared);
    expect(text).toContain('APPROVED SENTENCE');
    expect(text).not.toContain('SHOULD NOT APPEAR');
    expect(text).not.toContain('DRAFT SHOULD NOT APPEAR');
    expect(text).not.toContain('B APPROVED');   // tenant B's approved text
    expect(text).not.toContain('B NOTE');       // no annotation, ever
  });
});
```

- [ ] **Step 3: Run both, with and without the env var**

```bash
DATABASE_URL=<isaflow_dev url> ./node_modules/.bin/vitest run --config vitest.integration.config.ts tests/integration/share-link-lifecycle.int.test.ts tests/integration/share-commentary-rls.int.test.ts
```
Expected: PASS.

```bash
env -u DATABASE_URL ./node_modules/.bin/vitest run --config vitest.integration.config.ts tests/integration/share-link-lifecycle.int.test.ts
```
Expected: FAIL with "requires DATABASE_URL; it does not skip". A PASS or a SKIP here is a defect in the test, not a convenience.

- [ ] **Step 4: Mutation proof — three mutations, each must go red**

| Mutation | Test that must fail |
|---|---|
| Drop `AND status = 'approved'` from `loadApprovedCommentary` | published-only test finds `DRAFT SHOULD NOT APPEAR` |
| Change `resolveShareLink` to ignore `revoked_at` | revoked-token test |
| Drop `AND company_id = ${companyId}::uuid` from `revokeShareLink` | cross-company revoke test |

Run each, paste the red output into the PR, and revert.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/share-link-lifecycle.int.test.ts tests/integration/share-commentary-rls.int.test.ts
git commit -m "test(share): lifecycle, cross-tenant RLS, and approved-text-only, against a real database"
```

---

### Task 15: Browser proof, CI, adversarial review, PR

- [ ] **Step 1: Create a link as a real user**

Start the dev server in this worktree (`bun run dev`, port 3200 — stop it before any `bun run ci`; the CI build clobbers a running dev server's `.next`). Log in with the QA account, open the report packs page, and create a share link for the Britech company, board pack, a month-end period. Copy the URL from the dialog. Screenshot the dialog showing the *shown once* notice.

- [ ] **Step 2: Open the link in a FRESH INCOGNITO CONTEXT with no cookies**

This is the proof that matters: the page must render with **no session at all**. Using the same browser profile proves nothing, because a valid session would mask a missing auth check.

Confirm and screenshot:
1. The pack renders, with the company name and the period.
2. No AppLayout chrome, no navigation, no link back into the app.
3. No note icon anywhere on the page.
4. Any commentary shown is approved; a draft you left unapproved does **not** appear. Approve one draft in the app, reload the share page, and screenshot it appearing — that pair of screenshots is the commentary proof.
5. Revoke the link in the app, reload the share page in the same incognito window, and screenshot "This link has been withdrawn."
6. `curl -sS -o /dev/null -w '%{http_code}\n' https://localhost:3200/share/$(head -c32 /dev/urandom | base64 | tr '+/' '-_' | head -c43)` → `404`.

- [ ] **Step 3: `bun run ci`**

Run: `bun run ci`. Fix everything red. Then run the integration suite explicitly with `DATABASE_URL` set — `bun run ci` skips it silently without the env vars, so a green CI line is not evidence that Task 14 ran.

- [ ] **Step 4: Adversarial (policy-breaker) review**

Hand the reviewer the diff and **this attack list**. They run each and report pass or fail; do not pre-empt their conclusions.

1. **Token guessing.** Is the token 256 bits from a CSPRNG? Is it ever logged, ever put in a URL that reaches an analytics call, ever returned by a list endpoint? Does a malformed token reach a query?
2. **Expired and revoked reuse.** Is expiry checked on every view or only at creation? Is revocation immediate, or does a cached page or an in-memory map keep a withdrawn link alive? Does the rate-limit short-circuit ever let a resolution skip the expiry check?
3. **Cross-company pack id.** Can any input — `params`, a query string, a header, a JSON body key, a JSONB field inside `params` — cause `buildSharedPack` to read a company other than `share_links.company_id`? Confirm `parseSharePackParams` rebuilds rather than validates in place, so an injected `companyId` cannot survive into storage.
4. **Approval by a non-member.** Post an approve for a commentary id belonging to another tenant. Does it 404, or does it approve? Is `company_id` on the UPDATE itself, not only on a prior SELECT? Can a viewer-role user approve? Can two approvals race and both write?
5. **Draft leaking to a share link.** Is there any path from `draft_text` to the share page or the PDF? Check `buildSharedPack`, `CommentaryBlock` in published mode, and the props of everything `pages/share/[token].tsx` renders. Does a `JSON.stringify` of the page props contain a draft?
6. **Annotation on a share link.** Does any share code path import the annotation service, or return a `note` field? Is `StatementRow.note` reachable from `SharedPackView`?
7. **Audit completeness.** Is a view of a revoked link recorded? Is an approval recorded with the approver's id? Would a client auditor be able to say who approved a sentence and when, from the database alone?

- [ ] **Step 5: Blind `/review`**

Run `/review`. Fix every HIGH, MEDIUM and LOW. Re-run `bun run ci`.

- [ ] **Step 6: Push and open the PR**

```bash
cd <worktree> && timeout 420 git push -u origin feat/reporting-ws3-share
```
(The pre-push hook runs a Next build; 420 seconds is the working timeout for this repo.)

PR body: the incognito screenshots from Step 2, the three mutation outputs from Task 14 Step 4, the integration test output with `DATABASE_URL` set, and the adversarial reviewer's findings verbatim.

- [ ] **Step 7: Hand to the programme lead**

Do not merge. Every file here touches a production path, so this PR is outside the Level 3 auto-merge boundary.

---

## Requests to other owners

1. **WS2 (packs)** — mount `<ShareLinkDialog>` behind a "Share" button in `pages/accounting/reports/report-packs.tsx`, passing the currently selected `{ type, from, to }`. WS3 does not edit that file. The component is self-contained: one import, one boolean of state, one button.
2. **WS2 (packs)** — render `<CommentaryBlock mode="internal" …>` under each pack section on the same page, sourcing rows from `GET /api/accounting/commentary?type=&from=&to=`. This is the internal half of the inline placement; the published half already lives in `SharedPackView`.
3. **WS1 (charts and presentation)** — thread `onOpenNote` from `StatementGrid` to whichever surfaces should show annotations, and mount `<AnnotationThread>`. WS3 adds the prop and the marker; it does not decide which statement pages turn notes on.
4. **WS-P (PDF)** — when the pack PDF renders commentary, it must read `approved_text` only. The simplest way is to render `<CommentaryBlock mode="published">`; a direct query must filter `status = 'approved' AND approved_text IS NOT NULL`. Flagging this because the PDF is the second surface, besides share links, that leaves the tenant.
5. **Programme lead** — the `pages/share/**` route is public and unauthenticated. Confirm the security headers middleware and the CSP apply to it, and that no auth middleware is configured to redirect `/share/*` to a login page.
6. **Programme lead / Hein** — decide whether `/share/*` should be excluded from the analytics tracker. It is a third-party-facing page and the current tracker records path and IP.

---

## Self-review

**1. Spec coverage.** Every controller ruling maps to a task:

| Ruling | Task |
|---|---|
| `share_links` table with the named columns | 1 |
| Token shown once at creation, hash stored | 2, 4, 13 |
| Public route `pages/share/[token].tsx`, server-side loader, company from the link | 5, 6, 7 |
| Every view audited | 1 (`share_link_views`), 5 (`recordShareView`), 14 |
| Revocation and expiry enforced server-side | 4, 5, 14 |
| Rate-limited | 5 |
| No PII beyond the pack | 6, 7 (loader returns pack + approved text only) |
| Portal conventions reused | 2 (random token, hash-at-rest, 404 for anything unresolvable), 7 (`getServerSideProps`, `clientIp`) |
| `report_commentary` table with the named columns | 8 |
| `aiCommentaryService` writes drafts only | 10 (`commentaryDraft` wraps it; only `generateDrafts` writes, always as `draft`) |
| Approval is a POST copying draft to approved, with approver and audit | 10 |
| Share links and PDF read approved only | 6, 11, plus request 4 to WS-P |
| Inline placement under the figure | 7, 11 |
| `report_annotations` table | 8 |
| Note icon on the row via `StatementRow.note?`, thread popover | 12 |
| Annotations internal only, never on share links | 6, 7, 12, 14 |
| Every write `withAuth(withErrorHandler(...))`, company-scoped, audited | 4, 10, 12 |
| Migrations `IF NOT EXISTS`, next prefix, RLS | 1, 8 |
| Adversarial review with the named attacks | 15 |
| Tests: token round-trip, RLS cross-tenant (non-skipping), approval state machine, approved-only render | 2, 9, 14 |
| Browser proof in a fresh incognito context | 15 |
| No new dependencies | Global Constraints; nothing in this plan runs `bun add` |

**2. Placeholder scan.** No TBDs. Three items are deliberately described rather than transcribed, each with enough constraint to be unambiguous and each covered by a test or a gate: `AnnotationThread.tsx` (Task 12 Step 4, props and size given), `annotationService.ts` (Task 12 Step 6, told to mirror `shareLinkService.ts` function for function), and `packData.ts` (Task 10 Step 6, told which two existing services to compose). The `ShareLinkDialog` in Task 13 is specified as four numbered behaviours plus the `res.ok` rule; it is UI with no branching logic worth pinning line by line.

**3. Type consistency.** `SharePackParams` is defined in Task 3 and used unchanged in 4, 6, 10 and 14. `ResolvedShareLink` is defined in Task 5 and consumed in 6 and 7. `CommentaryRow` is defined in Task 10 and consumed in 11. `CommentaryStatus` is defined in Task 9 and reused in 10. `StatementRowNote` is defined in Task 12's `statementModel.ts` diff and consumed by `NoteMarker` and `attachNotes` in the same task. `hashShareToken` has one signature across 2, 4, 5 and 14.

**4. Known ordering constraint.** Task 6 reads `report_commentary`, which Task 8 creates. Type-check passes either way because SQL is not type-checked, but the integration test in Task 14 will fail if 8 has not been applied. Executed in order, this does not arise.

**5. The strongest argument against this design.** Storing `report_kind` + `params` rather than pointing at a persisted pack means a share link re-computes from the live ledger on every view. A client opening a January link in March sees figures that moved because someone posted a back-dated journal, and the sender will not know. Snapshotting the pack at creation would freeze it. It is not built that way here because WS2 owns pack persistence and WS3 must not depend on it, and because a stale snapshot has its own failure mode: a client reading numbers the accountant has since corrected. If the programme later wants immutability, the change is one nullable `pack_snapshot JSONB` column on `share_links` plus a branch in `buildSharedPack` — it does not disturb the token, the audit or the commentary model. Raise it with Hein rather than deciding it inside this workstream.

---

### Task 16: Exclude the public share page from the analytics tracker (controller-added)

**Files:**
- Modify: `pages/_app.tsx` (granted to WS3 for this one additive change: the `TrackerScript` mount)
- Test: `tests/unit/components/trackerExclusion.test.ts`

**Interfaces:**
- Produces: `isTrackedPath(pathname: string): boolean` in `src/modules/analytics/isTrackedPath.ts` returning `false` for any pathname that starts with `/share/` or equals `/share`, `true` otherwise.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { isTrackedPath } from '@/modules/analytics/isTrackedPath';

describe('isTrackedPath', () => {
  it('excludes the public share page and everything under it', () => {
    expect(isTrackedPath('/share')).toBe(false);
    expect(isTrackedPath('/share/abc123')).toBe(false);
    expect(isTrackedPath('/share/abc123/')).toBe(false);
  });
  it('keeps every app page tracked', () => {
    expect(isTrackedPath('/')).toBe(true);
    expect(isTrackedPath('/accounting/reports/report-packs')).toBe(true);
    expect(isTrackedPath('/shared-with-me')).toBe(true);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL (module not found).**

- [ ] **Step 3: Implement**

```ts
// src/modules/analytics/isTrackedPath.ts
/** The public share page is third-party-facing: no path or IP capture there. */
export function isTrackedPath(pathname: string): boolean {
  return !(pathname === '/share' || pathname.startsWith('/share/'));
}
```

In `pages/_app.tsx`, where `TrackerScript` is mounted, read `useRouter().pathname` (or `router.asPath` split on `?`) and render `TrackerScript` only when `isTrackedPath(pathname)`. Touch nothing else in `_app.tsx`.

- [ ] **Step 4: Run the test, expect PASS. `bun run type-check`. Browser proof: open a share link in a fresh context and confirm no request to the tracker endpoint (`/api/track*`) appears in the network log; open `/accounting` logged in and confirm one does. Note both in the report.**

- [ ] **Step 5: Commit**

```bash
git add src/modules/analytics/isTrackedPath.ts pages/_app.tsx tests/unit/components/trackerExclusion.test.ts
git commit -m "feat(share): the public share page is not tracked"
```

---

### Task 17: Redact share tokens in request logging and Sentry tags (controller-added)

**Why:** `src/lib/api-error-handler.ts` logs `req.url` and `req.query` verbatim; `src/lib/observability/requestLogger.ts` logs the path; `src/lib/sentry/tags.ts` sends the path to Sentry. A share link `/share/<token>` would put a working credential into journalctl and a third-party service. Granted to WS3 as additive one-line changes in each file (no other edits there).

**Files:**
- Modify: `src/lib/api-error-handler.ts` (wrap the logged URL and, if `req.query` carries a `token` key, redact it), `src/lib/observability/requestLogger.ts`, `src/lib/sentry/tags.ts` — each through `redactShareToken` from `src/modules/accounting/services/share/shareResolver.ts` (move `redactShareToken` to `src/lib/observability/redactShareToken.ts` so `src/lib` does not import from a module; re-export from the service).
- Test: `tests/unit/lib/observability/redactShareToken.test.ts` plus one test per logging site that the logged/tagged value for `/share/<43-char token>?x=1` contains `[token]` and never the token.

- [ ] Write the failing tests (three sites + helper).
- [ ] Move the helper; apply it at each site; nothing else changes in those files (diff must be ≤ 3 lines each).
- [ ] Run the tests, `bun run type-check`, `bun run lint`; run the pre-existing tests for those three files if any (`grep -rl api-error-handler tests/unit`).
- [ ] Commit: `fix(observability): share tokens never reach request logs or Sentry` with the trailer.

---

### Task 18: Scope the pack figures' account join to the company (controller-added)

**Why:** `getFinancialFigures` (in `src/modules/accounting/services/reports/reportPackDataService.ts` or wherever it lives; find it) joins `gl_accounts` without `ga.company_id = je.company_id`. Under RLS (authenticated page) the foreign account is invisible, so the page is R450 out; on the share path (pool superuser, no RLS) the line is classified through another tenant's account, so the shared pack disagrees with the owner's page by R450 (Brightsphere JE-2026-00002 → Dotbiz account 1140). Granted to WS3 as a one-predicate change plus a test.

**Files:** the file holding `getFinancialFigures` (additive predicate only), `tests/unit/services/reports/getFinancialFiguresScoping.test.ts`.

- [ ] Failing test: with `sql` mocked, assert the query text for the figures aggregation contains a `gl_accounts`…`company_id` predicate bound to the company parameter (assert on the bound params and the SQL text both), and a second test using the repo's integration harness (non-skipping without `DATABASE_URL`) that Brightsphere's `getFinancialFigures` for 2026-03-01..2026-08-31 excludes the R450 line: total assets minus (liabilities + equity) equals the SAME value the authenticated balance-sheet page shows (fetch via `getBalanceSheet` under a `set_config('app.current_company_id', …, true)` in the test transaction) — i.e. the two paths agree.
- [ ] Add `AND ga.company_id = je.company_id` (or the equivalent parameter predicate) to every `gl_accounts` join in that function; nothing else changes.
- [ ] Run the tests, `bun run type-check`, `bun run lint`; commit `fix(reports): pack figures classify only through the company's own accounts` with the trailer.
- [ ] In the report, record the agreed figure for Brightsphere before and after.

---

### Task 19: `useCommentary` hook and `CommentaryPanel` container (controller-added)

**Why:** Task 11's `CommentaryBlock` is presentational; nothing fetches rows or calls approve/reject/regenerate with role gating. WS2's integration must only mount a component.

**Files:** `src/components/accounting/commentary/useCommentary.ts`, `src/components/accounting/commentary/CommentaryPanel.tsx`, `tests/unit/components/commentary/CommentaryPanel.dom.test.tsx`.

**Interfaces:** `useCommentary({ reportKind, paramsHash | { type, from, to }, sectionRef })` → `{ rows, loading, error, generate(replace?), approve(id), reject(id), refresh() }` calling the Task 10 routes through `apiFetch` with `assertOk`/`res.ok` (never `?? []`), CSRF header as `apiFetch` sends; `CommentaryPanel({ sectionRef, mode, canApprove })` renders `CommentaryBlock` with callbacks wired only when `canApprove` (owner/admin from the current user context; find the existing hook the executive dashboard or AppLayout uses for role) and surfaces `error` inline.

- [ ] RED DOM tests: loads rows for the section; approve calls the route with the id and refreshes; a 403 from the route shows an inline error and leaves the row unchanged; non-approver sees no buttons; `generate` with `replace` only when confirmed.
- [ ] Implement; `bun run type-check`, `bun run lint`, `bun run test:components`.
- [ ] Commit `feat(commentary): container that fetches, approves and regenerates with role gating` with the trailer.
