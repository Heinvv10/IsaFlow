import {describe,expect,it} from 'vitest';
import {readdirSync,readFileSync} from 'node:fs';
import {join,relative} from 'node:path';
/**
 * Control rows are looked up by the stored `entity_id_canonical` column (migration 684), never by `lower(entity_id)`:
 * lower() is not leakproof, so under FORCE RLS such a comparison is never an index condition and scans the company.
 * Projections (`SELECT lower(e.entity_id) AS entity_id`, `ORDER BY`, `GROUP BY`) are not comparisons and stay allowed.
 * The one allowed comparison is control_policy_exposure's residual filter, inside a window-index bucket, on a table
 * that has no canonical column.
 *
 * This is a LEXICAL guard over src/, pages/ and scripts/ (SQL comments in .sql files ignored). It catches quoted,
 * interpolated and schema-less aliases, casts and extra parentheses inside lower(), a COLLATE before the operator, and
 * =, <>, !=, <, <=, >, >=, ~, ~*, !~, LIKE, ILIKE, IN and IS [NOT] DISTINCT FROM on either side. It does NOT parse SQL, so
 * it cannot see a comparison assembled by string or template concatenation (`'lower('+alias+'.entity_id)='`), and it
 * cannot tell a plain join `entity_id_canonical = x.id::text` (unindexable under RLS: the cast is not leakproof) from
 * the same text inside a LATERAL, where it is a Param. Those are covered only by the plan gates
 * (controlCanonicalIndexPath / controlCanonicalJoinPath), and only for the services those gates enumerate.
 */
const REPO=join(__dirname,'../../../..');
const ROOTS=['src','pages','scripts'];
const ALLOWED:Record<string,number>={'src/modules/accounting/services/controls/aggregateOperationPolicy.ts':1};
const ALIAS=String.raw`(?:"\w+"|\w+|\$\{[^}]*\})\s*\.\s*`;
const LOWER=String.raw`lower\(\s*\(?\s*(?:${ALIAS})?"?entity_id"?\s*(?:::\s*\w+\s*)?\)?\s*\)`;
const OPERATOR=String.raw`(?:<>|!=|>=|<=|=|<|>|!?~\*?|\bI?LIKE\b|\bIN\b|\bIS\s+(?:NOT\s+)?DISTINCT\s+FROM\b)`;
const COMPARISON=new RegExp(String.raw`${LOWER}\s*(?:COLLATE\s+(?:"[^"]+"|\w+)\s*)?${OPERATOR}|${OPERATOR}\s*${LOWER}`,'gi');
function sources(dir:string):string[]{
 return readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?(entry.name==='node_modules'?[]:sources(join(dir,entry.name)))
  :/\.(ts|tsx|js|mjs|sql)$/.test(entry.name)?[join(dir,entry.name)]:[]);
}
function lowerEntityComparisons(text:string,sql=false):number{
 return (sql?text.replace(/--.*$/gm,''):text).match(COMPARISON)?.length??0;
}
describe('canonical entity lookups',()=>{
 it('no source compares lower(entity_id); lookups use entity_id_canonical',()=>{
  const found=ROOTS.flatMap(root=>sources(join(REPO,root))).map(file=>({file:relative(REPO,file),
   count:lowerEntityComparisons(readFileSync(file,'utf8'),file.endsWith('.sql'))})).filter(({file,count})=>count!==(ALLOWED[file]??0));
  expect(found,'lower(entity_id) used as a comparison — compare entity_id_canonical instead').toEqual([]);
 });
 it.each([
  ['bare column','AND lower(entity_id)=$1'],
  ['alias','AND lower(e.entity_id) = $1'],
  ['quoted alias','AND lower("e".entity_id)=$1'],
  ['quoted column','AND lower(e."entity_id")=$1'],
  ['interpolated alias','AND lower(${alias}.entity_id)=$1'],
  ['cast inside lower','AND lower(e.entity_id::text)=$1'],
  ['extra parentheses','AND lower((e.entity_id))=$1'],
  ['collation before the operator','AND lower(e.entity_id) COLLATE "C" = $1'],
  ['not equal','AND lower(e.entity_id)<>$1'],
  ['bang equal','AND lower(e.entity_id) != $1'],
  ['greater or equal','AND lower(e.entity_id)>=$1'],
  ['regex match','AND lower(e.entity_id) ~ $1'],
  ['ilike','AND lower(e.entity_id) ILIKE $1'],
  ['like','AND lower(e.entity_id) LIKE $1'],
  ['in list','AND lower(e.entity_id) IN ($1,$2)'],
  ['is distinct from','AND lower(e.entity_id) IS DISTINCT FROM $1'],
  ['is not distinct from','AND lower(e.entity_id) IS NOT DISTINCT FROM $1'],
  ['right-hand side','AND i.id::text = lower(e.entity_id)'],
  ['right-hand side, distinct from','AND $1 IS NOT DISTINCT FROM lower(entity_id)'],
 ])('catches a comparison: %s',(_form,text)=>{expect(lowerEntityComparisons(text)).toBe(1);});
 it('ignores projections, ordering, grouping, index definitions and SQL comments',()=>{
  expect(lowerEntityComparisons('SELECT lower(e.entity_id) AS entity_id ORDER BY lower(e.entity_id) GROUP BY e.operation,lower(e.entity_id)')).toBe(0);
  expect(lowerEntityComparisons('CREATE INDEX x ON t(company_id,lower(entity_id));\n-- may not evaluate lower(entity_id)=... first',true)).toBe(0);
 });
 it('cannot see a comparison built by concatenation: the plan gates cover those',()=>{
  expect(lowerEntityComparisons("'lower('+alias+'.entity_id)='+value")).toBe(0);
 });
});
