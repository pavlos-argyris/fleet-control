import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import worker from "../cloudflare-worker/src/worker.js";
import { zonedLocalToUtc } from "../cloudflare-worker/src/workforce-core.js";

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

function datePart(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 10);
}

function localDatePart(ms = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Athens",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(ms));
}

function addDays(date, amount) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function monday(date) {
  const value = new Date(`${date}T12:00:00Z`);
  const day = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() - day + 1);
  return value.toISOString().slice(0, 10);
}

function iso(ms) {
  return new Date(ms).toISOString();
}

async function seedFleet() {
  ok(await call("/api/sync", {
    method: "POST",
    token: ownerToken,
    body: {
      version: 1,
      bikes: [
        { id: "bike-1", name: "ΜΗΧ-01", currentKm: 100, intervalKm: 3000, lastServiceKm: 0, history: [] },
        { id: "bike-2", name: "ΜΗΧ-02", currentKm: 200, intervalKm: 3000, lastServiceKm: 0, history: [] },
        { id: "bike-3", name: "ΜΗΧ-03", currentKm: 300, intervalKm: 3000, lastServiceKm: 0, history: [] }
      ]
    }
  }), 200, "seed fleet");
}

async function createEmployee(input) {
  const data = ok(await call("/api/admin/employees", {
    method: "POST",
    token: ownerToken,
    body: {
      role: "employee",
      active: true,
      showSchedule: true,
      showActualClockIn: true,
      showActualClockOut: true,
      showPayableHours: true,
      showPaymentAmount: true,
      showShiftKilometers: true,
      ...input
    }
  }), 201, `create ${input.username}`);
  return data.employee;
}

async function login(username, password) {
  const data = ok(await call("/api/auth/user-login", {
    method: "POST",
    body: { username, password, platform: "web", deviceId: `simulation-${username}`, deviceName: `Simulation ${username}` }
  }), 200, `login ${username}`);
  assert.ok(data.token, `token for ${username}`);
  return data.token;
}

let ownerToken;

ok(await call("/api/auth/bootstrap-status"), 200, "bootstrap status");
fails(await call("/api/workforce/dashboard"), 401, "login_required", "protected endpoint without login");
const boot = ok(await call("/api/auth/bootstrap", {
  method: "POST",
  server: true,
  body: { fullName: "Owner Admin", username: "owner", password: "Owner-Password-123", deviceId: "simulation-owner" }
}), 200, "bootstrap owner");
ownerToken = boot.token;
assert.equal(boot.user.role, "owner");
ok(await call("/api/auth/me", { token: ownerToken }), 200, "owner session");
await seedFleet();

const employeeA = await createEmployee({ fullName: "Διανομέας Α", username: "driver-a", password: "Driver-A-123", assignedVehicleId: "bike-1" });
const employeeB = await createEmployee({ fullName: "Διανομέας Β", username: "driver-b", password: "Driver-B-123", assignedVehicleId: "bike-1" });
const employeeOwn = await createEmployee({ fullName: "Ιδιόκτητος Γ", username: "driver-own", password: "Driver-C-123", usesOwnVehicle: true });
ok(await call("/api/admin/vehicles/bike-3/archive", {
  method: "POST",
  token: ownerToken,
  body: { confirmArchive: true, reason: "Έλεγχος archive/restore" }
}), 200, "archive unused vehicle");
const archivedVehicles = ok(await call("/api/admin/vehicles/archived", { token: ownerToken }), 200, "list archived vehicles");
assert.ok(archivedVehicles.vehicles.some((item) => item.id === "bike-3"));
const archivedAssignment = await call("/api/admin/employees", {
  method: "POST",
  token: ownerToken,
  body: { fullName: "Δεν πρέπει να δημιουργηθεί", username: "archived-driver", password: "Driver-D-123", assignedVehicleId: "bike-3" }
});
fails(archivedAssignment, 400, null, "assign archived vehicle");
ok(await call("/api/admin/vehicles/bike-3/restore", {
  method: "POST",
  token: ownerToken,
  body: { reason: "Επαναφορά μετά το test" }
}), 200, "restore archived vehicle");

const scheduleDate = addDays(monday(datePart(Date.now() + 14 * 86400000)), 1);
const scheduleA = ok(await call("/api/admin/schedules", {
  method: "POST",
  token: ownerToken,
  body: { employeeIds: [employeeA.id], startDate: scheduleDate, endDate: scheduleDate, startTime: "15:00", endTime: "17:00" }
}), 201, "schedule driver A");
assert.equal(scheduleA.created, 1);
const invalidEqualTimeSchedule = await call("/api/admin/schedules", {
  method: "POST",
  token: ownerToken,
  body: { employeeIds: [employeeOwn.id], startDate: scheduleDate, endDate: scheduleDate, startTime: "17:00", endTime: "17:00" }
});
fails(invalidEqualTimeSchedule, 400, null, "reject equal schedule start and end");
const conflict = await call("/api/admin/schedules", {
  method: "POST",
  token: ownerToken,
  body: { employeeIds: [employeeB.id], startDate: scheduleDate, endDate: scheduleDate, startTime: "15:00", endTime: "17:00" }
});
fails(conflict, 409, "vehicle_schedule_conflict", "overlapping permanent vehicle assignment");

ok(await call(`/api/admin/employees/${employeeB.id}`, {
  method: "PUT",
  token: ownerToken,
  body: { fullName: employeeB.fullName, username: employeeB.username, assignedVehicleId: null, usesOwnVehicle: false, reason: "Καθαρισμός μόνιμης ανάθεσης" }
}), 200, "clear permanent vehicle");
const employeesAfterClear = ok(await call("/api/admin/employees", { token: ownerToken }), 200, "read employees");
assert.equal(employeesAfterClear.employees.find((item) => item.id === employeeB.id).assignedVehicleId, null);

const template = ok(await call("/api/admin/shift-templates", {
  method: "POST",
  token: ownerToken,
  body: { name: "Απογευματινή δοκιμή", segments: [{ start: "15:00", end: "17:00" }], sortOrder: 1, color: "#315D67" }
}), 201, "create shift template");
const templateId = template.template.id;

const draftWeek = addDays(monday(datePart(Date.now() + 28 * 86400000)), 0);
ok(await call("/api/admin/schedule-week", {
  method: "POST",
  token: ownerToken,
  body: { draft: true, assignments: [{ employeeId: employeeA.id, date: draftWeek, templateId }] }
}), 201, "save first distributor draft");
ok(await call("/api/admin/schedule-week", {
  method: "POST",
  token: ownerToken,
  body: { draft: true, replaceEmployeeId: employeeOwn.id, assignments: [{ employeeId: employeeOwn.id, date: draftWeek, templateId, withoutVehicle: true }] }
}), 201, "append second distributor draft");
const draft = ok(await call(`/api/admin/schedule-week?week=${draftWeek}`, { token: ownerToken }), 200, "read combined draft");
assert.equal(draft.scheduleState, "draft");
assert.equal(draft.draft.assignments?.length ?? draft.schedules.filter((item) => String(item.id).startsWith("draft-")).length, 2);
const published = ok(await call("/api/admin/schedule-week/publish", {
  method: "POST",
  token: ownerToken,
  body: { weekStart: draftWeek, reason: "Δημοσίευση δοκιμής" }
}), 200, "publish combined week");
assert.equal(published.published, true);
const weekAfterPublish = ok(await call(`/api/admin/schedule-week?week=${draftWeek}`, { token: ownerToken }), 200, "read published week");
assert.equal(weekAfterPublish.scheduleState, "published");
assert.equal(weekAfterPublish.schedules.length, 2);
const coverage = ok(await call(`/api/admin/staffing-coverage?week=${draftWeek}`, { token: ownerToken }), 200, "future staffing coverage");
assert.equal(coverage.summary.undercoveredSlots, 0, "future planned slots must not be reported as gaps");
assert.ok(coverage.summary.upcomingSlots > 0);

