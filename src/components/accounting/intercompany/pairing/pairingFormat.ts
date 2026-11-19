/** Display helpers of the pairing screen. */
import { formatCurrency } from '@/utils/formatters';
import type { PairingDirection } from '@/modules/accounting/services/intercompany/pairingTypes';

/** A net-debit figure as "R 5 000.00 Dr" / "R 5 000.00 Cr" (nil carries no suffix): the sign is spoken, not left to a minus. */
export function formatDrCr(netDebit: number): string {
  if (Math.abs(netDebit) < 0.005) return formatCurrency(0);
  return `${formatCurrency(Math.abs(netDebit))} ${netDebit > 0 ? 'Dr' : 'Cr'}`;
}

/** The sum of amounts to the cent (floating point sums of rand amounts drift). */
export function sumCents(amounts: number[]): number {
  return amounts.reduce((total, a) => total + Math.round(a * 100), 0) / 100;
}

/** What each side's document is called: owed to this company, its invoice and the partner's bill; owed by it, the reverse. */
export function docLabels(direction: PairingDirection, partnerName: string): { mine: string; theirs: string } {
  return direction === 'ar'
    ? { mine: 'Your invoice', theirs: `${partnerName}'s bill` }
    : { mine: 'Your bill', theirs: `${partnerName}'s invoice` };
}
