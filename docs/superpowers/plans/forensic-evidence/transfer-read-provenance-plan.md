# Read-only transfer provenance

Own bankControlReadProvenance.ts, new bankTransferReadProvenance.ts, dedicated actual PostgreSQL/loopback HTTP tests and fixture only. Base 6559af16d. No inverse, preparation, effect or registry changes.

Follow the current owned matched journal and immutable original/late-link receipts. Require two owned bank legs, original saved post selection, exact signed cent amounts and date window, audited parent effects and exact current feed occupation. Return one canonical original post intent for either feed. Never discover fresh candidates or access live beneficiaries, invoices or fiscal write locks. Preserve nontransfer and explicit genuine legacy-unknown behavior; missing controlled receipts must refuse.

Tests first use actual shared prepare/independent approval/execute. Actual GET via Next apiResolver and cookie authentication covers original/saved opposite/late-link canonical identity, approvalId, read-only reviewer, tenant, missing audit/receipt, metadata or line tamper and legacy unknown. No built Next process/browser claim. Serialized synthetic DB only; fixture HTTP server and pools close.