const ownToken = await login("driver-own", "Driver-C-123");
const ownClockIn = ok(await call("/api/employee/clock-in", {
  method: "POST",
  token: ownToken,
  headers: { "X-Idempotency-Key": "own-clock-in-1" }
}), 201, "own vehicle clock in");
const ownReplay = ok(await call("/api/employee/clock-in", {
  method: "POST",
  token: ownToken,
  headers: { "X-Idempotency-Key": "own-clock-in-1" }
}), 200, "idempotent own vehicle clock in");
assert.equal(ownReplay.shift.id, ownClockIn.shift.id);
const ownClockOut = ok(await call("/api/employee/clock-out", { method: "POST", token: ownToken, body: {} }), 200, "own vehicle clock out without km");
assert.equal(ownClockOut.ownVehicle, true);
const ownShift = await db.prepare("SELECT status,final_km,shift_km,missing_km FROM shifts WHERE id=?").bind(ownClockIn.shift.id).first();
assert.equal(ownShift.status, "completed");
assert.equal(ownShift.final_km, null);
assert.equal(Number(ownShift.shift_km), 0);
assert.equal(Number(ownShift.missing_km), 0);

const payRule = ok(await call("/api/admin/pay-rules", {
  method: "POST",
  token: ownerToken,
  body: {
    id: "simulation-pay-rule",
    name: "Simulation 6/10/15",
    scopeType: "general",
    normalRateCents: 600,
    startRoundMode: "up",
    startRoundMinutes: 30,
    lateGraceMinutes: 0,
    lateClockOutGraceMinutes: 30,
    endRoundMode: "none",
    endRoundMinutes: 1,
    durationRoundMode: "nearest",
    payableIncrementMinutes: 1,
    minimumMinutes: 0,
    maximumMinutes: 720,
    specialRates: [
      { label: "00:00–01:00", startTime: "00:00", endTime: "01:00", rateCents: 1000, qualification: "automatic", priority: 20 },
      { label: "01:00–02:00", startTime: "01:00", endTime: "02:00", rateCents: 1500, qualification: "automatic", priority: 20 }
    ]
  }
}), 200, "save configurable payroll rule");
assert.equal(payRule.version, 1);
const payRules = ok(await call("/api/admin/pay-rules", { token: ownerToken }), 200, "read payroll rules");
const savedRule = payRules.rules.find((rule) => rule.id === "simulation-pay-rule");
assert.equal(savedRule.specialRates.length, 2);
assert.equal(savedRule.lateClockOutGraceMinutes, 30);
assert.ok(savedRule.specialRates.every((item) => item.id));
const savedRuleVersion = await db.prepare("SELECT snapshot FROM pay_rule_versions WHERE rule_id=? AND version=1").bind("simulation-pay-rule").first();
const savedRuleSnapshot = JSON.parse(savedRuleVersion.snapshot);
assert.ok(savedRuleSnapshot.specialRates.every((item) => item.id), "immutable payroll snapshot must retain generated special-rate identities");
const paySimulation = ok(await call("/api/admin/payroll/simulate", {
  method: "POST",
  token: ownerToken,
  body: {
    ruleId: "simulation-pay-rule",
    scheduledStart: "2026-09-15T12:00:00.000Z",
    actualClockIn: "2026-09-15T12:21:00.000Z",
    actualClockOut: "2026-09-15T22:00:00.000Z"
  }
}), 200, "simulate late clock in and special rates");
assert.equal(paySimulation.result.payableMinutes, 570);
assert.equal(paySimulation.result.totalPayCents, 6100);

const midnightWeek = addDays(monday(datePart(Date.now() + 21 * 86400000)), 7);
const midnightStart = zonedLocalToUtc(midnightWeek, "00:30", "Europe/Athens");
const midnightEnd = zonedLocalToUtc(midnightWeek, "01:30", "Europe/Athens");
await db.prepare(`INSERT INTO shifts
  (id,employee_id,vehicle_id,current_vehicle_id,status,actual_clock_in,actual_clock_out,effective_clock_out,
   payable_clock_in,payable_clock_out,payable_minutes,initial_km,rule_id,rule_version,rule_snapshot,
   base_pay_cents,special_pay_cents,final_pay_cents,overtime_status,missing_km,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
  "simulation-midnight-shift", employeeA.id, `__own_vehicle__:${employeeA.id}`, `__own_vehicle__:${employeeA.id}`,
  "completed", midnightStart, midnightEnd, midnightEnd, midnightStart, midnightEnd, 60, 0,
  "simulation-pay-rule", 1, "{}", 600, 0, 600, "none", 0, midnightStart, midnightEnd
).run();
const datePayRule = ok(await call("/api/admin/pay-rules", {
  method: "POST",
  token: ownerToken,
  body: {
    id: "simulation-local-date-rule",
    name: "Simulation local date rule",
    scopeType: "general",
    priority: 50,
    validFrom: midnightWeek,
    validUntil: midnightWeek,
    normalRateCents: 777,
    specialRates: []
  }
}), 200, "save local-date payroll rule");
const editedMidnight = ok(await call("/api/admin/shifts/simulation-midnight-shift/edit", {
  method: "POST",
  token: ownerToken,
  body: { actualClockIn: midnightStart, actualClockOut: midnightEnd, reason: "Έλεγχος τοπικής ημερομηνίας κανόνα" }
}), 200, "apply local-date payroll rule after midnight");
assert.equal(editedMidnight.updated, true);
const midnightAfterEdit = await db.prepare("SELECT rule_id,base_pay_cents FROM shifts WHERE id=?").bind("simulation-midnight-shift").first();
assert.equal(midnightAfterEdit.rule_id, datePayRule.id, "00:30 local shift must use the local-date pay rule");
assert.equal(Number(midnightAfterEdit.base_pay_cents), 777, "local-date pay rule rate must be applied");
const midnightPayroll = ok(await call(`/api/admin/payroll?start=${midnightWeek}&end=${midnightWeek}`, { token: ownerToken }), 200, "payroll local midnight boundary");
assert.ok(midnightPayroll.employees.some((item) => item.employeeId === employeeA.id), "a Monday 00:30 local shift must belong to Monday payroll");

const manualNow = Date.now();
const manualScheduleId = "simulation-manual-clock-in-schedule";
const manualShiftStart = iso(manualNow - 90 * 60000);
const manualShiftEnd = iso(manualNow + 90 * 60000);
await db.prepare(`INSERT INTO schedules
  (id,employee_id,vehicle_id,series_id,start_at,end_at,status,notes,created_by,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?, ?,?,?,?)`).bind(
  manualScheduleId, employeeB.id, "bike-2", "simulation-manual-series", manualShiftStart, manualShiftEnd,
  "planned", "simulation manual clock in", "simulation", manualShiftStart, manualShiftStart).run();
const manualClockIn = ok(await call("/api/admin/shifts/manual-clock-in", {
  method: "POST",
  token: ownerToken,
  body: {
    scheduleId: manualScheduleId,
    actualClockIn: iso(manualNow - 60 * 60000),
    vehicleId: "bike-2",
    initialKm: 200,
    reason: "Ο εργαζόμενος ξέχασε το Clock In"
  }
}), 201, "admin manual clock in");
assert.equal(manualClockIn.created, true);
assert.equal(manualClockIn.shift.vehicleId, "bike-2");
const manualShift = await db.prepare("SELECT status,notes FROM shifts WHERE id=?").bind(manualClockIn.shift.id).first();
assert.equal(manualShift.status, "active");
assert.match(manualShift.notes, /Χειροκίνητο Clock In/);
const employeeBToken = await login("driver-b", "Driver-B-123");
const manualClockOut = ok(await call("/api/employee/clock-out", {
  method: "POST", token: employeeBToken, body: { finalKm: 210 }
}), 200, "clock out manually created shift");
assert.equal(manualClockOut.pendingOvertime, false);

const overtimeEmployeeToken = await login("driver-a", "Driver-A-123");
const now = Date.now();
const overtimeDate = localDatePart(now - 2 * 3600000);
const overtimeScheduleId = "simulation-overtime-schedule";
const overtimeShiftId = "simulation-overtime-shift";
const overtimeStart = iso(now - 2 * 3600000);
const overtimeEnd = iso(now - 3600000);
const overtimeClockIn = iso(now - 2 * 3600000);
await db.batch([
  db.prepare(`INSERT INTO schedules
    (id,employee_id,vehicle_id,series_id,start_at,end_at,status,notes,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?, ?,?,?,?)`).bind(
    overtimeScheduleId, employeeA.id, "bike-1", "simulation-overtime-series", overtimeStart, overtimeEnd,
    "working", "simulation", "simulation", overtimeStart, overtimeStart),
  db.prepare(`UPDATE vehicle_registry SET status='in_use',active_shift_id=?,updated_at=? WHERE bike_id=?`).bind(overtimeShiftId, overtimeStart, "bike-1"),
  db.prepare(`INSERT INTO shifts
    (id,employee_id,schedule_id,vehicle_id,current_vehicle_id,status,actual_clock_in,initial_km,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(
    overtimeShiftId, employeeA.id, overtimeScheduleId, "bike-1", "bike-1", "active", overtimeClockIn, 100, overtimeStart, overtimeStart),
  db.prepare(`INSERT INTO vehicle_segments
    (id,shift_id,vehicle_id,started_at,initial_km,changed_by,reason)
    VALUES (?,?,?,?,?,?,?)`).bind("simulation-overtime-segment", overtimeShiftId, "bike-1", overtimeClockIn, 100, employeeA.id, "simulation")
]);
const overtimeClockOut = ok(await call("/api/employee/clock-out", {
  method: "POST",
  token: overtimeEmployeeToken,
  body: { finalKm: 110 }
}), 200, "clock out after scheduled end");
assert.equal(overtimeClockOut.pendingOvertime, true);
const overtimePending = await db.prepare("SELECT status,overtime_status,effective_clock_out,final_pay_cents FROM shifts WHERE id=?").bind(overtimeShiftId).first();
assert.equal(overtimePending.status, "pending_overtime");
assert.equal(overtimePending.overtime_status, "pending");
assert.equal(overtimePending.effective_clock_out, overtimeEnd);
const overtimeAlerts = await db.prepare("SELECT type FROM system_alerts WHERE object_type='shift' AND object_id=? AND resolved=0").bind(overtimeShiftId).all();
assert.deepEqual(new Set(overtimeAlerts.results.map((item) => item.type)), new Set(["overtime", "forgotten_clock_out"]));
const approval = ok(await call(`/api/admin/shifts/${overtimeShiftId}/approve-overtime`, {
  method: "POST",
  token: ownerToken,
  body: { reason: "Εγκρίθηκε από Owner για simulation", overtimeRateCents: 1200, overtimeMinutes: 30 }
}), 200, "approve overtime with custom rate");
assert.equal(approval.overtimeStatus, "approved");
const overtimeApproved = await db.prepare("SELECT status,overtime_status,overtime_rate_cents,overtime_minutes_override,overtime_approved_by,overtime_approved_by_name,overtime_approved_at,final_pay_cents FROM shifts WHERE id=?").bind(overtimeShiftId).first();
assert.equal(overtimeApproved.status, "completed");
assert.equal(overtimeApproved.overtime_status, "approved");
assert.equal(Number(overtimeApproved.overtime_rate_cents), 1200);
assert.equal(Number(overtimeApproved.overtime_minutes_override), 30);
assert.equal(overtimeApproved.overtime_approved_by_name, "Owner Admin");
assert.ok(overtimeApproved.overtime_approved_at);
const payroll = ok(await call(`/api/admin/payroll?start=${overtimeDate}&end=${overtimeDate}`, { token: ownerToken }), 200, "payroll after overtime approval");
const overtimePayroll = payroll.employees.find((item) => item.employeeId === employeeA.id);
assert.ok(overtimePayroll);
assert.ok(overtimePayroll.overtimeApprovals.some((item) => item.shiftId === overtimeShiftId && item.rateCents === 1200 && item.approvedBy === "Owner Admin"));

