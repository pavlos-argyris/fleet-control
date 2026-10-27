import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-backup-retention-'));
try{
 const source=[
 'import java.util.*;import gr.argyrismitsos.fleetserver.BackupRetention;',
 'public class RetentionTest {',
 'static void check(boolean b){if(!b)throw new AssertionError();}',
 'static void pair(Set<String> names,String stamp){names.add("FleetControl_backup_"+stamp+".fcbackup");names.add("FleetControl_documents_"+stamp+".fcdocs");}',
 'public static void main(String[] args){',
 'String a="20261001_030000",b="20261002_030000",c="20261003_030000";',
 'List<BackupRetention.Record> known=new ArrayList<BackupRetention.Record>();for(String stamp:new String[]{a,b,c})known.add(new BackupRetention.Record(stamp,true,true));',
 'Set<String> names=new HashSet<String>(),pending=new HashSet<String>();for(String stamp:new String[]{a,b,c})pair(names,stamp);',
 'check(BackupRetention.obsolete(known,names,2,pending).equals(Arrays.asList(a)));',
 'for(int i=1;i<=20;i++)pair(names,String.format("202611%02d_030000",i));',
 'check(BackupRetention.obsolete(known,names,2,pending).equals(Arrays.asList(a)));',
 'names.remove("FleetControl_documents_"+c+".fcdocs");check(BackupRetention.obsolete(known,names,2,pending).isEmpty());',
 'pair(names,c);pending.add(c);check(BackupRetention.obsolete(known,names,2,pending).isEmpty());pending.clear();',
 'known.set(2,new BackupRetention.Record(c,true,false));check(BackupRetention.obsolete(known,names,2,pending).isEmpty());',
 'known.set(2,new BackupRetention.Record(c,false,true));names.remove("FleetControl_documents_"+c+".fcdocs");check(BackupRetention.obsolete(known,names,2,pending).equals(Arrays.asList(a)));',
 'check(BackupRetention.obsolete(known,names,30,pending).isEmpty());',
 'known.add(new BackupRetention.Record("../unsafe",false,true));check(BackupRetention.obsolete(known,names,2,pending).equals(Arrays.asList(a)));',
 'names.remove("FleetControl_backup_"+c+".fcbackup");check(BackupRetention.obsolete(known,names,2,pending).isEmpty());',
 'check(BackupRetention.obsolete(new ArrayList<BackupRetention.Record>(),names,1,pending).isEmpty());',
 'System.out.println("PASS actual backup retention: complete known exports only; unknown files, partial pairs, incomplete coverage, pending transfers and missing or unowned files never evict good backups.");',
 '}}'].join('\n');
 fs.writeFileSync(path.join(temp,'RetentionTest.java'),source);
 execFileSync('java',['-jar',path.resolve('.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar'),'-proc:none','-source','8','-target','8','-nowarn','-encoding','UTF-8','-d',temp,path.resolve('server-android/src/gr/argyrismitsos/fleetserver/BackupRetention.java'),path.join(temp,'RetentionTest.java')],{stdio:'inherit'});
 execFileSync('java',['-cp',temp,'RetentionTest'],{stdio:'inherit'});
}finally{fs.rmSync(temp,{recursive:true,force:true});}
