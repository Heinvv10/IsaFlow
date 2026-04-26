#!/usr/bin/env python3
"""
Post-fix cleanup:
  1. Dedup the Fibertime customer_payments. Multiple draft duplicates exist
     from earlier failed runs. Keep one per (date, amount); cancel the rest.
  2. Confirm each unique draft payment via /customer-payments-action confirm
     (FK bug now fixed). This will:
       - post Dr Bank / Cr AR JE
       - update each invoice's amount_paid + status
"""
import json
from pathlib import Path
from collections import defaultdict

from _isaflow_client import get, post

ROOT = Path('/home/hein/Workspace/IsaFlow/docs/velocity-fibre/phase3')
FIBERTIME_ID = 'a8412ca1-3c48-4335-a297-5f197277c987'

def main():
    drafts = get(f'/api/accounting/customer-payments?client_id={FIBERTIME_ID}&status=draft&limit=200')
    payments = drafts['data']['payments'] if isinstance(drafts['data'], dict) else []
    print(f'Draft customer payments: {len(payments)}')

    # Group by (date, amount)
    by_key = defaultdict(list)
    for p in payments:
        key = (p['paymentDate'][:10], round(float(p['totalAmount']), 2))
        by_key[key].append(p)

    keep, cancel = [], []
    for key, group in by_key.items():
        keep.append(group[0])
        cancel.extend(group[1:])

    print(f'Unique payments: {len(keep)}')
    print(f'Duplicates to cancel: {len(cancel)}')

    # Cancel duplicates
    cancel_results = []
    for i, p in enumerate(cancel, 1):
        status, data = post('/api/accounting/customer-payments-action',
                             {'action': 'cancel', 'paymentId': p['id'],
                              'reason': 'duplicate from earlier failed run'})
        cancel_results.append({'id': p['id'], 'status': status,
                               'error': (data.get('error') or {}).get('message') if status not in (200, 201) else None})
        if status not in (200, 201) or i % 10 == 0:
            print(f'  cancel [{i}/{len(cancel)}] {p["id"][:8]} → {status}')

    # Confirm unique
    confirm_results = []
    for i, p in enumerate(keep, 1):
        status, data = post('/api/accounting/customer-payments-action',
                             {'action': 'confirm', 'paymentId': p['id']})
        confirm_results.append({'id': p['id'], 'date': p['paymentDate'][:10],
                                'amount': p['totalAmount'], 'status': status,
                                'je_id': data.get('data', {}).get('glJournalEntryId') if status in (200, 201) else None,
                                'error': (data.get('error') or {}).get('message') if status not in (200, 201) else None})
        if status not in (200, 201):
            print(f'  confirm [{i}/{len(keep)}] {p["id"][:8]} R{p["totalAmount"]:>14,.2f} → {status} {confirm_results[-1]["error"]}')
        elif i % 5 == 0:
            print(f'  confirm [{i}/{len(keep)}] R{p["totalAmount"]:>14,.2f} OK')

    ok = sum(1 for r in confirm_results if r['status'] in (200, 201))
    cancel_ok = sum(1 for r in cancel_results if r['status'] in (200, 201))
    print(f'\nDONE. Cancelled {cancel_ok}/{len(cancel_results)} duplicates, confirmed {ok}/{len(confirm_results)} unique.')

    (ROOT / 'dedup_confirm_results.json').write_text(json.dumps({
        'cancelled': cancel_results, 'confirmed': confirm_results
    }, indent=2))

if __name__ == '__main__':
    main()
