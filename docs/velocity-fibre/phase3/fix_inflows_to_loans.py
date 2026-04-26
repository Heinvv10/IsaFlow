#!/usr/bin/env python3
"""
Reverse + re-allocate the remaining inflows that were wrongly Cr'd to AP control.
Mostly loan drawdowns from Populace, VEA, Lew, plus other customer credits.
"""
import json
import subprocess

from _isaflow_client import post

GL_LOAN_POPULACE = '463127a4-b094-490e-b8cc-1240907cc614'
GL_LOAN_VEA      = '6f23d554-0593-4094-874a-6cc38c769db4'
GL_LOAN_LEW      = '255e7acd-d1e8-40a8-b3ca-8580827301ae'
GL_UNALLOC_INCOME = 'eef5a5e1-ee87-4e34-b299-087cbd9bf81d'

def classify(desc: str):
    d = (desc or '').lower()
    if 'populace' in d or 'shareholder loan' in d or 'director lo' in d:
        return GL_LOAN_POPULACE, 'populace'
    if 'vea group' in d or 'vea telecom' in d:
        return GL_LOAN_VEA, 'vea'
    if 'lewhofmeyr' in d or 'lew hofmeyr' in d:
        return GL_LOAN_LEW, 'lew'
    return GL_UNALLOC_INCOME, 'unalloc'

def get_target_txs():
    # Fetch via psql sudo
    pwd = subprocess.run(['sudo', '-n', 'grep', '-E', '^DATABASE_URL=', '/home/velo/isaflow/.env.local'],
                         capture_output=True, text=True).stdout.strip()
    pwd = pwd.split('://')[1].split('@')[0].split(':')[1]
    sql = """
      SELECT bt.id, bt.amount, bt.description
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      JOIN bank_transactions bt ON bt.matched_journal_line_id IN (
          SELECT jl2.id FROM gl_journal_lines jl2 WHERE jl2.journal_entry_id = je.id)
      WHERE je.company_id='4a159669-2f50-46b5-a7b8-2e94dab3d495'
        AND je.status='posted' AND je.source='auto_bank_recon'
        AND ga.account_code='SYS-8' AND jl.credit > 0
        AND bt.status = 'allocated'
      ORDER BY bt.amount DESC
    """
    r = subprocess.run(['psql', '-h', 'localhost', '-p', '7772', '-U', 'postgres', '-d', 'isaflow',
                        '-A', '-F', '|', '-t', '-c', sql],
                       env={**__import__('os').environ, 'PGPASSWORD': pwd},
                       capture_output=True, text=True)
    rows = []
    for line in r.stdout.strip().split('\n'):
        if not line.strip() or '|' not in line: continue
        parts = line.split('|', 2)
        if len(parts) >= 3:
            rows.append((parts[0], float(parts[1]), parts[2]))
    return rows

def main():
    rows = get_target_txs()
    print(f'Wrongly-AP-Cr inflows to clean up: {len(rows)}')

    results = []
    by_class = {}
    for i, (tx_id, amount, desc) in enumerate(rows, 1):
        contra, cls = classify(desc)
        by_class[cls] = by_class.get(cls, 0) + 1
        s, d = post('/api/accounting/bank-transactions-action',
                    {'action': 'reverse', 'bankTransactionId': tx_id})
        if s not in (200, 201):
            results.append({'i': i, 'phase': 'reverse', 'tx': tx_id, 'status': s,
                            'error': (d.get('error') or {}).get('message')})
            print(f'[{i:>3}] REV FAIL {tx_id[:8]} R{amount:,.0f}: {(d.get("error") or {}).get("message", "")[:60]}')
            continue
        s2, d2 = post('/api/accounting/bank-transactions-action', {
            'action': 'allocate',
            'bankTransactionId': tx_id,
            'allocationType': 'account',
            'contraAccountId': contra,
            'description': (desc or '')[:500],
        })
        ok = s2 in (200, 201)
        results.append({'i': i, 'tx': tx_id, 'amount': amount, 'desc': desc[:60],
                        'cls': cls, 'status': s2,
                        'error': (d2.get('error') or {}).get('message') if not ok else None})
        if not ok or i % 10 == 0:
            print(f'[{i:>3}/{len(rows)}] R{amount:>14,.2f} → {cls}: {"OK" if ok else "FAIL "+(results[-1]["error"] or "?")[:60]}')

    ok = sum(1 for r in results if r['status'] in (200, 201))
    print(f'\nDone: {ok}/{len(rows)} re-allocated')
    print(f'Class breakdown: {by_class}')
    open('/home/hein/Workspace/IsaFlow/docs/velocity-fibre/phase3/inflows_realloc_results.json', 'w').write(
        json.dumps(results, indent=2, default=str))

if __name__ == '__main__':
    main()
