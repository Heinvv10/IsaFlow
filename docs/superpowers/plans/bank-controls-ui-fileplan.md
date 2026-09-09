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
