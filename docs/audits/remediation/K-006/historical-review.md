# K-006 historical boundary

No durable foreign-account write was reproduced: both valid and foreign submissions on baseline9cfe3ab2 fail on nonexistent header total columns. Migration509 independently rejects the old source; migration501 resolves covering periods but leaves dates with no covering period unresolved. These observations concern the disposable current-schema fixture, not every historical schema or production execution.

historical-impact.sql is read-only and requires an explicit company parameter. It inventories legacy markers and the restored manual/reference marker, showing line ownership gaps, debit/credit totals and missing/mismatched periods without foreign account names. A privileged, deliberately malformed disposable row proved detection; that synthetic control is not an exploit reproduction. No production inventory or repair was run. Any eventual correction requires per-company evidence and approved accounting treatment.

The positive workflow reconciles journal lines, account cache and trial balance for non-control asset/equity accounts. It does not establish AR/AP subledger reconciliation for all possible control-account opening balances. Repeated POSTs intentionally create additional journals; this change does not promise idempotent retries or fix numbering races with other journal writers.
