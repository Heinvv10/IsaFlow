# CHANGES-ARCHIVE (frozen)

Frozen archive of the "Recent changes" sections that used to live in the sibling `.claude.md` file(s). Do not append to this file. Change history goes in commit messages and PR bodies; `.claude.md` holds rules only. CI (`check-no-recent-changes`) fails a PR that adds lines to an existing archive.

# Archived from .claude.md

## Recent changes
- 2026-11-06: master plan wave 4, PR NS1. `Select` is keyboard-complete: Enter/Space choose the active option, Tab closes without choosing, Home/End jump, printable keys type ahead (they move the active option and never the value), ArrowDown on a closed trigger opens on the current value. The key handling lives in `useSelectKeyboard.ts`. New `size="sm"` (32 px, `text-xs`, truncating, panel at least 224 px and kept inside the viewport) for grid cells; `CodingPicker`, the invoice Type and the invoice list's Status and period use it.
- 2026-11-02: master plan wave 3, PR V. The last 15 banner pages moved to `PageHeader`, the banner rule left `styles/themeContrast.css`, and `font-id` was added.
- 2026-11-06: master plan wave 4, VC. Label case applied: the 19 files on `uppercase tracking-wider mb-1.5` moved to the kit label (`text-sm font-medium`, sentence case) and `tests/unit/ci/labelCaseCensus.test.ts` refuses the pattern in ts/tsx. Payroll `font-mono` moved to `font-id` (identifiers) or `tabular-nums` (sequences, period labels); `PayrollRunLinesTable.tsx` and `employees/[id].tsx` stay on the allowlist.
- 2026-11-08: master plan wave 5, PR UXB. `Select` gains `size="xs"` (24 px, WCAG 2.5.8 minimum). The option panel is placed by `panelPlacement.ts` in viewport coordinates: downward unless there is less room below than above and less than the panel wants, then upward, its max height the room on that side (it no longer adds scroll offsets to a `fixed` panel).
