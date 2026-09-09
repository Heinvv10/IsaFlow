#!/usr/bin/env bun
import {parseArgs} from 'node:util';
import {resolve,dirname,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir,readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
/** Existing Bun bundler resolves application aliases; installed runtime packages stay external. */
async function main(){
 const {values}=parseArgs({args:process.argv.slice(2),strict:true,options:{outfile:{type:'string'}}});
 if(!values.outfile||!isAbsolute(values.outfile)||!('bun' in process.versions))throw new Error('Bun and explicit absolute artifact output required');
 await mkdir(dirname(values.outfile),{recursive:true});
 const here=dirname(fileURLToPath(import.meta.url));
 const manifest=JSON.parse(await readFile(resolve(here,'../../package.json'),'utf8')) as {dependencies?:Record<string,string>;devDependencies?:Record<string,string>};
 const external=Object.keys({...manifest.dependencies,...manifest.devDependencies}).flatMap(name=>['--external',name]);
 const built=spawnSync(process.execPath,['build',resolve(here,'run-audit-job.ts'),'--target','node','--format','cjs','--outfile',values.outfile,...external],{stdio:'pipe',maxBuffer:8192});
 if(built.error||built.status!==0)throw new Error('Audit child artifact build failed');
}
void main().catch(()=>{process.exitCode=1;});
