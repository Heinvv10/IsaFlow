# Staged import history kind metadata

Base b51bf6296. Owned source files: new historicalImportSourceKind.ts,
controlChangeHistoryPolicy.ts, historicalImportSourceService.ts and
historicalImportPreparation.ts (kind metadata only), plus focused tests.

Confirmed gap: source staging records an event but source history requires a later
prepared import solely to determine its read domain. Tests first cover genuine
small/large unprepared staging, current revoked domain, foreign source, altered
validly encrypted original and corrupt kind metadata.

New bounded protected staging metadata will bind kind to original ciphertext SHA256,
envelope version/key ID, source identity, content and normalized hashes. SQL computes
the ciphertext digest and returns a bounded protected metadata envelope, not source
bytes. Legacy events may use a bounded original-source decode or verified prepared
lookup; missing/unavailable evidence refuses. No source or historical event rewrite.
Current domain checks remain mandatory; no blanket read:imports bypass.

PG and static execution pending exclusive orchestrator lease. No result claimed yet.

## Implemented candidate `3694761b7`

`historicalImportSourceKind.ts` authenticates the original staging event's bounded
protected kind proof. It binds company ID, source ID, content/normalized hashes,
original envelope version/key and SHA256 of ciphertext UTF-8 bytes. PostgreSQL
computes the same field digest; no JSON serialization equivalence is assumed.
New stage events include this proof and new preparation events include kind.

Policy still requires current audit/import/domain rights. Legacy small source
artifacts can be decoded under a 64KiB SQL transfer cap. Large legacy staged sources
without proof or a prepared kind remain unavailable. Existing prepared-kind lookup
remains compatible; corrupt or mismatched protected metadata refuses before that
fallback. No original source or past event is rewritten by production code.

Validation, isolated synthetic PostgreSQL only:

- Tests-first commit `cf4fde769`: genuine small/large staged-unprepared history
  failed with `History domain metadata unavailable`; 2 RED / 3 PASS, handle 59691,
  terminal 1, 1.11s. Log `import-history-kind-red.log`.
- Initial implementation: 5 PG PASS, handle 19171, terminal 0.
- Final integration run: 9 new PG plus all 11 existing entity-history cases,
  **20 PASS**, handle 37277, terminal 0, 6.10s. Log `import-history-kind-full.log`.
  Includes genuine large source (original envelope >64KiB), SQL transfer-bound
  observation, original bytes unchanged, revoked reports, foreign source, validly
  encrypted changed original, corrupt protected proof, old small source, explicit
  old large missing-proof refusal, actual large preparation compatibility, and
  correctly encrypted proof claiming another company.
- Three actual-crypto unit cases **PASS**, handle 57895. Initial unit run 85995
  used a too-short synthetic encryption key (fixture-only error); corrected key.
  Logs `import-history-kind-unit.log` and `import-history-kind-unit-green.log`.
- Dedicated strict transitive TypeScript and typed ESLint across all six changed
  source/test files **PASS**, handle 16377, terminal 0. Log
  `import-history-kind-static.log`. Subsequent unit change only lengthened a string
  literal synthetic key; no production source changed after this check.

Logs reside in `.worktrees/mcp-forensic-artifacts-20260909`. Independent named
review requested from root; no final CI, remote delivery or production verification
is claimed. Heavy execution lease released.
