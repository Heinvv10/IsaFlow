/** Display helpers for AccountRow (moved out to keep the row under the 300-line cap). */

export function accountTypeColor(type: string): string {
  switch (type) {
    case 'asset':     return 'bg-blue-500/20 text-blue-400';
    case 'liability': return 'bg-red-500/20 text-red-400';
    case 'equity':    return 'bg-purple-500/20 text-purple-400';
    case 'revenue':   return 'bg-teal-500/20 text-teal-400';
    case 'expense':   return 'bg-amber-500/20 text-amber-400';
    default:          return 'bg-gray-500/20 text-gray-400';
  }
}

export const VAT_LABELS: Record<string, string> = { standard: '15%', zero_rated: 'Zero Rated', exempt: 'Exempt' };
