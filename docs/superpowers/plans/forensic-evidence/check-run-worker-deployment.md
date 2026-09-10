# Check-run worker deployment prerequisite (T2b)

**The check-run worker is not deployable yet.** `scripts/isaflow-audit-check-run-worker.service` is a
template; no deploy step installs what it runs, and choosing where and how is the owner's decision.

Why it cannot run from the application directory: `/home/velo/isaflow` is the Next.js standalone build,
rsynced with `--delete` from `.next/standalone` by `scripts/deploy.sh`. That tree has neither
`scripts/forensic/run-audit-worker.ts` nor a tsconfig to resolve `@/` imports, and any file placed there
that is not in the rsync exclude list is deleted by the next deploy. `deploy.sh` is deliberately unchanged.

The template therefore runs from `/home/velo/isaflow-audit-worker` with `/home/velo/.bun/bin/bun`, and
reads `/home/velo/.config/isaflow/audit-check-run-worker.env`. A deploy step must, before the unit is enabled:

1. Install a source checkout of the deployed commit (`scripts/`, `src/`, `tsconfig.json`, `package.json`,
   `bun.lock`) and its production `node_modules` at `/home/velo/isaflow-audit-worker`, outside every
   `rsync --delete` target, replacing it atomically (build beside it, then rename).
2. Build the child artifact there: `bun scripts/forensic/build-audit-job.ts --outfile
   /home/velo/isaflow-audit-worker/dist/run-audit-job.cjs`.
3. Never write the env file; the owner manages it (mode 0600). It supplies the worker database URL,
   Node and artifact paths, control keys, and `ISAFLOW_CHECK_RUN_COMPANIES=<uuid>[,<uuid>...]`.
4. Stop the unit before migrations that touch `control_audit_*` and restart it afterwards (plan v6 §4).

The unit is a user unit under velo's own systemd manager (linger enabled), because each job runs in a
transient `systemd-run --user` unit with the check_run class caps. Company ids reach the CLI as one
argument (`--companies=${ISAFLOW_CHECK_RUN_COMPANIES}`; verified on this host that a value containing
`--class audit` stays inside that single argument), and the CLI refuses any repeated option.
