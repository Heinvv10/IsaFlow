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

Post-checkpoint visibility regression: the preserved empty-bank-account branch omitted the new dialog, hiding saved-link authority errors for a tenant without bank accounts. Existing-view component RED fa52c9 → one GREEN6bfeb2 after mounting the same dialog in that branch; scoped view lint76125 terminal0. Actual browser fixture/run remains next; source TS54912 predates this single reused-component mount.

## Actual Next/browser checkpoint

Build86399 terminal0: dedicated browser harness TypeScript followed by `bun run build`, source9441023af. Private `/tmp/isaflow-bank-ui-20260910.env` uses validated33149 fixture, fresh synthetic keys and loopback33379. Root explicitly allowed required static `NEXT_PUBLIC_ADMIN_URL=https://admin.isaflow.co.za` for production validation; this does not authorize any external connection. Browser aborts every nonloopback request; actual app/privileged DB URLs match fixture, auth/storage remote origins fail closed locally. Original server50537 failed required-env checks, was verified/terminated and terminal0; current server48342 PID3091876 remains idle (~177MiB RSS).

Harness command: `source /tmp/isaflow-bank-ui-20260910.env && bun run scripts/forensic/bank-ui-acceptance.ts`. Fixture failures kept distinct: omitted separate PGPASSWORD caused SCRAM error; corrected local env. users.id varchar vs uuid[] caused42883; corrected fixture to text[]. Browser36277 then completed actual maker request/refresh, disabled self-decision, independent reviewer UI approval, maker execute and exact VAT journal; test incorrectly switched to Reviewed tab although allocated rows remain on New tab. Partial proof `/tmp/isaflow-bank-ui-c47549de-dfea-47e8-84ad-7aeb910782db/failure.json`.

Browser92072 completed four actual cycles (account VAT, reversal, supplier refund, customer refund), then test alert selector also matched Next route announcer. Browser99232 completed four cycles plus backdated same-amount source refusal with no retained operation effect; final foreign-tenant UI assertion expected raw not-found wording but correctly received public `Bank control state unavailable`. Corrected dialog-scoped/public-response assertion and added actual HTTP400 check; not rerun yet. Latest partial proof `/tmp/isaflow-bank-ui-3ed67eb1-93c2-4fde-aff7-4ff726fba265/failure.json`. All browsers/fixture pools closed; PG/heavy released to invoice100k. No full browser pass claimed.

Next: final corrected harness run after lease release, independent review of harness, then split/default-application browser extensions. Transfer browser integration remains dependent on root shared restoration. No production verification.

Final scoped browser78895 terminal0 on 2026-09-10: named harness7002bee1f against production build9441023af passed account VAT, controlled reversal, supplier inbound refund and customer outbound refund through actual maker request → persisted refresh → separate human reviewer UI decision → maker execution. SQL confirmed consumed approvals, exact VAT lines, refund absence of payment children, and backdated same-amount source refusal with no effect. Foreign-company saved-link GET returned400 and public unavailable state without execution. Evidence: `/tmp/isaflow-bank-ui-89f48b75-d960-4d55-85f2-c717bf063417/evidence.json`, maker-final.png and reviewer-final.png. Chromium/fixture pool closed; PG released to root. Server48342 retained idle under root coordination.

Root independently reviewed7002bee1f against9441023af clean for this scope. Authentication uses synthetic signed cookie JWTs through real middleware/current DB membership, not GoTrue login issuance proof. Initial dedicated harness TS/build86399 passed; latest harness refinements still need final dedicated TS/lint. Split, normal customer/supplier default applications and transfer browser cases remain outstanding; this is local synthetic verification only. Next extend split/default browser fixtures, then adopt root's pending-transfer relink response once available.

Next tests-first browser extension authored (not run): exact split100.01+15.22 through split modal→saved plan→independent approval→split execution, with real GL assertions; normal customer oldest applications100+50.23 against two draft invoices approved through actual cookie REST before the bank browser cycle. Existing product remains unchanged. Supplier normal payment prerequisite requires real beneficiary evidence/verification and is next. Dedicated final harness TypeScript61972 passed before these extensions; subsequent ESLint refused excluded test/script files at project-service configuration, not a source diagnostic. Dedicated lint configuration correction remains pending.

Supplier default browser extension also authored before execution: local captured evidence HTTP fixture plus actual shared beneficiary proposal by maker and verification by a second cookie principal; two draft supplier invoices approved through real cookie REST; bank browser request/reviewer decision/execution must bind100+50.23 oldest applications and produce a child payment with exact invoice paid balances. No direct SQL approved/verified states and no helper decisions for bank operations. These new scenarios are still unrun; failures must distinguish prerequisite failures from browser behavior.

Extension static verification90495 terminal0: dedicated TypeScript and typed ESLint passed all three harness/fixture files at7e4a1c11a. ESLint uses the dedicated three-file tsconfig with projectService disabled; the earlier excluded-file parser refusal is resolved without suppressing source rules. Heavy lease released. Existing product944 server PID3091876 remains live (~178MiB RSS); extended actual browser execution awaits serialized PG lease.
