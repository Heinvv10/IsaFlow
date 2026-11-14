# CHANGES-ARCHIVE (frozen)

Frozen archive of the "Recent changes" sections that used to live in the sibling `.claude.md` file(s). Do not append to this file. Change history goes in commit messages and PR bodies; `.claude.md` holds rules only. CI (`check-no-recent-changes`) fails a PR that adds lines to an existing archive.

# Archived from .claude.md

## Recent changes
- 2026-09-06: render semaphore on the PDF route; both export routes added to the rate-limit case table.
- 2026-09-07: `pages.ts` added (task 18b) — the board pack's server-side composition route, and the only path `packPrintApiPaths('board')` authorises.
- 2026-09-06 (PR review): the render slot moved OUTSIDE `withAuth` (see `src/lib/pdf/.claude.md`); `months` bounded to 1..12; the two legacy report routes recorded above as caller-less.