const health = ok(await call("/api/server/heartbeat", {
  method: "POST",
  server: true,
  body: {
    serverVersion: "2.0.3",
    health: {
      batteryPercent: 10,
      batteryCharging: false,
      batteryTemperatureC: 45,
      storageFreeBytes: 5,
      storageTotalBytes: 100,
      powerSaveMode: true,
      ignoringBatteryOptimizations: false,
      networkConnected: true,
      networkType: "Wi-Fi",
      androidVersion: "14",
      deviceModel: "Simulation",
      uptimeSeconds: 100
    },
    unexpectedRestart: true,
    restartAt: iso(now)
  }
}), 200, "server heartbeat health");
assert.equal(health.healthStored, true);
const serverHealth = ok(await call("/api/admin/server-health", { token: ownerToken }), 200, "server health dashboard");
assert.ok(serverHealth.warnings.some((item) => item.code === "temperature"));
assert.ok(serverHealth.warnings.some((item) => item.code === "storage"));
assert.ok(serverHealth.warnings.some((item) => item.code === "battery"));
assert.ok(serverHealth.warnings.some((item) => item.code === "optimization"));

const invoiceFleet = ok(await call("/api/sync", { token: ownerToken }), 200, "read fleet before QR invoice simulation");
const invoiceBike = invoiceFleet.bikes.find((bike) => bike.id === "bike-1");
const invoiceEntry = {
  id: "simulation-invoice-service",
  type: "service",
  km: 450,
  date: datePart(),
  tasks: ["Γενικός έλεγχος"],
  notes: "Γενικός έλεγχος",
  workshop: "Simulation Workshop",
  oilChanged: false,
  attachments: [],
  createdAt: iso(Date.now()),
  updatedAt: iso(Date.now())
};
invoiceBike.history = [invoiceEntry];
invoiceBike.updatedAt = iso(Date.now());
ok(await call("/api/sync", { method: "POST", token: ownerToken, body: invoiceFleet }), 200, "save invoice service for QR simulation");
const qrForSimulation = "https://einvoice.impact.gr/p/EL099902715/SIMULATION";
const queuedInvoice = ok(await call("/api/service-documents/import-qr", {
  method: "POST",
  token: ownerToken,
  body: { bikeId: "bike-1", entryId: invoiceEntry.id, value: qrForSimulation }
}), 202, "queue server-side QR PDF render");
assert.equal(queuedInvoice.queued, true);
const pendingInvoiceOperations = ok(await call("/api/server/pending?limit=50", { server: true }), 200, "read queued QR PDF render");
const invoiceOperation = pendingInvoiceOperations.operations.find((operation) => operation.id === queuedInvoice.jobId);
assert.equal(invoiceOperation.type, "service_document_render");
const renderedInvoice = ok(await callRaw(
  "/api/server/service-documents/rendered?jobId=" + encodeURIComponent(queuedInvoice.jobId)
    + "&bikeId=bike-1&entryId=" + encodeURIComponent(invoiceEntry.id)
    + "&qrValue=" + encodeURIComponent(qrForSimulation)
    + "&qrUrl=" + encodeURIComponent(qrForSimulation)
    + "&name=invoice-simulation.pdf",
  {
    method: "PUT",
    server: true,
    headers: { "Content-Type": "application/pdf" },
    body: new TextEncoder().encode("%PDF-1.4\n%%EOF")
  }
), 201, "upload server-rendered QR PDF");
assert.equal(renderedInvoice.attachment.contentType, "application/pdf");
assert.equal(renderedInvoice.attachment.renderJobId, queuedInvoice.jobId);
const completedInvoice = ok(await call("/api/service-documents/jobs/" + encodeURIComponent(queuedInvoice.jobId), { token: ownerToken }), 200, "read completed QR PDF job");
assert.equal(completedInvoice.status, "completed");
const downloadedInvoice = await callRaw("/api/service-documents/" + renderedInvoice.attachment.key.split("/").map(encodeURIComponent).join("/"), { token: ownerToken });
assert.equal(downloadedInvoice.status, 200, "download server-rendered QR PDF");
assert.equal(downloadedInvoice.bytes.byteLength, 14, "downloaded PDF must remain stored in R2");
const invoiceDocuments = ok(await call("/api/admin/service-documents", { token: ownerToken }), 200, "list invoice review queue");
const queuedDocument = invoiceDocuments.documents.find((item) => item.key === renderedInvoice.attachment.key);
assert.ok(queuedDocument);
assert.match(queuedDocument.name, new RegExp("_" + invoiceEntry.date + "\\.pdf$"));
const reviewedDocument = ok(await call("/api/admin/service-documents/review", {
  method: "POST",
  token: ownerToken,
  body: {
    bikeId: "bike-1",
    entryId: invoiceEntry.id,
    key: renderedInvoice.attachment.key,
    invoiceData: {
      supplier: "Reviewed Workshop",
      plate: invoiceBike.name,
      odometerKm: "500",
      invoiceDate: invoiceEntry.date,
      totalAmount: "34,00 €",
      workPerformed: "Λάδι Yamalube 20W50",
      lineItems: ["Λάδι Yamalube 20W50"]
    },
    tasks: ["Γενικός έλεγχος", "Αλλαγή λαδιών"]
  }
}), 200, "review extracted invoice data");
assert.equal(reviewedDocument.document.invoiceData.reviewStatus, "confirmed");
assert.equal(reviewedDocument.document.invoiceData.reviewedBy, "Owner Admin");
assert.ok(reviewedDocument.document.warnings.some((item) => item.type === "odometer"));
assert.ok(reviewedDocument.document.tasks.some((task) => task.includes("Yamalube")));
const retroactiveReprocess = ok(await call("/api/admin/service-documents/reprocess", {
  method: "POST",
  token: ownerToken,
  body: { key: renderedInvoice.attachment.key }
}), 200, "retroactively normalize stored invoice");
assert.equal(retroactiveReprocess.confirmedPreserved, true);
assert.ok(retroactiveReprocess.ocrWarning, "Η προσομοίωση χωρίς AI πρέπει να δηλώνει ότι κράτησε την υπάρχουσα OCR ανάγνωση.");
assert.ok(retroactiveReprocess.document.invoiceData.ocrReprocessedAt);
const batchStarted = ok(await call("/api/admin/service-documents/reprocess-batch", {
  method: "POST",
  token: ownerToken,
  body: { action: "start", batchId: "simulation-invoice-batch", total: 3 }
}), 201, "start shared invoice reprocess batch");
assert.equal(batchStarted.started, true);
const batchDuplicate = ok(await call("/api/admin/service-documents/reprocess-batch", {
  method: "POST",
  token: ownerToken,
  body: { action: "start", batchId: "simulation-invoice-batch-2", total: 3 }
}), 200, "prevent duplicate shared invoice reprocess batch");
assert.equal(batchDuplicate.started, false);
const batchUpdate = ok(await call("/api/admin/service-documents/reprocess-batch", {
  method: "POST",
  token: ownerToken,
  body: { action: "update", batchId: "simulation-invoice-batch", completed: 1, failed: 0, currentIndex: 1, currentName: "TNH-921_2026-08-17.pdf", progress: 33 }
}), 200, "update shared invoice reprocess batch");
assert.equal(batchUpdate.batch.completed, 1);
const batchStatus = ok(await call("/api/admin/service-documents/reprocess-batch", { token: ownerToken }), 200, "read shared invoice reprocess batch");
assert.equal(batchStatus.batch.progress, 33);
const batchComplete = ok(await call("/api/admin/service-documents/reprocess-batch", {
  method: "POST",
  token: ownerToken,
  body: { action: "complete", batchId: "simulation-invoice-batch", completed: 3, failed: 0 }
}), 200, "complete shared invoice reprocess batch");
assert.equal(batchComplete.batch.status, "completed");

