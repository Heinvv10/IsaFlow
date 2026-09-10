-- Commentary sign-off is the one approver-of-record path an impersonating
-- administrator may still complete: the text has no ledger effect and finishing
-- a client's report is legitimate support work. What must not happen is the
-- record claiming the member did it alone. approved_by stays the member whose
-- session signed; this column names the administrator who was driving it, or
-- the 'impersonation-state-unverified' marker when that state could not be
-- established. NULL means an ordinary, unimpersonated sign-off.
ALTER TABLE report_commentary ADD COLUMN IF NOT EXISTS approved_by_impersonator text;
COMMENT ON COLUMN report_commentary.approved_by_impersonator IS
  'Platform administrator impersonating the approver at sign-off; NULL for an ordinary session.';

-- The same truthfulness for the other two commentary decisions. Rejection recorded
-- nobody at all until now; a withdrawal recorded the person but not the actor behind
-- them when that person's session was being driven.
ALTER TABLE report_commentary ADD COLUMN IF NOT EXISTS rejected_by text;
ALTER TABLE report_commentary ADD COLUMN IF NOT EXISTS rejected_by_impersonator text;
ALTER TABLE report_commentary ADD COLUMN IF NOT EXISTS withdrawn_by_impersonator text;
