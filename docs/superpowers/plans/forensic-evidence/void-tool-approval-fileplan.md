# Payment void MCP approval contract

Root-owned adapter integration from8f008e719. Shared non-bank void correction is independently authored291b57c9b and must pass review before integration. Owned files: src/lib/mcp/tools/writeVoidPayments.ts and tests/unit/mcp/voidPaymentTools.test.ts.

The registered void_receipt and void_payment tools must accept required approval_id, optional prepared bank inverse intent_id, optional reason, and existing reversal_date/idempotency_key. Forward exact identifiers to the shared controlled services using the authenticated MCP context. IDs are references, never proof of approval; executing services recheck current authority, person separation, ownership and operation binding. Bank-backed operations must reference the already prepared inverse intent. No SQL or new approval logic belongs in the adapter.

Tests-first84af46740: actual2RED/10pass demonstrate omitted required approval schema and missing refusal/forwarding; corrected12unit tests pass. These tests mock only the shared service to verify dispatch; they are not economic/authorization proof. Shared author14actualPG establishes the new controlled lifecycle separately; full actual HTTP successful void workflow remains pending integration/rebuild. Scope remains write:invoices plus write:post. No metering or registry-name changes.
