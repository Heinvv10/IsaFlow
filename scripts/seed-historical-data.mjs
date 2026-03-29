/**
 * ISAFlow Historical Seed Data — 2020 to 2026
 * Seeds realistic financial data across ALL modules.
 */

import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL required.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: DATABASE_URL });

async function seed() {
  await client.connect();
  console.log('=== ISAFlow Historical Seed (2020-2026) ===\n');

  const companyResult = await client.query(`SELECT id FROM companies LIMIT 1`);
  const companyId = companyResult.rows[0]?.id;
  if (!companyId) { console.error('No company found!'); process.exit(1); }

  // ── 1. FISCAL PERIODS ──────────────────────────────────────────────────
  console.log('1. Seeding fiscal periods 2020-2025...');
  for (let year = 2020; year <= 2025; year++) {
    for (let month = 1; month <= 12; month++) {
      const lastDay = new Date(year, month, 0).getDate();
      const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
      const endDate = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;
      const periodName = `${new Date(year, month - 1).toLocaleString('en', { month: 'long' })} ${year}`;
      const status = 'closed';
      await client.query(`
        INSERT INTO fiscal_periods (period_name, period_number, fiscal_year, start_date, end_date, status, company_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT DO NOTHING
      `, [periodName, month, year, startDate, endDate, status, companyId]);
    }
  }
  console.log('  ✓ Done\n');

  // ── 2. GL JOURNAL ENTRIES (2020-2025) ──────────────────────────────────
  console.log('2. Seeding GL journal entries (2020-2025)...');
  const accounts = await client.query(`SELECT id, account_code FROM gl_accounts`);
  const acctMap = {};
  accounts.rows.forEach(a => { acctMap[a.account_code] = a.id; });

  const baseRevenue = { 2020: 80000, 2021: 120000, 2022: 160000, 2023: 200000, 2024: 250000, 2025: 300000 };
  const seasonalFactors = [0.85, 0.90, 1.05, 0.95, 1.00, 0.90, 0.85, 0.95, 1.05, 1.10, 1.15, 1.30];
  let entryCount = 0;

  for (let year = 2020; year <= 2025; year++) {
    for (let month = 1; month <= 12; month++) {
      const monthStr = `${year}-${String(month).padStart(2, '0')}`;
      const entryDate = `${monthStr}-28`;
      const base = baseRevenue[year];
      const revenue = Math.round(base * seasonalFactors[month - 1]);
      const cos = Math.round(revenue * (0.55 + Math.random() * 0.1));
      const opex = Math.round(revenue * (0.15 + Math.random() * 0.05));

      for (const [suffix, debitAcct, creditAcct, amount, desc] of [
        ['REV', '1110', '4100', revenue, `Sales ${monthStr}`],
        ['COS', '5200', '1110', cos, `Labour costs ${monthStr}`],
        ['OPEX', '5600', '1110', opex, `Admin expenses ${monthStr}`],
      ]) {
        const num = `JE-${year}-${String(month).padStart(2, '0')}-${suffix}`;
        if (!acctMap[debitAcct] || !acctMap[creditAcct]) continue;
        const r = await client.query(`INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, source, created_by) VALUES ($1, $2, $3, $4, 'posted', 'manual', '00000000-0000-0000-0000-000000000000'::UUID) ON CONFLICT DO NOTHING RETURNING id`, [companyId, num, entryDate, desc]);
        if (r.rows[0]) {
          await client.query(`INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, description) VALUES ($1, $2, $3, 0, $4)`, [r.rows[0].id, acctMap[debitAcct], amount, desc]);
          await client.query(`INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, description) VALUES ($1, $2, 0, $3, $4)`, [r.rows[0].id, acctMap[creditAcct], amount, desc]);
          entryCount++;
        }
      }
    }
  }
  console.log(`  ✓ ${entryCount} journal entries\n`);

  // ── 3. CUSTOMER INVOICES (2020-2025) ───────────────────────────────────
  console.log('3. Seeding customer invoices...');
  const customers = await client.query(`SELECT id FROM customers`);
  let invCount = 0;

  for (let year = 2020; year <= 2025; year++) {
    for (let month = 1; month <= 12; month++) {
      const n = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        const cust = customers.rows[Math.floor(Math.random() * customers.rows.length)];
        const amount = Math.round((10000 + Math.random() * 90000) * 100) / 100;
        const vat = Math.round(amount * 0.15 * 100) / 100;
        const total = amount + vat;
        const invDate = `${year}-${String(month).padStart(2, '0')}-${String(5 + Math.floor(Math.random() * 20)).padStart(2, '0')}`;
        const dueDate = new Date(new Date(invDate).getTime() + 30 * 86400000).toISOString().split('T')[0];
        const num = `HINV-${year}${String(month).padStart(2, '0')}-${String(i + 1).padStart(3, '0')}`;
        await client.query(`INSERT INTO customer_invoices (company_id, customer_id, invoice_number, invoice_date, due_date, subtotal, tax_amount, total_amount, amount_paid, status, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'paid', '00000000-0000-0000-0000-000000000000'::UUID) ON CONFLICT DO NOTHING`, [companyId, cust.id, num, invDate, dueDate, amount, vat, total, total]);
        invCount++;
      }
    }
  }
  console.log(`  ✓ ${invCount} customer invoices\n`);

  // ── 4. SUPPLIER INVOICES (2020-2025) ───────────────────────────────────
  console.log('4. Seeding supplier invoices...');
  const suppliers = await client.query(`SELECT id FROM suppliers`);
  let supInvCount = 0;

  for (let year = 2020; year <= 2025; year++) {
    for (let month = 1; month <= 12; month++) {
      const n = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        const sup = suppliers.rows[Math.floor(Math.random() * suppliers.rows.length)];
        const amount = Math.round((5000 + Math.random() * 50000) * 100) / 100;
        const vat = Math.round(amount * 0.15 * 100) / 100;
        const total = amount + vat;
        const invDate = `${year}-${String(month).padStart(2, '0')}-${String(3 + Math.floor(Math.random() * 20)).padStart(2, '0')}`;
        const dueDate = new Date(new Date(invDate).getTime() + 30 * 86400000).toISOString().split('T')[0];
        const num = `SINV-${year}${String(month).padStart(2, '0')}-${String(i + 1).padStart(3, '0')}`;
        await client.query(`INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date, subtotal, tax_amount, total_amount, amount_paid, status, paid_at, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'paid', $10, '00000000-0000-0000-0000-000000000000'::UUID) ON CONFLICT DO NOTHING`, [companyId, sup.id, num, invDate, dueDate, amount, vat, total, total, dueDate]);
        supInvCount++;
      }
    }
  }
  console.log(`  ✓ ${supInvCount} supplier invoices\n`);

  // ── 5. BANK TRANSACTIONS (2020-2025) ───────────────────────────────────
  console.log('5. Seeding bank transactions...');
  // Use existing bank account ID from seeded data
  const bankAccountId = 'ed7f55f6-77b5-4a10-bf78-c2c542de1aac';
  let bankTxCount = 0;

  if (bankAccountId) {
    const descs = ['WOOLWORTHS', 'ENGEN FUEL', 'MTN AIRTIME', 'ESKOM', 'TELKOM', 'VODACOM', 'PICK N PAY', 'SHELL FUEL', 'FNB CHARGES', 'TAKEALOT', 'BUILDERS', 'OFFICE NATIONAL', 'SAGE SUB', 'SALARY PAYMENT', 'SARS VAT', 'INSURANCE', 'RENT', 'CLIENT DEPOSIT', 'PROJECT PAYMENT'];
    for (let year = 2020; year <= 2025; year++) {
      for (let month = 1; month <= 12; month++) {
        const n = 15 + Math.floor(Math.random() * 11);
        for (let i = 0; i < n; i++) {
          const desc = descs[Math.floor(Math.random() * descs.length)];
          const isDebit = desc.includes('SALARY') || desc.includes('FUEL') || desc.includes('CHARGES') || desc.includes('RENT') || desc.includes('SARS') || Math.random() > 0.4;
          const amount = isDebit ? -(Math.round((500 + Math.random() * 30000) * 100) / 100) : Math.round((5000 + Math.random() * 100000) * 100) / 100;
          const txDate = `${year}-${String(month).padStart(2, '0')}-${String(1 + Math.floor(Math.random() * 28)).padStart(2, '0')}`;
          await client.query(`INSERT INTO bank_transactions (bank_account_id, transaction_date, description, amount, company_id) VALUES ($1, $2, $3, $4, $5)`, [bankAccountId, txDate, desc, amount, companyId]);
          bankTxCount++;
        }
      }
    }
  }
  console.log(`  ✓ ${bankTxCount} bank transactions\n`);

  // ── 6. PAYROLL RUNS & PAYSLIPS (2022-2025) ─────────────────────────────
  console.log('6. Seeding payroll...');
  const employees = await client.query(`SELECT id FROM employees`);
  let payrollCount = 0;
  const baseSalaries = [18000, 22000, 28000, 16000];

  for (let year = 2022; year <= 2025; year++) {
    for (let month = 1; month <= 12; month++) {
      const periodStart = `${year}-${String(month).padStart(2, '0')}-01`;
      const periodEnd = `${year}-${String(month).padStart(2, '0')}-${new Date(year, month, 0).getDate()}`;
      const r = await client.query(`INSERT INTO payroll_runs (company_id, period_start, period_end, run_date, status, total_gross, total_net, total_paye, total_sdl, total_uif_employee, total_uif_employer, created_by) VALUES ($1, $2, $3, $4, 'completed', 0, 0, 0, 0, 0, 0, '00000000-0000-0000-0000-000000000000'::UUID) RETURNING id`, [companyId, periodStart, periodEnd, periodEnd]);

      if (r.rows[0]) {
        let tGross = 0, tPaye = 0, tUifE = 0, tUifR = 0, tSdl = 0, tNet = 0;
        for (let e = 0; e < employees.rows.length; e++) {
          const salary = Math.round((baseSalaries[e] || 20000) * (1 + (year - 2022) * 0.06));
          const paye = Math.round(salary * 0.22 * 100) / 100;
          const uifE = Math.round(Math.min(salary, 17811.84) * 0.01 * 100) / 100;
          const sdl = Math.round(salary * 0.01 * 100) / 100;
          const net = Math.round((salary - paye - uifE) * 100) / 100;
          await client.query(`INSERT INTO payslips (payroll_run_id, employee_id, gross_pay, net_pay, paye, uif_employee, uif_employer, sdl, basic_salary) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [r.rows[0].id, employees.rows[e].id, salary, net, paye, uifE, uifE, sdl, salary]);
          tGross += salary; tPaye += paye; tUifE += uifE; tUifR += uifE; tSdl += sdl; tNet += net;
        }
        await client.query(`UPDATE payroll_runs SET total_gross=$1, total_net=$2, total_paye=$3, total_sdl=$4, total_uif_employee=$5, total_uif_employer=$6 WHERE id=$7`, [tGross, tNet, tPaye, tSdl, tUifE, tUifR, r.rows[0].id]);
        payrollCount++;
      }
    }
  }
  console.log(`  ✓ ${payrollCount} payroll runs (${payrollCount * employees.rows.length} payslips)\n`);

  // ── 7. LEAVE (2022-2025) ───────────────────────────────────────────────
  console.log('7. Seeding leave data...');
  const leaveTypes = await client.query(`SELECT id, code FROM leave_types`);
  let leaveCount = 0;

  for (const emp of employees.rows) {
    for (let year = 2022; year <= 2025; year++) {
      for (const lt of leaveTypes.rows) {
        const accrued = lt.code === 'annual' ? 15 : lt.code === 'sick' ? 10 : lt.code === 'family_responsibility' ? 3 : 0;
        const taken = Math.floor(Math.random() * Math.min(accrued, 8));
        await client.query(`INSERT INTO leave_balances (employee_id, leave_type_id, leave_type_code, year, accrued, taken, closing_balance) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (employee_id, leave_type_code, year) DO NOTHING`, [emp.id, lt.id, lt.code, year, accrued, taken, accrued - taken]);
      }
      // 1-2 leave applications per year
      for (let i = 0; i < 1 + Math.floor(Math.random() * 2); i++) {
        const m = 1 + Math.floor(Math.random() * 12);
        const d = 5 + Math.floor(Math.random() * 15);
        const days = 1 + Math.floor(Math.random() * 5);
        const lt = leaveTypes.rows[Math.floor(Math.random() * Math.min(3, leaveTypes.rows.length))];
        await client.query(`INSERT INTO leave_applications (company_id, employee_id, leave_type_id, leave_type_code, start_date, end_date, days, reason, status, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, 'Leave', 'approved', '00000000-0000-0000-0000-000000000000'::UUID)`, [companyId, emp.id, lt.id, lt.code, `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, `${year}-${String(m).padStart(2, '0')}-${String(Math.min(28, d + days)).padStart(2, '0')}`, days]);
        leaveCount++;
      }
    }
  }
  console.log(`  ✓ ${leaveCount} leave applications\n`);

  // ── 8. PURCHASE ORDERS (2024-2025) ─────────────────────────────────────
  console.log('8. Seeding purchase orders...');
  let poCount = 0;
  for (let year = 2024; year <= 2025; year++) {
    for (let month = 1; month <= 12; month++) {
      const n = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        const sup = suppliers.rows[Math.floor(Math.random() * suppliers.rows.length)];
        const subtotal = Math.round((5000 + Math.random() * 50000) * 100) / 100;
        const tax = Math.round(subtotal * 0.15 * 100) / 100;
        const num = `PO-${year}${String(month).padStart(2, '0')}-${String(i + 1).padStart(3, '0')}`;
        const r = await client.query(`INSERT INTO purchase_orders (company_id, po_number, supplier_id, order_date, status, subtotal, tax_amount, total, created_by) VALUES ($1, $2, $3, $4, 'received', $5, $6, $7, '00000000-0000-0000-0000-000000000000'::UUID) ON CONFLICT DO NOTHING RETURNING id`, [companyId, num, sup.id, `${year}-${String(month).padStart(2, '0')}-05`, subtotal, tax, subtotal + tax]);
        if (r.rows[0]) {
          const qty = 10 + Math.floor(Math.random() * 40);
          const up = Math.round(subtotal / qty * 100) / 100;
          await client.query(`INSERT INTO po_items (purchase_order_id, description, quantity, unit_price, tax_rate, line_total, tax_amount, quantity_received, sort_order) VALUES ($1, $2, $3, $4, 15, $5, $6, $7, 0)`, [r.rows[0].id, `Materials for ${num}`, qty, up, subtotal, tax, qty]);
          poCount++;
        }
      }
    }
  }
  console.log(`  ✓ ${poCount} purchase orders\n`);

  // ── 9. STOCK MOVEMENTS (2024-2025) ─────────────────────────────────────
  console.log('9. Seeding stock movements...');
  const products = await client.query(`SELECT id FROM products WHERE product_type = 'inventory'`);
  let stockCount = 0;
  for (const prod of products.rows) {
    for (let year = 2024; year <= 2025; year++) {
      for (let month = 1; month <= 12; month++) {
        await client.query(`INSERT INTO stock_movements (product_id, movement_type, quantity, unit_cost, total_cost, notes, created_by) VALUES ($1, 'purchase', $2, $3, $4, $5, '00000000-0000-0000-0000-000000000000'::UUID)`, [prod.id, 10 + Math.floor(Math.random() * 50), Math.round((50 + Math.random() * 500) * 100) / 100, 0, `Restock ${year}-${String(month).padStart(2, '0')}`]);
        stockCount++;
      }
    }
  }
  console.log(`  ✓ ${stockCount} stock movements\n`);

  // ── 10. ASSET DEPRECIATION (2025) ──────────────────────────────────────
  console.log('10. Seeding depreciation schedule...');
  const assets = await client.query(`SELECT id, purchase_price, useful_life_years, depreciation_method FROM assets`);
  let depCount = 0;
  for (const asset of assets.rows) {
    const monthlyDep = Math.round(asset.purchase_price / (asset.useful_life_years * 12) * 100) / 100;
    let accum = 0;
    for (let month = 1; month <= 15; month++) { // 15 months: Jan 2025 - Mar 2026
      const year = month <= 12 ? 2025 : 2026;
      const m = month <= 12 ? month : month - 12;
      accum += monthlyDep;
      await client.query(`INSERT INTO asset_depreciation_schedule (asset_id, period_date, depreciation_method, amount, accumulated_total, book_value_after) VALUES ($1, $2, $3, $4, $5, $6)`, [asset.id, `${year}-${String(m).padStart(2, '0')}-28`, asset.depreciation_method, monthlyDep, accum, Math.max(0, asset.purchase_price - accum)]);
      depCount++;
    }
    await client.query(`UPDATE assets SET accumulated_depreciation = $1, current_book_value = $2, last_depreciation_date = '2026-03-28' WHERE id = $3`, [accum, Math.max(0, asset.purchase_price - accum), asset.id]);
  }
  console.log(`  ✓ ${depCount} depreciation entries\n`);

  // ── 11. SARS SUBMISSIONS (2020-2025) ───────────────────────────────────
  console.log('11. Seeding SARS submissions...');
  let sarsCount = 0;
  for (let year = 2020; year <= 2025; year++) {
    for (let month = 1; month <= 12; month++) {
      const pStart = `${year}-${String(month).padStart(2, '0')}-01`;
      const pEnd = `${year}-${String(month).padStart(2, '0')}-${new Date(year, month, 0).getDate()}`;
      await client.query(`INSERT INTO sars_submissions (form_type, period_start, period_end, status, form_data) VALUES ('EMP201', $1, $2, 'submitted', $3, '00000000-0000-0000-0000-000000000000'::UUID)`, [pStart, pEnd, JSON.stringify({ paye: 15000 + year * 500, uif: 1200, sdl: 800 })]);
      sarsCount++;
      if (month % 2 === 0) {
        await client.query(`INSERT INTO sars_submissions (form_type, period_start, period_end, status, form_data) VALUES ('VAT201', $1, $2, 'submitted', $3, '00000000-0000-0000-0000-000000000000'::UUID)`, [pStart, pEnd, JSON.stringify({ output: 35000, input: 12000, net: 23000 })]);
        sarsCount++;
      }
    }
  }
  console.log(`  ✓ ${sarsCount} SARS submissions\n`);

  // ── 12. CUSTOMER PAYMENTS (2020-2025) ──────────────────────────────────
  console.log('12. Seeding customer payments...');
  let cpCount = 0;
  for (let year = 2020; year <= 2025; year++) {
    for (let month = 1; month <= 12; month++) {
      for (let i = 0; i < 2 + Math.floor(Math.random() * 3); i++) {
        const cust = customers.rows[Math.floor(Math.random() * customers.rows.length)];
        const amount = Math.round((5000 + Math.random() * 80000) * 100) / 100;
        const payDate = `${year}-${String(month).padStart(2, '0')}-${String(10 + Math.floor(Math.random() * 18)).padStart(2, '0')}`;
        await client.query(`INSERT INTO customer_payments (company_id, client_id, total_amount, payment_date, payment_method, payment_number, status, created_by) VALUES ($1, $2, $3, $4, 'eft', $5, 'confirmed', '00000000-0000-0000-0000-000000000000'::UUID)`, [companyId, cust.id, amount, payDate, `RCP-${year}${String(month).padStart(2, '0')}-${i + 1}`]);
        cpCount++;
      }
    }
  }
  console.log(`  ✓ ${cpCount} customer payments\n`);

  // ── 13. SUPPLIER PAYMENTS (2020-2025) ──────────────────────────────────
  console.log('13. Seeding supplier payments...');
  let spCount = 0;
  for (let year = 2020; year <= 2025; year++) {
    for (let month = 1; month <= 12; month++) {
      for (let i = 0; i < 2 + Math.floor(Math.random() * 2); i++) {
        const sup = suppliers.rows[Math.floor(Math.random() * suppliers.rows.length)];
        const amount = Math.round((3000 + Math.random() * 40000) * 100) / 100;
        const payDate = `${year}-${String(month).padStart(2, '0')}-${String(15 + Math.floor(Math.random() * 13)).padStart(2, '0')}`;
        await client.query(`INSERT INTO supplier_payments (company_id, supplier_id, total_amount, payment_date, payment_method, payment_number, reference, status, created_by) VALUES ($1, $2, $3, $4, 'eft', $5, $5, 'confirmed', '00000000-0000-0000-0000-000000000000'::UUID)`, [companyId, sup.id, amount, payDate, `PAY-${year}${String(month).padStart(2, '0')}-${i + 1}`]);
        spCount++;
      }
    }
  }
  console.log(`  ✓ ${spCount} supplier payments\n`);

  // ── SUMMARY ────────────────────────────────────────────────────────────
  console.log('=== SEED COMPLETE ===\n');
  const counts = await client.query(`
    SELECT
      (SELECT COUNT(*) FROM gl_journal_entries) as journals,
      (SELECT COUNT(*) FROM customer_invoices) as cust_invoices,
      (SELECT COUNT(*) FROM supplier_invoices) as sup_invoices,
      (SELECT COUNT(*) FROM customer_payments) as cust_payments,
      (SELECT COUNT(*) FROM supplier_payments) as sup_payments,
      (SELECT COUNT(*) FROM bank_transactions) as bank_tx,
      (SELECT COUNT(*) FROM payroll_runs) as payroll_runs,
      (SELECT COUNT(*) FROM payslips) as payslips,
      (SELECT COUNT(*) FROM leave_applications) as leave_apps,
      (SELECT COUNT(*) FROM purchase_orders) as pos,
      (SELECT COUNT(*) FROM stock_movements) as stock_moves,
      (SELECT COUNT(*) FROM asset_depreciation_schedule) as dep_entries,
      (SELECT COUNT(*) FROM sars_submissions) as sars_subs
  `);
  console.log('Final counts:');
  for (const [k, v] of Object.entries(counts.rows[0])) console.log(`  ${k}: ${v}`);
  await client.end();
}

seed().catch(err => { console.error('SEED FAILED:', err.message); process.exit(1); });
