/* Portable schedule workbook: native OOXML, no macros or remote library. */
(function (root) {
  "use strict";
  const encoder=new TextEncoder(),xml=value=>String(value??"").replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
  const ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  function column(n){let result='';for(n++;n;n=Math.floor((n-1)/26))result=String.fromCharCode(65+(n-1)%26)+result;return result;}
  function day(date,n){return new Date(Date.parse(date+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);}
  function monday(date){const n=new Date(date+'T12:00:00Z').getUTCDay()||7;return day(date,1-n);}
  function sheet(rows,widths,options={}) {
    const content=rows.map((row,i)=>'<row r="'+(i+1)+'" ht="'+(i?28:42)+'" customHeight="1">'+row.map((v,j)=>'<c r="'+column(j)+(i+1)+'" s="'+(i?j<2?2:3:1)+'" t="inlineStr"><is><t xml:space="preserve">'+xml(v)+'</t></is></c>').join('')+'</row>').join('');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="'+ns+'"><sheetViews><sheetView workbookViewId="0"><pane xSplit="1" ySplit="1" topLeftCell="C2" activePane="bottomRight" state="frozen"/></sheetView></sheetViews><cols>'+widths.map((w,i)=>'<col min="'+(i+1)+'" max="'+(i+1)+'" width="'+Math.abs(w)+'" customWidth="1"'+(w<0?' hidden="1"':'')+'/>').join('')+'</cols><sheetData>'+content+'</sheetData>'+(options.filter?'<autoFilter ref="A1:'+column(rows[0].length-1)+rows.length+'"/>':'')+(options.validation||'')+'<pageMargins left="0.25" right="0.25" top="0.35" bottom="0.35" header="0.15" footer="0.15"/><pageSetup paperSize="8" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>';
  }
  const crcTable=Array.from({length:256},(_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
  function crc(bytes){let c=0xffffffff;for(const b of bytes)c=crcTable[(c^b)&255]^(c>>>8);return(c^0xffffffff)>>>0;}
  function zip(files){
    const local=[],central=[];let offset=0;
    function record(size,fields){const a=new Uint8Array(size),v=new DataView(a.buffer);for(const [p,n,b] of fields)b===2?v.setUint16(p,n,true):v.setUint32(p,n,true);return a;}
    function join(chunks){const out=new Uint8Array(chunks.reduce((n,c)=>n+c.length,0));let i=0;for(const c of chunks){out.set(c,i);i+=c.length;}return out;}
    for(const [name,text] of Object.entries(files)){
      const n=encoder.encode(name),data=encoder.encode(text),sum=crc(data),header=record(30,[[0,0x04034b50],[4,20,2],[6,0x800,2],[14,sum],[18,data.length],[22,data.length],[26,n.length,2]]);
      local.push(header,n,data);
      central.push(record(46,[[0,0x02014b50],[4,20,2],[6,20,2],[8,0x800,2],[16,sum],[20,data.length],[24,data.length],[28,n.length,2],[42,offset]]),n);offset+=header.length+n.length+data.length;
    }
    const directory=join(central),count=Object.keys(files).length,end=record(22,[[0,0x06054b50],[8,count,2],[10,count,2],[12,directory.length],[16,offset]]);
    return join([...local,directory,end]);
  }
  function build(data) {
    if(!data?.employees?.length)throw new Error('Δεν υπάρχουν ενεργοί εργαζόμενοι για το πρότυπο.');
    const dates=[];for(let date=data.startDate;date<=data.endDate;date=day(date,1)){dates.push(date);if(dates.length>42)throw new Error('Έως 42 ημέρες ανά πρότυπο.');}
    if(!dates.length||dates.length*data.employees.length>2048)throw new Error('Το διάστημα ξεπερνά το όριο του προτύπου.');
    const sheets=[],files={},templateNames=new Map(data.templates.map(t=>[String(t.id),t.name])),vehicleNames=new Map(data.vehicles.map(v=>[String(v.id),v.name]));
    const existing=new Map((data.assignments||[]).map(a=>[a.employee_id+':'+a.work_date,a]));
    const groups=new Map();for(const date of dates){const week=monday(date);if(!groups.has(week))groups.set(week,[]);groups.get(week).push(date);}
    let index=0;
    for(const [week,days] of groups){
      const rows=[['Εργαζόμενος','Αναγνωριστικό εργαζομένου',...days.flatMap(d=>[d+' Βάρδια',d+' Μηχανάκι'])]];
      for(const e of data.employees)rows.push([e.fullName,String(e.id),...days.flatMap(d=>{const a=existing.get(e.id+':'+d);return [a?templateNames.get(String(a.template_id))||'':'',e.usesOwnVehicle?'Ιδιόκτητο μηχανάκι':a&&!a.vehicle_id?'Χωρίς μηχανάκι':vehicleNames.get(String(a?a.vehicle_id:e.assignedVehicleId||''))||''];})]);
      const validations=days.flatMap((_,i)=>[[column(2+i*2),'ShiftChoices'],[column(3+i*2),'VehicleChoices']]).map(([col,name])=>'<dataValidation type="list" allowBlank="1" showErrorMessage="1" showInputMessage="1" errorStyle="stop" errorTitle="Επιλογή από τη λίστα" error="Χρησιμοποίησε μία από τις διαθέσιμες επιλογές." promptTitle="'+(name==='ShiftChoices'?'Πρότυπο βάρδιας':'Μηχανάκι ημέρας')+'" prompt="'+(name==='ShiftChoices'?'Κενό σημαίνει ρεπό για αυτή την ημέρα.':'Η προανάθεση μπορεί να αλλάξει για αυτή την ημέρα.')+'" sqref="'+col+'2:'+col+rows.length+'"><formula1>'+name+'</formula1></dataValidation>').join('');
      sheets.push({name:'Πρόγραμμα '+week,xml:sheet(rows,[28,-38,...days.flatMap(()=>[25,22])],{filter:true,validation:'<dataValidations count="'+days.length*2+'">'+validations+'</dataValidations>'})});index++;
    }
    sheets.push({name:'Οδηγίες',xml:sheet([
      ['Fleet Control','Συμπλήρωση προγράμματος'],
      ['Διάστημα',data.startDate+' έως '+data.endDate],
      ['Δημιουργήθηκε',data.generatedAt||''],
      ['1. Βάρδια','Διάλεξε αποθηκευμένο πρότυπο στη στήλη κάθε ημέρας. Κενό σημαίνει ρεπό.'],
      ['2. Μηχανάκι','Η προανάθεση συμπληρώνεται αυτόματα. Μπορείς να την αλλάξεις από τη λίστα.'],
      ['Χωρίς μηχανάκι','Διάλεξε «Χωρίς μηχανάκι» μόνο όταν αυτό επιτρέπεται για τη συγκεκριμένη βάρδια.'],
      ['3. Εισαγωγή','Ανέβασε το αρχείο στην εφαρμογή και έλεγξε την προεπισκόπηση όλων των εβδομάδων.'],
      ['4. Πρόχειρο','Η αποθήκευση ενημερώνει τις ημέρες των εργαζομένων που περιέχει το αρχείο. Οι υπόλοιπες διατηρούνται.'],
      ['5. Δημοσίευση','Κάθε εβδομάδα παραμένει πρόχειρη μέχρι να πατήσεις Δημοσίευση στην εφαρμογή.'],
      ['Ταυτοποίηση','Μην αλλάζεις τη στήλη ονομάτων ή τη κρυφή στήλη αναγνωριστικών.'],
      ['Νέα στοιχεία','Αν άλλαξαν εργαζόμενοι, πρότυπα ή μηχανάκια, κατέβασε καινούριο πρότυπο.']
    ],[25,100])});
    const shifts=data.templates.map(t=>t.name),vehicles=[...data.vehicles.map(v=>v.name),'Χωρίς μηχανάκι','Ιδιόκτητο μηχανάκι'];
    sheets.push({name:'Επιλογές',hidden:true,xml:sheet([['Πρότυπα βαρδιών','Διαθέσιμα μηχανάκια'],...Array.from({length:Math.max(shifts.length,vehicles.length,1)},(_,i)=>[shifts[i]||'',vehicles[i]||''])],[40,28])});
    files['[Content_Types].xml']='<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'+sheets.map((_,i)=>'<Override PartName="/xl/worksheets/sheet'+(i+1)+'.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('')+'</Types>';
    files['_rels/.rels']='<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
    files['xl/workbook.xml']='<?xml version="1.0"?><workbook xmlns="'+ns+'" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'+sheets.map((s,i)=>'<sheet name="'+xml(s.name)+'" sheetId="'+(i+1)+'" r:id="rId'+(i+1)+'"'+(s.hidden?' state="hidden"':'')+'/>').join('')+'</sheets><definedNames><definedName name="ShiftChoices">\'Επιλογές\'!$A$2:$A$'+Math.max(2,shifts.length+1)+'</definedName><definedName name="VehicleChoices">\'Επιλογές\'!$B$2:$B$'+(vehicles.length+1)+'</definedName></definedNames><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>';
    files['xl/_rels/workbook.xml.rels']='<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+sheets.map((_,i)=>'<Relationship Id="rId'+(i+1)+'" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet'+(i+1)+'.xml"/>').join('')+'<Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>';
    files['xl/styles.xml']='<?xml version="1.0"?><styleSheet xmlns="'+ns+'"><fonts count="2"><font><sz val="11"/><name val="Calibri"/><color rgb="FF153B36"/></font><font><b/><sz val="11"/><name val="Calibri"/><color rgb="FFFFFFFF"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF126858"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEAF7F0"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="4"><xf fontId="0" fillId="0" borderId="0"/><xf fontId="1" fillId="2" borderId="0" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf><xf fontId="0" fillId="0" borderId="0" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf><xf fontId="0" fillId="3" borderId="0" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
    sheets.forEach((s,i)=>files['xl/worksheets/sheet'+(i+1)+'.xml']=s.xml);
    return zip(files);
  }
  function rowsFromMatrix(matrix) {
    if(!matrix.length)return [];
    const headers=matrix[0].map(v=>String(v??'').trim()),days=headers.map((h,i)=>({match:h.match(/^(\d{4}-\d{2}-\d{2}) Βάρδια$/),i})).filter(x=>x.match);
    const body=matrix.slice(1).filter(row=>row.some(v=>String(v??'').trim()));
    if(days.length)return body.flatMap(row=>days.map(({match,i})=>({date:match[1],employeeName:String(row[0]||''),employeeId:String(row[1]||''),templateName:String(row[i]||''),vehicle:String(row[i+1]||'')})));
    return body.map(row=>Object.fromEntries(headers.map((h,i)=>[h,row[i]??'']).filter(([h])=>h)));
  }
  root.FleetScheduleWorkbook={build,rowsFromMatrix};
})(globalThis);
