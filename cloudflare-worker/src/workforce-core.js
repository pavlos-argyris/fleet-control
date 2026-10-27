export const ROLE_PERMISSIONS = Object.freeze({
  owner: ["*"],
  manager: [
    "dashboard.view", "employees.view", "employees.manage", "shifts.view", "shifts.manage",
    "shifts.vehicle.change", "schedules.view", "schedules.manage", "fleet.view", "fleet.manage",
    "service.manage", "payroll.view", "reports.view", "alerts.view", "alerts.manage"
  ],
  payroll_manager: [
    "dashboard.view", "employees.view", "shifts.view", "schedules.view", "payroll.view",
    "payroll.manage", "payroll.lock", "reports.view", "audit.view", "alerts.view"
  ],
  fleet_manager: [
    "dashboard.view", "employees.view", "shifts.view", "fleet.view", "fleet.manage",
    "service.manage", "reports.view", "alerts.view", "alerts.manage", "shifts.vehicle.change"
  ],
  employee: ["clock_in_out", "select_vehicle", "view_own_history", "request_correction"]
});

export const ALL_PERMISSIONS = Object.freeze([
  "dashboard.view", "employees.view", "employees.manage", "clock_in_out", "select_vehicle",
  "view_own_history", "view_hours", "view_history", "view_kilometers", "view_pay",
  "request_correction", "shifts.view", "shifts.manage", "shifts.vehicle.change",
  "schedules.view", "schedules.manage", "fleet.view", "fleet.manage", "service.manage",
  "payroll.view", "payroll.manage", "payroll.lock", "reports.view", "alerts.view",
  "alerts.manage", "audit.view", "backup.manage", "server.manage", "settings.manage",
  "security.manage"
]);

// Employee accounts may only receive permissions that are scoped to their own
// shift and their own optional visibility.  Keeping this allowlist in the core
// permission resolver also protects accounts that may already contain an old
// or accidentally over-broad override in D1.
export const EMPLOYEE_ALLOWED_PERMISSIONS = Object.freeze([
  "clock_in_out", "select_vehicle", "view_own_history", "view_hours",
  "view_history", "view_kilometers", "view_pay", "request_correction"
]);

export function normalizeRole(value) {
  const role = String(value || "employee").toLowerCase();
  return Object.prototype.hasOwnProperty.call(ROLE_PERMISSIONS, role) ? role : "employee";
}

export function sanitizePermissionOverrides(role, overrides) {
  const normalizedRole = normalizeRole(role);
  if (normalizedRole === "owner") return [];
  const allowed = new Set(normalizedRole === "employee" ? EMPLOYEE_ALLOWED_PERMISSIONS : ALL_PERMISSIONS);
  const normalized = new Map();
  const requested = Array.isArray(overrides) ? overrides : [];
  requested.forEach((entry) => {
    const raw = String(entry || "").trim();
    const denied = raw.startsWith("!");
    const permission = denied ? raw.slice(1) : raw;
    if (!allowed.has(permission)) return;
    normalized.set(permission, denied ? `!${permission}` : permission);
  });
  return [...normalized.values()];
}

export function effectivePermissions(role, overrides) {
  const normalizedRole = normalizeRole(role);
  const base = new Set(ROLE_PERMISSIONS[normalizedRole] || []);
  const requested = sanitizePermissionOverrides(normalizedRole, overrides);
  requested.forEach((entry) => {
    const value = String(entry || "").trim();
    if (!value) return;
    if (value.startsWith("!")) base.delete(value.slice(1));
    else if (ALL_PERMISSIONS.includes(value)) base.add(value);
  });
  return [...base];
}

export function hasPermission(permissions, permission) {
  const values = Array.isArray(permissions) ? permissions : [];
  return values.includes("*") || values.includes(permission);
}

export function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

