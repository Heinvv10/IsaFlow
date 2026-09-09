import {expect,it} from 'vitest';
import {analysePayrollControls} from '@/modules/accounting/services/controls/payrollControlAnalysis';
import {payrollPopulation} from './payrollControlFixture';
const kinds=(source:ReturnType<typeof payrollPopulation>)=>analysePayrollControls(source).findings.map(row=>row.finding.kind);
it('reconciles complete payroll totals and exact ledger liabilities without inventing bank confirmation',()=>{
 const result=analysePayrollControls(payrollPopulation());expect(result.findings).toHaveLength(0);
 expect(result.missing).toContain('independent_employee_settlement_evidence_unavailable');
});
it('detects header total and complete employee count mismatch',()=>{
 const source=payrollPopulation();source.runs[0].header.total_net='91.01';source.runs[0].header.employee_count=2;
 expect(kinds(source)).toContain('payroll_totals_mismatch');
});
it('detects balanced but inverted payroll liability legs',()=>{
 const source=payrollPopulation();source.runs[0].journal!.lines.forEach(line=>{[line.debit,line.credit]=[line.credit,line.debit];});
 expect(kinds(source)).toContain('payroll_journal_mismatch');
});
it('separates legitimate final-period wages from payment after prior termination',()=>{
 const source=payrollPopulation();source.employees[0].end_date='2026-09-15';source.employees[0].status='terminated';
 expect(kinds(source)).not.toContain('payroll_after_termination');source.employees[0].end_date='2026-08-31';
 expect(kinds(source)).toContain('payroll_after_termination');
});
it('detects zero total employer cost, not merely zero net pay',()=>{
 const source=payrollPopulation();source.runs[0].lines[0].net_pay='0.00';expect(kinds(source)).not.toContain('payroll_zero_cost');
 Object.assign(source.runs[0].lines[0],{gross_pay:'0.00',uif_employer:'0.00',sdl:'0.00',eti:'0.00'});
 expect(kinds(source)).toContain('payroll_zero_cost');
});
it('classifies shared beneficiaries and changed components as candidates without secrets',()=>{
 const source=payrollPopulation();source.beneficiaryGroups=[['employee','other']];source.componentChanges=[{employeeId:'employee',eventId:'event',runId:'run'}];
 const result=analysePayrollControls(source);expect(result.findings.map(row=>row.finding.kind)).toEqual(expect.arrayContaining(['payroll_beneficiary_reuse','payroll_component_change']));
 expect(result.findings.every(row=>row.finding.classification==='candidate')).toBe(true);
 expect(JSON.stringify(result)).not.toContain('1234567890');
});
it('reports missing or bounded evidence as unknown source coverage',()=>{
 const source=payrollPopulation();source.runs[0].journal=null;
 const result=analysePayrollControls(source);source.over=true;expect(analysePayrollControls(source).missing).toContain('async_scan_required:payroll_population_exceeds_10000');
 expect(result.missing).toContain('payroll_journal_evidence_unavailable');
});
it('compares declared UIF contribution and posted settlement independently',()=>{
 const source=payrollPopulation();source.declarations=[{id:'declaration',year:2026,month:9,employee:'1.00',employer:'1.00',status:'paid',journal:null}];
 expect(analysePayrollControls(source).missing).toContain('uif_settlement_journal_unavailable');
 source.declarations[0].employee='2.00';expect(kinds(source)).toContain('payroll_uif_declaration_mismatch');
});

