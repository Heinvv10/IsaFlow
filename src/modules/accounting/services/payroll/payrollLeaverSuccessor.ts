/**
 * ONE predicate for "a leaver's own recurring row (alias `pec`, ending on the employee's end date) is replaced by the
 * next day" (W29 review #1901 round 3: the last-day reader and the ended-rows reader disagreed). True when a live row of
 * the same component starts the day after it ends and is: recurring; or any row when a package cut this one
 * (superseded_at: the package's once-off is the replacement); or any row when both are pre-953 (supersede_inferred, the
 * old neighbour rule). A hand-entered once-off after 953, a cancelled replacement, another component, or a row after a
 * gap does not replace it. Used by getEmployeeComponents (the band) and recurringEarningsEndedInPeriod (any day), so a
 * leaver row is read, or not, the same way whichever reader meets it. A SQL fragment over the alias `pec`, no input.
 */
export const LEAVER_ROW_HAS_SUCCESSOR_SQL = `EXISTS (
  SELECT 1 FROM payroll_employee_components nxt
  WHERE nxt.id <> pec.id AND nxt.employee_id = pec.employee_id AND nxt.component_id = pec.component_id
    AND (nxt.is_recurring OR pec.superseded_at IS NOT NULL OR (pec.supersede_inferred AND nxt.supersede_inferred))
    AND nxt.effective_from = pec.effective_to + 1
    AND (nxt.effective_to IS NULL OR nxt.effective_to >= nxt.effective_from)
)`;
