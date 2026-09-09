# GL shared posting and reversal writers

Base `7515bdb8`, isolated branch `feat/mcp-forensic-gl-writers-20260909`. Dependencies: root `208e2fab`, `03dd42a5`, and the paired generic-dispatch commits `3a9c7198` + `3f74ebda`. Earlier core and generated-relationship checkpoints are `bb745eb2`, `06ad9d5e`, and `eb56d6d1`.

`materializeGlOperation(ctx, ref)` derives journal.post/reverse material from locked owned company, journal, lines, accounts and original/target fiscal periods. Currency comes from persisted companies.default_currency without a fallback. Text numeric lines use a private exact decimal context; positive balanced amounts and source fingerprints include classifications, account state, periods and company currency/lockdown. Explicit reversal dates bind the target date. The default uses the original open date or database-clock SAST day. Missing, ambiguous and foreign material refuses.

The shared post/reverse services now require the active authenticated context and reject supplied company/person mismatches before financial access. Standalone writes execute through the generic approval kernel. Existing draft/posted status, open period, lockdown, inactive-account and balance guards remain enforced. Reversal uses the frozen permit accounting date, creates one linked contra and copies line values with SQL INSERT SELECT and swapped debit/credit, avoiding floating-point conversion. The original stays posted with its reversal marker. Returned journal DTOs omit undefined optional fields before canonical effect-result serialization.

Generated journals use asynchronous registerGeneratedJournal(ctx, parentControl, journalId, operation), followed by assertGeneratedJournal. A WeakMap binds the live parent permit, exact authenticated principal, journal and allowed child operation. Registration checks the persisted owned parent relationship: new AP journals require the expected auto supplier source and source_record_id; existing AP reversals require the actual gl_journal_entry_id link. Cancellation/void contras require reversal_of_id to that owned posted original, draft status and matching source. Standalone journal reversal contras also require the frozen accounting date. Generated execution writes its encrypted before/after event in a savepoint, and failures poison the outer control transaction. There is no transport skip flag.

## Evidence

2026-09-09, Node 22.23.1; focused commands only:

- Initial core modules absent: genuine RED (`/tmp/gl-material-red.log`).
- Four shared-writer regressions failed against the old writer: missing context, forged person and absent execution gate (`/tmp/gl-writer-red.log`).
- Missing persisted relationship failed against synchronous registration (`/tmp/gl-relation-red.log`).
- Real legacy AP contra registration refused under the original predicate (`/tmp/gl-legacy-contra-red.log`); the corrected relation passes below.
- Initial full database run exposed undefined optional result fields: five failed, five passed (`/tmp/gl-writers-result-red.log`). Explicit DTO projection fixes serialization without weakening material canonicalization.
- Final focused unit suite: **22 passed**, three files, 649ms (`/tmp/gl-writer-green.log`). Includes exact large decimal material, capability lifetime/context/operation and writer guards.
- Final real PostgreSQL suite: **10 passed**, 2.02s (`/tmp/gl-writers-pg.log`). Runs actual app_user authenticated transactions against the explicitly opted-in synthetic localhost:33149 fixture; random owned tenants and pools are cleaned up. Database lease returned after completion.
- Focused TypeScript: exit 0 (`/tmp/gl-writer-types.log`). Source ESLint: exit 0 (`/tmp/gl-writer-lint.log`). Code files remain within 300 lines; git diff whitespace check passes.

The ten PostgreSQL cases cover authoritative currency/exact balanced material without history mutation; changed line/account/period/company facts; foreign journal and imbalance refusal; explicit date constraints; policy-blocked posting followed by independent-person approval and durable replay with one effect; approved reversal with changed-date rejection and an exact contra netting each account to zero; arbitrary generated journal refusal; closed/inactive/lockdown guards; rollback of status/effect/events; and a real AP cancellation callback reversing a linked legacy journal through the shared GL writer.

## Scope and remaining integration

These results prove these two shared GL writers and their generic dispatcher dependency in the synthetic fixture, not every financial workflow or ingress. AP workers must integrate registration and bind their cancellation/void reversal target date into the parent material. The GL child path already consumes that frozen date and rejects an explicit mismatch; All generated journal.post registrations now also require the locked child entry_date to equal permit.accountingDate; their successful AP integration depends on that parent-material change. Alternative direct journal writers and unauthenticated jobs require their separately owned closure. Full CI, build, deployment and production operations were not run.

Independent named review of the root generic-dispatch dependency found no new confirmed blocker; the actual GL approval/replay/reversal tests exercise it. The separately reported transaction-observer COMMIT command-tag finding is owned by root and is outside these writer changes.

## Generated child date follow-up

Root review identified that persisted parent/source linkage did not itself bind the dates of AP generated drafts or contras. Six new unit cases reproduced acceptance of a mismatched date across invoice post/approve/cancel, payment process/void and journal reversal (`/tmp/gl-child-date-red.log`: six failed, five passed). Registration now selects the locked persisted entry_date as text and requires exact equality to the frozen parent permit accountingDate for every journal.post child. Registering the original for journal.reverse allows its historical date to differ from the target reversal date.

Focused unit suite: 29 passed (`/tmp/gl-child-date-green.log`); focused TypeScript and source ESLint passed (`/tmp/gl-child-date-types.log`, `/tmp/gl-child-date-lint.log`). No PostgreSQL test was rerun for this follow-up because AP owns the database lease; the earlier ten-PG result predates this added date guard. Root named canonical extension `35236915` was independently reviewed with no confirmed new finding; the AP materializer's target-date implementation remains separately owned.
