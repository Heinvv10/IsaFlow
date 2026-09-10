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
