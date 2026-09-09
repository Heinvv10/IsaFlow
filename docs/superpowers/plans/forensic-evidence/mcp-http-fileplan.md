# Actual local MCP HTTP foundation

Base 5f99823a4; owner snapshot_capture. Root owns registry/product integration and server/build leases.

## Gap and files
Existing 133-tool matrix mocks SQL/authority/handlers; existing mcp-smoke only checks initialize, manifest presence, discovery and unauthenticated 401. No all-tool HTTP foundation existed.
- client.ts: explicit loopback HTTP origin, reject credentials/path/query, actual bounded streaming fetch/no redirects, 650ms pacing and JSON-RPC correlation.
- fixtures.ts: existing explicitly opted-in local PostgreSQL fixture, synthetic PATs, tenant feature override, exact committed inventory/schema and actual HTTP refusals. Schema-valid samples validated locally, never substituted handlers. Every tool receives invalid extra authority property; scoped tools also receive empty-scope PAT with valid structural arguments. Actual committed invocation receipts/outcomes prove rejections without reported writes.
- contracts.int.test.ts: initial missing-module RED, target guard GREEN. Full HTTP acceptance pending real server lease.
- scripts/forensic/mcp-http-acceptance.ts: reusable acceptance runner outputs only redacted result file, no token/raw arguments.

No production fallback or financial handler invocation. No business permissions, billing settings, or production rate limits changed. Real endpoint pacing preserved. All pools closed by finally. Existing fixture synthetic identities remain as evidence.

## Acceptance and remaining scope
Require GET discovery + authenticated initialize + tools/list equality; every declared tool has an explicit structural-refusal result, applicable missing-scope result and committed rejected invocation count. Any generic/internal/permission/SQL error in place of expected validation refusal fails.

This foundation does NOT prove valid financial execution, current-permission revocation, posting-only scope denial, every nested field, UI/REST workflows, or complete Phase5/programme acceptance. Future registry growth must regenerate named executable contract; inventory mismatch fails closed.

## Evidence
- Target test first: missing ./client module RED (65b3a5 terminal1), then loopback URL test GREEN (ef117b terminal0). Actual HTTP/PG lease pending.

## Actual HTTP checkpoint
- Built integration tree exact 5f99823a4, Next build TUaBjS_7vh2XWdjDt6-hR, loopback http://127.0.0.1:33219, synthetic PostgreSQL33149. All application/admin DB URLs explicitly local; boot secrets synthetic. No production document/network financial requests.
- Initial actual fixture run refused absent migration506 reference seed before HTTP. Fixture now inserts only the existing dark mcp_connector flag ON CONFLICT DO NOTHING; company override supplies required set_by. This is reference-data fixture setup, not a new migration or global feature enablement.
- Command: vitest run --config vitest.integration.config.ts tests/integration/mcp-http/contracts.int.test.ts with explicit ISAFLOW_FORENSIC_HTTP_ORIGIN and existing validated fixture env. Handle29875 terminal0: 2 tests passed,173.10s.
- Actual GET discovery + authenticated initialize + tools/list matched all133 contract names and manifest schemas. All133 tools rejected an undeclared authority property before handlers; all131 scoped tools rejected a zero-scope PAT with schema-valid args. company_profile/list_companies have null scopes and explicit N/A scope entries. Every tool required exactly1 or2 actual committed rejected/no-write receipts and outcomes. Total264 tools/call refusals, no generic-error substitutions.
- Synthetic company5a858549-86c2-4127-8bbb-853db67ad874/person95d5acb1-a216-4292-a74a-5a4d5bd0ce2d retains database evidence; raw tokens never written to evidence.
- Server50295 stopped terminal0; fixture pool closed; DB lease released to renderer worker. Earlier incomplete boot8492/93664 stopped cleanly after required synthetic env configuration corrections.
- Dedicated tsc config included all three new test/helper files and script (normal root config excludes tests/scripts): tsc --noEmit -p .forensic-http-tsconfig.json terminal0 (834cc6). Root unchanged.
- Observed existing server API logging includes full MCP request arguments. Values were synthetic in this run; root notified to assess logging privacy independently.
- Scoped type-aware ESLint for all4 TS files used temporary extending config pointing at dedicated test tsconfig: handle66510 terminal0, zero warnings. git diff --check passed. Temporary verification configs removed before commit. Root independent named review pending.
