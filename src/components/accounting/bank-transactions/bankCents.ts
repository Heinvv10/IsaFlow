/** Integer cents (the bank-account summary's money) on screen: "R 1 234.56", negatives "−R 12.00" (formatMoney). */
import { formatMoney } from '@/lib/money/formatMoney';

export const fmtCents = (cents: number): string => formatMoney(cents / 100);
