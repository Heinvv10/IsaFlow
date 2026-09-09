-- Migration 626: keep the two column pairs on practice_client_rate_overrides in step.
-- Migration 372 created (user_id, rate) NOT NULL; migration 395 added the nullable
-- (staff_user_id, rate_per_hour) the current service writes and back-filled once.
-- Nothing kept them synchronised afterwards, so a writer touching only one pair either
-- raised 23502 or produced a row half the readers could not see. This mirrors the pairs
-- on every write so drift is impossible regardless of which writer runs: a half-populated
-- pair is filled from its other half, and two supplied halves that disagree are reconciled
-- in favour of the newer column (staff_user_id / rate_per_hour), which is what every reader
-- prefers. A consequence is that SET rate = X on a row whose rate_per_hour is unchanged
-- lands as the existing rate_per_hour, and SET rate_per_hour = NULL propagates the NULL into
-- the still-NOT NULL rate and raises 23502; both only reach hand-written SQL, since
-- updateClientRateOverride never sends a NULL rate.
-- Reversible: DROP TRIGGER trg_pcro_mirror_columns ON practice_client_rate_overrides.
-- The legacy columns are intentionally NOT dropped here.

CREATE OR REPLACE FUNCTION practice_pcro_mirror_columns() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Carry whichever side the statement actually changed over to the other.
    IF NEW.rate_per_hour IS DISTINCT FROM OLD.rate_per_hour THEN
      NEW.rate := NEW.rate_per_hour;
    ELSIF NEW.rate IS DISTINCT FROM OLD.rate THEN
      NEW.rate_per_hour := NEW.rate;
    END IF;
    IF NEW.staff_user_id IS DISTINCT FROM OLD.staff_user_id THEN
      NEW.user_id := NEW.staff_user_id;
    ELSIF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
      NEW.staff_user_id := NEW.user_id;
    END IF;
    NEW.staff_user_id := COALESCE(NEW.staff_user_id, NEW.user_id);
    NEW.user_id       := COALESCE(NEW.user_id, NEW.staff_user_id);
    NEW.rate_per_hour := COALESCE(NEW.rate_per_hour, NEW.rate);
    NEW.rate          := COALESCE(NEW.rate, NEW.rate_per_hour);
  ELSE
    -- INSERT: there is no OLD row to say which side the writer meant, so the newer
    -- column is authoritative. This fills a legacy half left NULL and also reconciles
    -- two halves supplied together that disagree, which would otherwise pass through.
    NEW.staff_user_id := COALESCE(NEW.staff_user_id, NEW.user_id);
    NEW.rate_per_hour := COALESCE(NEW.rate_per_hour, NEW.rate);
    NEW.user_id       := NEW.staff_user_id;
    NEW.rate          := NEW.rate_per_hour;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pcro_mirror_columns ON practice_client_rate_overrides;
CREATE TRIGGER trg_pcro_mirror_columns
  BEFORE INSERT OR UPDATE ON practice_client_rate_overrides
  FOR EACH ROW EXECUTE FUNCTION practice_pcro_mirror_columns();

-- One-time repair of rows migration 395 left half-populated. Column-local mirror only;
-- it copies a value between two columns of the same row and never crosses company_id.
UPDATE practice_client_rate_overrides
   SET staff_user_id = COALESCE(staff_user_id, user_id),
       user_id       = COALESCE(user_id, staff_user_id),
       rate_per_hour = COALESCE(rate_per_hour, rate),
       rate          = COALESCE(rate, rate_per_hour)
 WHERE staff_user_id IS NULL
    OR user_id IS NULL
    OR rate_per_hour IS NULL
    OR rate IS NULL;
