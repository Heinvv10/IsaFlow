# Mandatory audit execution boundary

Root isolated tree based845801e31, worker protocol contracts b2c5bfd64/0d6e821f1. Own auditJobPoller.ts, production scripts/forensic/run-audit-worker.ts and existing poller caller tests. Invoice worker owns actual subprocess parent/entry/build implementation separately.

1. Tests-first: missingexecutor refuses beforequeueconnection; configuredexecutor receives onlyidentity+AbortSignal afterdiscovery client release; failedisolation reports observation withoutinlinefallback.
2. Poller requires explicit executeJob, no runtime import or hidden default to runAuditJob. Existing narrow service/HTTP tests explicitly inject their in-process executor and remain labelled as such. Production CLI must configure actual isolated runner from trusted Node/artifact paths, validate readiness and onlylog bounded process observations.
3. Actual PostgreSQL poller regression and actual process queue publication/cancellation/permissionrecheck/recovery through production executor; no unit wrapper counts as subprocess proof. Source TypeScript/scoped lint/named independent review required after parent integration.
4. Final CLI build/runtime path test and large dataset acceptance before programme completion; production deployment not authorized.

Progress: tests43db6567c reproduced3actualRED then11focusedunitGREEN after requiredexecuteJob injection. Existingservice/HTTP integration fixtures explicitly inject inline runner, preserving their limited scope. ProductionCLI now requires trusted Node/artifact envpaths and calls actual isolatedrunner readiness thenexecutor; worker parent module is not yet cherry-picked, so source TypeScript/realCLI execution are deliberately pending and this staging branch is not integration-ready. Scoped source+CLI type-aware ESLint82013 passed using explicit allowDefaultProject for the script (initial95793 parser-project coverage failed; no rules disabled). No PG run yet after injection.
