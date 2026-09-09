-- Read-only: explicitly selected company only. Names of foreign accounts are not returned.
SELECT je.id, je.entry_number, je.entry_date, je.status, je.source,
       je.fiscal_period_id, count(jl.id) AS line_count,
       count(jl.id) FILTER (WHERE ga.id IS NULL) AS unowned_account_lines,
       COALESCE(sum(jl.debit),0) AS debit_total,
       COALESCE(sum(jl.credit),0) AS credit_total,
       (fp.id IS NULL OR je.entry_date NOT BETWEEN fp.start_date AND fp.end_date) AS period_missing_or_mismatched
FROM gl_journal_entries je
LEFT JOIN gl_journal_lines jl ON jl.journal_entry_id=je.id AND jl.company_id=$1::uuid
LEFT JOIN gl_accounts ga ON ga.id=jl.gl_account_id AND ga.company_id=$1::uuid
LEFT JOIN fiscal_periods fp ON fp.id=je.fiscal_period_id AND fp.company_id=$1::uuid
WHERE je.company_id=$1::uuid
  AND (je.source='opening_balance' OR je.reference='opening_balance'
       OR je.description='Opening Balances' OR je.entry_number LIKE 'OB-%')
GROUP BY je.id, fp.id, fp.start_date, fp.end_date
ORDER BY je.entry_date, je.id;
