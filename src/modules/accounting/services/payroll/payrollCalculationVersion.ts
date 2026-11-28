/**
 * The version of the pay-run calculation, stamped on the run header with calculated_at (migration 953) by every
 * calculation (payrollRunLock.saveCalculatedRunTotals). The approval gate (payrollRunRecalcGate) refuses a run whose
 * stamp is missing (calculated before 953) or older than this: its lines were read under other rules, so recalculate.
 * Bump it when a change alters what a calculation writes for the same inputs.
 *
 * 1: components read on the period's last day; once-offs inside the month; pro-rata and termination-base flags.
 * 2: an unaffordable loan keeps its taxable 3801 benefit while omitting the cash instalment.
 * 3: s18A donations need a receipt and stop at 5%, off PAYE and SDL (migration 959).
 * 4: only retirement contributions and s18A donations reduce PAYE; any other taxable deduction is warned.
 * 5: an hourly or daily employee with no hours or days on the run is flagged HOURS_MISSING and refused at approval (HD).
 * 6: tax status and employment class decide PAYE, UIF, SDL and ETI (non-standard 25%, independent contractor: none; TS-b).
 * 7: fringe benefits: 3701 and 3802 are taxed at 80% (20% with business use of at least 80%), SDL / UIF / ETI read the PAYE share, a 3810 earning is non-cash and deemed medical fees (FB).
 * 8: ETI by hours: under 160 hours grossed up, tabled and grossed down (s7(5), overtime hours in); nil below the national minimum wage (s4(1)(a)); the base is para 1 cash remuneration (3701 at its PAYE share, no non-taxable or non-cash); an ID document (s6(b)); age at month end; R-B 40 h/week for a monthly starter with no hours (ET).
 * 9: each line records how PAYE, UIF, SDL and ETI were calculated (payroll_run_lines.explanation, migration 973; EX-core).
 *    Provisional: master's value + 1 at EX-core's final rebase (DR is heading for the same number).
 * 10: an employer's 3817 / 3825 / 3828 fund contribution is non-cash and deemed paid into s11F, UIF and SDL levied on it (a pre-RF
 *    assignment stays cash, migration 975); percent_of_rfi rows are costed on RFI (RF). Master's value + 1 at RF's rebase (DR may take it).
 * 11: an IRP3(b) fixed-percentage or IRP3(c) fixed-amount directive decides PAYE on regular pay (DR).
 * 12: UIF is floored at nil: a clawback larger than the month's UIF pay gives nil, not a negative contribution, and warns UIF_CLAWBACK (UF).
 * 13: PAYE annualises a month by days, 365 ÷ 30.4166 (Sage parity, wave-6 ruling 5), not × 12: the annual equivalent and the tax after rebates' n ÷ F.
 *    The s11F cap to date, the medical credits and the fees a year stay statutory period ratios, × min(n, 12) ÷ 12 (coordinator ruling 2026-11-17; AN).
 * 14: weekly and fortnightly runs: × 52 / × 26 over the periods worked (a starter's part period by its days), UIF capped on the month to
 *    date across the month's runs, ETI claimed on the month's last run, the year to date and once-offs keyed by run (FQc).
 * 15: garnishee orders come off net pay after tax: emoluments attachments within 25% of basic salary (Magistrates' Courts Act
 *    s65J(1A)(a)), maintenance outside it and first (Maintenance Act s28, s29(3)); recorded per run (GA).
 * 16: a personal service provider pays PAYE at 27% (company) or 45% (trust) of the payment, no UIF or ETI, SDL levied (PSP, migration 1013).
 * 17: a defined-benefit fund row (db_member_category_factor, migration 1014) is valued X = factor x RFI - the marked compulsory contributions
 *    (para 12D(3)), non-cash and deemed paid into s11F; its amount is the employer's payment (GL 2175, 4472) (DBF).
 * 18: overtime hours at 1.5x / 2x priced on the server (ETI counts their hours once, as 3607, etiHours); a km row splits at the prescribed
 *    rate a km into 3702 / 3703 (not taxed) and 3722 (taxed, UIF, SDL); OVERTIME_ABOVE_BCEA_THRESHOLD (RI, migration 1017).
 * 19: weekly and fortnightly regular runs are costed (FQd lifts the run-kind `frequency` clause; a run straddling an employee's
 *    frequency change is refused until acknowledged); SDL is the month's 1% across its runs, floored at the month, so a run
 *    may carry a negative SDL refunding an earlier run's over-catch-up (FQd).
 * 20: monthly off-cycle bonus and termination runs are costed (OC lifts the run-kind off-cycle clause): a bonus line pays its
 *    3605 amount alone, a termination line the leaver's pay-outs; PAYE taxes the annual payment on the month's annual
 *    equivalent, UIF is capped on the month to date and ETI recomputed for the month (the line carries the difference), SDL
 *    joins the month's catch-up; an off-cycle line takes no garnishee instalment (the month's is the regular run's) (OC, migration 999x).
 *    A once-off assignment's breakdown item carries onceOff, so a later off-cycle line's classification leaves it out.
 * 21: a recurring earning (plain amount) that starts or ends strictly inside employment inside the period is paid its share:
 *    monthly by working days (employedShareOfMonth), weekly / fortnightly by calendar days (periodShareOf); a starter's or
 *    leaver's own rows keep full pay; the breakdown item carries `share`, the payslip prints it (W29, wave 7 PRA; rulings 7, 13, 19).
 * 22: a weekly line that is the tax year's 53rd pay day (fortnightly: 27th; n > P) carries WEEK_53_PAY_DAY, a warning: PAYE
 *    stays x 52 / x 26 per period because SARS is silent (PAYE-GEN-01-G21 (2027) Rev 1 p. 9; ruling 9) (W1, wave 7 W53).
 */
export const PAYROLL_CALCULATION_VERSION = 22;

/** The version whose lines first carry the breakdown's onceOff marker (the 20 entry above); older lines do not. */
export const ONCE_OFF_MARKER_VERSION = 20;
