# Export renderer cancellation

Base5f99823a4. Owned auditEvidenceExportService.ts, auditEvidenceExportPdf.ts, auditEvidenceExportMaterial.ts, new focused tests and this plan. No root job, migration or transport changes.

Optional final {signal?,deadlineAt?} options preserve existing callers. One deadline begins before retained load, clamps to existing60second export bound, never widens caller deadline. Check before/after retained load; async rendering loops and byte hashing yield in bounded batches. PDF abort destroys the document and removes listeners. No partial bundle returned. Existing100000record/100MiB source/1GiB bundle bounds unchanged.

TDD expired-before-read, retainedload consuming deadline, actual timer abort during large PDF and complete bundle; retain existing complete bundle/authentication regression suite. This helper cannot cancel PostgreSQL itself: root worker owns backend cancellation. Shared canonical snapshot authentication and initial bounded input detachment remain synchronous operations; cancellation checked around those boundaries.

## Verification checkpoint

- Tests-first6dded76c7: four actual behavior REDs (expired deadline before retained read, consumed outer deadline, actual timer PDF cancellation, actual timer bundle cancellation), session88903 terminal1; export-renderer-cancel-red.log.
- Implementation584e037fd; further exact-once PDF abort-listener cleanup test e8d84f771. Final12 unit tests/2files GREEN, including all six existing complete bundle/authentication/PDF checks and actual8MiB copy/hash cancellation; export-renderer-cancel-final-unit.log. No unhandled stream errors reported.
- Source type-check and three-file source ESLint47288 terminal0. All heavy leases released.
- Independent root review e8d84f771 vs5f99823a4 read all3 source files/newtests and existing artifact contracts: no confirmed findings. Original canonical snapshot authentication remains synchronous and bounded; this is not isolated-memory-worker completion or SQL cancellation proof.
- Existing three PostgreSQL export tests remain pending HTTP worker's exclusive database lease release. No production work or new transport implementation.
- HTTP worker explicitly released DB/server after terminal29875 and50295. Existing actual export PostgreSQL suite now terminal0:3 tests GREEN (`export-renderer-cancel-pg.log`), source mutation preserves retained output, current payroll denial, foreign tenant/tampered artifact refusal. Fixture poolclosed and DBlease returned; bounded renderer slice verification complete pending root integration.
