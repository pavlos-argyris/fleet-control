import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

export function nativeOrdexaEngine(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-payroll-native-')),root=process.cwd(),jar=path.join(root,'vendor/json-java/json-20240303.jar');
 fs.writeFileSync(path.join(dir,'PayrollRunner.java'),`import org.json.*;import java.io.*;import gr.argyrismitsos.fleetserver.OrdexaPayrollEngine;
public class PayrollRunner{public static void main(String[] args)throws Exception{ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] buf=new byte[8192];int n;while((n=System.in.read(buf))!=-1)out.write(buf,0,n);JSONObject input=new JSONObject(new String(out.toByteArray(),"UTF-8"));System.out.print(OrdexaPayrollEngine.build(input,Long.parseLong(args[0])).toString());}}`);
 execFileSync('java',['-jar',path.join(root,'.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar'),'-proc:none','-source','8','-target','8','-nowarn','-encoding','UTF-8','-cp',jar,'-d',dir,path.join(root,'server-android/src/gr/argyrismitsos/fleetserver/OrdexaPayrollEngine.java'),path.join(dir,'PayrollRunner.java')],{stdio:'pipe'});
 return {build:(input,now)=>JSON.parse(execFileSync('java',['-cp',dir+path.delimiter+jar,'PayrollRunner',String(typeof now==='number'?now:Date.parse(now))],{input:JSON.stringify(input),encoding:'utf8',maxBuffer:8*1024*1024,timeout:30000})),close:()=>fs.rmSync(dir,{recursive:true,force:true})};
}