// Review fixes operate on a separate synthetic vehicle, never production data.
{
  const before = ok(await call("/api/sync", { token: ownerToken }));
  const reviewBike = {
    id: "invoice-review-regression", name: "ΒΤΟ 756", intervalKm: 3000,
    lastServiceKm: 10000, currentKm: 12000, createdAt: iso(Date.now()), updatedAt: iso(Date.now()),
    history: [
      { id: "oil", type: "service", km: 10000, date: "2026-10-08", oilChanged: true, tasks: ["Αλλαγή λαδιών"] },
      { id: "check", type: "check", km: 12000, date: "2026-10-09" },
      { id: "review", type: "service", km: 9000, date: "2026-10-01", oilChanged: false, tasks: ["Γενικός έλεγχος"], attachments: [] }
    ]
  };
  before.bikes.push(reviewBike);
  ok(await call("/api/sync", { method: "POST", token: ownerToken, body: before }));
  const uploadForm = new FormData();
  uploadForm.append("bikeId", reviewBike.id); uploadForm.append("entryId", "review");
  uploadForm.append("file", new Blob(["%PDF-1.4\n%%EOF"], { type: "application/pdf" }), "review.pdf");
  const document = ok(await callRaw("/api/service-documents", { method: "POST", token: ownerToken, body: uploadForm }), 201).attachment;
  const payload = { bikeId: reviewBike.id, entryId: "review", key: document.key, keepOnCurrent: true,
    updateServiceKm: true, expectedServiceKm: 9000,
    invoiceData: { plate: "BTO-757", odometerKm: "9100", totalAmount: "50", invoiceDate: "2026-10-02",
      workPerformed: "Αλλαγή τακακιών\nΌροι Πληρωμής Συναλλαγής Τοίς Μετρητοίς", ocrFallbackUsed: "true" },
    tasks: ["Γενικός έλεγχος", "Όροι Πληρωμής Συναλλαγής Τοίς Μετρητοίς"] };
  const saved = ok(await call("/api/admin/service-documents/review", { method: "POST", token: ownerToken, body: payload }));
  assert.equal(saved.document.status, "confirmed");
  assert.deepEqual(saved.document.warnings, []);
  assert.equal(saved.document.invoiceData.plate, "BTO-757", "Keep the original reading for audit");
  assert.equal(saved.document.invoiceData.plateResolution, "kept-current");
  assert.ok(saved.document.invoiceData.correctedByUserAt);
  assert.equal(saved.document.invoiceData.serviceKmBeforeCorrection, "9000");
  assert.equal(saved.document.invoiceData.serviceKmAfterCorrection, "9100");
  assert.equal(saved.document.serviceKm, 9100);
  assert.equal(saved.bike.lastServiceKm, 10000);
  assert.equal(saved.bike.currentKm, 12000);
  assert.equal(saved.bike.nextServiceKm, 13000);
  assert.equal(saved.document.serviceDate, "2026-10-01");
  assert.equal(saved.document.invoiceData.invoiceDate, "2026-10-02");
  assert.ok(saved.document.tasks.includes("Αλλαγή τακακιών"));
  assert.ok(saved.document.tasks.every(task => !task.includes("Πληρωμής")));
  const staleVersion = ok(await call("/api/sync", { token: ownerToken })).version;
  ok(await call("/api/admin/service-documents/review", { method: "POST", token: ownerToken, body: payload }), 409,
    "Stale confirmation must not overwrite a newer mileage");
  assert.equal(ok(await call("/api/sync", { token: ownerToken })).version, staleVersion);
  const reread = ok(await call("/api/admin/service-documents/reprocess", { method: "POST", token: ownerToken, body: { key: document.key } }));
  assert.equal(reread.document.status, "confirmed");
  assert.equal(reread.document.invoiceData.plateResolution, "kept-current");
  assert.equal(reread.document.serviceKm, 9100);
  assert.equal(reread.document.invoiceData.totalAmount, "50");
  const listed = ok(await call("/api/admin/service-documents", { token: ownerToken })).documents.find(item => item.key === document.key);
  assert.equal(listed.status, "confirmed");
  assert.equal(listed.invoiceData.correctedByUserAt, saved.document.invoiceData.correctedByUserAt);
  // A subsequent different plate cannot reuse the previous acceptance.
  const changed = ok(await call("/api/admin/service-documents/review", { method: "POST", token: ownerToken,
    body: { bikeId: reviewBike.id, entryId: "review", key: document.key, invoiceData: { plate: "BTO-758" } } }));
  assert.equal(changed.document.status, "warning");
  assert.ok(changed.document.warnings.some(item => item.type === "plate"));

  const kept=ok(await call('/api/admin/service-documents/review',{method:'POST',token:ownerToken,body:{bikeId:reviewBike.id,entryId:'review',key:document.key,keepOnCurrent:true,expectedServiceKm:9100,expectedEntryUpdatedAt:changed.document.serviceUpdatedAt,mileageDecision:'keep',invoiceData:{plate:'BTO-758',odometerKm:'9200',totalAmount:'59',netAmount:'50',vatAmount:'9'}}}));
  assert.equal(kept.document.status,'confirmed');assert.deepEqual(kept.document.warnings,[]);assert.equal(kept.document.serviceKm,9100);assert.equal(kept.document.invoiceData.odometerKm,'9200');
  const revision=kept.document.reviewJournal.at(-1);assert.ok(revision.id);
  const undone=ok(await call('/api/admin/service-documents/undo-review',{method:'POST',token:ownerToken,body:{bikeId:reviewBike.id,entryId:'review',revisionId:revision.id}}));
  assert.equal(undone.document.invoiceData.totalAmount,'50');assert.equal(undone.document.invoiceData.odometerKm,'9100');
  assert.equal(undone.bike.history.find(e=>e.id==='check').km,12000,'Undo preserves unrelated mileage records');
  ok(await call('/api/admin/service-documents/undo-review',{method:'POST',token:ownerToken,body:{bikeId:reviewBike.id,entryId:'review',revisionId:revision.id}}),409,'Already undone cannot replay');
  const next=ok(await call('/api/admin/service-documents/review',{method:'POST',token:ownerToken,body:{bikeId:reviewBike.id,entryId:'review',key:document.key,keepOnCurrent:true,expectedServiceKm:9100,mileageDecision:'keep',invoiceData:{odometerKm:'9300'}}}));
  const later=ok(await call('/api/sync',{token:ownerToken}));const rb=later.bikes.find(b=>b.id===reviewBike.id);rb.history.find(e=>e.id==='review').notes='A newer edit';rb.history.find(e=>e.id==='review').updatedAt=iso(Date.now()+10000);rb.updatedAt=iso(Date.now()+10000);ok(await call('/api/sync',{method:'POST',token:ownerToken,body:later}));
  ok(await call('/api/admin/service-documents/undo-review',{method:'POST',token:ownerToken,body:{bikeId:reviewBike.id,entryId:'review',revisionId:next.document.reviewJournal.at(-1).id}}),409,'Later edit prevents unsafe undo');
  const retryForm=new FormData();retryForm.set('bikeId',reviewBike.id);retryForm.set('entryId','review');retryForm.set('uploadId','stable-upload-test-123456');retryForm.set('file',new Blob(['%PDF-1.4 test upload'],{type:'application/pdf'}),'retry.pdf');
  const firstUpload=ok(await callRaw('/api/service-documents',{method:'POST',token:ownerToken,body:retryForm}),201);
  const secondUpload=ok(await callRaw('/api/service-documents',{method:'POST',token:ownerToken,body:retryForm}),200);
  assert.equal(firstUpload.attachment.key,secondUpload.attachment.key);assert.equal(secondUpload.duplicate,true);
  console.log('OK new review decisions: keep mismatch completes, dual readings persist, safe undo and stale protection, original upload ID prevents duplicate lost-response retries');
  console.log("OK invoice review API: explicit keep, completed status, durable user badge, confirmed manual mileage correction, stale protection and reprocessing preservation");
}

