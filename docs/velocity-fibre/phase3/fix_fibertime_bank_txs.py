#!/usr/bin/env python3
"""
Cleanup: 32 Fibertime incoming bank txs were Phase-3d-allocated as 'account'
to Revenue/Unallocated Income (wrongly). Reverse + re-allocate as 'customer'
against Fibertime → posts Dr Bank / Cr AR correctly.
"""
import json

from _isaflow_client import get, post

FIBERTIME_ID = 'a8412ca1-3c48-4335-a297-5f197277c987'

def main():
    # Pull all Fibertime txns across all 3 main bank accounts
    bank_ids = [
        '025b058b-adf6-45d9-9bf9-a3a543083c04',  # VF1 ABSA
        'dedb15b0-4f56-4a35-9a66-71b4dc36fd20',  # VF2 ABSA
        '829e064a-eb93-4845-a447-7ae1880a0829',  # SBSA
    ]
    fibertime = []
    for bid in bank_ids:
        for off in range(0, 4000, 100):
            try:
                items = get(f'/api/accounting/bank-transactions?bankAccountId={bid}&limit=100&offset={off}')['data']['transactions']
                if not items: break
                for t in items:
                    if 'fibertime' in (t.get('description') or '').lower() and float(t['amount']) > 0:
                        fibertime.append(t)
                if len(items) < 100: break
            except Exception as e:
                print(f'fetch err at bid={bid[:8]} off {off}: {e}'); break

    print(f'Fibertime bank txs found: {len(fibertime)}')

    results = []
    for i, tx in enumerate(fibertime, 1):
        # Step 1: reverse if currently allocated
        if tx.get('status') == 'allocated':
            s, d = post('/api/accounting/bank-transactions-action',
                        {'action': 'reverse', 'bankTransactionId': tx['id']})
            if s not in (200, 201):
                results.append({'i': i, 'phase': 'reverse', 'tx': tx['id'], 'status': s,
                                'error': (d.get('error') or {}).get('message')})
                print(f'[{i}] reverse FAIL {tx["id"][:8]} → {s}')
                continue

        # Step 2: re-allocate as customer
        s, d = post('/api/accounting/bank-transactions-action', {
            'action': 'allocate',
            'bankTransactionId': tx['id'],
            'allocationType': 'customer',
            'entityId': FIBERTIME_ID,
            'description': f'Fibertime payment {tx["transactionDate"]}',
        })
        ok = s in (200, 201)
        results.append({'i': i, 'phase': 'allocate', 'tx': tx['id'],
                        'amount': tx['amount'], 'date': tx['transactionDate'],
                        'status': s, 'error': (d.get('error') or {}).get('message') if not ok else None})
        if not ok or i % 5 == 0:
            print(f'[{i:>2}/{len(fibertime)}] {tx["transactionDate"]} R{tx["amount"]:>14,.2f} → reverse+alloc {"OK" if ok else "FAIL: "+(results[-1]["error"] or "?")}')

    ok = sum(1 for r in results if r['status'] in (200, 201))
    print(f'\nDone. {ok}/{len(fibertime)} re-allocated as customer.')
    open('/home/hein/Workspace/IsaFlow/docs/velocity-fibre/phase3/fibertime_realloc_results.json', 'w').write(json.dumps(results, indent=2))

if __name__ == '__main__':
    main()
