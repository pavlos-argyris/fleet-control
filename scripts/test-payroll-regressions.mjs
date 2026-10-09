import assert from "node:assert/strict";
import {
  computePayBreakdown,
  coverageBucketStatus,
  zonedLocalToUtc
} from "../cloudflare-worker/src/workforce-core.js";

const timeZone = "Europe/Athens";
const scheduledStart = zonedLocalToUtc("2026-09-15", "15:00", timeZone);
const actualStart = zonedLocalToUtc("2026-09-15", "15:21", timeZone);
const scheduledEnd = zonedLocalToUtc("2026-09-16", "01:00", timeZone);
const actualEnd = zonedLocalToUtc("2026-09-16", "01:30", timeZone);
const specialWindows = [
  { id: "night10", label: "00:00–01:00", startTime: "00:00", endTime: "01:00", rateCents: 1000, priority: 20, qualified: true },
  { id: "night15", label: "01:00–02:00", startTime: "01:00", endTime: "02:00", rateCents: 1500, priority: 20, qualified: true }
];
const rule = {
  normalRateCents: 600,
  startRoundMode: "up",
  startRoundMinutes: 30,
  lateGraceMinutes: 0,
  endRoundMode: "none",
  endRoundMinutes: 1,
  durationRoundMode: "nearest",
  payableIncrementMinutes: 1,
  minimumMinutes: 0,
  maximumMinutes: 720
};

const capped = computePayBreakdown({
  actualStart,
  actualEnd: scheduledEnd,
  scheduledStart,
  rule,
  specialWindows,
  timeZone
});
assert.equal(capped.payableStart, zonedLocalToUtc("2026-09-15", "15:30", timeZone));
assert.equal(capped.payableMinutes, 570);
assert.equal(capped.totalPayCents, 6100);

const approved = computePayBreakdown({
  actualStart,
  actualEnd,
  scheduledStart,
  overtimeStart: scheduledEnd,
  rule,
  specialWindows,
  timeZone
});
assert.equal(approved.payableMinutes, 600);
assert.equal(approved.totalPayCents, 6850);

const customRate = computePayBreakdown({
  actualStart,
  actualEnd,
  scheduledStart,
  overtimeStart: scheduledEnd,
  overtimeRateCents: 1200,
  rule,
  specialWindows,
  timeZone
});
assert.equal(customRate.totalPayCents, 6700);

const grace = computePayBreakdown({
  actualStart: zonedLocalToUtc("2026-09-15", "15:04", timeZone),
  actualEnd: scheduledEnd,
  scheduledStart,
  rule: { ...rule, lateGraceMinutes: 5 },
  specialWindows,
  timeZone
});
assert.equal(grace.payableStart, scheduledStart);

const now = Date.now();
assert.equal(coverageBucketStatus(1, 0, new Date(now + 60 * 60 * 1000), now), "planned");
assert.equal(coverageBucketStatus(1, 0, new Date(now - 60 * 60 * 1000), now), "under");

console.log("OK payroll and coverage regression checks");
