/**
 * JournalBuilder: every seeded journal goes through `add`, which refuses an
 * entry that does not balance to the cent, has fewer than two lines, or puts
 * money on both sides of one line. No database trigger checks balance on
 * INSERT, so this is the guard (post-check J1 re-proves it in SQL).
 */

import { at0900, minDay } from './dates';
import { money, type Rng, uuidFrom } from './rng';

export type JournalSource =
  | 'manual' | 'auto_invoice' | 'auto_payment' | 'auto_supplier_invoice' | 'auto_supplier_payment' | 'auto_payroll';

export interface JLineInput {
  accountId: string;
  /** Integer cents; exactly one of debit/credit is > 0. */
  debit: number;
  credit: number;
  description: string;
  vatType?: 'standard';
}

export interface JEntryInput {
  date: string;
  description: string;
  reference: string;
  source: JournalSource;
  lines: JLineInput[];
  /** Statement-style text for the bank line(s) this entry produces. */
  bankText?: string;
}

export interface JLine extends JLineInput { id: string }
export interface JEntry extends Omit<JEntryInput, 'lines'> { id: string; lines: JLine[]; seq: number }

export class JournalBuilder {
  readonly entries: JEntry[] = [];
  private seq = 0;

  constructor(private readonly rng: Rng, private readonly today: string) {}

  add(input: JEntryInput): JEntry {
    if (input.date > this.today) throw new Error(`journal dated ${input.date} is after ${this.today}`);
    const lines = input.lines.filter((l) => l.debit !== 0 || l.credit !== 0);
    if (lines.length < 2) throw new Error(`journal "${input.description}" has fewer than two lines`);
    let dr = 0;
    let cr = 0;
    for (const l of lines) {
      if (!Number.isInteger(l.debit) || !Number.isInteger(l.credit)) throw new Error('journal amounts must be integer cents');
      if (l.debit < 0 || l.credit < 0) throw new Error(`negative amount on "${l.description}"`);
      if (l.debit > 0 && l.credit > 0) throw new Error(`both sides on "${l.description}"`);
      dr += l.debit;
      cr += l.credit;
    }
    if (dr !== cr) throw new Error(`journal "${input.description}" does not balance: ${money(dr)} vs ${money(cr)}`);
    const entry: JEntry = {
      ...input,
      id: uuidFrom(this.rng),
      seq: this.seq++,
      lines: lines.map((l) => ({ ...l, id: uuidFrom(this.rng) })),
    };
    this.entries.push(entry);
    return entry;
  }

  /** Entries in date order (stable on insertion order), as numbered and inserted. */
  ordered(): JEntry[] {
    return [...this.entries].sort((a, b) => (a.date === b.date ? a.seq - b.seq : a.date < b.date ? -1 : 1));
  }

  /** Bank-account lines in date order, with their entry. */
  bankLines(bankAccountId: string): Array<{ entry: JEntry; line: JLine; amount: number }> {
    const out: Array<{ entry: JEntry; line: JLine; amount: number }> = [];
    for (const entry of this.ordered()) {
      for (const line of entry.lines) {
        if (line.accountId === bankAccountId) out.push({ entry, line, amount: line.debit - line.credit });
      }
    }
    return out;
  }

  /** Lowest running bank balance in cents over the whole history (date order). */
  minBankBalance(bankAccountId: string): number {
    let bal = 0;
    let min = 0;
    for (const { amount } of this.bankLines(bankAccountId)) {
      bal += amount;
      if (bal < min) min = bal;
    }
    return min;
  }

  /** gl_journal_entries / gl_journal_lines rows, numbered `JE-<year>-<5 digits>` per year in date order. */
  rows(companyId: string, actorId: string): { entries: Row[]; lines: Row[] } {
    const perYear = new Map<string, number>();
    const entries: Row[] = [];
    const lines: Row[] = [];
    for (const e of this.ordered()) {
      const year = e.date.slice(0, 4);
      const n = (perYear.get(year) ?? 0) + 1;
      perYear.set(year, n);
      entries.push({
        id: e.id, company_id: companyId, entry_number: `JE-${year}-${String(n).padStart(5, '0')}`,
        entry_date: e.date, description: e.description, reference: e.reference, source: e.source,
        status: 'posted', posted_by: actorId, posted_at: at0900(minDay(e.date, this.today)), created_by: actorId,
      });
      for (const l of e.lines) {
        lines.push({
          id: l.id, journal_entry_id: e.id, company_id: companyId, gl_account_id: l.accountId,
          debit: money(l.debit), credit: money(l.credit), description: l.description, vat_type: l.vatType ?? null,
        });
      }
    }
    return { entries, lines };
  }
}

/** One row for a table: column name to value (text for numerics, dates and jsonb). */
export type Row = Record<string, string | number | boolean | null>;
