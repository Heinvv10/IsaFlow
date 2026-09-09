# Audit tool delivery implementation and verification plan

Base: ece90a620. Owner: root; isolated feat/mcp-forensic-tool-delivery-20260909.

- tools/auditDelivery.ts: eight bounded shared-service adapters for snapshot/export enqueue, job status, authenticated snapshot manifest/item/chunk reads and completed export file/chunk reads. No SQL or worker execution in handlers. Original byte chunks use explicit base64.
- toolIndex.ts/existingTools.ts: preserve the existing 133 tools in a separate assembly and compose the new tools centrally. Keep files under 300 lines.
- clientMetadata.ts and flowMetering.ts/flowReadOperations.ts/flowWriteOperations.ts: explicit discovery and free forensic controls, retain every pre-existing metering decision and keep extracted maps bounded.
- types.ts/registry.ts: optional read-only request authority callback before replay lookup. Snapshot callback derives all source permissions from strict request; export callback authenticates retained metadata and current source rights. Enqueue tools use per-user idempotency to match shared requester-owned jobs.
- Tests auditDeliveryTools/clientMetadata/registryAuthority: missing module RED, missing discovery RED, then true cached replay/source revocation RED. Assert strict input, issued context mapping, requester keys, bounded chunk bytes and permission derivation; preserve registry idempotency and metering suites.
- Acceptance still required: named independent review; actual PostgreSQL registry replay/current revocation tests; rebuilt local MCP HTTP enqueue/worker/status/reassembled bytes and every-tool refreshed contract/auth tests. Unit service mocks establish adapter contracts only. This slice does not claim complete programme tooling, export process isolation, UI acceptance or full CI.
