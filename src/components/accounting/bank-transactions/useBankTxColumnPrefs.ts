/**
 * useBankTxColumnPrefs — whether the bank transactions grid shows its cost-centre and business-unit columns.
 * The company setting decides, unless this browser's localStorage says otherwise. Split out of the page shell
 * (300-line rule).
 */

import { useEffect, useState } from 'react';
import { apiFetch, assertOk } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

export function useBankTxColumnPrefs() {
  const [showCC, setShowCC] = useState(false);
  const [showBU, setShowBU] = useState(false);
  // Column visibility — company settings + localStorage override
  useEffect(() => {
    const readSetting = (key: string) => apiFetch(`/api/accounting/accounting-settings?key=${key}`).then(async r => { await assertOk(r, 'Could not load the column settings'); return r.json(); });
    Promise.all([readSetting('enable_cost_centres'), readSetting('enable_business_units')]).then(([ccJson, buJson]) => {
      const ccLocal = localStorage.getItem('isaflow_bank_showCC');
      const buLocal = localStorage.getItem('isaflow_bank_showBU');
      setShowCC(ccLocal !== null ? ccLocal !== 'false' : ccJson.data?.value === 'true');
      setShowBU(buLocal !== null ? buLocal !== 'false' : buJson.data?.value === 'true');
    }).catch(err => log.warn('Column settings unavailable, using defaults', { error: err }, 'bank-transactions'));
  }, []);
  const toggleCC = () => { const v = !showCC; setShowCC(v); localStorage.setItem('isaflow_bank_showCC', String(v)); };
  const toggleBU = () => { const v = !showBU; setShowBU(v); localStorage.setItem('isaflow_bank_showBU', String(v)); };
  return { showCC, showBU, toggleCC, toggleBU };
}
