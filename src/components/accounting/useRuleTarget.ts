import { useState, useEffect, useRef } from 'react';
import type { SelectOption, RowSelection } from './BankTxTable';
import type { RuleVatCode } from '@/modules/accounting/types/bank.types';
import type { AllocType } from './RuleModalFields';

/** What the rule allocates to (type, VAT code and the picked entity), seeded from the selected row. */
export function useRuleTarget({ selection, glAccounts, suppliers, clients, bankAccounts }: {
  selection?: RowSelection | null;
  glAccounts: SelectOption[]; suppliers: SelectOption[]; clients: SelectOption[]; bankAccounts: SelectOption[];
}) {
  const [allocType, setAllocType] = useState<AllocType>(() => {
    const t = selection?.type;
    if (t === 'supplier') return 'supplier';
    if (t === 'customer') return 'customer';
    if (t === 'transfer') return 'bank';
    return 'account';
  });
  // Seeded from the row, but never for a type that posts no VAT line: the
  // effect below only fires on a CHANGE of alloc type, so a modal opened
  // straight onto a supplier selection would otherwise keep a code the render
  // no longer shows and the sweep would discard.
  const [vatCode, setVatCode] = useState<RuleVatCode>(() => (
    selection?.type === 'account' ? (selection.vatCode as RuleVatCode) ?? 'none' : 'none'
  ));
  const [selectedGl, setSelectedGl] = useState<SelectOption | null>(() => {
    if (selection?.type === 'account' && selection.entityId) {
      return glAccounts.find(a => a.id === selection.entityId) ?? null;
    }
    return null;
  });
  const [selectedSupplier, setSelectedSupplier] = useState<SelectOption | null>(() => {
    if (selection?.type === 'supplier' && selection.entityId) {
      // The list may not have loaded yet (it pages in on its own): the row's label stands in.
      return suppliers.find(s => s.id === selection.entityId) ?? { id: selection.entityId, name: selection.label };
    }
    return null;
  });
  const [selectedClient, setSelectedClient] = useState<SelectOption | null>(() => {
    if (selection?.type === 'customer' && selection.entityId) {
      return clients.find(c => c.id === selection.entityId) ?? null;
    }
    return null;
  });
  const [selectedBankAccount, setSelectedBankAccount] = useState<SelectOption | null>(() => {
    if (selection?.type === 'transfer' && selection.entityId) {
      return bankAccounts.find(b => b.id === selection.entityId) ?? null;
    }
    return null;
  });

  // Clear entity selection when switching alloc type (skip initial mount)
  const allocTypeInitial = useRef(true);
  useEffect(() => {
    if (allocTypeInitial.current) { allocTypeInitial.current = false; return; }
    setSelectedSupplier(null);
    setSelectedClient(null);
    setSelectedBankAccount(null);
    // Only an `account` rule posts a VAT line. A supplier or customer rule
    // SETTLES a document that already carried its VAT and a bank rule is a
    // transfer, so the sweep drops the code — storing one here would keep
    // showing "Standard 15%" on the rules list for a treatment nothing applies.
    if (allocType !== 'account') setVatCode('none');
  }, [allocType]);

  return {
    allocType, setAllocType, vatCode, setVatCode, selectedGl, setSelectedGl,
    selectedSupplier, setSelectedSupplier, selectedClient, setSelectedClient, selectedBankAccount, setSelectedBankAccount,
  };
}
