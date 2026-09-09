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
