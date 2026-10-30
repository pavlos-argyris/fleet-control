import fs from 'node:fs';
import {ROLE_PERMISSIONS, ALL_PERMISSIONS, EMPLOYEE_ALLOWED_PERMISSIONS} from '../cloudflare-worker/src/workforce-core.js';
const file='server-android/assets/direct-permissions.json';
const value=JSON.stringify({roles:ROLE_PERMISSIONS,all:ALL_PERMISSIONS,employee:EMPLOYEE_ALLOWED_PERMISSIONS},null,2)+'\n';
if(process.argv.includes('--check')) {
  if(fs.readFileSync(file,'utf8')!==value)throw Error('Server direct permissions differ from the central role rules.');
} else fs.writeFileSync(file,value);
