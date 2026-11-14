/**
 * Lump Sum Calculator (moved out of TaxDirectiveComponents.tsx, unchanged: 300-line cap).
 * Used by /payroll/tax-directives page.
 */

import { useState } from 'react';
import { Calculator } from 'lucide-react';
import { calculateLumpSumTax, type LumpSumCalculation } from '@/lib/taxCalculations';
import { formatMoney } from '@/lib/money/formatMoney';

const fmtCurrency = (n: number) => formatMoney(n);

const inputCls = 'w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-400 focus:outline-none focus:border-teal-500';
const labelCls = 'block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1';

// ─── Lump Sum Calculator ──────────────────────────────────────────────────────

export function LumpSumCalculator() {
  const [gross, setGross] = useState('');
  const [useDirectiveRate, setUseDirectiveRate] = useState(false);
  const [directiveRate, setDirectiveRate] = useState('');
  const [result, setResult] = useState<LumpSumCalculation | null>(null);

  const calculate = () => {
    const amount = parseFloat(gross);
    if (isNaN(amount) || amount <= 0) return;
    const rate = useDirectiveRate && directiveRate ? parseFloat(directiveRate) / 100 : null;
    setResult(calculateLumpSumTax(amount, rate));
  };

  return (
    <div className="bg-slate-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-xl p-5">
      <div className="flex items-center gap-2 mb-4">
        <Calculator className="h-5 w-5 text-teal-400" />
        <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Lump Sum Calculator</h3>
      </div>
      <div className="space-y-3">
        <div>
          <label htmlFor="lsc-gross" className={labelCls}>Gross Amount (ZAR)</label>
          <input
            id="lsc-gross" type="number" min="0" step="0.01"
            className={inputCls}
            value={gross} onChange={e => setGross(e.target.value)} placeholder="0.00"
          />
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={useDirectiveRate} onChange={e => setUseDirectiveRate(e.target.checked)} className="accent-teal-500" />
          <span className="text-xs text-gray-700 dark:text-gray-300">Use directive rate</span>
        </label>
        {useDirectiveRate && (
          <div>
            <label htmlFor="lsc-rate" className={labelCls}>Directive Rate (%)</label>
            <input
              id="lsc-rate" type="number" min="0" max="100" step="0.01"
              className={inputCls}
              value={directiveRate} onChange={e => setDirectiveRate(e.target.value)} placeholder="e.g. 18.00"
            />
          </div>
        )}
        <button onClick={calculate} className="w-full py-2 text-sm font-medium bg-brand-600 hover:bg-brand-700 text-white rounded-lg transition-colors">
          Calculate Tax
        </button>
        {result && (
          <div className="mt-3 space-y-2 border-t border-gray-300 dark:border-gray-700 pt-3">
            <div className="space-y-1">
              {result.breakdown.map((b, i) => (
                <div key={i} className="flex justify-between text-xs">
                  <span className="text-gray-600 dark:text-gray-400">{b.bracket}</span>
                  <span className="text-gray-800 dark:text-gray-200">{fmtCurrency(b.tax)}</span>
                </div>
              ))}
            </div>
            <div className="flex justify-between text-sm font-semibold border-t border-gray-600 pt-2">
              <span className="text-slate-900 dark:text-white">Total Tax</span>
              <span className="text-red-400">{fmtCurrency(result.taxAmount)}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-gray-600 dark:text-gray-400">Net Payment</span>
              <span className="text-teal-400">{fmtCurrency(result.grossAmount - result.taxAmount)}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-gray-600 dark:text-gray-400">Effective Rate</span>
              <span className="text-gray-800 dark:text-gray-200">{(result.effectiveRate * 100).toFixed(2)}%</span>
            </div>
            {result.directiveRateUsed && (
              <p className="text-xs text-amber-400">Using SARS directive rate</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
