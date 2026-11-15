# CHANGES-ARCHIVE (frozen)

Frozen archive of the "Recent changes" sections that used to live in the sibling `.claude.md` file(s). Do not append to this file. Change history goes in commit messages and PR bodies; `.claude.md` holds rules only. CI (`check-no-recent-changes`) fails a PR that adds lines to an existing archive.

# Archived from .claude.md

## Recent changes
- 2026-09-26 (R-032 L5): `decideProposal` (approve, reject and dismiss) now call `assertNotImpersonating()` (`src/lib/auth/impersonationGuard.ts`) as their FIRST statement: a platform-admin "Login as" session gets `ImpersonationForbiddenError` → 403 `IMPERSONATION_FORBIDDEN` before anything is read or written. Bearer callers (MCP, PATs) and jobs carry no `session_id` and pass. The guard runs one `sql` query, so a unit test that mocks `sql` with a positional queue must also mock the guard (`vi.mock('@/lib/auth/impersonationGuard', ...)` with `assertNotImpersonating: async () => undefined`) or every later query shifts by one.
- 2026-07-06: created (P5.1 close-run engine). Surface (Month-End tab home + bureau rollup) lands in P5.2.
