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

Pending reviewer RED, implementation and verification; root independently reviewing base11dd separately.
