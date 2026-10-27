import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import worker from "../cloudflare-worker/src/worker.js";
import { zonedLocalToUtc,addCalendarDays,mondayPeriod } from "../cloudflare-worker/src/workforce-core.js";

const BASE_URL = "https://simulation.invalid";
const SERVER_KEY = "simulation-server-key";
const PIN_PEPPER = "simulation-pin-pepper";

function plainRow(row) {
  return row == null ? null : Object.fromEntries(Object.entries(row));
}

class D1Statement {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }

  bind(...args) {
    return new D1Statement(this.db, this.sql, args);
  }

  all(...args) {
    const rows = this.db.prepare(this.sql).all(...(this.args.length ? this.args : args));
    return Promise.resolve({ results: rows.map(plainRow) });
  }

  first(...args) {
    const row = this.db.prepare(this.sql).get(...(this.args.length ? this.args : args));
    return Promise.resolve(plainRow(row));
  }

  run(...args) {
    const result = this.db.prepare(this.sql).run(...(this.args.length ? this.args : args));
    return Promise.resolve({ meta: {
      changes: Number(result.changes || 0),
      last_row_id: Number(result.lastInsertRowid || 0)
    } });
  }
}

class D1Simulation {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec("PRAGMA foreign_keys = ON;");
  }

  exec(sql) {
    this.sqlite.exec(sql);
    return Promise.resolve({});
  }

  prepare(sql) {
    return new D1Statement(this.sqlite, sql);
  }

  async batch(statements) {
    this.sqlite.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

class R2Simulation {
  constructor() {
    this.objects = new Map();
  }

  async put(key, value, options = {}) {
    const bytes = value instanceof Uint8Array
      ? value
      : value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(await new Response(value).arrayBuffer());
    this.objects.set(key, { bytes, httpMetadata: options.httpMetadata || {} });
    return { size: bytes.byteLength, httpMetadata: options.httpMetadata || {} };
  }

  async head(key) {
    const item = this.objects.get(key);
    return item ? { size: item.bytes.byteLength, httpMetadata: item.httpMetadata } : null;
  }

  async get(key) {
    const item = this.objects.get(key);
    if (!item) return null;
    return {
      body: new Response(item.bytes).body,
      size: item.bytes.byteLength,
      httpMetadata: item.httpMetadata,
      arrayBuffer: async () => item.bytes.buffer.slice(item.bytes.byteOffset, item.bytes.byteOffset + item.bytes.byteLength),
      writeHttpMetadata(headers) {
        for (const [key, value] of Object.entries(item.httpMetadata || {})) {
          const header = key.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase());
          if (value) headers.set(header, value);
        }
      }
    };
  }
}

const db = new D1Simulation();
const releases = new R2Simulation();
const env = {
  DB: db,
  RELEASES: releases,
  ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
  SERVER_KEY,
  PIN_PEPPER,
  CLIENT_KEY: "simulation-client-key"
};

async function call(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  if (options.server) headers.set("X-Fleet-Server-Key", SERVER_KEY);
  let body = options.body;
  if (body !== undefined) {
    body = typeof body === "string" ? body : JSON.stringify(body);
    headers.set("Content-Type", "application/json");
  }
  const response = await worker.fetch(new Request(`${BASE_URL}${path}`, {
    method: options.method || "GET",
    headers,
    body
  }), env);
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  return { status: response.status, data, headers: response.headers };
}

