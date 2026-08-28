-- Migration 518: make sars_efiling_events genuinely append-only for app_user.
--
-- Migration 517 added the RLS policy and stated in its comment that this is an
-- append-only audit trail with SELECT + INSERT only. That was true of the GRANT
-- it issued but not of the table: app_user already held UPDATE and DELETE from
-- an earlier blanket grant, so the comment described an intent the schema did
-- not enforce. 517 is already applied, and editing an applied migration breaks
-- its checksum, so the correction lands here instead.
--
-- Safe because nothing in the codebase mutates this table: the only statement
-- touching it is the INSERT in insertEfilingEvent
-- (src/modules/accounting/services/reports/sarsEfilingRepo.ts). A grep for
-- UPDATE / DELETE against sars_efiling_events returns nothing.
--
-- Cascade deletes are unaffected. sars_efiling_events_submission_id_fkey is
-- ON DELETE CASCADE, and Postgres runs referential actions through an internal
-- trigger that does not re-check the deleting role's table privileges — so
-- removing a sars_submissions row still removes its events.

REVOKE UPDATE, DELETE ON sars_efiling_events FROM app_user;

-- Restate the intended grant so a database provisioned from scratch ends in the
-- same place as one that has been through the blanket grant.
GRANT SELECT, INSERT ON sars_efiling_events TO app_user;
