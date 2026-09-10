/**
 * Bank Categorisation Rules Service — CRUD
 * Rule-matching and auto-application logic lives in bankRulesMatchingService.ts.
 */

import { sql } from '@/lib/neon';
import {detachRuleInput,withBankRuleChange,recordBankRuleChange} from './bankRuleChangeControl';
import { log } from '@/lib/logger';
import type {
  BankCategorisationRule, RuleCreateInput, RuleApplyResult,
} from '../../types/bank.types';

// Re-export matching function for backward compatibility
export type { RuleApplyResult };
export { applyRules } from './bankRulesMatchingService';

// ── CRUD ────────────────────────────────────────────────────────────────────

export async function getRules(companyId: string): Promise<BankCategorisationRule[]> {
  const rows = (await sql`
    SELECT r.*, ga.account_code AS gl_account_code, ga.account_name AS gl_account_name,
           s.company_name AS supplier_name, c.name AS client_name
    FROM bank_categorisation_rules r
    LEFT JOIN gl_accounts ga ON ga.id = r.gl_account_id
    LEFT JOIN suppliers s ON s.id = r.supplier_id
    LEFT JOIN customers c ON c.id = r.client_id
    WHERE r.company_id = ${companyId}::UUID
    ORDER BY r.priority ASC, r.rule_name ASC
  `) as Record<string, unknown>[];
  return rows.map(mapRuleRow);
}

export async function createRule(
  companyId: string,
  input: RuleCreateInput,
  userId: string
): Promise<BankCategorisationRule> {
  input=detachRuleInput(input);
  if(typeof userId!=='string')throw new Error('Rule caller assertion required');
  return withBankRuleChange(companyId,[],async(ctx)=>{
  await assertOwnedRuleReferences(companyId,input.glAccountId || null,input.supplierId || null,input.clientId || null);
  const vatCode = input.vatCode || 'none';
  const rows = (await sql`
    INSERT INTO bank_categorisation_rules (
      company_id, rule_name, match_field, match_type, match_pattern,
      gl_account_id, supplier_id, client_id, description_template,
      priority, auto_create_entry, vat_code, created_by
    ) VALUES (
      ${companyId}::UUID, ${input.ruleName}, ${input.matchField}, ${input.matchType}, ${input.matchPattern},
      ${input.glAccountId || null}::UUID, ${input.supplierId || null}::UUID,
      ${input.clientId || null}::UUID,
      ${input.descriptionTemplate || null},
      ${input.priority || 100}, ${input.autoCreateEntry === true}, ${vatCode}, ${userId}
    ) RETURNING *
  `) as Record<string, unknown>[];
  await recordBankRuleChange(ctx,String(rows[0]!.id),null,rows[0]!, 'created');
  log.info('Created bank rule', { id: rows[0]!.id, ruleName: input.ruleName }, 'accounting');
  return mapRuleRow(rows[0]!);
  },userId);
}

export async function updateRule(
  companyId: string,
  id: string,
  input: Partial<RuleCreateInput> & { isActive?: boolean }
): Promise<BankCategorisationRule> {
  input=detachRuleInput(input);
  return withBankRuleChange(companyId,[id],async(ctx,[before])=>{
  await assertOwnedRuleReferences(companyId,input.glAccountId ?? before!.gl_account_id,input.supplierId ?? before!.supplier_id,input.clientId ?? before!.client_id);
  const fields={ruleName:'rule_name',matchField:'match_field',matchType:'match_type',matchPattern:'match_pattern',glAccountId:'gl_account_id',supplierId:'supplier_id',clientId:'client_id',descriptionTemplate:'description_template',priority:'priority',autoCreateEntry:'auto_create_entry',vatCode:'vat_code',isActive:'is_active'} as const;
  if(Object.entries(fields).every(([key,column])=>{const value=input[key as keyof typeof input];return value==null||value===before![column];}))return mapRuleRow(before!);
  // Use ?? not || so legitimately-zero priorities and false booleans are not
  // dropped by COALESCE. Fields with min(1) (ruleName, matchPattern) and enums
  // can't be empty strings, so ?? matches the schema invariants.
  const rows = (await sql`
    UPDATE bank_categorisation_rules SET
      rule_name = COALESCE(${input.ruleName ?? null}, rule_name),
      match_field = COALESCE(${input.matchField ?? null}, match_field),
      match_type = COALESCE(${input.matchType ?? null}, match_type),
      match_pattern = COALESCE(${input.matchPattern ?? null}, match_pattern),
      gl_account_id = COALESCE(${input.glAccountId ?? null}::UUID, gl_account_id),
      supplier_id = COALESCE(${input.supplierId ?? null}::UUID, supplier_id),
      client_id = COALESCE(${input.clientId ?? null}::UUID, client_id),
      description_template = COALESCE(${input.descriptionTemplate ?? null}, description_template),
      priority = COALESCE(${input.priority ?? null}, priority),
      auto_create_entry = COALESCE(${input.autoCreateEntry ?? null}, auto_create_entry),
      vat_code = COALESCE(${input.vatCode ?? null}, vat_code),
      is_active = COALESCE(${input.isActive ?? null}, is_active)
    WHERE company_id = ${companyId}::UUID AND id = ${id}::UUID RETURNING *
  `) as Record<string, unknown>[];
  if (!rows[0]) throw new Error(`Rule ${id} not found`);
  await recordBankRuleChange(ctx,String(before!.id),before!,rows[0], 'updated');
  return mapRuleRow(rows[0]);
  });
}

