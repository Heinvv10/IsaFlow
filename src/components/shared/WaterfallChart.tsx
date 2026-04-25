import dynamic from 'next/dynamic';
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';

const WaterfallChartInner = dynamic(() => import('./WaterfallChartInner'), { ssr: false });

interface WaterfallChartProps {
  data: WaterfallStep[];
  height?: number;
  formatValue?: (n: number) => string;
}

export function WaterfallChart(props: WaterfallChartProps) {
  return <WaterfallChartInner {...props} />;
}
