import {z} from 'zod';
import {canonicalJson} from '../controls/canonical';
export const DEFAULT_ACCOUNT_ROLES={sales_revenue:{subtype:'default_revenue',type:'revenue'},sales_vat_output:{subtype:'vat_output',type:'liability'},
 accounts_receivable:{subtype:'receivable',type:'asset'},cost_of_sales:{subtype:'default_expense',type:'expense'},purchase_vat_input:{subtype:'vat_input',type:'asset'},
 accounts_payable:{subtype:'payable',type:'liability'},primary_bank:{subtype:'bank',type:'asset'},retained_earnings:{subtype:'retained_earnings',type:'equity'}} as const;
export class DefaultAccountsValidationError extends Error {}
export type DefaultAccountKey=keyof typeof DEFAULT_ACCOUNT_ROLES;
export type DefaultAccountsMappings=Partial<Record<DefaultAccountKey,string|null>>;
const account=z.union([z.string().uuid().transform(id=>id.toLowerCase()),z.literal(''),z.null()]).optional();
const schema=z.object({mappings:z.object({sales_revenue:account,sales_vat_output:account,accounts_receivable:account,cost_of_sales:account,
 purchase_vat_input:account,accounts_payable:account,primary_bank:account,retained_earnings:account}).strict()}).strict();
export function parseDefaultAccountsInput(value:unknown):DefaultAccountsMappings{
 let mappings:DefaultAccountsMappings;
 try{mappings=schema.parse(JSON.parse(canonicalJson(value))).mappings;}catch{throw new DefaultAccountsValidationError('Invalid default account mappings');}
 const ids=Object.values(mappings).filter(Boolean);
 if(new Set(ids).size!==ids.length)throw new DefaultAccountsValidationError('One account cannot serve distinct default account roles');
 return mappings;
}
