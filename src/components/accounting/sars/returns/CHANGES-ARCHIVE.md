# CHANGES-ARCHIVE (frozen)

Frozen archive of the "Recent changes" sections that used to live in the sibling `.claude.md` file(s). Do not append to this file. Change history goes in commit messages and PR bodies; `.claude.md` holds rules only. CI (`check-no-recent-changes`) fails a PR that adds lines to an existing archive.

# Archived from .claude.md

## Recent changes
- 2026-11-11: created (wave 5 L2); golden `z16-return-lifecycle` (sandbox only).
- 2026-11-11: review r1: refusal codes instead of message matching, legacy ids from the server, settled-only status, stale-tab Amend, drawer focus return, solid disabled buttons.
- 2026-11-11: review r2: `useReturnLifecycle` returns data only for the current period key (never the last period's for a render); LEGACY_SUBMISSION_EXISTS without ids is an ordinary refusal; tests split (`returnLifecycleBar*.test.tsx`, `returnLifecycleEmp201.test.tsx`, harness in `tests/unit/components/helpers/`).
- 2026-11-11: browser r2: focus starts on the first field (finalise: its action) via Modal's opt-in `initialFocusRef`, returns to the opening button on close (status line when it is gone), and moves to Amend instead or the alert after a stale refusal; ALREADY_FILED, VERSION_SUPERSEDED and ALREADY_AMENDED reload the bar like LIVE_VERSION_EXISTS.
