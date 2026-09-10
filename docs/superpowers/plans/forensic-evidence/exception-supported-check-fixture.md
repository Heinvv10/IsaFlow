# Exception supported-check fixture correction

Base `21c8252f3`; test-only scope. Actual focused baseline: 1 failed,
15 passed, 16 tests, 564 ms (`exception-check-fixture-red.log`). The failing
invalid-check array still expected `payroll_control_checks` to throw.

Current `EXCEPTION_CHECK_VERSIONS` defines all six required checks:
duplicate_invoice_checks, payment_risk_checks, three_way_match_exceptions,
journal_risk_checks, bank_statement_completeness, payroll_control_checks.
`controlExceptionRecheck.ts` maps payroll to the actual checker and requires
current `read:payroll`; this is supported behavior, not an invalid name.

Changed only that invalid fixture name to `unknown_control_check`. Every
assertion and all supported-check source contracts remain unchanged. Focused
rerun: 16/16 pass (`exception-check-fixture-green.log`). No production, registry,
schema, PG or heavy static changes/runs. Root independently reviews this named
test/doc commit before integration; full integrated CI remains required.