export async function deleteRule(companyId: string, id: string): Promise<void> {
  await deleteRules(companyId,[id]);
}

export async function deleteRules(companyId: string, ids: string[]): Promise<number> {
  return withBankRuleChange(companyId,ids,async(ctx,rows)=>{
    if(!rows.length)return 0;
    const deleted=await ctx.sql`DELETE FROM bank_categorisation_rules WHERE company_id=${companyId}::uuid AND id=ANY(${rows.map(row=>row.id)}::uuid[]) RETURNING id` as {id:string}[];
    const affected=new Set(deleted.map(row=>row.id));
    if(deleted.length!==rows.length||affected.size!==rows.length||rows.some(row=>!affected.has(String(row.id))))throw new Error('Bank rule deletion did not affect the exact owned population');
    for(const row of rows)await recordBankRuleChange(ctx,String(row.id),row,null,'deleted');
    return rows.length;
  });
}

export async function toggleRule(companyId: string, id: string, isActive: boolean): Promise<void> {
  if(typeof isActive!=='boolean')throw new Error('Invalid rule activation');
  await withBankRuleChange(companyId,[id],async(ctx,[before])=>{
    if(before!.is_active===isActive)return;
    const [after]=await ctx.sql`UPDATE bank_categorisation_rules SET is_active=${isActive} WHERE company_id=${companyId}::uuid AND id=${id}::uuid RETURNING *` as Record<string,unknown>[];
    await recordBankRuleChange(ctx,String(before!.id),before!,after!,'toggled');
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function mapRuleRow(row: Record<string, unknown>): BankCategorisationRule {
  return {
    id: String(row.id),
    ruleName: String(row.rule_name),
    matchField: String(row.match_field) as BankCategorisationRule['matchField'],
    matchType: String(row.match_type) as BankCategorisationRule['matchType'],
    matchPattern: String(row.match_pattern ?? row.match_value ?? ''),
    glAccountId: row.gl_account_id ? String(row.gl_account_id) : undefined,
    supplierId: row.supplier_id ? String(row.supplier_id) : undefined,
    clientId: row.client_id ? String(row.client_id) : undefined,
    descriptionTemplate: row.description_template ? String(row.description_template) : undefined,
    priority: Number(row.priority),
    isActive: Boolean(row.is_active),
    autoCreateEntry: Boolean(row.auto_create_entry),
    vatCode: (row.vat_code || 'none') as BankCategorisationRule['vatCode'],
    createdBy: row.created_by ? String(row.created_by) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    glAccountCode: row.gl_account_code ? String(row.gl_account_code) : undefined,
    glAccountName: row.gl_account_name ? String(row.gl_account_name) : undefined,
    supplierName: row.supplier_name ? String(row.supplier_name) : undefined,
    clientName: row.client_name ? String(row.client_name) : undefined,
  };
}

/** Validate effective references inside the mutation savepoint, including no-op updates. */
async function assertOwnedRuleReferences(companyId:string,gl:unknown,supplier:unknown,customer:unknown):Promise<void>{
  if(gl!=null){
    if(typeof gl!=='string')throw new Error('Invalid bank rule reference');
    const rows=await sql`SELECT id FROM gl_accounts WHERE company_id=${companyId}::uuid AND id=${gl}::uuid FOR SHARE`;
    if(rows.length!==1)throw new Error('Bank rule reference not found in company');
  }
  if(supplier!=null){
    if(typeof supplier!=='string')throw new Error('Invalid bank rule reference');
    const rows=await sql`SELECT id FROM suppliers WHERE company_id=${companyId}::uuid AND id=${supplier}::uuid FOR SHARE`;
    if(rows.length!==1)throw new Error('Bank rule reference not found in company');
  }
  if(customer!=null){
    if(typeof customer!=='string')throw new Error('Invalid bank rule reference');
    const rows=await sql`SELECT id FROM customers WHERE company_id=${companyId}::uuid AND id=${customer}::uuid FOR SHARE`;
    if(rows.length!==1)throw new Error('Bank rule reference not found in company');
  }
}
