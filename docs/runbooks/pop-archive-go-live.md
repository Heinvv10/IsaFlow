# POP archive: going live (SharePoint copy of ABSA proofs of payment)

What it does and its rules: `src/modules/accounting/services/capture/pop/.claude.md`. Tables: migrations 989 (POPs),
991 (bank-line matching), 992 (archive).

## The Entra app

- **"IsaFlow POP Archive"**, appId `f0338688-bb55-4e89-8b5e-42ea803454a8`, tenant `f22e6344-a35d-43b0-ad8c-a247f513c1ee`.
- Application permission **Sites.Selected**, granted **write** on the VelocityFinance site only. Verified 2026-11-14: an upload works there, and every other site answers 403.
- **Why a second app.** The existing `AZURE_*` app ("ISAFlow SharePoint Reader", which backs the document panel's "From SharePoint") has Sites.Read.All: read-only, on every site. Widening it to write would have given write on every site to the app the UI uses. The POP app can write to one site and nothing else.
- The client secret is **not in the repo**. Ops keeps it with the other secrets (`docs/runbooks/secrets-rotation.md`).

## Steps (in this order)

1. **Production deploy of the code and migrations 989, 991 and 992.** This is `bash scripts/deploy.sh`, which applies pending migrations to the production database and deploys production at once (CLAUDE.md, "Deploys").
   - Only after hours (never 08:00-17:00 SAST, Mon-Fri), and only with Hein's explicit approval for that deploy.
   - Nothing below works before it: the tables do not exist yet.
2. **Credentials.**
   - Ops sets `POP_ARCHIVE_TENANT_ID`, `POP_ARCHIVE_CLIENT_ID` and `POP_ARCHIVE_CLIENT_SECRET` in `/home/velo/isaflow/.env.local`.
   - Then restart the colours with `bash scripts/deploy/restart-colours.sh`, never `systemctl restart`. It is how an env change reaches production (CLAUDE.md, "Deploys").
   - The restart is a production change too: same window, same approval.
3. **Target row, as migration_admin.** App sessions can only read this table.
   - Connect with the migration_admin login the app itself holds: `MIGRATION_ADMIN_DATABASE_URL` in `/home/velo/isaflow/.env.local` (`docs/runbooks/s07b-app-pool-login-roles.md` §1: production has it).
   - Keep the password off the command line, as that runbook's §3 says.

   ```sql
   INSERT INTO pop_archive_targets (company_id, site_id, folder_path)
   VALUES ('4a159669-2f50-46b5-a7b8-2e94dab3d495',
           'blitzfibre.sharepoint.com,213128c6-87ec-42c3-a710-512ded8654e1,fc658fb6-8f1c-4888-8fab-70440ee0f2b6',
           'Proof of Payments');
   ```

   That is the VelocityFinance site's Graph id and its existing, empty `Proof of Payments` folder.
4. **Watch the next mirror-scan ticks** (every 5 min) with `journalctl -u isaflow-mirror-scan`. The app log component is `pop-archive`, and the cron's answer carries `pop.archive` totals.
   - `POP_ARCHIVE_* is not set`: step 2 has not reached the service.
   - `stopped`, with a `denied` result on the **second** POP of a tick and nothing archived: the site grant is missing or wrong. Nothing is counted against any POP while it lasts, so fixing the grant lets every POP through. A 403 on one POP while others archive in the same tick is counted against that POP (its folder's permissions); after 10 it is settled `failed`.
   - `GraphTokenError`: the tenant, client id or secret is wrong.
   - Rows appear in `pop_archive_copies`.

## Afterwards

- **Settled POPs:** `SELECT outcome, count(*) FROM pop_archive_copies GROUP BY 1`.
- **Why a POP failed:** `pop_archive_attempts.last_error`. `attempts` counts the POP's own failures toward `failed` (10). `tries` counts every failure, outages included, and drives the wait.
- **Retry `failed` copies** (e.g. after the grant was fixed): delete their `pop_archive_copies` and `pop_archive_attempts` rows as migration_admin. The next tick tries them again. A file already in SharePoint is adopted on the 409 if its bytes are ours.
- **Stop archiving** one company: delete its `pop_archive_targets` row. To stop it everywhere, unset the env (step 2's restart).

## Correcting a bank-line match decision

`proof_of_payment_matches` rows other than `not_found` are final. 991's trigger `trg_proof_of_payment_matches_final` refuses any UPDATE of them for every role, migration_admin included.

- **To let the matcher decide again:** delete the row as migration_admin. The trigger guards UPDATE only. If the POP's document was already attached, unlink it first through the app.
- **To set a decision by hand:** run this as the table owner (the deploy's `postgres`; `ALTER TABLE` needs the owner, migration_admin cannot), in one transaction, and re-enable the trigger in the same transaction:

  ```sql
  BEGIN;
  ALTER TABLE proof_of_payment_matches DISABLE TRIGGER trg_proof_of_payment_matches_final;
  UPDATE proof_of_payment_matches SET ... WHERE proof_of_payment_id = '<pop id>';
  ALTER TABLE proof_of_payment_matches ENABLE TRIGGER trg_proof_of_payment_matches_final;
  COMMIT;
  ```
