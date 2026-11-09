/**
 * When a draft's edit re-dates its due date (payment-terms programme, Part A; Hein, 2026-11-08).
 *
 * A draft whose due date came from terms (`due_date_source` = 'terms') should keep following them: an edit that moves the
 * invoice date (a customer invoice's edit may also move the customer) re-dates it by the terms for the NEW date and
 * contact, with the same precedence the creator used. The rule lives on the server so API and MCP callers get it as the
 * pages do.
 *
 * The edit's own due date decides whether the person meant the old one:
 *   absent               nothing was named: re-date;
 *   the stored date      the pages re-send what they loaded, which is not a choice: re-date;
 *   the new terms date   the page shows the recalculated date and sends it back: re-date (the source stays `terms`);
 *   anything else        the caller's choice: left to the edit as it always was (recorded `manual`).
 * A `manual`, `document` or `legacy` date is never moved by this.
 *
 * Named limit: a user who changes the invoice date and wants to KEEP the old terms date cannot say so in the same save
 * (their old date is the stored one, which reads as "not touched"). They save the date change, then change the due date.
 */
import type { DueDateSource } from './dueDateSource';

export interface RedatedDueDate { dueDate: string; source: DueDateSource }

export async function redatedDueDate(a: {
  storedSource: unknown;
  /** The edit moves the invoice date, or the customer. */
  moved: boolean;
  storedDueDate: string | null;
  /** The due date the edit names (null / undefined: none). */
  givenDueDate: string | null | undefined;
  /** The terms' date and its source for the NEW invoice date and contact; read only when the rule can apply. */
  termsDate: () => Promise<{ dueDate: string | null; source: DueDateSource }>;
}): Promise<RedatedDueDate | null> {
  if (!a.moved || a.storedSource !== 'terms') return null;
  const terms = await a.termsDate();
  if (terms.dueDate === null) return null;
  const g = a.givenDueDate;
  if (g && g !== a.storedDueDate && g !== terms.dueDate) return null;
  return { dueDate: terms.dueDate, source: terms.source };
}
