import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';import assert from 'node:assert/strict';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-backup-verify-')),root=process.cwd();
try {
  execFileSync('python3',['-c',String.raw`import zipfile,json,pathlib,sys
p=pathlib.Path(sys.argv[1]);pdf=b'%PDF-1.4\nfixture invoice\n%%EOF'
def make(name,rows):
 with zipfile.ZipFile(p/name,'w',compression=zipfile.ZIP_STORED) as z:
  for k,v in rows:z.writestr(k,v)
manifest=json.dumps([{'key':'one','zipName':'documents/0.pdf','size':len(pdf)}]).encode()
make('good.zip',[('fleet-control-documents.json',manifest),('documents/0.pdf',pdf)])
b=bytearray((p/'good.zip').read_bytes());i=b.find(pdf);b[i+8]^=1;(p/'corrupt.zip').write_bytes(b)
make('no-manifest.zip',[('documents/0.pdf',pdf)])
make('traversal.zip',[('fleet-control-documents.json',manifest),('documents/../outside.pdf',pdf)])
with zipfile.ZipFile(p/'large.zip','w',compression=zipfile.ZIP_DEFLATED) as z:z.writestr('fleet-control-documents.json',manifest);z.writestr('documents/0.pdf',b'x'*(16*1024*1024))
`,temp]);
  fs.writeFileSync(path.join(temp,'ArchiveTest.java'),`import java.nio.file.*;import java.util.*;import gr.argyrismitsos.fleetserver.BackupArchiveVerifier;public class ArchiveTest{
  static byte[] read(String dir,String file)throws Exception{return Files.readAllBytes(Paths.get(dir,file));}
  public static void main(String[] args)throws Exception{
    Map<String,BackupArchiveVerifier.Item> items=BackupArchiveVerifier.inspect(read(args[0],"good.zip"));
    if(items.size()!=2||items.get("fleet-control-documents.json").manifest.length==0)throw new AssertionError();
    BackupArchiveVerifier.Item pdf=items.get("documents/0.pdf");if(!BackupArchiveVerifier.matches(pdf,pdf.size,pdf.sha256)||BackupArchiveVerifier.matches(pdf,pdf.size,"wrong")||BackupArchiveVerifier.matches(pdf,pdf.size+1,""))throw new AssertionError();
    for(String bad:new String[]{"corrupt.zip","no-manifest.zip","traversal.zip","large.zip"}){boolean rejected=false;try{BackupArchiveVerifier.inspect(read(args[0],bad));}catch(Exception e){rejected=true;}if(!rejected)throw new AssertionError(bad);}
    System.out.println("OK actual Java backup archive verifier: all ZIP data/CRC read, size/SHA checks, corruption/missing-manifest/path traversal/expanded-size limits rejected; zero restore writes.");
  }} `);
  execFileSync('java',['-jar',path.join(root,'.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar'),'-proc:none','-source','8','-target','8','-nowarn','-encoding','UTF-8','-d',temp,path.join(root,'server-android/src/gr/argyrismitsos/fleetserver/BackupArchiveVerifier.java'),path.join(temp,'ArchiveTest.java')],{stdio:'inherit'});
  execFileSync('java',['-cp',temp,'ArchiveTest',temp],{stdio:'inherit'});
  const java=fs.readFileSync('server-android/src/gr/argyrismitsos/fleetserver/BackupManager.java','utf8'),verify=java.slice(java.indexOf('public static synchronized JSONObject verifyBackup('),java.indexOf('public static JSONObject verifyAndRemember('));
  assert.doesNotMatch(verify,/restoreArchive|restorePreparedBackup|importFleet|setFleet|writeLocalBytes|createDocument/);
  assert.match(verify,/BackupArchiveVerifier\.matches/);assert.match(verify,/archiveSha256/);assert.match(verify,/missingDocuments/);assert.match(verify,/workforceIncluded/);assert.match(verify,/documentInventory\(root\)/);assert.match(java,/BackupJobs\.createAndExport\(context, store\)/);const inventory=java.slice(java.indexOf('static JSONObject documentInventory('),java.indexOf('private static java.util.Set<String> attachmentKeys'));assert.match(inventory,/deleted_records/);assert.match(inventory,/isNull\("restored_at"\)/);assert.doesNotMatch(inventory,/mergeFleet|setFleet|importFleet/);
}finally{fs.rmSync(temp,{recursive:true,force:true});}
