# GL future mutation capture: proposed scope at 7bb9f5e19

Status: source audit and proposed tests only. Root must freeze implementation ownership/authority before production edits. No database, runtime tests or heavy checks run. Existing Phase2 reader supports owned `gl_account` exact protected values; absent old events remain untracked. That historical limitation does not waive capture for future writes.

## Named source inventory

Case-insensitive literal SQL scan of src/pages at 7bb9f5e19 found 23 `gl_accounts` mutation statements in 11 files. None of these files calls recordCommittedChange. This is an application-source inventory, not proof that migrations, SQL functions or external jobs never mutate the table.

| Writer, named line | Actual operation and caller |
| --- | --- |
| gl/chartOfAccountsService.ts 271/339/380/465 | create, rename code, ordinary update, soft deactivate. REST chart-of-accounts.ts and chart-of-accounts-detail.ts; MCP writeGlAccounts.ts. Existing parent/subtype/posted-balance/system-account guards remain. |
| gl/accountReclassifyService.ts 215/237 | subtype, parent, root level, descendant levels. REST chart-of-accounts.ts PUT calls this then updateAccount; MCP writeGlAccounts.ts does the same. Must capture every changed descendant, not only returned root. |
| gl/chartOfAccountsImportService.ts 163/179 | template INSERT ON CONFLICT DO NOTHING then parent wiring. REST coa-seed.ts. Repeat may change parent links even when no insertion occurs. |
| gl/accountMergeService.ts 169/190/200 | children reparent, descendants relevel, source deactivate. MCP writeMergeGlAccounts.ts. Already locks source/target and records gl_account_merges plus moved-line digest/notes. Those records must remain; new account events do not replace economic merge proof. |
| gl/openingBalanceEquityService.ts 113 | find-or-create reserved equity account. MCP writeOpeningBalance.ts resolves default only after refusals, before real journal posting. Existing account must be a no-op. |
| bank/bankOpeningBalanceService.ts 56 | opening amount/date metadata after MCP opening journal. Must be atomic with journal, implicit equity creation and evidence. |
| core/migrationCoaService.ts 154/198/210 | session COA upsert plus exclusive system-role demotion/promotion. REST migration/chart-of-accounts.ts. Reports invalid/skipped rows; catches row errors; session summary follows writes. |
| core/migrationExecuteService.ts 73/225 | imported account upsert batch and source rollback hard deletion. REST migration-execute.ts / migration-rollback.ts. Account batch uses neon transaction helper; opening/customer/supplier phases report separate errors. |
| pages/api/accounting/bank-accounts.ts 75/103 | group parent assignment plus bank/account metadata update, including secret bank fields. Direct route SQL bypasses chart service; route catches failures as 400. |
| pages/api/accounting/default-accounts.ts 116/129 | clears existing managed system flags, sets selected flags/subtypes in withTransaction with app_settings mapping. Must capture displaced accounts too and keep setting change atomic. |
| admin/services/sageMigrationCommitService.ts 191 | account INSERT ON CONFLICT DO NOTHING under existing per-record savepoint. pages/api/admin/migration/sage-commit.ts invokes through withAdmin/withPlatformAdmin; platform middleware has ALS BYPASSRLS transaction but no company-issued ControlTx. |

No runtime scheduler caller to these exact exported functions was found in src/pages at this commit. A future job must use an actual issued tenant job context/current authority and the same shared capture; never infer an actor from userId arguments. Platform-admin Sage import is an actual additional integration gap: it needs root-owned authenticated target-company admin delegation, not a fabricated cookie or company from an untrusted body.

## Proposed owned implementation files and seams

First bounded implementation tranche (subject to root freeze): new gl/glAccountChangeControl.ts and gl/glAccountChangeRows.ts; chartOfAccountsService.ts (split existing 300+ line file into mutation helper if necessary); accountReclassifyService.ts; chartOfAccountsImportService.ts; accountMergeService.ts. Dedicated glAccountChangeControl unit/PG fixture suites and this plan. No registry, shared crypto, principal, contracts or migration changes.

Second explicit follow-up tranche: openingBalanceEquityService.ts, bankOpeningBalanceService.ts, core/migrationCoaService.ts, core/migrationExecuteService.ts; extract direct REST writes into new bank/bankAccountSettingsService.ts and gl/defaultAccountSettingsService.ts, leaving existing route schemas/responses and guards. Sage service plus platform-admin delegation requires separately frozen root ownership. All are required future capture coverage, not excluded permanent exceptions.

Proposed internal helper shape:

```ts
withGlAccountChanges<T>(ctx: ControlTx, spec: {
  action: GlAccountChangeAction;
  authority: GlAccountMutationAuthority; // fixed by trusted service, never body
  selectAffected: () => Promise<OwnedGlSelection>; // IDs/codes, recursive scope
}, mutate: (capture: GlAccountCapture) => Promise<T>): Promise<T>
```

`OwnedGlSelection` describes exact owned existing IDs, planned new codes and affected tree/role selectors. Helper acquires current caller authority and common company account-mutation advisory lock before deterministic account/version row locks; then re-evaluates selectors under the lock. Existing merge glAccountLock ordering must be preserved after this new outer lock. New code serialization handles absent rows/upsert races. No caller-provided before/after material is accepted: helper queries exact owned database rows itself before and after mutation. `capture` can report newly inserted IDs from RETURNING, but helper re-reads and verifies their owned source identity before recording. Empty/suppressed RETURNING or missing expected row throws before an apparent successful result. Post-mutation capture covers deletes using retained originals.