const uploaded = ok(await call("/api/admin/releases/client", {
  method: "PUT",
  server: true,
  headers: { "X-Release-Version": "simulation-5.22", "X-Release-Notes": "simulation" },
  body: "not-an-apk"
}), 200, "server uploads client release");
assert.equal(uploaded.uploaded, true);
const update = ok(await call("/api/client-update"), 200, "public client update metadata");
assert.equal(update.available, true);
assert.equal(update.version, "simulation-5.22");
const downloaded = await call("/download/client.apk");
assert.equal(downloaded.status, 200, "public client download");

const status = ok(await call("/api/status"), 200, "public status");
assert.equal(status.databaseOk, true);
assert.equal(status.storageOk, true);
assert.equal(status.users >= 4, true);
const malformedAsset = await call("/bad%2");
assert.notEqual(malformedAsset.status, 500, "malformed asset encoding must not crash the Worker");

console.log("OK admin simulations: auth, fleet, permanent assignment, schedule conflicts, draft/publish, coverage, own-vehicle clock, payroll, overtime approval, server health and client update");

// Recovery check added for the handoff, using the simulation's in-memory DB.
const recoveryPin = "246810";
ok(await call("/api/admin/pin", { method: "POST", server: true, body: { pin: recoveryPin } }), 200, "set simulated restore PIN");
const noteAt='2026-10-19T00:00:00.000Z',noteLater='2026-10-19T01:00:00.000Z';
const reminderBike={id:'next-notes-backup',name:'BTO 555',intervalKm:3000,lastServiceKm:10000,currentKm:12000,createdAt:noteAt,updatedAt:noteAt,history:[],nextServiceNotes:[
 {id:'next-belt',text:'Έλεγχος ιμάντα',status:'pending',createdAt:noteAt,updatedAt:noteAt,sourceEntryId:'',completedEntryId:''},
 {id:'next-tyre',text:'Πίσω ελαστικό',status:'pending',createdAt:noteAt,updatedAt:noteAt,sourceEntryId:'',completedEntryId:''}]};
ok(await call('/api/sync/bike',{method:'POST',body:{bike:reminderBike}}),401);
let reminderSaved=ok(await call('/api/sync/bike',{method:'POST',token:ownerToken,body:{bike:reminderBike}})).bike;
reminderSaved.nextServiceNotes[0]={...reminderSaved.nextServiceNotes[0],status:'completed',updatedAt:noteLater,completedEntryId:'real-service'};reminderSaved.updatedAt=noteLater;
reminderSaved=ok(await call('/api/sync/bike',{method:'POST',token:ownerToken,body:{bike:reminderSaved}})).bike;
const staleNotes={...reminderBike,updatedAt:iso(Date.now()+2000)};
reminderSaved=ok(await call('/api/sync/bike',{method:'POST',token:ownerToken,body:{bike:staleNotes}})).bike;
assert.equal(reminderSaved.nextServiceNotes.find(n=>n.id==='next-belt').status,'completed');
const oldNotesClient={...reminderSaved,updatedAt:iso(Date.now()+3000)};delete oldNotesClient.nextServiceNotes;
reminderSaved=ok(await call('/api/sync/bike',{method:'POST',token:ownerToken,body:{bike:oldNotesClient}})).bike;assert.equal(reminderSaved.nextServiceNotes.length,2);assert.equal(reminderSaved.currentKm,12000);assert.equal(reminderSaved.history.length,0);
const savedExport = ok(await call("/api/server/system-export", { server: true }), 200, "export simulated system");
assert.equal(savedExport.fleet.bikes.find(b=>b.id===reminderBike.id).nextServiceNotes.find(n=>n.id==='next-belt').completedEntryId,'real-service');
const savedEmployee = savedExport.workforce.app_users.find(row => row.id === employeeA.id);
assert.ok(savedEmployee);
await db.prepare("UPDATE app_users SET full_name=? WHERE id=?").bind("Changed after backup", employeeA.id).run();
const createdAfterBackup = await createEmployee({ fullName: "After backup", username: "after-backup", password: "Simulation-after-123", usesOwnVehicle: true });
const serverBackupShape = { ...savedExport, schemaVersion: 3 };

ok(await call('/api/server/system-import/preview',{method:'POST',body:serverBackupShape}),401,'Preview requires server credentials');
const stateBeforePreview=(await db.prepare('SELECT full_name FROM app_users WHERE id=?').bind(employeeA.id).first()).full_name;
const preview=ok(await call('/api/server/system-import/preview',{method:'POST',server:true,headers:{'X-Admin-Pin':recoveryPin},body:serverBackupShape}));
assert.equal(preview.tables.length,28);assert.ok(preview.preserved>=1);assert.ok(preview.replaced>=1);assert.equal((await db.prepare('SELECT full_name FROM app_users WHERE id=?').bind(employeeA.id).first()).full_name,stateBeforePreview,'Preview must not change rows');
await db.prepare('UPDATE app_users SET full_name=? WHERE id=?').bind('Changed during preview',employeeA.id).run();
ok(await call('/api/server/system-import',{method:'PUT',server:true,headers:{'X-Admin-Pin':recoveryPin},body:{...serverBackupShape,restoreGuard:preview.restoreGuard}}),409,'Stale preview rejected before changes');
assert.equal((await db.prepare('SELECT full_name FROM app_users WHERE id=?').bind(employeeA.id).first()).full_name,'Changed during preview');
const currentFleet=ok(await call('/api/sync',{token:ownerToken}));currentFleet.bikes.push({id:'post-backup-bike',name:'BTO 999',intervalKm:3000,lastServiceKm:0,currentKm:0,createdAt:iso(Date.now()),updatedAt:iso(Date.now()),history:[]});ok(await call('/api/sync',{method:'POST',token:ownerToken,body:currentFleet}));
const refreshed=ok(await call('/api/server/system-import/preview',{method:'POST',server:true,headers:{'X-Admin-Pin':recoveryPin},body:serverBackupShape}));serverBackupShape.restoreGuard=refreshed.restoreGuard;
const imported = ok(await call("/api/server/system-import", { method: "PUT", server: true, headers: { "X-Admin-Pin": recoveryPin }, body: serverBackupShape }), 200, "restore simulated system backup");
const restoredNotes=ok(await call('/api/snapshot',{token:ownerToken})).bikes.find(b=>b.id===reminderBike.id).nextServiceNotes;assert.equal(restoredNotes.length,2);assert.equal(restoredNotes.find(n=>n.id==='next-belt').status,'completed');assert.equal(restoredNotes.find(n=>n.id==='next-tyre').status,'pending');
const restoredName = await db.prepare("SELECT full_name FROM app_users WHERE id=?").bind(employeeA.id).first();
const laterRecord = await db.prepare("SELECT id FROM app_users WHERE id=?").bind(createdAfterBackup.id).first();
assert.equal(restoredName.full_name, savedEmployee.full_name);
assert.ok(laterRecord, "Current restore keeps post-backup workforce records: it is an upsert, not a point-in-time reset.");
console.log(JSON.stringify({ recoveryCheck: "passed", data: "synthetic in-memory only", exportedTables: Object.keys(savedExport.workforce).length, restoredRecords: imported.records, savedRecordRestored: true, postBackupRecordPreserved: true, exactPointInTimeRestore: false }));

