import {describe,expect,it} from 'vitest';
import {readdirSync,readFileSync} from 'node:fs';
import {join,relative} from 'node:path';
/**
 * Control rows are looked up by the stored `entity_id_canonical` column (migration 684), never by `lower(entity_id)`:
 * lower() is not leakproof, so under FORCE RLS such a comparison is never an index condition and scans the company.
 * Projections (`SELECT lower(e.entity_id) AS entity_id`, `ORDER BY`, `GROUP BY`) are not comparisons and stay allowed.
 * The one allowed comparison is control_policy_exposure's residual filter, inside a window-index bucket, on a table
 * that has no canonical column.
 */
const ROOT=join(__dirname,'../../../../src');
const ALLOWED:Record<string,number>={'modules/accounting/services/controls/aggregateOperationPolicy.ts':1};
const LOWER=String.raw`lower\(\s*(?:\w+\.)?entity_id\s*\)`;
const COMPARISON=new RegExp(`${LOWER}\\s*(?:=|<>|!=|\\bIN\\b|\\bLIKE\\b)|(?:=|<>|!=)\\s*${LOWER}`,'gi');
function sources(dir:string):string[]{
 return readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?sources(join(dir,entry.name))
  :/\.(ts|tsx)$/.test(entry.name)?[join(dir,entry.name)]:[]);
}
function lowerEntityComparisons(text:string):number{return text.match(COMPARISON)?.length??0;}
describe('canonical entity lookups',()=>{
 it('no source compares lower(entity_id); lookups use entity_id_canonical',()=>{
  const found=sources(ROOT).map(file=>({file:relative(ROOT,file),count:lowerEntityComparisons(readFileSync(file,'utf8'))}))
   .filter(({file,count})=>count!==(ALLOWED[file]??0));
  expect(found,'lower(entity_id) used as a comparison — compare entity_id_canonical instead').toEqual([]);
 });
 it('recognises comparisons in either order and ignores projections',()=>{
  expect(lowerEntityComparisons("AND lower(e.entity_id)=${id} OR x.id::text = lower(entity_id) AND lower(entity_id) IN (1)")).toBe(3);
  expect(lowerEntityComparisons('SELECT lower(e.entity_id) AS entity_id ORDER BY lower(e.entity_id) GROUP BY e.operation,lower(e.entity_id)')).toBe(0);
 });
});