SQL projection should use explicit owned `to_jsonb(row)` or named raw DB columns, retaining decimal strings, nulls, full classification/parent/level/system/VAT/default/opening metadata and timestamps. The human GLAccount mapper is not an evidence serializer (it drops columns and normalizes nulls/defaults). A meaningful no-op comparison excludes only updated_at; when substantive values change, exact original/result rows including actual timestamps are retained. Secret fields go through existing protectChangeValues; public audit stays sanitized and authorized reader explicitly redacts bank credentials. No new crypto or plaintext logging.

Use recordCommittedChange(ctx, entityType='gl_account') with the current locked control_entity_versions row. First observed mutation of a legacy account uses previousVersion=null/newVersion=1 with its real non-null before image and actual mutation action, not a fabricated historical create. Existing event versions increment exactly once per distinct changed account in each shared operation. One logical create/template operation retains final wired parent state; no synthetic intermediate null-parent event. Rename unchanged, already inactive, identical update/template/upsert and existing equity lookup emit no event and advance no version. Descendants actually changed each receive an event; untouched target siblings do not.

Whole shared operation and events use one real issued transaction/savepoint. Mandatory evidence failure must preserve recordCommittedChange's controlWriteFailed semantics so callers catching errors cannot commit the mutation. Existing partial import semantics require a deliberate split: ordinary validated row refusals can remain skipped before mutation, successful records must have evidence; evidence storage failure cannot be swallowed into a successful import summary. Keep existing transactional batch rollback and merge records. Composite REST reclassify+update must retain current failure rollback; do not introduce a partial commit or a success-shaped 400.

Authority requires root freeze: ordinary account CRUD/reclassification/merge/template uses current write:accounts (per-entity account-range constraints where supported), never only token scope. Current constrained permission supports existing account IDs, not proposed new codes; do not silently broaden constrained creation. Existing set_opening_balance intentionally uses write:journals + write:post and may create its default equity account: preserve that narrow trusted operation rather than blindly adding write:accounts to this legacy capability. Bank metadata needs current banking write authority; import paths need current imports authority plus the agreed account mutation policy. Helper authority options must be closed internal operations, not generic permission strings or caller overrides. Root must define the admin target-company case.

## Tests-first acceptance proposal

New tests/integration/controls/glAccountChangeCapture.int.test.ts + small real issued cookie/PAT fixture; pure tests only for exact row normalization/no-op diff. First actual RED invokes unchanged real createAccount then reads control_change_events expecting one exact owned event. No blanket assertControlTx mock and no hand-inserted event substitutes for producer proof.

1. Create, rename, update, deactivate: real public functions; actual event/protected envelope before/after; monotone version; nested classifications and VAT/default fields preserved. Faithful reader sees exact authorized nonsecret values. Legacy first edit has real before; old history remains untracked.
2. No-op repeated calls and rejected subtype/parent/system/balance/code changes leave event/version/account unchanged. Parent foreign and revoked current accounts authority refuse before mutation; PAT scope still broad but current override revoked.
3. Reclassification across levels with children/grandchildren: exact event count equals actual changed account set; descendants correct; unrelated siblings/foreign company untouched; cycle/depth/bank-reference guards retained.
4. Merge with movable lines: original moved-line ID/digest/merge record remains; capture all changed children/descendants/source only. Count-race, protected evidence insert failure, merge-record failure roll back account, ledger/reference moves and all events.
5. Template new chart and repeat: complete final parent graph, existing no-op rows no synthetic create, changed existing parent wiring captured; no first-page account omission. Instrument actual affected-row count, then query/capture batches without arbitrary total population caps. Large import resource acceptance must be measured before choosing a foreground ceiling; no unsupported cap/async claim.
6. Real two-client concurrent mutations serialize and produce consecutive original/result versions; concurrent same new code yields existing business duplicate behavior with no orphan evidence; evidence failure including suppressed INSERT RETURNING aborts operation even when caller catches it.
7. Follow-up imports: upsert existing/null fields, newly inserted accounts, old/new system-role holders, invalid row skip, account-batch rollback, source hard deletion and after=null. Capture rows committed, not requested/imported counters. Preserve named import session/company identity and current rights.
8. Follow-up opening and REST: full opening post/equity creation/metadata transaction; forced journal/evidence error leaves no account or metadata; repeated existing account no-op. Bank parent+metadata update failures and default mapping displaced-role changes fully roll back; plaintext account/branch values never in public history/logs. Actual cookie REST and real MCP shared boundary test, not route wrappers only.
9. Follow-up Sage/admin/job: actual authorized target-company principal, original recorded person/delegation/current grants; source body cannot select unrelated tenant. Missing issued context refuses; actual job authorization must be implemented centrally before claiming caller coverage.

Baseline economic regression suites to preserve: accountReclassifyDb; accountMerge{ExecuteDb,LockDb,RecordDb,CallsLockDb}; chartOfAccountsPutPartialCommit; openingBalanceEquityService/openingBalanceEquity.integration; migration COA map/import tests and bank metadata route tests discovered in the frozen tranche. No tests executed in this planning turn. Root grants synthetic PG/heavy lease for the first genuine producer RED after scope freeze.