assert.ok(ok(await call('/api/sync',{token:ownerToken})).bikes.some(b=>b.id==='post-backup-bike'),'Restore must preserve newly added bikes');
console.log('OK read-only restore preview: 28 table counts, guard against later changes, refresh then import, preserved post-backup fleet and workforce records.');

// Actual authenticated follow-up endpoints and old-client synchronization.
{
  const bike={id:'followup-bike',name:'BTO-756',currentKm:10000,lastServiceKm:0,intervalKm:3000,createdAt:iso(Date.now()),updatedAt:iso(Date.now()),history:[
    {id:'prior',type:'service',date:'2026-09-01',km:10000,createdAt:iso(Date.now()),updatedAt:iso(Date.now()),tasks:['Γενικός έλεγχος'],attachments:[]},
    {id:'lower',type:'service',date:'2026-10-01',km:9000,createdAt:iso(Date.now()),updatedAt:iso(Date.now()),tasks:['Γενικός έλεγχος'],attachments:[]}
  ]};
  const seeded=ok(await call('/api/sync/bike',{method:'POST',token:ownerToken,body:{bike}}));
  let current=seeded.bike||ok(await call('/api/snapshot',{token:ownerToken})).bikes.find(b=>b.id===bike.id);
  const target=()=>current.history.find(e=>e.id==='lower');
  const base=()=>({bikeId:bike.id,entryId:'lower',expectedEntryUpdatedAt:target().updatedAt});
  ok(await call('/api/admin/service-followup',{method:'POST',body:{...base(),action:'invoice-expectation',status:'not_expected',reason:'Δωρεάν εργασία'}}),401,'Management login required');
  ok(await call('/api/admin/service-followup',{method:'POST',token:ownerToken,body:{...base(),action:'invoice-expectation',status:'not_expected',reason:''}}),400,'No unexplained exemption');
  const queryLog=[],previousPrepare=db.prepare.bind(db);db.prepare=sql=>{queryLog.push(sql);return previousPrepare(sql);};
  const stale=base();current=ok(await call('/api/admin/service-followup',{method:'POST',token:ownerToken,body:{...base(),action:'invoice-expectation',status:'not_expected',reason:'Δωρεάν εργασία',actor:'spoofed'}})).bike;
  db.prepare=previousPrepare;assert.ok(queryLog.some(sql=>sql.includes('b.value AS bike_json')));assert.ok(!queryLog.some(sql=>/SELECT\s+data\s*,?\s*version/i.test(sql)),'Follow-up reads only one bike, never unrelated histories');
  assert.equal(target().invoiceExpectation.status,'not_expected');assert.notEqual(target().invoiceExpectation.actor,'spoofed');assert.equal(target().km,9000);
  ok(await call('/api/admin/service-followup',{method:'POST',token:ownerToken,body:{...stale,action:'invoice-expectation',status:'expected'}}),409,'Stale decision cannot overwrite');
  const mismatch=globalThis.FleetServiceModel.chronology(current)[0];
  ok(await call('/api/admin/service-followup',{method:'POST',token:ownerToken,body:{...base(),action:'acknowledge-km',signature:mismatch.signature+'changed',reason:'Αλλαγή κοντέρ'}}),409,'Signature must match both entries');
  current=ok(await call('/api/admin/service-followup',{method:'POST',token:ownerToken,body:{...base(),action:'acknowledge-km',signature:mismatch.signature,reason:'Αλλαγή κοντέρ'}})).bike;
  assert.equal(globalThis.FleetServiceModel.chronology(current)[0].acknowledgment.reason,'Αλλαγή κοντέρ');assert.equal(target().km,9000);
  const oldClient=JSON.parse(JSON.stringify(current));oldClient.updatedAt=iso(Date.now()+1000);for(const e of oldClient.history){delete e.invoiceExpectation;delete e.kmAcknowledgments;delete e.reviewJournal;}
  const merged=ok(await call('/api/sync/bike',{method:'POST',token:ownerToken,body:{bike:oldClient}})).bike;
  const kept=merged.history.find(e=>e.id==='lower');assert.equal(kept.invoiceExpectation.status,'not_expected');assert.equal(kept.kmAcknowledgments.length,1,'Older clients cannot strip new metadata');
  current=merged;current=ok(await call('/api/admin/service-followup',{method:'POST',token:ownerToken,body:{...base(),action:'invoice-expectation',status:'expected'}})).bike;assert.equal(target().invoiceExpectation.status,'expected','Exemption is reversible');
  assert.ok(db.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'service_followup_%'").get().n>=3);
  console.log('OK actual service follow-up API: management auth, mandatory reasons, actor from session, stale/fingerprint guards, unchanged odometers, reversible exemptions, central audit and compatibility with older clients.');
}

// Six operations improvements, using real Worker + SQLite + R2 simulation only.
{
 const id='operations-bike',stamp=iso(Date.now());const bike={id,name:'BTO 456',intervalKm:3000,lastServiceKm:10000,currentKm:12000,createdAt:stamp,updatedAt:stamp,history:[{id:'oil',type:'service',date:'2026-10-01',km:10000,oilChanged:true,tasks:['Αλλαγή λαδιών'],cost:'59',createdAt:stamp,updatedAt:stamp},{id:'reading',type:'check',date:'2026-10-02',km:12000,createdAt:stamp,updatedAt:stamp}]};
 let current=ok(await call('/api/sync/bike',{method:'POST',token:ownerToken,body:{bike}})).bike;
 ok(await call('/api/admin/service-appointments'),401);ok(await call('/api/admin/fleet-diagnostics',{server:true}),401,'Server key cannot impersonate a fleet manager');
 const planned={action:'create',id:'stable-appointment-id',bikeId:id,date:'2026-11-01',tasks:['Αλλαγή λαδιών'],notes:'Τρίτη πρωί'};
 const created=ok(await call('/api/admin/service-appointments',{method:'POST',token:ownerToken,body:planned}));assert.equal(created.bike.currentKm,12000);assert.equal(created.bike.history.length,2);assert.equal(created.appointment.status,'planned');
 const replay=ok(await call('/api/admin/service-appointments',{method:'POST',token:ownerToken,body:planned}));assert.equal(replay.bike.serviceAppointments.length,1);assert.equal(replay.unchanged,true);
 const edit={bikeId:id,entryId:'oil',action:'edit',changes:{km:9500,date:'2026-10-01',tasks:['Αλλαγή λαδιών'],oilChanged:true,majorService:false,cost:'59',workshop:''}};
 const beforePreview=ok(await call('/api/snapshot',{token:ownerToken})).version;
 const preview=ok(await call('/api/admin/service-impact',{method:'POST',token:ownerToken,body:edit}));assert.equal(preview.impact.after.nextServiceKm,12500);assert.equal(preview.impact.after.currentKm,12000);assert.equal(ok(await call('/api/snapshot',{token:ownerToken})).version,beforePreview,'Preview must never write');
 const changedPlan=ok(await call('/api/admin/service-appointments',{method:'POST',token:ownerToken,body:{action:'edit',id:created.appointment.id,bikeId:id,expectedUpdatedAt:created.appointment.updatedAt,date:'2026-11-02',tasks:['Φίλτρο']}}));
 ok(await call('/api/admin/fleet/'+id+'/history/oil/edit',{method:'POST',token:ownerToken,body:{...edit.changes,impactToken:preview.impactToken,expectedEntryUpdatedAt:preview.expectedEntryUpdatedAt}}),409,'Changed bike invalidates accepted impact');
 current=changedPlan.bike;const p=changedPlan.appointment;
 const completion={action:'complete',id:p.id,bikeId:id,expectedUpdatedAt:p.updatedAt,expectedBikeUpdatedAt:current.updatedAt,date:'2026-10-03',km:12500,tasks:['Αλλαγή λαδιών'],oilChanged:true,majorService:false,confirm:true};
 const completed=ok(await call('/api/admin/service-appointments',{method:'POST',token:ownerToken,body:completion}));assert.equal(completed.bike.lastServiceKm,12500);assert.equal(completed.bike.nextServiceKm,15500);assert.equal(completed.bike.history.length,3);assert.equal(completed.appointment.completedEntryId,completed.entryId);
 const duplicate=ok(await call('/api/admin/service-appointments',{method:'POST',token:ownerToken,body:completion}));assert.equal(duplicate.entryId,completed.entryId);assert.equal(duplicate.bike.history.length,3);
 const syncedOld=JSON.parse(JSON.stringify(completed.bike));delete syncedOld.serviceAppointments;syncedOld.updatedAt=iso(Date.now()+1000);const kept=ok(await call('/api/sync/bike',{method:'POST',token:ownerToken,body:{bike:syncedOld}})).bike;assert.equal(kept.serviceAppointments[0].status,'completed');
 const dpreview=ok(await call('/api/admin/service-impact',{method:'POST',token:ownerToken,body:{bikeId:id,entryId:completed.entryId,action:'delete',changes:{}}}));
 const deleted=ok(await call('/api/admin/fleet/'+id+'/history/'+completed.entryId+'/delete',{method:'POST',token:ownerToken,body:{confirmDelete:true,impactToken:dpreview.impactToken,expectedEntryUpdatedAt:dpreview.expectedEntryUpdatedAt}}));assert.ok(deleted.recycleId);assert.ok(deleted.bike.historyDeletes.some(e=>e.id===completed.entryId));
 const trash=ok(await call('/api/admin/service-trash?bikeId='+id,{token:ownerToken}));assert.ok(trash.records.some(r=>r.id===deleted.recycleId));
 const restore=ok(await call('/api/admin/service-trash?id='+deleted.recycleId,{token:ownerToken}));assert.equal(restore.impact.after.lastServiceKm,12500);
 const restored=ok(await call('/api/admin/service-trash',{method:'POST',token:ownerToken,body:{id:deleted.recycleId,expectedDeletedAt:restore.deletedAt,expectedBikeUpdatedAt:restore.expectedBikeUpdatedAt,reason:'Διαγραφή κατά λάθος'}}));assert.ok(restored.bikes[0].history.some(e=>e.id===completed.entryId));
 const staleDeleted=JSON.parse(JSON.stringify(deleted.bike));staleDeleted.updatedAt=iso(Date.now()+2000);delete staleDeleted.historyRestores;delete staleDeleted.historyDeletes;const survived=ok(await call('/api/sync/bike',{method:'POST',token:ownerToken,body:{bike:staleDeleted}})).bike;assert.ok(survived.history.some(e=>e.id===completed.entryId),'Old-client tombstone must never erase restored service');
 const diag=ok(await call('/api/admin/fleet-diagnostics',{token:ownerToken}));assert.equal(diag.databaseOk,true);assert.equal(diag.workerVersion,'5.12.3');assert.ok(!JSON.stringify(diag).includes(SERVER_KEY));assert.ok(!JSON.stringify(diag).includes('BTO 456'));
 const backup=ok(await call('/api/server/system-export',{server:true}));const savedBike=backup.fleet.bikes.find(b=>b.id===id);assert.equal(savedBike.serviceAppointments[0].status,'completed');assert.ok(savedBike.historyRestores.some(r=>r.id===completed.entryId));
 console.log('OK actual operations API: manager auth, read-only/stale impact, idempotent appointment creation/completion, unchanged metrics until completion, direct trash preview/restore, stale deletion fences, safe diagnostics and backup metadata.');
}
// A PDF belonging to service trash can be recovered from a verified Server backup without restoring the live service first.
{
 const s=ok(await call('/api/snapshot',{token:ownerToken})),b=s.bikes.find(b=>b.id==='operations-bike'),entryId='trash-with-pdf',key='service-documents/operations-bike/'+entryId+'/archive.pdf';
 b.updatedAt=iso(Date.now()+3000);b.history.unshift({id:entryId,type:'service',date:'2026-10-04',km:12600,tasks:['Φίλτρο'],createdAt:b.updatedAt,updatedAt:b.updatedAt,attachments:[{id:'archive.pdf',key,name:'archive.pdf',contentType:'application/pdf',size:20}]});
 ok(await call('/api/sync/bike',{method:'POST',token:ownerToken,body:{bike:b}}));const deleted=ok(await call('/api/admin/fleet/'+b.id+'/history/'+entryId+'/delete',{method:'POST',token:ownerToken,body:{confirmDelete:true}}));
 const preview=ok(await call('/api/admin/service-trash?id='+deleted.recycleId,{token:ownerToken}));assert.equal(preview.files[0].available,false);
 ok(await callRaw('/api/server/service-documents/restore?bikeId='+b.id+'&entryId='+entryId+'&key='+encodeURIComponent(key)+'&name=archive.pdf',{method:'PUT',server:true,body:new Uint8Array(Buffer.from('%PDF-1.4\narchived fixture'))}));
 const available=ok(await call('/api/admin/service-trash?id='+deleted.recycleId,{token:ownerToken}));assert.equal(available.files[0].available,true);assert.ok(!ok(await call('/api/snapshot',{token:ownerToken})).bikes.find(x=>x.id===b.id).history.some(e=>e.id===entryId),'Uploading archived PDF must not restore the live service');
 console.log('OK trash PDF backup recovery: only a key present in archived service is accepted; restored bytes become available without resurrecting the service.');
}
// Real SQLite transaction rollback: an archive insert cannot survive a failed live-history update, nor can history be lost.
{
 const id='operations-bike',current=ok(await call('/api/snapshot',{token:ownerToken})).bikes.find(b=>b.id===id),target=current.history.find(e=>e.id==='oil');
 const archiveBefore=db.sqlite.prepare("SELECT COUNT(*) AS n FROM deleted_records WHERE record_id=?").get(id+':'+target.id).n;
 const originalPrepare=db.prepare.bind(db);let injected=false;
 db.prepare=sql=>{const statement=originalPrepare(sql);if(sql.startsWith('UPDATE fleet_snapshot SET data=json_set(data,?,json(?)),version=version+1')){const oldBind=statement.bind.bind(statement);statement.bind=(...args)=>{const bound=oldBind(...args);bound.run=async()=>{injected=true;throw new Error('Synthetic archive transaction failure');};return bound;};}return statement;};
 const originalConsoleError=console.error;console.error=(...args)=>{if(args[0]?.message!=='Synthetic archive transaction failure')originalConsoleError(...args);};
 try{ok(await call('/api/admin/fleet/'+id+'/history/'+target.id+'/delete',{method:'POST',token:ownerToken,body:{confirmDelete:true}}),500);}finally{console.error=originalConsoleError;}
 db.prepare=originalPrepare;assert.equal(injected,true);assert.ok(ok(await call('/api/snapshot',{token:ownerToken})).bikes.find(b=>b.id===id).history.some(e=>e.id===target.id));assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM deleted_records WHERE record_id=?").get(id+':'+target.id).n,archiveBefore);
 console.log('OK actual archive transaction failure: SQLite rolls back archive insertion and preserves the service unchanged.');
}
// 5.47 offload protocol: real Worker handlers and SQLite, no production requests.
{
 const stamp=iso(Date.now()),key='service-documents/offload-bike/saved/local.pdf';let aiCalls=0;
 env.AI={toMarkdown:async()=>({format:'markdown',data:'Invoice BTO 756 total 59.00'}),run:async()=>{aiCalls++;return {response:JSON.stringify({plate:'BTO 756',invoiceNumber:'A-547',invoiceDate:'2026-10-01',totalAmount:'59',odometerKm:'9000',workPerformed:'Φίλτρο'})};}};
 await releases.put(key,new TextEncoder().encode('%PDF-1.4\nsynthetic'),{httpMetadata:{contentType:'application/pdf'}});
 const bike={id:'offload-bike',name:'BTO 756',intervalKm:3000,lastServiceKm:9000,currentKm:9000,createdAt:stamp,updatedAt:stamp,history:[{id:'saved',type:'service',date:'2026-10-01',km:9000,updatedAt:stamp,attachments:[{id:'local',key,name:'local.pdf',contentType:'application/pdf'}]}]};
 ok(await call('/api/sync/bike',{method:'POST',token:ownerToken,body:{bike}}));
 const version=ok(await call('/api/snapshot',{token:ownerToken})).version;
 const exchange=(body={})=>call('/api/server/exchange',{method:'POST',server:true,body:{serverVersion:'2.2.3',sinceVersion:version,knownJobs:[],acknowledgements:[],...body}});
 ok(await call('/api/server/exchange',{method:'POST',body:{}}),401);
 let x=ok(await exchange({includeStatus:true}));assert.equal(x.protocol,1);assert.equal(x.snapshot.unchanged,true);assert.equal(x.status.databaseOk,true);
 const start=ok(await call('/api/service-documents/ocr',{method:'POST',token:ownerToken,body:{key}}),202);assert.equal(start.queued,true);assert.equal(aiCalls,0);
 const repeat=ok(await call('/api/service-documents/ocr',{method:'POST',token:ownerToken,body:{key}}),202);assert.equal(repeat.jobId,start.jobId,'Duplicate submission reuses pending job');
 assert.ok(!ok(await call('/api/server/pending?queue=invoices',{server:true})).operations.some(j=>j.id===start.jobId),'Old Server never receives unsupported documentKey work');
 x=ok(await exchange({knownJobs:[start.jobId],progress:{jobId:start.jobId,progress:40,stage:'Local read'}}));assert.ok(x.invoices.some(j=>j.id===start.jobId));assert.equal(x.knownJobs.find(j=>j.id===start.jobId).status,'pending');assert.equal(x.snapshot.unchanged,true,'Buffered progress never rewrites fleet snapshot');
 const cards=ok(await call('/api/admin/service-documents',{token:ownerToken})).documents.filter(d=>d.key===key);assert.equal(cards.length,1);assert.equal(cards[0].jobId,start.jobId);assert.equal(cards[0].status,'processing');
 assert.equal(ok(await call('/api/service-documents/jobs/'+start.jobId,{token:ownerToken})).status,'processing','Existing PDF does not mark a fresh analysis job completed');
 const resultBody={jobId:start.jobId,localOcr:{localReadStatus:'confident',ocrConfidence:92,plate:'BTO 756',invoiceDate:'2026-10-01',invoiceNumber:'A-547',totalAmount:'59',odometerKm:'9000',workPerformed:'Φίλτρο'}};
 ok(await call('/api/server/service-documents/analysis-result',{method:'POST',server:true,body:resultBody}));assert.equal(aiCalls,0);
 const after=ok(await call('/api/snapshot',{token:ownerToken}));assert.equal(after.bikes.find(b=>b.id===bike.id).history[0].attachments[0].ocr.totalAmount,'59');
 assert.equal(ok(await call('/api/server/service-documents/analysis-result',{method:'POST',server:true,body:resultBody})).reused,true);assert.equal(ok(await call('/api/snapshot',{token:ownerToken})).version,after.version,'Repeated result is idempotent');
 assert.equal(ok(await call('/api/service-documents/jobs/'+start.jobId,{token:ownerToken})).status,'completed');
 x=ok(await exchange({acknowledgements:[start.jobId],knownJobs:[start.jobId]}));assert.equal(x.knownJobs[0].status,'applied');assert.deepEqual(x.acknowledged,[start.jobId]);
 const retry=ok(await call('/api/admin/service-documents/reprocess',{method:'POST',token:ownerToken,body:{key}}),202);
 const restarted=ok(await call('/api/admin/service-documents/restart',{method:'POST',token:ownerToken,body:{jobId:retry.jobId}}),202);assert.notEqual(restarted.jobId,retry.jobId);
 ok(await call('/api/server/service-documents/analysis-result',{method:'POST',server:true,body:{...resultBody,jobId:retry.jobId}}),410);
 ok(await call('/api/server/service-documents/analysis-result',{method:'POST',server:true,body:{jobId:restarted.jobId,localOcr:{localReadStatus:'ambiguous',ocrConfidence:20}}}));assert.equal(aiCalls,1,'AI only on uncertain local result');
 ok(await call('/api/admin/service-documents/reprocess',{method:'POST',token:ownerToken,body:{key,forceAi:true}}));assert.equal(aiCalls,2,'Explicit forced AI still works');
 const latest=ok(await call('/api/snapshot',{token:ownerToken})).version,report={schema:1,snapshotVersion:latest,bikes:[],issues:[],costCents:5900};
 assert.equal(ok(await exchange({preparedReport:report})).reportAccepted,true);ok(await call('/api/admin/server-report'),401);assert.equal(ok(await call('/api/admin/server-report',{token:ownerToken})).report.costCents,5900);
 assert.equal(ok(await exchange({preparedReport:{...report,snapshotVersion:latest-1}})).reportAccepted,false,'Stale report cannot replace current report');
 await db.prepare('UPDATE fleet_snapshot SET version=version+1 WHERE id=1').run();const stale=ok(await call('/api/admin/server-report',{token:ownerToken}));assert.equal(stale.ready,false);assert.equal(stale.report,null);
 console.log('OK actual offload API: combined exchange, old Server compatibility, queue deduplication, lightweight progress, single invoice card, local result idempotence, cancellation, conditional AI and version-bound read-only reports.');
}
{
 const head=ok(await call('/api/server/system-export/page',{server:true})).mirror;
 ok(await call('/api/server/system-export/delta?epoch='+head.epoch+'&cursor='+head.cursor),401);
 for(let i=0;i<45;i++)await db.prepare("INSERT INTO system_settings(key,value,updated_at) VALUES(?,?,'now') ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind('offload-delta-'+i,'one').run();
 await db.prepare("UPDATE system_settings SET value='two' WHERE key='offload-delta-1'").run();await db.prepare("DELETE FROM system_settings WHERE key='offload-delta-2'").run();
 let cursor=head.cursor,until,changes=[],pages=0;
 do{const d=ok(await call('/api/server/system-export/delta?epoch='+head.epoch+'&cursor='+cursor+(until==null?'':'&until='+until),{server:true}));assert.ok(d.changes.length<=20);if(until!=null)assert.equal(d.until,until);until=d.until;cursor=d.nextCursor;changes.push(...d.changes);pages++;if(!d.hasMore)break;}while(pages<10);
 assert.equal(pages,3);assert.equal(changes.length,45);assert.equal(changes.filter(c=>c.row?.key==='offload-delta-1').length,1);assert.equal(changes.find(c=>c.row?.key==='offload-delta-1').row.value,'two');assert.ok(changes.some(c=>c.table==='system_settings'&&c.row===null));
 assert.equal(ok(await call('/api/server/system-export/delta?epoch='+head.epoch+'&cursor='+cursor,{server:true})).changes.length,0);
 assert.equal(ok(await call('/api/server/system-export/delta?epoch=wrong&cursor='+cursor,{server:true})).resetRequired,true);
 await db.prepare('UPDATE fleet_mirror_state SET floor=? WHERE id=1').bind(cursor).run();assert.equal(ok(await call('/api/server/system-export/delta?epoch='+head.epoch+'&cursor='+head.cursor,{server:true})).resetRequired,true);
 console.log('OK actual SQLite differential export: coalesced updates/deletes, bounded 20-row pages, fixed watermark, unchanged mirror, authentication and expired cursor reset.');
}
