# Comparison delivery implementation

Base:21c8252f3. Owner:root. No migration.

- Extend src/lib/mcp/tools/auditDelivery.ts with compare_audit_snapshots and audit_comparison_items. Enqueue accepts only ordered source UUIDs and retry key, derives authority through issued context, and checks both original signed headers before registry replay. Results use the bounded shared reader.
- Update flowMetering.ts, clientMetadata.ts and exact registry/discovery tests; expected163 tools,91 reads,72 writes,32 post-required. Both audit tools remain free and require read:reports plus current original source permissions.
- Add pages/api/accounting/audit-comparisons.ts: authenticated CSRF-protected POST enqueue and authenticated GET bounded results. Preserve existing unrelated audit-exports PDF product.
- Extend focused contract tests and actual default-registry local HTTP harness with queue/status/result, current source permission revocation before replay, cross-tenant refusal, malformed inputs, and immutable original versus changed second snapshot. Exercise real REST with cookie identity. No foreground worker or source scan.
- RED scenarios: missing registered tools; forged source hashes/permissions; missing second source; oversized/invalid page; queued result unavailable; revoked permission on prior successful enqueue replay; human REST follows identical service restrictions.
- Integrate verified paging dependency before implementation checks. Focused tests then serialized actual PostgreSQL/HTTP and TypeScript/lint. Independent named-commit review before integration.

## Verification checkpoint

Tests-first5fa5e90e4: two genuine missing-tool RED, seven existing tests passed. Added frozen manifest/current metadata/metering and strict public tools; registry now163 =91 reads/72 writes/32 post-required.341focused contract/metadata cases passed.

Actual default MCP HTTP82714: two cases passed; full-digest case exposed missing version/companyId/permissions in public pages. Root confirmed and worker corrected with unit45c641e0c RED then21d2a8e31. Six actual paging tests now independently reconstruct digest from public pages only; source/test TypeScript and lint32169 passed. Reviewed dependency included in this branch separately from transport commits.

Corrected actual default MCP HTTP15080: all three cases PASS,21.17s test time. Real PAT HTTP uses actual Next API resolver, authentication, default registry and shared services. Tests concurrent same-key enqueue, queued no-work read, original-person worker publication, complete paged independent digest, original ordered identities/change, second authorized reader, current payroll/banking denial before cached retry using another token, foreign references and malformed authority. Worker invoked in process; separate cold-process proof belongs to comparisonDispatch suite. Not a built-Next or complete financial supplier workflow claim.

Full source TypeScript passed. Dedicated test TypeScript initially exposed five pre-existing/current fixture type mismatches; typed permission spy, existing asserted company property and current approval/unwind result fixtures corrected without changing assertions.65627 terminal0: dedicated TypeScript, source and typed-test lint,432 units in7files PASS. Two unused read-test symbols removed;15189 final scoped lint zero warnings and33 read tests PASS. No production edits after successful HTTP.

Independent snapshot review925d2433e versus eb144aafb: all9changed paths plus earlier unit contract, no additional blocker beyond corrected public metadata. Exact census independently verified. Final107ed57bc fixture correction submitted for follow-up review. All root pools/processes closed; no final integrated CI or production verification claimed.
