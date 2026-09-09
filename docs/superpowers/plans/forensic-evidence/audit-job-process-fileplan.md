# Hard-contained per-job audit subprocess

Base30018fe07. Root owns processcontract/runner/poller/CLIintegration. Worker owns new protocol/process/systemd helpers, childentry/build helper and focused tests. No new dependencies/globalunits/currentcgroup changes.

First failing tests: strict bounded identity-only request/reply and fixed cgroup/runtime argv. Parent uses absolute trusted Node/artifact configuration, private fixed environment names without values in argv, dedicated random user service per job. MemoryMax8GiB/MemorySwapMax0 is cgroup charged memory, not a pretend RSS/heap equivalence. Parent and systemd walltime65s+2sgrace bound blocked child CPU. Child pool2/current saveddelegation bootstrap delegates to existing runner, never receives lease/principal/businesspayload. Existing SQL cancellation remains active on graceful termination.

Success reply is bounded; child briefly waits stdin EOF so parent can read actual cgroup peak before service collection. No financial source data crosses IPC. Parent may report killed/unrecorded failure but never fabricate lease-authorized DB failure writes; expiredclaim recovery stays existing90s/generationfence. Raw diagnostics are capped and never returned/logged.

Actual dedicated-unit readiness/CPUspin/smallOOM/cancellation/recovery tests need root resource lease. Full8GiBpressure/100k/1GiBscale is explicitly not yet authorized or verified. Named review and root integration required.
