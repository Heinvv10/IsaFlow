# CHANGES-ARCHIVE (frozen)

Frozen archive of the "Recent changes" sections that used to live in the sibling `.claude.md` file(s). Do not append to this file. Change history goes in commit messages and PR bodies; `.claude.md` holds rules only. CI (`check-no-recent-changes`) fails a PR that adds lines to an existing archive.

# Archived from .claude.md

## Recent changes
- 2026-10-27 (P2 PR-C): directory created (core store/hooks, grid, wizard, import, shell).
- 2026-10-27 (PR-C round 1): store revision (`subscribeRevision` / `getRevision`), `hasAmounts`, `fyTotals`; undo kept across views; account-boundary chunks; `reapplyMine` resolves its message; compare never the version itself and cleared on a version switch; no-year panel; 409 dialog says when.
- 2026-10-27 (PR-C round 2): Shift+Tab off column 0 keeps a refused draft open; a cell that turned read-only mid-edit is not re-opened; the editor error opens away from the sticky column; Shift+F10 / context-menu key opens row actions; sub-account splits warn when a part crosses zero.
- 2026-10-27 (PR-C round 2): `fyTotals()` is the WHOLE version (every grain), not the view; `useCopyReapply` remembers a locked-copy whose load failed so a retry never copies twice; notices carry `cells` and `store.addNotice` appends (a rounding warning keeps a paste's notice).
- 2026-10-27 (P2 PR-D): cutover. `/accounting/budgets` renders the workspace; `BudgetForm.tsx`, `useBudgetAccounts.ts` and the old page's `budgetClient` exports (`budgetTotals`, `fmt`, `BudgetRow`, `BudgetMonth`, `GLAccount`) are deleted. The legacy `GET /api/accounting/budgets` stays (the year list).
- 2026-10-27 (P2 PR-D review): budget notes (`GridAccount.note`, the year's `accounting_budgets.notes`) show read-only: a note icon on the row label (accessible name and tooltip carry the text) and the text on the phone sheet; editing is a follow-up. The legacy write routes are retired; the year list uses `years_only=1`.
- 2026-10-28 (P2 follow-up F1): notes are editable (`NoteDialog`, `store.setNote`, `GridRowSnapshot.note`, `BudgetGrid` props `fiscalYear` + `onSaveNote`).
- 2026-10-29 (P4 PR-5): drivers on the grid (see `../drivers/.claude.md`). `GridRowSnapshot` += `sources`, `driver`, `driverWarning`; the store holds cell sources, closed months (read-only "Actual" columns, FY too) and drivers; `apply` drops closed-month writes and clears of driver cells; `BudgetGrid` prop `driver`; row actions "Set/Edit driver…", "Reset <month> to driver", "Reset all overrides" (when wired); `useBudgetGrid` `adoptToken` + `refresh` (in-place re-read; a save in a driver version calls it); `VersionsBar` props `onReforecastFromActuals`, `rolling`; `SaveBar` shows the recompute; `failureOf` keeps a 400's `path`; `call` exported.
- 2026-10-29 (PR-5 review round 1): `gridRefresh.ts` (the in-place re-read; `refresh` has its own sequence, never cancels a switch, answers a failure message → `SaveState.saved.refreshError`); the `BudgetGridApi` interface moved to `budgetGridApi.ts` (re-exported; 300-line ceiling); `SpreadDialog` row target `note`; `apply` reverts a cleared, typed-over driver cell to its loaded value; a save answering `driverWarnings` (even empty) replaces the rows' warnings.
- 2026-11-03 (P5-6): holder mode (`holderMode.ts`, `HolderBanner.tsx`, pivot `readReason`), owner force-approve dialog.
