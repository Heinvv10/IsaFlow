-- 964: VALIDATE the entity_changes entity_type CHECK that 961 and 962 replaced NOT VALID (PR 1b). Both lists were strict
-- supersets of the one before, so every row already satisfies it; this only records that in the catalogue. Its own file:
-- VALIDATE takes SHARE UPDATE EXCLUSIVE (writes, and so every capture, carry on during the scan) and must not run in a
-- transaction that holds a stronger lock on entity_changes. A lock not granted within 5s aborts it; re-run.
SET LOCAL lock_timeout = '5s';
ALTER TABLE entity_changes VALIDATE CONSTRAINT entity_changes_entity_type_check;
