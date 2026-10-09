import assert from "node:assert/strict";
import { effectiveScheduleVehicleId, isOwnVehicleShiftId, ownVehicleShiftId, replaceScheduleDraftEmployee, resolveEmployeeAssignedVehicleId } from "../cloudflare-worker/src/workforce.js";

assert.equal(
  resolveEmployeeAssignedVehicleId({ assignedVehicleId: null }, { assigned_vehicle_id: "bike-old" }),
  null,
  "Το ρητό null πρέπει να αφαιρεί τη μόνιμη ανάθεση."
);
assert.equal(
  resolveEmployeeAssignedVehicleId({ assignedVehicleId: "" }, { assigned_vehicle_id: "bike-old" }),
  null,
  "Η ρητή κενή τιμή πρέπει να αφαιρεί τη μόνιμη ανάθεση."
);
assert.equal(
  resolveEmployeeAssignedVehicleId({}, { assigned_vehicle_id: "bike-old" }),
  "bike-old",
  "Το παραλειπόμενο πεδίο πρέπει να διατηρεί την παλιά ανάθεση."
);
assert.equal(
  effectiveScheduleVehicleId({ vehicleId: null, withoutVehicle: false }, { assigned_vehicle_id: "bike-fixed" }),
  "bike-fixed",
  "Το πρόγραμμα πρέπει να χρησιμοποιεί το μόνιμα ανατεθειμένο μηχανάκι ως προεπιλογή."
);
assert.equal(
  effectiveScheduleVehicleId({ vehicleId: "__no_vehicle__", withoutVehicle: true }, { assigned_vehicle_id: "bike-fixed" }),
  null,
  "Η ρητή επιλογή Χωρίς μηχανάκι πρέπει να υπερισχύει της μόνιμης ανάθεσης."
);
assert.equal(
  effectiveScheduleVehicleId({ vehicleId: "bike-selected", withoutVehicle: false }, { assigned_vehicle_id: "bike-fixed" }),
  "bike-selected",
  "Η ρητή επιλογή μηχανής πρέπει να υπερισχύει της μόνιμης ανάθεσης."
);
assert.equal(
  effectiveScheduleVehicleId({ vehicleId: "bike-selected", withoutVehicle: false }, { assigned_vehicle_id: "bike-fixed", uses_own_vehicle: 1 }),
  null,
  "Το ιδιόκτητο μηχανάκι πρέπει να υπερισχύει οποιασδήποτε μηχανής στόλου στο πρόγραμμα."
);
assert.equal(ownVehicleShiftId("employee-a"), "__own_vehicle__:employee-a", "Το ιδιόκτητο shift id πρέπει να είναι μοναδικό ανά εργαζόμενο.");
assert.equal(isOwnVehicleShiftId("__own_vehicle__:employee-a"), true, "Το ιδιόκτητο shift πρέπει να αναγνωρίζεται χωρίς registry μηχανής.");
assert.equal(isOwnVehicleShiftId("bike-1"), false, "Η μηχανή στόλου δεν πρέπει να αναγνωρίζεται ως ιδιόκτητη.");

const mergedDraft = replaceScheduleDraftEmployee(
  [
    { employeeId: "employee-a", date: "2026-09-21", templateId: "shift-1" },
    { employeeId: "employee-b", date: "2026-09-21", templateId: "shift-2" }
  ],
  [{ employeeId: "employee-b", date: "2026-09-22", templateId: "shift-3" }],
  "employee-b"
);
assert.deepEqual(mergedDraft.map((item) => `${item.employeeId}:${item.date}`), [
  "employee-a:2026-09-21", "employee-b:2026-09-22"
], "Η καταχώρηση νέου διανομέα πρέπει να κρατά τους προηγούμενους στο Πρόχειρο.");

console.log("OK schedule regressions: clear permanent vehicle and apply schedule default");
