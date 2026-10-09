import assert from "node:assert/strict";
import { mergeBike, normalizeBike } from "../cloudflare-worker/src/worker.js";

const base = {
  id: "moto-1",
  name: "ΜΗΧ-01",
  intervalKm: 3000,
  lastServiceKm: 10000,
  currentKm: 12600,
  history: [
    { id: "oil-1", type: "service", km: 10000, date: "2026-01-01", tasks: ["Αλλαγή λαδιών"], oilChanged: true },
    { id: "service-2", type: "service", km: 12500, date: "2026-02-01", notes: "Γενικός έλεγχος\nΑλλαγή φίλτρου", workshop: "Moto Service", oilChanged: false },
    { id: "check-1", type: "check", km: 12600, date: "2026-02-02" }
  ]
};

const withoutOil = normalizeBike(base);
assert.equal(withoutOil.lastServiceKm, 10000, "Σέρβις χωρίς λάδια δεν πρέπει να μηδενίζει τον κύκλο.");
assert.equal(withoutOil.nextServiceKm, 13000);
assert.deepEqual(Array.from(withoutOil.history[1].tasks), ["Γενικός έλεγχος", "Αλλαγή φίλτρου"]);
assert.equal(withoutOil.history[1].workshop, "Moto Service");
assert.equal(withoutOil.history.filter((entry) => entry.type === "check").length, 1);

const withDocument = normalizeBike({
  ...base,
  history: base.history.map((entry) => entry.id === "service-2"
    ? {
        ...entry,
        attachments: [{
          id: "invoice-1",
          key: "service-documents/moto-1/service-2/invoice-1.pdf",
          name: "invoice-1.pdf",
          contentType: "application/pdf",
          size: 2048,
          uploadedAt: "2026-02-01T12:00:00.000Z",
          qrValue: "https://provider.example/invoice/abc",
          qrUrl: "https://provider.example/invoice/abc",
          ocr: { supplier: "Moto Service", workPerformed: "Αλλαγή φίλτρου", totalAmount: "86,50" }
        }],
        invoiceData: { supplier: "Moto Service", plate: "ΜΗΧ-01", odometerKm: "12500", totalAmount: "86,50", workPerformed: "Αλλαγή φίλτρου", confirmedAt: "2026-02-01T12:01:00.000Z" }
      }
    : entry)
});
assert.equal(withDocument.history.find((entry) => entry.id === "service-2").attachments.length, 1,
  "Τα τιμολόγια πρέπει να διατηρούνται στον canonical snapshot.");
assert.equal(withDocument.history.find((entry) => entry.id === "service-2").attachments[0].ocr.workPerformed, "Αλλαγή φίλτρου");
assert.equal(withDocument.history.find((entry) => entry.id === "service-2").attachments[0].qrUrl, "https://provider.example/invoice/abc");
assert.equal(withDocument.history.find((entry) => entry.id === "service-2").invoiceData.totalAmount, "86,50");

const retroactiveInvoice = normalizeBike({
  id: "retroactive", name: "TNH-921", intervalKm: 3000,
  history: [{
    id: "retro-service", type: "service", km: 14000, date: "2026-08-17",
    tasks: ["12345 - Λάδι Yamalube 20W50", "Αλλαγή λαδιών", "67890 - Φίλτρο λαδιού", "Φίλτρο λαδιού"],
    invoiceData: {
      workPerformed: "54321 - Έλεγχος φρένων\nΑλλαγή λαδιών",
      parts: [{ code: "A-1234", description: "A-1234 - Φίλτρο λαδιού" }],
      lineItems: [{ sku: "998877", name: "998877 - Εργασία ελέγχου" }]
    }
  }]
});
assert.deepEqual(retroactiveInvoice.history[0].tasks, ["Αλλαγή λαδιών — Λάδι Yamalube 20W50", "Φίλτρο λαδιού"],
  "Οι παλιές εργασίες πρέπει να αφαιρούν κωδικούς και να συγχωνεύουν μόνο τις πραγματικά διπλές εργασίες.");
assert.equal(retroactiveInvoice.history[0].invoiceData.parts[0], "Φίλτρο λαδιού");
assert.equal(retroactiveInvoice.history[0].invoiceData.lineItems[0], "Εργασία ελέγχου");
assert.equal(retroactiveInvoice.history[0].invoiceData.workPerformed, "Έλεγχος φρένων\nΑλλαγή λαδιών");

const withOil = normalizeBike({
  ...base,
  history: base.history.concat({ id: "oil-2", type: "service", km: 12700, date: "2026-02-03", tasks: ["Αλλαγή λαδιών"], oilChanged: true })
});
assert.equal(withOil.lastServiceKm, 12700, "Η αλλαγή λαδιών πρέπει να ξεκινά νέο κύκλο.");
assert.equal(withOil.nextServiceKm, 15700);

