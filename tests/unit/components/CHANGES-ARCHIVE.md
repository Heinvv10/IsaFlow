# CHANGES-ARCHIVE (frozen)

Frozen archive of the "Recent changes" sections that used to live in the sibling `.claude.md` file(s). Do not append to this file. Change history goes in commit messages and PR bodies; `.claude.md` holds rules only. CI (`check-no-recent-changes`) fails a PR that adds lines to an existing archive.

# Archived from .claude.md

## Recent changes
- 2026-09-30: R-164 — `clientRateOverridesLoadErrors` covers `ClientRateOverrides`'s `loadData`
  and `handleDelete`, which resolved on a 500 (never threw) and rendered "No rate overrides yet" /
  an empty staff dropdown instead of an error. Mock `apiFetch` per-endpoint by URL suffix
  (`/staff` vs `/rate-overrides`), not by call order — `Promise.all` does not guarantee it.
- 2026-09-29: R-154 — `autoPostRunsPanelHandOffset` / `autoPostRunsPanelUndoResult` waited on the
  `onUndone` spy; now wait on the DOM (line + notice gone, or the `Undo` button back).
- 2026-09-29: R-138/R-098 — `ReportPageDrillDimensions` BU tests changed the select before the BU
  option rendered; now wait for the option first.
- 2026-09-29: R-138 sweep — same fix in `CostCentreComparatorGate` (6 tests), `ReportReturnState`,
  `TrialBalanceExport`, `expenseClaimLateClaimNotice`, `apPaymentRefusalMessages`.
- 2026-09-28: R-150 — `supplierInvoiceSaveRefusal` waited for `Save` to vanish (true mid-save);
  now waits for `Edit` and asserts the refetched notes.
