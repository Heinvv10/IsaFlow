# Controlled bank UI implementation

Base 11ddcd325; isolated feat/mcp-bank-controls-ui-20260909. Owner snapshot_capture. Root approved earlier UI design and this bank reviewer contract extension. No changes to legacy approvals, migrations or registry.

## Backend prerequisite, tests first

- bankControlReadService.ts: optional approvalId mutually exclusive with intentId; require current bank and approval read rights. Default saved-list/intent-detail remain maker-only.
- bankControlReadQueries.ts: exact company, bank, entity type, operation and requester association before selecting a reviewable saved intent. Only explicit approval-addressed selection permits another requester. Return that exact approval summary.
- bank-control-state.ts keeps authenticated GET delegation and safe responses.
- bankControlReviewer.int.test.ts + bankControlReadFixture.ts: real cookie HTTP and PostgreSQL independent reviewer read, denied approval rights, foreign/wrong bank/mixed refs, own-list isolation.

## UI ownership and sequence

Use existing bank page visual language. New API client/controller and exact-plan review dialog prepare then show server-saved instructions, request approval, display pending state, refresh/resume, execute only exact approved references. Existing useBankTxActions routes accept/reverse/batch into this flow; split modal passes exact decimal strings. New bank-control-approvals inbox/detail page allows a different authorized human to inspect exact saved plan and approve/reject. Nav adds this page; legacy approvals stay intact. Extract oversized hook/page rather than editing oversized table.

Before these UI edits, inspect current files and send the precise extraction/file ownership plan to root. Actual browser fixtures must exercise maker request → independent human decision → maker execution and refresh. Unit/controller refusal scenarios precede implementation; backend tests cannot substitute for browser proof.

## Acceptance

Preserve normal default invoice application selection, refund gross directions with no invoice applications, VAT exact amounts, split decimal strings, explicit inverse date/reason. No success toast or posted count for pending work. Current permission/stale-source rechecks remain authoritative. Persisted server intent and approval recover after refresh. No production verification or programme completion claim from this bounded task.

## Evidence

Reviewer tests-first32e3171d4; actual35806 had authorized reviewer400 unsupported approvalId (capability RED), denied-right400 vs403 was old-schema specificity, foreign/mismatch refusal already passed. Implemented approvalId-only owned-bank derivation; optional bank must match, intentId exclusive, server requesterIsCurrentPerson boolean, exact referenced approval summary, original ownlist isolation. Three actual reviewer HTTP/PG50949 pass; source TypeScript and scoped reader ESLint51187 terminal0. Root requested additive current signed bankAmount field separately for plan preview; its tests and implementation remain next.

UI client initial missing-module RED0a5a74→4units e3bcc0; workflow hook missing-module RED2266d1→3component units6a0032. Actual existing accept/batch/reverse handlers3RED91edb4→3GREEN986de6 after delegation to explicit workflow, keeping pending selections and no posted success. Initial reverse test fixture lacked window.confirm; corrected before accepting genuineRED. UI/page/dialog/browser integration remains unverified and uncommitted separately.

2026-09-10 recovery: root independently reviewed and integrated32e3171d4+d19df646f reviewer extension. Actual23838 missing bankAmount RED expected signed -115.23, received undefined; approved additive current owned field now implemented, focused GREEN queued. Dialog/hook/actions9component tests bee937 passed; reviewer detail missing-module RED257e24→3component GREEN4e4b46 covers explicit independent decision, self-decision UI denial and authority failure hiding details. These are frontend tests, not actual browser acceptance. Page/dialog mount, split modal, inbox/nav, URL resume and real two-person browser workflow remain outstanding.

Current signed bankAmount actual4150 focused GREEN then final71681 all4 reviewer HTTP/PG GREEN (alongside9 dimension PG). Exact existing owned row amount::text returned; no extra source authority or mutable-to-immutable claim. Source TS99963 and scoped backend lint13509 passed. Dimension source isolated in dc6cf2294; inbox/detail/split/page UI work remains uncommitted and not browser verified.

## UI implementation checkpoint, browser acceptance pending

New client/workflow/dialog, exact-plan summary, independent reviewer detail/inbox, URL resume, page/nav and split flow are wired. Pending never increments posted success; maker execution sends only exact intent/approval identifiers. ApprovalId review loads the authoritative saved plan; own requester cannot decide through UI. Inbox preserves nextCursor through other authorized domain rows. Split sends decimal strings and requires exact zero remainder rather than legacy one-cent tolerance. Existing oversized page extracted into249-line controller,182-line view and6-line page; existing action hook300lines. Transfer is an explicit outstanding root-owned restoration dependency, not claimed complete.

Tests: detail missing-module257e24→3GREEN4e4b46; inbox missing-modulea1f856→2GREENcf5a83; existing split actual2RED92071 (raw posting and one-cent tolerance)→2GREEN8b3839; resume missing-module2fe8fd→2GREEN0e4bbb. Combined18 component tests1257a6 passed; client4units53930 separately passed (component config excludes service tests). Source TS86584 passed; scoped UI lint46701 found one ref write during render, moved to effect, focused lint/resume53930 passed; final TS54912 terminal0.

Required next: independent named UI source review; isolated actual Next build and real browser maker→request→refresh→independent human approval→maker execution through UI plus reversal/split/tenant and stale cases. Browser fixtures must use genuine cookie identity and PostgreSQL; no mocked auth/routes and no backend helper decisions substituting browser action. No production or full UI acceptance claim at this checkpoint.