export function roundInstant(value, mode = "none", incrementMinutes = 1) {
  const input = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(input) || mode === "none") return input;
  const size = Math.max(1, Math.round(Number(incrementMinutes) || 1)) * 60_000;
  const ratio = input / size;
  if (mode === "down") return Math.floor(ratio) * size;
  if (mode === "up") return Math.ceil(ratio) * size;
  return Math.ceil(ratio - 0.5) * size;
}

export function roundDurationMinutes(minutes, mode = "nearest", incrementMinutes = 1) {
  const size = Math.max(1, Math.round(Number(incrementMinutes) || 1));
  const ratio = Math.max(0, Number(minutes) || 0) / size;
  if (mode === "down") return Math.floor(ratio) * size;
  if (mode === "up") return Math.ceil(ratio) * size;
  if (mode === "none") return Math.max(0, Number(minutes) || 0);
  return Math.ceil(ratio - 0.5) * size;
}

export function coverageBucketStatus(plannedCount, actualCount, endAt, now = Date.now()) {
  const planned = Math.max(0, Number(plannedCount) || 0);
  const actual = Math.max(0, Number(actualCount) || 0);
  const end = endAt instanceof Date ? endAt.getTime() : new Date(endAt).getTime();
  const current = now instanceof Date ? now.getTime() : Number(now);
  // A future bucket is information about the plan, not evidence of a staffing
  // gap. Coverage is evaluated only after the complete half-hour has elapsed.
  if (Number.isFinite(end) && Number.isFinite(current) && end > current) {
    return planned ? "planned" : actual > planned ? "over" : "empty";
  }
  return planned > actual ? "under" : actual > planned ? "over" : planned ? "covered" : "empty";
}

const zonedFormatters = new Map();
function zonedParts(value, timeZone) {
  const zone = timeZone || "Europe/Athens";
  let formatter = zonedFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone || "Europe/Athens", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", weekday: "short"
    });
    if (zonedFormatters.size >= 8) zonedFormatters.clear();
    zonedFormatters.set(zone, formatter);
  }
  const parts = formatter.formatToParts(new Date(value));
  const result = {};
  parts.forEach((part) => { if (part.type !== "literal") result[part.type] = part.value; });
  return result;
}

export function localDate(value, timeZone = "Europe/Athens") {
  const p = zonedParts(value, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

export function localMinutes(value, timeZone = "Europe/Athens") {
  const p = zonedParts(value, timeZone);
  return Number(p.hour) * 60 + Number(p.minute);
}

export function zonedLocalToUtc(date, time, timeZone = "Europe/Athens") {
  const dateMatch = String(date || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const timeMatch = String(time || "").match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!dateMatch || !timeMatch) throw new Error("Μη έγκυρη ημερομηνία ή ώρα.");
  const desired = Date.UTC(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]), Number(timeMatch[1]), Number(timeMatch[2]), Number(timeMatch[3] || 0));
  let guess = desired;
  for (let count = 0; count < 4; count += 1) {
    const p = zonedParts(guess, timeZone);
    const represented = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
    guess += desired - represented;
  }
  return new Date(guess).toISOString();
}

export function addCalendarDays(date, days) {
  const match = String(date).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error("Μη έγκυρη ημερομηνία.");
  const value = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + Number(days || 0)));
  return value.toISOString().slice(0, 10);
}

export function weekdayForDate(date) {
  const value = new Date(`${date}T12:00:00Z`);
  return value.getUTCDay();
}

export function scheduleInterval(date, startTime, endTime, timeZone = "Europe/Athens") {
  const start = zonedLocalToUtc(date, startTime, timeZone);
  let endDate = date;
  if (String(endTime) <= String(startTime)) endDate = addCalendarDays(date, 1);
  const end = zonedLocalToUtc(endDate, endTime, timeZone);
  return { start, end };
}