const merged = mergeBike(withoutOil, withOil);
assert.equal(merged.lastServiceKm, 12700);
assert.equal(merged.history.length, 4);

const corrected = normalizeBike({
  ...withOil,
  updatedAt: "2027-01-02T12:00:00.000Z",
  historyCorrectedAt: "2027-01-02T12:00:00.000Z",
  history: withOil.history.map((entry) => entry.id === "check-1"
    ? { ...entry, km: 12540, updatedAt: "2027-01-02T12:00:00.000Z" }
    : entry)
});
const mergedWithStale = mergeBike(corrected, withOil);
assert.equal(mergedWithStale.history.find((entry) => entry.id === "check-1").km, 12540,
  "Η διορθωμένη εγγραφή πρέπει να υπερισχύει παλιού αντιγράφου.");

const deletedOil = normalizeBike({
  ...corrected,
  updatedAt: "2027-01-03T12:00:00.000Z",
  historyCorrectedAt: "2027-01-03T12:00:00.000Z",
  historyDeletedIds: ["oil-2"],
  history: corrected.history.filter((entry) => entry.id !== "oil-2")
});
assert.equal(deletedOil.lastServiceKm, 10000, "Η διαγραφή αλλαγής λαδιών πρέπει να επαναφέρει τον προηγούμενο κύκλο.");
assert.equal(deletedOil.nextServiceKm, 13000);
const mergedAfterDelete = mergeBike(deletedOil, withOil);
assert.equal(mergedAfterDelete.history.some((entry) => entry.id === "oil-2"), false,
  "Η διαγραμμένη εγγραφή δεν πρέπει να επανεμφανίζεται από παλιό συγχρονισμό.");
assert.equal(mergedAfterDelete.lastServiceKm, 10000);

const majorDue = normalizeBike({
  id: "moto-major", name: "ΜΗΧ-ΜΕΓΑΛΟ", intervalKm: 2000,
  lastServiceKm: 87000, currentKm: 88950,
  history: [{ id: "oil-87", type: "service", km: 87000, date: "2026-03-01", tasks: ["Αλλαγή λαδιών"], oilChanged: true }]
});
assert.equal(majorDue.hasMajorService, false, "Χωρίς καταχώρηση μεγάλου service δεν πρέπει να υπάρχει ενεργός κύκλος.");
assert.equal(majorDue.nextMajorServiceKm, 0, "Ο πρώτος κύκλος ξεκινά μόνο μετά από χειροκίνητη δήλωση.");
assert.equal(majorDue.majorServiceTargetKm, 0, "Μη καταχωρημένο μεγάλο service δεν πρέπει να δημιουργεί στόχο.");

const majorCompleted = normalizeBike({
  ...majorDue,
  lastServiceKm: 89000,
  currentKm: 89000,
  history: majorDue.history.concat({
    id: "major-88900", type: "service", km: 88900, date: "2026-03-10",
    tasks: ["Αλλαγή λαδιών", "Μεγάλο service"], oilChanged: true, majorService: true
  })
});
assert.equal(majorCompleted.lastServiceKm, 89000, "Το λάδι πρέπει να συνεχίζει να ορίζει μόνο του τον κανονικό κύκλο.");
assert.equal(majorCompleted.hasMajorService, true);
assert.equal(majorCompleted.lastMajorServiceKm, 88900);
assert.equal(majorCompleted.lastMajorServiceMilestoneKm, 88900, "Το baseline πρέπει να κρατά τα πραγματικά χιλιόμετρα.");
assert.equal(majorCompleted.nextMajorServiceKm, 98900, "Μετά τη δήλωση μεγάλου service μετρά ακριβώς 10.000 χλμ.");
assert.equal(majorCompleted.majorServiceTargetKm, 98900, "Ο στόχος δεν πρέπει να στρογγυλοποιείται ούτε να ευθυγραμμίζεται με τα λάδια.");

const majorPending = normalizeBike({ ...majorDue, pendingMajorServiceKm: 90000, lastServiceKm: 89000, currentKm: 91000 });
assert.equal(majorPending.hasMajorService, false, "Παλιό pending χωρίς πραγματική καταχώρηση δεν πρέπει να ενεργοποιεί υπενθύμιση.");
assert.equal(majorPending.pendingMajorServiceKm, 0);
assert.equal(majorPending.majorServiceTargetKm, 0);

const completedWinsStalePending = mergeBike(majorCompleted, majorPending);
assert.equal(completedWinsStalePending.pendingMajorServiceKm, 0, "Παλιό pending δεν πρέπει να ξανανοίγει μετά από ολοκληρωμένο μεγάλο service.");
assert.equal(completedWinsStalePending.lastMajorServiceMilestoneKm, 88900);
assert.equal(completedWinsStalePending.nextMajorServiceKm, 98900);

console.log("OK Worker model: bullets, oil-only reset, major-service milestones, edits and durable deletes");
