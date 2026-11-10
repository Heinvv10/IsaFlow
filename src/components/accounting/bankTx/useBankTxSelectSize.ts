/** The kit size of a bank grid cell's select: `sm` (32px) in comfortable rows, `xs` (24px) in compact ones. */

import { useOptionalDensity } from '@/contexts/TableDensityContext';

export function useBankTxSelectSize(): 'xs' | 'sm' {
  return useOptionalDensity() === 'compact' ? 'xs' : 'sm';
}
