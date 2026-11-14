# POP archive: going live (SharePoint copy of ABSA proofs of payment)

What it does and its rules: `src/modules/accounting/services/capture/pop/.claude.md`. Tables: migration 992.

## The Entra app

- **"IsaFlow POP Archive"**, appId `f0338688-bb55-4e89-8b5e-42ea803454a8`, tenant `f22e6344-a35d-43b0-ad8c-a247f513c1ee`.
- Application permission **Sites.Selected**, granted **write** on the VelocityFinance site only. Verified 2026-11-14: an upload works there and every other site answers 403.
- **Why a second app.** The existing `AZURE_*` app ("ISAFlow SharePoint Reader", the document panel's "From SharePoint") has Sites.Read.All: read-only, on every site. Widening it to write would have given write on every site to the app the UI uses. The POP app can write to one site and to nothing else.
- The client secret is **not in the repo**. Ops keeps it with the other secrets (`docs/runbooks/secrets-rotation.md`).

## Steps

1. Production env (ops, not git): set `POP_ARCHIVE_TENANT_ID`, `POP_ARCHIVE_CLIENT_ID` and `POP_ARCHIVE_CLIENT_SECRET` in the env file the service reads, then restart it with the deploy script.
2. Target row, as **migration_admin** (app sessions can only read this table):

   ```sql
   INSERT INTO pop_archive_targets (company_id, site_id, folder_path)
   VALUES ('4a159669-2f50-46b5-a7b8-2e94dab3d495',
           'blitzfibre.sharepoint.com,213128c6-87ec-42c3-a710-512ded8654e1,fc658fb6-8f1c-4888-8fab-70440ee0f2b6',
           'Proof of Payments');
   ```

   That is the VelocityFinance site's Graph id and its existing (empty) `Proof of Payments` folder.
3. Watch the next mirror-scan ticks (every 5 min): `journalctl -u isaflow-mirror-scan`. The app log component is `pop-archive`, and the cron's answer carries `pop.archive` totals.
   - `POP_ARCHIVE_* is not set` means step 1 has not reached the service.
   - `stopped` with `denied` means the site grant is missing.
   - Rows appear in `pop_archive_copies`.

## Afterwards

- Settled POPs: `SELECT outcome, count(*) FROM pop_archive_copies GROUP BY 1`. To see why a POP failed, look at `pop_archive_attempts.last_error`.
- To retry `failed` copies (e.g. after a long Graph outage), delete their `pop_archive_copies` and `pop_archive_attempts` rows as migration_admin. The next tick then tries them again. A file already in SharePoint is adopted on the 409 when its size matches.
- To stop archiving one company, delete its `pop_archive_targets` row. To stop it everywhere, unset the env.
