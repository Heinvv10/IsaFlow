const META=['sourceSystem','sourceKey','kind','mode','accountingDate','currency'];
const DOCUMENT=['partyId','invoiceNumber','dueDate','subtotal','taxAmount','totalAmount','amountPaid','settlements'];
const LINE=['recordId','accountCode','debit','credit','description','vatType'];
function rows(text:string):string[][]{
 const result:string[][]=[];let row:string[]=[],cell='',quoted=false,closed=false;
 const pushCell=()=>{row.push(cell);cell='';closed=false;};
 const pushRow=()=>{pushCell();result.push(row);row=[];if(result.length>1001)throw new Error('Historical CSV row bound exceeded');};
 for(let i=0;i<text.length;i++){
  const char=text[i]!;
  if(quoted){if(char==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=char;}
  else if(char===',')pushCell();
  else if(char==='\n'||char==='\r'){if(char==='\r'&&text[i+1]==='\n')i++;pushRow();}
  else if(char==='"'&&cell===''&&!closed)quoted=true;
  else{if(closed||char==='"')throw new Error('Malformed historical CSV quote');cell+=char;}
  if(cell.length>20000)throw new Error('Historical CSV cell bound exceeded');
 }
 if(quoted)throw new Error('Unterminated historical CSV quote');
 if(cell||row.length||closed)pushRow();
 return result;
}
/** Explicit import CSV format; repeated metadata must describe exactly one group. */
export function parseHistoricalImportCsv(text:string):unknown{
 const [header,...body]=rows(text);
 if(!header||!body.length||new Set(header).size!==header.length||META.concat(LINE.filter(k=>k!=='vatType')).some(key=>!header.includes(key))
  ||header.some(key=>!META.concat(DOCUMENT,LINE,['existingJournalId']).includes(key)))throw new Error('Invalid historical CSV header');
 const records=body.map(values=>{
  if(values.length!==header.length)throw new Error('Historical CSV column count differs');
  return Object.fromEntries(header.map((key,i)=>[key,values[i]!]));
 });
 const first=records[0]!,invoice=['customer_invoice','supplier_invoice'].includes(first.kind!);
 const groupKeys=META.concat(DOCUMENT,['existingJournalId']);
 if(records.some(row=>groupKeys.some(key=>row[key]!==first[key])))throw new Error('Historical CSV mixes source groups');
 let settlements:unknown=[];
 if(first.settlements){try{settlements=JSON.parse(first.settlements);}catch{throw new Error('Invalid historical CSV settlement evidence');}}
 return{version:1,...Object.fromEntries(META.map(key=>[key,first[key]])),records:records.map(row=>Object.fromEntries(LINE.filter(key=>key!=='vatType'||Boolean(row[key])).map(key=>[key,row[key]]))),
  ...(invoice?{document:{...Object.fromEntries(DOCUMENT.filter(key=>key!=='settlements').map(key=>[key,first[key]])),settlements}}:{}),
  ...(first.existingJournalId?{existingJournalId:first.existingJournalId}:{})};
}
