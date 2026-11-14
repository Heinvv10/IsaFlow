# CHANGES-ARCHIVE (frozen)

Frozen archive of the "Recent changes" sections that used to live in the sibling `.claude.md` file(s). Do not append to this file. Change history goes in commit messages and PR bodies; `.claude.md` holds rules only. CI (`check-no-recent-changes`) fails a PR that adds lines to an existing archive.

# Archived from .claude.md

## Recent changes
- 2026-11-08: created (wave 5 L1a, mig 969).
- 2026-11-09: wave 5 L1b (mig 971): file, amend, the unlock guard, the transition guard, one open draft per key.
- 2026-11-11: wave 5 L2: refusal codes `RATE_CHECK_FAILED` (400), `VAT_RETURN_MISMATCH`, `LIVE_VERSION_EXISTS`, `OVERLAPS_LIVE_VERSION` (409) in `error.details.code`; `LEGACY_SUBMISSION_EXISTS` also sends `details.legacySubmissionIds` (`ReturnRefusal.refusalDetails`); those messages no longer name API fields.
- 2026-11-11: wave 5 L2: `ALREADY_FILED` / `VERSION_SUPERSEDED` (file) and `ALREADY_AMENDED` (amend) codes on those 409s.
