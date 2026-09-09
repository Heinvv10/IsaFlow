# Completed export readers

Base3f7c76ba2; isolated mcp-forensic-export-readers-20260909. Own auditExportReadService.ts, auditExportReadHeader.ts if needed, dedicated unit/integration tests and synthetic fixture helpers, this plan. No schema/job/registry edits.

getAuditExportFiles(ctx,{jobId,limit?,cursor?}) returns jobId,generation,fileCount,files,nextCursor. Strict detached input, canonical zero-based cursor, limit1..100 default100. Query only owned succeeded job whose export result equals its own ID and current generation, join immutable result and encrypted original intent. Open exact audit_export request, recheck current caller reports and all recorded permissions; read authenticated retained index metadata and compare canonical snapshot hash and exact permission set. Open branded export header with identity from request plus result lease/current generation, require identical header permissions.

Any currently permitted tenant member can read retained completed exports, including after the original requester token/delegation expires or is revoked. Read authority is the current issued caller, never the stored original grant. Reads do not render, load whole snapshot/manifest, enqueue or claim.

Page only <=100 consecutive authenticated descriptors and exact expected count. readAuditExportChunk(ctx,{jobId,fileOrdinal,chunkOrdinal}) validates one exact file descriptor then one <=256KiB authenticated chunk, returning file descriptor, ordinal and bytes. Every query explicitcompany predicates and generation/lease association. Missing/staged/foreign/tampered/noncontiguous material refuses.

TDD: actual pure generator/crypto fixtures; unit dependency traps for whole retained blob/renderer/job execution. PostgreSQL fixtures intentionally stage genuine generator rows through test-owned storage setup and opaque queue lifecycle metadata; not end-to-end worker publication proof. Actual current-user/tenant/refusedpayroll, originalgrantrevocation with another permitted user, >100completefile pagination, missingpage/chunk/tamperedgeneration/header and inaccessiblepartial result. Full manifest reconstructed through chunk API. Request DB/heavy leases before runs.
