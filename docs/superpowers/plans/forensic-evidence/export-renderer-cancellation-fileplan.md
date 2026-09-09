# Export renderer cancellation

Base5f99823a4. Owned auditEvidenceExportService.ts, auditEvidenceExportPdf.ts, auditEvidenceExportMaterial.ts, new focused tests and this plan. No root job, migration or transport changes.

Optional final {signal?,deadlineAt?} options preserve existing callers. One deadline begins before retained load, clamps to existing60second export bound, never widens caller deadline. Check before/after retained load; async rendering loops and byte hashing yield in bounded batches. PDF abort destroys the document and removes listeners. No partial bundle returned. Existing100000record/100MiB source/1GiB bundle bounds unchanged.

TDD expired-before-read, retainedload consuming deadline, actual timer abort during large PDF and complete bundle; retain existing complete bundle/authentication regression suite. This helper cannot cancel PostgreSQL itself: root worker owns backend cancellation. Shared canonical snapshot authentication and initial bounded input detachment remain synchronous operations; cancellation checked around those boundaries.
