import {randomUUID} from 'node:crypto';
import {gl39Fixture} from './gl39Fixture';
import {prepareBankAllocation} from '@/modules/accounting/services/bank/bankAllocationControl';
import type {BankAllocationPlan} from '@/modules/accounting/services/bank/bankAllocationPlan';
import type {OperationRef} from '@/modules/accounting/services/controls/contracts';
import {requestOperationApproval,decideOperationApproval} from '@/modules/accounting/services/controls/approvalRequestService';
/** Reuses reviewed issued identity/transaction lifecycle; seeds source data only. */
export async function bank39Fixture(){
 const g=await gl39Fixture(),{pool,f}=g;
 const bank=randomUUID(),expense=randomUUID(),receivable=randomUUID(),customer=randomUUID();
 try{
  for(const [id,type,role] of [[bank,'asset','bank'],[expense,'expense','default_expense'],[receivable,'asset','receivable']])await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account,level) VALUES($1,$2,left($1::uuid::text,20),$3,$4,$3,'debit',true,true,3)",[id,f.companyA,role,type]);
  await pool.query("INSERT INTO bank_accounts(company_id,account_name,gl_account_id,currency) VALUES($1,'BANK39 bank',$2,'ZAR')",[f.companyA,bank]);
  await pool.query("INSERT INTO customers(id,company_id,name,auto_allocate_strategy) VALUES($1,$2,'BANK39 customer','oldest')",[customer,f.companyA]);
  await pool.query("INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role) VALUES($1,$2,'BANK39 payment approval','payment','amount','any',0,'admin')",[randomUUID(),f.companyA]);
 }catch(error){await g.close();throw error;}
 async function source(amount='-115',date='2026-03-01T00:30:00+02:00'){
  const id=randomUUID();await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status) VALUES($1,$2,$3,$4,$5,'BANK39 source','imported')",[id,f.companyA,bank,date,amount]);return id;
 }
 async function approve(operation:OperationRef,pat=false){const a=await g.actor(ctx=>requestOperationApproval(ctx,operation),'u1',pat);await g.actor(ctx=>decideOperationApproval(ctx,a.id,'approved'),'u2');return a.id;}
 async function prepare(plan:BankAllocationPlan,pat=false){const p=await g.actor(ctx=>prepareBankAllocation(ctx,plan),'u1',pat);return{...p,approvalId:await approve(p.operation,pat)};}
 const lines=async(id:string)=>(await pool.query('SELECT gl_account_id,debit::text,credit::text,vat_type FROM gl_journal_lines WHERE company_id=$1 AND journal_entry_id=$2 ORDER BY gl_account_id',[f.companyA,id])).rows;
 return{...g,bank,expense,receivable,customer,source,approve,prepare,lines};
}