async function callRaw(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  if (options.server) headers.set("X-Fleet-Server-Key", SERVER_KEY);
  const response = await worker.fetch(new Request(`${BASE_URL}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body
  }), env);
  const raw = await response.arrayBuffer();
  let data = {};
  try { data = raw.byteLength ? JSON.parse(new TextDecoder().decode(raw)) : {}; } catch { data = { bytes: raw.byteLength }; }
  return { status: response.status, data, headers: response.headers, bytes: raw };
}

function ok(result, expectedStatus = 200, label = "request") {
  assert.equal(result.status, expectedStatus, `${label}: ${JSON.stringify(result.data)}`);
  return result.data;
}

function fails(result, expectedStatus, expectedCode, label) {
  assert.equal(result.status, expectedStatus, `${label}: ${JSON.stringify(result.data)}`);
  if (expectedCode) assert.equal(result.data.code, expectedCode, `${label}: error code`);
}


const owner=ok(await call('/api/auth/bootstrap',{method:'POST',server:true,body:{fullName:'Issue Seven Owner',username:'issue7owner',password:'ExamplePassword!7'}}));
const token=owner.token;assert.ok(token);
const request=(path,method,body)=>call(path,{token,method,body});
const staff=ok(await request('/api/admin/employees','POST',{fullName:'Εργαζόμενος χωρίς σύνδεση',loginEnabled:false,usesOwnVehicle:true}),201).employee;
assert.equal(staff.loginEnabled,false);assert.equal(staff.username,'');
const before=db.sqlite.prepare('SELECT * FROM app_users WHERE id=?').get(staff.id);
assert.ok(before.password_hash.startsWith('!disabled:'));
fails(await call('/api/auth/user-login',{method:'POST',body:{username:before.username,password:'ExamplePassword!7'}}),401,'invalid_credentials','staff cannot log in');
fails(await request('/api/admin/employees/'+staff.id,'PUT',{loginEnabled:true,username:'staffenabled'}),400,null,'password required on activation');
assert.equal(db.sqlite.prepare('SELECT login_enabled FROM app_users WHERE id=?').get(staff.id).login_enabled,0);
ok(await request('/api/admin/employees/'+staff.id,'PUT',{loginEnabled:true,username:'staffenabled',password:'EnabledPassword!7'}));
const signed=ok(await call('/api/auth/user-login',{method:'POST',body:{username:'staffenabled',password:'EnabledPassword!7'}}));
assert.equal(signed.user.id,staff.id);assert.ok(signed.token);
ok(await request('/api/admin/employees/'+staff.id,'PUT',{loginEnabled:false}));
fails(await call('/api/auth/me',{token:signed.token}),401,null,'disabling login revokes sessions');
const date='2026-09-21';
ok(await request('/api/admin/schedule-week','POST',{assignments:[{employeeId:staff.id,date,templateId:'tpl-0800-1600',withoutVehicle:true}]}),201);
const scheduleId=db.sqlite.prepare("SELECT id FROM schedule_assignments WHERE employee_id=? AND status='planned'").get(staff.id).id;
let payroll=ok(await call('/api/admin/payroll?start='+date+'&end=2026-09-27',{token}));
assert.equal(payroll.hoursSource,'clock');assert.equal(payroll.totals.finalCents,0);
ok(await request('/api/admin/settings','PUT',{payroll_hours_source:'schedule',reason:'Use planned hours'}));
payroll=ok(await call('/api/admin/payroll?start='+date+'&end=2026-09-27',{token}));
assert.equal(payroll.hoursSource,'schedule');assert.equal(payroll.totals.payableHours,8);assert.equal(payroll.totals.finalCents,4800);
assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM shifts').get().n,0,'planned preview never creates actual clock records');
ok(await request('/api/admin/schedule-assignments/'+scheduleId+'/edit','POST',{date,templateId:'tpl-0900-1500',vehicleId:'__no_vehicle__'}));
payroll=ok(await call('/api/admin/payroll?start='+date+'&end=2026-09-27',{token}));
assert.equal(payroll.totals.payableHours,6);assert.equal(payroll.totals.finalCents,3600);
ok(await request('/api/admin/payroll/lock','POST',{startDate:date,endDate:'2026-09-27'}));
ok(await request('/api/admin/settings','PUT',{payroll_hours_source:'clock',reason:'Actual hours again'}));
payroll=ok(await call('/api/admin/payroll?start='+date+'&end=2026-09-27',{token}));
assert.equal(payroll.lockedSnapshot,true);assert.equal(payroll.hoursSource,'schedule');assert.equal(payroll.totals.finalCents,3600);
fails(await request('/api/admin/schedule-assignments/'+scheduleId+'/edit','POST',{date,templateId:'tpl-0800-1600'}),409,'payroll_locked','locked schedule edit');
fails(await request('/api/admin/schedule-assignments/'+scheduleId+'/delete','POST',{employeeId:staff.id,date}),409,'payroll_locked','locked schedule delete');
ok(await request('/api/admin/payroll/unlock','POST',{startDate:date,endDate:'2026-09-27',reason:'Test source change'}));
payroll=ok(await call('/api/admin/payroll?start='+date+'&end=2026-09-27',{token}));assert.equal(payroll.hoursSource,'clock');assert.equal(payroll.totals.finalCents,0);
assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM schedules WHERE status='planned'").get().n,1,'source toggle preserves schedules');
const sourceStart=zonedLocalToUtc(date,'09:00'),sourceEnd=zonedLocalToUtc(date,'14:00');
db.sqlite.prepare(`INSERT INTO shifts(id,employee_id,vehicle_id,current_vehicle_id,status,initial_km,actual_clock_in,actual_clock_out,payable_minutes,base_pay_cents,special_pay_cents,final_pay_cents,created_at,updated_at) VALUES (?,?,?,?,'completed',0,?,?,300,3000,0,3000,?,?)`).run('actual-staff',staff.id,'__own_vehicle__:'+staff.id,'__own_vehicle__:'+staff.id,sourceStart,sourceEnd,sourceStart,sourceEnd);
payroll=ok(await call('/api/admin/payroll?start='+date+'&end=2026-09-27',{token}));assert.equal(payroll.totals.payableHours,5);assert.equal(payroll.totals.finalCents,3000);
const actualBefore=JSON.stringify(db.sqlite.prepare("SELECT * FROM shifts WHERE id='actual-staff'").get());
ok(await request('/api/admin/settings','PUT',{payroll_hours_source:'schedule'}));
payroll=ok(await call('/api/admin/payroll?start='+date+'&end=2026-09-27',{token}));assert.equal(payroll.totals.finalCents,3600);assert.equal(JSON.stringify(db.sqlite.prepare("SELECT * FROM shifts WHERE id='actual-staff'").get()),actualBefore);
const deleted=ok(await request('/api/admin/employees/'+staff.id,'DELETE',{confirm:true,reason:'Archive staff'}));
assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM shifts WHERE employee_id=?').get(staff.id).n,1);
assert.equal(ok(await call('/api/admin/employees',{token})).employees.some(e=>e.id===staff.id),false);
assert.equal(ok(await call('/api/admin/payroll?start='+date+'&end=2026-09-27',{token})).totals.finalCents,3600,'archived employee still paid');
ok(await request('/api/admin/recycle-bin/'+deleted.recycleId+'/restore','POST',{reason:'Restore same employee'}));
assert.ok(ok(await call('/api/admin/employees',{token})).employees.some(e=>e.id===staff.id));
fails(await request('/api/admin/employees/'+owner.user.id,'DELETE',{confirm:true}),409,null,'self deletion protected');

// A full fortnight for 30 people, well above the former 80-row limit.
const people=[];for(let i=0;i<30;i++)people.push(ok(await request('/api/admin/employees','POST',{fullName:'Πρόγραμμα '+i,loginEnabled:false,usesOwnVehicle:true}),201).employee);
const futureWeek=addCalendarDays(mondayPeriod(Date.now()).startDate,7),futureNext=addCalendarDays(futureWeek,7),futureWeekEnd=addCalendarDays(futureWeek,6),futureEnd=addCalendarDays(futureWeek,13);
const rows=[];for(let n=0;n<14;n++){const day=new Date(Date.parse(futureWeek+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);for(const person of people)rows.push({date:day,employeeId:person.id,templateId:'tpl-0800-1600',withoutVehicle:true});}
const preview=ok(await request('/api/admin/schedule-import/preview','POST',{rows}));assert.equal(preview.valid,true,JSON.stringify(preview.errors));assert.equal(preview.weeks.length,2);assert.equal(preview.assignments.length,420);
const committed=ok(await request('/api/admin/schedule-import/commit','POST',{rows,confirm:true,previewToken:preview.previewToken}),201);assert.equal(committed.weeks.length,2);
assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM schedule_week_drafts WHERE week_start>=?").get(futureWeek).n,2);
assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM schedules WHERE start_at>=? AND status<>'cancelled'").get(futureWeek).n,0,'import changes draft only');
for(const weekStart of [futureWeek,futureNext])ok(await request('/api/admin/schedule-week/publish','POST',{weekStart}));
assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM schedules WHERE start_at>=? AND status<>'cancelled'").get(futureWeek).n,420,'no publication truncation');
const total=ok(await call('/api/admin/payroll?start='+futureWeek+'&end='+futureEnd,{token}));assert.equal(total.totals.finalCents,30*14*4800);assert.equal(total.employees.length,30);
const template=ok(await call('/api/admin/schedule-import/template-data?from='+futureWeek+'&to='+futureEnd,{token}));assert.equal(template.days,14);assert.equal(template.assignments.length,420);assert.ok(template.employees.some(e=>e.id===people[0].id));
const originalCount=db.sqlite.prepare('SELECT COUNT(*) AS n FROM schedule_week_drafts').get().n;
const invalid=ok(await request('/api/admin/schedule-import/preview','POST',{rows:[...rows,{date:futureWeek,employeeName:'Unknown employee',templateName:'08:00 - 16:00'}]}));assert.equal(invalid.valid,false);
fails(await request('/api/admin/schedule-import/commit','POST',{rows:[...rows,{date:futureWeek,employeeName:'Unknown employee',templateId:'tpl-0800-1600'}],confirm:true,replace:true}),422,'schedule_import_invalid','invalid multi-week import');
assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM schedule_week_drafts').get().n,originalCount);
const oldPlan=ok(await request('/api/admin/schedule-import/preview','POST',{rows:[rows[0]]}));
db.sqlite.prepare("UPDATE shift_templates SET name=name||' changed' WHERE id='tpl-0800-1600'").run();
fails(await request('/api/admin/schedule-import/commit','POST',{rows:[rows[0]],confirm:true,replace:true,previewToken:oldPlan.previewToken}),409,'schedule_import_stale','stale preview');
const dayOff=ok(await request('/api/admin/schedule-import/preview','POST',{rows:[{date:futureWeek,employeeId:people[0].id,templateName:''}]}));assert.equal(dayOff.valid,true);assert.equal(dayOff.assignments.length,209,'day off preserves other employees and six other days');
fails(await request('/api/admin/schedule-import/preview','POST',{rows:Array.from({length:2049},()=>rows[0])}),400,null,'oversized import rejected rather than truncated');
// Cross-week overlap is checked against incoming rows, not only the old DB.
const overnight=ok(await request('/api/admin/shift-templates','POST',{name:'Sunday overnight',segments:[{start:'23:00',end:'10:00'}]}),201).template.id;
const crossing=ok(await request('/api/admin/schedule-import/preview','POST',{rows:[{date:'2026-12-06',employeeId:people[0].id,templateId:overnight},{date:'2026-12-07',employeeId:people[0].id,templateId:'tpl-0800-1600'}]}));assert.equal(crossing.valid,false);assert.ok(crossing.errors.some(e=>e.code==='employee_conflict'));
fails(await request('/api/admin/employees/'+people[0].id,'DELETE',{confirm:true}),409,'employee_future_schedules','future cancellation needs explicit confirmation');
ok(await request('/api/admin/payroll/lock','POST',{startDate:futureWeek,endDate:futureWeekEnd}));
fails(await request('/api/admin/employees/'+people[0].id,'DELETE',{confirm:true,cancelFuture:true}),409,'payroll_locked','future locked payroll preserved');
ok(await request('/api/admin/payroll/unlock','POST',{startDate:futureWeek,endDate:futureWeekEnd,reason:'Test safe future cancellation'}));
const futureArchive=ok(await request('/api/admin/employees/'+people[0].id,'DELETE',{confirm:true,cancelFuture:true}));assert.equal(futureArchive.cancelledFutureSchedules,14);
assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM schedules WHERE employee_id=? AND status<>'cancelled'").get(people[0].id).n,0);
assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM schedules WHERE start_at>=? AND status<>'cancelled'").get(futureWeek).n,406,'other 29 employees retain every shift');
assert.throws(()=>db.sqlite.prepare("INSERT INTO shifts(id,employee_id,vehicle_id,current_vehicle_id,status,actual_clock_in,initial_km,created_at,updated_at) VALUES ('late-clock',?,?,?,'active','2026-11-02T06:00:00Z',0,'now','now')").run(people[0].id,'own-late','own-late'),/employee_inactive/,'stale clock-in cannot race archived employee');
ok(await request('/api/admin/recycle-bin/'+futureArchive.recycleId+'/restore','POST',{reason:'Restore identity only'}));
assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM schedules WHERE employee_id=? AND status<>'cancelled'").get(people[0].id).n,0,'restoration does not silently recreate future bookings');
const activeId=people[1].id;db.sqlite.prepare("INSERT INTO shifts(id,employee_id,vehicle_id,current_vehicle_id,status,actual_clock_in,initial_km,created_at,updated_at) VALUES ('working-guard',?,?,?,'active','2026-10-27T06:00:00Z',0,'now','now')").run(activeId,'own-guard','own-guard');
fails(await request('/api/admin/employees/'+activeId,'DELETE',{confirm:true,cancelFuture:true}),409,'employee_working','working employee protected');
assert.throws(()=>db.sqlite.prepare("UPDATE app_users SET deleted_at='now',active=0 WHERE id=?").run(activeId),/employee_working/,'database enforces the same guard after an API race');
assert.throws(()=>db.sqlite.prepare("UPDATE app_users SET active=0 WHERE id=?").run(owner.user.id),/owner_required/,'database protects last owner from concurrent mutations');
console.log('PASS Issue #7 actual Worker + SQLite: accountless staff, same-ID activation, revoked login, planned/actual source isolation, past edits, locked source, safe employee archive/restore, 420 assignments across two weeks, complete publication, partial-date preservation, stale/invalid/oversized and cross-week import checks. Synthetic data only.');
