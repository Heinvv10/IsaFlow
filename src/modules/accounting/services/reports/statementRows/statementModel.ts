export type StatementRowKind = 'section' | 'line' | 'subtotal' | 'total' | 'grand';

export interface StatementRow {
  id: string;
  kind: StatementRowKind;
  label: string;
  depth: 0 | 1;
  accountCode?: string;
  actual: number;
  prior?: number;
  variance?: number;
  variancePct?: number;
  favourable?: boolean;
  trend?: number[];
}

export interface StatementColumns {
  prior: boolean;
  variance: boolean;
  trend: boolean;
}
