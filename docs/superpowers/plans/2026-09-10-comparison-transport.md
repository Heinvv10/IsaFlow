# Comparison delivery implementation

Base:21c8252f3. Owner:root. No migration.

- Extend src/lib/mcp/tools/auditDelivery.ts with compare_audit_snapshots and audit_comparison_items. Enqueue accepts only ordered source UUIDs and retry key, derives authority through issued context, and checks both original signed headers before registry replay. Results use the bounded shared reader.
- Update flowMetering.ts, clientMetadata.ts and exact registry/discovery tests; expected163 tools,91 reads,72 writes,32 post-required. Both audit tools remain free and require read:reports plus current original source permissions.
- Add pages/api/accounting/audit-comparisons.ts: authenticated CSRF-protected POST enqueue and authenticated GET bounded results. Preserve existing unrelated audit-exports PDF product.
- Extend focused contract tests and actual default-registry local HTTP harness with queue/status/result, current source permission revocation before replay, cross-tenant refusal, malformed inputs, and immutable original versus changed second snapshot. Exercise real REST with cookie identity. No foreground worker or source scan.
- RED scenarios: missing registered tools; forged source hashes/permissions; missing second source; oversized/invalid page; queued result unavailable; revoked permission on prior successful enqueue replay; human REST follows identical service restrictions.
- Integrate verified paging dependency before implementation checks. Focused tests then serialized actual PostgreSQL/HTTP and TypeScript/lint. Independent named-commit review before integration.
