/**
 * The cap on the profile card's readiness read. It is one indexed read with no figure and no account number in the
 * answer, and every profile opened is one read (two in dev under React strict mode), so the shared interactive
 * default of 120 a window (INTERACTIVE_REPORT_LIMIT, sized for a report engine) was reached by a reviewer opening
 * about sixty profiles; every card after that said "Could not check bank details" for the rest of the 15 minutes
 * (RS3, wave 7 RD, a 429). Still a per-user, per-company ceiling, but one an interactive session cannot reach.
 */
export const READINESS_RATE_LIMIT = { max: 1200, windowSecs: 900 } as const;
