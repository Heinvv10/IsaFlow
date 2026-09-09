import {HISTORICAL_SOURCE_MAX_BYTES} from './historicalImportExactPlan';
/** Exact UTF-8 source tokenizer, before any financial normalization or grouping. */
export function historicalCsvRows(bytes:Buffer,delimiter:','|';'):string[][]{
 if(!Buffer.isBuffer(bytes)||bytes.length===0||bytes.length>HISTORICAL_SOURCE_MAX_BYTES)throw new Error('Historical artifact byte bound exceeded');
 let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new Error('Historical artifact must be valid UTF-8');}
 if(text.startsWith('\ufeff'))text=text.slice(1);
 const result:string[][]=[];let row:string[]=[],cell='',quoted=false,closed=false;
 const pushCell=()=>{row.push(cell);cell='';closed=false;if(row.length>100)throw new Error('Historical CSV column bound exceeded');};
 const pushRow=()=>{pushCell();result.push(row);row=[];if(result.length>100001)throw new Error('Historical CSV record bound exceeded');};
 for(let i=0;i<text.length;i++){
  const char=text[i]!;
  if(quoted){if(char==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=char;}
  else if(char===delimiter)pushCell();
  else if(char==='\n'||char==='\r'){if(char==='\r'&&text[i+1]==='\n')i++;pushRow();}
  else if(char==='"'&&cell===''&&!closed)quoted=true;
  else{if(closed||char==='"')throw new Error('Malformed historical CSV quote');cell+=char;}
  if(cell.length>20000)throw new Error('Historical CSV cell bound exceeded');
 }
 if(quoted)throw new Error('Unterminated historical CSV quote');
 if(cell||row.length||closed)pushRow();
 return result;
}