it('does not label a truncated source as a confirmed totals mismatch',()=>{const source=payrollPopulation();source.over=true;source.runs[0].lines=[];expect(analysePayrollControls(source).findings).toHaveLength(0);});
it('keeps an exact-cent difference beyond JavaScript safe-integer range',()=>{
 const source=payrollPopulation(),run=source.runs[0];run.header.total_gross='9007199254740992.01';run.lines[0].gross_pay='9007199254740992.02';
 expect(kinds(source)).toContain('payroll_totals_mismatch');
});
it('identifies approved reversed journals without adopting their former posting',()=>{
 const source=payrollPopulation();source.runs[0].journal!.reversed=true;expect(kinds(source)).toContain('payroll_journal_state_mismatch');
});
it('does not call absent current costing accounts an arithmetic fraud finding',()=>{
 const source=payrollPopulation();source.accounts=[];const result=analysePayrollControls(source);
 expect(result.missing).toContain('payroll_expected_ledger_material_unavailable');expect(result.findings).toHaveLength(0);
});
it('reconciles an explicit UIF debit-bank credit settlement and detects its reversal',()=>{
 const source=payrollPopulation();source.declarations=[{id:'declaration',year:2026,month:9,employee:'1.00',employer:'1.00',status:'paid',
 journal:{id:'uif-journal',status:'posted',source:'auto_payroll',sourceRecordId:null,reversed:false,lines:[{glAccountId:'2150',debit:'2.00',credit:'0.00'},{glAccountId:'1110',debit:'0.00',credit:'2.00'}]}}];
 expect(kinds(source)).not.toContain('payroll_uif_settlement_mismatch');source.declarations[0].journal!.reversed=true;
 expect(kinds(source)).toContain('payroll_uif_settlement_mismatch');
});
it('does not treat a new empty draft run as a confirmed payroll discrepancy',()=>{
 const source=payrollPopulation();Object.assign(source.runs[0].header,{status:'draft',employee_count:0});source.runs[0].lines=[];source.runs[0].journal=null;
 const result=analysePayrollControls(source);expect(result.findings).toHaveLength(0);expect(result.missing).toContain('uncalculated_payroll_run');
});
it('accepts an explicit UIF settlement using an owned alternate bank account',()=>{
 const source=payrollPopulation();source.accounts.push({id:'alternate-bank',account_code:'1115',account_type:'asset',account_subtype:'bank',is_active:true});
 source.declarations=[{id:'declaration',year:2026,month:9,employee:'1.00',employer:'1.00',status:'paid',journal:{id:'uif-journal',status:'posted',source:'auto_payroll',sourceRecordId:null,reversed:false,
 lines:[{glAccountId:'2150',debit:'2.00',credit:'0.00'},{glAccountId:'alternate-bank',debit:'0.00',credit:'2.00'}]}}];
 expect(kinds(source)).not.toContain('payroll_uif_settlement_mismatch');
});
it('uses distinct stable finding identities for overlapping beneficiary groups',()=>{
 const source=payrollPopulation();source.beneficiaryGroups=[['employee','other'],['employee','third']];
 const result=analysePayrollControls(source);expect(new Set(result.findings.map(row=>row.finding.key)).size).toBe(2);
 expect(result.findings.every(row=>new Set(row.finding.entities.map(e=>e.entityId)).size===row.finding.entities.length)).toBe(true);
});
it('keeps distinct employee salary changes separately addressable between the same runs',()=>{
 const source=payrollPopulation();source.componentChanges=[{employeeId:'employee',runId:'run',eventId:'prior'},{employeeId:'other',runId:'run',eventId:'prior'}];
 const findings=analysePayrollControls(source).findings.filter(f=>f.finding.kind==='payroll_component_change');
 expect(findings).toHaveLength(2);expect(new Set(findings.map(f=>f.finding.key)).size).toBe(2);
});
it.each(['draft','calculated','cancelled'])('excludes %s payroll from the canonical UIF declaration population',status=>{
 const source=payrollPopulation();source.runs[0].header.status=status;source.runs[0].journal=null;
 source.declarations=[{id:'declaration',year:2026,month:9,employee:'0.00',employer:'0.00',status:'draft',journal:null}];
 expect(kinds(source)).not.toContain('payroll_uif_declaration_mismatch');
});
it('keeps a current cost-centre change separate from confirmed historic financial discrepancies',()=>{
 const source=payrollPopulation();source.accounts[0].account_type='expense';source.employees[0].cost_centre_id='new-centre';
 source.accounts.push({id:'new-expense',account_code:'5201',account_type:'expense',is_active:true});source.mappings=[{cost_centre_id:'new-centre',expense_account_id:'new-expense'}];
 const result=analysePayrollControls(source);expect(result.findings.map(f=>f.finding.kind)).not.toContain('payroll_journal_mismatch');
 expect(result.findings.find(f=>f.finding.kind==='payroll_cost_allocation_difference')?.finding.classification).toBe('candidate');
 expect(result.missing).toContain('historical_payroll_cost_allocation_basis_unavailable');
 source.runs[0].journal!.lines.find(line=>line.glAccountId==='2140')!.credit='9.00';
 expect(kinds(source)).toContain('payroll_journal_mismatch');
});
it('does not excuse expense-role violations as an unknown allocation change',()=>{
 const source=payrollPopulation();source.accounts.push({id:'cash',account_code:'1115',account_type:'asset',is_active:true});
 source.runs[0].journal!.lines[0]!.glAccountId='cash';
 expect(kinds(source)).toContain('payroll_journal_mismatch');
});
it('still confirms nonzero UIF declared against an entirely unapproved payroll population',()=>{
 const source=payrollPopulation();source.runs[0].header.status='calculated';source.runs[0].journal=null;
 source.declarations=[{id:'declaration',year:2026,month:9,employee:'1.00',employer:'1.00',status:'draft',journal:null}];
 expect(kinds(source)).toContain('payroll_uif_declaration_mismatch');
});
