import {
  ALL_PERMISSIONS,
  EMPLOYEE_ALLOWED_PERMISSIONS,
  ROLE_PERMISSIONS,
  addCalendarDays,
  computePayBreakdown,
  coverageBucketStatus,
  effectivePermissions,
  hasPermission,
  localDate,
  mondayPeriod,
  normalizeRole,
  parseJson,
  sanitizePermissionOverrides,
  safetyFallbackAt,
  scheduleInterval,
  weekdayForDate
} from "./workforce-core.js";

// Cloudflare Workers WebCrypto currently caps PBKDF2 at 100,000 iterations.
const PASSWORD_ITERATIONS = 100000;
const LOGIN_WINDOW_SECONDS = 15 * 60;
const LOGIN_MAX_ATTEMPTS = 8;
const DEFAULT_TIME_ZONE = "Europe/Athens";
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const AUTH_COOKIE = "fc_auth";
const AUTH_TOUCH_SECONDS = 60;
const PERSISTENT_SESSION_SECONDS = 30 * 24 * 60 * 60;
const MANAGEMENT_ROLES = new Set(["owner", "manager", "fleet_manager", "payroll_manager"]);
const OWN_VEHICLE_PREFIX = "__own_vehicle__:";
const OWN_VEHICLE_LABEL = "Ιδιόκτητο μηχανάκι";
const MILEAGE_CHECK_STALE_DAYS = 7;
const PAY_CLOCK_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DEFAULT_PAY_SPECIAL_RATES = Object.freeze([
  { id: "default-general-0000-0100", label: "00:00–01:00", startTime: "00:00", endTime: "01:00", rateCents: 1000, qualification: "automatic", priority: 20 },
  { id: "default-general-0100-0200", label: "01:00–02:00", startTime: "01:00", endTime: "02:00", rateCents: 1500, qualification: "automatic", priority: 20 }
]);

export function ownVehicleShiftId(employeeId) {
  return `${OWN_VEHICLE_PREFIX}${String(employeeId || "")}`;
}

export function isOwnVehicleShiftId(value) {
  return String(value || "").startsWith(OWN_VEHICLE_PREFIX);
}
// Matches the longest selectable Android Server sync interval (five minutes)
// plus enough grace for mobile-network and Android scheduler delays.
const SERVER_HEARTBEAT_GRACE_MS = 7 * 60 * 1000;

export const WORKFORCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS app_users (
  id TEXT PRIMARY KEY NOT NULL,
  full_name TEXT NOT NULL,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  email TEXT COLLATE NOCASE UNIQUE,
  phone TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL DEFAULT 100000,
  role TEXT NOT NULL DEFAULT 'employee',
  permissions TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  employee_group TEXT NOT NULL DEFAULT '',
  pay_rule_id TEXT,
  assigned_vehicle_id TEXT,
  uses_own_vehicle INTEGER NOT NULL DEFAULT 0,
  hire_date TEXT,
  notes TEXT NOT NULL DEFAULT '',
  show_schedule INTEGER NOT NULL DEFAULT 0,
  show_actual_clock_in INTEGER NOT NULL DEFAULT 0,
  show_actual_clock_out INTEGER NOT NULL DEFAULT 0,
  show_payable_hours INTEGER NOT NULL DEFAULT 0,
  show_payment_amount INTEGER NOT NULL DEFAULT 0,
  show_shift_kilometers INTEGER NOT NULL DEFAULT 0,
  can_change_vehicle INTEGER NOT NULL DEFAULT 0,
  force_logout_after INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS app_users_role_active ON app_users(role, active);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  device_name TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT 'web',
  persistent INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_ip TEXT NOT NULL DEFAULT '',
  revoked_at INTEGER,
  FOREIGN KEY(user_id) REFERENCES app_users(id)
);
CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions(user_id, expires_at);

CREATE TABLE IF NOT EXISTS registered_devices (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT 'web',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY(user_id) REFERENCES app_users(id)
);
CREATE INDEX IF NOT EXISTS registered_devices_user ON registered_devices(user_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS auth_login_attempts (
  fingerprint TEXT PRIMARY KEY NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  window_started INTEGER NOT NULL,
  blocked_until INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS vehicle_registry (
  bike_id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  odometer INTEGER NOT NULL DEFAULT 0 CHECK(odometer >= 0),
  status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','in_use','reserved','service','inactive')),
  active_shift_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS vehicle_registry_status ON vehicle_registry(status, name COLLATE NOCASE);

/*
 * Vehicles are never physically deleted.  The archive keeps the last Fleet
 * snapshot and the audit metadata, while vehicle_registry remains available
 * to preserve historical shift/service references.
 */
CREATE TABLE IF NOT EXISTS vehicle_archives (
  bike_id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  odometer INTEGER NOT NULL DEFAULT 0,
  original_status TEXT NOT NULL DEFAULT 'available',
  snapshot_json TEXT NOT NULL DEFAULT '{}',
  archived_at TEXT NOT NULL,
  archived_by TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  restored_at TEXT,
  restored_by TEXT,
  restore_reason TEXT
);
CREATE INDEX IF NOT EXISTS vehicle_archives_active ON vehicle_archives(active, archived_at DESC);

CREATE TABLE IF NOT EXISTS shift_templates (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  segments TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  color TEXT NOT NULL DEFAULT '#0D8F82',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS shift_templates_active_order ON shift_templates(active, sort_order, name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS schedule_assignments (
  id TEXT PRIMARY KEY NOT NULL,
  employee_id TEXT NOT NULL,
  template_id TEXT,
  work_date TEXT NOT NULL,
  vehicle_id TEXT,
  status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','cancelled')),
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(employee_id) REFERENCES app_users(id),
  FOREIGN KEY(template_id) REFERENCES shift_templates(id)
);
CREATE INDEX IF NOT EXISTS schedule_assignments_week ON schedule_assignments(work_date, employee_id, status);

/*
 * A schedule is edited in a private draft first.  Keeping drafts in their own
 * tables means a bad import or an unfinished machine assignment can never
 * replace the last published week.  These tables are deliberately additive so
 * old D1 databases can be upgraded with CREATE TABLE IF NOT EXISTS.
 */
CREATE TABLE IF NOT EXISTS schedule_week_drafts (
  week_start TEXT PRIMARY KEY NOT NULL,
  assignments TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','published')),
  base_revision INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS schedule_publications (
  week_start TEXT PRIMARY KEY NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  published_by TEXT NOT NULL,
  published_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS schedule_acknowledgements (
  week_start TEXT NOT NULL,
  revision INTEGER NOT NULL,
  employee_id TEXT NOT NULL,
  acknowledged_at TEXT NOT NULL,
  PRIMARY KEY(week_start, revision, employee_id),
  FOREIGN KEY(employee_id) REFERENCES app_users(id)
);
CREATE TABLE IF NOT EXISTS schedule_vehicle_waivers (
  week_start TEXT NOT NULL,
  assignment_key TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(week_start, assignment_key)
);
CREATE INDEX IF NOT EXISTS schedule_ack_week ON schedule_acknowledgements(week_start, revision);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY NOT NULL,
  employee_id TEXT NOT NULL,
  vehicle_id TEXT,
  series_id TEXT,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','awaiting','working','completed','absent','pending_correction','cancelled')),
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(employee_id) REFERENCES app_users(id)
);
CREATE INDEX IF NOT EXISTS schedules_employee_start ON schedules(employee_id, start_at);
CREATE INDEX IF NOT EXISTS schedules_start_status ON schedules(start_at, status);
CREATE INDEX IF NOT EXISTS schedules_vehicle_start ON schedules(vehicle_id, start_at, status);

CREATE TABLE IF NOT EXISTS shifts (
  id TEXT PRIMARY KEY NOT NULL,
  employee_id TEXT NOT NULL,
  schedule_id TEXT,
  vehicle_id TEXT NOT NULL,
  current_vehicle_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','pending_overtime','pending_km','cancelled','pending_correction')),
  actual_clock_in TEXT NOT NULL,
  actual_clock_out TEXT,
  effective_clock_out TEXT,
  automatic_closed_at TEXT,
  payable_clock_in TEXT,
  payable_clock_out TEXT,
  payable_minutes REAL NOT NULL DEFAULT 0,
  initial_km INTEGER NOT NULL CHECK(initial_km >= 0),
  final_km INTEGER,
  shift_km INTEGER,
  rule_id TEXT,
  rule_version INTEGER,
  rule_snapshot TEXT NOT NULL DEFAULT '{}',
  base_pay_cents INTEGER NOT NULL DEFAULT 0,
  special_pay_cents INTEGER NOT NULL DEFAULT 0,
  final_pay_cents INTEGER NOT NULL DEFAULT 0,
  out_of_schedule INTEGER NOT NULL DEFAULT 0,
  overtime_status TEXT NOT NULL DEFAULT 'none' CHECK(overtime_status IN ('none','pending','approved','rejected')),
  overtime_rate_cents INTEGER,
  overtime_minutes_override INTEGER,
  overtime_approved_by TEXT,
  overtime_approved_by_name TEXT NOT NULL DEFAULT '',
  overtime_approved_at TEXT,
  missing_km INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(employee_id) REFERENCES app_users(id),
  FOREIGN KEY(schedule_id) REFERENCES schedules(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS shifts_one_active_employee ON shifts(employee_id) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS shifts_one_active_vehicle ON shifts(current_vehicle_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS shifts_employee_start ON shifts(employee_id, actual_clock_in DESC);
CREATE INDEX IF NOT EXISTS shifts_status_start ON shifts(status, actual_clock_in);

CREATE TABLE IF NOT EXISTS vehicle_segments (
  id TEXT PRIMARY KEY NOT NULL,
  shift_id TEXT NOT NULL,
  vehicle_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  initial_km INTEGER NOT NULL,
  final_km INTEGER,
  changed_by TEXT,
  reason TEXT NOT NULL DEFAULT '',
  FOREIGN KEY(shift_id) REFERENCES shifts(id)
);
CREATE INDEX IF NOT EXISTS vehicle_segments_shift ON vehicle_segments(shift_id, started_at);

CREATE TABLE IF NOT EXISTS correction_requests (
  id TEXT PRIMARY KEY NOT NULL,
  shift_id TEXT,
  employee_id TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  resolution TEXT NOT NULL DEFAULT '',
  resolved_by TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS correction_requests_status ON correction_requests(status, created_at DESC);

CREATE TABLE IF NOT EXISTS pay_rules (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  scope_type TEXT NOT NULL DEFAULT 'general' CHECK(scope_type IN ('general','group','employee','shift')),
  scope_id TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  normal_rate_cents INTEGER NOT NULL DEFAULT 600,
  start_round_mode TEXT NOT NULL DEFAULT 'none',
  start_round_minutes INTEGER NOT NULL DEFAULT 1,
  late_grace_minutes INTEGER NOT NULL DEFAULT 0,
  late_clock_out_grace_minutes INTEGER NOT NULL DEFAULT 30,
  end_round_mode TEXT NOT NULL DEFAULT 'none',
  end_round_minutes INTEGER NOT NULL DEFAULT 1,
  duration_round_mode TEXT NOT NULL DEFAULT 'none',
  payable_increment_minutes INTEGER NOT NULL DEFAULT 1,
  minimum_minutes INTEGER NOT NULL DEFAULT 0,
  maximum_minutes INTEGER NOT NULL DEFAULT 720,
  valid_from TEXT,
  valid_until TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pay_rules_scope_active ON pay_rules(scope_type, scope_id, active, priority DESC);

CREATE TABLE IF NOT EXISTS pay_rule_versions (
  rule_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(rule_id, version)
);
CREATE TRIGGER IF NOT EXISTS pay_rule_versions_no_update BEFORE UPDATE ON pay_rule_versions BEGIN SELECT RAISE(ABORT, 'pay_rule_version_is_immutable'); END;
CREATE TRIGGER IF NOT EXISTS pay_rule_versions_no_delete BEFORE DELETE ON pay_rule_versions BEGIN SELECT RAISE(ABORT, 'pay_rule_version_is_immutable'); END;

CREATE TABLE IF NOT EXISTS special_rates (
  id TEXT PRIMARY KEY NOT NULL,
  pay_rule_id TEXT NOT NULL,
  label TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  rate_cents INTEGER NOT NULL,
  capacity INTEGER,
  qualification TEXT NOT NULL DEFAULT 'first_eligible' CHECK(qualification IN ('first_eligible','scheduled','automatic','manual')),
  priority INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY(pay_rule_id) REFERENCES pay_rules(id)
);

CREATE TABLE IF NOT EXISTS special_rate_assignments (
  special_rate_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  date TEXT NOT NULL,
  assigned_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(special_rate_id, employee_id, date)
);

CREATE TABLE IF NOT EXISTS payroll_segments (
  id TEXT PRIMARY KEY NOT NULL,
  shift_id TEXT NOT NULL,
  special_rate_id TEXT,
  label TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  minutes REAL NOT NULL,
  rate_cents INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  FOREIGN KEY(shift_id) REFERENCES shifts(id)
);
CREATE INDEX IF NOT EXISTS payroll_segments_shift ON payroll_segments(shift_id);

CREATE TABLE IF NOT EXISTS payroll_periods (
  id TEXT PRIMARY KEY NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','locked')),
  locked_at TEXT,
  locked_by TEXT,
  unlocked_at TEXT,
  unlocked_by TEXT,
  unlock_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(start_date, end_date)
);

CREATE TABLE IF NOT EXISTS payroll_adjustments (
  id TEXT PRIMARY KEY NOT NULL,
  period_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('bonus','deduction','advance','hours')),
  amount_cents INTEGER NOT NULL DEFAULT 0,
  minutes REAL NOT NULL DEFAULT 0,
  date TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(period_id) REFERENCES payroll_periods(id)
);

CREATE TABLE IF NOT EXISTS payroll_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  period_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(period_id, employee_id)
);

CREATE TABLE IF NOT EXISTS system_alerts (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning' CHECK(severity IN ('info','warning','critical')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  object_type TEXT NOT NULL DEFAULT '',
  object_id TEXT NOT NULL DEFAULT '',
  dedupe_key TEXT UNIQUE,
  resolved INTEGER NOT NULL DEFAULT 0,
  resolved_by TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS system_alerts_open ON system_alerts(resolved, severity, created_at DESC);

CREATE TABLE IF NOT EXISTS alert_rules (
  type TEXT PRIMARY KEY NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  severity TEXT NOT NULL DEFAULT 'warning' CHECK(severity IN ('info','warning','critical')),
  channel TEXT NOT NULL DEFAULT 'in_app' CHECK(channel IN ('in_app','push','both')),
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

/*
 * Recoverable deletion journal.  The operational tables can stay small while
 * an administrator still has a safe, auditable way to undo an accidental
 * deletion.  payload is a complete JSON snapshot of the affected record and
 * its dependent rows at the moment of deletion.
 */
CREATE TABLE IF NOT EXISTS deleted_records (
  id TEXT PRIMARY KEY NOT NULL,
  record_type TEXT NOT NULL CHECK(record_type IN ('fleet_history','shift','schedule_assignment')),
  record_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}',
  deleted_at TEXT NOT NULL,
  deleted_by TEXT NOT NULL,
  deleted_by_name TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  restored_at TEXT,
  restored_by TEXT,
  restore_reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS deleted_records_open ON deleted_records(restored_at, deleted_at DESC);
CREATE INDEX IF NOT EXISTS deleted_records_object ON deleted_records(record_type, record_id, deleted_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY NOT NULL,
  timestamp TEXT NOT NULL,
  user_id TEXT,
  user_name TEXT NOT NULL DEFAULT 'System',
  role TEXT NOT NULL DEFAULT 'system',
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL DEFAULT '',
  old_value TEXT,
  new_value TEXT,
  reason TEXT NOT NULL DEFAULT '',
  ip_address TEXT NOT NULL DEFAULT '',
  device_id TEXT NOT NULL DEFAULT '',
  admin_pin_used INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS audit_log_time ON audit_log(timestamp DESC);
CREATE INDEX IF NOT EXISTS audit_log_object ON audit_log(object_type, object_id, timestamp DESC);
CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log_is_immutable'); END;
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log_is_immutable'); END;

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL
);

DROP TRIGGER IF EXISTS shift_final_km_guard;
CREATE TRIGGER shift_final_km_guard
BEFORE UPDATE OF final_km ON shifts
WHEN NEW.final_km IS NOT OLD.final_km AND NEW.final_km IS NOT NULL AND (
  NEW.final_km < COALESCE((
    SELECT initial_km FROM vehicle_segments
    WHERE shift_id = NEW.id AND vehicle_id = NEW.current_vehicle_id
    ORDER BY started_at DESC LIMIT 1
  ), NEW.initial_km) OR
  EXISTS(SELECT 1 FROM vehicle_registry WHERE bike_id = NEW.current_vehicle_id AND odometer > NEW.final_km)
)
BEGIN SELECT RAISE(ABORT, 'invalid_final_km'); END;

CREATE TRIGGER IF NOT EXISTS shift_vehicle_change_guard
BEFORE UPDATE OF current_vehicle_id ON shifts
WHEN NEW.status = 'active' AND NEW.current_vehicle_id <> OLD.current_vehicle_id AND NOT EXISTS(
  SELECT 1 FROM vehicle_registry
  WHERE bike_id = NEW.current_vehicle_id AND status = 'in_use' AND active_shift_id = OLD.id
)
BEGIN SELECT RAISE(ABORT, 'vehicle_unavailable'); END;

CREATE TRIGGER IF NOT EXISTS schedule_employee_overlap_guard
BEFORE INSERT ON schedules
WHEN NEW.status NOT IN ('cancelled','completed') AND EXISTS(
  SELECT 1 FROM schedules
  WHERE id <> NEW.id AND employee_id = NEW.employee_id AND status NOT IN ('cancelled','completed')
    AND start_at < NEW.end_at AND end_at > NEW.start_at
)
BEGIN SELECT RAISE(ABORT, 'employee_schedule_conflict'); END;

CREATE TRIGGER IF NOT EXISTS schedule_vehicle_overlap_guard
BEFORE INSERT ON schedules
WHEN NEW.vehicle_id IS NOT NULL AND NEW.status NOT IN ('cancelled','completed') AND EXISTS(
  SELECT 1 FROM schedules
  WHERE id <> NEW.id AND vehicle_id = NEW.vehicle_id AND status NOT IN ('cancelled','completed')
    AND start_at < NEW.end_at AND end_at > NEW.start_at
)
BEGIN SELECT RAISE(ABORT, 'vehicle_schedule_conflict'); END;

INSERT OR IGNORE INTO pay_rules (
  id, name, scope_type, scope_id, version, priority, normal_rate_cents,
  start_round_mode, start_round_minutes, end_round_mode, end_round_minutes,
  duration_round_mode, payable_increment_minutes, minimum_minutes, maximum_minutes,
  active, created_at, updated_at
) VALUES (
  'default-general', 'Βασικός κανόνας', 'general', '', 1, 0, 600,
  'none', 1, 'none', 1, 'none', 1, 0, 720, 1, datetime('now'), datetime('now')
);
INSERT OR IGNORE INTO system_settings (key, value, updated_at) VALUES ('timezone', 'Europe/Athens', datetime('now'));
INSERT OR IGNORE INTO system_settings (key, value, updated_at) VALUES ('no_schedule_policy', 'allow_warning', datetime('now'));
INSERT OR IGNORE INTO system_settings (key, value, updated_at) VALUES ('admin_session_duration', '4h', datetime('now'));
INSERT OR IGNORE INTO system_settings (key, value, updated_at) VALUES ('safety_fallback_hour', '5', datetime('now'));
INSERT OR IGNORE INTO system_settings (key, value, updated_at) VALUES ('unusual_distance_km', '300', datetime('now'));
INSERT OR IGNORE INTO shift_templates (id,name,segments,active,sort_order,color,created_at,updated_at) VALUES ('tpl-0800-1600','08:00 - 16:00','[{"start":"08:00","end":"16:00"}]',1,10,'#0D8F82',datetime('now'),datetime('now'));
INSERT OR IGNORE INTO shift_templates (id,name,segments,active,sort_order,color,created_at,updated_at) VALUES ('tpl-1300-0100','13:00 - 01:00','[{"start":"13:00","end":"01:00"}]',1,20,'#315D67',datetime('now'),datetime('now'));
INSERT OR IGNORE INTO shift_templates (id,name,segments,active,sort_order,color,created_at,updated_at) VALUES ('tpl-1500-0000','15:00 - 00:00','[{"start":"15:00","end":"00:00"}]',1,30,'#7663C5',datetime('now'),datetime('now'));
INSERT OR IGNORE INTO shift_templates (id,name,segments,active,sort_order,color,created_at,updated_at) VALUES ('tpl-1600-0100','16:00 - 01:00','[{"start":"16:00","end":"01:00"}]',1,40,'#5067A8',datetime('now'),datetime('now'));
INSERT OR IGNORE INTO shift_templates (id,name,segments,active,sort_order,color,created_at,updated_at) VALUES ('tpl-1300-1700','13:00 - 17:00','[{"start":"13:00","end":"17:00"}]',1,50,'#159679',datetime('now'),datetime('now'));
INSERT OR IGNORE INTO shift_templates (id,name,segments,active,sort_order,color,created_at,updated_at) VALUES ('tpl-1800-0000','18:00 - 00:00','[{"start":"18:00","end":"00:00"}]',1,60,'#BE7B2E',datetime('now'),datetime('now'));
INSERT OR IGNORE INTO shift_templates (id,name,segments,active,sort_order,color,created_at,updated_at) VALUES ('tpl-1900-0000','19:00 - 00:00','[{"start":"19:00","end":"00:00"}]',1,70,'#B05A46',datetime('now'),datetime('now'));
INSERT OR IGNORE INTO shift_templates (id,name,segments,active,sort_order,color,created_at,updated_at) VALUES ('tpl-2000-0000','20:00 - 00:00','[{"start":"20:00","end":"00:00"}]',1,80,'#99506E',datetime('now'),datetime('now'));
INSERT OR IGNORE INTO shift_templates (id,name,segments,active,sort_order,color,created_at,updated_at) VALUES ('tpl-1600-0000','16:00 - 00:00','[{"start":"16:00","end":"00:00"}]',1,90,'#3E718F',datetime('now'),datetime('now'));
INSERT OR IGNORE INTO shift_templates (id,name,segments,active,sort_order,color,created_at,updated_at) VALUES ('tpl-1800-2300','18:00 - 23:00','[{"start":"18:00","end":"23:00"}]',1,100,'#A66E35',datetime('now'),datetime('now'));
INSERT OR IGNORE INTO shift_templates (id,name,segments,active,sort_order,color,created_at,updated_at) VALUES ('tpl-split-0816-20302330','08:00 - 16:00 / 20:30 - 23:30','[{"start":"08:00","end":"16:00"},{"start":"20:30","end":"23:30"}]',1,110,'#187F73',datetime('now'),datetime('now'));
INSERT OR IGNORE INTO shift_templates (id,name,segments,active,sort_order,color,created_at,updated_at) VALUES ('tpl-0900-1500','09:00 - 15:00','[{"start":"09:00","end":"15:00"}]',1,120,'#3B826C',datetime('now'),datetime('now'));
INSERT OR IGNORE INTO shift_templates (id,name,segments,active,sort_order,color,created_at,updated_at) VALUES ('tpl-1400-0000','14:00 - 00:00','[{"start":"14:00","end":"00:00"}]',1,130,'#6B5FA4',datetime('now'),datetime('now'));
INSERT OR IGNORE INTO shift_templates (id,name,segments,active,sort_order,color,created_at,updated_at) VALUES ('tpl-1700-0100','17:00 - 01:00','[{"start":"17:00","end":"01:00"}]',1,140,'#596CA0',datetime('now'),datetime('now'));
INSERT OR IGNORE INTO shift_templates (id,name,segments,active,sort_order,color,created_at,updated_at) VALUES ('tpl-split-0813-1800','08:00 - 13:00 / 18:00 - 00:00','[{"start":"08:00","end":"13:00"},{"start":"18:00","end":"00:00"}]',1,150,'#28766E',datetime('now'),datetime('now'));
INSERT OR IGNORE INTO alert_rules (type,enabled,severity,channel,updated_at) VALUES ('forgotten_clock_out',1,'warning','both',datetime('now'));
INSERT OR IGNORE INTO alert_rules (type,enabled,severity,channel,updated_at) VALUES ('overtime',1,'warning','both',datetime('now'));
INSERT OR IGNORE INTO alert_rules (type,enabled,severity,channel,updated_at) VALUES ('auto_close',1,'info','in_app',datetime('now'));
INSERT OR IGNORE INTO alert_rules (type,enabled,severity,channel,updated_at) VALUES ('missing_km',1,'critical','both',datetime('now'));
INSERT OR IGNORE INTO alert_rules (type,enabled,severity,channel,updated_at) VALUES ('out_of_schedule',1,'warning','in_app',datetime('now'));
INSERT OR IGNORE INTO alert_rules (type,enabled,severity,channel,updated_at) VALUES ('vehicle_conflict',1,'warning','in_app',datetime('now'));
INSERT OR IGNORE INTO alert_rules (type,enabled,severity,channel,updated_at) VALUES ('schedule_conflict',1,'warning','in_app',datetime('now'));
INSERT OR IGNORE INTO alert_rules (type,enabled,severity,channel,updated_at) VALUES ('invalid_km',1,'warning','in_app',datetime('now'));
INSERT OR IGNORE INTO alert_rules (type,enabled,severity,channel,updated_at) VALUES ('unusual_distance',1,'warning','in_app',datetime('now'));
INSERT OR IGNORE INTO alert_rules (type,enabled,severity,channel,updated_at) VALUES ('service_conflict',1,'critical','both',datetime('now'));
INSERT OR IGNORE INTO alert_rules (type,enabled,severity,channel,updated_at) VALUES ('service_due',1,'warning','both',datetime('now'));
INSERT OR IGNORE INTO alert_rules (type,enabled,severity,channel,updated_at) VALUES ('major_service_due',1,'warning','both',datetime('now'));
INSERT OR IGNORE INTO alert_rules (type,enabled,severity,channel,updated_at) VALUES ('mileage_check_stale',1,'warning','both',datetime('now'));
INSERT OR IGNORE INTO alert_rules (type,enabled,severity,channel,updated_at) VALUES ('payroll_correction',1,'warning','in_app',datetime('now'));
INSERT OR IGNORE INTO alert_rules (type,enabled,severity,channel,updated_at) VALUES ('correction_request',1,'warning','in_app',datetime('now'));
INSERT OR IGNORE INTO alert_rules (type,enabled,severity,channel,updated_at) VALUES ('backup_failed',1,'critical','both',datetime('now'));
INSERT OR IGNORE INTO alert_rules (type,enabled,severity,channel,updated_at) VALUES ('db_problem',1,'critical','both',datetime('now'));
INSERT OR IGNORE INTO alert_rules (type,enabled,severity,channel,updated_at) VALUES ('server_offline',1,'warning','both',datetime('now'));
INSERT OR IGNORE INTO alert_rules (type,enabled,severity,channel,updated_at) VALUES ('server_restart',1,'warning','in_app',datetime('now'));
INSERT OR IGNORE INTO alert_rules (type,enabled,severity,channel,updated_at) VALUES ('server_temperature',1,'critical','both',datetime('now'));
INSERT OR IGNORE INTO alert_rules (type,enabled,severity,channel,updated_at) VALUES ('server_storage',1,'critical','both',datetime('now'));
INSERT OR IGNORE INTO alert_rules (type,enabled,severity,channel,updated_at) VALUES ('server_battery',1,'warning','both',datetime('now'));
INSERT OR IGNORE INTO alert_rules (type,enabled,severity,channel,updated_at) VALUES ('server_restriction',1,'warning','both',datetime('now'));
`;

// D1Database.exec treats every non-empty line as a separate query. Keep each
// complete SQL statement on one line, while allowing the source schema to stay
// readable and multi-line. The schema's trigger bodies end with `END;`, so the
// statement boundary is still the final semicolon at the end of the line.
export function d1ExecScript(script) {
  const statements = [];
  let current = [];
  for (const rawLine of String(script || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("--")) continue;
    current.push(line);
    if (line.endsWith(";")) {
      statements.push(current.join(" "));
      current = [];
    }
  }
  if (current.length) throw new Error("Incomplete SQL schema statement");
  return statements.join("\n");
}

async function ensureColumn(env, table, column, definition) {
  const columns = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
  if (!(columns.results || []).some((item) => item.name === column)) {
    await env.DB.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function initializeDefaultPayrollPolicy(env) {
  const [rule, specialCount] = await Promise.all([
    env.DB.prepare("SELECT * FROM pay_rules WHERE id='default-general'").first(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM special_rates WHERE pay_rule_id='default-general'").first()
  ]);
  // Only initialize a never-configured default. Existing custom rules and
  // historical special-rate identities remain untouched.
  const pristine = rule && Number(rule.version) === 1 && Number(rule.active) === 1 &&
    Number(specialCount?.count || 0) === 0 && Number(rule.normal_rate_cents) === 600 &&
    rule.start_round_mode === "none" && Number(rule.start_round_minutes) === 1 &&
    Number(rule.late_grace_minutes || 0) === 0 && rule.end_round_mode === "none" &&
    Number(rule.end_round_minutes) === 1 && (rule.duration_round_mode === "nearest" || rule.duration_round_mode === "none") &&
    Number(rule.payable_increment_minutes) === 1 && Number(rule.minimum_minutes) === 0 &&
    Number(rule.maximum_minutes) === 720;
  if (!pristine) return;

  const now = nowIso();
  const version = Number(rule.version) + 1;
  const updated = await env.DB.prepare(`UPDATE pay_rules SET version=?,start_round_mode='up',start_round_minutes=30,
    late_grace_minutes=0,late_clock_out_grace_minutes=30,duration_round_mode='none',payable_increment_minutes=1,updated_at=?
    WHERE id='default-general' AND version=1 AND active=1`).bind(version, now).run();
  if (!Number(updated?.meta?.changes || 0)) return;

  const specialRates = DEFAULT_PAY_SPECIAL_RATES.map((item) => ({ ...item, capacity: null, active: true }));
  await env.DB.batch([
    ...specialRates.map((item) => env.DB.prepare(`INSERT INTO special_rates
      (id,pay_rule_id,label,start_time,end_time,rate_cents,capacity,qualification,priority,active)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        label=excluded.label,start_time=excluded.start_time,end_time=excluded.end_time,
        rate_cents=excluded.rate_cents,capacity=excluded.capacity,qualification=excluded.qualification,
        priority=excluded.priority,active=excluded.active WHERE special_rates.pay_rule_id=excluded.pay_rule_id`)
      .bind(item.id, "default-general", item.label, item.startTime, item.endTime, item.rateCents,
        item.capacity, item.qualification, item.priority, item.active ? 1 : 0)),
    env.DB.prepare(`INSERT OR IGNORE INTO pay_rule_versions
      (rule_id,version,snapshot,created_by,created_at) VALUES (?,?,?,?,?)`).bind(
      "default-general", version, JSON.stringify({
        id: "default-general", name: rule.name, scopeType: "general", scopeId: "", version,
        priority: Number(rule.priority || 0), normalRateCents: 600,
        startRoundMode: "up", startRoundMinutes: 30, lateGraceMinutes: 0, lateClockOutGraceMinutes: 30,
        endRoundMode: "none", endRoundMinutes: 1, durationRoundMode: "none",
        payableIncrementMinutes: 1, minimumMinutes: 0, maximumMinutes: 720,
        validFrom: rule.valid_from || null, validUntil: rule.valid_until || null, active: true,
        specialRates
      }), "system", now)
  ]);
  await audit(env, new Request("https://system.local"), null, "default_payroll_policy_initialized",
    "pay_rule", "default-general", { version: 1 }, { version, specialRates },
    "Αρχική ρύθμιση ωριαίων ζωνών και στρογγυλοποίησης Clock In", false);
}

class ApiError extends Error {
  constructor(status, message, code = "", details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function ensureWorkforceSchema(env) {
  await env.DB.exec(d1ExecScript(WORKFORCE_SCHEMA));
  await ensureColumn(env, "app_users", "uses_own_vehicle", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn(env, "pay_rules", "late_grace_minutes", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn(env, "pay_rules", "late_clock_out_grace_minutes", "INTEGER NOT NULL DEFAULT 30");
  await ensureColumn(env, "shifts", "overtime_rate_cents", "INTEGER");
  await ensureColumn(env, "shifts", "overtime_minutes_override", "INTEGER");
  await ensureColumn(env, "shifts", "overtime_approved_by", "TEXT");
  await ensureColumn(env, "shifts", "overtime_approved_by_name", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(env, "shifts", "overtime_approved_at", "TEXT");
  await initializeDefaultPayrollPolicy(env);
}

export async function routeWorkforce(request, env, path, deps) {
  if (!path.startsWith("/api/")) return null;
  try {
    return await (async () => {
    if (path === "/api/auth/bootstrap-status" && request.method === "GET") return bootstrapStatus(env);
    if (path === "/api/auth/bootstrap" && request.method === "POST") return bootstrapOwner(request, env, deps);
    if (path === "/api/auth/user-login" && request.method === "POST") return userLogin(request, env);
    if (path === "/api/auth/me" && request.method === "GET") return authMe(request, env);
    if (path === "/api/auth/verify-admin-pin" && request.method === "POST") return verifyCriticalPin(request, env, deps);
    if (path === "/api/auth/user-logout" && request.method === "POST") return userLogout(request, env);
    if (path === "/api/auth/devices" && request.method === "GET") return listDevices(request, env);
    if (path === "/api/auth/force-logout" && request.method === "POST") return forceLogout(request, env, deps);

    if (path === "/api/workforce/dashboard" && request.method === "GET") return dashboard(request, env);
    if (path === "/api/admin/staffing-coverage" && request.method === "GET") return staffingCoverage(request, env);
    if (path === "/api/workforce/vehicles" && request.method === "GET") return vehicles(request, env, deps);
    if (path === "/api/employee/home" && request.method === "GET") return employeeHome(request, env, deps);
    if (path === "/api/employee/clock-in" && request.method === "POST") return clockIn(request, env, deps);
    if (path === "/api/employee/clock-out" && request.method === "POST") return clockOut(request, env, deps);
    if (path === "/api/employee/change-vehicle" && request.method === "POST") return employeeChangeVehicle(request, env, deps);
    if (path === "/api/employee/corrections" && request.method === "POST") return createCorrection(request, env);

    if (path === "/api/admin/employees" && request.method === "GET") return listEmployees(request, env);
    if (path === "/api/admin/employees" && request.method === "POST") return createEmployee(request, env, deps);
    const employeeMatch = path.match(/^\/api\/admin\/employees\/([^/]+)$/);
    if (employeeMatch && request.method === "PUT") return updateEmployee(request, env, deps, employeeMatch[1]);
    const passwordMatch = path.match(/^\/api\/admin\/employees\/([^/]+)\/password$/);
    if (passwordMatch && request.method === "POST") return resetEmployeePassword(request, env, deps, passwordMatch[1]);
    const vehicleStatusMatch = path.match(/^\/api\/admin\/vehicles\/([^/]+)\/status$/);
    if (vehicleStatusMatch && request.method === "POST") return updateVehicleStatus(request, env, deps, vehicleStatusMatch[1]);
    if (path === "/api/admin/vehicles/archived" && request.method === "GET") return archivedVehicles(request, env);
    const vehicleArchiveMatch = path.match(/^\/api\/admin\/vehicles\/([^/]+)\/(archive|restore)$/);
    if (vehicleArchiveMatch && request.method === "POST") {
      return vehicleArchiveMatch[2] === "archive"
        ? archiveVehicle(request, env, deps, vehicleArchiveMatch[1])
        : restoreVehicle(request, env, deps, vehicleArchiveMatch[1]);
    }

    if (path === "/api/admin/schedules" && request.method === "GET") return listSchedules(request, env);
    if (path === "/api/admin/schedules" && request.method === "POST") return createSchedules(request, env, deps);
    if (path === "/api/admin/shift-templates" && request.method === "GET") return listShiftTemplates(request, env);
    if (path === "/api/admin/shift-templates" && request.method === "POST") return createShiftTemplate(request, env);
    const templateMatch = path.match(/^\/api\/admin\/shift-templates\/([^/]+)$/);
    if (templateMatch && request.method === "PUT") return updateShiftTemplate(request, env, templateMatch[1]);
    const templateDeleteMatch = path.match(/^\/api\/admin\/shift-templates\/([^/]+)\/delete$/);
    if (templateDeleteMatch && request.method === "POST") return deleteShiftTemplate(request, env, templateDeleteMatch[1]);
    if (path === "/api/admin/schedule-week" && request.method === "GET") return scheduleWeek(request, env, deps);
    if (path === "/api/admin/schedule-week" && request.method === "POST") return createWeekAssignments(request, env, deps);
    if (path === "/api/admin/schedule-week/copy" && request.method === "POST") return copyScheduleWeek(request, env, deps);
    if (path === "/api/admin/schedule-week/publish" && request.method === "POST") return publishScheduleWeek(request, env, deps);
    if (path === "/api/admin/schedule-import/preview" && request.method === "POST") return previewScheduleImport(request, env);
    if (path === "/api/admin/schedule-import/commit" && request.method === "POST") return commitScheduleImport(request, env, deps);
    if (path === "/api/employee/schedule-acknowledge" && request.method === "POST") return acknowledgeSchedule(request, env);
    const scheduleEditMatch = path.match(/^\/api\/admin\/schedule-assignments\/([^/]+)\/edit$/);
    if (scheduleEditMatch && request.method === "POST") return updateScheduleAssignment(request, env, deps, scheduleEditMatch[1]);
    const scheduleDeleteMatch = path.match(/^\/api\/admin\/schedule-assignments\/([^/]+)\/delete$/);
    if (scheduleDeleteMatch && request.method === "POST") return deleteScheduleAssignment(request, env, scheduleDeleteMatch[1]);
    if (path === "/api/admin/shifts" && request.method === "GET") return listShifts(request, env);
    if (path === "/api/admin/shifts/manual-clock-in" && request.method === "POST") return manualClockIn(request, env, deps);
    const shiftActionMatch = path.match(/^\/api\/admin\/shifts\/([^/]+)\/(approve-overtime|reject-overtime|close|kilometers|vehicle|edit|delete)$/);
    if (shiftActionMatch && request.method === "POST") return shiftAction(request, env, deps, shiftActionMatch[1], shiftActionMatch[2]);

    if (path === "/api/admin/pay-rules" && request.method === "GET") return listPayRules(request, env);
    if (path === "/api/admin/pay-rules" && request.method === "POST") return savePayRule(request, env, deps);
    if (path === "/api/admin/special-rate-assignments" && request.method === "GET") return listSpecialRateAssignments(request, env);
    if (path === "/api/admin/special-rate-assignments" && request.method === "POST") return saveSpecialRateAssignments(request, env, deps);
    if (path === "/api/admin/payroll/simulate" && request.method === "POST") return simulatePay(request, env);
    if (path === "/api/admin/payroll" && request.method === "GET") return payrollSummary(request, env);
    if (path === "/api/admin/payroll/adjustment" && request.method === "POST") return addPayrollAdjustment(request, env, deps);
    if (path === "/api/admin/payroll/lock" && request.method === "POST") return lockPayroll(request, env, deps);
    if (path === "/api/admin/payroll/unlock" && request.method === "POST") return unlockPayroll(request, env, deps);

    if (path === "/api/admin/alerts" && request.method === "GET") return listAlerts(request, env);
    if (path === "/api/admin/alert-rules" && request.method === "GET") return listAlertRules(request, env);
    if (path === "/api/admin/alert-rules" && request.method === "PUT") return saveAlertRules(request, env, deps);
    const alertMatch = path.match(/^\/api\/admin\/alerts\/([^/]+)\/resolve$/);
    if (alertMatch && request.method === "POST") return resolveAlert(request, env, alertMatch[1]);
    if (path === "/api/admin/corrections" && request.method === "GET") return listCorrections(request, env);
    const correctionMatch = path.match(/^\/api\/admin\/corrections\/([^/]+)\/resolve$/);
    if (correctionMatch && request.method === "POST") return resolveCorrection(request, env, deps, correctionMatch[1]);
    if (path === "/api/admin/audit" && request.method === "GET") return listAudit(request, env);
    if (path === "/api/admin/recycle-bin" && request.method === "GET") return listDeletedRecords(request, env);
    const recycleRestoreMatch = path.match(/^\/api\/admin\/recycle-bin\/([^/]+)\/restore$/);
    if (recycleRestoreMatch && request.method === "POST") return restoreDeletedRecord(request, env, deps, recycleRestoreMatch[1]);
    if (path === "/api/admin/reports" && request.method === "GET") return reportData(request, env, deps);
    if (path === "/api/admin/server-health" && request.method === "GET") return serverDeviceHealth(request, env);
    if (path === "/api/admin/settings" && request.method === "GET") return getSystemSettings(request, env);
    if (path === "/api/admin/settings" && request.method === "PUT") return updateSystemSettings(request, env, deps);

    if (path === "/api/server/system-export" && request.method === "GET") return systemExport(request, env, deps);
    if (path === "/api/server/system-import" && request.method === "PUT") return systemImport(request, env, deps);
      return null;
    })();
  } catch (error) {
    if (error instanceof ApiError) return wfJson({
      error: error.message,
      code: error.code || undefined,
      ...(error.details && typeof error.details === "object" ? error.details : {})
    }, error.status);
    const message = String(error && error.message || "");
    if (/UNIQUE constraint failed: shifts\.current_vehicle_id/.test(message)) {
      await createAlert(env, "vehicle_conflict", "warning", "Ταυτόχρονη δέσμευση απορρίφθηκε",
        "Δύο χρήστες προσπάθησαν να δεσμεύσουν το ίδιο μηχανάκι. Η βάση κράτησε μόνο την πρώτη επιβεβαιωμένη βάρδια.",
        "vehicle", "", null);
      return wfJson({ error: "Το μηχανάκι μόλις δεσμεύτηκε από άλλο χρήστη.", code: "vehicle_taken" }, 409);
    }
    if (/UNIQUE constraint failed: shifts\.employee_id/.test(message)) {
      return wfJson({ error: "Υπάρχει ήδη ενεργή βάρδια για αυτόν τον εργαζόμενο.", code: "shift_exists" }, 409);
    }
    if (/vehicle_unavailable/.test(message)) {
      await createAlert(env, "vehicle_conflict", "warning", "Αλλαγή μηχανής απορρίφθηκε",
        "Το επιλεγμένο μηχανάκι δεσμεύτηκε ταυτόχρονα από άλλη βάρδια.", "vehicle", "", null);
      return wfJson({ error: "Το νέο μηχανάκι μόλις δεσμεύτηκε από άλλο χρήστη.", code: "vehicle_taken" }, 409);
    }
    if (/vehicle_schedule_conflict/.test(message)) {
      await createAlert(env, "schedule_conflict", "warning", "Σύγκρουση προανάθεσης",
        "Απορρίφθηκε πρόγραμμα που θα ανέθετε το ίδιο μηχανάκι σε επικαλυπτόμενες βάρδιες.", "schedule", "", null);
      return wfJson({ error: "Το μηχανάκι είναι ήδη προανατεθειμένο σε άλλη βάρδια που επικαλύπτεται.", code: "vehicle_schedule_conflict" }, 409);
    }
    if (/employee_schedule_conflict/.test(message)) {
      await createAlert(env, "schedule_conflict", "warning", "Σύγκρουση προγράμματος",
        "Απορρίφθηκε επικαλυπτόμενο πρόγραμμα για εργαζόμενο.", "schedule", "", null);
      return wfJson({ error: "Ο εργαζόμενος έχει ήδη πρόγραμμα που επικαλύπτεται.", code: "employee_schedule_conflict" }, 409);
    }
    if (/invalid_final_km/.test(message)) return wfJson({ error: "Τα τελικά χιλιόμετρα δεν είναι έγκυρα.", code: "invalid_km" }, 409);
    console.error("Workforce API", error);
    return wfJson({ error: "Η ενέργεια δεν ολοκληρώθηκε. Δοκίμασε ξανά." }, 500);
  }
}

function wfHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Pin, X-Idempotency-Key, X-Fleet-Server-Key",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extra
  };
}

function wfJson(payload, status = 200, extra = {}) {
  return Response.json(payload, { status, headers: wfHeaders(extra) });
}

async function bodyJson(request) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_BODY_BYTES) throw new ApiError(413, "Το αίτημα είναι πολύ μεγάλο.");
  try { return await request.json(); } catch { throw new ApiError(400, "Τα δεδομένα του αιτήματος δεν είναι έγκυρα."); }
}

function text(value, max = 200) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function integer(value, min, max, fallback = 0) {
  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function bool(value) {
  return value === true || value === 1 || value === "1";
}

function nowIso() {
  return new Date().toISOString();
}

function isoTimestamp(value) {
  const raw = text(value, 40);
  const timestamp = raw ? new Date(raw).getTime() : NaN;
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}

function uuid() {
  return crypto.randomUUID();
}

function randomToken(bytes = 32) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return btoa(String.fromCharCode(...value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

async function passwordHash(password, salt, iterations = PASSWORD_ITERATIONS) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(password)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({
    name: "PBKDF2", salt: new TextEncoder().encode(String(salt)), iterations: Number(iterations), hash: "SHA-256"
  }, material, 256);
  return [...new Uint8Array(bits)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

async function secureEqual(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  let mismatch = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    mismatch |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

async function setting(env, key, fallback = "") {
  const row = await env.DB.prepare("SELECT value FROM system_settings WHERE key = ?").bind(key).first();
  return row ? String(row.value) : fallback;
}

async function localDateUtcBounds(env, startDate, endDate) {
  const timeZone = await setting(env, "timezone", DEFAULT_TIME_ZONE);
  return {
    start: scheduleInterval(startDate, "00:00", "00:01", timeZone).start,
    end: scheduleInterval(addCalendarDays(endDate, 1), "00:00", "00:01", timeZone).start
  };
}

function sessionSeconds(value, remember, role) {
  if (remember) return PERSISTENT_SESSION_SECONDS;
  const choices = { "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, never: 10 * 365 * 24 * 60 * 60 };
  return choices[value] || 14400;
}

function requestIp(request) {
  return text(request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "", 120);
}

function cookieValue(request, name) {
  const cookie = request.headers.get("cookie") || "";
  for (const item of cookie.split(";")) {
    const [key, ...parts] = item.trim().split("=");
    if (key === name) return parts.join("=");
  }
  return "";
}

function bearerToken(request) {
  return (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim() || cookieValue(request, AUTH_COOKIE);
}

function authCookie(token, maxAge) {
  return `${AUTH_COOKIE}=${token}; Max-Age=${Math.max(0, Number(maxAge) || 0)}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

async function authenticate(request, env, requiredPermission = "") {
  const token = bearerToken(request);
  if (!token) throw new ApiError(401, "Χρειάζεται σύνδεση.", "login_required");
  const hash = await sha256(`${env.PIN_PEPPER || ""}:auth:${token}`);
  const epoch = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(`
    SELECT s.token_hash, s.user_id, s.device_id, s.persistent, s.created_at, s.expires_at,
           s.last_seen_at AS session_last_seen_at,
           u.full_name, u.username, u.email, u.phone, u.role, u.permissions, u.active,
           u.employee_group, u.pay_rule_id, u.assigned_vehicle_id, u.uses_own_vehicle, u.hire_date, u.notes,
           u.show_schedule, u.show_actual_clock_in, u.show_actual_clock_out,
           u.show_payable_hours, u.show_payment_amount, u.show_shift_kilometers,
           u.can_change_vehicle, u.force_logout_after, u.last_seen_at
    FROM auth_sessions s JOIN app_users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
  `).bind(hash, epoch).first();
  if (!row || !Number(row.active) || Number(row.created_at) < Number(row.force_logout_after || 0)) {
    throw new ApiError(401, "Η σύνδεση έληξε. Συνδέσου ξανά.", "session_expired");
  }
  const overrides = parseJson(row.permissions, []);
  const sanitizedOverrides = sanitizePermissionOverrides(row.role, overrides);
  const permissions = effectivePermissions(row.role, sanitizedOverrides);
  if (JSON.stringify(overrides) !== JSON.stringify(sanitizedOverrides)) {
    await env.DB.prepare("UPDATE app_users SET permissions=? WHERE id=?").bind(JSON.stringify(sanitizedOverrides), row.user_id).run();
    await audit(env, request, row, "permission_overrides_sanitized", "user", row.user_id,
      { permissions: overrides }, { permissions: sanitizedOverrides }, "Αυτόματο κλείδωμα δικαιωμάτων ρόλου", false);
  }
  if (requiredPermission && !hasPermission(permissions, requiredPermission)) {
    await audit(env, request, row, "unauthorized_attempt", "permission", requiredPermission, null, null, "", false);
    throw new ApiError(403, "Δεν έχεις δικαίωμα για αυτή την ενέργεια.", "forbidden");
  }
  if (epoch - Number(row.session_last_seen_at || 0) >= AUTH_TOUCH_SECONDS) {
    const now = nowIso();
    const refreshedExpiry = Number(row.persistent) ? epoch + PERSISTENT_SESSION_SECONDS : Number(row.expires_at || epoch);
    await env.DB.batch([
      env.DB.prepare("UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?").bind(epoch, refreshedExpiry, hash),
      env.DB.prepare("UPDATE app_users SET last_seen_at = ? WHERE id = ?").bind(now, row.user_id),
      env.DB.prepare("UPDATE registered_devices SET last_seen_at = ? WHERE id = ?").bind(now, row.device_id)
    ]);
    row.expires_at = refreshedExpiry;
  }
  return { ...row, permissions, tokenHash: hash };
}

export async function authorizedFor(request, env, permission = "") {
  try {
    await authenticate(request, env, permission);
    return true;
  } catch {
    return false;
  }
}

export async function authenticateExternal(request, env, permission = "") {
  return authenticate(request, env, permission);
}

export async function recordExternalAudit(env, request, actor, action, objectType, objectId, oldValue, newValue, reason = "", pinUsed = false) {
  return audit(env, request, actor, action, objectType, objectId, oldValue, newValue, reason, pinUsed);
}

function publicUser(row) {
  return {
    id: row.user_id || row.id,
    fullName: row.full_name,
    username: row.username,
    email: row.email || "",
    phone: row.phone || "",
    role: row.role,
    permissions: row.permissions || [],
    active: Number(row.active) === 1,
    employeeGroup: row.employee_group || "",
    payRuleId: row.pay_rule_id || null,
    assignedVehicleId: row.assigned_vehicle_id || null,
    usesOwnVehicle: bool(row.uses_own_vehicle),
    hireDate: row.hire_date || null,
    notes: row.notes || "",
    showSchedule: bool(row.show_schedule),
    showActualClockIn: bool(row.show_actual_clock_in),
    showActualClockOut: bool(row.show_actual_clock_out),
    showPayableHours: bool(row.show_payable_hours),
    showPaymentAmount: bool(row.show_payment_amount),
    showShiftKilometers: bool(row.show_shift_kilometers),
    canChangeVehicle: bool(row.can_change_vehicle),
    lastSeenAt: row.last_seen_at || null
  };
}

function permissionMetadata(user) {
  if (normalizeRole(user?.role) !== "employee") {
    return {
      allPermissions: ALL_PERMISSIONS,
      employeeAllowedPermissions: EMPLOYEE_ALLOWED_PERMISSIONS,
      rolePermissions: ROLE_PERMISSIONS,
      roles: Object.keys(ROLE_PERMISSIONS)
    };
  }
  return {
    allPermissions: EMPLOYEE_ALLOWED_PERMISSIONS,
    employeeAllowedPermissions: EMPLOYEE_ALLOWED_PERMISSIONS,
    rolePermissions: { employee: ROLE_PERMISSIONS.employee },
    roles: ["employee"]
  };
}

function isManagementActor(actor) {
  return Boolean(actor && MANAGEMENT_ROLES.has(String(actor.role || "")));
}

async function requirePin(request, env, deps, actor = null) {
  if (isManagementActor(actor)) return false;
  const pin = text(request.headers.get("x-admin-pin"), 8);
  const result = await deps.verifyPin(request, env, pin);
  if (!result.ok) throw new ApiError(result.blocked ? 429 : 403, result.blocked ? "Πολλές προσπάθειες PIN. Δοκίμασε αργότερα." : "Το δεύτερο Admin PIN δεν είναι σωστό.", "admin_pin_required");
  return true;
}

async function verifyCriticalPin(request, env, deps) {
  const actor = await authenticate(request, env, "fleet.manage");
  const pinUsed = await requirePin(request, env, deps, actor);
  return wfJson({ verified: true, pinUsed, user: publicUser(actor) });
}

async function audit(env, request, actor, action, objectType, objectId, oldValue, newValue, reason = "", pinUsed = false) {
  const userId = actor ? String(actor.user_id || actor.id || "") : null;
  const name = actor ? String(actor.full_name || actor.fullName || "System") : "System";
  const role = actor ? String(actor.role || "system") : "system";
  await env.DB.prepare(`INSERT INTO audit_log
    (id, timestamp, user_id, user_name, role, action, object_type, object_id, old_value, new_value, reason, ip_address, device_id, admin_pin_used)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(uuid(), nowIso(), userId, name, role, action, objectType, String(objectId || ""),
      oldValue == null ? null : JSON.stringify(oldValue), newValue == null ? null : JSON.stringify(newValue),
      text(reason, 500), requestIp(request), actor ? String(actor.device_id || "") : "", pinUsed ? 1 : 0).run();
}

async function archiveDeletedRecord(env, actor, recordType, recordId, label, payload, reason = "") {
  const id = uuid();
  const deletedAt = nowIso();
  await env.DB.prepare(`INSERT INTO deleted_records
    (id,record_type,record_id,label,payload,deleted_at,deleted_by,deleted_by_name,reason)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(id, recordType, String(recordId || ""), text(label, 240), JSON.stringify(payload || {}), deletedAt,
      String(actor?.user_id || actor?.id || "system"), text(actor?.full_name || actor?.fullName || "System", 120), text(reason, 500)).run();
  return { id, deletedAt };
}

async function createAlert(env, type, severity, title, message, objectType = "", objectId = "", dedupeKey = null) {
  const rule = await env.DB.prepare("SELECT enabled,severity FROM alert_rules WHERE type=?").bind(type).first();
  if (rule && !bool(rule.enabled)) return false;
  const effectiveSeverity = rule && ["info", "warning", "critical"].includes(rule.severity) ? rule.severity : severity;
  await env.DB.prepare(`INSERT INTO system_alerts
    (id, type, severity, title, message, object_type, object_id, dedupe_key, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(dedupe_key) DO UPDATE SET severity=excluded.severity,title=excluded.title,
      message=excluded.message,object_type=excluded.object_type,object_id=excluded.object_id,
      resolved=0,resolved_by=NULL,resolved_at=NULL,
      created_at=CASE WHEN system_alerts.resolved=1 THEN excluded.created_at ELSE system_alerts.created_at END`)
    .bind(uuid(), type, effectiveSeverity, title, message, objectType, String(objectId || ""), dedupeKey, nowIso()).run();
  return true;
}

export async function createExternalAlert(env, type, severity, title, message, objectType = "", objectId = "", dedupeKey = null) {
  return createAlert(env, type, severity, title, message, objectType, objectId, dedupeKey);
}

async function bootstrapStatus(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM app_users").first();
  return wfJson({ configured: Number(row?.count || 0) > 0 });
}

function validatePassword(password) {
  if (typeof password !== "string" || password.length < 8 || password.length > 128) {
    throw new ApiError(400, "Ο κωδικός πρέπει να έχει τουλάχιστον 8 χαρακτήρες.");
  }
}

function validateUsername(username) {
  const value = text(username, 80).toLowerCase();
  if (!/^[a-z0-9._@+-]{3,80}$/i.test(value)) {
    throw new ApiError(400, "Το username πρέπει να έχει τουλάχιστον 3 έγκυρους χαρακτήρες.");
  }
  return value;
}

async function bootstrapOwner(request, env, deps) {
  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM app_users").first();
  if (Number(count?.count || 0) > 0) throw new ApiError(409, "Ο Owner έχει ήδη δημιουργηθεί.");
  const body = await bodyJson(request);
  const serverOk = await deps.serverAuthorized(request, env);
  if (!serverOk) await requirePin(request, env, deps);
  const fullName = text(body.fullName, 120);
  const username = validateUsername(body.username);
  validatePassword(body.password);
  if (!fullName) throw new ApiError(400, "Γράψε το ονοματεπώνυμο του Owner.");
  const salt = randomToken(24);
  const hash = await passwordHash(body.password, salt);
  const id = uuid();
  const now = nowIso();
  await env.DB.prepare(`INSERT INTO app_users
    (id, full_name, username, email, phone, password_hash, password_salt, password_iterations,
     role, permissions, active, show_schedule, show_actual_clock_in, show_actual_clock_out,
     show_payable_hours, show_payment_amount, show_shift_kilometers, can_change_vehicle, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'owner', '[]', 1, 1, 1, 1, 1, 1, 1, 1, ?, ?)`)
    .bind(id, fullName, username, text(body.email, 160) || null, text(body.phone, 30), hash, salt, PASSWORD_ITERATIONS, now, now).run();
  const actor = { id, full_name: fullName, role: "owner", device_id: text(body.deviceId, 120) };
  await audit(env, request, actor, "owner_created", "user", id, null, { username }, "Αρχική ρύθμιση", true);
  return createSessionResponse(request, env, {
    id, full_name: fullName, username, email: text(body.email, 160), phone: text(body.phone, 30),
    role: "owner", permissions: "[]", active: 1, employee_group: "", pay_rule_id: null,
    assigned_vehicle_id: null, show_schedule: 1, show_actual_clock_in: 1, show_actual_clock_out: 1,
    show_payable_hours: 1, show_payment_amount: 1, show_shift_kilometers: 1, can_change_vehicle: 1,
    force_logout_after: 0
  }, body);
}

async function loginFingerprint(request, env, username) {
  return sha256(`${env.PIN_PEPPER || ""}:login:${username}:${requestIp(request)}`);
}

async function userLogin(request, env) {
  const body = await bodyJson(request);
  const username = validateUsername(body.username);
  const fingerprint = await loginFingerprint(request, env, username);
  const epoch = Math.floor(Date.now() / 1000);
  const attempt = await env.DB.prepare("SELECT attempts, window_started, blocked_until FROM auth_login_attempts WHERE fingerprint = ?").bind(fingerprint).first();
  if (attempt && Number(attempt.blocked_until) > epoch) {
    throw new ApiError(429, "Πολλές αποτυχημένες προσπάθειες. Δοκίμασε ξανά σε 15 λεπτά.", "login_blocked");
  }
  const user = await env.DB.prepare("SELECT * FROM app_users WHERE username = ? OR email = ? LIMIT 1").bind(username, username).first();
  let valid = false;
  if (user && Number(user.active) === 1 && typeof body.password === "string") {
    const supplied = await passwordHash(body.password, user.password_salt, Number(user.password_iterations || PASSWORD_ITERATIONS));
    valid = await secureEqual(supplied, user.password_hash);
  }
  if (!valid) {
    const inWindow = attempt && epoch - Number(attempt.window_started) <= LOGIN_WINDOW_SECONDS;
    const attempts = inWindow ? Number(attempt.attempts) + 1 : 1;
    const windowStarted = inWindow ? Number(attempt.window_started) : epoch;
    const blockedUntil = attempts >= LOGIN_MAX_ATTEMPTS ? epoch + LOGIN_WINDOW_SECONDS : 0;
    await env.DB.prepare(`INSERT INTO auth_login_attempts (fingerprint, attempts, window_started, blocked_until)
      VALUES (?, ?, ?, ?) ON CONFLICT(fingerprint) DO UPDATE SET attempts=excluded.attempts,
      window_started=excluded.window_started, blocked_until=excluded.blocked_until`)
      .bind(fingerprint, attempts, windowStarted, blockedUntil).run();
    await audit(env, request, user || null, "login_failed", "session", "", null, { username }, "", false);
    throw new ApiError(blockedUntil ? 429 : 401, blockedUntil ? "Πολλές αποτυχημένες προσπάθειες. Δοκίμασε ξανά σε 15 λεπτά." : "Το username ή ο κωδικός δεν είναι σωστός.", blockedUntil ? "login_blocked" : "invalid_credentials");
  }
  await env.DB.prepare("DELETE FROM auth_login_attempts WHERE fingerprint = ?").bind(fingerprint).run();
  const response = await createSessionResponse(request, env, user, body);
  await audit(env, request, user, "login", "session", "", null, { device: text(body.deviceName, 120) }, "", false);
  return response;
}

async function createSessionResponse(request, env, user, body) {
  const token = randomToken(40);
  const hash = await sha256(`${env.PIN_PEPPER || ""}:auth:${token}`);
  const deviceId = text(body.deviceId, 120) || uuid();
  const deviceName = text(body.deviceName, 120) || "Άγνωστη συσκευή";
  const platform = ["android", "ios", "web"].includes(body.platform) ? body.platform : "web";
  const remember = bool(body.remember);
  const duration = await setting(env, "admin_session_duration", "4h");
  const epoch = Math.floor(Date.now() / 1000);
  const expiry = epoch + sessionSeconds(duration, remember, user.role);
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO auth_sessions
      (token_hash, user_id, device_id, device_name, platform, persistent, created_at, last_seen_at, expires_at, created_ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(hash, user.id, deviceId, deviceName, platform, remember ? 1 : 0, epoch, epoch, expiry, requestIp(request)),
    env.DB.prepare(`INSERT INTO registered_devices (id, user_id, name, platform, first_seen_at, last_seen_at, active)
      VALUES (?, ?, ?, ?, ?, ?, 1) ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,
      name=excluded.name, platform=excluded.platform, last_seen_at=excluded.last_seen_at, active=1`)
      .bind(deviceId, user.id, deviceName, platform, now, now)
  ]);
  const permissions = effectivePermissions(user.role, parseJson(user.permissions, []));
  const metadata = permissionMetadata({ ...user, permissions });
  return wfJson({
    token, expiresAt: expiry, deviceId,
    user: publicUser({ ...user, user_id: user.id, permissions }),
    ...metadata
  }, 200, { "Set-Cookie": authCookie(token, expiry - epoch) });
}

async function authMe(request, env) {
  const user = await authenticate(request, env);
  const token = bearerToken(request);
  const maxAge = Math.max(0, Number(user.expires_at || 0) - Math.floor(Date.now() / 1000));
  return wfJson({ user: publicUser(user), ...permissionMetadata(user) },
    200, { "Set-Cookie": authCookie(token, maxAge) });
}

async function userLogout(request, env) {
  const user = await authenticate(request, env);
  const epoch = Math.floor(Date.now() / 1000);
  await env.DB.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ?").bind(epoch, user.tokenHash).run();
  await audit(env, request, user, "logout", "session", user.tokenHash.slice(0, 12), null, null, "", false);
  return wfJson({ loggedOut: true }, 200, { "Set-Cookie": authCookie("", 0) });
}

async function listDevices(request, env) {
  const actor = await authenticate(request, env);
  const target = new URL(request.url).searchParams.get("userId") || actor.user_id;
  if (target !== actor.user_id && !hasPermission(actor.permissions, "security.manage")) throw new ApiError(403, "Δεν επιτρέπεται.");
  const rows = await env.DB.prepare("SELECT id, name, platform, first_seen_at, last_seen_at, active FROM registered_devices WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT 50").bind(target).all();
  return wfJson({ devices: rows.results || [] });
}

async function forceLogout(request, env, deps) {
  const actor = await authenticate(request, env, "security.manage");
  const pinUsed = await requirePin(request, env, deps, actor);
  const body = await bodyJson(request);
  const userId = text(body.userId, 100);
  const epoch = Math.floor(Date.now() / 1000);
  if (!userId) throw new ApiError(400, "Λείπει ο χρήστης.");
  await env.DB.batch([
    env.DB.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").bind(epoch, userId),
    env.DB.prepare("UPDATE app_users SET force_logout_after = ?, updated_at = ? WHERE id = ?").bind(epoch, nowIso(), userId),
    env.DB.prepare("UPDATE registered_devices SET active = 0 WHERE user_id = ?").bind(userId)
  ]);
  await audit(env, request, actor, "force_logout", "user", userId, null, { revoked: true }, text(body.reason, 500), pinUsed);
  return wfJson({ loggedOut: true });
}

async function listEmployees(request, env) {
  await authenticate(request, env, "employees.view");
  const rows = await env.DB.prepare(`SELECT id, full_name, username, email, phone, role, permissions, active,
    employee_group, pay_rule_id, assigned_vehicle_id, uses_own_vehicle, hire_date, notes, show_schedule,
    show_actual_clock_in, show_actual_clock_out, show_payable_hours, show_payment_amount,
    show_shift_kilometers, can_change_vehicle, last_seen_at, created_at, updated_at
    FROM app_users ORDER BY active DESC, full_name COLLATE NOCASE`).all();
  return wfJson({ employees: (rows.results || []).map((row) => ({
    ...publicUser({ ...row, permissions: effectivePermissions(row.role, parseJson(row.permissions, [])) }),
    permissionOverrides: sanitizePermissionOverrides(row.role, parseJson(row.permissions, []))
  })) });
}

function employeeInput(body, existing = null) {
  const role = normalizeRole(body.role || existing?.role || "employee");
  const usesOwnVehicle = body.usesOwnVehicle === undefined
    ? Number(existing?.uses_own_vehicle || 0)
    : (bool(body.usesOwnVehicle) ? 1 : 0);
  const requestedPermissions = Array.isArray(body.permissions)
    ? body.permissions.map((item) => text(item, 80)).filter(Boolean)
    : parseJson(existing?.permissions, []);
  const rawPermissions = sanitizePermissionOverrides(role, requestedPermissions);
  return {
    fullName: text(body.fullName ?? existing?.full_name, 120),
    username: body.username !== undefined ? validateUsername(body.username) : existing?.username,
    email: text(body.email ?? existing?.email, 160) || null,
    phone: text(body.phone ?? existing?.phone, 30),
    role,
    rawPermissions,
    active: body.active === undefined ? Number(existing?.active ?? 1) : (bool(body.active) ? 1 : 0),
    employeeGroup: text(body.employeeGroup ?? existing?.employee_group, 80),
    payRuleId: text(body.payRuleId ?? existing?.pay_rule_id, 100) || null,
    // A supplied null/empty value is an explicit request to remove the
    // permanent assignment; only an omitted field keeps the old value.
    // An own-vehicle employee cannot also reserve a fleet vehicle.
    assignedVehicleId: usesOwnVehicle ? null : resolveEmployeeAssignedVehicleId(body, existing),
    usesOwnVehicle,
    hireDate: text(body.hireDate ?? existing?.hire_date, 10) || null,
    notes: text(body.notes ?? existing?.notes, 1000),
    showSchedule: body.showSchedule === undefined ? Number(existing?.show_schedule || 0) : (bool(body.showSchedule) ? 1 : 0),
    showActualClockIn: body.showActualClockIn === undefined ? Number(existing?.show_actual_clock_in || 0) : (bool(body.showActualClockIn) ? 1 : 0),
    showActualClockOut: body.showActualClockOut === undefined ? Number(existing?.show_actual_clock_out || 0) : (bool(body.showActualClockOut) ? 1 : 0),
    showPayableHours: body.showPayableHours === undefined ? Number(existing?.show_payable_hours || 0) : (bool(body.showPayableHours) ? 1 : 0),
    showPaymentAmount: body.showPaymentAmount === undefined ? Number(existing?.show_payment_amount || 0) : (bool(body.showPaymentAmount) ? 1 : 0),
    showShiftKilometers: body.showShiftKilometers === undefined ? Number(existing?.show_shift_kilometers || 0) : (bool(body.showShiftKilometers) ? 1 : 0),
    canChangeVehicle: body.canChangeVehicle === undefined ? Number(existing?.can_change_vehicle || 0) : (bool(body.canChangeVehicle) ? 1 : 0)
  };
}

export function resolveEmployeeAssignedVehicleId(body, existing = null) {
  return text(body?.assignedVehicleId !== undefined ? body.assignedVehicleId : existing?.assigned_vehicle_id, 100) || null;
}

async function validateEmployeeReferences(env, deps, data) {
  if (data.assignedVehicleId) {
    await syncVehicleRegistry(env, deps);
    const vehicle = await env.DB.prepare(`SELECT 1 FROM vehicle_registry vr
      WHERE vr.bike_id=? AND vr.status NOT IN ('service','inactive')
        AND NOT EXISTS (SELECT 1 FROM vehicle_archives va WHERE va.bike_id=vr.bike_id AND va.active=1)`).bind(data.assignedVehicleId).first();
    if (!vehicle) throw new ApiError(400, "Το ανατεθειμένο μηχανάκι δεν βρέθηκε ή δεν είναι διαθέσιμο.");
  }
  if (data.payRuleId) {
    const rule = await env.DB.prepare("SELECT 1 FROM pay_rules WHERE id=? AND active=1").bind(data.payRuleId).first();
    if (!rule) throw new ApiError(400, "Ο κανόνας πληρωμής δεν βρέθηκε ή δεν είναι ενεργός.");
  }
}

async function createEmployee(request, env, deps) {
  const actor = await authenticate(request, env, "employees.manage");
  const body = await bodyJson(request);
  const data = employeeInput(body);
  if (!data.fullName) throw new ApiError(400, "Γράψε το ονοματεπώνυμο.");
  validatePassword(body.password);
  await validateEmployeeReferences(env, deps, data);
  const critical = data.role !== "employee" || data.rawPermissions.length || data.employeeGroup || data.payRuleId ||
    data.assignedVehicleId || data.usesOwnVehicle || data.canChangeVehicle || data.showActualClockIn || data.showActualClockOut ||
    data.showPayableHours || data.showPaymentAmount || data.showShiftKilometers;
  const pinUsed = critical ? await requirePin(request, env, deps, actor) : false;
  const salt = randomToken(24);
  const hash = await passwordHash(body.password, salt);
  const id = uuid();
  const now = nowIso();
  await env.DB.prepare(`INSERT INTO app_users
    (id, full_name, username, email, phone, password_hash, password_salt, password_iterations,
     role, permissions, active, employee_group, pay_rule_id, assigned_vehicle_id, uses_own_vehicle, hire_date, notes,
     show_schedule, show_actual_clock_in, show_actual_clock_out, show_payable_hours,
     show_payment_amount, show_shift_kilometers, can_change_vehicle, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, data.fullName, data.username, data.email, data.phone, hash, salt, PASSWORD_ITERATIONS,
      data.role, JSON.stringify(data.rawPermissions), data.active, data.employeeGroup, data.payRuleId,
      data.assignedVehicleId, data.usesOwnVehicle, data.hireDate, data.notes, data.showSchedule, data.showActualClockIn,
      data.showActualClockOut, data.showPayableHours, data.showPaymentAmount, data.showShiftKilometers,
      data.canChangeVehicle, now, now).run();
  await audit(env, request, actor, "employee_created", "user", id, null, { ...data, rawPermissions: data.rawPermissions }, text(body.reason, 500), pinUsed);
  return wfJson({ employee: publicUser({
    id, full_name: data.fullName, username: data.username, email: data.email, phone: data.phone,
    role: data.role, permissions: effectivePermissions(data.role, data.rawPermissions), active: data.active,
    employee_group: data.employeeGroup, pay_rule_id: data.payRuleId, assigned_vehicle_id: data.assignedVehicleId,
    uses_own_vehicle: data.usesOwnVehicle,
    hire_date: data.hireDate, notes: data.notes, show_schedule: data.showSchedule,
    show_actual_clock_in: data.showActualClockIn, show_actual_clock_out: data.showActualClockOut,
    show_payable_hours: data.showPayableHours, show_payment_amount: data.showPaymentAmount,
    show_shift_kilometers: data.showShiftKilometers, can_change_vehicle: data.canChangeVehicle
  }) }, 201);
}

async function updateEmployee(request, env, deps, id) {
  const actor = await authenticate(request, env, "employees.manage");
  const existing = await env.DB.prepare("SELECT * FROM app_users WHERE id = ?").bind(id).first();
  if (!existing) throw new ApiError(404, "Ο εργαζόμενος δεν βρέθηκε.");
  const body = await bodyJson(request);
  const data = employeeInput(body, existing);
  await validateEmployeeReferences(env, deps, data);
  const critical = data.role !== existing.role || JSON.stringify(data.rawPermissions) !== String(existing.permissions) ||
    data.active !== Number(existing.active) || data.assignedVehicleId !== existing.assigned_vehicle_id ||
    data.usesOwnVehicle !== Number(existing.uses_own_vehicle || 0) ||
    data.employeeGroup !== existing.employee_group || data.payRuleId !== existing.pay_rule_id ||
    data.canChangeVehicle !== Number(existing.can_change_vehicle) || data.showSchedule !== Number(existing.show_schedule) ||
    data.showActualClockIn !== Number(existing.show_actual_clock_in) || data.showActualClockOut !== Number(existing.show_actual_clock_out) ||
    data.showPayableHours !== Number(existing.show_payable_hours) || data.showPaymentAmount !== Number(existing.show_payment_amount) ||
    data.showShiftKilometers !== Number(existing.show_shift_kilometers);
  const pinUsed = critical ? await requirePin(request, env, deps, actor) : false;
  if (!data.fullName) throw new ApiError(400, "Γράψε το ονοματεπώνυμο.");
  await env.DB.prepare(`UPDATE app_users SET full_name=?, username=?, email=?, phone=?, role=?, permissions=?,
    active=?, employee_group=?, pay_rule_id=?, assigned_vehicle_id=?, uses_own_vehicle=?, hire_date=?, notes=?, show_schedule=?,
    show_actual_clock_in=?, show_actual_clock_out=?, show_payable_hours=?, show_payment_amount=?,
    show_shift_kilometers=?, can_change_vehicle=?, updated_at=? WHERE id=?`)
    .bind(data.fullName, data.username, data.email, data.phone, data.role, JSON.stringify(data.rawPermissions),
      data.active, data.employeeGroup, data.payRuleId, data.assignedVehicleId, data.usesOwnVehicle, data.hireDate, data.notes,
      data.showSchedule, data.showActualClockIn, data.showActualClockOut, data.showPayableHours,
      data.showPaymentAmount, data.showShiftKilometers, data.canChangeVehicle, nowIso(), id).run();
  if (!data.active) {
    const epoch = Math.floor(Date.now() / 1000);
    await env.DB.prepare("UPDATE auth_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL").bind(epoch, id).run();
  }
  await audit(env, request, actor, "employee_updated", "user", id, publicUser({ ...existing, permissions: effectivePermissions(existing.role, parseJson(existing.permissions, [])) }), data, text(body.reason, 500), pinUsed);
  return wfJson({ updated: true });
}

async function resetEmployeePassword(request, env, deps, id) {
  const actor = await authenticate(request, env, "security.manage");
  const pinUsed = await requirePin(request, env, deps, actor);
  const body = await bodyJson(request);
  validatePassword(body.password);
  const salt = randomToken(24);
  const hash = await passwordHash(body.password, salt);
  const epoch = Math.floor(Date.now() / 1000);
  const result = await env.DB.batch([
    env.DB.prepare("UPDATE app_users SET password_hash=?, password_salt=?, password_iterations=?, force_logout_after=?, updated_at=? WHERE id=?")
      .bind(hash, salt, PASSWORD_ITERATIONS, epoch, nowIso(), id),
    env.DB.prepare("UPDATE auth_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL").bind(epoch, id)
  ]);
  if (!Number(result[0]?.meta?.changes || 0)) throw new ApiError(404, "Ο χρήστης δεν βρέθηκε.");
  await audit(env, request, actor, "password_reset", "user", id, null, { reset: true }, text(body.reason, 500), pinUsed);
  return wfJson({ changed: true });
}

async function syncVehicleRegistry(env, deps) {
  const snapshot = await (deps.readFleetRegistry || deps.readSnapshot)(env);
  const bikes = snapshot?.data?.bikes || [];
  if (!bikes.length) return;
  // Include the alert-rule revision so an already synchronized snapshot is
  // re-evaluated once after a Worker upgrade that adds new fleet alerts.
  const snapshotVersion = deps.readFleetRegistry
    ? `${await sha256(JSON.stringify(bikes))}:${nowIso().slice(0,10)}:alerts-v5`
    : `${String(snapshot.version || 0)}:alerts-v4`;
  const synchronized = await env.DB.prepare("SELECT value FROM fleet_settings WHERE key='vehicle_registry_snapshot_version'").first();
  if (snapshotVersion !== "0" && String(synchronized?.value || "") === snapshotVersion) return;
  const now = nowIso();
  const statements = bikes.map((bike) => env.DB.prepare(`INSERT INTO vehicle_registry
    (bike_id, name, odometer, status, version, updated_at) VALUES (?, ?, ?, 'available', 1, ?)
    ON CONFLICT(bike_id) DO UPDATE SET name=excluded.name,
    odometer=MAX(vehicle_registry.odometer, excluded.odometer),
    version=CASE WHEN excluded.odometer > vehicle_registry.odometer THEN vehicle_registry.version + 1 ELSE vehicle_registry.version END,
    updated_at=CASE WHEN excluded.odometer > vehicle_registry.odometer OR excluded.name <> vehicle_registry.name THEN excluded.updated_at ELSE vehicle_registry.updated_at END`)
    .bind(String(bike.id), String(bike.name), integer(bike.currentKm, 0, 2_000_000_000, 0), now));
  for (let index = 0; index < statements.length; index += 80) await env.DB.batch(statements.slice(index, index + 80));
  for (const bike of bikes) {
    const current = Number(bike.currentKm || 0);
    const next = Number(bike.nextServiceKm || (Number(bike.lastServiceKm || 0) + Number(bike.intervalKm || 0)));
    const remaining = next - current;
    if (!next || remaining > 500) {
      await env.DB.prepare("UPDATE system_alerts SET resolved=1,resolved_at=? WHERE type='service_due' AND object_id=? AND resolved=0")
        .bind(now, String(bike.id)).run();
    } else {
      const key = `service:${bike.id}:${next}`;
      await env.DB.prepare("UPDATE system_alerts SET resolved=1,resolved_at=? WHERE type='service_due' AND object_id=? AND dedupe_key<>? AND resolved=0")
        .bind(now, String(bike.id), key).run();
      const title = remaining <= 0 ? "Το service έχει καθυστερήσει" : remaining <= 200 ? "Το service είναι πολύ κοντά" : "Το service πλησιάζει";
      const message = `${bike.name} • ${remaining <= 0 ? `${Math.abs(remaining)} χλμ. μετά το όριο` : `απομένουν ${remaining} χλμ.`}`;
      await createAlert(env, "service_due", remaining <= 0 ? "critical" : "warning", title, message, "vehicle", String(bike.id), key);
    }

    const majorTarget = integer(bike.majorServiceTargetKm, 0, 2_000_000_000, 0);
    const majorRemaining = majorTarget - current;
    // A major-service alert is possible only after the user has actually
    // recorded a major service. Older rounded/pending fields are ignored.
    const majorNeedsAttention = majorTarget > 0 && majorRemaining <= 500;
    if (!majorNeedsAttention) {
      await env.DB.prepare("UPDATE system_alerts SET resolved=1,resolved_at=? WHERE type='major_service_due' AND object_id=? AND resolved=0")
        .bind(now, String(bike.id)).run();
    } else {
      const majorKey = `major-service:${bike.id}:${majorTarget}`;
      await env.DB.prepare("UPDATE system_alerts SET resolved=1,resolved_at=? WHERE type='major_service_due' AND object_id=? AND dedupe_key<>? AND resolved=0")
        .bind(now, String(bike.id), majorKey).run();
      const majorTitle = majorRemaining <= 0 ? "Το μεγάλο service είναι εκπρόθεσμο" : "Πλησιάζει μεγάλο service";
      const majorMessage = `${bike.name} • ${majorRemaining <= 0 ? `${Math.abs(majorRemaining)} χλμ. μετά το όριο` : `απομένουν ${majorRemaining} χλμ.`} • κύκλος 10.000 χλμ. από τα ${integer(bike.lastMajorServiceKm, 0, 2_000_000_000, 0)} χλμ.`;
      await createAlert(env, "major_service_due", majorRemaining <= 0 ? "critical" : "warning",
        majorTitle, majorMessage, "vehicle", String(bike.id), majorKey);
    }

    const checkReference = String(bike.lastCheckedAt || bike.createdAt || "");
    const checkTime = Date.parse(checkReference);
    const checkAgeDays = Number.isFinite(checkTime)
      ? Math.floor(Math.max(0, Date.now() - checkTime) / 86400000)
      : 0;
    if (!Number.isFinite(checkTime) || checkAgeDays < MILEAGE_CHECK_STALE_DAYS) {
      await env.DB.prepare("UPDATE system_alerts SET resolved=1,resolved_at=? WHERE type='mileage_check_stale' AND object_id=? AND resolved=0")
        .bind(now, String(bike.id)).run();
    } else {
      const checkKey = `mileage-check:${bike.id}:${String(bike.lastCheckedAt || bike.createdAt || "never")}`;
      await env.DB.prepare("UPDATE system_alerts SET resolved=1,resolved_at=? WHERE type='mileage_check_stale' AND object_id=? AND dedupe_key<>? AND resolved=0")
        .bind(now, String(bike.id), checkKey).run();
      await createAlert(env, "mileage_check_stale", "warning", "Χρειάζεται έλεγχος χιλιομέτρων",
        `${bike.name} • τελευταίος έλεγχος πριν από ${checkAgeDays} ημέρες.`, "vehicle", String(bike.id), checkKey);
    }
  }
  await env.DB.prepare(`INSERT INTO fleet_settings (key,value,updated_at) VALUES ('vehicle_registry_snapshot_version',?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(snapshotVersion, now).run();
}

async function vehicles(request, env, deps) {
  const actor = await authenticate(request, env);
  if (!hasPermission(actor.permissions, "select_vehicle") && !hasPermission(actor.permissions, "fleet.view") && !hasPermission(actor.permissions, "fleet.manage")) {
    throw new ApiError(403, "Δεν έχεις δικαίωμα προβολής μηχανών.");
  }
  await syncVehicleRegistry(env, deps);
  const assigned = actor.assigned_vehicle_id || "";
  const restrictToAssigned = assigned && !bool(actor.can_change_vehicle) ? assigned : "";
  const rows = await env.DB.prepare(`SELECT bike_id, name, odometer, status, active_shift_id, version, updated_at
    FROM vehicle_registry
    WHERE (? = '' OR bike_id = ?)
      AND NOT EXISTS (SELECT 1 FROM vehicle_archives va WHERE va.bike_id = vehicle_registry.bike_id AND va.active = 1)
    ORDER BY name COLLATE NOCASE`).bind(restrictToAssigned, restrictToAssigned).all();
  const reservationRows = await env.DB.prepare(`SELECT DISTINCT vehicle_id FROM schedules
    WHERE vehicle_id IS NOT NULL AND status IN ('planned','awaiting') AND start_at < ? AND end_at > ?`)
    .bind(new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(), new Date(Date.now() - 30 * 60 * 1000).toISOString()).all();
  const reserved = new Set((reservationRows.results || []).map((row) => String(row.vehicle_id)));
  return wfJson({ vehicles: (rows.results || []).map((row) => {
    const displayStatus = row.status === "available" && reserved.has(String(row.bike_id)) ? "reserved" : row.status;
    return {
      id: row.bike_id, name: row.name, odometer: Number(row.odometer), status: displayStatus,
      available: row.status === "available" && !reserved.has(String(row.bike_id)),
      assigned: assigned === row.bike_id, updatedAt: row.updated_at
    };
  }) });
}

async function archivedVehicles(request, env) {
  await authenticate(request, env, "fleet.manage");
  const result = await env.DB.prepare(`SELECT va.bike_id, va.name, va.odometer, va.original_status,
      va.snapshot_json, va.archived_at, va.archived_by, va.reason, va.restored_at,
      va.restored_by, va.restore_reason, vr.version
    FROM vehicle_archives va
    LEFT JOIN vehicle_registry vr ON vr.bike_id = va.bike_id
    WHERE va.active = 1
    ORDER BY va.archived_at DESC, va.name COLLATE NOCASE`).all();
  return wfJson({ vehicles: (result.results || []).map((row) => ({
    id: row.bike_id,
    name: row.name,
    odometer: Number(row.odometer || 0),
    originalStatus: row.original_status || "available",
    archivedAt: row.archived_at,
    archivedBy: row.archived_by,
    reason: row.reason || "",
    version: Number(row.version || 0)
  })) });
}

function validVehicleStatus(value) {
  return ["available", "service", "inactive"].includes(String(value || "")) ? String(value) : "available";
}

function normalizeArchivedBike(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = text(value.id, 100);
  const name = text(value.name, 120);
  if (!id || !name) return null;
  const intervalKm = integer(value.intervalKm, 1, 2_000_000_000, 1);
  const lastServiceKm = integer(value.lastServiceKm, 0, 2_000_000_000, 0);
  const currentKm = Math.max(lastServiceKm, integer(value.currentKm, 0, 2_000_000_000, lastServiceKm));
  return {
    ...value,
    id,
    name,
    intervalKm,
    lastServiceKm,
    currentKm,
    nextServiceKm: lastServiceKm + intervalKm,
    history: Array.isArray(value.history) ? value.history.slice(0, 500) : []
  };
}

async function archiveVehicle(request, env, deps, vehicleId) {
  const actor = await authenticate(request, env, "fleet.manage");
  const pinUsed = await requirePin(request, env, deps, actor);
  const body = await bodyJson(request);
  if (body.confirmArchive !== true) throw new ApiError(400, "Χρειάζεται επιβεβαίωση αρχειοθέτησης.", "archive_confirmation_required");
  const id = text(vehicleId, 100);
  if (!id) throw new ApiError(400, "Το μηχανάκι δεν είναι έγκυρο.");
  await syncVehicleRegistry(env, deps);
  const vehicle = await env.DB.prepare("SELECT * FROM vehicle_registry WHERE bike_id=?").bind(id).first();
  if (!vehicle) throw new ApiError(404, "Το μηχανάκι δεν βρέθηκε.", "vehicle_not_found");
  const existing = await env.DB.prepare("SELECT active FROM vehicle_archives WHERE bike_id=?").bind(id).first();
  if (existing && Number(existing.active) === 1) throw new ApiError(409, "Το μηχανάκι βρίσκεται ήδη στα διαγραμμένα.", "vehicle_archived");
  if (vehicle.status === "in_use" || vehicle.active_shift_id) {
    throw new ApiError(409, "Δεν μπορεί να αρχειοθετηθεί μηχανάκι που χρησιμοποιείται σε ενεργή βάρδια.", "vehicle_in_use");
  }
  const assignment = await env.DB.prepare("SELECT COUNT(*) AS count FROM app_users WHERE active=1 AND assigned_vehicle_id=?").bind(id).first();
  if (Number(assignment?.count || 0) > 0) {
    throw new ApiError(409, "Αφαίρεσε πρώτα την μόνιμη ανάθεση του μηχανιού από τους εργαζομένους.", "vehicle_assigned");
  }
  const now = nowIso();
  const reason = text(body.reason, 500) || "Αρχειοθέτηση μηχανιού από το Fleet Control";
  const oldValue = {
    id,
    name: vehicle.name,
    odometer: Number(vehicle.odometer || 0),
    status: vehicle.status,
    activeShiftId: vehicle.active_shift_id || null
  };
  const snapshot = await deps.readSnapshot(env);
  const bike = (snapshot.data?.bikes || []).find((item) => String(item.id) === id);
  if (!bike) throw new ApiError(404, "Το μηχανάκι δεν βρέθηκε στο Fleet snapshot.", "vehicle_not_found");
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO vehicle_archives
      (bike_id,name,odometer,original_status,snapshot_json,archived_at,archived_by,reason,active,restored_at,restored_by,restore_reason)
      VALUES (?,?,?,?,?,?,?,?,1,NULL,NULL,NULL)
      ON CONFLICT(bike_id) DO UPDATE SET name=excluded.name,odometer=excluded.odometer,
      original_status=excluded.original_status,snapshot_json=excluded.snapshot_json,
      archived_at=excluded.archived_at,archived_by=excluded.archived_by,reason=excluded.reason,
      active=1,restored_at=NULL,restored_by=NULL,restore_reason=NULL`)
      .bind(id, String(bike.name || vehicle.name), integer(bike.currentKm, 0, 2_000_000_000, Number(vehicle.odometer || 0)), validVehicleStatus(vehicle.status), JSON.stringify(bike), now, String(actor.user_id || actor.id || ""), reason),
    env.DB.prepare(`UPDATE vehicle_registry SET status='inactive',active_shift_id=NULL,version=version+1,updated_at=?
      WHERE bike_id=? AND active_shift_id IS NULL`).bind(now, id)
  ]);
  const stored = await deps.writeSnapshot(env, { bikes: (snapshot.data.bikes || []).filter((item) => String(item.id) !== id) }, "vehicle-archived", snapshot.version + 1);
  await audit(env, request, actor, "vehicle_archived", "vehicle", id, oldValue,
    { id, name: String(bike.name || vehicle.name), archivedAt: now }, reason, pinUsed);
  return wfJson({ archived: true, id, version: stored.version, archivedAt: now });
}

async function restoreVehicle(request, env, deps, vehicleId) {
  const actor = await authenticate(request, env, "fleet.manage");
  const pinUsed = await requirePin(request, env, deps, actor);
  const body = await bodyJson(request);
  const id = text(vehicleId, 100);
  if (!id) throw new ApiError(400, "Το μηχανάκι δεν είναι έγκυρο.");
  const archive = await env.DB.prepare("SELECT * FROM vehicle_archives WHERE bike_id=? AND active=1").bind(id).first();
  if (!archive) throw new ApiError(404, "Δεν βρέθηκε ενεργό αντίγραφο για ανάκτηση.", "vehicle_archive_not_found");
  let bike;
  try { bike = normalizeArchivedBike(JSON.parse(archive.snapshot_json || "{}")); } catch {}
  if (!bike) throw new ApiError(409, "Το αποθηκευμένο αντίγραφο του μηχανιού δεν είναι έγκυρο.", "vehicle_archive_invalid");
  const now = nowIso();
  const reason = text(body.reason, 500) || "Ανάκτηση μηχανιού από τα διαγραμμένα";
  const current = await deps.readSnapshot(env);
  if ((current.data?.bikes || []).some((item) => String(item.id) === id)) {
    throw new ApiError(409, "Το μηχανάκι υπάρχει ήδη στον στόλο.", "vehicle_already_present");
  }
  if ((current.data?.bikes || []).length >= 40) {
    throw new ApiError(409, "Ο ενεργός στόλος έχει φτάσει το όριο των 40 μηχανιών.", "fleet_limit");
  }
  const oldValue = { id, archivedAt: archive.archived_at, name: archive.name };
  const archiveUpdate = await env.DB.prepare(`UPDATE vehicle_archives SET active=0,restored_at=?,restored_by=?,restore_reason=?
    WHERE bike_id=? AND active=1`).bind(now, String(actor.user_id || actor.id || ""), reason, id).run();
  if (!Number(archiveUpdate?.meta?.changes || 0)) throw new ApiError(409, "Η ανάκτηση ολοκληρώθηκε ήδη από άλλη συσκευή.", "vehicle_archive_changed");
  const restoredStatus = ["service"].includes(String(archive.original_status || "")) ? "service" : "available";
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO vehicle_registry (bike_id,name,odometer,status,active_shift_id,version,updated_at)
      VALUES (?,?,?,? ,NULL,1,?)
      ON CONFLICT(bike_id) DO UPDATE SET name=excluded.name,odometer=MAX(vehicle_registry.odometer,excluded.odometer),
      status=excluded.status,active_shift_id=NULL,version=vehicle_registry.version+1,updated_at=excluded.updated_at`)
      .bind(id, bike.name, integer(bike.currentKm, 0, 2_000_000_000, Number(archive.odometer || 0)), restoredStatus, now)
  ]);
  const stored = await deps.writeSnapshot(env, { bikes: [...(current.data?.bikes || []), bike] }, "vehicle-restored", current.version + 1);
  await audit(env, request, actor, "vehicle_restored", "vehicle", id, oldValue,
    { id, name: bike.name, restoredAt: now, status: restoredStatus }, reason, pinUsed);
  return wfJson({ restored: true, bike, version: stored.version, restoredAt: now });
}

async function updateVehicleStatus(request, env, deps, vehicleId) {
  const actor = await authenticate(request, env, "fleet.manage");
  const pinUsed = await requirePin(request, env, deps, actor);
  const body = await bodyJson(request);
  const status = ["available", "service", "inactive"].includes(body.status) ? body.status : "";
  const reason = text(body.reason, 500);
  if (!status || !reason) throw new ApiError(400, "Διάλεξε κατάσταση και γράψε αιτιολογία.");
  const vehicle = await env.DB.prepare("SELECT * FROM vehicle_registry WHERE bike_id=?").bind(vehicleId).first();
  if (!vehicle) throw new ApiError(404, "Το μηχανάκι δεν βρέθηκε.");
  const archived = await env.DB.prepare("SELECT active FROM vehicle_archives WHERE bike_id=? AND active=1").bind(vehicleId).first();
  if (archived) throw new ApiError(409, "Το μηχανάκι βρίσκεται στα διαγραμμένα. Ανάκτησέ το πρώτα.", "vehicle_archived");
  if (vehicle.status === "in_use" || vehicle.active_shift_id) {
    if (status === "service") {
      await createAlert(env, "service_conflict", "critical", "Service σε ενεργή βάρδια",
        `${vehicle.name} χρησιμοποιείται αυτή τη στιγμή. Η βάρδια δεν άλλαξε και χρειάζεται απόφαση Admin.`,
        "vehicle", vehicleId, `service-conflict:${vehicle.active_shift_id || vehicleId}`);
      await audit(env, request, actor, "vehicle_service_conflict", "vehicle", vehicleId,
        { status: vehicle.status, activeShiftId: vehicle.active_shift_id }, { requestedStatus: status }, reason, pinUsed);
      throw new ApiError(409, "Το μηχανάκι χρησιμοποιείται σε ενεργή βάρδια. Δημιουργήθηκε ειδοποίηση χωρίς να αλλάξει η βάρδια.", "service_conflict");
    }
    throw new ApiError(409, "Το μηχανάκι χρησιμοποιείται σε ενεργή βάρδια και η κατάστασή του δεν άλλαξε.", "vehicle_in_use");
  }
  await env.DB.prepare("UPDATE vehicle_registry SET status=?,version=version+1,updated_at=? WHERE bike_id=? AND active_shift_id IS NULL")
    .bind(status, nowIso(), vehicleId).run();
  await audit(env, request, actor, "vehicle_status_changed", "vehicle", vehicleId,
    { status: vehicle.status }, { status }, reason, pinUsed);
  return wfJson({ updated: true, status });
}

async function currentSchedule(env, employeeId, now) {
  const after = new Date(new Date(now).getTime() + 6 * 60 * 60 * 1000).toISOString();
  return env.DB.prepare(`SELECT * FROM schedules WHERE employee_id=? AND status IN ('planned','awaiting')
    AND start_at <= ? AND end_at >= ? ORDER BY ABS(strftime('%s', start_at) - strftime('%s', ?)) LIMIT 1`)
    .bind(employeeId, after, now, now).first();
}

async function activeShift(env, employeeId) {
  return env.DB.prepare(`SELECT s.*, v.name AS vehicle_name, v.odometer AS vehicle_odometer,
    sc.start_at AS scheduled_start, sc.end_at AS scheduled_end,
    COALESCE(vs.initial_km, s.initial_km) AS current_initial_km
    FROM shifts s LEFT JOIN vehicle_registry v ON v.bike_id=s.current_vehicle_id
    LEFT JOIN schedules sc ON sc.id=s.schedule_id
    LEFT JOIN vehicle_segments vs ON vs.shift_id=s.id AND vs.ended_at IS NULL
    WHERE s.employee_id=? AND s.status='active' LIMIT 1`).bind(employeeId).first();
}

async function resolvePayRule(env, user, shift) {
  // Pay-rule validity dates are entered as local calendar dates.  Using the
  // UTC date part here made a shift just after local midnight resolve against
  // the previous day's rule (for example 00:30 Europe/Athens).
  const timeZone = await setting(env, "timezone", DEFAULT_TIME_ZONE);
  const at = localDate(shift.actual_clock_in || nowIso(), timeZone);
  const directId = text(user.pay_rule_id, 100);
  const employeeId = text(user.user_id || user.id, 100);
  const groupId = text(user.employee_group, 100);
  // Rule precedence is unchanged (direct assignment, employee, shift, group,
  // general), but all candidates are selected in one indexed D1 query.
  const row = await env.DB.prepare(`SELECT * FROM pay_rules
    WHERE active=1 AND (valid_from IS NULL OR valid_from<=?) AND (valid_until IS NULL OR valid_until>=?)
      AND (id=? OR (scope_type='employee' AND scope_id=?) OR (scope_type='shift' AND scope_id=?)
        OR (scope_type='group' AND scope_id=?) OR (scope_type='general' AND scope_id=''))
    ORDER BY CASE WHEN id=? THEN 0 WHEN scope_type='employee' THEN 1 WHEN scope_type='shift' THEN 2
      WHEN scope_type='group' THEN 3 WHEN scope_type='general' THEN 4 ELSE 5 END,
      priority DESC, version DESC LIMIT 1`)
    .bind(at, at, directId, employeeId, shift.id, groupId, directId).first();
  if (row) return hydrateRule(env, row, user, shift);
  const fallback = await env.DB.prepare("SELECT * FROM pay_rules WHERE id='default-general'").first();
  return hydrateRule(env, fallback, user, shift);
}

async function hydrateRule(env, row, user, shift) {
  const special = await env.DB.prepare("SELECT * FROM special_rates WHERE pay_rule_id=? AND active=1 ORDER BY priority DESC").bind(row.id).all();
  const date = localDate(shift.actual_clock_in, await setting(env, "timezone", DEFAULT_TIME_ZONE));
  const qualified = [];
  for (const item of special.results || []) {
    let allowed = true;
    if (item.qualification === "scheduled") allowed = Boolean(shift.schedule_id);
    if (item.qualification === "manual") {
      const assignment = await env.DB.prepare("SELECT 1 FROM special_rate_assignments WHERE special_rate_id=? AND employee_id=? AND date=?")
        .bind(item.id, user.user_id || user.id, date).first();
      allowed = Boolean(assignment);
    }
    if (allowed && item.capacity != null && item.qualification !== "manual") {
      const employeeId = user.user_id || user.id;
      await env.DB.prepare(`INSERT OR IGNORE INTO special_rate_assignments
        (special_rate_id,employee_id,date,assigned_by,created_at)
        SELECT ?,?,?,?,? WHERE
          (SELECT COUNT(*) FROM special_rate_assignments WHERE special_rate_id=? AND date=?) < ?`)
        .bind(item.id, employeeId, date, "system-capacity", nowIso(), item.id, date, Number(item.capacity)).run();
      const claim = await env.DB.prepare("SELECT 1 FROM special_rate_assignments WHERE special_rate_id=? AND employee_id=? AND date=?")
        .bind(item.id, employeeId, date).first();
      allowed = Boolean(claim);
    }
    qualified.push({
      id: item.id, label: item.label, startTime: item.start_time, endTime: item.end_time,
      rateCents: Number(item.rate_cents), capacity: item.capacity == null ? null : Number(item.capacity),
      qualification: item.qualification, priority: Number(item.priority), qualified: allowed
    });
  }
  return {
    id: row.id,
    name: row.name,
    version: Number(row.version),
    normalRateCents: Number(row.normal_rate_cents),
    startRoundMode: row.start_round_mode,
    startRoundMinutes: Number(row.start_round_minutes),
    lateGraceMinutes: Number(row.late_grace_minutes || 0),
    lateClockOutGraceMinutes: Number(row.late_clock_out_grace_minutes == null ? 30 : row.late_clock_out_grace_minutes),
    endRoundMode: row.end_round_mode,
    endRoundMinutes: Number(row.end_round_minutes),
    durationRoundMode: "none",
    payableIncrementMinutes: 1,
    minimumMinutes: Number(row.minimum_minutes),
    maximumMinutes: Number(row.maximum_minutes),
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    special: qualified
  };
}

async function calculateShiftPay(env, user, shift, endAt, options = {}) {
  const rule = await resolvePayRule(env, user, shift);
  const breakdown = computePayBreakdown({
    actualStart: shift.actual_clock_in,
    actualEnd: endAt,
    scheduledStart: shift.scheduled_start || shift.scheduledStart || null,
    overtimeStart: options.overtimeStart || null,
    overtimeRateCents: options.overtimeRateCents === undefined ? null : options.overtimeRateCents,
    hardEndAt: options.hardEndAt || null,
    rule,
    specialWindows: rule.special,
    timeZone: await setting(env, "timezone", DEFAULT_TIME_ZONE)
  });
  return { rule, breakdown };
}

function clockOutTiming(shift, actualEnd, rule = {}) {
  const actualMs = new Date(actualEnd || "").getTime();
  const scheduledMs = new Date(shift?.scheduled_end || "").getTime();
  const overtimeMinutes = Number.isFinite(actualMs) && Number.isFinite(scheduledMs) && actualMs > scheduledMs
    ? Math.max(0, Math.round((actualMs - scheduledMs) / 60_000)) : 0;
  const graceMinutes = integer(rule?.lateClockOutGraceMinutes, 0, 720, 30);
  return {
    overtime: overtimeMinutes > 0,
    overtimeMinutes,
    graceMinutes,
    beyondGrace: overtimeMinutes > graceMinutes,
    hardEndAt: overtimeMinutes > 0 ? shift.scheduled_end : null
  };
}

function overtimeMessage(shift, actualEnd, timing, employeeName = "") {
  const employee = employeeName || shift?.full_name || shift?.employee_name || "Εργαζόμενος";
  const vehicle = shift?.vehicle_name || OWN_VEHICLE_LABEL;
  const scheduled = shift?.scheduled_end || "—";
  const actual = actualEnd || "—";
  const tolerance = timing?.graceMinutes ?? 30;
  const within = timing && !timing.beyondGrace ? ` Εντός ανοχής ${tolerance} λεπτών.` : "";
  return `${employee} • ${vehicle} • Προγραμματισμένο Clock Out ${scheduled} • Actual Clock Out ${actual} • Καθυστέρηση ${timing?.overtimeMinutes || 0} λεπτά.${within} Δεν πληρώνεται μετά την προγραμματισμένη λήξη χωρίς έγκριση.`;
}

function shiftPublic(row, viewer = null) {
  const own = viewer && String(viewer.user_id) === String(row.employee_id);
  const ownVehicle = isOwnVehicleShiftId(row.current_vehicle_id || row.vehicle_id);
  const admin = viewer && (hasPermission(viewer.permissions, "shifts.view") || hasPermission(viewer.permissions, "payroll.view"));
  const result = {
    id: row.id,
    employeeId: row.employee_id,
    employeeName: row.employee_name || row.full_name || (own ? viewer.full_name : ""),
    scheduleId: row.schedule_id || null,
    vehicleId: ownVehicle ? null : (row.current_vehicle_id || row.vehicle_id),
    vehicleName: ownVehicle ? OWN_VEHICLE_LABEL : (row.vehicle_name || ""),
    ownVehicle,
    status: row.status,
    outOfSchedule: bool(row.out_of_schedule),
    overtimeStatus: row.overtime_status,
    overtimeRateCents: row.overtime_rate_cents == null ? null : Number(row.overtime_rate_cents),
    overtimeMinutesOverride: row.overtime_minutes_override == null ? null : Number(row.overtime_minutes_override),
    overtimeApprovedBy: row.overtime_approved_by_name || row.overtime_approved_by || null,
    overtimeApprovedAt: row.overtime_approved_at || null,
    missingKm: ownVehicle ? false : bool(row.missing_km),
    scheduledStart: row.scheduled_start || null,
    scheduledEnd: row.scheduled_end || null
  };
  if (admin || own) result.notes = row.notes || "";
  if (admin || (own && bool(viewer.show_actual_clock_in))) result.actualClockIn = row.actual_clock_in;
  if (admin || (own && bool(viewer.show_actual_clock_out))) {
    result.actualClockOut = row.actual_clock_out || null;
    result.effectiveClockOut = row.effective_clock_out || null;
  }
  if (admin || (own && bool(viewer.show_payable_hours))) {
    result.payableClockIn = row.payable_clock_in || null;
    result.payableClockOut = row.payable_clock_out || null;
    result.payableHours = Math.round(Number(row.payable_minutes || 0) / 60 * 100) / 100;
  }
  if (admin || (own && bool(viewer.show_payment_amount))) result.paymentCents = Number(row.final_pay_cents || 0);
  if (!ownVehicle && (admin || (own && bool(viewer.show_shift_kilometers)))) {
    result.initialKm = Number(row.initial_km);
    result.finalKm = row.final_km == null ? null : Number(row.final_km);
    result.shiftKm = row.shift_km == null ? null : Number(row.shift_km);
  }
  return result;
}

async function runMaintenance(env) {
  const maintenanceNow = nowIso();
  await env.DB.batch([
    env.DB.prepare(`UPDATE schedules SET status='awaiting',updated_at=?
      WHERE status='planned' AND start_at<=? AND end_at>?`).bind(maintenanceNow, maintenanceNow, maintenanceNow),
    env.DB.prepare(`UPDATE schedules SET status='absent',updated_at=?
      WHERE status IN ('planned','awaiting') AND end_at<?
        AND NOT EXISTS(SELECT 1 FROM shifts WHERE shifts.schedule_id=schedules.id)`)
      .bind(maintenanceNow, maintenanceNow)
  ]);
  const active = await env.DB.prepare(`SELECT s.*, sc.start_at AS scheduled_start, sc.end_at AS scheduled_end, u.full_name, u.role,
    u.permissions, u.employee_group, u.pay_rule_id, u.uses_own_vehicle,
    CASE WHEN u.uses_own_vehicle=1 OR substr(s.current_vehicle_id,1,16)='__own_vehicle__:'
      THEN '${OWN_VEHICLE_LABEL}' ELSE v.name END AS vehicle_name
    FROM shifts s JOIN schedules sc ON sc.id=s.schedule_id
    JOIN app_users u ON u.id=s.employee_id LEFT JOIN vehicle_registry v ON v.bike_id=s.current_vehicle_id
    WHERE s.status='active' AND sc.end_at < ? ORDER BY sc.end_at LIMIT 50`).bind(nowIso()).all();
  const timeZone = await setting(env, "timezone", DEFAULT_TIME_ZONE);
  const fallbackHour = integer(await setting(env, "safety_fallback_hour", "5"), 0, 23, 5);
  for (const shift of active.results || []) {
    const user = { ...shift, user_id: shift.employee_id };
    const ruleForTiming = await resolvePayRule(env, user, shift);
    const timing = clockOutTiming(shift, maintenanceNow, ruleForTiming);
    // Give the configured delayed-Clock-Out tolerance to an employee who is
    // still active. The shift remains active and no forgotten-clock-out alert
    // is created until the tolerance has elapsed.
    if (timing.overtimeMinutes < timing.graceMinutes) continue;
    if (shift.overtime_status === "none") {
      await env.DB.prepare("UPDATE shifts SET overtime_status='pending',updated_at=? WHERE id=? AND status='active' AND overtime_status='none'")
        .bind(maintenanceNow, shift.id).run();
      shift.overtime_status = "pending";
    }
    if (shift.overtime_status === "approved") continue;
    const message = overtimeMessage(shift, null, timing, shift.full_name);
    await createAlert(env, "overtime", "warning", "Έγκριση υπερωρίας / καθυστερημένο Clock Out", message, "shift", shift.id, `overtime:${shift.id}`);
    await createAlert(env, "forgotten_clock_out", "warning", "Ξεχασμένο Clock Out", message, "shift", shift.id, `forgotten:${shift.id}`);
    const fallback = safetyFallbackAt(shift.scheduled_end, timeZone, fallbackHour);
    if (Date.now() < new Date(fallback).getTime()) continue;
    const { rule, breakdown } = await calculateShiftPay(env, user, shift, shift.scheduled_end, { hardEndAt: shift.scheduled_end });
    const closedAt = nowIso();
    const ownVehicle = isOwnVehicleShiftId(shift.current_vehicle_id || shift.vehicle_id);
    const nextStatus = ownVehicle ? "pending_overtime" : "pending_km";
    const statements = [
      env.DB.prepare(`UPDATE shifts SET status=?, effective_clock_out=?, automatic_closed_at=?,
        payable_clock_in=?, payable_clock_out=?, payable_minutes=?, rule_id=?, rule_version=?, rule_snapshot=?,
        base_pay_cents=?, special_pay_cents=?, final_pay_cents=?, missing_km=?, updated_at=?
        WHERE id=? AND status='active'`)
        .bind(nextStatus, shift.scheduled_end, closedAt, breakdown.payableStart, breakdown.payableEnd, breakdown.payableMinutes,
          rule.id, rule.version, JSON.stringify(rule), breakdown.basePayCents, breakdown.specialPayCents,
          breakdown.totalPayCents, ownVehicle ? 0 : 1, closedAt, shift.id),
      env.DB.prepare("UPDATE schedules SET status='pending_correction', updated_at=? WHERE id=?").bind(closedAt, shift.schedule_id),
      ...breakdown.segments.map((segment) => env.DB.prepare(`INSERT INTO payroll_segments
        (id, shift_id, special_rate_id, label, start_at, end_at, minutes, rate_cents, amount_cents)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(uuid(), shift.id, segment.specialRateId, segment.label, segment.start, segment.end,
          segment.minutes, segment.rateCents, segment.amountCents))
    ];
    if (!ownVehicle) {
      statements.push(
        env.DB.prepare("UPDATE vehicle_registry SET status='available', active_shift_id=NULL, version=version+1, updated_at=? WHERE bike_id=? AND active_shift_id=?")
          .bind(closedAt, shift.current_vehicle_id, shift.id),
        env.DB.prepare("UPDATE vehicle_segments SET ended_at=?, changed_by='system', reason='Αυτόματο κλείσιμο ασφαλείας' WHERE shift_id=? AND ended_at IS NULL")
          .bind(shift.scheduled_end, shift.id)
      );
    }
    const result = await env.DB.batch(statements);
    if (Number(result[0]?.meta?.changes || 0)) {
      await createAlert(env, "auto_close", "info", "Αυτόματο κλείσιμο ασφαλείας", `${shift.full_name} • Effective Clock Out ${shift.scheduled_end}.`, "shift", shift.id, `auto-close:${shift.id}`);
      if (!ownVehicle) await createAlert(env, "missing_km", "critical", "Εκκρεμούν χιλιόμετρα", `${shift.full_name} • ${shift.vehicle_name}. Δεν ενημερώθηκε το official odometer.`, "shift", shift.id, `missing-km:${shift.id}`);
      await audit(env, new Request("https://system.local"), null, "shift_auto_closed", "shift", shift.id, { status: "active" }, { status: nextStatus, effectiveClockOut: shift.scheduled_end, automaticClosedAt: closedAt, ownVehicle }, "System automatic closure", false);
    }
  }
}

export async function maintainWorkforce(env, systemState = {}, deps = {}) {
  await runMaintenance(env);
  if (typeof deps.readSnapshot === "function") await syncVehicleRegistry(env, deps);
  const now = nowIso();
  const serverSeen = systemState.serverLastSeen ? new Date(systemState.serverLastSeen).getTime() : 0;
  const serverOffline = !serverSeen || Date.now() - serverSeen > SERVER_HEARTBEAT_GRACE_MS;
  if (serverOffline) {
    await createAlert(env, "server_offline", "warning", "Η εφαρμογή Server είναι offline",
      "Το Cloudflare/D1 συνεχίζει να εξυπηρετεί τις εφαρμογές. Έλεγξε τον Server S24 Ultra.",
      "server", "android-server", "server-offline");
  } else {
    await env.DB.prepare(`UPDATE system_alerts SET resolved=1,resolved_at=?
      WHERE type='server_offline' AND object_id='android-server' AND resolved=0`).bind(now).run();
  }
  const backupResult = String(systemState.backupResult || "");
  const backupFailed = backupResult && !/^Επιτυχία/i.test(backupResult);
  if (backupFailed) {
    await createAlert(env, "backup_failed", "critical", "Αποτυχία backup", backupResult,
      "backup", "google-drive", `backup-failed:${backupResult.slice(0, 100)}`);
  } else if (backupResult) {
    await env.DB.prepare("UPDATE system_alerts SET resolved=1,resolved_at=? WHERE type='backup_failed' AND resolved=0")
      .bind(now).run();
  }
}

async function dashboard(request, env) {
  const actor = await authenticate(request, env, "dashboard.view");
  const timeZone = await setting(env, "timezone", DEFAULT_TIME_ZONE);
  const today = localDate(Date.now(), timeZone);
  const period = mondayPeriod(Date.now(), timeZone);
  const periodBounds = {
    start: scheduleInterval(period.startDate, "00:00", "00:01", timeZone).start,
    end: scheduleInterval(addCalendarDays(period.endDate, 1), "00:00", "00:01", timeZone).start
  };
  const now = nowIso();
  const dayStart = scheduleInterval(today, "00:00", "00:01", timeZone).start;
  const dayEnd = scheduleInterval(addCalendarDays(today, 1), "00:00", "00:01", timeZone).start;
  const [employees, active, vehicles, alerts, week, backup, realtime, daily, missed] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM app_users WHERE active=1 AND role='employee'").first(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM shifts WHERE status='active'").first(),
    env.DB.prepare("SELECT status, COUNT(*) AS count FROM vehicle_registry GROUP BY status").all(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM system_alerts WHERE resolved=0").first(),
    env.DB.prepare(`SELECT COALESCE(SUM(payable_minutes),0) AS minutes, COALESCE(SUM(final_pay_cents),0) AS pay,
      COALESCE(SUM(shift_km),0) AS km FROM shifts WHERE actual_clock_in>=? AND actual_clock_in<? AND status IN ('completed','pending_overtime','pending_km')`)
      .bind(periodBounds.start, periodBounds.end).first(),
    env.DB.prepare("SELECT value FROM fleet_settings WHERE key='server_last_backup'").first(),
    env.DB.prepare(`SELECT s.id, s.employee_id, s.schedule_id, u.full_name AS employee_name,
      s.current_vehicle_id, CASE WHEN u.uses_own_vehicle=1 OR substr(s.current_vehicle_id,1,16)='__own_vehicle__:'
        THEN '${OWN_VEHICLE_LABEL}' ELSE v.name END AS vehicle_name,
      s.actual_clock_in, s.status, s.out_of_schedule
      FROM shifts s JOIN app_users u ON u.id=s.employee_id LEFT JOIN vehicle_registry v ON v.bike_id=s.current_vehicle_id
      WHERE s.status='active' ORDER BY s.actual_clock_in`).all(),
    env.DB.prepare(`SELECT sc.*, u.full_name AS employee_name,
      CASE WHEN u.uses_own_vehicle=1 THEN '${OWN_VEHICLE_LABEL}' ELSE v.name END AS vehicle_name
      FROM schedules sc JOIN app_users u ON u.id=sc.employee_id LEFT JOIN vehicle_registry v ON v.bike_id=sc.vehicle_id
      WHERE sc.start_at>=? AND sc.start_at<? AND sc.status<>'cancelled' ORDER BY sc.start_at`).bind(dayStart, dayEnd).all(),
    env.DB.prepare(`SELECT sc.id,sc.employee_id,u.full_name AS employee_name,sc.start_at,sc.end_at,sc.status
      FROM schedules sc JOIN app_users u ON u.id=sc.employee_id
      WHERE sc.start_at>=? AND sc.start_at<? AND sc.start_at<=?
        AND sc.status IN ('planned','awaiting','absent')
        AND NOT EXISTS (
          SELECT 1 FROM shifts sh WHERE sh.employee_id=sc.employee_id AND sh.status<>'cancelled'
            AND sh.actual_clock_in<sc.end_at AND COALESCE(sh.actual_clock_out,sh.effective_clock_out,?)>sc.start_at
        )
      ORDER BY sc.start_at,u.full_name COLLATE NOCASE`).bind(dayStart, dayEnd, now, now).all()
  ]);
  const vehicleCounts = { available: 0, in_use: 0, reserved: 0, service: 0, inactive: 0 };
  (vehicles.results || []).forEach((row) => { vehicleCounts[row.status] = Number(row.count); });
  const missedRows = missed.results || [];
  const missedEmployees = new Set(missedRows.map((row) => String(row.employee_id)));
  return wfJson({
    user: publicUser(actor), today: {
      employees: Number(employees?.count || 0),
      workingNow: Number(active?.count || 0),
      missedClockIns: missedEmployees.size,
      vehicles: vehicleCounts
    },
    currentWeek: { ...period, payableHours: Math.round(Number(week?.minutes || 0) / 60 * 100) / 100, payrollCents: Number(week?.pay || 0), kilometers: Number(week?.km || 0) },
    actionCount: Number(alerts?.count || 0), realtime: realtime.results || [], dailySchedule: daily.results || [],
    missedClockIns: missedRows, lastBackup: backup?.value || null
  });
}

function coverageInstant(workDate, operationalMinute, timeZone) {
  const dayOffset = Math.floor(operationalMinute / 1440);
  const minute = ((operationalMinute % 1440) + 1440) % 1440;
  const clock = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  const date = addCalendarDays(workDate, dayOffset);
  const endMinute = (minute + 1) % 1440;
  const endClock = `${String(Math.floor(endMinute / 60)).padStart(2, "0")}:${String(endMinute % 60).padStart(2, "0")}`;
  return scheduleInterval(date, clock, endClock, timeZone).start;
}

function coverageNames(rows, startAt, endAt, idKey, nameKey, endKey) {
  const names = new Map();
  rows.forEach((row) => {
    const rowEnd = String(row[endKey] || "");
    if (String(row.start_at || row.actual_clock_in || "") < endAt && rowEnd > startAt) {
      names.set(String(row[idKey] || row[nameKey] || names.size), String(row[nameKey] || "—"));
    }
  });
  return [...names.values()].sort((a, b) => a.localeCompare(b, "el")).slice(0, 30);
}

async function staffingCoverage(request, env) {
  await authenticate(request, env, "schedules.view");
  const url = new URL(request.url);
  const timeZone = await setting(env, "timezone", DEFAULT_TIME_ZONE);
  const requested = text(url.searchParams.get("week"), 10) || localDate(Date.now(), timeZone);
  const weekStart = mondayForDate(requested);
  const weekEnd = addCalendarDays(weekStart, 6);
  const rangeStart = coverageInstant(weekStart, 6 * 60, timeZone);
  const rangeEnd = coverageInstant(weekEnd, 27 * 60, timeZone);
  const [plannedResult, actualResult] = await Promise.all([
    env.DB.prepare(`SELECT sc.employee_id,u.full_name AS employee_name,sc.start_at,sc.end_at
      FROM schedules sc JOIN app_users u ON u.id=sc.employee_id
      WHERE sc.status<>'cancelled' AND sc.start_at<? AND sc.end_at>? ORDER BY sc.start_at`)
      .bind(rangeEnd, rangeStart).all(),
    env.DB.prepare(`SELECT sh.employee_id,u.full_name AS employee_name,sh.actual_clock_in AS start_at,
      COALESCE(sh.actual_clock_out,sh.effective_clock_out,?) AS actual_end
      FROM shifts sh JOIN app_users u ON u.id=sh.employee_id
      WHERE sh.status<>'cancelled' AND sh.actual_clock_in<?
        AND COALESCE(sh.actual_clock_out,sh.effective_clock_out,?)>? ORDER BY sh.actual_clock_in`)
      .bind(nowIso(), rangeEnd, nowIso(), rangeStart).all()
  ]);
  const plannedRows = plannedResult.results || [];
  const actualRows = actualResult.results || [];
  const days = [];
  let plannedSlots = 0;
  let coveredSlots = 0;
  let undercoveredSlots = 0;
  let overcoveredSlots = 0;
  let upcomingSlots = 0;
  const nowMs = Date.now();
  for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
    const date = addCalendarDays(weekStart, dayIndex);
    const buckets = [];
    let dayPlanned = 0;
    let dayActual = 0;
    for (let minute = 6 * 60; minute < 27 * 60; minute += 30) {
      const startAt = coverageInstant(date, minute, timeZone);
      const endAt = coverageInstant(date, minute + 30, timeZone);
      const planned = coverageNames(plannedRows, startAt, endAt, "employee_id", "employee_name", "end_at");
      const actual = coverageNames(actualRows, startAt, endAt, "employee_id", "employee_name", "actual_end");
      const elapsed = new Date(endAt).getTime() <= nowMs;
      const status = coverageBucketStatus(planned.length, actual.length, endAt, nowMs);
      if (!elapsed && planned.length) upcomingSlots += 1;
      if (elapsed && planned.length) {
        plannedSlots += 1;
        if (actual.length >= planned.length) coveredSlots += 1;
      }
      if (elapsed && status === "under") undercoveredSlots += 1;
      if (elapsed && status === "over") overcoveredSlots += 1;
      dayPlanned += planned.length;
      dayActual += actual.length;
      const displayMinute = minute % 1440;
      buckets.push({
        time: `${String(Math.floor(displayMinute / 60)).padStart(2, "0")}:${String(displayMinute % 60).padStart(2, "0")}`,
        nextDay: minute >= 1440,
        planned: planned.length,
        actual: actual.length,
        plannedEmployees: planned,
        actualEmployees: actual,
        status
      });
    }
    days.push({ date, plannedUnits: dayPlanned, actualUnits: dayActual, buckets });
  }
  return wfJson({
    weekStart,
    weekEnd,
    intervalMinutes: 30,
    operationalStart: "06:00",
    operationalEnd: "03:00",
    summary: {
      plannedSlots,
      coveredSlots,
      undercoveredSlots,
      overcoveredSlots,
      upcomingSlots,
      coveragePercent: plannedSlots ? Math.round(coveredSlots / plannedSlots * 100) : 100
    },
    days
  });
}

async function serverDeviceHealth(request, env) {
  const actor = await authenticate(request, env);
  if (!hasPermission(actor.permissions, "server.manage") && !hasPermission(actor.permissions, "backup.manage")) {
    throw new ApiError(403, "Δεν έχεις δικαίωμα προβολής της συσκευής Server.", "forbidden");
  }
  const rows = await env.DB.prepare(`SELECT key,value,updated_at FROM fleet_settings
    WHERE key IN ('server_health_json','server_last_seen','server_last_backup','server_backup_result','server_version')`).all();
  const values = {};
  (rows.results || []).forEach((row) => { values[row.key] = { value: row.value, updatedAt: row.updated_at }; });
  let health = {};
  try { health = JSON.parse(values.server_health_json?.value || "{}"); } catch {}
  if (!health || typeof health !== "object" || Array.isArray(health)) health = {};
  const battery = Number(health.batteryPercent);
  const temperature = Number(health.batteryTemperatureC);
  const freeBytes = Number(health.storageFreeBytes);
  const totalBytes = Number(health.storageTotalBytes);
  const freePercent = totalBytes > 0 ? Math.round(freeBytes / totalBytes * 1000) / 10 : null;
  const lastSeen = values.server_last_seen?.value || null;
  const lastSeenAgeMs = lastSeen ? Date.now() - new Date(lastSeen).getTime() : Number.POSITIVE_INFINITY;
  const warnings = [];
  if (!(lastSeenAgeMs >= 0 && lastSeenAgeMs < SERVER_HEARTBEAT_GRACE_MS)) warnings.push({ code: "offline", severity: "critical", message: "Η εφαρμογή Server δεν έχει επικοινωνήσει πρόσφατα." });
  if (Number.isFinite(temperature) && temperature >= 42) warnings.push({ code: "temperature", severity: "critical", message: `Υψηλή θερμοκρασία μπαταρίας (${temperature.toFixed(1)} °C).` });
  if (Number.isFinite(freePercent) && freePercent <= 10) warnings.push({ code: "storage", severity: "critical", message: `Απομένει μόνο ${freePercent}% ελεύθερος χώρος.` });
  if (Number.isFinite(battery) && battery <= 15 && !bool(health.batteryCharging)) warnings.push({ code: "battery", severity: "warning", message: `Η μπαταρία είναι στο ${Math.round(battery)}% και δεν φορτίζει.` });
  if (health.ignoringBatteryOptimizations === false) warnings.push({ code: "optimization", severity: "warning", message: "Το Android μπορεί να περιορίσει τον Server. Ενεργοποίησε την εξαίρεση μπαταρίας." });
  if (bool(health.powerSaveMode)) warnings.push({ code: "power_save", severity: "warning", message: "Η εξοικονόμηση ενέργειας είναι ενεργή." });
  return wfJson({
    online: lastSeenAgeMs >= 0 && lastSeenAgeMs < SERVER_HEARTBEAT_GRACE_MS,
    lastSeen,
    lastBackup: values.server_last_backup?.value || null,
    backupResult: values.server_backup_result?.value || "",
    serverVersion: values.server_version?.value || health.serverVersion || "",
    health: { ...health, storageFreePercent: freePercent },
    warnings
  });
}

async function employeeHome(request, env, deps) {
  const actor = await authenticate(request, env, "clock_in_out");
  const now = nowIso();
  const ownVehicle = bool(actor.uses_own_vehicle);
  const showSchedule = bool(actor.show_schedule);
  // The own-vehicle path never reads or updates the fleet registry. Keep the
  // registry refresh for fleet employees, but overlap it with the independent
  // schedule/timezone reads so the home screen starts with one I/O wave.
  const registrySync = ownVehicle ? Promise.resolve() : syncVehicleRegistry(env, deps);
  const [schedule, timeZone] = await Promise.all([
    showSchedule ? currentSchedule(env, actor.user_id, now) : Promise.resolve(null),
    setting(env, "timezone", DEFAULT_TIME_ZONE),
    registrySync
  ]);
  // Read the active shift after the registry refresh has settled so its
  // vehicle name/odometer is never taken from the pre-sync state.
  const shift = await activeShift(env, actor.user_id);
  const employeeWeekStart = mondayForDate(localDate(Date.now(), timeZone));
  const employeeWeekBounds = {
    start: scheduleInterval(employeeWeekStart, "00:00", "00:01", timeZone).start,
    end: scheduleInterval(addCalendarDays(employeeWeekStart, 7), "00:00", "00:01", timeZone).start
  };
  const assigned = schedule?.vehicle_id || actor.assigned_vehicle_id || "";
  const reservationEnd = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const reservationStart = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const weeklyRowsPromise = showSchedule ? env.DB.prepare(`SELECT sc.id,sc.start_at,sc.end_at,sc.status,sc.vehicle_id,
    CASE WHEN u.uses_own_vehicle=1 THEN '${OWN_VEHICLE_LABEL}' ELSE v.name END AS vehicle_name
    FROM schedules sc JOIN app_users u ON u.id=sc.employee_id LEFT JOIN vehicle_registry v ON v.bike_id=sc.vehicle_id
    WHERE sc.employee_id=? AND sc.start_at>=? AND sc.start_at<? AND sc.status NOT IN ('cancelled') ORDER BY sc.start_at`)
    .bind(actor.user_id, employeeWeekBounds.start, employeeWeekBounds.end).all() : Promise.resolve({ results: [] });
  const publicationPromise = showSchedule ? schedulePublication(env, employeeWeekStart) : Promise.resolve(null);
  const availablePromise = !shift && !ownVehicle ? env.DB.prepare(`SELECT bike_id, name, odometer, status FROM vehicle_registry vr
      WHERE status='available' AND (?='' OR bike_id=?) AND NOT EXISTS(
        SELECT 1 FROM schedules sc WHERE sc.vehicle_id=vr.bike_id AND sc.employee_id<>?
          AND sc.status IN ('planned','awaiting') AND sc.start_at < ? AND sc.end_at > ?
      ) ORDER BY name COLLATE NOCASE`).bind(assigned, assigned, actor.user_id, reservationEnd, reservationStart).all() : Promise.resolve({ results: [] });
  const [employeePublication, weeklyRows, availableRows] = await Promise.all([publicationPromise, weeklyRowsPromise, availablePromise]);
  const employeeAck = employeePublication ? await env.DB.prepare("SELECT acknowledged_at FROM schedule_acknowledgements WHERE week_start=? AND revision=? AND employee_id=?")
    .bind(employeeWeekStart, Number(employeePublication.revision || 0), actor.user_id).first() : null;
  let available = [];
  if (!shift && !ownVehicle) {
    // A bike assigned to this specific shift is authoritative.  The permanent
    // employee assignment is only a fallback suggestion when the schedule has
    // no digital bike yet.
    available = (availableRows.results || []).map((row) => ({ id: row.bike_id, name: row.name, odometer: Number(row.odometer), status: row.status, assigned: Boolean(assigned) }));
  }
  return wfJson({
    user: publicUser(actor),
    activeShift: shift ? {
      ...shiftPublic(shift, actor),
      actualClockIn: shift.actual_clock_in,
      ...(isOwnVehicleShiftId(shift.current_vehicle_id || shift.vehicle_id) ? {} : { initialKm: Number(shift.current_initial_km ?? shift.initial_km) })
    } : null,
    schedule: schedule ? { id: schedule.id, startAt: schedule.start_at, endAt: schedule.end_at, vehicleId: ownVehicle ? null : (schedule.vehicle_id || null), status: schedule.status } : null,
    scheduleWeek: showSchedule ? {
      weekStart: employeeWeekStart, weekEnd: addCalendarDays(employeeWeekStart, 6), revision: employeePublication ? Number(employeePublication.revision || 0) : null,
      acknowledged: Boolean(employeeAck), entries: (weeklyRows.results || []).map((row) => ({ id: row.id, startAt: row.start_at, endAt: row.end_at, status: row.status, vehicleId: ownVehicle ? null : (row.vehicle_id || null), vehicleName: ownVehicle ? OWN_VEHICLE_LABEL : (row.vehicle_name || "") }))
    } : null,
    vehicles: available
  });
}

async function idempotentResponse(request, env, actor, action) {
  const key = text(request.headers.get("x-idempotency-key"), 120);
  if (!key) return null;
  const id = await sha256(`${actor.user_id}:${action}:${key}`);
  const row = await env.DB.prepare("SELECT response FROM idempotency_keys WHERE id=? AND user_id=? AND action=?").bind(id, actor.user_id, action).first();
  return row ? { id, payload: parseJson(row.response, {}) } : { id, payload: null };
}

async function saveIdempotent(env, item, actor, action, payload) {
  if (!item?.id) return;
  await env.DB.prepare("INSERT OR IGNORE INTO idempotency_keys (id,user_id,action,response,created_at) VALUES (?,?,?,?,?)")
    .bind(item.id, actor.user_id, action, JSON.stringify(payload), nowIso()).run();
}

async function clockIn(request, env, deps) {
  const actor = await authenticate(request, env, "clock_in_out");
  const replay = await idempotentResponse(request, env, actor, "clock_in");
  if (replay?.payload) return wfJson(replay.payload);
  const now = nowIso();
  // These checks are independent. Running them together removes two network
  // round trips from the most frequent employee action.
  const [existingShift, schedule, policy] = await Promise.all([
    activeShift(env, actor.user_id),
    currentSchedule(env, actor.user_id, now),
    setting(env, "no_schedule_policy", "allow_warning")
  ]);
  if (existingShift) throw new ApiError(409, "Έχεις ήδη ενεργή βάρδια.", "shift_exists");
  if (!schedule && policy === "block") throw new ApiError(409, "Δεν υπάρχει προγραμματισμένη βάρδια αυτή την ώρα.", "outside_schedule");
  if (bool(actor.uses_own_vehicle)) {
    const shiftId = uuid();
    const ownVehicleId = ownVehicleShiftId(actor.user_id);
    const outOfSchedule = schedule ? 0 : 1;
    const statements = [
      env.DB.prepare(`INSERT INTO shifts
        (id, employee_id, schedule_id, vehicle_id, current_vehicle_id, status, actual_clock_in,
         initial_km, out_of_schedule, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, 0, ?, ?, ?)`)
        .bind(shiftId, actor.user_id, schedule?.id || null, ownVehicleId, ownVehicleId, now, outOfSchedule, now, now),
      ...(schedule ? [env.DB.prepare("UPDATE schedules SET status='working',updated_at=? WHERE id=?").bind(now, schedule.id)] : [])
    ];
    const result = await env.DB.batch(statements);
    if (!Number(result[0]?.meta?.changes || 0)) throw new ApiError(409, "Έχεις ήδη ενεργή βάρδια.", "shift_exists");
    if (outOfSchedule && policy === "allow_warning") {
      await createAlert(env, "out_of_schedule", "warning", "Clock In εκτός προγράμματος", `${actor.full_name} • ${OWN_VEHICLE_LABEL}`, "shift", shiftId, `out-of-schedule:${shiftId}`);
    }
    await audit(env, request, actor, "clock_in", "shift", shiftId, null, {
      actualClockIn: now, ownVehicle: true, scheduleId: schedule?.id || null, outOfSchedule: Boolean(outOfSchedule)
    }, "", false);
    const payload = {
      success: true,
      shift: {
        id: shiftId, status: "active", vehicleId: null, vehicleName: OWN_VEHICLE_LABEL,
        ownVehicle: true, actualClockIn: now, outOfSchedule: Boolean(outOfSchedule)
      }
    };
    await saveIdempotent(env, replay, actor, "clock_in", payload);
    return wfJson(payload, 201);
  }
  const body = await bodyJson(request);
  // Fleet employees still get the authoritative registry refresh before the
  // vehicle is read/reserved. The own-vehicle branch above never needs it.
  await syncVehicleRegistry(env, deps);
  const assigned = schedule?.vehicle_id || actor.assigned_vehicle_id || "";
  const requestedVehicle = text(body.vehicleId, 100);
  const vehicleId = assigned || requestedVehicle;
  if (!vehicleId) throw new ApiError(400, "Διάλεξε μηχανάκι.");
  if (assigned && requestedVehicle && requestedVehicle !== assigned) throw new ApiError(403, "Μπορείς να χρησιμοποιήσεις μόνο το ανατεθειμένο μηχανάκι.");
  const vehicle = await env.DB.prepare("SELECT * FROM vehicle_registry WHERE bike_id=?").bind(vehicleId).first();
  if (!vehicle) throw new ApiError(404, "Το μηχανάκι δεν βρέθηκε.");
  if (vehicle.status !== "available") throw new ApiError(409, "Το μηχανάκι μόλις δεσμεύτηκε από άλλο χρήστη.", "vehicle_taken");
  if (!assigned && !hasPermission(actor.permissions, "select_vehicle")) throw new ApiError(403, "Δεν έχεις δικαίωμα επιλογής μηχανής.");
  if (!assigned) {
    const conflict = await env.DB.prepare(`SELECT 1 FROM schedules WHERE vehicle_id=? AND employee_id<>?
      AND status IN ('planned','awaiting') AND start_at < ? AND end_at > ? LIMIT 1`)
      .bind(vehicleId, actor.user_id, new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(), new Date(Date.now() - 30 * 60 * 1000).toISOString()).first();
    if (conflict) throw new ApiError(409, "Το μηχανάκι είναι δεσμευμένο για άλλη προγραμματισμένη βάρδια.", "vehicle_reserved");
  }
  const shiftId = uuid();
  const segmentId = uuid();
  const outOfSchedule = schedule ? 0 : 1;
  const result = await env.DB.batch([
    env.DB.prepare(`INSERT INTO shifts
      (id, employee_id, schedule_id, vehicle_id, current_vehicle_id, status, actual_clock_in,
       initial_km, out_of_schedule, created_at, updated_at)
      SELECT ?, ?, ?, bike_id, bike_id, 'active', ?, odometer, ?, ?, ?
      FROM vehicle_registry WHERE bike_id=? AND status='available'`)
      .bind(shiftId, actor.user_id, schedule?.id || null, now, outOfSchedule, now, now, vehicleId),
    env.DB.prepare("UPDATE vehicle_registry SET status='in_use', active_shift_id=?, version=version+1, updated_at=? WHERE bike_id=? AND status='available'")
      .bind(shiftId, now, vehicleId),
    env.DB.prepare(`INSERT INTO vehicle_segments (id,shift_id,vehicle_id,started_at,initial_km,changed_by,reason)
      SELECT ?,id,current_vehicle_id,?,initial_km,?,? FROM shifts WHERE id=?`)
      .bind(segmentId, now, actor.user_id, "Clock In", shiftId),
    ...(schedule ? [env.DB.prepare("UPDATE schedules SET status='working',updated_at=? WHERE id=?").bind(now, schedule.id)] : [])
  ]);
  if (!Number(result[0]?.meta?.changes || 0)) throw new ApiError(409, "Το μηχανάκι μόλις δεσμεύτηκε από άλλο χρήστη.", "vehicle_taken");
  if (outOfSchedule && policy === "allow_warning") {
    await createAlert(env, "out_of_schedule", "warning", "Clock In εκτός προγράμματος", `${actor.full_name} • ${vehicle.name}`, "shift", shiftId, `out-of-schedule:${shiftId}`);
  }
  await audit(env, request, actor, "clock_in", "shift", shiftId, null, {
    actualClockIn: now, vehicleId, initialKm: Number(vehicle.odometer), scheduleId: schedule?.id || null, outOfSchedule: Boolean(outOfSchedule)
  }, "", false);
  const payload = {
    success: true,
    shift: {
      id: shiftId, status: "active", vehicleId, vehicleName: vehicle.name,
      actualClockIn: now, initialKm: Number(vehicle.odometer), outOfSchedule: Boolean(outOfSchedule)
    }
  };
  await saveIdempotent(env, replay, actor, "clock_in", payload);
  return wfJson(payload, 201);
}

async function updateFleetOdometer(env, deps, vehicleId, finalKm, date, sourceId) {
  const snapshot = await deps.readSnapshot(env);
  const fleet = JSON.parse(JSON.stringify(snapshot.data || { bikes: [] }));
  const bike = (fleet.bikes || []).find((item) => String(item.id) === String(vehicleId));
  if (!bike) return;
  const previous = Number(bike.currentKm || 0);
  bike.currentKm = Math.max(previous, Number(finalKm));
  bike.lastCheckedAt = date;
  bike.updatedAt = nowIso();
  bike.history = Array.isArray(bike.history) ? bike.history : [];
  const entryId = `shift-${sourceId}`;
  const existingEntry = bike.history.find((entry) => entry.id === entryId);
  const now = nowIso();
  if (existingEntry) {
    existingEntry.km = Math.max(Number(existingEntry.km || 0), Number(finalKm));
    existingEntry.date = date;
    existingEntry.updatedAt = now;
  } else {
    bike.history.unshift({
      id: entryId, type: "check", km: Number(finalKm), date,
      notes: "Καταχώρηση από ολοκλήρωση βάρδιας", tasks: [], oilChanged: false,
      createdAt: now, updatedAt: now
    });
    bike.history = bike.history.slice(0, 500);
  }
  await deps.writeSnapshot(env, fleet, "employee-clock-out", snapshot.version + 1);
}

async function removeShiftFleetHistory(env, deps, shiftId) {
  const snapshot = await deps.readSnapshot(env);
  const fleet = JSON.parse(JSON.stringify(snapshot.data || { bikes: [] }));
  const prefix = `shift-${shiftId}`;
  let changed = false;
  const removed = [];
  for (const bike of fleet.bikes || []) {
    const history = Array.isArray(bike.history) ? bike.history : [];
    const filtered = history.filter((entry) => {
      const id = String(entry?.id || "");
      return id !== prefix && !id.startsWith(`${prefix}-`);
    });
    if (filtered.length !== history.length) {
      const now = nowIso();
      const removedEntries = history.filter((entry) => !filtered.includes(entry));
      const removedIds = removedEntries.map((entry) => String(entry.id || "")).filter(Boolean);
      removedEntries.forEach((entry) => removed.push({ bikeId: String(bike.id || ""), bikeName: String(bike.name || ""), entry }));
      bike.history = filtered;
      bike.historyDeletedIds = [...new Set([...removedIds, ...(Array.isArray(bike.historyDeletedIds) ? bike.historyDeletedIds : [])])].slice(0, 500);
      bike.historyCorrectedAt = now;
      bike.currentKm = filtered.reduce((highest, entry) => Math.max(highest, Number(entry.km || 0)), Math.max(Number(bike.lastServiceKm || 0), Number(bike.odometerFloorKm || 0)));
      bike.lastCheckedAt = filtered.filter((entry) => entry.type === "check").map((entry) => String(entry.date || "")).sort().pop() || "";
      bike.updatedAt = now;
      changed = true;
    }
  }
  if (changed) await deps.writeSnapshot(env, fleet, "shift-deleted", snapshot.version + 1);
  return removed;
}

async function totalShiftDistance(env, shiftId, currentVehicleId, finalKm) {
  const row = await env.DB.prepare(`SELECT COALESCE(SUM(
    CASE
      WHEN final_km IS NOT NULL THEN MAX(0, final_km - initial_km)
      WHEN vehicle_id = ? THEN MAX(0, ? - initial_km)
      ELSE 0
    END
  ), 0) AS distance FROM vehicle_segments WHERE shift_id = ?`)
    .bind(currentVehicleId, finalKm, shiftId).first();
  return Number(row?.distance || 0);
}

async function employeeChangeVehicle(request, env, deps) {
  const actor = await authenticate(request, env, "clock_in_out");
  if (bool(actor.uses_own_vehicle)) throw new ApiError(409, "Ο εργαζόμενος χρησιμοποιεί ιδιόκτητο μηχανάκι και δεν αλλάζει μηχανάκι στόλου.", "own_vehicle");
  if (!bool(actor.can_change_vehicle)) throw new ApiError(403, "Δεν έχεις δικαίωμα αλλαγής μηχανής.", "forbidden");
  const replay = await idempotentResponse(request, env, actor, "employee_change_vehicle");
  if (replay?.payload) return wfJson(replay.payload);
  const body = await bodyJson(request);
  const shift = await activeShift(env, actor.user_id);
  if (!shift) throw new ApiError(409, "Δεν υπάρχει ενεργή βάρδια.", "no_active_shift");
  const newVehicleId = text(body.vehicleId, 100);
  const oldFinalKm = integer(body.currentKm, 0, 2_000_000_000, -1);
  const currentInitial = Number(shift.current_initial_km ?? shift.initial_km);
  if (!newVehicleId || newVehicleId === shift.current_vehicle_id || oldFinalKm < currentInitial || oldFinalKm < Number(shift.vehicle_odometer || 0)) {
    throw new ApiError(400, "Συμπλήρωσε σωστά μηχανάκι και τρέχοντα χιλιόμετρα.");
  }
  const next = await env.DB.prepare("SELECT * FROM vehicle_registry WHERE bike_id=? AND status='available'").bind(newVehicleId).first();
  if (!next) throw new ApiError(409, "Το νέο μηχανάκι δεν είναι διαθέσιμο.", "vehicle_taken");
  const conflict = await env.DB.prepare(`SELECT 1 FROM schedules WHERE vehicle_id=? AND employee_id<>?
    AND status IN ('planned','awaiting') AND start_at < ? AND end_at > ? LIMIT 1`)
    .bind(newVehicleId, actor.user_id, new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(), new Date(Date.now() - 30 * 60 * 1000).toISOString()).first();
  if (conflict) throw new ApiError(409, "Το μηχανάκι είναι δεσμευμένο για άλλη προγραμματισμένη βάρδια.", "vehicle_reserved");
  const now = nowIso();
  const result = await env.DB.batch([
    env.DB.prepare("UPDATE vehicle_segments SET ended_at=?,final_km=?,changed_by=?,reason=? WHERE shift_id=? AND ended_at IS NULL")
      .bind(now, oldFinalKm, actor.user_id, "Αλλαγή από εργαζόμενο", shift.id),
    env.DB.prepare("UPDATE vehicle_registry SET odometer=?,status='available',active_shift_id=NULL,version=version+1,updated_at=? WHERE bike_id=? AND active_shift_id=?")
      .bind(oldFinalKm, now, shift.current_vehicle_id, shift.id),
    env.DB.prepare("UPDATE vehicle_registry SET status='in_use',active_shift_id=?,version=version+1,updated_at=? WHERE bike_id=? AND status='available'")
      .bind(shift.id, now, newVehicleId),
    env.DB.prepare("UPDATE shifts SET current_vehicle_id=?,updated_at=? WHERE id=? AND status='active'").bind(newVehicleId, now, shift.id),
    env.DB.prepare(`INSERT INTO vehicle_segments (id,shift_id,vehicle_id,started_at,initial_km,changed_by,reason)
      VALUES (?,?,?,?,?,?,?)`).bind(uuid(), shift.id, newVehicleId, now, Number(next.odometer), actor.user_id, "Αλλαγή από εργαζόμενο")
  ]);
  if (!Number(result[2]?.meta?.changes || 0) || !Number(result[3]?.meta?.changes || 0)) {
    throw new ApiError(409, "Το νέο μηχανάκι μόλις δεσμεύτηκε από άλλο χρήστη.", "vehicle_taken");
  }
  await updateFleetOdometer(env, deps, shift.current_vehicle_id, oldFinalKm,
    localDate(now, await setting(env, "timezone", DEFAULT_TIME_ZONE)), `${shift.id}-employee-segment`);
  const payload = { updated: true, shiftId: shift.id, vehicleId: newVehicleId, vehicleName: next.name, initialKm: Number(next.odometer) };
  await audit(env, request, actor, "shift_vehicle_changed_by_employee", "shift", shift.id,
    { vehicleId: shift.current_vehicle_id, finalKm: oldFinalKm }, { vehicleId: newVehicleId, initialKm: Number(next.odometer) }, "Εξουσιοδοτημένη αλλαγή", false);
  await saveIdempotent(env, replay, actor, "employee_change_vehicle", payload);
  return wfJson(payload);
}

async function clockOut(request, env, deps) {
  const actor = await authenticate(request, env, "clock_in_out");
  const replay = await idempotentResponse(request, env, actor, "clock_out");
  if (replay?.payload) return wfJson(replay.payload);
  const body = await bodyJson(request);
  const shift = await activeShift(env, actor.user_id);
  if (!shift) throw new ApiError(409, "Δεν υπάρχει ενεργή βάρδια.", "no_active_shift");
  const ownVehicle = isOwnVehicleShiftId(shift.current_vehicle_id || shift.vehicle_id);
  const finalKm = ownVehicle ? null : integer(body.finalKm, 0, 2_000_000_000, -1);
  const currentInitialKm = Number(shift.current_initial_km ?? shift.initial_km);
  if (!ownVehicle && finalKm < 0) throw new ApiError(400, "Γράψε τα τωρινά χιλιόμετρα.");
  if (!ownVehicle && (finalKm < currentInitialKm || finalKm < Number(shift.vehicle_odometer))) {
    await createAlert(env, "invalid_km", "warning", "Απορρίφθηκαν μη έγκυρα χιλιόμετρα", `${actor.full_name} • ${shift.vehicle_name} • ${finalKm} χλμ.`, "shift", shift.id, `invalid-km:${shift.id}`);
    throw new ApiError(409, "Τα τελικά χιλιόμετρα δεν μπορεί να είναι μικρότερα από τα αρχικά ή το official odometer.", "invalid_km");
  }
  const now = nowIso();
  const overtime = shift.scheduled_end && new Date(now).getTime() > new Date(shift.scheduled_end).getTime();
  const overtimeApproved = Boolean(overtime && shift.overtime_status === "approved");
  const effectiveEnd = overtimeApproved ? approvedOvertimeEnd(shift, now) : (overtime ? shift.scheduled_end : now);
  const approvedPayOptions = overtimeApproved ? {
    overtimeStart: shift.scheduled_end,
    overtimeRateCents: shift.overtime_rate_cents == null ? null : Number(shift.overtime_rate_cents),
    hardEndAt: shift.overtime_minutes_override == null ? null : effectiveEnd
  } : { hardEndAt: overtime ? shift.scheduled_end : null };
  // Distance, pay calculation and the warning threshold are independent
  // reads. Resolve them together while preserving the same validation and
  // atomic write batch below.
  const [shiftDistance, calculatedPay, unusualThreshold, timeZone] = await Promise.all([
    ownVehicle ? Promise.resolve(0) : totalShiftDistance(env, shift.id, shift.current_vehicle_id, finalKm),
    calculateShiftPay(env, actor, shift, effectiveEnd, approvedPayOptions),
    ownVehicle ? Promise.resolve(0) : setting(env, "unusual_distance_km", "300"),
    ownVehicle ? Promise.resolve(DEFAULT_TIME_ZONE) : setting(env, "timezone", DEFAULT_TIME_ZONE)
  ]);
  const { rule, breakdown } = calculatedPay;
  const nextStatus = overtime && !overtimeApproved ? "pending_overtime" : "completed";
  const statements = [
    env.DB.prepare(`UPDATE shifts SET status=?, actual_clock_out=?, effective_clock_out=?, payable_clock_in=?,
      payable_clock_out=?, payable_minutes=?, final_km=?, shift_km=?, rule_id=?, rule_version=?, rule_snapshot=?,
      base_pay_cents=?, special_pay_cents=?, final_pay_cents=?, overtime_status=?, missing_km=0, updated_at=?
      WHERE id=? AND status='active'`)
      .bind(nextStatus, now, effectiveEnd, breakdown.payableStart, breakdown.payableEnd, breakdown.payableMinutes,
        finalKm, shiftDistance, rule.id, rule.version, JSON.stringify(rule),
        breakdown.basePayCents, breakdown.specialPayCents, breakdown.totalPayCents,
        overtimeApproved ? "approved" : overtime ? "pending" : "none", now, shift.id),
    env.DB.prepare("UPDATE system_alerts SET resolved=1,resolved_by=?,resolved_at=? WHERE object_type='shift' AND object_id=? AND type='forgotten_clock_out' AND resolved=0")
      .bind(actor.user_id, now, shift.id),
    ...((!overtime || overtimeApproved) ? [env.DB.prepare("UPDATE system_alerts SET resolved=1,resolved_by=?,resolved_at=? WHERE object_type='shift' AND object_id=? AND type='overtime' AND resolved=0")
      .bind(actor.user_id, now, shift.id)] : []),
    ...(shift.schedule_id ? [env.DB.prepare("UPDATE schedules SET status=?, updated_at=? WHERE id=?").bind(overtime && !overtimeApproved ? "pending_correction" : "completed", now, shift.schedule_id)] : []),
    ...breakdown.segments.map((segment) => env.DB.prepare(`INSERT INTO payroll_segments
      (id,shift_id,special_rate_id,label,start_at,end_at,minutes,rate_cents,amount_cents)
      VALUES (?,?,?,?,?,?,?,?,?)`).bind(uuid(), shift.id, segment.specialRateId, segment.label, segment.start,
      segment.end, segment.minutes, segment.rateCents, segment.amountCents))
  ];
  if (!ownVehicle) {
    statements.splice(1, 0,
      env.DB.prepare(`UPDATE vehicle_registry SET odometer=?, status='available', active_shift_id=NULL,
        version=version+1, updated_at=? WHERE bike_id=? AND active_shift_id=? AND odometer<=?`)
        .bind(finalKm, now, shift.current_vehicle_id, shift.id, finalKm),
      env.DB.prepare("UPDATE vehicle_segments SET ended_at=?, final_km=?, changed_by=?, reason='Clock Out' WHERE shift_id=? AND ended_at IS NULL")
        .bind(now, finalKm, actor.user_id, shift.id)
    );
  }
  const result = await env.DB.batch(statements);
  if (!Number(result[0]?.meta?.changes || 0)) throw new ApiError(409, "Η βάρδια έχει ήδη ολοκληρωθεί.");
  if (!ownVehicle) await updateFleetOdometer(env, deps, shift.current_vehicle_id, finalKm,
    localDate(now, timeZone), shift.id);
  const unusualDistanceLimit = integer(unusualThreshold, 1, 5000, 300);
  if (!ownVehicle && shiftDistance > unusualDistanceLimit) {
    await createAlert(env, "unusual_distance", "warning", "Ασυνήθιστη απόσταση βάρδιας", `${actor.full_name} • ${shift.vehicle_name} • ${shiftDistance} χλμ.`, "shift", shift.id, `unusual-distance:${shift.id}`);
  }
  if (overtime && !overtimeApproved) {
    const timing = clockOutTiming(shift, now, rule);
    const message = overtimeMessage(shift, now, timing, actor.full_name);
    await createAlert(env, "overtime", "warning", "Έγκριση υπερωρίας / καθυστερημένο Clock Out", message, "shift", shift.id, `overtime:${shift.id}`);
    await createAlert(env, "forgotten_clock_out", "warning", "Ξεχασμένο Clock Out", message, "shift", shift.id, `forgotten:${shift.id}`);
  }
  await audit(env, request, actor, "clock_out", "shift", shift.id, { status: "active" }, {
    actualClockOut: now, effectiveClockOut: effectiveEnd, ...(ownVehicle ? { ownVehicle: true } : { finalKm, shiftKm: shiftDistance }), status: nextStatus
  }, "", false);
  const completion = {
    success: true,
    message: overtime && !overtimeApproved
      ? "Η καταγραφή αποθηκεύτηκε. Η υπερωρία θα πληρωθεί μόνο μετά από έγκριση."
      : "Η βάρδια ολοκληρώθηκε επιτυχώς. Η καταγραφή σας αποθηκεύτηκε.",
    pendingOvertime: overtime && !overtimeApproved,
    ownVehicle
  };
  if (bool(actor.show_actual_clock_in)) completion.actualClockIn = shift.actual_clock_in;
  if (bool(actor.show_actual_clock_out)) completion.actualClockOut = now;
  if (bool(actor.show_payable_hours)) completion.payableHours = breakdown.payableHours;
  if (bool(actor.show_payment_amount)) completion.paymentCents = breakdown.totalPayCents;
  if (!ownVehicle && bool(actor.show_shift_kilometers)) completion.shiftKilometers = shiftDistance;
  await saveIdempotent(env, replay, actor, "clock_out", completion);
  return wfJson(completion);
}

async function createCorrection(request, env) {
  const actor = await authenticate(request, env, "request_correction");
  const body = await bodyJson(request);
  const type = ["forgot_clock_out", "wrong_km", "other"].includes(body.type) ? body.type : "other";
  const message = text(body.message, 1000);
  if (!message) throw new ApiError(400, "Γράψε τι χρειάζεται διόρθωση.");
  const shiftId = text(body.shiftId, 100) || null;
  if (shiftId) {
    const ownShift = await env.DB.prepare("SELECT 1 FROM shifts WHERE id=? AND employee_id=?").bind(shiftId, actor.user_id).first();
    if (!ownShift) throw new ApiError(403, "Μπορείς να ζητήσεις διόρθωση μόνο για δική σου βάρδια.", "forbidden");
  }
  const id = uuid();
  await env.DB.prepare(`INSERT INTO correction_requests (id,shift_id,employee_id,type,message,created_at)
    VALUES (?,?,?,?,?,?)`).bind(id, shiftId, actor.user_id, type, message, nowIso()).run();
  await createAlert(env, "correction_request", "warning", "Αίτημα διόρθωσης", `${actor.full_name}: ${message}`, "correction", id, `correction:${id}`);
  await audit(env, request, actor, "correction_requested", "correction", id, null, { type, message }, "", false);
  return wfJson({ created: true, id }, 201);
}

function templateSegments(value) {
  const source = Array.isArray(value) ? value : parseJson(value, []);
  if (!Array.isArray(source) || !source.length || source.length > 4) {
    throw new ApiError(400, "Κάθε πρότυπο χρειάζεται από 1 έως 4 τμήματα ώρας.", "invalid_template_segments");
  }
  const segments = source.map((item) => ({
    start: text(item && item.start, 5),
    end: text(item && item.end, 5)
  }));
  if (segments.some((item) => !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(item.start) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(item.end) || item.start === item.end)) {
    throw new ApiError(400, "Έλεγξε τις ώρες του προτύπου. Η έναρξη και η λήξη πρέπει να είναι διαφορετικές.", "invalid_template_segments");
  }
  const intervals = segments.map((item) => scheduleInterval("2026-01-12", item.start, item.end, DEFAULT_TIME_ZONE))
    .sort((a, b) => a.start.localeCompare(b.start));
  for (let index = 1; index < intervals.length; index += 1) {
    if (intervals[index].start < intervals[index - 1].end) {
      throw new ApiError(400, "Τα τμήματα της σπαστής βάρδιας δεν πρέπει να επικαλύπτονται.", "template_segments_overlap");
    }
  }
  return segments;
}

function templatePublic(row) {
  return {
    id: row.id,
    name: row.name,
    segments: templateSegments(row.segments),
    active: bool(row.active),
    sortOrder: Number(row.sort_order || 0),
    color: /^#[0-9A-F]{6}$/i.test(String(row.color || "")) ? row.color : "#0D8F82"
  };
}

function templateName(segments) {
  return segments.map((item) => `${item.start} - ${item.end}`).join(" / ");
}

function templateInput(body) {
  const segments = templateSegments(body.segments);
  const name = text(body.name, 80) || templateName(segments);
  const color = /^#[0-9A-F]{6}$/i.test(String(body.color || "")) ? String(body.color).toUpperCase() : "#0D8F82";
  return {
    name,
    segments,
    color,
    active: body.active === undefined ? true : bool(body.active),
    sortOrder: integer(body.sortOrder, 0, 10000, 0)
  };
}

async function listShiftTemplates(request, env) {
  const actor = await authenticate(request, env, "schedules.view");
  const includeInactive = new URL(request.url).searchParams.get("includeInactive") === "1" && hasPermission(actor.permissions, "schedules.manage");
  const rows = await env.DB.prepare(`SELECT * FROM shift_templates
    WHERE (?=1 OR active=1) ORDER BY active DESC,sort_order,name COLLATE NOCASE`).bind(includeInactive ? 1 : 0).all();
  return wfJson({ templates: (rows.results || []).map(templatePublic) });
}

async function createShiftTemplate(request, env) {
  const actor = await authenticate(request, env, "schedules.manage");
  const input = templateInput(await bodyJson(request));
  const id = uuid();
  const now = nowIso();
  await env.DB.prepare(`INSERT INTO shift_templates
    (id,name,segments,active,sort_order,color,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(id, input.name, JSON.stringify(input.segments), input.active ? 1 : 0, input.sortOrder, input.color, actor.user_id, now, now).run();
  await audit(env, request, actor, "shift_template_created", "shift_template", id, null, input, "", false);
  return wfJson({ created: true, template: { id, ...input } }, 201);
}

async function updateShiftTemplate(request, env, templateId) {
  const actor = await authenticate(request, env, "schedules.manage");
  const old = await env.DB.prepare("SELECT * FROM shift_templates WHERE id=?").bind(templateId).first();
  if (!old) throw new ApiError(404, "Το πρότυπο βάρδιας δεν βρέθηκε.");
  const input = templateInput(await bodyJson(request));
  const now = nowIso();
  await env.DB.prepare(`UPDATE shift_templates SET name=?,segments=?,active=?,sort_order=?,color=?,updated_at=? WHERE id=?`)
    .bind(input.name, JSON.stringify(input.segments), input.active ? 1 : 0, input.sortOrder, input.color, now, templateId).run();
  await audit(env, request, actor, "shift_template_updated", "shift_template", templateId, templatePublic(old), input, "", false);
  return wfJson({ updated: true, template: { id: templateId, ...input } });
}

async function deleteShiftTemplate(request, env, templateId) {
  const actor = await authenticate(request, env, "schedules.manage");
  const old = await env.DB.prepare("SELECT * FROM shift_templates WHERE id=?").bind(templateId).first();
  if (!old) throw new ApiError(404, "Το πρότυπο βάρδιας δεν βρέθηκε.");
  await env.DB.prepare("UPDATE shift_templates SET active=0,updated_at=? WHERE id=?").bind(nowIso(), templateId).run();
  await audit(env, request, actor, "shift_template_disabled", "shift_template", templateId, templatePublic(old), { active: false }, "", false);
  return wfJson({ deleted: true });
}

function mondayForDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) throw new ApiError(400, "Η ημερομηνία εβδομάδας δεν είναι έγκυρη.");
  const day = weekdayForDate(date);
  return addCalendarDays(date, day === 0 ? -6 : 1 - day);
}

function localClock(value, timeZone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(value));
  const result = {};
  parts.forEach((part) => { if (part.type !== "literal") result[part.type] = part.value; });
  return `${result.hour}:${result.minute}`;
}

function schedulesOverlap(first, second) {
  return first.start < second.end && first.end > second.start;
}

async function loadScheduleConflictRows(env, intervals, employeeIds = [], vehicleIds = []) {
  if (!intervals.length || (!employeeIds.length && !vehicleIds.length)) return [];
  const start = intervals.map((item) => item.start).sort()[0];
  const end = intervals.map((item) => item.end).sort().slice(-1)[0];
  const queries = [];
  if (employeeIds.length) {
    queries.push(env.DB.prepare(`SELECT sc.id,sc.employee_id,sc.vehicle_id,sc.series_id,sc.start_at,sc.end_at,
        u.full_name AS employee_name
      FROM schedules sc JOIN app_users u ON u.id=sc.employee_id
      WHERE sc.status NOT IN ('cancelled','completed') AND sc.start_at<? AND sc.end_at>?
        AND sc.employee_id IN (${employeeIds.map(() => "?").join(",")})`).bind(end, start, ...employeeIds).all());
  }
  if (vehicleIds.length) {
    queries.push(env.DB.prepare(`SELECT sc.id,sc.employee_id,sc.vehicle_id,sc.series_id,sc.start_at,sc.end_at,
        u.full_name AS employee_name
      FROM schedules sc JOIN app_users u ON u.id=sc.employee_id
      WHERE sc.status NOT IN ('cancelled','completed') AND sc.start_at<? AND sc.end_at>?
        AND sc.vehicle_id IN (${vehicleIds.map(() => "?").join(",")})`).bind(end, start, ...vehicleIds).all());
  }
  const results = await Promise.all(queries);
  const rows = new Map();
  results.forEach((result) => (result.results || []).forEach((row) => rows.set(String(row.id), row)));
  return [...rows.values()];
}

function explicitNoVehicle(item) {
  return Boolean(item?.withoutVehicle || item?.noVehicle || item?.vehicleId === "__no_vehicle__");
}

function requestedScheduleVehicleId(item) {
  const raw = item?.vehicleId === "__no_vehicle__" ? "" : text(item?.vehicleId, 100);
  return raw || null;
}

export function effectiveScheduleVehicleId(item, employee) {
  if (bool(employee?.uses_own_vehicle) || bool(employee?.usesOwnVehicle)) return null;
  if (explicitNoVehicle(item)) return null;
  return requestedScheduleVehicleId(item) || text(employee?.assigned_vehicle_id, 100) || null;
}

function draftAssignmentKey(item) {
  return [text(item?.employeeId, 100), text(item?.date, 10), text(item?.templateId, 100)].join("|");
}

function draftAssignmentInput(item, weekStart) {
  return {
    employeeId: text(item?.employeeId, 100),
    date: text(item?.date || item?.workDate, 10),
    templateId: text(item?.templateId, 100),
    vehicleId: requestedScheduleVehicleId(item),
    withoutVehicle: explicitNoVehicle(item),
    notes: text(item?.notes, 500),
    weekStart
  };
}

async function schedulePublication(env, weekStart) {
  return env.DB.prepare("SELECT week_start,revision,published_by,published_at FROM schedule_publications WHERE week_start=?")
    .bind(weekStart).first();
}

async function readScheduleDraft(env, weekStart) {
  const row = await env.DB.prepare("SELECT * FROM schedule_week_drafts WHERE week_start=?").bind(weekStart).first();
  if (!row) return null;
  return {
    ...row,
    assignments: parseJson(row.assignments, []),
    baseRevision: Number(row.base_revision || 0)
  };
}

async function validateDraftAssignments(env, assignments, weekStart, options = {}) {
  const source = Array.isArray(assignments) ? assignments.slice(0, 80) : [];
  const normalized = source.map((item) => draftAssignmentInput(item, weekStart));
  const errors = [];
  const warnings = [];
  const seen = new Set();
  const employeeIds = [...new Set(normalized.map((item) => item.employeeId).filter(Boolean))];
  const templateIds = [...new Set(normalized.map((item) => item.templateId).filter(Boolean))];
  const vehicleIds = new Set();
  const employees = new Map();
  const templates = new Map();
  const vehicles = new Map();
  if (employeeIds.length) {
    const marks = employeeIds.map(() => "?").join(",");
    const rows = await env.DB.prepare(`SELECT id,full_name,role,assigned_vehicle_id,uses_own_vehicle FROM app_users WHERE active=1 AND id IN (${marks})`).bind(...employeeIds).all();
    (rows.results || []).forEach((row) => employees.set(String(row.id), row));
  }
  normalized.forEach((item) => {
    const employee = employees.get(item.employeeId);
    const vehicleId = effectiveScheduleVehicleId(item, employee);
    if (vehicleId) vehicleIds.add(vehicleId);
  });
  if (templateIds.length) {
    const marks = templateIds.map(() => "?").join(",");
    const rows = await env.DB.prepare(`SELECT * FROM shift_templates WHERE active=1 AND id IN (${marks})`).bind(...templateIds).all();
    (rows.results || []).forEach((row) => templates.set(String(row.id), row));
  }
  if (vehicleIds.size) {
    const ids = [...vehicleIds];
    const marks = ids.map(() => "?").join(",");
    const rows = await env.DB.prepare(`SELECT bike_id,name,status,odometer FROM vehicle_registry WHERE bike_id IN (${marks})`).bind(...ids).all();
    (rows.results || []).forEach((row) => vehicles.set(String(row.bike_id), row));
  }
  const timeZone = await setting(env, "timezone", DEFAULT_TIME_ZONE);
  const startBoundary = scheduleInterval(weekStart, "00:00", "00:01", timeZone).start;
  const endBoundary = scheduleInterval(addCalendarDays(weekStart, 7), "00:00", "00:01", timeZone).start;
  const occupied = await env.DB.prepare(`SELECT sc.id,sc.employee_id,sc.vehicle_id,sc.series_id,sc.start_at,sc.end_at,u.full_name AS employee_name
    FROM schedules sc JOIN app_users u ON u.id=sc.employee_id
    WHERE sc.status NOT IN ('cancelled','completed')`).all();
  const existing = occupied.results || [];
  const pending = [];
  const valid = [];
  for (let normalizedIndex = 0; normalizedIndex < normalized.length; normalizedIndex += 1) {
    const item = normalized[normalizedIndex];
    const rowNumber = normalizedIndex + 2;
    const key = draftAssignmentKey(item);
    if (!item.employeeId || !employees.has(item.employeeId)) {
      errors.push({ row: rowNumber, code: "employee", message: "Ο εργαζόμενος δεν βρέθηκε ή δεν είναι ενεργός." });
      continue;
    }
    const employee = employees.get(item.employeeId);
    const ownVehicle = bool(employee.uses_own_vehicle);
    const effectiveItem = {
      ...item,
      vehicleId: effectiveScheduleVehicleId(item, employee),
      withoutVehicle: item.withoutVehicle || ownVehicle
    };
    if (!item.templateId || !templates.has(item.templateId)) {
      errors.push({ row: rowNumber, code: "template", message: "Το πρότυπο βάρδιας δεν βρέθηκε ή δεν είναι ενεργό." });
      continue;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.date) || item.date < weekStart || item.date > addCalendarDays(weekStart, 6)) {
      errors.push({ row: rowNumber, code: "date", message: "Η ημερομηνία πρέπει να ανήκει στην ίδια εβδομάδα." });
      continue;
    }
    if (seen.has(key)) {
      warnings.push({ row: rowNumber, message: "Η διπλή ίδια ανάθεση αγνοήθηκε." });
      continue;
    }
    seen.add(key);
    if (effectiveItem.vehicleId && (!vehicles.has(effectiveItem.vehicleId) || ["service", "inactive"].includes(String(vehicles.get(effectiveItem.vehicleId).status)))) {
      errors.push({ row: rowNumber, code: "vehicle", message: "Το μηχανάκι δεν βρέθηκε ή είναι σε service/ανενεργό." });
      continue;
    }
    let intervals;
    try {
      intervals = templateSegments(templates.get(item.templateId).segments).map((segment) => scheduleInterval(item.date, segment.start, segment.end, timeZone));
    } catch (error) {
      errors.push({ row: rowNumber, code: "time", message: error.message });
      continue;
    }
    let rejected = false;
    for (const interval of intervals) {
      const pendingEmployee = pending.find((entry) => String(entry.employeeId) === item.employeeId && schedulesOverlap(interval, entry));
      if (pendingEmployee) {
        errors.push({ row: rowNumber, code: "employee_conflict", message: `${employees.get(item.employeeId).full_name} έχει δύο επικαλυπτόμενες βάρδιες.` });
        rejected = true;
        break;
      }
      const dbEmployee = existing.find((entry) => String(entry.employee_id) === item.employeeId && !(entry.start_at >= startBoundary && entry.start_at < endBoundary) && schedulesOverlap(interval, { start: entry.start_at, end: entry.end_at }));
      if (dbEmployee) {
        errors.push({ row: rowNumber, code: "employee_conflict", message: `${employees.get(item.employeeId).full_name} έχει ήδη επικαλυπτόμενη δημοσιευμένη βάρδια.` });
        rejected = true;
        break;
      }
      if (effectiveItem.vehicleId) {
        const pendingVehicle = pending.find((entry) => String(entry.vehicleId || "") === effectiveItem.vehicleId && schedulesOverlap(interval, entry));
        const dbVehicle = existing.find((entry) => String(entry.vehicle_id || "") === effectiveItem.vehicleId && !(entry.start_at >= startBoundary && entry.start_at < endBoundary) && schedulesOverlap(interval, { start: entry.start_at, end: entry.end_at }));
        if (pendingVehicle || dbVehicle) {
          const suggestions = await availableVehicleSuggestions(env, intervals, pending, employee.assigned_vehicle_id || "", null);
          const conflictEntry = pendingVehicle || dbVehicle;
          errors.push({ row: rowNumber, code: "vehicle_conflict", message: `${vehicles.get(effectiveItem.vehicleId)?.name || "Το μηχανάκι"} είναι ήδη δεσμευμένο σε επικαλυπτόμενη βάρδια.`,
            conflict: { kind: "vehicle", employeeId: item.employeeId, employeeName: employee.full_name, date: item.date, vehicleId: effectiveItem.vehicleId, vehicleName: vehicles.get(effectiveItem.vehicleId)?.name || "",
              startAt: interval.start, endAt: interval.end, conflictingEmployeeName: conflictEntry.employeeName || conflictEntry.employee_name || "" },
            suggestedVehicles: suggestions });
          rejected = true;
          break;
        }
      }
    }
    if (rejected) continue;
    valid.push(effectiveItem);
    intervals.forEach((interval) => pending.push({ ...interval, employeeId: effectiveItem.employeeId, employeeName: employee.full_name, vehicleId: effectiveItem.vehicleId }));
  }
  const missingVehicles = valid.filter((item) => !item.vehicleId && !item.withoutVehicle).map((item) => ({
    key: draftAssignmentKey(item), employeeId: item.employeeId, employeeName: employees.get(item.employeeId)?.full_name || "", date: item.date,
    templateId: item.templateId, templateName: templates.get(item.templateId)?.name || ""
  }));
  return { assignments: valid, errors, warnings, missingVehicles, employees, templates, vehicles };
}

export function replaceScheduleDraftEmployee(existingAssignments, incomingAssignments, employeeId) {
  const targetEmployeeId = text(employeeId, 100);
  if (!targetEmployeeId) return incomingAssignments;
  const retained = (Array.isArray(existingAssignments) ? existingAssignments : [])
    .filter((item) => text(item?.employeeId, 100) !== targetEmployeeId);
  return retained.concat(Array.isArray(incomingAssignments) ? incomingAssignments : []);
}

async function readPublishedScheduleAssignments(env, weekStart) {
  const weekEnd = addCalendarDays(weekStart, 6);
  const timeZone = await setting(env, "timezone", DEFAULT_TIME_ZONE);
  const startBoundary = scheduleInterval(weekStart, "00:00", "00:01", timeZone).start;
  const endBoundary = scheduleInterval(addCalendarDays(weekEnd, 1), "00:00", "00:01", timeZone).start;
  const [rows, legacyRows] = await Promise.all([
    env.DB.prepare("SELECT employee_id AS employeeId,template_id AS templateId, work_date AS date,vehicle_id AS vehicleId,notes FROM schedule_assignments WHERE status='planned' AND work_date BETWEEN ? AND ? ORDER BY work_date,employee_id").bind(weekStart, weekEnd).all(),
    env.DB.prepare(`SELECT sc.id FROM schedules sc
      LEFT JOIN schedule_assignments sa ON sa.id=sc.series_id AND sa.status='planned'
      WHERE sc.start_at>=? AND sc.start_at<? AND sc.status NOT IN ('cancelled') AND sa.id IS NULL LIMIT 1`)
      .bind(startBoundary, endBoundary).all()
  ]);
  return {
    assignments: (rows.results || []).map((row) => ({
      employeeId: row.employeeId,
      date: row.date,
      templateId: row.templateId,
      vehicleId: row.vehicleId || null,
      withoutVehicle: !row.vehicleId
    })),
    hasLegacyRows: (legacyRows.results || []).length > 0
  };
}

async function saveScheduleDraft(env, actor, assignments, weekStart, options = {}) {
  const replaceEmployeeId = text(options.replaceEmployeeId, 100);
  const existingDraft = replaceEmployeeId ? await readScheduleDraft(env, weekStart) : null;
  const publishedSeed = replaceEmployeeId && !existingDraft
    ? await readPublishedScheduleAssignments(env, weekStart)
    : { assignments: [], hasLegacyRows: false };
  if (replaceEmployeeId && !existingDraft && publishedSeed.hasLegacyRows) {
    throw new ApiError(409, "Η εβδομάδα περιέχει παλιές καταχωρήσεις χωρίς ασφαλή ομαδοποίηση. Δημιούργησε πρώτα πλήρες Πρόχειρο από την καταχώρηση ανά βάρδια και μετά συνέχισε ανά διανομέα.", "schedule_draft_legacy_rows");
  }
  const publishedAssignments = publishedSeed.assignments;
  const baseAssignments = existingDraft?.assignments || publishedAssignments;
  const sourceAssignments = replaceEmployeeId
    ? replaceScheduleDraftEmployee(baseAssignments, assignments, replaceEmployeeId)
    : assignments;
  const check = await validateDraftAssignments(env, sourceAssignments, weekStart);
  if (check.errors.length) {
    const issue = check.errors[0];
    throw new ApiError(422, issue.message || "Το πρόχειρο έχει σφάλματα. Διόρθωσέ τα πριν αποθηκευτεί.", "schedule_draft_invalid", {
      errors: check.errors, warnings: check.warnings, conflict: issue.conflict, suggestedVehicles: issue.suggestedVehicles
    });
  }
  if (!check.assignments.length) throw new ApiError(400, "Δεν προέκυψε καμία έγκυρη ανάθεση.");
  const publication = await schedulePublication(env, weekStart);
  const now = nowIso();
  await env.DB.prepare(`INSERT INTO schedule_week_drafts (week_start,assignments,state,base_revision,created_by,created_at,updated_at)
    VALUES (?,?, 'draft', ?, ?, ?, ?)
    ON CONFLICT(week_start) DO UPDATE SET assignments=excluded.assignments,state='draft',base_revision=excluded.base_revision,updated_at=excluded.updated_at`)
    .bind(weekStart, JSON.stringify(check.assignments), Number(publication?.revision || 0), actor.user_id, now, now).run();
  return { weekStart, state: "draft", assignments: check.assignments, missingVehicles: check.missingVehicles, warnings: check.warnings, revision: Number(publication?.revision || 0) };
}

async function expandDraftRows(env, draft, timeZone) {
  if (!draft) return [];
  const assignments = Array.isArray(draft.assignments) ? draft.assignments : [];
  if (!assignments.length) return [];
  const employeeIds = [...new Set(assignments.map((item) => item.employeeId).filter(Boolean))];
  const templateIds = [...new Set(assignments.map((item) => item.templateId).filter(Boolean))];
  const maps = await Promise.all([
    employeeIds.length ? env.DB.prepare(`SELECT id,full_name,employee_group,assigned_vehicle_id,uses_own_vehicle FROM app_users WHERE id IN (${employeeIds.map(() => "?").join(",")})`).bind(...employeeIds).all() : Promise.resolve({ results: [] }),
    templateIds.length ? env.DB.prepare(`SELECT * FROM shift_templates WHERE id IN (${templateIds.map(() => "?").join(",")})`).bind(...templateIds).all() : Promise.resolve({ results: [] })
  ]);
  const employees = new Map((maps[0].results || []).map((row) => [String(row.id), row]));
  const templates = new Map((maps[1].results || []).map((row) => [String(row.id), row]));
  const resolvedAssignments = assignments.map((item) => {
    const employee = employees.get(String(item.employeeId));
    return {
      ...item,
      vehicleId: effectiveScheduleVehicleId(item, employee),
      withoutVehicle: Boolean(item.withoutVehicle || bool(employee?.uses_own_vehicle))
    };
  });
  const vehicleIds = [...new Set(resolvedAssignments.map((item) => item.vehicleId).filter(Boolean))];
  const vehicleRows = vehicleIds.length
    ? await env.DB.prepare(`SELECT bike_id,name FROM vehicle_registry WHERE bike_id IN (${vehicleIds.map(() => "?").join(",")})`).bind(...vehicleIds).all()
    : { results: [] };
  const vehicles = new Map((vehicleRows.results || []).map((row) => [String(row.bike_id), row]));
  const rows = [];
  resolvedAssignments.forEach((item) => {
    const employee = employees.get(String(item.employeeId));
    const template = templates.get(String(item.templateId));
    if (!employee || !template) return;
    templateSegments(template.segments).forEach((segment) => {
      const interval = scheduleInterval(item.date, segment.start, segment.end, timeZone);
      rows.push({
        id: `draft-${draft.week_start}-${draftAssignmentKey(item)}-${segment.start}`,
        employee_id: item.employeeId, vehicle_id: item.vehicleId || null, series_id: draftAssignmentKey(item),
        start_at: interval.start, end_at: interval.end, status: "planned", notes: item.notes || "",
        employee_name: employee.full_name, vehicle_name: item.vehicleId ? (vehicles.get(String(item.vehicleId))?.name || "") : (bool(employee.uses_own_vehicle) ? OWN_VEHICLE_LABEL : ""),
        assignment_id: draftAssignmentKey(item), template_id: item.templateId, assignment_date: item.date,
        assignment_notes: item.notes || "", template_name: template.name, template_color: template.color,
        managed_assignment: true, has_shift: false, work_date: item.date,
        start_time: segment.start, end_time: segment.end
      });
    });
  });
  return rows;
}

function importCell(row, keys) {
  for (const key of keys) {
    if (row && row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== "") return row[key];
  }
  return "";
}

function importDate(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86400000);
    return date.toISOString().slice(0, 10);
  }
  const valueText = text(value, 30);
  if (/^\d{4}-\d{2}-\d{2}$/.test(valueText)) return valueText;
  const match = valueText.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (match) return `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
  return "";
}

async function normalizeScheduleImportRows(env, rows) {
  const source = Array.isArray(rows) ? rows.slice(0, 80) : [];
  const allEmployees = await env.DB.prepare("SELECT id,full_name,username,assigned_vehicle_id FROM app_users WHERE active=1").all();
  const allTemplates = await env.DB.prepare("SELECT * FROM shift_templates WHERE active=1 ORDER BY sort_order,name COLLATE NOCASE").all();
  const allVehicles = await env.DB.prepare("SELECT bike_id,name,status FROM vehicle_registry WHERE status NOT IN ('service','inactive')").all();
  const employees = allEmployees.results || [];
  const templates = allTemplates.results || [];
  const vehicles = allVehicles.results || [];
  const errors = [];
  const assignments = [];
  source.forEach((row, index) => {
    const date = importDate(importCell(row, ["date", "workDate", "Ημερομηνία", "Ημ/νία"]));
    const employeeId = text(importCell(row, ["employeeId", "employee_id"]), 100);
    const username = text(importCell(row, ["username", "Username", "user"]), 100).toLocaleLowerCase("el");
    const employeeName = text(importCell(row, ["employeeName", "fullName", "employee", "Εργαζόμενος", "Ονοματεπώνυμο"]), 160).toLocaleLowerCase("el");
    const employee = employees.find((item) => String(item.id) === employeeId || String(item.username || "").toLocaleLowerCase("el") === username || String(item.full_name || "").toLocaleLowerCase("el") === employeeName);
    const templateId = text(importCell(row, ["templateId", "template_id"]), 100);
    const templateName = text(importCell(row, ["templateName", "template", "Πρότυπο βάρδιας", "Βάρδια"]), 160).toLocaleLowerCase("el");
    const template = templates.find((item) => String(item.id) === templateId || String(item.name || "").toLocaleLowerCase("el") === templateName);
    const vehicleId = text(importCell(row, ["vehicleId", "vehicle_id"]), 100);
    const vehicleName = text(importCell(row, ["vehicle", "Μηχανάκι"]), 160).toLocaleLowerCase("el");
    const vehicle = vehicles.find((item) => String(item.bike_id) === vehicleId || String(item.name || "").toLocaleLowerCase("el") === vehicleName);
    const noVehicleValue = importCell(row, ["withoutVehicle", "noVehicle", "Χωρίς μηχανάκι"]).toString().toLocaleLowerCase("el");
    const withoutVehicle = ["ναι", "yes", "true", "1", "χωρίς μηχανάκι", "χωρις μηχανακι"].includes(noVehicleValue);
    if (!date) errors.push({ row: index + 2, message: "Η ημερομηνία δεν είναι έγκυρη." });
    if (!employee) errors.push({ row: index + 2, message: "Δεν βρέθηκε εργαζόμενος. Χρησιμοποίησε Username ή ακριβές ονοματεπώνυμο." });
    if (!template) errors.push({ row: index + 2, message: "Δεν βρέθηκε ενεργό πρότυπο βάρδιας." });
    if (!vehicle && (vehicleId || vehicleName) && !withoutVehicle) errors.push({ row: index + 2, message: "Το μηχανάκι δεν βρέθηκε ή δεν είναι διαθέσιμο." });
    if (employee && template && date) assignments.push({
      employeeId: employee.id, date, templateId: template.id, vehicleId: vehicle?.bike_id || null,
      withoutVehicle, notes: text(importCell(row, ["notes", "Σημειώσεις"]), 500)
    });
  });
  const weekStart = assignments.length ? mondayForDate(assignments[0].date) : "";
  if (weekStart && assignments.some((item) => mondayForDate(item.date) !== weekStart)) errors.push({ row: 0, message: "Όλες οι γραμμές πρέπει να ανήκουν στην ίδια εβδομάδα." });
  return { assignments, errors, weekStart };
}

async function copyScheduleWeek(request, env, deps) {
  const actor = await authenticate(request, env, "schedules.manage");
  const body = await bodyJson(request);
  const targetWeek = mondayForDate(text(body.targetWeek || body.weekStart, 10) || localDate(Date.now(), DEFAULT_TIME_ZONE));
  const sourceWeek = mondayForDate(text(body.sourceWeek, 10) || addCalendarDays(targetWeek, -7));
  const sourceEnd = addCalendarDays(sourceWeek, 6);
  const rows = await env.DB.prepare(`SELECT employee_id,template_id,work_date,vehicle_id,notes FROM schedule_assignments
    WHERE status='planned' AND work_date BETWEEN ? AND ? ORDER BY work_date`).bind(sourceWeek, sourceEnd).all();
  const assignments = (rows.results || []).map((row) => ({
    employeeId: row.employee_id, date: addCalendarDays(row.work_date, 7), templateId: row.template_id,
    vehicleId: body.preserveVehicles === false ? null : row.vehicle_id, notes: row.notes || ""
  }));
  if (!assignments.length) throw new ApiError(404, "Δεν βρέθηκε δημοσιευμένο πρόγραμμα στην προηγούμενη εβδομάδα.", "schedule_copy_empty");
  const saved = await saveScheduleDraft(env, actor, assignments, targetWeek);
  await audit(env, request, actor, "schedule_week_copied", "schedule_week", targetWeek, { sourceWeek }, { assignments: saved.assignments.length }, text(body.reason, 500), false);
  return wfJson({ copied: true, sourceWeek, targetWeek, draft: saved });
}

async function publishScheduleWeek(request, env, deps) {
  const actor = await authenticate(request, env, "schedules.manage");
  const body = await bodyJson(request);
  const weekStart = mondayForDate(text(body.weekStart, 10));
  const draft = await readScheduleDraft(env, weekStart);
  if (!draft) throw new ApiError(404, "Δεν υπάρχει Πρόχειρο για αυτή την εβδομάδα.", "schedule_draft_missing");
  const check = await validateDraftAssignments(env, draft.assignments, weekStart);
  if (check.errors.length) {
    const issue = check.errors[0];
    throw new ApiError(422, issue.message || "Το Πρόχειρο έχει σφάλματα και δεν δημοσιεύτηκε.", "schedule_draft_invalid", {
      errors: check.errors, conflict: issue.conflict, suggestedVehicles: issue.suggestedVehicles
    });
  }
  const waivers = new Set(Array.isArray(body.waivers) ? body.waivers.map((item) => text(item, 240)) : []);
  const missing = check.missingVehicles.filter((item) => !waivers.has(item.key) && !draft.assignments.some((entry) => draftAssignmentKey(entry) === item.key && entry.withoutVehicle));
  if (missing.length) throw new ApiError(409, "Κάθε βάρδια χρειάζεται μηχανάκι ή ρητή επιλογή Χωρίς μηχανάκι.", "schedule_vehicle_required", { missingVehicles: missing });
  const timeZone = await setting(env, "timezone", DEFAULT_TIME_ZONE);
  const startBoundary = scheduleInterval(weekStart, "00:00", "00:01", timeZone).start;
  const endBoundary = scheduleInterval(addCalendarDays(weekStart, 7), "00:00", "00:01", timeZone).start;
  const locked = await env.DB.prepare(`SELECT sc.id FROM schedules sc JOIN shifts sh ON sh.schedule_id=sc.id
    WHERE sc.start_at>=? AND sc.start_at<? LIMIT 1`).bind(startBoundary, endBoundary).first();
  if (locked) throw new ApiError(409, "Η εβδομάδα περιέχει βάρδια με πραγματικό Clock In και δεν αντικαθίσταται.", "schedule_week_locked");
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare("UPDATE schedule_assignments SET status='cancelled',updated_at=? WHERE work_date BETWEEN ? AND ? AND status='planned'").bind(now, weekStart, addCalendarDays(weekStart, 6)),
    env.DB.prepare("UPDATE schedules SET status='cancelled',updated_at=? WHERE start_at>=? AND start_at<? AND status IN ('planned','awaiting','absent')").bind(now, startBoundary, endBoundary)
  ]);
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  const materializeRequest = new Request(request.url, { method: "POST", headers, body: JSON.stringify({ assignments: draft.assignments, reason: "Δημοσίευση Πρόχειρου" }) });
  await createWeekAssignments(materializeRequest, env, deps);
  const publication = await schedulePublication(env, weekStart);
  const revision = Number(publication?.revision || 0) + 1;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO schedule_publications (week_start,revision,published_by,published_at) VALUES (?,?,?,?)
      ON CONFLICT(week_start) DO UPDATE SET revision=excluded.revision,published_by=excluded.published_by,published_at=excluded.published_at`)
      .bind(weekStart, revision, actor.user_id, now),
    env.DB.prepare("DELETE FROM schedule_acknowledgements WHERE week_start=?").bind(weekStart),
    env.DB.prepare("DELETE FROM schedule_vehicle_waivers WHERE week_start=?").bind(weekStart),
    env.DB.prepare("DELETE FROM schedule_week_drafts WHERE week_start=?").bind(weekStart)
  ]);
  await audit(env, request, actor, "schedule_week_published", "schedule_week", weekStart, { draft: true }, { revision }, text(body.reason, 500), false);
  return wfJson({ published: true, weekStart, revision });
}

async function previewScheduleImport(request, env) {
  await authenticate(request, env, "schedules.manage");
  const body = await bodyJson(request);
  const normalized = await normalizeScheduleImportRows(env, body.rows);
  const validation = normalized.weekStart ? await validateDraftAssignments(env, normalized.assignments, normalized.weekStart) : { assignments: [], errors: [], missingVehicles: [] };
  const errors = normalized.errors.concat(validation.errors || []);
  const target = normalized.weekStart ? {
    weekStart: normalized.weekStart,
    state: (await readScheduleDraft(env, normalized.weekStart)) ? "draft" : (await schedulePublication(env, normalized.weekStart)) ? "published" : "empty"
  } : null;
  return wfJson({ valid: !errors.length, weekStart: normalized.weekStart, assignments: validation.assignments || normalized.assignments, errors, missingVehicles: validation.missingVehicles || [], target });
}

async function commitScheduleImport(request, env, deps) {
  const actor = await authenticate(request, env, "schedules.manage");
  const body = await bodyJson(request);
  if (body.confirm !== true) throw new ApiError(400, "Χρειάζεται επιβεβαίωση δημιουργίας Πρόχειρου.");
  const normalized = await normalizeScheduleImportRows(env, body.rows || body.assignments);
  if (normalized.errors.length) throw new ApiError(422, "Το Excel έχει σφάλματα και δεν αποθηκεύτηκε.", "schedule_import_invalid", { errors: normalized.errors });
  if (!normalized.weekStart) throw new ApiError(400, "Το Excel δεν περιέχει γραμμές.");
  const existingDraft = await readScheduleDraft(env, normalized.weekStart);
  const publication = await schedulePublication(env, normalized.weekStart);
  if ((existingDraft || publication) && body.replace !== true) throw new ApiError(409, "Η εβδομάδα έχει ήδη Πρόχειρο ή δημοσιευμένο πρόγραμμα. Επιβεβαίωσε την αντικατάσταση.", "schedule_import_target_occupied", {
    target: { weekStart: normalized.weekStart, state: existingDraft ? "draft" : "published" }
  });
  const saved = await saveScheduleDraft(env, actor, normalized.assignments, normalized.weekStart);
  await audit(env, request, actor, "schedule_import_draft_saved", "schedule_week", normalized.weekStart, null, { rows: saved.assignments.length }, text(body.reason, 500), false);
  return wfJson({ committed: true, draft: saved }, 201);
}

async function acknowledgeSchedule(request, env) {
  const actor = await authenticate(request, env, "clock_in_out");
  const body = await bodyJson(request);
  const weekStart = mondayForDate(text(body.weekStart, 10));
  const publication = await schedulePublication(env, weekStart);
  if (!publication) throw new ApiError(404, "Δεν υπάρχει δημοσιευμένο πρόγραμμα για αυτή την εβδομάδα.");
  await env.DB.prepare(`INSERT INTO schedule_acknowledgements (week_start,revision,employee_id,acknowledged_at)
    VALUES (?,?,?,?) ON CONFLICT(week_start,revision,employee_id) DO UPDATE SET acknowledged_at=excluded.acknowledged_at`)
    .bind(weekStart, Number(publication.revision || 0), actor.user_id, nowIso()).run();
  return wfJson({ acknowledged: true, weekStart, revision: Number(publication.revision || 0) });
}

async function availableVehicleSuggestions(env, intervals, pending, preferredVehicleId = "", replaceScope = null, excludeSeriesId = "") {
  const start = intervals.map((item) => item.start).sort()[0];
  const end = intervals.map((item) => item.end).sort().slice(-1)[0];
  const [vehicles, occupied] = await Promise.all([
    env.DB.prepare(`SELECT bike_id,name,status,odometer FROM vehicle_registry
      WHERE status NOT IN ('service','inactive') ORDER BY CASE WHEN bike_id=? THEN 0 ELSE 1 END,name COLLATE NOCASE`).bind(preferredVehicleId).all(),
    env.DB.prepare(`SELECT vehicle_id,employee_id,series_id,start_at,end_at FROM schedules
      WHERE vehicle_id IS NOT NULL AND status NOT IN ('cancelled','completed') AND start_at<? AND end_at>?`).bind(end, start).all()
  ]);
  return (vehicles.results || []).filter((vehicle) => {
    const busy = (occupied.results || []).some((item) => {
      if (excludeSeriesId && String(item.series_id || "") === String(excludeSeriesId)) return false;
      if (replaceScope && String(item.employee_id) === String(replaceScope.employeeId) && item.start_at >= replaceScope.start && item.start_at < replaceScope.end) return false;
      return String(item.vehicle_id) === String(vehicle.bike_id) && intervals.some((interval) => schedulesOverlap(interval, { start: item.start_at, end: item.end_at }));
    });
    const pendingBusy = pending.some((item) => String(item.vehicleId || "") === String(vehicle.bike_id) &&
      intervals.some((interval) => schedulesOverlap(interval, item)));
    return !busy && !pendingBusy;
  }).slice(0, 6).map((vehicle) => ({
    id: vehicle.bike_id,
    name: vehicle.name,
    odometer: Number(vehicle.odometer || 0)
  }));
}

async function scheduleWeek(request, env, deps) {
  await authenticate(request, env, "schedules.view");
  const url = new URL(request.url);
  const timeZone = await setting(env, "timezone", DEFAULT_TIME_ZONE);
  const requested = text(url.searchParams.get("week"), 10) || localDate(Date.now(), timeZone);
  const startDate = mondayForDate(requested);
  const endDate = addCalendarDays(startDate, 6);
  const nextDate = addCalendarDays(startDate, 7);
  const startBoundary = scheduleInterval(startDate, "00:00", "00:01", timeZone).start;
  const endBoundary = scheduleInterval(nextDate, "00:00", "00:01", timeZone).start;
  await syncVehicleRegistry(env, deps);
  const [employees, vehicles, templates, schedules, draft, publication] = await Promise.all([
    env.DB.prepare(`SELECT id,full_name,role,employee_group,assigned_vehicle_id,uses_own_vehicle,active FROM app_users
      WHERE active=1 ORDER BY full_name COLLATE NOCASE`).all(),
    env.DB.prepare(`SELECT bike_id AS id,name,odometer,status FROM vehicle_registry
      WHERE NOT EXISTS (SELECT 1 FROM vehicle_archives va WHERE va.bike_id = vehicle_registry.bike_id AND va.active = 1)
      ORDER BY status='available' DESC,name COLLATE NOCASE`).all(),
    env.DB.prepare("SELECT * FROM shift_templates WHERE active=1 ORDER BY sort_order,name COLLATE NOCASE").all(),
    env.DB.prepare(`SELECT sc.*,u.full_name AS employee_name,
      CASE WHEN u.uses_own_vehicle=1 THEN '${OWN_VEHICLE_LABEL}' ELSE v.name END AS vehicle_name,
      sa.id AS assignment_id,sa.template_id,sa.work_date AS assignment_date,
      sa.notes AS assignment_notes,st.name AS template_name,st.color AS template_color,
      EXISTS(SELECT 1 FROM shifts sh WHERE sh.schedule_id=sc.id) AS has_shift
      FROM schedules sc JOIN app_users u ON u.id=sc.employee_id
      LEFT JOIN vehicle_registry v ON v.bike_id=sc.vehicle_id
      LEFT JOIN schedule_assignments sa ON sa.id=sc.series_id AND sa.status='planned'
      LEFT JOIN shift_templates st ON st.id=sa.template_id
      WHERE sc.start_at>=? AND sc.start_at<? AND sc.status NOT IN ('cancelled')
      ORDER BY u.full_name COLLATE NOCASE,sc.start_at`).bind(startBoundary, endBoundary).all(),
    readScheduleDraft(env, startDate),
    schedulePublication(env, startDate)
  ]);
  let mapped = (schedules.results || []).map((row) => ({
    ...row,
    managed_assignment: Boolean(row.assignment_id),
    has_shift: Boolean(row.has_shift),
    // Legacy rows often reused a series_id for several days.  The concrete
    // schedule row is the safe edit/delete target when no managed assignment
    // exists; never expose the shared legacy series as the UI action id.
    assignment_id: row.assignment_id || row.id,
    notes: row.assignment_notes == null ? row.notes : row.assignment_notes,
    work_date: row.assignment_date || localDate(row.start_at, timeZone),
    start_time: localClock(row.start_at, timeZone),
    end_time: localClock(row.end_at, timeZone),
    template_name: row.template_name || `${localClock(row.start_at, timeZone)} - ${localClock(row.end_at, timeZone)}`,
    template_color: /^#[0-9A-F]{6}$/i.test(String(row.template_color || "")) ? row.template_color : "#315D67"
  }));
  if (draft) mapped = await expandDraftRows(env, draft, timeZone);
  const missingVehicles = draft ? (await validateDraftAssignments(env, draft.assignments, startDate)).missingVehicles : [];
  const ackRows = publication ? await env.DB.prepare("SELECT COUNT(*) AS count FROM schedule_acknowledgements WHERE week_start=? AND revision=?").bind(startDate, Number(publication.revision || 0)).first() : null;
  return wfJson({
    weekStart: startDate,
    weekEnd: endDate,
    employees: employees.results || [],
    vehicles: vehicles.results || [],
    templates: (templates.results || []).map(templatePublic),
    schedules: mapped,
    draft: draft ? { state: "draft", updatedAt: draft.updated_at, baseRevision: draft.baseRevision, missingVehicles } : null,
    publication: publication ? { revision: Number(publication.revision || 0), publishedAt: publication.published_at, acknowledged: Number(ackRows?.count || 0) } : null,
    scheduleState: draft ? "draft" : publication ? "published" : "empty"
  });
}

async function createWeekAssignments(request, env, deps) {
  const actor = await authenticate(request, env, "schedules.manage");
  const body = await bodyJson(request);
  const assignments = Array.isArray(body.assignments) ? body.assignments.slice(0, 80) : [];
  if (!assignments.length) throw new ApiError(400, "Δεν έχεις επιλέξει καμία βάρδια για αποθήκευση.");
  if (body.draft === true) {
    const firstDate = text(assignments[0]?.date || assignments[0]?.workDate, 10);
    const weekStart = mondayForDate(firstDate);
    const replaceEmployeeId = text(body.replaceEmployeeId, 100);
    if (replaceEmployeeId && assignments.some((item) => text(item?.employeeId, 100) !== replaceEmployeeId)) {
      throw new ApiError(400, "Η καταχώρηση ανά διανομέα περιέχει διαφορετικούς εργαζομένους.");
    }
    const result = await saveScheduleDraft(env, actor, assignments, weekStart, { replaceEmployeeId });
    await audit(env, request, actor, "schedule_draft_saved", "schedule_week", weekStart, null, {
      assignments: result.assignments.length, missingVehicles: result.missingVehicles.length
    }, text(body.reason, 500), false);
    return wfJson({ created: result.assignments.length, scheduleRows: result.assignments.length, draft: result }, 201);
  }
  await syncVehicleRegistry(env, deps);
  const employeeIds = [...new Set(assignments.map((item) => text(item.employeeId, 100)).filter(Boolean))];
  const templateIds = [...new Set(assignments.map((item) => text(item.templateId, 100)).filter(Boolean))];
  if (!employeeIds.length || !templateIds.length) throw new ApiError(400, "Διάλεξε διανομέα και πρότυπο βάρδιας.");
  const employeePlaceholders = employeeIds.map(() => "?").join(",");
  const templatePlaceholders = templateIds.map(() => "?").join(",");
  const [employeeRows, templateRows] = await Promise.all([
    env.DB.prepare(`SELECT id,full_name,assigned_vehicle_id,uses_own_vehicle FROM app_users WHERE active=1 AND id IN (${employeePlaceholders})`).bind(...employeeIds).all(),
    env.DB.prepare(`SELECT * FROM shift_templates WHERE active=1 AND id IN (${templatePlaceholders})`).bind(...templateIds).all()
  ]);
  const employees = new Map((employeeRows.results || []).map((row) => [String(row.id), row]));
  const templates = new Map((templateRows.results || []).map((row) => [String(row.id), row]));
  const vehicleIds = new Set();
  assignments.forEach((item) => {
    const employee = employees.get(text(item.employeeId, 100));
    const vehicleId = effectiveScheduleVehicleId(item, employee);
    if (vehicleId) vehicleIds.add(vehicleId);
  });
  const vehicleIdList = [...vehicleIds];
  const vehicleRows = vehicleIdList.length
    ? await env.DB.prepare(`SELECT bike_id,name,status FROM vehicle_registry WHERE bike_id IN (${vehicleIdList.map(() => "?").join(",")})`).bind(...vehicleIdList).all()
    : { results: [] };
  const vehicles = new Map((vehicleRows.results || []).map((row) => [String(row.bike_id), row]));
  if (employees.size !== employeeIds.length) throw new ApiError(400, "Ένας ή περισσότεροι διανομείς δεν βρέθηκαν ή δεν είναι ενεργοί.");
  if (templates.size !== templateIds.length) throw new ApiError(400, "Ένα από τα πρότυπα βάρδιας δεν είναι πλέον ενεργό.");
  if (vehicles.size !== vehicleIds.size || [...vehicles.values()].some((vehicle) => ["service", "inactive"].includes(vehicle.status))) {
    throw new ApiError(400, "Ένα από τα επιλεγμένα μηχανάκια είναι σε service ή ανενεργό.", "vehicle_unavailable");
  }

  const prepared = [];
  const pendingIntervals = [];
  const seen = new Set();
  const timeZone = await setting(env, "timezone", DEFAULT_TIME_ZONE);
  const replaceEmployeeId = text(body.replaceEmployeeId, 100);
  let replaceScope = null;
  if (replaceEmployeeId) {
    const replaceWeekStart = mondayForDate(text(body.replaceWeekStart, 10));
    const replaceWeekEnd = addCalendarDays(replaceWeekStart, 6);
    if (!employees.has(replaceEmployeeId) || assignments.some((item) => text(item.employeeId, 100) !== replaceEmployeeId || text(item.date, 10) < replaceWeekStart || text(item.date, 10) > replaceWeekEnd)) {
      throw new ApiError(400, "Η αντικατάσταση εβδομάδας περιέχει μη έγκυρες αναθέσεις.");
    }
    replaceScope = {
      employeeId: replaceEmployeeId,
      startDate: replaceWeekStart,
      endDate: replaceWeekEnd,
      start: scheduleInterval(replaceWeekStart, "00:00", "00:01", timeZone).start,
      end: scheduleInterval(addCalendarDays(replaceWeekStart, 7), "00:00", "00:01", timeZone).start
    };
  }
  const normalized = [];
  for (const raw of assignments) {
    const employeeId = text(raw.employeeId, 100);
    const templateId = text(raw.templateId, 100);
    const workDate = text(raw.date, 10);
    const employee = employees.get(employeeId);
    const template = templates.get(templateId);
    if (!employee || !template || !/^\d{4}-\d{2}-\d{2}$/.test(workDate)) throw new ApiError(400, "Μία από τις αναθέσεις δεν είναι έγκυρη.");
    const vehicleId = effectiveScheduleVehicleId(raw, employee);
    const uniqueKey = employeeId + "|" + workDate + "|" + templateId;
    if (seen.has(uniqueKey)) continue;
    seen.add(uniqueKey);
    normalized.push({ employeeId, employeeName: employee.full_name, templateId, template, workDate, vehicleId,
      intervals: templateSegments(template.segments).map((segment) => scheduleInterval(workDate, segment.start, segment.end, timeZone)),
      notes: text(raw.notes, 500) });
  }
  const allIntervals = normalized.flatMap((item) => item.intervals);
  const existingRows = await loadScheduleConflictRows(env, allIntervals, employeeIds, vehicleIdList);
  const existingSchedules = existingRows.filter((row) => !(replaceScope
    && String(row.employee_id) === String(replaceScope.employeeId)
    && row.start_at >= replaceScope.start && row.start_at < replaceScope.end));
  for (const item of normalized) {
    const { employeeId, employeeName, templateId, template, workDate, vehicleId, intervals, notes } = item;
    const employee = employees.get(employeeId);

    for (const interval of intervals) {
      const ownPending = pendingIntervals.find((item) => String(item.employeeId) === employeeId && schedulesOverlap(interval, item));
      if (ownPending) throw new ApiError(409, `${employee.full_name} έχει δύο βάρδιες που επικαλύπτονται.`, "employee_schedule_conflict", {
        conflict: { kind: "employee", employeeId, employeeName: employee.full_name, date: workDate, startAt: interval.start, endAt: interval.end }
      });
      const existingEmployee = existingSchedules.find((row) => String(row.employee_id) === employeeId
        && schedulesOverlap(interval, { start: row.start_at, end: row.end_at }));
      if (existingEmployee) throw new ApiError(409, `${employee.full_name} έχει ήδη πρόγραμμα που επικαλύπτεται.`, "employee_schedule_conflict", {
        conflict: { kind: "employee", employeeId, employeeName: employee.full_name, date: workDate, startAt: interval.start, endAt: interval.end }
      });
    }

    if (vehicleId) {
      let conflict = null;
      for (const interval of intervals) {
        const pendingConflict = pendingIntervals.find((item) => String(item.vehicleId || "") === vehicleId && schedulesOverlap(interval, item));
        if (pendingConflict) {
          conflict = { employee_name: pendingConflict.employeeName, start_at: pendingConflict.start, end_at: pendingConflict.end };
          break;
        }
        const existingVehicle = existingSchedules.find((row) => String(row.vehicle_id || "") === vehicleId
          && schedulesOverlap(interval, { start: row.start_at, end: row.end_at }));
        if (existingVehicle) { conflict = existingVehicle; break; }
      }
      if (conflict) {
        const suggestions = await availableVehicleSuggestions(env, intervals, pendingIntervals, employee.assigned_vehicle_id || "", replaceScope);
        const vehicle = vehicles.get(vehicleId);
        throw new ApiError(409, `${vehicle?.name || "Το μηχανάκι"} χρησιμοποιείται ήδη από ${conflict.employee_name || "άλλον διανομέα"} την ίδια ώρα.`, "vehicle_schedule_conflict", {
          conflict: { kind: "vehicle", employeeId, employeeName: employee.full_name, date: workDate, vehicleId, vehicleName: vehicle?.name || "", startAt: intervals[0].start, endAt: intervals[intervals.length - 1].end },
          suggestedVehicles: suggestions
        });
      }
    }

    const assignmentId = uuid();
    prepared.push({ assignmentId, employeeId, employeeName, templateId, template, workDate, vehicleId, intervals, notes });
    intervals.forEach((interval) => pendingIntervals.push({ ...interval, employeeId, employeeName: employee.full_name, vehicleId }));
  }

  const statementCount = prepared.reduce((total, item) => total + 1 + item.intervals.length, 0) + (replaceScope ? 2 : 0);
  if (!prepared.length) throw new ApiError(400, "Δεν προέκυψε καμία νέα ανάθεση.");
  if (statementCount > 90) throw new ApiError(400, "Η μαζική αποθήκευση είναι πολύ μεγάλη. Αποθήκευσε λιγότερες ημέρες ή διανομείς κάθε φορά.", "schedule_batch_too_large");
  const now = nowIso();
  const statements = [];
  if (replaceScope) {
    statements.push(env.DB.prepare(`UPDATE schedule_assignments SET status='cancelled',updated_at=?
      WHERE employee_id=? AND work_date BETWEEN ? AND ? AND status='planned'`)
      .bind(now, replaceScope.employeeId, replaceScope.startDate, replaceScope.endDate));
    statements.push(env.DB.prepare(`UPDATE schedules SET status='cancelled',updated_at=? WHERE employee_id=?
      AND start_at>=? AND start_at<? AND status IN ('planned','awaiting')`)
      .bind(now, replaceScope.employeeId, replaceScope.start, replaceScope.end));
  }
  prepared.forEach((item) => {
    statements.push(env.DB.prepare(`INSERT INTO schedule_assignments
      (id,employee_id,template_id,work_date,vehicle_id,status,notes,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,'planned',?,?,?,?)`).bind(item.assignmentId, item.employeeId, item.templateId, item.workDate,
      item.vehicleId, item.notes, actor.user_id, now, now));
    item.intervals.forEach((interval) => {
      statements.push(env.DB.prepare(`INSERT INTO schedules
        (id,employee_id,vehicle_id,series_id,start_at,end_at,status,notes,created_by,created_at,updated_at)
        VALUES (?,?,?,?,?,?,'planned',?,?,?,?)`).bind(uuid(), item.employeeId, item.vehicleId, item.assignmentId,
        interval.start, interval.end, item.notes, actor.user_id, now, now));
    });
  });
  await env.DB.batch(statements);
  await audit(env, request, actor, replaceScope ? "employee_week_schedule_replaced" : "week_schedule_created", "schedule_week", prepared[0].workDate, null, {
    assignments: prepared.length,
    scheduleRows: prepared.reduce((total, item) => total + item.intervals.length, 0),
    employees: [...new Set(prepared.map((item) => item.employeeId))]
  }, text(body.reason, 500), false);
  return wfJson({ created: prepared.length, scheduleRows: prepared.reduce((total, item) => total + item.intervals.length, 0) }, 201);
}

const EDITABLE_SCHEDULE_STATUSES = new Set(["planned", "awaiting", "absent"]);

async function editableAssignmentSchedules(env, assignmentId) {
  const schedules = await env.DB.prepare("SELECT * FROM schedules WHERE series_id=? AND status<>'cancelled' ORDER BY start_at")
    .bind(assignmentId).all();
  const rows = schedules.results || [];
  if (!rows.length) throw new ApiError(404, "Η προγραμματισμένη βάρδια δεν βρέθηκε.");
  const linked = await env.DB.prepare(`SELECT COUNT(*) AS count FROM shifts sh
    JOIN schedules sc ON sc.id=sh.schedule_id WHERE sc.series_id=?`).bind(assignmentId).first();
  if (Number(linked?.count || 0) > 0 || rows.some((row) => !EDITABLE_SCHEDULE_STATUSES.has(String(row.status)))) {
    throw new ApiError(409, "Η βάρδια έχει ήδη συνδεθεί με πραγματική έναρξη ή λήξη. Επεξεργάσου την από την καρτέλα Βάρδιες.", "schedule_started");
  }
  return rows;
}

async function updateScheduleAssignment(request, env, deps, assignmentId) {
  const actor = await authenticate(request, env, "schedules.manage");
  const body = await bodyJson(request);
  const old = await env.DB.prepare("SELECT * FROM schedule_assignments WHERE id=? AND status='planned'").bind(assignmentId).first();
  if (!old) {
    // Upgrade a legacy schedule row lazily.  Older releases did not create a
    // schedule_assignments metadata row, and several days could share one
    // series_id.  Use the concrete row id plus employee/date supplied by the
    // client, and refuse the operation if a real shift is linked.
    const legacyEmployeeId = text(body.employeeId, 100);
    const legacyDate = text(body.date || body.workDate, 10);
    if (!legacyEmployeeId || !/^\d{4}-\d{2}-\d{2}$/.test(legacyDate)) throw new ApiError(400, "Δεν είναι δυνατή η ασφαλής αναγνώριση της παλιάς βάρδιας.");
    const timeZone = await setting(env, "timezone", DEFAULT_TIME_ZONE);
    const legacy = await env.DB.prepare(`SELECT sc.*,u.full_name AS employee_name FROM schedules sc JOIN app_users u ON u.id=sc.employee_id
      WHERE sc.id=? AND sc.employee_id=? AND sc.status IN ('planned','awaiting','absent')
      AND NOT EXISTS(SELECT 1 FROM shifts sh WHERE sh.schedule_id=sc.id)`).bind(assignmentId, legacyEmployeeId).first();
    if (!legacy) throw new ApiError(404, "Η παλιά βάρδια δεν βρέθηκε ή έχει ήδη ξεκινήσει.");
    const employeeId = legacyEmployeeId;
    const templateId = text(body.templateId, 100);
    const requestedVehicleId = body.vehicleId === undefined ? (legacy.vehicle_id || null) : (text(body.vehicleId, 100) || null);
    const template = templateId ? await env.DB.prepare("SELECT * FROM shift_templates WHERE id=? AND active=1").bind(templateId).first() : null;
    if (!template) throw new ApiError(400, "Διάλεξε ένα ενεργό πρότυπο βάρδιας για να διορθωθεί η παλιά βάρδια.");
    const employee = await env.DB.prepare("SELECT id,full_name,assigned_vehicle_id,uses_own_vehicle FROM app_users WHERE id=? AND active=1").bind(employeeId).first();
    if (!employee) throw new ApiError(400, "Ο διανομέας δεν βρέθηκε ή δεν είναι ενεργός.");
    const vehicleId = effectiveScheduleVehicleId({ vehicleId: requestedVehicleId, withoutVehicle: requestedVehicleId === "__no_vehicle__" }, employee);
    const vehicle = vehicleId ? await env.DB.prepare("SELECT bike_id,name,status FROM vehicle_registry WHERE bike_id=?").bind(vehicleId).first() : null;
    if (vehicleId && (!vehicle || ["service", "inactive"].includes(String(vehicle.status)))) {
      throw new ApiError(400, "Το επιλεγμένο μηχανάκι είναι σε service ή ανενεργό.", "vehicle_unavailable");
    }
    const intervals = templateSegments(template.segments).map((segment) => scheduleInterval(legacyDate, segment.start, segment.end, timeZone));
    for (const interval of intervals) {
      const conflict = await env.DB.prepare(`SELECT sc.id FROM schedules sc WHERE sc.id<>? AND sc.employee_id=?
        AND sc.status NOT IN ('cancelled','completed') AND sc.start_at<? AND sc.end_at>? LIMIT 1`)
        .bind(assignmentId, employeeId, interval.end, interval.start).first();
      if (conflict) throw new ApiError(409, "Ο διανομέας έχει ήδη επικαλυπτόμενο πρόγραμμα.", "employee_schedule_conflict");
    }
    if (vehicleId) {
      let vehicleConflict = null;
      for (const interval of intervals) {
        vehicleConflict = await env.DB.prepare(`SELECT sc.employee_id,sc.start_at,sc.end_at,u.full_name AS employee_name
          FROM schedules sc JOIN app_users u ON u.id=sc.employee_id
          WHERE sc.id<>? AND sc.vehicle_id=? AND sc.status NOT IN ('cancelled','completed')
            AND sc.start_at<? AND sc.end_at>? LIMIT 1`)
          .bind(assignmentId, vehicleId, interval.end, interval.start).first();
        if (vehicleConflict) break;
      }
      if (vehicleConflict) {
        const suggestions = await availableVehicleSuggestions(env, intervals, [], employee.assigned_vehicle_id || "", null, assignmentId);
        throw new ApiError(409, `${vehicle?.name || "Το μηχανάκι"} χρησιμοποιείται ήδη από ${vehicleConflict.employee_name || "άλλον διανομέα"} την ίδια ώρα.`, "vehicle_schedule_conflict", {
          conflict: { kind: "vehicle", employeeId, employeeName: employee.full_name, date: legacyDate, vehicleId, vehicleName: vehicle?.name || "", startAt: intervals[0].start, endAt: intervals[intervals.length - 1].end },
          suggestedVehicles: suggestions
        });
      }
    }
    const now = nowIso();
    const statements = [
      env.DB.prepare(`INSERT OR IGNORE INTO schedule_assignments
        (id,employee_id,template_id,work_date,vehicle_id,status,notes,created_by,created_at,updated_at)
        VALUES (?,?,?,?,?,'planned',?,?,?,?)`).bind(assignmentId, employeeId, templateId, legacyDate, vehicleId, text(body.notes, 500), actor.user_id, now, now),
      env.DB.prepare(`UPDATE schedules SET series_id=?,employee_id=?,vehicle_id=?,start_at=?,end_at=?,notes=?,status='planned',updated_at=?
        WHERE id=? AND NOT EXISTS(SELECT 1 FROM shifts WHERE schedule_id=schedules.id)`)
        .bind(assignmentId, employeeId, vehicleId, intervals[0].start, intervals[0].end, text(body.notes, 500), now, assignmentId)
    ];
    intervals.slice(1).forEach((interval) => {
      statements.push(env.DB.prepare(`INSERT INTO schedules
        (id,employee_id,vehicle_id,series_id,start_at,end_at,status,notes,created_by,created_at,updated_at)
        VALUES (?,?,?,?,?,?,'planned',?,?,?,?)`).bind(uuid(), employeeId, vehicleId, assignmentId,
        interval.start, interval.end, text(body.notes, 500), actor.user_id, now, now));
    });
    await env.DB.batch(statements);
    await audit(env, request, actor, "legacy_schedule_assignment_upgraded", "schedule_assignment", assignmentId, legacy, { employeeId, templateId, workDate: legacyDate, vehicleId }, text(body.reason, 500), false);
    return wfJson({ updated: true, legacyUpgraded: true, assignment: { id: assignmentId, employeeId, employeeName: employee.full_name, templateId, templateName: template.name, workDate: legacyDate, vehicleId, vehicleName: vehicle?.name || "", notes: text(body.notes, 500), scheduleRows: intervals.length } });
  }
  await editableAssignmentSchedules(env, assignmentId);
  await syncVehicleRegistry(env, deps);

  const employeeId = text(body.employeeId ?? old.employee_id, 100);
  const templateId = text(body.templateId ?? old.template_id, 100);
  const workDate = text(body.date ?? body.workDate ?? old.work_date, 10);
  const requestedVehicleId = body.vehicleId === undefined ? (old.vehicle_id || null) : (text(body.vehicleId, 100) || null);
  const notes = body.notes === undefined ? text(old.notes, 500) : text(body.notes, 500);
  if (!employeeId || !templateId || !/^\d{4}-\d{2}-\d{2}$/.test(workDate)) {
    throw new ApiError(400, "Διάλεξε διανομέα, ημερομηνία και πρότυπο βάρδιας.");
  }

  const [employee, template] = await Promise.all([
    env.DB.prepare("SELECT id,full_name,assigned_vehicle_id,uses_own_vehicle FROM app_users WHERE id=? AND active=1").bind(employeeId).first(),
    env.DB.prepare("SELECT * FROM shift_templates WHERE id=? AND active=1").bind(templateId).first()
  ]);
  if (!employee) throw new ApiError(400, "Ο διανομέας δεν βρέθηκε ή δεν είναι ενεργός.");
  if (!template) throw new ApiError(400, "Το πρότυπο βάρδιας δεν βρέθηκε ή δεν είναι ενεργό.");
  const vehicleId = effectiveScheduleVehicleId({ vehicleId: requestedVehicleId, withoutVehicle: requestedVehicleId === "__no_vehicle__" }, employee);
  const vehicle = vehicleId ? await env.DB.prepare("SELECT bike_id,name,status FROM vehicle_registry WHERE bike_id=?").bind(vehicleId).first() : null;
  if (vehicleId && (!vehicle || ["service", "inactive"].includes(vehicle.status))) {
    throw new ApiError(400, "Το επιλεγμένο μηχανάκι είναι σε service ή ανενεργό.", "vehicle_unavailable");
  }

  const timeZone = await setting(env, "timezone", DEFAULT_TIME_ZONE);
  const intervals = templateSegments(template.segments).map((segment) => scheduleInterval(workDate, segment.start, segment.end, timeZone));
  for (const interval of intervals) {
    const existingEmployee = await env.DB.prepare(`SELECT sc.id FROM schedules sc
      WHERE sc.employee_id=? AND sc.status NOT IN ('cancelled','completed') AND COALESCE(sc.series_id,'')<>?
      AND sc.start_at<? AND sc.end_at>? LIMIT 1`)
      .bind(employeeId, assignmentId, interval.end, interval.start).first();
    if (existingEmployee) throw new ApiError(409, `${employee.full_name} έχει ήδη πρόγραμμα που επικαλύπτεται.`, "employee_schedule_conflict", {
      conflict: { kind: "employee", employeeId, employeeName: employee.full_name, date: workDate, startAt: interval.start, endAt: interval.end }
    });
  }

  if (vehicleId) {
    let conflict = null;
    for (const interval of intervals) {
      conflict = await env.DB.prepare(`SELECT sc.employee_id,sc.start_at,sc.end_at,u.full_name AS employee_name
        FROM schedules sc JOIN app_users u ON u.id=sc.employee_id
        WHERE sc.vehicle_id=? AND sc.status NOT IN ('cancelled','completed') AND COALESCE(sc.series_id,'')<>?
        AND sc.start_at<? AND sc.end_at>? LIMIT 1`)
        .bind(vehicleId, assignmentId, interval.end, interval.start).first();
      if (conflict) break;
    }
    if (conflict) {
      const suggestions = await availableVehicleSuggestions(env, intervals, [], employee.assigned_vehicle_id || "", null, assignmentId);
      throw new ApiError(409, `${vehicle?.name || "Το μηχανάκι"} χρησιμοποιείται ήδη από ${conflict.employee_name || "άλλον διανομέα"} την ίδια ώρα.`, "vehicle_schedule_conflict", {
        conflict: { kind: "vehicle", employeeId, employeeName: employee.full_name, date: workDate, vehicleId, vehicleName: vehicle?.name || "", startAt: intervals[0].start, endAt: intervals[intervals.length - 1].end },
        suggestedVehicles: suggestions
      });
    }
  }

  const now = nowIso();
  const statements = [
    env.DB.prepare(`UPDATE schedule_assignments SET employee_id=?,template_id=?,work_date=?,vehicle_id=?,notes=?,updated_at=?
      WHERE id=? AND status='planned'`).bind(employeeId, templateId, workDate, vehicleId, notes, now, assignmentId),
    env.DB.prepare("UPDATE schedules SET status='cancelled',updated_at=? WHERE series_id=? AND status IN ('planned','awaiting','absent')")
      .bind(now, assignmentId)
  ];
  intervals.forEach((interval) => {
    statements.push(env.DB.prepare(`INSERT INTO schedules
      (id,employee_id,vehicle_id,series_id,start_at,end_at,status,notes,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'planned',?,?,?,?)`).bind(uuid(), employeeId, vehicleId, assignmentId,
      interval.start, interval.end, notes, actor.user_id, now, now));
  });
  await env.DB.batch(statements);
  const next = { id: assignmentId, employee_id: employeeId, template_id: templateId, work_date: workDate, vehicle_id: vehicleId, notes, status: "planned" };
  await audit(env, request, actor, "schedule_assignment_updated", "schedule_assignment", assignmentId, old, next, text(body.reason, 500), false);
  return wfJson({ updated: true, assignment: {
    id: assignmentId, employeeId, employeeName: employee.full_name, templateId, templateName: template.name,
    workDate, vehicleId, vehicleName: vehicle?.name || "", notes, scheduleRows: intervals.length
  } });
}

async function deleteScheduleAssignment(request, env, assignmentId) {
  const actor = await authenticate(request, env, "schedules.manage");
  const body = await bodyJson(request);
  const employeeId = text(body.employeeId, 100);
  const workDate = text(body.date, 10);
  const meta = await env.DB.prepare("SELECT * FROM schedule_assignments WHERE id=? AND status='planned'").bind(assignmentId).first();
  const now = nowIso();
  let statements;
  let object;
  let scheduleRows = [];
  if (meta) {
    await editableAssignmentSchedules(env, assignmentId);
    const rows = await env.DB.prepare("SELECT * FROM schedules WHERE series_id=? AND status IN ('planned','awaiting','absent') ORDER BY start_at")
      .bind(assignmentId).all();
    scheduleRows = rows.results || [];
    statements = [
      env.DB.prepare("UPDATE schedule_assignments SET status='cancelled',updated_at=? WHERE id=? AND status='planned'").bind(now, assignmentId),
      env.DB.prepare("UPDATE schedules SET status='cancelled',updated_at=? WHERE series_id=? AND status IN ('planned','awaiting','absent')").bind(now, assignmentId)
    ];
    object = meta;
  } else {
    if (!employeeId || !/^\d{4}-\d{2}-\d{2}$/.test(workDate)) throw new ApiError(400, "Δεν είναι δυνατή η ασφαλής αναγνώριση της βάρδιας.");
    const timeZone = await setting(env, "timezone", DEFAULT_TIME_ZONE);
    const start = scheduleInterval(workDate, "00:00", "00:01", timeZone).start;
    const end = scheduleInterval(addCalendarDays(workDate, 1), "00:00", "00:01", timeZone).start;
    const old = await env.DB.prepare(`SELECT sc.* FROM schedules sc WHERE (sc.series_id=? OR sc.id=?) AND sc.employee_id=?
      AND sc.start_at>=? AND sc.start_at<? AND sc.status IN ('planned','awaiting','absent')
      AND NOT EXISTS(SELECT 1 FROM shifts sh WHERE sh.schedule_id=sc.id) LIMIT 1`).bind(assignmentId, assignmentId, employeeId, start, end).first();
    if (!old) throw new ApiError(404, "Η προγραμματισμένη βάρδια δεν βρέθηκε ή έχει ήδη ξεκινήσει.");
    const rows = await env.DB.prepare(`SELECT sc.* FROM schedules sc WHERE (sc.series_id=? OR sc.id=?) AND sc.employee_id=?
      AND sc.start_at>=? AND sc.start_at<? AND sc.status IN ('planned','awaiting','absent')
      AND NOT EXISTS(SELECT 1 FROM shifts sh WHERE sh.schedule_id=sc.id) ORDER BY sc.start_at`)
      .bind(assignmentId, assignmentId, employeeId, start, end).all();
    scheduleRows = rows.results || [];
    statements = [env.DB.prepare(`UPDATE schedules SET status='cancelled',updated_at=? WHERE (series_id=? OR id=?)
      AND employee_id=? AND start_at>=? AND start_at<? AND status IN ('planned','awaiting','absent')
      AND NOT EXISTS(SELECT 1 FROM shifts sh WHERE sh.schedule_id=schedules.id)`).bind(now, assignmentId, assignmentId, employeeId, start, end)];
    object = old;
  }
  const reason = text(body.reason, 500) || "Διαγραφή προγραμματισμένης βάρδιας";
  const employee = await env.DB.prepare("SELECT full_name FROM app_users WHERE id=?").bind(object.employee_id || employeeId).first();
  const recycleId = uuid();
  const mutationCount = statements.length;
  statements.push(env.DB.prepare(`INSERT INTO deleted_records
    (id,record_type,record_id,label,payload,deleted_at,deleted_by,deleted_by_name,reason)
    VALUES (?,'schedule_assignment',?,?,?,?,?,?,?)`)
    .bind(recycleId, assignmentId,
      `${employee?.full_name || "Πρόγραμμα"} • ${meta?.work_date || workDate || localDate(scheduleRows[0]?.start_at || now, DEFAULT_TIME_ZONE)}`,
      JSON.stringify({ assignment: meta || null, schedules: scheduleRows }), now,
      String(actor.user_id || ""), text(actor.full_name || "", 120), reason));
  const results = await env.DB.batch(statements);
  if (!results.slice(0, mutationCount).some((result) => Number(result?.meta?.changes || 0) > 0)) {
    await env.DB.prepare("DELETE FROM deleted_records WHERE id=?").bind(recycleId).run();
    throw new ApiError(409, "Η βάρδια δεν μπορεί πλέον να διαγραφεί επειδή έχει ξεκινήσει.");
  }
  await audit(env, request, actor, "schedule_assignment_cancelled", "schedule_assignment", assignmentId, object, { status: "cancelled", recycleId }, reason, false);
  return wfJson({ deleted: true, recycleId });
}

async function listSchedules(request, env) {
  const actor = await authenticate(request, env, "schedules.view");
  const url = new URL(request.url);
  const from = text(url.searchParams.get("from"), 10) || localDate(Date.now(), DEFAULT_TIME_ZONE);
  const to = text(url.searchParams.get("to"), 10) || addCalendarDays(from, 13);
  const employeeId = text(url.searchParams.get("employeeId"), 100);
  const bounds = await localDateUtcBounds(env, from, to);
  const rows = await env.DB.prepare(`SELECT sc.*, u.full_name AS employee_name, u.uses_own_vehicle, u.assigned_vehicle_id,
    CASE WHEN u.uses_own_vehicle=1 THEN '${OWN_VEHICLE_LABEL}' ELSE v.name END AS vehicle_name
    FROM schedules sc JOIN app_users u ON u.id=sc.employee_id
    LEFT JOIN vehicle_registry v ON v.bike_id=sc.vehicle_id
    WHERE sc.start_at>=? AND sc.start_at<? AND (?='' OR sc.employee_id=?)
    ORDER BY sc.start_at, u.full_name`).bind(bounds.start, bounds.end, employeeId, employeeId).all();
  return wfJson({ schedules: rows.results || [] });
}

async function createSchedules(request, env, deps) {
  const actor = await authenticate(request, env, "schedules.manage");
  const body = await bodyJson(request);
  const employeeIds = Array.isArray(body.employeeIds) ? [...new Set(body.employeeIds.map((id) => text(id, 100)).filter(Boolean))].slice(0, 100) : [];
  if (!employeeIds.length) throw new ApiError(400, "Διάλεξε τουλάχιστον έναν εργαζόμενο.");
  const startDate = text(body.startDate, 10);
  const endDate = text(body.endDate, 10) || startDate;
  const startTime = text(body.startTime, 8);
  const endTime = text(body.endTime, 8);
  const timeZone = await setting(env, "timezone", DEFAULT_TIME_ZONE);
  const weekdays = Array.isArray(body.weekdays) ? body.weekdays.map((day) => integer(day, 0, 6, -1)).filter((day) => day >= 0) : [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(startTime) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(endTime) || startTime === endTime) {
    throw new ApiError(400, "Συμπλήρωσε σωστά ημερομηνίες και ώρες.");
  }
  const employeePlaceholders = employeeIds.map(() => "?").join(",");
  const employeeRows = await env.DB.prepare(`SELECT id,full_name,assigned_vehicle_id,uses_own_vehicle FROM app_users WHERE active=1 AND id IN (${employeePlaceholders})`).bind(...employeeIds).all();
  const employees = new Map((employeeRows.results || []).map((row) => [String(row.id), row]));
  if (employees.size !== employeeIds.length) throw new ApiError(400, "Ένας ή περισσότεροι εργαζόμενοι δεν είναι ενεργοί ή δεν βρέθηκαν.");
  const vehicleByEmployee = new Map(employeeIds.map((employeeId) => [employeeId, effectiveScheduleVehicleId(body, employees.get(employeeId))]));
  const vehicleIds = [...new Set([...vehicleByEmployee.values()].filter(Boolean))];
  const vehicles = new Map();
  if (vehicleIds.length) {
    await syncVehicleRegistry(env, deps);
    const vehicleRows = await env.DB.prepare(`SELECT bike_id,name,status FROM vehicle_registry WHERE bike_id IN (${vehicleIds.map(() => "?").join(",")})`).bind(...vehicleIds).all();
    (vehicleRows.results || []).forEach((row) => vehicles.set(String(row.bike_id), row));
    if (vehicles.size !== vehicleIds.length || [...vehicles.values()].some((vehicle) => ["service", "inactive"].includes(String(vehicle.status)))) {
      throw new ApiError(400, "Το προανατεθειμένο μηχανάκι δεν είναι διαθέσιμο για πρόγραμμα.", "vehicle_unavailable");
    }
  }
  const days = Math.floor((new Date(`${endDate}T12:00:00Z`) - new Date(`${startDate}T12:00:00Z`)) / 86400000);
  if (days < 0 || days > 180) throw new ApiError(400, "Το πρόγραμμα μπορεί να δημιουργηθεί για έως 180 ημέρες.");
  const selectedDates = [];
  for (let offset = 0; offset <= days; offset += 1) {
    const date = addCalendarDays(startDate, offset);
    if (!weekdays.length || weekdays.includes(weekdayForDate(date))) selectedDates.push(date);
  }
  if (!selectedDates.length) throw new ApiError(400, "Δεν προέκυψε καμία βάρδια από τις ημέρες που επέλεξες.");
  const totalRows = selectedDates.length * employeeIds.length;
  if (totalRows > 40) {
    throw new ApiError(400, "Η μαζική δημιουργία υποστηρίζει έως 40 βάρδιες κάθε φορά. Χώρισε το διάστημα σε μικρότερα τμήματα.", "schedule_batch_too_large");
  }
  const intervals = selectedDates.map((date) => ({ date, ...scheduleInterval(date, startTime, endTime, timeZone) }));
  const existingRows = await loadScheduleConflictRows(env, intervals, [], vehicleIds);
  const seriesId = uuid();
  const now = nowIso();
  const statements = [];
  const created = [];
  const pendingIntervals = [];
  for (const item of intervals) {
    const { date, start, end } = item;
    for (const employeeId of employeeIds) {
      const vehicleId = vehicleByEmployee.get(employeeId) || null;
      if (vehicleId) {
        const pendingConflict = pendingIntervals.find((pending) => String(pending.vehicleId) === vehicleId && schedulesOverlap(item, pending));
        const existingConflict = existingRows.find((row) => String(row.vehicle_id || "") === vehicleId
          && schedulesOverlap(item, { start: row.start_at, end: row.end_at }));
        const conflict = pendingConflict || existingConflict;
        if (conflict) {
          const vehicle = vehicles.get(vehicleId);
          throw new ApiError(409, `${vehicle?.name || "Το μηχανάκι"} χρησιμοποιείται ήδη από ${conflict.employeeName || conflict.employee_name || "άλλον διανομέα"} την ίδια ώρα.`, "vehicle_schedule_conflict", {
            conflict: { kind: "vehicle", employeeId, employeeName: employees.get(employeeId)?.full_name || "", date, vehicleId, vehicleName: vehicle?.name || "", startAt: start, endAt: end }
          });
        }
        pendingIntervals.push({ ...item, vehicleId, employeeId, employeeName: employees.get(employeeId)?.full_name || "" });
      }
      const id = uuid();
      created.push(id);
      statements.push(env.DB.prepare(`INSERT INTO schedules
        (id,employee_id,vehicle_id,series_id,start_at,end_at,status,notes,created_by,created_at,updated_at)
        VALUES (?,?,?,?,?,?,'planned',?,?,?,?)`)
        .bind(id, employeeId, vehicleId, seriesId, start, end,
          text(body.notes, 500), actor.user_id, now, now));
    }
  }
  if (!statements.length) throw new ApiError(400, "Δεν προέκυψε καμία βάρδια από τις ημέρες που επέλεξες.");
  await env.DB.batch(statements);
  await audit(env, request, actor, "schedule_created", "schedule_series", seriesId, null, {
    count: created.length, startDate, endDate, startTime, endTime, employeeIds, weekdays
  }, text(body.reason, 500), false);
  return wfJson({ created: created.length, seriesId }, 201);
}

async function listShifts(request, env) {
  const actor = await authenticate(request, env, "shifts.view");
  const url = new URL(request.url);
  const from = text(url.searchParams.get("from"), 10) || addCalendarDays(localDate(Date.now(), DEFAULT_TIME_ZONE), -7);
  const to = text(url.searchParams.get("to"), 10) || addCalendarDays(from, 14);
  const status = text(url.searchParams.get("status"), 40);
  const employeeId = text(url.searchParams.get("employeeId"), 100);
  const bounds = await localDateUtcBounds(env, from, to);
  const rows = await env.DB.prepare(`SELECT s.*, u.full_name AS employee_name,
    CASE WHEN u.uses_own_vehicle=1 OR substr(s.current_vehicle_id,1,16)='__own_vehicle__:'
      THEN '${OWN_VEHICLE_LABEL}' ELSE v.name END AS vehicle_name,
    sc.start_at AS scheduled_start, sc.end_at AS scheduled_end
    FROM shifts s JOIN app_users u ON u.id=s.employee_id
    LEFT JOIN vehicle_registry v ON v.bike_id=s.current_vehicle_id
    LEFT JOIN schedules sc ON sc.id=s.schedule_id
    WHERE s.actual_clock_in>=? AND s.actual_clock_in<? AND (?='' OR s.status=?) AND (?='' OR s.employee_id=?)
    ORDER BY s.actual_clock_in DESC LIMIT 1000`)
    .bind(bounds.start, bounds.end, status, status, employeeId, employeeId).all();
  return wfJson({ shifts: (rows.results || []).map((row) => shiftPublic(row, actor)) });
}

async function manualClockIn(request, env, deps) {
  const actor = await authenticate(request, env, "shifts.manage");
  const pinUsed = await requirePin(request, env, deps, actor);
  const body = await bodyJson(request);
  const scheduleId = text(body.scheduleId, 100);
  const actualClockIn = isoTimestamp(body.actualClockIn);
  const reason = text(body.reason, 500);
  if (!scheduleId || !actualClockIn || !reason) {
    throw new ApiError(400, "Διάλεξε προγραμματισμένη βάρδια, ώρα Clock In και αιτιολογία.");
  }
  if (new Date(actualClockIn).getTime() > Date.now() + 2 * 60 * 1000) {
    throw new ApiError(400, "Το χειροκίνητο Clock In δεν μπορεί να είναι μελλοντικό.");
  }

  const schedule = await env.DB.prepare(`SELECT sc.*, u.full_name, u.uses_own_vehicle, u.assigned_vehicle_id,
    CASE WHEN u.uses_own_vehicle=1 THEN '${OWN_VEHICLE_LABEL}' ELSE v.name END AS vehicle_name
    FROM schedules sc JOIN app_users u ON u.id=sc.employee_id
    LEFT JOIN vehicle_registry v ON v.bike_id=sc.vehicle_id
    WHERE sc.id=? AND u.active=1`).bind(scheduleId).first();
  if (!schedule) throw new ApiError(404, "Η προγραμματισμένη βάρδια ή ο εργαζόμενος δεν βρέθηκε.");
  if (!["planned", "awaiting", "absent"].includes(String(schedule.status))) {
    throw new ApiError(409, "Η συγκεκριμένη προγραμματισμένη βάρδια δεν μπορεί να ξεκινήσει χειροκίνητα.", "schedule_not_available");
  }
  await assertPayrollOpen(env, actualClockIn.slice(0, 10));

  const [existingShift, existingEmployeeShift] = await Promise.all([
    env.DB.prepare("SELECT id,status FROM shifts WHERE schedule_id=? AND status<>'cancelled' LIMIT 1").bind(scheduleId).first(),
    env.DB.prepare("SELECT id,status FROM shifts WHERE employee_id=? AND status='active' LIMIT 1").bind(schedule.employee_id).first()
  ]);
  if (existingShift) throw new ApiError(409, "Η προγραμματισμένη βάρδια έχει ήδη καταχωρημένη πραγματική βάρδια.", "shift_exists");
  if (existingEmployeeShift) throw new ApiError(409, "Ο εργαζόμενος έχει ήδη ενεργή βάρδια.", "shift_exists");

  const now = nowIso();
  const startMs = new Date(schedule.start_at).getTime();
  const endMs = new Date(schedule.end_at).getTime();
  const outOfSchedule = Number.isFinite(startMs) && Number.isFinite(endMs) &&
    (new Date(actualClockIn).getTime() < startMs || new Date(actualClockIn).getTime() > endMs) ? 1 : 0;
  const ownVehicle = bool(schedule.uses_own_vehicle);
  const shiftId = uuid();
  let vehicleId = null;
  let vehicle = null;
  let initialKm = 0;

  if (ownVehicle) {
    vehicleId = ownVehicleShiftId(schedule.employee_id);
  } else {
    await syncVehicleRegistry(env, deps);
    const requestedVehicleId = text(body.vehicleId, 100);
    const assignedVehicleId = text(schedule.vehicle_id, 100) || text(schedule.assigned_vehicle_id, 100);
    vehicleId = assignedVehicleId || requestedVehicleId;
    if (!vehicleId) throw new ApiError(400, "Διάλεξε το μηχανάκι της χειροκίνητης βάρδιας.");
    if (assignedVehicleId && requestedVehicleId && assignedVehicleId !== requestedVehicleId) {
      throw new ApiError(403, "Η προγραμματισμένη βάρδια έχει διαφορετικά ανατεθειμένο μηχανάκι.");
    }
    vehicle = await env.DB.prepare(`SELECT * FROM vehicle_registry WHERE bike_id=?
      AND NOT EXISTS (SELECT 1 FROM vehicle_archives va WHERE va.bike_id=vehicle_registry.bike_id AND va.active=1)`).bind(vehicleId).first();
    if (!vehicle) throw new ApiError(404, "Το μηχανάκι δεν βρέθηκε.");
    if (vehicle.status !== "available") throw new ApiError(409, "Το μηχανάκι δεν είναι διαθέσιμο αυτή τη στιγμή.", "vehicle_taken");
    const requestedInitial = body.initialKm === undefined || body.initialKm === null || body.initialKm === ""
      ? Number(vehicle.odometer) : integer(body.initialKm, 0, 2_000_000_000, -1);
    if (requestedInitial < Number(vehicle.odometer)) {
      throw new ApiError(409, "Τα αρχικά χιλιόμετρα δεν μπορεί να είναι μικρότερα από το official odometer.", "invalid_km");
    }
    initialKm = requestedInitial;
  }

  const statements = [
    ownVehicle
      ? env.DB.prepare(`INSERT INTO shifts
        (id,employee_id,schedule_id,vehicle_id,current_vehicle_id,status,actual_clock_in,initial_km,out_of_schedule,notes,created_at,updated_at)
        VALUES (?,?,?,?,?,'active',?,?,?,?,?,?)`).bind(
        shiftId, schedule.employee_id, scheduleId, vehicleId, vehicleId, actualClockIn, 0, outOfSchedule,
        `Χειροκίνητο Clock In από Admin — ${reason}`, now, now)
      : env.DB.prepare(`INSERT INTO shifts
        (id,employee_id,schedule_id,vehicle_id,current_vehicle_id,status,actual_clock_in,initial_km,out_of_schedule,notes,created_at,updated_at)
        SELECT ?,?,?,bike_id,bike_id,'active',?,?,?,?,?,?
        FROM vehicle_registry WHERE bike_id=? AND status='available'`).bind(
        shiftId, schedule.employee_id, scheduleId, actualClockIn, initialKm, outOfSchedule,
        `Χειροκίνητο Clock In από Admin — ${reason}`, now, now, vehicleId),
    ...(ownVehicle ? [] : [
      env.DB.prepare("UPDATE vehicle_registry SET status='in_use',active_shift_id=?,version=version+1,updated_at=? WHERE bike_id=? AND status='available'")
        .bind(shiftId, now, vehicleId),
      env.DB.prepare(`INSERT INTO vehicle_segments (id,shift_id,vehicle_id,started_at,initial_km,changed_by,reason)
        VALUES (?,?,?,?,?,?,?)`).bind(uuid(), shiftId, vehicleId, actualClockIn, initialKm, actor.user_id, `Χειροκίνητο Clock In από Admin — ${reason}`)
    ]),
    env.DB.prepare("UPDATE schedules SET status='working',updated_at=? WHERE id=? AND status IN ('planned','awaiting','absent')")
      .bind(now, scheduleId)
  ];
  const result = await env.DB.batch(statements);
  if (!Number(result[0]?.meta?.changes || 0)) throw new ApiError(409, "Η βάρδια δημιουργήθηκε ήδη ή το μηχανάκι μόλις δεσμεύτηκε.", "shift_exists");
  if (!ownVehicle && initialKm > Number(vehicle.odometer)) {
    await env.DB.prepare("UPDATE vehicle_registry SET odometer=?,version=version+1,updated_at=? WHERE bike_id=? AND odometer<=?")
      .bind(initialKm, now, vehicleId, initialKm).run();
    await updateFleetOdometer(env, deps, vehicleId, initialKm,
      localDate(actualClockIn, await setting(env, "timezone", DEFAULT_TIME_ZONE)), `${shiftId}-manual-start`);
  }
  await audit(env, request, actor, "admin_manual_clock_in", "shift", shiftId, null, {
    employeeId: schedule.employee_id, scheduleId, actualClockIn, vehicleId: ownVehicle ? null : vehicleId,
    initialKm: ownVehicle ? null : initialKm, outOfSchedule: Boolean(outOfSchedule)
  }, reason, pinUsed);
  return wfJson({
    created: true,
    shift: { id: shiftId, employeeId: schedule.employee_id, scheduleId, status: "active",
      actualClockIn, vehicleId: ownVehicle ? null : vehicleId, vehicleName: ownVehicle ? OWN_VEHICLE_LABEL : vehicle.name,
      ownVehicle, initialKm: ownVehicle ? null : initialKm, outOfSchedule: Boolean(outOfSchedule) }
  }, 201);
}

async function assertPayrollOpen(env, date) {
  const period = mondayPeriod(new Date(`${date}T12:00:00Z`), await setting(env, "timezone", DEFAULT_TIME_ZONE));
  const row = await env.DB.prepare("SELECT * FROM payroll_periods WHERE start_date=? AND end_date=?").bind(period.startDate, period.endDate).first();
  if (row && row.status === "locked") throw new ApiError(409, "Η μισθοδοσία αυτής της εβδομάδας είναι κλειδωμένη.", "payroll_locked");
  return { period, row };
}

function optionalOvertimeRateCents(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = integer(value, 0, 1_000_000, -1);
  if (parsed < 0) throw new ApiError(400, "Η τιμή υπερωρίας πρέπει να είναι μη αρνητικό ποσό ανά ώρα.");
  return parsed;
}

function optionalOvertimeMinutes(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = integer(value, 0, 720, -1);
  if (parsed < 0) throw new ApiError(400, "Τα εγκεκριμένα λεπτά υπερωρίας πρέπει να είναι από 0 έως 720.");
  return parsed;
}

function approvedOvertimeEnd(shift, actualEnd) {
  const actualMs = new Date(actualEnd || "").getTime();
  const scheduledMs = new Date(shift?.scheduled_end || "").getTime();
  const override = shift?.overtime_minutes_override;
  if (!Number.isFinite(actualMs) || !Number.isFinite(scheduledMs) || override == null || override === "") return actualEnd;
  const capMs = scheduledMs + integer(override, 0, 720, 0) * 60_000;
  return new Date(Math.min(actualMs, capMs)).toISOString();
}

async function replaceShiftPay(env, shift, user, endAt, options = {}) {
  const { rule, breakdown } = await calculateShiftPay(env, user, shift, endAt, options);
  const statements = [
    env.DB.prepare("DELETE FROM payroll_segments WHERE shift_id=?").bind(shift.id),
    env.DB.prepare(`UPDATE shifts SET effective_clock_out=?, payable_clock_in=?, payable_clock_out=?, payable_minutes=?,
      rule_id=?, rule_version=?, rule_snapshot=?, base_pay_cents=?, special_pay_cents=?, final_pay_cents=?, updated_at=? WHERE id=?`)
      .bind(endAt, breakdown.payableStart, breakdown.payableEnd, breakdown.payableMinutes, rule.id, rule.version,
        JSON.stringify(rule), breakdown.basePayCents, breakdown.specialPayCents, breakdown.totalPayCents, nowIso(), shift.id),
    ...breakdown.segments.map((segment) => env.DB.prepare(`INSERT INTO payroll_segments
      (id,shift_id,special_rate_id,label,start_at,end_at,minutes,rate_cents,amount_cents)
      VALUES (?,?,?,?,?,?,?,?,?)`).bind(uuid(), shift.id, segment.specialRateId, segment.label, segment.start,
      segment.end, segment.minutes, segment.rateCents, segment.amountCents))
  ];
  await env.DB.batch(statements);
  return breakdown;
}

async function shiftAction(request, env, deps, shiftId, action) {
  const overtimeAction = action === "approve-overtime" || action === "reject-overtime";
  const permission = action === "vehicle" ? "shifts.vehicle.change" : "shifts.manage";
  const actor = await authenticate(request, env, overtimeAction ? "" : permission);
  if (overtimeAction && !hasPermission(actor.permissions, "shifts.manage") && !hasPermission(actor.permissions, "payroll.manage")) {
    await audit(env, request, actor, "unauthorized_attempt", "permission", "overtime_approval", null, null, "", false);
    throw new ApiError(403, "Δεν έχεις δικαίωμα έγκρισης υπερωρίας.", "forbidden");
  }
  const pinUsed = await requirePin(request, env, deps, actor);
  const body = await bodyJson(request);
  const shift = await env.DB.prepare(`SELECT s.*, u.full_name, u.role, u.permissions, u.employee_group, u.pay_rule_id,
    sc.start_at AS scheduled_start, sc.end_at AS scheduled_end,
    CASE WHEN u.uses_own_vehicle=1 OR substr(s.current_vehicle_id,1,16)='__own_vehicle__:'
      THEN '${OWN_VEHICLE_LABEL}' ELSE v.name END AS vehicle_name, v.odometer AS vehicle_odometer
    FROM shifts s JOIN app_users u ON u.id=s.employee_id
    LEFT JOIN schedules sc ON sc.id=s.schedule_id LEFT JOIN vehicle_registry v ON v.bike_id=s.current_vehicle_id
    WHERE s.id=?`).bind(shiftId).first();
  if (!shift) throw new ApiError(404, "Η βάρδια δεν βρέθηκε.");
  await assertPayrollOpen(env, String(shift.actual_clock_in).slice(0, 10));
  const reason = text(body.reason, 500);
  if (!reason) throw new ApiError(400, "Χρειάζεται αιτιολογία.");
  const employee = { ...shift, user_id: shift.employee_id };
  const ownVehicle = isOwnVehicleShiftId(shift.current_vehicle_id || shift.vehicle_id);
  if (ownVehicle && (action === "kilometers" || action === "vehicle")) {
    throw new ApiError(409, "Η βάρδια χρησιμοποιεί ιδιόκτητο μηχανάκι και δεν έχει καταγραφή χιλιομέτρων ή αλλαγή μηχανής.", "own_vehicle");
  }
  const old = shiftPublic(shift, actor);

  if (action === "delete") {
    if (!bool(body.confirmDelete)) throw new ApiError(400, "Χρειάζεται επιβεβαίωση διαγραφής.");
    const now = nowIso();
    const [rawShift, vehicleRows, payrollRows, correctionRows, scheduleRow] = await Promise.all([
      env.DB.prepare("SELECT * FROM shifts WHERE id=?").bind(shiftId).first(),
      env.DB.prepare("SELECT * FROM vehicle_segments WHERE shift_id=? ORDER BY started_at,id").bind(shiftId).all(),
      env.DB.prepare("SELECT * FROM payroll_segments WHERE shift_id=? ORDER BY start_at,id").bind(shiftId).all(),
      env.DB.prepare("SELECT id FROM correction_requests WHERE shift_id=?").bind(shiftId).all(),
      shift.schedule_id ? env.DB.prepare("SELECT * FROM schedules WHERE id=?").bind(shift.schedule_id).first() : Promise.resolve(null)
    ]);
    const recycleId = uuid();
    const archivePayload = {
      shift: rawShift,
      vehicleSegments: vehicleRows.results || [],
      payrollSegments: payrollRows.results || [],
      correctionIds: (correctionRows.results || []).map((row) => row.id),
      schedule: scheduleRow || null,
      fleetHistory: []
    };
    const statements = [
      env.DB.prepare(`INSERT INTO deleted_records
        (id,record_type,record_id,label,payload,deleted_at,deleted_by,deleted_by_name,reason)
        VALUES (?,'shift',?,?,?,?,?,?,?)`)
        .bind(recycleId, shiftId, `${shift.full_name || "Βάρδια"} • ${shift.vehicle_name || "Χωρίς μηχανάκι"}`,
          JSON.stringify(archivePayload), now, String(actor.user_id || ""), text(actor.full_name || "", 120), reason),
      env.DB.prepare("DELETE FROM payroll_segments WHERE shift_id=?").bind(shiftId),
      env.DB.prepare("DELETE FROM vehicle_segments WHERE shift_id=?").bind(shiftId),
      env.DB.prepare("UPDATE correction_requests SET shift_id=NULL WHERE shift_id=?").bind(shiftId),
      env.DB.prepare("UPDATE system_alerts SET resolved=1,resolved_by=?,resolved_at=? WHERE object_type='shift' AND object_id=? AND resolved=0")
        .bind(actor.user_id, now, shiftId)
    ];
    if (shift.status === "active") {
      statements.push(env.DB.prepare("UPDATE vehicle_registry SET status='available',active_shift_id=NULL,version=version+1,updated_at=? WHERE active_shift_id=?")
        .bind(now, shiftId));
    }
    if (shift.schedule_id) {
      statements.push(env.DB.prepare(`UPDATE schedules SET status=CASE
        WHEN end_at < ? THEN 'absent' WHEN start_at <= ? THEN 'awaiting' ELSE 'planned' END, updated_at=? WHERE id=?`)
        .bind(now, now, now, shift.schedule_id));
    }
    statements.push(env.DB.prepare("DELETE FROM shifts WHERE id=?").bind(shiftId));
    const results = await env.DB.batch(statements);
    if (!Number(results[results.length - 1]?.meta?.changes || 0)) throw new ApiError(409, "Η βάρδια έχει ήδη διαγραφεί.");
    const removedFleetHistory = await removeShiftFleetHistory(env, deps, shiftId);
    if (removedFleetHistory.length) {
      archivePayload.fleetHistory = removedFleetHistory;
      await env.DB.prepare("UPDATE deleted_records SET payload=? WHERE id=? AND restored_at IS NULL")
        .bind(JSON.stringify(archivePayload), recycleId).run();
    }
    await audit(env, request, actor, "shift_deleted", "shift", shiftId, old, { recycleId }, reason, pinUsed);
    return wfJson({ deleted: true, id: shiftId, recycleId });
  }

  if (action === "edit") {
    if (ownVehicle) {
      const actualClockIn = isoTimestamp(body.actualClockIn);
      const notes = text(body.notes, 500);
      const finalProvided = body.finalKm !== undefined && body.finalKm !== null && body.finalKm !== "";
      if (!actualClockIn || finalProvided) throw new ApiError(400, "Συμπλήρωσε σωστά την ώρα έναρξης. Οι βάρδιες με ιδιόκτητο μηχανάκι δεν έχουν χιλιόμετρα.");
      await assertPayrollOpen(env, actualClockIn.slice(0, 10));
      if (shift.status === "active") {
        if (body.actualClockOut) throw new ApiError(400, "Η ενεργή βάρδια δεν μπορεί να έχει ώρα λήξης.");
        const now = nowIso();
        const result = await env.DB.prepare("UPDATE shifts SET actual_clock_in=?,notes=?,updated_at=? WHERE id=? AND status='active'")
          .bind(actualClockIn, notes, now, shiftId).run();
        if (!Number(result?.meta?.changes || 0)) throw new ApiError(409, "Η βάρδια δεν είναι πλέον ενεργή.");
        await audit(env, request, actor, "shift_edited", "shift", shiftId, old,
          { ...old, actualClockIn, notes, ownVehicle: true }, reason, pinUsed);
        return wfJson({ updated: true, active: true, ownVehicle: true });
      }
      const actualClockOut = isoTimestamp(body.actualClockOut || shift.actual_clock_out || shift.effective_clock_out);
      if (!actualClockOut || new Date(actualClockOut).getTime() <= new Date(actualClockIn).getTime()) {
        throw new ApiError(400, "Η ώρα λήξης πρέπει να είναι μετά την ώρα έναρξης.");
      }
      const scheduledEnd = isoTimestamp(shift.scheduled_end);
      const overtime = Boolean(scheduledEnd && new Date(actualClockOut).getTime() > new Date(scheduledEnd).getTime());
      let overtimeStatus = shift.overtime_status || "none";
      let effectiveEnd = actualClockOut;
      let nextStatus = "completed";
      if (!overtime) overtimeStatus = "none";
      else if (overtimeStatus === "rejected") effectiveEnd = scheduledEnd;
      else if (overtimeStatus !== "approved") {
        overtimeStatus = "pending";
        effectiveEnd = scheduledEnd;
        nextStatus = "pending_overtime";
      }
      const approvedOvertime = overtime && overtimeStatus === "approved";
      const adjustedShift = { ...shift, actual_clock_in: actualClockIn };
      if (approvedOvertime) effectiveEnd = approvedOvertimeEnd(adjustedShift, actualClockOut);
      const { rule, breakdown } = await calculateShiftPay(env, employee, adjustedShift, effectiveEnd,
        approvedOvertime ? { overtimeStart: scheduledEnd, overtimeRateCents: shift.overtime_rate_cents == null ? null : Number(shift.overtime_rate_cents), hardEndAt: shift.overtime_minutes_override == null ? null : effectiveEnd } : { hardEndAt: overtime ? scheduledEnd : null });
      const now = nowIso();
      const statements = [
        env.DB.prepare("DELETE FROM payroll_segments WHERE shift_id=?").bind(shiftId),
        env.DB.prepare(`UPDATE shifts SET status=?,actual_clock_in=?,actual_clock_out=?,effective_clock_out=?,
          payable_clock_in=?,payable_clock_out=?,payable_minutes=?,initial_km=0,final_km=NULL,shift_km=NULL,
          rule_id=?,rule_version=?,rule_snapshot=?,base_pay_cents=?,special_pay_cents=?,final_pay_cents=?,
          overtime_status=?,overtime_rate_cents=?,overtime_minutes_override=?,overtime_approved_by=?,overtime_approved_by_name=?,overtime_approved_at=?,
          missing_km=0,notes=?,updated_at=? WHERE id=?`)
          .bind(nextStatus, actualClockIn, actualClockOut, effectiveEnd, breakdown.payableStart, breakdown.payableEnd,
            breakdown.payableMinutes, rule.id, rule.version, JSON.stringify(rule), breakdown.basePayCents,
            breakdown.specialPayCents, breakdown.totalPayCents, overtimeStatus,
            approvedOvertime ? shift.overtime_rate_cents : null,
            approvedOvertime ? shift.overtime_minutes_override : null,
            approvedOvertime ? shift.overtime_approved_by : null,
            approvedOvertime ? (shift.overtime_approved_by_name || "") : "",
            approvedOvertime ? shift.overtime_approved_at : null,
            notes, now, shiftId),
        ...breakdown.segments.map((segment) => env.DB.prepare(`INSERT INTO payroll_segments
          (id,shift_id,special_rate_id,label,start_at,end_at,minutes,rate_cents,amount_cents)
          VALUES (?,?,?,?,?,?,?,?,?)`).bind(uuid(), shiftId, segment.specialRateId, segment.label, segment.start,
          segment.end, segment.minutes, segment.rateCents, segment.amountCents))
      ];
      if (shift.schedule_id) {
        statements.push(env.DB.prepare("UPDATE schedules SET status=?,updated_at=? WHERE id=?")
          .bind(nextStatus === "completed" ? "completed" : "pending_correction", now, shift.schedule_id));
      }
      await env.DB.batch(statements);
      if (overtimeStatus === "pending") {
        const message = `${shift.full_name} • ${OWN_VEHICLE_LABEL} • Actual Clock Out ${actualClockOut}.`;
        await createAlert(env, "overtime", "warning", "Έγκριση υπερωρίας", message, "shift", shiftId, `overtime:${shiftId}`);
        await createAlert(env, "forgotten_clock_out", "warning", "Ξεχασμένο Clock Out", message, "shift", shiftId, `forgotten:${shiftId}`);
      } else {
        await env.DB.prepare("UPDATE system_alerts SET resolved=1,resolved_by=?,resolved_at=? WHERE object_type='shift' AND object_id=? AND type IN ('overtime','forgotten_clock_out') AND resolved=0")
          .bind(actor.user_id, now, shiftId).run();
      }
      await audit(env, request, actor, "shift_edited", "shift", shiftId, old,
        { ...old, status: nextStatus, actualClockIn, actualClockOut, effectiveClockOut: effectiveEnd, ownVehicle: true, notes }, reason, pinUsed);
      return wfJson({ updated: true, status: nextStatus, ownVehicle: true });
    }
    const actualClockIn = isoTimestamp(body.actualClockIn);
    const initialKm = integer(body.initialKm, 0, 2_000_000_000, -1);
    const notes = text(body.notes, 500);
    if (!actualClockIn || initialKm < 0) throw new ApiError(400, "Συμπλήρωσε σωστά ώρα έναρξης και αρχικά χιλιόμετρα.");
    await assertPayrollOpen(env, actualClockIn.slice(0, 10));
    const segmentRows = await env.DB.prepare("SELECT * FROM vehicle_segments WHERE shift_id=? ORDER BY started_at,id").bind(shiftId).all();
    const segments = segmentRows.results || [];
    if (!segments.length) throw new ApiError(409, "Δεν βρέθηκε το ιστορικό μηχανής της βάρδιας.");
    const firstSegment = segments[0];
    const lastSegment = segments[segments.length - 1];
    const finalProvided = body.finalKm !== undefined && body.finalKm !== null && body.finalKm !== "";

    if (shift.status === "active") {
      if (body.actualClockOut || finalProvided) throw new ApiError(400, "Η ενεργή βάρδια δεν μπορεί να έχει ώρα λήξης ή τελικά χιλιόμετρα.");
      if (firstSegment.final_km != null && initialKm > Number(firstSegment.final_km)) {
        throw new ApiError(409, "Τα αρχικά χιλιόμετρα δεν μπορεί να ξεπερνούν τα χιλιόμετρα αλλαγής μηχανής.", "invalid_km");
      }
      const initialVehicle = await env.DB.prepare("SELECT odometer FROM vehicle_registry WHERE bike_id=?").bind(firstSegment.vehicle_id).first();
      if (segments.length === 1 && initialKm < Number(initialVehicle?.odometer || 0)) {
        throw new ApiError(409, "Τα αρχικά χιλιόμετρα δεν μπορεί να είναι μικρότερα από το official odometer.", "invalid_km");
      }
      const now = nowIso();
      const statements = [
        env.DB.prepare("UPDATE vehicle_segments SET started_at=?,initial_km=?,changed_by=?,reason=? WHERE id=?")
          .bind(actualClockIn, initialKm, actor.user_id, reason, firstSegment.id),
        env.DB.prepare("UPDATE shifts SET actual_clock_in=?,initial_km=?,notes=?,updated_at=? WHERE id=? AND status='active'")
          .bind(actualClockIn, initialKm, notes, now, shiftId)
      ];
      if (segments.length === 1 && initialKm > Number(initialVehicle?.odometer || 0)) {
        statements.push(env.DB.prepare("UPDATE vehicle_registry SET odometer=?,version=version+1,updated_at=? WHERE bike_id=? AND odometer<=?")
          .bind(initialKm, now, firstSegment.vehicle_id, initialKm));
      }
      const results = await env.DB.batch(statements);
      if (!Number(results[1]?.meta?.changes || 0)) throw new ApiError(409, "Η βάρδια δεν είναι πλέον ενεργή.");
      if (segments.length === 1 && initialKm > Number(initialVehicle?.odometer || 0)) {
        await updateFleetOdometer(env, deps, firstSegment.vehicle_id, initialKm,
          localDate(actualClockIn, await setting(env, "timezone", DEFAULT_TIME_ZONE)), `${shift.id}-start-edit`);
      }
      await audit(env, request, actor, "shift_edited", "shift", shiftId, old,
        { ...old, actualClockIn, initialKm, notes }, reason, pinUsed);
      return wfJson({ updated: true, active: true });
    }

    const actualClockOut = isoTimestamp(body.actualClockOut || shift.actual_clock_out || shift.effective_clock_out);
    if (!actualClockOut || new Date(actualClockOut).getTime() <= new Date(actualClockIn).getTime()) {
      throw new ApiError(400, "Η ώρα λήξης πρέπει να είναι μετά την ώρα έναρξης.");
    }
    const finalKm = finalProvided ? integer(body.finalKm, 0, 2_000_000_000, -1)
      : shift.final_km == null ? null : Number(shift.final_km);
    const lastInitialKm = firstSegment.id === lastSegment.id ? initialKm : Number(lastSegment.initial_km);
    if (finalKm != null && (finalKm < 0 || finalKm < lastInitialKm)) {
      throw new ApiError(409, "Τα τελικά χιλιόμετρα δεν μπορεί να είναι μικρότερα από τα αρχικά.", "invalid_km");
    }
    if (firstSegment.final_km != null && firstSegment.id !== lastSegment.id && initialKm > Number(firstSegment.final_km)) {
      throw new ApiError(409, "Τα αρχικά χιλιόμετρα δεν μπορεί να ξεπερνούν τα χιλιόμετρα αλλαγής μηχανής.", "invalid_km");
    }
    const currentVehicle = await env.DB.prepare("SELECT odometer FROM vehicle_registry WHERE bike_id=?").bind(lastSegment.vehicle_id).first();
    if (finalKm != null && shift.final_km != null && finalKm !== Number(shift.final_km) && finalKm < Number(currentVehicle?.odometer || 0)) {
      throw new ApiError(409, "Δεν μπορείς να μειώσεις ιστορική ένδειξη κάτω από το σημερινό official odometer.", "invalid_km");
    }
    const adjustedSegments = segments.map((segment) => ({ ...segment }));
    adjustedSegments[0].initial_km = initialKm;
    adjustedSegments[adjustedSegments.length - 1].final_km = finalKm;
    const shiftDistance = finalKm == null ? null : adjustedSegments.reduce((total, segment) => {
      return total + (segment.final_km == null ? 0 : Math.max(0, Number(segment.final_km) - Number(segment.initial_km)));
    }, 0);
    const scheduledEnd = isoTimestamp(shift.scheduled_end);
    const overtime = Boolean(scheduledEnd && new Date(actualClockOut).getTime() > new Date(scheduledEnd).getTime());
    let overtimeStatus = shift.overtime_status;
    let effectiveEnd = actualClockOut;
    let nextStatus = finalKm == null ? "pending_km" : "completed";
    if (!overtime) overtimeStatus = "none";
    else if (overtimeStatus === "rejected") effectiveEnd = scheduledEnd;
    else if (overtimeStatus !== "approved") {
      overtimeStatus = "pending";
      effectiveEnd = scheduledEnd;
      if (finalKm != null) nextStatus = "pending_overtime";
    }
    const approvedOvertime = overtime && overtimeStatus === "approved";
    const adjustedShift = { ...shift, actual_clock_in: actualClockIn };
    if (approvedOvertime) effectiveEnd = approvedOvertimeEnd(adjustedShift, actualClockOut);
    const { rule, breakdown } = await calculateShiftPay(env, employee, adjustedShift, effectiveEnd,
      approvedOvertime ? { overtimeStart: scheduledEnd, overtimeRateCents: shift.overtime_rate_cents == null ? null : Number(shift.overtime_rate_cents), hardEndAt: shift.overtime_minutes_override == null ? null : effectiveEnd } : { hardEndAt: overtime ? scheduledEnd : null });
    const now = nowIso();
    const statements = [
      env.DB.prepare("UPDATE vehicle_segments SET started_at=?,initial_km=?,changed_by=?,reason=? WHERE id=?")
        .bind(actualClockIn, initialKm, actor.user_id, reason, firstSegment.id),
      env.DB.prepare("UPDATE vehicle_segments SET ended_at=?,final_km=?,changed_by=?,reason=? WHERE id=?")
        .bind(actualClockOut, finalKm, actor.user_id, reason, lastSegment.id),
      env.DB.prepare("DELETE FROM payroll_segments WHERE shift_id=?").bind(shiftId),
      env.DB.prepare(`UPDATE shifts SET status=?,actual_clock_in=?,actual_clock_out=?,effective_clock_out=?,
        payable_clock_in=?,payable_clock_out=?,payable_minutes=?,initial_km=?,final_km=?,shift_km=?,
        rule_id=?,rule_version=?,rule_snapshot=?,base_pay_cents=?,special_pay_cents=?,final_pay_cents=?,
        overtime_status=?,overtime_rate_cents=?,overtime_minutes_override=?,overtime_approved_by=?,overtime_approved_by_name=?,overtime_approved_at=?,
        missing_km=?,notes=?,updated_at=? WHERE id=?`)
        .bind(nextStatus, actualClockIn, actualClockOut, effectiveEnd, breakdown.payableStart, breakdown.payableEnd,
          breakdown.payableMinutes, initialKm, finalKm, shiftDistance, rule.id, rule.version, JSON.stringify(rule),
          breakdown.basePayCents, breakdown.specialPayCents, breakdown.totalPayCents, overtimeStatus,
          approvedOvertime ? shift.overtime_rate_cents : null,
          approvedOvertime ? shift.overtime_minutes_override : null,
          approvedOvertime ? shift.overtime_approved_by : null,
          approvedOvertime ? (shift.overtime_approved_by_name || "") : "",
          approvedOvertime ? shift.overtime_approved_at : null,
          finalKm == null ? 1 : 0, notes, now, shiftId),
      ...breakdown.segments.map((segment) => env.DB.prepare(`INSERT INTO payroll_segments
        (id,shift_id,special_rate_id,label,start_at,end_at,minutes,rate_cents,amount_cents)
        VALUES (?,?,?,?,?,?,?,?,?)`).bind(uuid(), shiftId, segment.specialRateId, segment.label, segment.start,
        segment.end, segment.minutes, segment.rateCents, segment.amountCents))
    ];
    if (finalKm != null && finalKm > Number(currentVehicle?.odometer || 0)) {
      statements.push(env.DB.prepare("UPDATE vehicle_registry SET odometer=?,version=version+1,updated_at=? WHERE bike_id=? AND odometer<=?")
        .bind(finalKm, now, lastSegment.vehicle_id, finalKm));
    }
    if (shift.schedule_id) {
      statements.push(env.DB.prepare("UPDATE schedules SET status=?,updated_at=? WHERE id=?")
        .bind(nextStatus === "completed" ? "completed" : "pending_correction", now, shift.schedule_id));
    }
    await env.DB.batch(statements);
    if (finalKm == null) {
      await createAlert(env, "missing_km", "critical", "Εκκρεμούν χιλιόμετρα", `${shift.full_name} • ${shift.vehicle_name}`, "shift", shiftId, `missing-km:${shiftId}`);
    } else {
      await env.DB.prepare("UPDATE system_alerts SET resolved=1,resolved_by=?,resolved_at=? WHERE object_type='shift' AND object_id=? AND type='missing_km' AND resolved=0")
        .bind(actor.user_id, now, shiftId).run();
      await updateFleetOdometer(env, deps, lastSegment.vehicle_id, finalKm,
        localDate(actualClockOut, await setting(env, "timezone", DEFAULT_TIME_ZONE)), shift.id);
    }
    if (overtimeStatus === "pending") {
      const message = `${shift.full_name} • ${shift.vehicle_name} • Actual Clock Out ${actualClockOut}.`;
      await createAlert(env, "overtime", "warning", "Έγκριση υπερωρίας", message, "shift", shiftId, `overtime:${shiftId}`);
      await createAlert(env, "forgotten_clock_out", "warning", "Ξεχασμένο Clock Out", message, "shift", shiftId, `forgotten:${shiftId}`);
    } else {
      await env.DB.prepare("UPDATE system_alerts SET resolved=1,resolved_by=?,resolved_at=? WHERE object_type='shift' AND object_id=? AND type IN ('overtime','forgotten_clock_out') AND resolved=0")
        .bind(actor.user_id, now, shiftId).run();
    }
    await audit(env, request, actor, "shift_edited", "shift", shiftId, old,
      { ...old, status: nextStatus, actualClockIn, actualClockOut, effectiveClockOut: effectiveEnd,
        initialKm, finalKm, shiftKm: shiftDistance, notes }, reason, pinUsed);
    return wfJson({ updated: true, status: nextStatus });
  }

  if (action === "approve-overtime" || action === "reject-overtime") {
    if (shift.overtime_status !== "pending") throw new ApiError(409, "Δεν υπάρχει εκκρεμής υπερωρία.");
    const approved = action === "approve-overtime";
    const overtimeRateCents = approved ? optionalOvertimeRateCents(body.overtimeRateCents) : null;
    const overtimeMinutes = approved ? optionalOvertimeMinutes(body.overtimeMinutes) : null;
    const now = nowIso();
    if (shift.status === "active") {
      if (approved) {
        await env.DB.batch([
          env.DB.prepare(`UPDATE shifts SET overtime_status='approved',overtime_rate_cents=?,overtime_minutes_override=?,overtime_approved_by=?
            ,overtime_approved_by_name=?,overtime_approved_at=?,updated_at=?
            WHERE id=? AND status='active' AND overtime_status='pending'`).bind(
            overtimeRateCents, overtimeMinutes, actor.user_id, text(actor.full_name, 120), now, now, shiftId),
          env.DB.prepare("UPDATE system_alerts SET resolved=1,resolved_by=?,resolved_at=? WHERE object_type='shift' AND object_id=? AND type IN ('overtime','forgotten_clock_out') AND resolved=0").bind(actor.user_id, now, shiftId)
        ]);
        await audit(env, request, actor, "active_overtime_approved", "shift", shiftId, old,
          { status: "active", overtimeStatus: "approved", overtimeRateCents, overtimeMinutes,
            approvedBy: actor.user_id, approvedByName: actor.full_name }, reason, pinUsed);
        return wfJson({ updated: true, active: true, overtimeStatus: "approved", overtimeRateCents, overtimeMinutes, approvedBy: actor.full_name });
      }
      if (!shift.scheduled_end) throw new ApiError(409, "Δεν υπάρχει προγραμματισμένη ώρα λήξης.");
      const breakdown = await replaceShiftPay(env, shift, employee, shift.scheduled_end, { hardEndAt: shift.scheduled_end });
      if (ownVehicle) {
        await env.DB.batch([
          env.DB.prepare(`UPDATE shifts SET status='completed',overtime_status='rejected',effective_clock_out=?,
            automatic_closed_at=?,overtime_rate_cents=NULL,overtime_minutes_override=NULL,overtime_approved_by=NULL,overtime_approved_by_name='',
            overtime_approved_at=NULL,missing_km=0,updated_at=? WHERE id=? AND status='active'`)
            .bind(shift.scheduled_end, now, now, shiftId),
          ...(shift.schedule_id ? [env.DB.prepare("UPDATE schedules SET status='completed',updated_at=? WHERE id=?").bind(now, shift.schedule_id)] : []),
          env.DB.prepare("UPDATE system_alerts SET resolved=1,resolved_by=?,resolved_at=? WHERE object_type='shift' AND object_id=? AND type IN ('overtime','forgotten_clock_out') AND resolved=0").bind(actor.user_id, now, shiftId)
        ]);
        await audit(env, request, actor, "active_overtime_rejected", "shift", shiftId, old,
          { status: "completed", effectiveClockOut: shift.scheduled_end, overtimeStatus: "rejected", ownVehicle: true }, reason, pinUsed);
        return wfJson({ updated: true, active: false, ownVehicle: true, overtimeStatus: "rejected" });
      }
      await env.DB.batch([
        env.DB.prepare(`UPDATE shifts SET status='pending_km',overtime_status='rejected',effective_clock_out=?,
          automatic_closed_at=?,payable_minutes=?,overtime_rate_cents=NULL,overtime_minutes_override=NULL,overtime_approved_by=NULL,overtime_approved_by_name='',
          overtime_approved_at=NULL,missing_km=1,updated_at=? WHERE id=? AND status='active'`)
          .bind(shift.scheduled_end, now, breakdown.payableMinutes, now, shiftId),
        env.DB.prepare("UPDATE vehicle_registry SET status='available',active_shift_id=NULL,version=version+1,updated_at=? WHERE bike_id=? AND active_shift_id=?")
          .bind(now, shift.current_vehicle_id, shiftId),
        env.DB.prepare("UPDATE vehicle_segments SET ended_at=?,changed_by=?,reason=? WHERE shift_id=? AND ended_at IS NULL")
          .bind(shift.scheduled_end, actor.user_id, reason, shiftId),
        ...(shift.schedule_id ? [env.DB.prepare("UPDATE schedules SET status='pending_correction',updated_at=? WHERE id=?").bind(now, shift.schedule_id)] : []),
        env.DB.prepare("UPDATE system_alerts SET resolved=1,resolved_by=?,resolved_at=? WHERE object_type='shift' AND object_id=? AND type IN ('overtime','forgotten_clock_out') AND resolved=0").bind(actor.user_id, now, shiftId)
      ]);
      await createAlert(env, "missing_km", "critical", "Εκκρεμούν χιλιόμετρα", `${shift.full_name} • ${shift.vehicle_name}`, "shift", shiftId, `missing-km:${shiftId}`);
      await audit(env, request, actor, "active_overtime_rejected", "shift", shiftId, old,
        { status: "pending_km", effectiveClockOut: shift.scheduled_end, overtimeStatus: "rejected" }, reason, pinUsed);
      return wfJson({ updated: true, active: false, missingKm: true, overtimeStatus: "rejected" });
    }
    const approvedShift = approved ? { ...shift, overtime_minutes_override: overtimeMinutes } : shift;
    const endAt = approved ? approvedOvertimeEnd(approvedShift, shift.actual_clock_out) : shift.scheduled_end;
    if (!endAt) throw new ApiError(409, "Δεν υπάρχει διαθέσιμη ώρα λήξης.");
    const breakdown = await replaceShiftPay(env, shift, employee, endAt,
      approved ? { overtimeStart: shift.scheduled_end, overtimeRateCents, hardEndAt: overtimeMinutes == null ? null : endAt } : { hardEndAt: shift.scheduled_end });
    const nextStatus = !ownVehicle && bool(shift.missing_km) ? "pending_km" : "completed";
    await env.DB.prepare(`UPDATE shifts SET status=?, overtime_status=?, effective_clock_out=?,
      payable_minutes=?, base_pay_cents=?, special_pay_cents=?, final_pay_cents=?, overtime_rate_cents=?, overtime_minutes_override=?, overtime_approved_by=?,
      overtime_approved_by_name=?, overtime_approved_at=?, updated_at=? WHERE id=?`)
      .bind(nextStatus, approved ? "approved" : "rejected", endAt, breakdown.payableMinutes, breakdown.basePayCents,
        breakdown.specialPayCents, breakdown.totalPayCents,
        approved ? overtimeRateCents : null, approved ? overtimeMinutes : null, approved ? actor.user_id : null,
        approved ? text(actor.full_name, 120) : "", approved ? now : null, now, shiftId).run();
    if (shift.schedule_id) {
      await env.DB.prepare("UPDATE schedules SET status=?,updated_at=? WHERE id=?").bind(nextStatus === "completed" ? "completed" : "pending_correction", now, shift.schedule_id).run();
    }
    await env.DB.prepare("UPDATE system_alerts SET resolved=1,resolved_by=?,resolved_at=? WHERE object_type='shift' AND object_id=? AND type IN ('overtime','forgotten_clock_out') AND resolved=0")
      .bind(actor.user_id, now, shiftId).run();
    await audit(env, request, actor, approved ? "overtime_approved" : "overtime_rejected", "shift", shiftId,
      old, { endAt, pay: breakdown.totalPayCents, overtimeRateCents: approved ? overtimeRateCents : null,
        overtimeMinutes: approved ? overtimeMinutes : null,
        approvedBy: approved ? actor.user_id : null, approvedByName: approved ? actor.full_name : null }, reason, pinUsed);
    return wfJson({ updated: true, status: nextStatus, overtimeStatus: approved ? "approved" : "rejected",
      overtimeRateCents: approved ? overtimeRateCents : null, overtimeMinutes: approved ? overtimeMinutes : null,
      approvedBy: approved ? actor.full_name : null });
  }

  if (action === "kilometers") {
    const finalKm = integer(body.finalKm, 0, 2_000_000_000, -1);
    const latestSegment = await env.DB.prepare(`SELECT initial_km FROM vehicle_segments
      WHERE shift_id=? AND vehicle_id=? ORDER BY started_at DESC LIMIT 1`)
      .bind(shiftId, shift.current_vehicle_id).first();
    if (!shift.missing_km || finalKm < Number(latestSegment?.initial_km ?? shift.initial_km) || finalKm < Number(shift.vehicle_odometer || 0)) {
      await createAlert(env, "invalid_km", "warning", "Απορρίφθηκαν μη έγκυρα χιλιόμετρα", `${shift.full_name} • ${shift.vehicle_name} • ${finalKm} χλμ.`, "shift", shiftId, `invalid-km:${shiftId}`);
      throw new ApiError(409, "Τα χιλιόμετρα δεν είναι έγκυρα ή δεν εκκρεμούν.");
    }
    const shiftDistance = await totalShiftDistance(env, shiftId, shift.current_vehicle_id, finalKm);
    const now = nowIso();
    await env.DB.batch([
      env.DB.prepare("UPDATE shifts SET status=CASE WHEN overtime_status='pending' THEN 'pending_overtime' ELSE 'completed' END, final_km=?, shift_km=?, missing_km=0, updated_at=? WHERE id=?")
        .bind(finalKm, shiftDistance, now, shiftId),
      env.DB.prepare("UPDATE vehicle_registry SET odometer=?,version=version+1,updated_at=? WHERE bike_id=? AND odometer<=?")
        .bind(finalKm, now, shift.current_vehicle_id, finalKm),
      env.DB.prepare("UPDATE vehicle_segments SET final_km=? WHERE shift_id=? AND final_km IS NULL").bind(finalKm, shiftId),
      env.DB.prepare("UPDATE system_alerts SET resolved=1,resolved_by=?,resolved_at=? WHERE object_type='shift' AND object_id=? AND type='missing_km'")
        .bind(actor.user_id, now, shiftId)
    ]);
    await updateFleetOdometer(env, deps, shift.current_vehicle_id, finalKm,
      localDate(now, await setting(env, "timezone", DEFAULT_TIME_ZONE)), shift.id);
    await audit(env, request, actor, "shift_kilometers_added", "shift", shiftId, old, { finalKm }, reason, pinUsed);
    return wfJson({ updated: true });
  }

  if (action === "close") {
    if (shift.status !== "active") throw new ApiError(409, "Η βάρδια δεν είναι ενεργή.");
    const effectiveEnd = text(body.effectiveClockOut, 30) || shift.scheduled_end;
    if (!effectiveEnd) throw new ApiError(400, "Χρειάζεται ώρα λήξης.");
    const breakdown = await replaceShiftPay(env, shift, employee, effectiveEnd);
    const now = nowIso();
    if (ownVehicle) {
      await env.DB.batch([
        env.DB.prepare(`UPDATE shifts SET status='completed', effective_clock_out=?, automatic_closed_at=?,
          missing_km=0, updated_at=? WHERE id=? AND status='active'`)
          .bind(effectiveEnd, now, now, shiftId),
        ...(shift.schedule_id ? [env.DB.prepare("UPDATE schedules SET status='completed',updated_at=? WHERE id=?").bind(now, shift.schedule_id)] : []),
        env.DB.prepare("UPDATE system_alerts SET resolved=1,resolved_by=?,resolved_at=? WHERE object_type='shift' AND object_id=? AND type IN ('overtime','forgotten_clock_out') AND resolved=0")
          .bind(actor.user_id, now, shiftId)
      ]);
      await audit(env, request, actor, "shift_closed_by_admin", "shift", shiftId, old,
        { effectiveEnd, ownVehicle: true, missingKm: false }, reason, pinUsed);
      return wfJson({ updated: true, ownVehicle: true });
    }
    await env.DB.batch([
      env.DB.prepare(`UPDATE shifts SET status='pending_km', effective_clock_out=?, automatic_closed_at=?,
        payable_minutes=?, missing_km=1, updated_at=? WHERE id=? AND status='active'`)
        .bind(effectiveEnd, now, breakdown.payableMinutes, now, shiftId),
      env.DB.prepare("UPDATE vehicle_registry SET status='available',active_shift_id=NULL,version=version+1,updated_at=? WHERE bike_id=? AND active_shift_id=?")
        .bind(now, shift.current_vehicle_id, shiftId),
      env.DB.prepare("UPDATE vehicle_segments SET ended_at=?,changed_by=?,reason=? WHERE shift_id=? AND ended_at IS NULL")
        .bind(effectiveEnd, actor.user_id, reason, shiftId)
    ]);
    await createAlert(env, "missing_km", "critical", "Εκκρεμούν χιλιόμετρα", `${shift.full_name} • ${shift.vehicle_name}`, "shift", shiftId, `missing-km:${shiftId}`);
    await audit(env, request, actor, "shift_closed_by_admin", "shift", shiftId, old, { effectiveEnd, missingKm: true }, reason, pinUsed);
    return wfJson({ updated: true });
  }

  if (action === "vehicle") {
    if (shift.status !== "active") throw new ApiError(409, "Η βάρδια δεν είναι ενεργή.");
    const newVehicleId = text(body.vehicleId, 100);
    const oldFinalKm = integer(body.currentKm, 0, 2_000_000_000, -1);
    if (!newVehicleId || oldFinalKm < Number(shift.vehicle_odometer || shift.initial_km)) throw new ApiError(400, "Συμπλήρωσε σωστά μηχανάκι και χιλιόμετρα.");
    const next = await env.DB.prepare("SELECT * FROM vehicle_registry WHERE bike_id=? AND status='available'").bind(newVehicleId).first();
    if (!next) throw new ApiError(409, "Το νέο μηχανάκι δεν είναι διαθέσιμο.");
    const now = nowIso();
    const result = await env.DB.batch([
      env.DB.prepare("UPDATE vehicle_segments SET ended_at=?,final_km=?,changed_by=?,reason=? WHERE shift_id=? AND ended_at IS NULL")
        .bind(now, oldFinalKm, actor.user_id, reason, shiftId),
      env.DB.prepare("UPDATE vehicle_registry SET odometer=?,status='available',active_shift_id=NULL,version=version+1,updated_at=? WHERE bike_id=? AND active_shift_id=?")
        .bind(oldFinalKm, now, shift.current_vehicle_id, shiftId),
      env.DB.prepare("UPDATE vehicle_registry SET status='in_use',active_shift_id=?,version=version+1,updated_at=? WHERE bike_id=? AND status='available'")
        .bind(shiftId, now, newVehicleId),
      env.DB.prepare("UPDATE shifts SET current_vehicle_id=?,updated_at=? WHERE id=? AND status='active'").bind(newVehicleId, now, shiftId),
      env.DB.prepare(`INSERT INTO vehicle_segments (id,shift_id,vehicle_id,started_at,initial_km,changed_by,reason)
        VALUES (?,?,?,?,?,?,?)`).bind(uuid(), shiftId, newVehicleId, now, Number(next.odometer), actor.user_id, reason)
    ]);
    if (!Number(result[2]?.meta?.changes || 0) || !Number(result[3]?.meta?.changes || 0)) {
      throw new ApiError(409, "Το νέο μηχανάκι μόλις δεσμεύτηκε από άλλο χρήστη.", "vehicle_taken");
    }
    await updateFleetOdometer(env, deps, shift.current_vehicle_id, oldFinalKm,
      localDate(now, await setting(env, "timezone", DEFAULT_TIME_ZONE)), `${shift.id}-segment`);
    await audit(env, request, actor, "shift_vehicle_changed", "shift", shiftId, { vehicleId: shift.current_vehicle_id, km: shift.vehicle_odometer }, { vehicleId: newVehicleId, km: next.odometer }, reason, pinUsed);
    return wfJson({ updated: true });
  }
  throw new ApiError(404, "Η ενέργεια δεν υποστηρίζεται.");
}

function rulePublic(row, special = []) {
  return {
    id: row.id,
    name: row.name,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    version: Number(row.version),
    priority: Number(row.priority),
    normalRateCents: Number(row.normal_rate_cents),
    startRoundMode: row.start_round_mode,
    startRoundMinutes: Number(row.start_round_minutes),
    lateGraceMinutes: Number(row.late_grace_minutes || 0),
    lateClockOutGraceMinutes: Number(row.late_clock_out_grace_minutes == null ? 30 : row.late_clock_out_grace_minutes),
    endRoundMode: row.end_round_mode,
    endRoundMinutes: Number(row.end_round_minutes),
    durationRoundMode: "none",
    payableIncrementMinutes: 1,
    minimumMinutes: Number(row.minimum_minutes),
    maximumMinutes: Number(row.maximum_minutes),
    validFrom: row.valid_from || null,
    validUntil: row.valid_until || null,
    active: bool(row.active),
    specialRates: special.map((item) => ({
      id: item.id, label: item.label, startTime: item.start_time, endTime: item.end_time,
      rateCents: Number(item.rate_cents), capacity: item.capacity == null ? null : Number(item.capacity),
      qualification: item.qualification, priority: Number(item.priority), active: bool(item.active)
    }))
  };
}

async function listPayRules(request, env) {
  await authenticate(request, env, "payroll.view");
  const rows = await env.DB.prepare("SELECT * FROM pay_rules ORDER BY active DESC, priority DESC, name").all();
  const result = [];
  for (const row of rows.results || []) {
    const special = await env.DB.prepare("SELECT * FROM special_rates WHERE pay_rule_id=? ORDER BY priority DESC,start_time").bind(row.id).all();
    result.push(rulePublic(row, special.results || []));
  }
  return wfJson({ rules: result });
}

async function listSpecialRateAssignments(request, env) {
  await authenticate(request, env, "payroll.view");
  const date = text(new URL(request.url).searchParams.get("date"), 10) || localDate(Date.now(), DEFAULT_TIME_ZONE);
  const rows = await env.DB.prepare(`SELECT a.special_rate_id,a.employee_id,a.date,a.assigned_by,a.created_at,
    sr.label,r.name AS rule_name,u.full_name AS employee_name
    FROM special_rate_assignments a JOIN special_rates sr ON sr.id=a.special_rate_id
    JOIN pay_rules r ON r.id=sr.pay_rule_id JOIN app_users u ON u.id=a.employee_id
    WHERE a.date=? ORDER BY r.name,sr.start_time,u.full_name`).bind(date).all();
  return wfJson({ date, assignments: rows.results || [] });
}

async function saveSpecialRateAssignments(request, env, deps) {
  const actor = await authenticate(request, env, "payroll.manage");
  const pinUsed = await requirePin(request, env, deps, actor);
  const body = await bodyJson(request);
  const specialRateId = text(body.specialRateId, 100);
  const date = text(body.date, 10);
  const employeeIds = Array.isArray(body.employeeIds) ? [...new Set(body.employeeIds.map((id) => text(id, 100)).filter(Boolean))].slice(0, 40) : [];
  if (!specialRateId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ApiError(400, "Διάλεξε ειδική ζώνη και ημερομηνία.");
  await assertPayrollOpen(env, date);
  const rate = await env.DB.prepare("SELECT * FROM special_rates WHERE id=? AND active=1 AND qualification='manual'").bind(specialRateId).first();
  if (!rate) throw new ApiError(404, "Η χειροκίνητη ειδική ζώνη δεν βρέθηκε.");
  if (rate.capacity != null && employeeIds.length > Number(rate.capacity)) throw new ApiError(400, `Η χωρητικότητα της ζώνης είναι ${rate.capacity} εργαζόμενοι.`);
  if (employeeIds.length) {
    const placeholders = employeeIds.map(() => "?").join(",");
    const valid = await env.DB.prepare(`SELECT COUNT(*) AS count FROM app_users WHERE active=1 AND id IN (${placeholders})`).bind(...employeeIds).first();
    if (Number(valid?.count || 0) !== employeeIds.length) throw new ApiError(400, "Μία ή περισσότερες επιλογές εργαζομένων δεν είναι έγκυρες.");
  }
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM special_rate_assignments WHERE special_rate_id=? AND date=?").bind(specialRateId, date),
    ...employeeIds.map((employeeId) => env.DB.prepare(`INSERT INTO special_rate_assignments
      (special_rate_id,employee_id,date,assigned_by,created_at) VALUES (?,?,?,?,?)`)
      .bind(specialRateId, employeeId, date, actor.user_id, now))
  ]);
  await audit(env, request, actor, "special_rate_assignments_changed", "special_rate", specialRateId,
    null, { date, employeeIds }, text(body.reason, 500), pinUsed);
  return wfJson({ updated: true, date, assigned: employeeIds.length });
}

async function savePayRule(request, env, deps) {
  const actor = await authenticate(request, env, "payroll.manage");
  const pinUsed = await requirePin(request, env, deps, actor);
  const body = await bodyJson(request);
  const id = text(body.id, 100) || uuid();
  const existing = await env.DB.prepare("SELECT * FROM pay_rules WHERE id=?").bind(id).first();
  const name = text(body.name, 120);
  if (!name) throw new ApiError(400, "Γράψε όνομα κανόνα.");
  const scopeType = ["general", "group", "employee", "shift"].includes(body.scopeType) ? body.scopeType : "general";
  const scopeId = scopeType === "general" ? "" : text(body.scopeId, 100);
  if (scopeType !== "general" && !scopeId) throw new ApiError(400, "Διάλεξε σε ποιον εφαρμόζεται ο κανόνας.");
  const modes = ["none", "down", "up", "nearest"];
  const version = existing ? Number(existing.version) + 1 : 1;
  const now = nowIso();
  const specialRates = Array.isArray(body.specialRates) ? body.specialRates.slice(0, 30).map((item, index) => {
    const startTime = text(item?.startTime || item?.start_time, 8);
    const endTime = text(item?.endTime || item?.end_time, 8);
    if (!PAY_CLOCK_TIME_PATTERN.test(startTime) || !PAY_CLOCK_TIME_PATTERN.test(endTime)) {
      throw new ApiError(400, `Η ειδική ζώνη ${index + 1} χρειάζεται έγκυρη ώρα έναρξης και λήξης.`);
    }
    const rateCents = integer(item?.rateCents ?? item?.rate_cents, 0, 1_000_000, -1);
    if (rateCents < 0) throw new ApiError(400, `Η ειδική ζώνη ${index + 1} χρειάζεται έγκυρη αμοιβή.`);
    let capacity = null;
    if (item?.capacity !== undefined && item?.capacity !== null && item?.capacity !== "") {
      capacity = integer(item.capacity, 1, 1000, -1);
      if (capacity < 1) throw new ApiError(400, `Η χωρητικότητα της ειδικής ζώνης ${index + 1} δεν είναι έγκυρη.`);
    }
    return {
      // Assign the identity before both the live row and the immutable
      // version snapshot are written.  Leaving this undefined made newly
      // created special zones exist in `special_rates` but disappear from
      // the historical `pay_rule_versions` snapshot.
      id: text(item?.id, 100) || uuid(),
      label: text(item?.label, 120) || "Ειδική ώρα",
      startTime, endTime, rateCents, capacity,
      qualification: ["first_eligible", "scheduled", "automatic", "manual"].includes(item?.qualification) ? item.qualification : "first_eligible",
      priority: integer(item?.priority, -1000, 1000, 0),
      active: item?.active === false ? false : true
    };
  }) : [];
  const values = {
    id, name, scopeType, scopeId, version,
    priority: integer(body.priority, -1000, 1000, 0),
    normalRateCents: integer(body.normalRateCents, 0, 1_000_000, 600),
    startRoundMode: modes.includes(body.startRoundMode) ? body.startRoundMode : "none",
    startRoundMinutes: integer(body.startRoundMinutes, 1, 60, 1),
    lateGraceMinutes: integer(body.lateGraceMinutes, 0, 720, 0),
    lateClockOutGraceMinutes: integer(body.lateClockOutGraceMinutes, 0, 720, 30),
    endRoundMode: modes.includes(body.endRoundMode) ? body.endRoundMode : "none",
    endRoundMinutes: integer(body.endRoundMinutes, 1, 60, 1),
    durationRoundMode: "none",
    payableIncrementMinutes: 1,
    minimumMinutes: integer(body.minimumMinutes, 0, 1440, 0),
    maximumMinutes: integer(body.maximumMinutes, 1, 1440, 720),
    validFrom: text(body.validFrom, 10) || null,
    validUntil: text(body.validUntil, 10) || null,
    active: body.active === false ? 0 : 1
  };
  if (values.maximumMinutes < values.minimumMinutes) throw new ApiError(400, "Η μέγιστη διάρκεια πρέπει να είναι μεγαλύτερη από την ελάχιστη.");
  await env.DB.prepare(`INSERT INTO pay_rules
    (id,name,scope_type,scope_id,version,priority,normal_rate_cents,start_round_mode,start_round_minutes,
     late_grace_minutes,late_clock_out_grace_minutes,end_round_mode,end_round_minutes,duration_round_mode,payable_increment_minutes,minimum_minutes,
     maximum_minutes,valid_from,valid_until,active,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,scope_type=excluded.scope_type,scope_id=excluded.scope_id,
    version=excluded.version,priority=excluded.priority,normal_rate_cents=excluded.normal_rate_cents,
    start_round_mode=excluded.start_round_mode,start_round_minutes=excluded.start_round_minutes,
    late_grace_minutes=excluded.late_grace_minutes,
    late_clock_out_grace_minutes=excluded.late_clock_out_grace_minutes,
    end_round_mode=excluded.end_round_mode,end_round_minutes=excluded.end_round_minutes,
    duration_round_mode=excluded.duration_round_mode,payable_increment_minutes=excluded.payable_increment_minutes,
    minimum_minutes=excluded.minimum_minutes,maximum_minutes=excluded.maximum_minutes,
    valid_from=excluded.valid_from,valid_until=excluded.valid_until,active=excluded.active,updated_at=excluded.updated_at`)
    .bind(id, name, scopeType, scopeId, version, values.priority, values.normalRateCents,
      values.startRoundMode, values.startRoundMinutes, values.lateGraceMinutes, values.lateClockOutGraceMinutes, values.endRoundMode, values.endRoundMinutes,
      values.durationRoundMode, values.payableIncrementMinutes, values.minimumMinutes, values.maximumMinutes,
      values.validFrom, values.validUntil, values.active, actor.user_id, existing?.created_at || now, now).run();
  // Historical payroll segments may reference an older special-rate row. Keep
  // those rows and deactivate them instead of deleting historical identities.
  await env.DB.prepare("UPDATE special_rates SET active=0 WHERE pay_rule_id=?").bind(id).run();
  const statements = specialRates.map((item) => env.DB.prepare(`INSERT INTO special_rates
    (id,pay_rule_id,label,start_time,end_time,rate_cents,capacity,qualification,priority,active)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      label=excluded.label,start_time=excluded.start_time,end_time=excluded.end_time,
      rate_cents=excluded.rate_cents,capacity=excluded.capacity,qualification=excluded.qualification,
      priority=excluded.priority,active=excluded.active
      WHERE special_rates.pay_rule_id=excluded.pay_rule_id`).bind(
      item.id, id, item.label, item.startTime, item.endTime, item.rateCents,
      item.capacity, item.qualification, item.priority, item.active ? 1 : 0));
  if (statements.length) await env.DB.batch(statements);
  await env.DB.prepare(`INSERT OR IGNORE INTO pay_rule_versions (rule_id,version,snapshot,created_by,created_at)
    VALUES (?,?,?,?,?)`).bind(id, version, JSON.stringify({ ...values, specialRates }), actor.user_id, now).run();
  await audit(env, request, actor, existing ? "pay_rule_updated" : "pay_rule_created", "pay_rule", id,
    existing ? rulePublic(existing) : null, { ...values, specialRates }, text(body.reason, 500), pinUsed);
  return wfJson({ saved: true, id, version });
}

async function simulatePay(request, env) {
  const actor = await authenticate(request, env, "payroll.view");
  const body = await bodyJson(request);
  const ruleId = text(body.ruleId, 100) || "default-general";
  const row = await env.DB.prepare("SELECT * FROM pay_rules WHERE id=?").bind(ruleId).first();
  if (!row) throw new ApiError(404, "Ο κανόνας δεν βρέθηκε.");
  const special = await env.DB.prepare("SELECT * FROM special_rates WHERE pay_rule_id=? AND active=1 ORDER BY priority DESC").bind(ruleId).all();
  const rule = rulePublic(row, special.results || []);
  const result = computePayBreakdown({
    actualStart: body.actualClockIn,
    actualEnd: body.actualClockOut,
    scheduledStart: body.scheduledStart || null,
    rule,
    specialWindows: rule.specialRates.map((item) => ({ ...item, qualified: true })),
    timeZone: await setting(env, "timezone", DEFAULT_TIME_ZONE)
  });
  await audit(env, request, actor, "pay_rule_simulated", "pay_rule", ruleId, null, {
    actualClockIn: body.actualClockIn, actualClockOut: body.actualClockOut, totalPayCents: result.totalPayCents
  }, "Simulation only", false);
  return wfJson({ result, rule });
}

async function ensurePayrollPeriod(env, startDate, endDate, actorId = null) {
  const now = nowIso();
  await env.DB.prepare(`INSERT OR IGNORE INTO payroll_periods
    (id,start_date,end_date,status,created_at,updated_at) VALUES (?,?,?,'open',?,?)`)
    .bind(uuid(), startDate, endDate, now, now).run();
  return env.DB.prepare("SELECT * FROM payroll_periods WHERE start_date=? AND end_date=?").bind(startDate, endDate).first();
}

async function buildPayrollSummary(env, startDate, endDate) {
  const bounds = await localDateUtcBounds(env, startDate, endDate);
  const shifts = await env.DB.prepare(`SELECT s.*,u.full_name AS employee_name,sc.end_at AS scheduled_end
    FROM shifts s JOIN app_users u ON u.id=s.employee_id
    LEFT JOIN schedules sc ON sc.id=s.schedule_id
    WHERE s.actual_clock_in>=? AND s.actual_clock_in<? AND s.status IN ('completed','pending_overtime','pending_km','pending_correction')
    ORDER BY u.full_name,s.actual_clock_in`).bind(bounds.start, bounds.end).all();
  const period = await ensurePayrollPeriod(env, startDate, endDate);
  if (period.status === "locked") {
    const snapshots = await env.DB.prepare("SELECT employee_id,data FROM payroll_snapshots WHERE period_id=? ORDER BY employee_id").bind(period.id).all();
    const employees = (snapshots.results || []).map((row) => parseJson(row.data, {}));
    return { period, employees, lockedSnapshot: true };
  }
  const adjustments = await env.DB.prepare("SELECT * FROM payroll_adjustments WHERE period_id=? ORDER BY created_at").bind(period.id).all();
  const map = new Map();
  for (const shift of shifts.results || []) {
    if (!map.has(shift.employee_id)) map.set(shift.employee_id, {
      employeeId: shift.employee_id, employeeName: shift.employee_name, shifts: 0,
      normalHours: 0, specialHours: 0, payableHours: 0, kilometers: 0,
      basePayCents: 0, specialPayCents: 0, bonusCents: 0, deductionCents: 0,
      advanceCents: 0, hoursAdjustment: 0, finalCents: 0, pendingOvertime: 0, overtimeApprovals: []
    });
    const item = map.get(shift.employee_id);
    item.shifts += 1;
    item.payableHours += Number(shift.payable_minutes || 0) / 60;
    item.kilometers += Number(shift.shift_km || 0);
    item.basePayCents += Number(shift.base_pay_cents || 0);
    item.specialPayCents += Number(shift.special_pay_cents || 0);
    const specialMinutes = await env.DB.prepare("SELECT COALESCE(SUM(minutes),0) AS minutes FROM payroll_segments WHERE shift_id=? AND special_rate_id IS NOT NULL").bind(shift.id).first();
    item.specialHours += Number(specialMinutes?.minutes || 0) / 60;
    if (shift.overtime_status === "pending") item.pendingOvertime += 1;
    if (shift.overtime_status === "approved") {
      const actualEnd = new Date(shift.actual_clock_out || "").getTime();
      const scheduledEnd = new Date(shift.scheduled_end || "").getTime();
      item.overtimeApprovals.push({
        shiftId: shift.id,
        overtimeMinutes: shift.overtime_minutes_override != null
          ? Number(shift.overtime_minutes_override)
          : Number.isFinite(actualEnd) && Number.isFinite(scheduledEnd)
            ? Math.max(0, Math.round((actualEnd - scheduledEnd) / 60000 * 100) / 100) : 0,
        approvedBy: shift.overtime_approved_by_name || shift.overtime_approved_by || "—",
        approvedAt: shift.overtime_approved_at || null,
        rateCents: shift.overtime_rate_cents == null ? null : Number(shift.overtime_rate_cents)
      });
    }
  }
  for (const adjustment of adjustments.results || []) {
    if (!map.has(adjustment.employee_id)) {
      const user = await env.DB.prepare("SELECT full_name FROM app_users WHERE id=?").bind(adjustment.employee_id).first();
      map.set(adjustment.employee_id, { employeeId: adjustment.employee_id, employeeName: user?.full_name || "—", shifts: 0, normalHours: 0, specialHours: 0, payableHours: 0, kilometers: 0, basePayCents: 0, specialPayCents: 0, bonusCents: 0, deductionCents: 0, advanceCents: 0, hoursAdjustment: 0, finalCents: 0, pendingOvertime: 0, overtimeApprovals: [] });
    }
    const item = map.get(adjustment.employee_id);
    if (adjustment.kind === "bonus") item.bonusCents += Number(adjustment.amount_cents);
    if (adjustment.kind === "deduction") item.deductionCents += Math.abs(Number(adjustment.amount_cents));
    if (adjustment.kind === "advance") item.advanceCents += Math.abs(Number(adjustment.amount_cents));
    if (adjustment.kind === "hours") item.hoursAdjustment += Number(adjustment.minutes) / 60;
  }
  const employees = [...map.values()].map((item) => {
    item.normalHours = Math.max(0, item.payableHours - item.specialHours);
    item.payableHours = Math.round((item.payableHours + item.hoursAdjustment) * 100) / 100;
    item.normalHours = Math.round(item.normalHours * 100) / 100;
    item.specialHours = Math.round(item.specialHours * 100) / 100;
    item.finalCents = item.basePayCents + item.specialPayCents + item.bonusCents - item.deductionCents - item.advanceCents;
    return item;
  });
  return { period, employees, lockedSnapshot: false };
}

async function payrollSummary(request, env) {
  await authenticate(request, env, "payroll.view");
  const url = new URL(request.url);
  const defaultPeriod = mondayPeriod(Date.now(), await setting(env, "timezone", DEFAULT_TIME_ZONE));
  const startDate = text(url.searchParams.get("start"), 10) || defaultPeriod.startDate;
  const endDate = text(url.searchParams.get("end"), 10) || addCalendarDays(startDate, 6);
  const summary = await buildPayrollSummary(env, startDate, endDate);
  const totals = summary.employees.reduce((acc, item) => ({
    employees: acc.employees + 1,
    payableHours: acc.payableHours + item.payableHours,
    kilometers: acc.kilometers + item.kilometers,
    basePayCents: acc.basePayCents + item.basePayCents,
    specialPayCents: acc.specialPayCents + item.specialPayCents,
    bonusCents: acc.bonusCents + item.bonusCents,
    deductionCents: acc.deductionCents + item.deductionCents,
    advanceCents: acc.advanceCents + item.advanceCents,
    finalCents: acc.finalCents + item.finalCents,
    pendingOvertime: acc.pendingOvertime + Number(item.pendingOvertime || 0),
    approvedOvertime: acc.approvedOvertime + (item.overtimeApprovals || []).length
  }), { employees: 0, payableHours: 0, kilometers: 0, basePayCents: 0, specialPayCents: 0, bonusCents: 0, deductionCents: 0, advanceCents: 0, finalCents: 0, pendingOvertime: 0, approvedOvertime: 0 });
  totals.payableHours = Math.round(totals.payableHours * 100) / 100;
  return wfJson({ period: { id: summary.period.id, startDate, endDate, status: summary.period.status }, employees: summary.employees, totals, lockedSnapshot: summary.lockedSnapshot });
}

async function addPayrollAdjustment(request, env, deps) {
  const actor = await authenticate(request, env, "payroll.manage");
  const pinUsed = await requirePin(request, env, deps, actor);
  const body = await bodyJson(request);
  const startDate = text(body.startDate, 10);
  const endDate = text(body.endDate, 10) || addCalendarDays(startDate, 6);
  const period = await ensurePayrollPeriod(env, startDate, endDate, actor.user_id);
  if (period.status === "locked") throw new ApiError(409, "Η μισθοδοσία είναι κλειδωμένη.");
  const kind = ["bonus", "deduction", "advance", "hours"].includes(body.kind) ? body.kind : "bonus";
  const reason = text(body.reason, 500);
  const employeeId = text(body.employeeId, 100);
  if (!employeeId || !reason) throw new ApiError(400, "Διάλεξε εργαζόμενο και γράψε αιτιολογία.");
  const id = uuid();
  const amountCents = integer(body.amountCents, -100_000_000, 100_000_000, 0);
  const minutes = Math.round(Number(body.hours || 0) * 60 * 1000) / 1000;
  await env.DB.prepare(`INSERT INTO payroll_adjustments
    (id,period_id,employee_id,kind,amount_cents,minutes,date,reason,created_by,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(id, period.id, employeeId, kind, amountCents, minutes,
      text(body.date, 10) || nowIso().slice(0, 10), reason, actor.user_id, nowIso()).run();
  await audit(env, request, actor, "payroll_adjustment_added", "payroll_adjustment", id, null,
    { periodId: period.id, employeeId, kind, amountCents, minutes }, reason, pinUsed);
  if (kind === "hours") {
    await createAlert(env, "payroll_correction", "warning", "Χειροκίνητη διόρθωση μισθοδοσίας", `${minutes / 60} ώρες • ${reason}`, "payroll_adjustment", id, `payroll-correction:${id}`);
  }
  return wfJson({ created: true, id }, 201);
}

async function lockPayroll(request, env, deps) {
  const actor = await authenticate(request, env, "payroll.lock");
  const pinUsed = await requirePin(request, env, deps, actor);
  const body = await bodyJson(request);
  const startDate = text(body.startDate, 10);
  const endDate = text(body.endDate, 10) || addCalendarDays(startDate, 6);
  const summary = await buildPayrollSummary(env, startDate, endDate);
  if (summary.period.status === "locked") return wfJson({ locked: true, unchanged: true });
  const now = nowIso();
  const statements = summary.employees.map((item) => env.DB.prepare(`INSERT INTO payroll_snapshots
    (id,period_id,employee_id,data,created_at) VALUES (?,?,?,?,?)`)
    .bind(uuid(), summary.period.id, item.employeeId, JSON.stringify(item), now));
  statements.push(env.DB.prepare("UPDATE payroll_periods SET status='locked',locked_at=?,locked_by=?,updated_at=? WHERE id=?")
    .bind(now, actor.user_id, now, summary.period.id));
  for (let index = 0; index < statements.length; index += 80) await env.DB.batch(statements.slice(index, index + 80));
  await audit(env, request, actor, "payroll_locked", "payroll_period", summary.period.id, { status: "open" }, { status: "locked", employees: summary.employees.length }, text(body.reason, 500), pinUsed);
  return wfJson({ locked: true });
}

async function unlockPayroll(request, env, deps) {
  const actor = await authenticate(request, env, "payroll.lock");
  const pinUsed = await requirePin(request, env, deps, actor);
  const body = await bodyJson(request);
  const reason = text(body.reason, 500);
  if (!reason) throw new ApiError(400, "Χρειάζεται αιτιολογία ξεκλειδώματος.");
  const startDate = text(body.startDate, 10);
  const endDate = text(body.endDate, 10) || addCalendarDays(startDate, 6);
  const period = await ensurePayrollPeriod(env, startDate, endDate);
  if (period.status !== "locked") return wfJson({ unlocked: true, unchanged: true });
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM payroll_snapshots WHERE period_id=?").bind(period.id),
    env.DB.prepare(`UPDATE payroll_periods SET status='open',unlocked_at=?,unlocked_by=?,unlock_reason=?,updated_at=? WHERE id=?`)
      .bind(now, actor.user_id, reason, now, period.id)
  ]);
  await audit(env, request, actor, "payroll_unlocked", "payroll_period", period.id, { status: "locked" }, { status: "open" }, reason, pinUsed);
  return wfJson({ unlocked: true });
}

async function listAlerts(request, env) {
  await authenticate(request, env, "alerts.view");
  const includeResolved = new URL(request.url).searchParams.get("resolved") === "1";
  const rows = await env.DB.prepare(`SELECT a.*,COALESCE(r.channel,'in_app') AS channel
    FROM system_alerts a LEFT JOIN alert_rules r ON r.type=a.type WHERE (?=1 OR a.resolved=0)
    ORDER BY a.resolved, CASE a.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, a.created_at DESC LIMIT 500`)
    .bind(includeResolved ? 1 : 0).all();
  return wfJson({ alerts: rows.results || [] });
}

async function listAlertRules(request, env) {
  await authenticate(request, env, "alerts.view");
  const rows = await env.DB.prepare("SELECT type,enabled,severity,channel,updated_at,updated_by FROM alert_rules ORDER BY type").all();
  return wfJson({ rules: (rows.results || []).map((row) => ({
    type: row.type, enabled: bool(row.enabled), severity: row.severity, channel: row.channel,
    updatedAt: row.updated_at, updatedBy: row.updated_by || null
  })) });
}

async function saveAlertRules(request, env, deps) {
  const actor = await authenticate(request, env, "alerts.manage");
  const pinUsed = await requirePin(request, env, deps, actor);
  const body = await bodyJson(request);
  const requested = Array.isArray(body.rules) ? body.rules.slice(0, 50) : [];
  if (!requested.length) throw new ApiError(400, "Δεν δόθηκαν ρυθμίσεις ειδοποιήσεων.");
  const existingRows = await env.DB.prepare("SELECT type,enabled,severity,channel FROM alert_rules ORDER BY type").all();
  const known = new Set((existingRows.results || []).map((row) => row.type));
  const normalized = requested.map((item) => {
    const type = text(item?.type, 80);
    if (!known.has(type)) throw new ApiError(400, `Άγνωστος τύπος ειδοποίησης: ${type || "—"}`);
    const severity = ["info", "warning", "critical"].includes(item.severity) ? item.severity : "warning";
    const channel = ["in_app", "push", "both"].includes(item.channel) ? item.channel : "in_app";
    return { type, enabled: bool(item.enabled) ? 1 : 0, severity, channel };
  });
  const unique = new Map(normalized.map((item) => [item.type, item]));
  const now = nowIso();
  await env.DB.batch([...unique.values()].map((item) => env.DB.prepare(`UPDATE alert_rules SET
    enabled=?,severity=?,channel=?,updated_at=?,updated_by=? WHERE type=?`)
    .bind(item.enabled, item.severity, item.channel, now, actor.user_id, item.type)));
  await audit(env, request, actor, "alert_rules_updated", "settings", "alerts", existingRows.results || [], [...unique.values()], text(body.reason, 500), pinUsed);
  return wfJson({ updated: true, count: unique.size });
}

async function listCorrections(request, env) {
  await authenticate(request, env, "shifts.view");
  const rows = await env.DB.prepare(`SELECT cr.*,u.full_name AS employee_name,s.status AS shift_status,
    s.actual_clock_in,s.actual_clock_out FROM correction_requests cr
    JOIN app_users u ON u.id=cr.employee_id LEFT JOIN shifts s ON s.id=cr.shift_id
    ORDER BY CASE cr.status WHEN 'pending' THEN 0 ELSE 1 END,cr.created_at DESC LIMIT 500`).all();
  return wfJson({ corrections: rows.results || [] });
}

async function resolveCorrection(request, env, deps, id) {
  const actor = await authenticate(request, env, "shifts.manage");
  const pinUsed = await requirePin(request, env, deps, actor);
  const body = await bodyJson(request);
  const resolution = text(body.resolution, 1000);
  const status = body.status === "rejected" ? "rejected" : "approved";
  if (!resolution) throw new ApiError(400, "Γράψε τον τρόπο επίλυσης.");
  const current = await env.DB.prepare("SELECT * FROM correction_requests WHERE id=?").bind(id).first();
  if (!current) throw new ApiError(404, "Το αίτημα διόρθωσης δεν βρέθηκε.");
  if (current.status !== "pending") throw new ApiError(409, "Το αίτημα έχει ήδη κλείσει.");
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare("UPDATE correction_requests SET status=?,resolution=?,resolved_by=?,resolved_at=? WHERE id=? AND status='pending'")
      .bind(status, resolution, actor.user_id, now, id),
    env.DB.prepare("UPDATE system_alerts SET resolved=1,resolved_by=?,resolved_at=? WHERE object_type='correction' AND object_id=?")
      .bind(actor.user_id, now, id)
  ]);
  await audit(env, request, actor, status === "approved" ? "correction_approved" : "correction_rejected",
    "correction", id, { status: current.status, message: current.message }, { status, resolution }, resolution, pinUsed);
  return wfJson({ updated: true, status });
}

async function resolveAlert(request, env, id) {
  const actor = await authenticate(request, env, "alerts.manage");
  const now = nowIso();
  const result = await env.DB.prepare("UPDATE system_alerts SET resolved=1,resolved_by=?,resolved_at=? WHERE id=? AND resolved=0")
    .bind(actor.user_id, now, id).run();
  if (!Number(result.meta?.changes || 0)) throw new ApiError(404, "Η ειδοποίηση δεν βρέθηκε ή έχει ήδη κλείσει.");
  await audit(env, request, actor, "alert_resolved", "alert", id, { resolved: false }, { resolved: true }, "", false);
  return wfJson({ resolved: true });
}

async function listAudit(request, env) {
  await authenticate(request, env, "audit.view");
  const url = new URL(request.url);
  const objectType = text(url.searchParams.get("objectType"), 60);
  const userId = text(url.searchParams.get("userId"), 100);
  const action = text(url.searchParams.get("action"), 100);
  const rows = await env.DB.prepare(`SELECT * FROM audit_log WHERE (?='' OR object_type=?)
    AND (?='' OR user_id=? OR (object_type='user' AND object_id=?))
    AND (?='' OR action=?) ORDER BY timestamp DESC LIMIT 1000`)
    .bind(objectType, objectType, userId, userId, userId, action, action).all();
  return wfJson({ entries: rows.results || [] });
}

function recyclePermission(actor, recordType) {
  if (recordType === "fleet_history") return hasPermission(actor.permissions, "fleet.manage");
  if (recordType === "shift") return hasPermission(actor.permissions, "shifts.manage");
  if (recordType === "schedule_assignment") return hasPermission(actor.permissions, "schedules.manage");
  return false;
}

function deletedRecordPublic(row, canRestore) {
  let payload = {};
  try { payload = JSON.parse(row.payload || "{}"); } catch {}
  let details = "";
  if (row.record_type === "fleet_history") {
    const entry = payload.entry || {};
    details = `${entry.type === "service" ? "Service" : "Έλεγχος χιλιομέτρων"} • ${Number(entry.km || 0).toLocaleString("el-GR")} χλμ. • ${entry.date || "—"}`;
  } else if (row.record_type === "shift") {
    const shift = payload.shift || {};
    details = `${shift.actual_clock_in || "—"}${shift.actual_clock_out ? ` → ${shift.actual_clock_out}` : ""}`;
  } else if (row.record_type === "schedule_assignment") {
    const schedule = (payload.schedules || [])[0] || {};
    details = `${schedule.start_at || "—"}${schedule.end_at ? ` → ${schedule.end_at}` : ""}`;
  }
  return {
    id: row.id,
    recordType: row.record_type,
    recordId: row.record_id,
    label: row.label || "Διαγραμμένη εγγραφή",
    details,
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by_name || "System",
    reason: row.reason || "",
    restoredAt: row.restored_at || null,
    restoreReason: row.restore_reason || "",
    canRestore: Boolean(canRestore && !row.restored_at)
  };
}

async function listDeletedRecords(request, env) {
  const actor = await authenticate(request, env);
  if (!isManagementActor(actor)) throw new ApiError(403, "Ο κάδος είναι διαθέσιμος μόνο στη διαχείριση.", "forbidden");
  const url = new URL(request.url);
  const includeRestored = url.searchParams.get("restored") === "1";
  const type = text(url.searchParams.get("type"), 40);
  const rows = await env.DB.prepare(`SELECT * FROM deleted_records
    WHERE (?=1 OR restored_at IS NULL) AND (?='' OR record_type=?)
    ORDER BY CASE WHEN restored_at IS NULL THEN 0 ELSE 1 END,deleted_at DESC LIMIT 500`)
    .bind(includeRestored ? 1 : 0, type, type).all();
  const visible = (rows.results || []).filter((row) => recyclePermission(actor, row.record_type));
  return wfJson({
    records: visible.map((row) => deletedRecordPublic(row, recyclePermission(actor, row.record_type))),
    retention: "manual",
    counts: {
      active: visible.filter((row) => !row.restored_at).length,
      restored: visible.filter((row) => Boolean(row.restored_at)).length
    }
  });
}

const SHIFT_ARCHIVE_COLUMNS = [
  "id","employee_id","schedule_id","vehicle_id","current_vehicle_id","status","actual_clock_in","actual_clock_out",
  "effective_clock_out","automatic_closed_at","payable_clock_in","payable_clock_out","payable_minutes","initial_km",
  "final_km","shift_km","rule_id","rule_version","rule_snapshot","base_pay_cents","special_pay_cents","final_pay_cents",
  "out_of_schedule","overtime_status","overtime_rate_cents","overtime_minutes_override","overtime_approved_by",
  "overtime_approved_by_name","overtime_approved_at","missing_km","notes","created_at","updated_at"
];
const VEHICLE_SEGMENT_ARCHIVE_COLUMNS = ["id","shift_id","vehicle_id","started_at","ended_at","initial_km","final_km","changed_by","reason"];
const PAYROLL_SEGMENT_ARCHIVE_COLUMNS = ["id","shift_id","special_rate_id","label","start_at","end_at","minutes","rate_cents","amount_cents"];
const SCHEDULE_ARCHIVE_COLUMNS = ["id","employee_id","vehicle_id","series_id","start_at","end_at","status","notes","created_by","created_at","updated_at"];
const SCHEDULE_ASSIGNMENT_ARCHIVE_COLUMNS = ["id","employee_id","template_id","work_date","vehicle_id","status","notes","created_by","created_at","updated_at"];

function archivedInsert(env, table, columns, row) {
  return env.DB.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
    .bind(...columns.map((column) => row[column] === undefined ? null : row[column]));
}

async function restoreScheduleArchive(env, payload, actor, deletedRow) {
  const scheduleRows = Array.isArray(payload.schedules) ? payload.schedules.slice(0, 20) : [];
  if (!scheduleRows.length) throw new ApiError(409, "Το αντίγραφο της προγραμματισμένης βάρδιας είναι κενό.", "archive_invalid");
  for (const row of scheduleRows) {
    const employeeConflict = await env.DB.prepare(`SELECT id FROM schedules WHERE id<>? AND employee_id=?
      AND status NOT IN ('cancelled','completed') AND start_at<? AND end_at>? LIMIT 1`)
      .bind(row.id, row.employee_id, row.end_at, row.start_at).first();
    if (employeeConflict) throw new ApiError(409, "Δεν μπορεί να γίνει ανάκτηση: ο εργαζόμενος έχει πλέον άλλη επικαλυπτόμενη βάρδια.", "employee_schedule_conflict");
    if (row.vehicle_id) {
      const vehicleConflict = await env.DB.prepare(`SELECT id FROM schedules WHERE id<>? AND vehicle_id=?
        AND status NOT IN ('cancelled','completed') AND start_at<? AND end_at>? LIMIT 1`)
        .bind(row.id, row.vehicle_id, row.end_at, row.start_at).first();
      if (vehicleConflict) throw new ApiError(409, "Δεν μπορεί να γίνει ανάκτηση: το μηχανάκι έχει πλέον άλλη επικαλυπτόμενη ανάθεση.", "vehicle_schedule_conflict");
    }
  }
  const now = nowIso();
  const statements = [];
  const assignment = payload.assignment && typeof payload.assignment === "object" ? payload.assignment : null;
  if (assignment) {
    const existing = await env.DB.prepare("SELECT id FROM schedule_assignments WHERE id=?").bind(assignment.id).first();
    if (existing) {
      statements.push(env.DB.prepare(`UPDATE schedule_assignments SET employee_id=?,template_id=?,work_date=?,vehicle_id=?,status='planned',
        notes=?,updated_at=? WHERE id=?`).bind(assignment.employee_id, assignment.template_id, assignment.work_date,
        assignment.vehicle_id, assignment.notes || "", now, assignment.id));
    } else {
      statements.push(archivedInsert(env, "schedule_assignments", SCHEDULE_ASSIGNMENT_ARCHIVE_COLUMNS, { ...assignment, status: "planned", updated_at: now }));
    }
  }
  for (const row of scheduleRows) {
    const existing = await env.DB.prepare("SELECT id FROM schedules WHERE id=?").bind(row.id).first();
    const restoredStatus = ["planned","awaiting","absent"].includes(row.status) ? row.status : "planned";
    if (existing) {
      statements.push(env.DB.prepare(`UPDATE schedules SET employee_id=?,vehicle_id=?,series_id=?,start_at=?,end_at=?,status=?,notes=?,updated_at=?
        WHERE id=? AND status='cancelled'`).bind(row.employee_id, row.vehicle_id, row.series_id, row.start_at, row.end_at,
        restoredStatus, row.notes || "", now, row.id));
    } else {
      statements.push(archivedInsert(env, "schedules", SCHEDULE_ARCHIVE_COLUMNS, { ...row, status: restoredStatus, updated_at: now }));
    }
  }
  statements.push(env.DB.prepare("UPDATE deleted_records SET restored_at=?,restored_by=?,restore_reason=? WHERE id=? AND restored_at IS NULL")
    .bind(now, actor.user_id, deletedRow.restoreReason, deletedRow.id));
  const results = await env.DB.batch(statements);
  if (!Number(results[results.length - 1]?.meta?.changes || 0)) throw new ApiError(409, "Η εγγραφή έχει ήδη ανακτηθεί.", "already_restored");
  return { restored: scheduleRows.length, status: "planned" };
}

async function restoreShiftArchive(env, deps, payload, actor, deletedRow) {
  if (!payload.shift || typeof payload.shift !== "object") throw new ApiError(409, "Το αντίγραφο της βάρδιας δεν είναι έγκυρο.", "archive_invalid");
  const existing = await env.DB.prepare("SELECT id FROM shifts WHERE id=?").bind(payload.shift.id).first();
  if (existing) throw new ApiError(409, "Η βάρδια υπάρχει ήδη.", "already_present");
  await assertPayrollOpen(env, String(payload.shift.actual_clock_in || "").slice(0, 10));
  const employee = await env.DB.prepare("SELECT id FROM app_users WHERE id=?").bind(payload.shift.employee_id).first();
  const vehicle = await env.DB.prepare("SELECT bike_id FROM vehicle_registry WHERE bike_id=?").bind(payload.shift.current_vehicle_id).first();
  if (!employee || !vehicle) throw new ApiError(409, "Ο εργαζόμενος ή το μηχανάκι της βάρδιας δεν υπάρχει πλέον.", "archive_reference_missing");
  const now = nowIso();
  const wasActive = payload.shift.status === "active";
  let scheduleId = payload.shift.schedule_id || null;
  if (scheduleId && !await env.DB.prepare("SELECT id FROM schedules WHERE id=?").bind(scheduleId).first()) scheduleId = null;
  const restoredShift = {
    ...payload.shift,
    schedule_id: scheduleId,
    status: wasActive ? "pending_correction" : payload.shift.status,
    actual_clock_out: wasActive ? deletedRow.deleted_at : payload.shift.actual_clock_out,
    effective_clock_out: wasActive ? deletedRow.deleted_at : payload.shift.effective_clock_out,
    missing_km: wasActive ? 1 : payload.shift.missing_km,
    notes: wasActive ? `${payload.shift.notes || ""}${payload.shift.notes ? "\n" : ""}Ανακτήθηκε από τον κάδο — χρειάζεται έλεγχος λήξης και χιλιομέτρων.` : payload.shift.notes,
    updated_at: now
  };
  const statements = [archivedInsert(env, "shifts", SHIFT_ARCHIVE_COLUMNS, restoredShift)];
  for (const row of Array.isArray(payload.vehicleSegments) ? payload.vehicleSegments.slice(0, 50) : []) {
    statements.push(archivedInsert(env, "vehicle_segments", VEHICLE_SEGMENT_ARCHIVE_COLUMNS,
      wasActive && !row.ended_at ? { ...row, ended_at: deletedRow.deleted_at, reason: `${row.reason || ""}${row.reason ? " • " : ""}Ανάκτηση από κάδο` } : row));
  }
  for (const row of Array.isArray(payload.payrollSegments) ? payload.payrollSegments.slice(0, 100) : []) {
    statements.push(archivedInsert(env, "payroll_segments", PAYROLL_SEGMENT_ARCHIVE_COLUMNS, row));
  }
  for (const correctionId of Array.isArray(payload.correctionIds) ? payload.correctionIds.slice(0, 100) : []) {
    statements.push(env.DB.prepare("UPDATE correction_requests SET shift_id=? WHERE id=? AND shift_id IS NULL").bind(restoredShift.id, correctionId));
  }
  if (scheduleId) {
    const scheduleStatus = wasActive ? "pending_correction" : (["completed","pending_correction"].includes(payload.schedule?.status) ? payload.schedule.status : "planned");
    statements.push(env.DB.prepare("UPDATE schedules SET status=?,updated_at=? WHERE id=?").bind(scheduleStatus, now, scheduleId));
  }
  statements.push(env.DB.prepare("UPDATE deleted_records SET restored_at=?,restored_by=?,restore_reason=? WHERE id=? AND restored_at IS NULL")
    .bind(now, actor.user_id, deletedRow.restoreReason, deletedRow.id));
  const results = await env.DB.batch(statements);
  if (!Number(results[results.length - 1]?.meta?.changes || 0)) throw new ApiError(409, "Η βάρδια έχει ήδη ανακτηθεί.", "already_restored");
  if (Array.isArray(payload.fleetHistory) && payload.fleetHistory.length && deps.restoreFleetHistoryEntries) {
    await deps.restoreFleetHistoryEntries(env, payload.fleetHistory);
  }
  return { restored: 1, status: restoredShift.status, needsReview: wasActive };
}

async function restoreDeletedRecord(request, env, deps, rawId) {
  const actor = await authenticate(request, env);
  const id = text(rawId, 100);
  const row = await env.DB.prepare("SELECT * FROM deleted_records WHERE id=?").bind(id).first();
  if (!row) throw new ApiError(404, "Η διαγραμμένη εγγραφή δεν βρέθηκε.", "archive_not_found");
  if (row.restored_at) throw new ApiError(409, "Η εγγραφή έχει ήδη ανακτηθεί.", "already_restored");
  if (!recyclePermission(actor, row.record_type)) throw new ApiError(403, "Δεν έχεις δικαίωμα ανάκτησης αυτής της εγγραφής.", "forbidden");
  const body = await bodyJson(request);
  const reason = text(body.reason, 500) || "Ανάκτηση από τον κάδο";
  let payload = {};
  try { payload = JSON.parse(row.payload || "{}"); } catch { throw new ApiError(409, "Το αποθηκευμένο αντίγραφο δεν είναι έγκυρο.", "archive_invalid"); }
  const deletedRow = { ...row, restoreReason: reason };
  let result;
  if (row.record_type === "fleet_history") {
    if (!deps.restoreFleetHistoryEntries) throw new ApiError(503, "Η ανάκτηση Fleet δεν είναι διαθέσιμη.");
    result = await deps.restoreFleetHistoryEntries(env, [{ bikeId: payload.bikeId, bikeName: payload.bikeName, entry: payload.entry }]);
    if (!result.restored) throw new ApiError(409, "Το μηχανάκι δεν υπάρχει πλέον ή η εγγραφή έχει ήδη ανακτηθεί.", "restore_conflict");
    const now = nowIso();
    const changed = await env.DB.prepare("UPDATE deleted_records SET restored_at=?,restored_by=?,restore_reason=? WHERE id=? AND restored_at IS NULL")
      .bind(now, actor.user_id, reason, id).run();
    if (!Number(changed?.meta?.changes || 0)) throw new ApiError(409, "Η εγγραφή έχει ήδη ανακτηθεί.", "already_restored");
  } else if (row.record_type === "schedule_assignment") {
    result = await restoreScheduleArchive(env, payload, actor, deletedRow);
  } else if (row.record_type === "shift") {
    result = await restoreShiftArchive(env, deps, payload, actor, deletedRow);
  } else {
    throw new ApiError(400, "Ο τύπος εγγραφής δεν υποστηρίζεται.");
  }
  await audit(env, request, actor, "record_restored", row.record_type, row.record_id,
    { deletedAt: row.deleted_at, recycleId: id }, { restoredAt: nowIso(), result }, reason, false);
  return wfJson({ restored: true, recordType: row.record_type, recordId: row.record_id, result });
}

async function reportData(request, env, deps) {
  const actor = await authenticate(request, env, "reports.view");
  const url = new URL(request.url);
  const type = text(url.searchParams.get("type"), 40) || "shifts";
  const from = text(url.searchParams.get("from"), 10) || addCalendarDays(localDate(Date.now(), DEFAULT_TIME_ZONE), -30);
  const to = text(url.searchParams.get("to"), 10) || localDate(Date.now(), DEFAULT_TIME_ZONE);
  const employeeId = text(url.searchParams.get("employeeId"), 100);
  const vehicleId = text(url.searchParams.get("vehicleId"), 100);
  const serviceTask = text(url.searchParams.get("serviceTask"), 120).toLocaleLowerCase("el");
  const workshop = text(url.searchParams.get("workshop"), 160).toLocaleLowerCase("el");
  const bounds = await localDateUtcBounds(env, from, to);
  if (type === "shifts" || type === "employees") {
    const rows = await env.DB.prepare(`SELECT s.id,u.full_name AS employee,s.actual_clock_in,s.actual_clock_out,
      s.payable_clock_in,s.payable_clock_out,ROUND(s.payable_minutes/60.0,2) AS payable_hours,
      CASE WHEN u.uses_own_vehicle=1 OR substr(s.current_vehicle_id,1,16)='__own_vehicle__:'
        THEN '${OWN_VEHICLE_LABEL}' ELSE v.name END AS vehicle,s.initial_km,s.final_km,s.shift_km,s.status,s.out_of_schedule,
      s.base_pay_cents,s.special_pay_cents,s.final_pay_cents
      FROM shifts s JOIN app_users u ON u.id=s.employee_id LEFT JOIN vehicle_registry v ON v.bike_id=s.current_vehicle_id
      WHERE s.actual_clock_in>=? AND s.actual_clock_in<? AND (?='' OR s.employee_id=?) AND (?='' OR s.current_vehicle_id=?)
      ORDER BY s.actual_clock_in DESC`).bind(bounds.start, bounds.end, employeeId, employeeId, vehicleId, vehicleId).all();
    return wfJson({ type, from, to, columns: ["employee","actual_clock_in","actual_clock_out","payable_hours","vehicle","initial_km","final_km","shift_km","status","final_pay_cents"], rows: rows.results || [] });
  }
  if (type === "mileage" || type === "vehicle") {
    const rows = await env.DB.prepare(`SELECT vs.id,v.name AS vehicle,u.full_name AS employee,vs.started_at,vs.ended_at,
      vs.initial_km,vs.final_km,CASE WHEN vs.final_km IS NULL THEN NULL ELSE vs.final_km-vs.initial_km END AS distance,
      vs.reason FROM vehicle_segments vs JOIN shifts s ON s.id=vs.shift_id JOIN app_users u ON u.id=s.employee_id
      JOIN vehicle_registry v ON v.bike_id=vs.vehicle_id
      WHERE vs.started_at>=? AND vs.started_at<? AND (?='' OR vs.vehicle_id=?) AND (?='' OR s.employee_id=?)
      ORDER BY vs.started_at DESC`).bind(bounds.start, bounds.end, vehicleId, vehicleId, employeeId, employeeId).all();
    return wfJson({ type, from, to, columns: ["vehicle","employee","started_at","ended_at","initial_km","final_km","distance","reason"], rows: rows.results || [] });
  }
  if (type === "service") {
    const snapshot = await deps.readSnapshot(env);
    const rows = [];
    for (const bike of snapshot.data.bikes || []) {
      if (vehicleId && String(bike.id) !== vehicleId) continue;
      for (const entry of bike.history || []) {
        if (entry.type !== "service" || entry.date < from || entry.date > to) continue;
        const taskText = (entry.tasks || []).join(" • ");
        if (serviceTask && !taskText.toLocaleLowerCase("el").includes(serviceTask)) continue;
        if (workshop && !String(entry.workshop || "").toLocaleLowerCase("el").includes(workshop)) continue;
        rows.push({ record_id: entry.id, vehicle: bike.name, date: entry.date, km: entry.km, tasks: taskText,
          workshop: entry.workshop || "", oil_changed: entry.oilChanged ? "Ναι" : "Όχι", notes: entry.notes || "" });
      }
    }
    rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return wfJson({ type, from, to, columns: ["record_id","vehicle","date","km","tasks","workshop","oil_changed","notes"], rows });
  }
  if (type === "payroll") {
    const summary = await buildPayrollSummary(env, from, to);
    return wfJson({ type, from, to, columns: ["employeeName","payableHours","normalHours","specialHours","kilometers","basePayCents","specialPayCents","bonusCents","deductionCents","advanceCents","finalCents"], rows: summary.employees });
  }
  throw new ApiError(400, "Ο τύπος αναφοράς δεν υποστηρίζεται.");
}

async function getSystemSettings(request, env) {
  const actor = await authenticate(request, env, "settings.manage");
  const rows = await env.DB.prepare("SELECT key,value,updated_at,updated_by FROM system_settings ORDER BY key").all();
  const values = {};
  (rows.results || []).forEach((row) => { values[row.key] = row.value; });
  return wfJson({ settings: values, roles: ROLE_PERMISSIONS, allPermissions: ALL_PERMISSIONS, user: publicUser(actor) });
}

async function updateSystemSettings(request, env, deps) {
  const actor = await authenticate(request, env, "settings.manage");
  const body = await bodyJson(request);
  const allowed = {
    timezone: ["Europe/Athens"],
    no_schedule_policy: ["block", "allow_warning", "allow_normal"],
    admin_session_duration: ["never", "5m", "15m", "30m", "1h", "4h"],
    safety_fallback_hour: Array.from({ length: 24 }, (_, index) => String(index))
  };
  const changes = {};
  for (const [key, options] of Object.entries(allowed)) {
    if (body[key] === undefined) continue;
    const value = String(body[key]);
    if (!options.includes(value)) throw new ApiError(400, `Μη έγκυρη ρύθμιση: ${key}`);
    changes[key] = value;
  }
  if (body.unusual_distance_km !== undefined) {
    const value = integer(body.unusual_distance_km, 1, 5000, -1);
    if (value < 1) throw new ApiError(400, "Το όριο ασυνήθιστης απόστασης δεν είναι έγκυρο.");
    changes.unusual_distance_km = String(value);
  }
  if (!Object.keys(changes).length) throw new ApiError(400, "Δεν δόθηκαν ρυθμίσεις.");
  const critical = Boolean(changes.admin_session_duration || changes.safety_fallback_hour || changes.unusual_distance_km);
  const pinUsed = critical ? await requirePin(request, env, deps, actor) : false;
  const now = nowIso();
  await env.DB.batch(Object.entries(changes).map(([key, value]) => env.DB.prepare(`INSERT INTO system_settings
    (key,value,updated_at,updated_by) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET
    value=excluded.value,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
    .bind(key, value, now, actor.user_id)));
  await audit(env, request, actor, "settings_updated", "settings", "system", null, changes, text(body.reason, 500), pinUsed);
  return wfJson({ updated: true, settings: changes });
}

const EXPORT_TABLES = [
  "app_users", "registered_devices", "vehicle_registry", "vehicle_archives", "shift_templates", "schedule_assignments", "schedule_week_drafts", "schedule_publications",
  "schedule_acknowledgements", "schedule_vehicle_waivers", "schedules", "shifts", "vehicle_segments",
  "correction_requests", "pay_rules", "pay_rule_versions", "special_rates", "special_rate_assignments", "payroll_segments",
  "payroll_periods", "payroll_adjustments", "payroll_snapshots", "system_alerts", "alert_rules", "audit_log", "system_settings",
  "deleted_records"
];

async function systemExport(request, env, deps) {
  if (!await deps.serverAuthorized(request, env)) throw new ApiError(401, "Μη έγκυρος Server.");
  await runMaintenance(env);
  const data = {};
  for (const table of EXPORT_TABLES) {
    const result = await env.DB.prepare(`SELECT * FROM ${table}`).all();
    data[table] = result.results || [];
  }
  const snapshot = await deps.readSnapshot(env);
  return wfJson({ schemaVersion: 5, createdAt: nowIso(), fleet: snapshot.data, workforce: data });
}

function importStatement(env, table, row) {
  const columnsByTable = {
    app_users: ["id","full_name","username","email","phone","password_hash","password_salt","password_iterations","role","permissions","active","employee_group","pay_rule_id","assigned_vehicle_id","uses_own_vehicle","hire_date","notes","show_schedule","show_actual_clock_in","show_actual_clock_out","show_payable_hours","show_payment_amount","show_shift_kilometers","can_change_vehicle","force_logout_after","last_seen_at","created_at","updated_at"],
    registered_devices: ["id","user_id","name","platform","first_seen_at","last_seen_at","active"],
    vehicle_registry: ["bike_id","name","odometer","status","active_shift_id","version","updated_at"],
    vehicle_archives: ["bike_id","name","odometer","original_status","snapshot_json","archived_at","archived_by","reason","active","restored_at","restored_by","restore_reason"],
    shift_templates: ["id","name","segments","active","sort_order","color","created_by","created_at","updated_at"],
    schedule_assignments: ["id","employee_id","template_id","work_date","vehicle_id","status","notes","created_by","created_at","updated_at"],
    schedule_week_drafts: ["week_start","assignments","state","base_revision","created_by","created_at","updated_at"],
    schedule_publications: ["week_start","revision","published_by","published_at"],
    schedule_acknowledgements: ["week_start","revision","employee_id","acknowledged_at"],
    schedule_vehicle_waivers: ["week_start","assignment_key","reason","created_by","created_at"],
    schedules: ["id","employee_id","vehicle_id","series_id","start_at","end_at","status","notes","created_by","created_at","updated_at"],
    shifts: ["id","employee_id","schedule_id","vehicle_id","current_vehicle_id","status","actual_clock_in","actual_clock_out","effective_clock_out","automatic_closed_at","payable_clock_in","payable_clock_out","payable_minutes","initial_km","final_km","shift_km","rule_id","rule_version","rule_snapshot","base_pay_cents","special_pay_cents","final_pay_cents","out_of_schedule","overtime_status","overtime_rate_cents","overtime_minutes_override","overtime_approved_by","overtime_approved_by_name","overtime_approved_at","missing_km","notes","created_at","updated_at"],
    vehicle_segments: ["id","shift_id","vehicle_id","started_at","ended_at","initial_km","final_km","changed_by","reason"],
    correction_requests: ["id","shift_id","employee_id","type","message","status","resolution","resolved_by","created_at","resolved_at"],
    pay_rules: ["id","name","scope_type","scope_id","version","priority","normal_rate_cents","start_round_mode","start_round_minutes","late_grace_minutes","late_clock_out_grace_minutes","end_round_mode","end_round_minutes","duration_round_mode","payable_increment_minutes","minimum_minutes","maximum_minutes","valid_from","valid_until","active","created_by","created_at","updated_at"],
    pay_rule_versions: ["rule_id","version","snapshot","created_by","created_at"],
    special_rates: ["id","pay_rule_id","label","start_time","end_time","rate_cents","capacity","qualification","priority","active"],
    special_rate_assignments: ["special_rate_id","employee_id","date","assigned_by","created_at"],
    payroll_segments: ["id","shift_id","special_rate_id","label","start_at","end_at","minutes","rate_cents","amount_cents"],
    payroll_periods: ["id","start_date","end_date","status","locked_at","locked_by","unlocked_at","unlocked_by","unlock_reason","created_at","updated_at"],
    payroll_adjustments: ["id","period_id","employee_id","kind","amount_cents","minutes","date","reason","created_by","created_at"],
    payroll_snapshots: ["id","period_id","employee_id","data","created_at"],
    system_alerts: ["id","type","severity","title","message","object_type","object_id","dedupe_key","resolved","resolved_by","resolved_at","created_at"],
    alert_rules: ["type","enabled","severity","channel","updated_at","updated_by"],
    deleted_records: ["id","record_type","record_id","label","payload","deleted_at","deleted_by","deleted_by_name","reason","restored_at","restored_by","restore_reason"],
    audit_log: ["id","timestamp","user_id","user_name","role","action","object_type","object_id","old_value","new_value","reason","ip_address","device_id","admin_pin_used"],
    system_settings: ["key","value","updated_at","updated_by"]
  };
  const columns = columnsByTable[table];
  if (!columns) return null;
  const placeholders = columns.map(() => "?").join(",");
  const updates = columns.filter((column) => !["id", "bike_id", "key", "special_rate_id", "employee_id", "date"].includes(column)).map((column) => `${column}=excluded.${column}`).join(",");
  const sql = table === "audit_log" || table === "pay_rule_versions"
    ? `INSERT OR IGNORE INTO ${table} (${columns.join(",")}) VALUES (${placeholders})`
    : `INSERT INTO ${table} (${columns.join(",")}) VALUES (${placeholders}) ON CONFLICT DO UPDATE SET ${updates || `${columns[0]}=excluded.${columns[0]}`}`;
  return env.DB.prepare(sql).bind(...columns.map((column) => row[column] === undefined
    ? (table === "app_users" && column === "uses_own_vehicle" ? 0
      : table === "pay_rules" && column === "late_grace_minutes" ? 0
      : table === "pay_rules" && column === "late_clock_out_grace_minutes" ? 30
      : table === "shifts" && column === "overtime_minutes_override" ? null
      : table === "shifts" && column === "overtime_approved_by_name" ? ""
      : null)
    : row[column]));
}

async function systemImport(request, env, deps) {
  if (!await deps.serverAuthorized(request, env)) throw new ApiError(401, "Μη έγκυρος Server.");
  await requirePin(request, env, deps);
  const body = await bodyJson(request);
  if (Number(body.schemaVersion) < 2 || !body.workforce || typeof body.workforce !== "object") throw new ApiError(400, "Το system backup δεν είναι έγκυρο.");
  const statements = [];
  for (const table of EXPORT_TABLES) {
    const rows = Array.isArray(body.workforce[table]) ? body.workforce[table] : [];
    rows.forEach((row) => {
      const statement = importStatement(env, table, row);
      if (statement) statements.push(statement);
    });
  }
  for (let index = 0; index < statements.length; index += 70) await env.DB.batch(statements.slice(index, index + 70));
  if (body.fleet && Array.isArray(body.fleet.bikes)) await deps.writeSnapshot(env, body.fleet, "backup-restore", Date.now());
  await audit(env, request, null, "system_backup_restored", "backup", text(body.createdAt, 40), null, { records: statements.length }, "Restore από Server APK", true);
  return wfJson({ restored: true, records: statements.length });
}
