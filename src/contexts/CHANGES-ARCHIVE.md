# CHANGES-ARCHIVE (frozen)

Frozen archive of the "Recent changes" sections that used to live in the sibling `.claude.md` file(s). Do not append to this file. Change history goes in commit messages and PR bodies; `.claude.md` holds rules only. CI (`check-no-recent-changes`) fails a PR that adds lines to an existing archive.

# Archived from .claude.md

## Recent changes
- 2026-11-06: **an expired access cookie is not a sign-out.** It lives an hour, the refresh cookie up to 30 days ("Keep me signed in"). `middleware.ts` counts either as a session, and `useSessionCheck` renews on a 401 through `apiFetch`'s shared `refreshSession`, which now gives up after 10 s. Tests: `tests/unit/middlewareRefreshCookieSession.test.ts`, `tests/unit/components/authSessionCheckRefresh.test.tsx`.
- 2026-10-16: **a session pointed at a company the server will no longer serve recovers itself, once.** When `GET /api/accounting/companies?action=user-companies` does not answer (a soft-deleted active company 403s that very request, so the provider has neither an active company nor a list to switch with), `companyRecovery.recoverActiveCompany` reads the user-scoped `/api/auth/me` — which now lists only live memberships — and POSTs `switch-company` to the first one, then the provider re-reads the list. It does NOT reload the page, and a ref guards it to one attempt per provider instance, so a switch that does not help ends on the "no company" screen rather than in a loop. Tests: `tests/unit/components/contexts/companyRecovery.dom.test.tsx`.
- 2026-10-02: D9 round 2 — `authUnavailable` drives an outage message + Retry on AppLayout's pending screen, instead of a bare spinner.
- 2026-10-02: D9 — `AuthProvider` treats an unavailable `/api/auth/me` as "try again", not "signed out".
- 2026-09-28: R-148 — the mount-time divergence is fixed: the provider activates the server's `activeCompanyId` and corrects `localStorage` to it; a failed fetch shows no company and leaves `localStorage` alone.
- 2026-09-06: `skipFetch` added to both providers for the PDF print render; the mount-time cookie/`localStorage` divergence above recorded as a follow-up.