function windowMatches(minuteOfDay, startMinute, endMinute) {
  if (startMinute === endMinute) return true;
  if (endMinute > startMinute) return minuteOfDay >= startMinute && minuteOfDay < endMinute;
  return minuteOfDay >= startMinute || minuteOfDay < endMinute;
}

function toMinute(value) {
  const match = String(value || "").match(/^(\d{2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
}

export function computePayBreakdown(input) {
  const rule = input.rule || {};
  const timeZone = input.timeZone || "Europe/Athens";
  const actualStart = new Date(input.actualStart).getTime();
  const actualEnd = new Date(input.actualEnd).getTime();
  if (!Number.isFinite(actualStart) || !Number.isFinite(actualEnd) || actualEnd < actualStart) {
    throw new Error("Οι ώρες της βάρδιας δεν είναι έγκυρες.");
  }

  const scheduledStart = input.scheduledStart ? new Date(input.scheduledStart).getTime() : NaN;
  const lateGraceMinutes = Math.max(0, Number(rule.lateGraceMinutes) || 0);
  const withinLateGrace = Number.isFinite(scheduledStart) && actualStart >= scheduledStart &&
    actualStart <= scheduledStart + lateGraceMinutes * 60_000;
  let payableStart = withinLateGrace
    ? scheduledStart
    : roundInstant(actualStart, rule.startRoundMode || "none", rule.startRoundMinutes || 1);
  let payableEnd = roundInstant(actualEnd, rule.endRoundMode || "none", rule.endRoundMinutes || 1);
  const hardEnd = input.hardEndAt ? new Date(input.hardEndAt).getTime() : NaN;
  // A scheduled end (or an explicitly approved payroll end) may be a hard
  // boundary. End rounding must never extend an unapproved shift beyond it.
  if (Number.isFinite(hardEnd)) payableEnd = Math.min(payableEnd, hardEnd);
  if (payableEnd < payableStart) payableEnd = payableStart;

  // Payroll uses exact payable minutes. The legacy duration-rounding fields
  // remain readable in old snapshots for compatibility, but are not applied
  // to live calculations so a second rounding pass cannot alter pay.
  let durationMinutes = (payableEnd - payableStart) / 60_000;
  const minimum = Math.max(0, Number(rule.minimumMinutes) || 0);
  const maximum = Math.max(minimum || 0, Number(rule.maximumMinutes) || 24 * 60);
  durationMinutes = Math.min(maximum, Math.max(minimum, durationMinutes));
  payableEnd = payableStart + durationMinutes * 60_000;

  const normalRate = Math.max(0, Math.round(Number(rule.normalRateCents) || 0));
  const windows = Array.isArray(input.specialWindows) ? input.specialWindows.filter((item) => item && item.qualified !== false) : [];
  const overtimeStart = input.overtimeStart ? new Date(input.overtimeStart).getTime() : NaN;
  const overtimeRate = input.overtimeRateCents === null || input.overtimeRateCents === undefined
    ? null
    : Math.max(0, Math.round(Number(input.overtimeRateCents)));
  const hasOvertimeOverride = Number.isFinite(overtimeStart) && Number.isFinite(overtimeRate);
  const segments = [];
  const totalWholeMinutes = Math.floor(durationMinutes);

  function rateFor(minuteStart) {
    if (hasOvertimeOverride && minuteStart >= overtimeStart) {
      return {
        key: "__overtime_override__",
        specialRateId: "__overtime_override__",
        label: "Υπερωρία (εγκεκριμένη)",
        rateCents: overtimeRate
      };
    }
    const minuteOfDay = windows.length ? localMinutes(minuteStart, timeZone) : 0;
    const candidates = windows.filter((window) => windowMatches(minuteOfDay, toMinute(window.startTime), toMinute(window.endTime)))
      .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));
    const special = candidates[0] || null;
    const rate = special ? Math.max(0, Math.round(Number(special.rateCents) || 0)) : normalRate;
    return {
      key: special ? String(special.id || special.label || rate) : "normal",
      specialRateId: special ? String(special.id || "") : null,
      label: special ? String(special.label || "Ειδική ώρα") : "Κανονική αμοιβή",
      rateCents: rate
    };
  }

  function appendSegment(minuteStart, minuteEnd, minutes) {
    const rate = rateFor(minuteStart);
    const previous = segments[segments.length - 1];
    if (previous && previous.key === rate.key && previous.rateCents === rate.rateCents) {
      previous.minutes += minutes;
      previous.end = new Date(minuteEnd).toISOString();
    } else {
      segments.push({
        key: rate.key,
        specialRateId: rate.specialRateId,
        label: rate.label,
        start: new Date(minuteStart).toISOString(),
        end: new Date(minuteEnd).toISOString(),
        minutes,
        rateCents: rate.rateCents
      });
    }
  }

  for (let index = 0; index < totalWholeMinutes;) {
    const minuteStart = payableStart + index * 60_000;
    let run = totalWholeMinutes - index;
    if (hasOvertimeOverride && minuteStart < overtimeStart) {
      run = Math.min(run, Math.max(1, Math.ceil((overtimeStart - minuteStart) / 60_000)));
    }
    if (windows.length && !(hasOvertimeOverride && minuteStart >= overtimeStart)) {
      const minute = localMinutes(minuteStart, timeZone);
      run = Math.min(run, 60);
      for (const window of windows) for (const boundary of [toMinute(window.startTime), toMinute(window.endTime)]) {
        const distance = (boundary - minute + 1440) % 1440;
        if (distance) run = Math.min(run, distance);
      }
      // Preserve the original per-minute semantics over a daylight-saving
      // jump/repeated hour. Only stable wall-clock spans are grouped.
      if (run > 1 && localMinutes(minuteStart + (run - 1) * 60_000, timeZone) !== (minute + run - 1) % 1440) run = 1;
    }
    appendSegment(minuteStart, minuteStart + run * 60_000, run);
    index += run;
  }

  const fractional = durationMinutes - totalWholeMinutes;
  if (fractional > 0.0001) {
    const minuteStart = payableStart + totalWholeMinutes * 60_000;
    appendSegment(minuteStart, payableEnd, fractional);
  }

  let basePayCents = 0;
  let specialPayCents = 0;
  segments.forEach((segment) => {
    const amount = Math.round(segment.minutes * segment.rateCents / 60);
    segment.amountCents = amount;
    if (segment.specialRateId) specialPayCents += amount;
    else basePayCents += amount;
  });

  return {
    payableStart: new Date(payableStart).toISOString(),
    payableEnd: new Date(payableEnd).toISOString(),
    payableMinutes: Math.round(durationMinutes * 1000) / 1000,
    payableHours: Math.round(durationMinutes / 60 * 100) / 100,
    basePayCents,
    specialPayCents,
    totalPayCents: basePayCents + specialPayCents,
    segments
  };
}

export function mondayPeriod(dateValue, timeZone = "Europe/Athens") {
  const date = dateValue ? localDate(dateValue, timeZone) : localDate(Date.now(), timeZone);
  const day = weekdayForDate(date);
  const monday = addCalendarDays(date, day === 0 ? -6 : 1 - day);
  return { startDate: monday, endDate: addCalendarDays(monday, 6) };
}

export function safetyFallbackAt(scheduleEnd, timeZone = "Europe/Athens", fallbackHour = 5) {
  const endDate = localDate(scheduleEnd, timeZone);
  const endMinutes = localMinutes(scheduleEnd, timeZone);
  const fallbackMinutes = Math.max(0, Math.min(23, Number(fallbackHour) || 5)) * 60;
  const date = endMinutes < fallbackMinutes ? endDate : addCalendarDays(endDate, 1);
  return zonedLocalToUtc(date, `${String(Math.floor(fallbackMinutes / 60)).padStart(2, "0")}:00`, timeZone);
}
