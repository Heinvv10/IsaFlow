# CHANGES-ARCHIVE (frozen)

Frozen archive of the "Recent changes" sections that used to live in the sibling `.claude.md` file(s). Do not append to this file. Change history goes in commit messages and PR bodies; `.claude.md` holds rules only. CI (`check-no-recent-changes`) fails a PR that adds lines to an existing archive.

# Archived from .claude.md

## Recent changes
- 2026-09-07 (task 20d): `MattersTable`'s omitted note said matters were "not printed on this page" above 45% of blank white — the table is held to a fixed depth so a pack is twelve sheets for every company, which is a different reason and the true one; it also states the ordering the rows now actually follow. The cover's brand band prints the company name through `content: attr(data-brand-name)` on `.pack-cover::after` — it shipped as an empty navy rectangle, and the band must stay a pseudo-element (see the CSS for why).
- 2026-09-07 (task 18b): `?print=1&pack=board` now routes to `PackPagesPrintPage`/`usePackPagesData`, off the server-composed `/api/accounting/packs/board/pages`. Management and monthly are unchanged.
- 2026-09-07: `PackPagesView` renders block content (Task 18) — `pages/PackBlocks.tsx`, `pages/PackChartBlock.tsx`, `pages/PackNoteBlocks.tsx`, `primitives/MattersTable.tsx`. At the time, `?print=1` still routed every pack type to the legacy `PackPrintPage`; task 18b built the data path and flipped `board`.
- 2026-09-06: `PackPrintPage`'s docstring corrected (the three app-level fetches it described are now gated off); print gate scoped to this page.
