(function () {
  "use strict";
  const api = window.FleetInvoiceApi;
  if (!api) return;
  const $ = (id) => document.getElementById(id),
    esc = (value) =>
      String(value ?? "").replace(
        /[&<>"']/g,
        (c) =>
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          })[c],
      );
  const labels = {
    plate: "Πινακίδα",
    odometerKm: "Χιλιόμετρα",
    invoiceDate: "Ημερομηνία",
    totalAmount: "Σύνολο",
    netAmount: "Καθαρή αξία",
    vatAmount: "ΦΠΑ",
    lineItems: "Πληρότητα γραμμών",
    supplier: "Προμηθευτής",
    invoiceNumber: "Αριθμός τιμολογίου",
  };
  const plateKey = (value) =>
    String(value || "")
      .toUpperCase()
      .replace(
        /[ΑΒΕΖΗΙΚΜΝΟΡΤΥΧ]/g,
        (c) =>
          ({
            Α: "A",
            Β: "B",
            Ε: "E",
            Ζ: "Z",
            Η: "H",
            Ι: "I",
            Κ: "K",
            Μ: "M",
            Ν: "N",
            Ο: "O",
            Ρ: "P",
            Τ: "T",
            Υ: "Y",
            Χ: "X",
          })[c],
      )
      .replace(/[^A-Z0-9]/g, "");
  let dialog = null,
    stream = null,
    frame = 0,
    lastFrame = 0,
    loading = false,
    records = [],
    bikes = [],
    sessionScans = new Set(),
    requestQueue = Promise.resolve(),
    timer = 0,
    historyOpen = false;
  const scanBackoff = new Map();
  const edits = new Map(),
    targets = new Map();
  function showEvidence(data) {
    const root = $("invoiceFieldEvidence");
    if (!root) return;
    const evidence = data.fieldEvidence || {};
    root.innerHTML =
      Object.entries(evidence)
        .filter(([field]) => labels[field])
        .map(
          ([field, item]) =>
            "<details><summary>" +
            esc(labels[field]) +
            " · " +
            esc(Number(item.score) || 0) +
            "/100</summary><p>" +
            esc(item.reason) +
            "<br>Πηγή: " +
            esc(item.source) +
            "</p><pre>" +
            esc(item.evidence || "Δεν υπάρχει διαθέσιμο απόσπασμα.") +
            "</pre></details>",
        )
        .join("") +
      (Object.keys(evidence).length
        ? "<small>Οι βαθμοί είναι ενδείξεις κανόνων ανάγνωσης, όχι μετρημένη πιθανότητα ορθότητας.</small>"
        : "");
    if (data.analysisEngine)
      root.insertAdjacentHTML(
        "afterbegin",
        "<small>Αναγνώστης: " +
          esc(data.analysisEngine) +
          (data.analysisCacheHit ? " · προηγούμενη ανάλυση" : "") +
          " · " +
          esc((Number(data.analysisDurationMs || 0) / 1000).toFixed(1)) +
          "s</small>",
      );
  }
  function stopCamera() {
    cancelAnimationFrame(frame);
    frame = 0;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    if ($("invoiceImportVideo")) $("invoiceImportVideo").srcObject = null;
  }
  function close() {
    stopCamera();
    clearInterval(timer);
    timer = 0;
    if (dialog?.open) dialog.close();
    if (historyOpen) {
      historyOpen = false;
      history.back();
    }
  }
  function ensureDialog() {
    if (dialog) return;
    dialog = document.createElement("dialog");
    dialog.id = "invoiceImportDialog";
    dialog.className = "app-dialog wide-dialog";
    dialog.innerHTML =
      '<div class="dialog-head"><div><span class="overline">ΠΡΟΣΧΕΔΙΑ ΤΙΜΟΛΟΓΙΩΝ</span><h2>Μαζική σάρωση QR</h2></div><button type="button" id="invoiceImportClose" class="ghost-button service-back-button" aria-label="Πίσω">← Πίσω</button></div><p class="invoice-import-help">Σάρωσε διαδοχικά QR. Ο Server διαβάζει κάθε τιμολόγιο και το κρατά ως προσχέδιο. Διάλεξε μηχανάκι και service, έλεγξε τα πεδία και μετά πάτησε αποθήκευση. Η ημερομηνία τιμολογίου παραμένει χωριστή από την ημερομηνία service.</p><div class="invoice-import-toolbar"><button type="button" id="invoiceImportCamera" class="primary-button">Άνοιγμα κάμερας</button><button type="button" id="invoiceImportStop" class="secondary-button">Σταμάτημα κάμερας</button><button type="button" id="invoiceImportRefresh" class="secondary-button">Ανανέωση</button></div><video id="invoiceImportVideo" class="invoice-import-video" autoplay muted playsinline hidden></video><label class="field"><span>Σύνδεσμοι QR — ένας ανά γραμμή</span><textarea id="invoiceImportQr" rows="2" placeholder="https://…"></textarea></label><div class="invoice-import-toolbar"><button type="button" id="invoiceImportAdd" class="secondary-button">Προσθήκη συνδέσμων</button><button type="button" id="invoiceImportCommitAll" class="primary-button">Αποθήκευση επιλεγμένων</button></div><p id="invoiceImportStatus" class="invoice-import-status" role="status" aria-live="polite"></p><div id="invoiceImportList" class="invoice-import-list"></div>';
    document.body.appendChild(dialog);
    $("invoiceImportClose").onclick = close;
    dialog.addEventListener("cancel", (e) => {
      e.preventDefault();
      close();
    });
    dialog.addEventListener("close", () => {
      stopCamera();
      clearInterval(timer);
      timer = 0;
    });
    $("invoiceImportCamera").onclick = startCamera;
    $("invoiceImportStop").onclick = () => {
      stopCamera();
      $("invoiceImportVideo").hidden = true;
    };
    $("invoiceImportRefresh").onclick = () => refresh(true);
    $("invoiceImportAdd").onclick = () => {
      String($("invoiceImportQr").value)
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach(queueScan);
      $("invoiceImportQr").value = "";
    };
    $("invoiceImportCommitAll").onclick = async () => {
      const selected = [...edits.entries()]
        .filter(([, v]) => v.selected)
        .map(([id]) => id);
      if (!selected.length) return status("Επίλεξε έτοιμα προσχέδια.");
      $("invoiceImportCommitAll").disabled = true;
      let count = 0;
      try {
        for (const id of selected) {
          if (await commit(id)) count++;
        }
        status(
          "Αποθηκεύτηκαν " +
            count +
            " από " +
            selected.length +
            " επιλεγμένα. Τα υπόλοιπα παραμένουν στα προσχέδια.",
        );
      } finally {
        $("invoiceImportCommitAll").disabled = false;
        await refresh(true);
      }
    };
    $("invoiceImportList").addEventListener("input", saveEdit);
    $("invoiceImportList").addEventListener("change", async (e) => {
      saveEdit(e);
      if (e.target.dataset.field === "bikeId")
        await loadTargets(e.target.closest("[data-draft]").dataset.draft);
    });
    $("invoiceImportList").addEventListener("click", async (e) => {
      const button = e.target.closest("[data-action]");
      if (!button) return;
      const id = button.closest("[data-draft]").dataset.draft;
      if (button.dataset.action === "open") {
        const row = records.find((r) => r.id === id);
        return api.openPdf(row?.attachment, false);
      }
      button.disabled = true;
      try {
        if (button.dataset.action === "commit") await commit(id);
        else if (button.dataset.action === "discard") {
          if (
            !window.confirm(
              "Να αφαιρεθεί το προσχέδιο; Δεν διαγράφεται service.",
            )
          )
            return;
          await api.api("/api/admin/invoice-imports", {
            body: { action: "discard", id },
          });
          edits.delete(id);
        } else
          await api.api("/api/admin/invoice-imports", {
            body: { action: "retry", id },
          });
        await refresh(true);
      } catch (error) {
        status(error.message);
      } finally {
        button.disabled = false;
      }
    });
  }
  function status(text) {
    if ($("invoiceImportStatus")) $("invoiceImportStatus").textContent = text;
  }
  function saveEdit(e) {
    const row = e.target.closest("[data-draft]");
    if (!row || !e.target.dataset.field) return;
    const data = edits.get(row.dataset.draft);
    if (data)
      data[e.target.dataset.field] =
        e.target.type === "checkbox" ? e.target.checked : e.target.value;
  }
  async function loadTargets(id) {
    const value = edits.get(id);
    if (!value?.bikeId) return;
    const bikeId = value.bikeId;
    try {
      const result = await api.api(
        "/api/admin/invoice-imports/targets?bikeId=" +
          encodeURIComponent(bikeId),
      );
      targets.set(bikeId, result);
      if (value.bikeId === bikeId) {
        value.entryId = "";
        render();
      }
    } catch (error) {
      status(error.message);
    }
  }
  async function refresh(force) {
    if (loading || !dialog?.open) return;
    loading = true;
    try {
      const result = await api.api("/api/admin/invoice-imports");
      records = result.drafts || [];
      bikes = result.bikes || [];
      // Polling preserves edits and focus; it never replaces a form being edited.
      if (
        force ||
        !dialog.contains(document.activeElement) ||
        !document.activeElement?.matches("input,select,textarea")
      )
        render();
    } catch (error) {
      status(error.message);
    } finally {
      loading = false;
    }
  }
  function render() {
    const root = $("invoiceImportList");
    if (!root) return;
    const active = records.filter((r) => r.status !== "committed");
    root.innerHTML =
      active
        .map((row) => {
          const data = row.invoiceData || {},
            ready = ["ready", "committing"].includes(row.status);
          if (!edits.has(row.id)) {
            const bike = bikes.find(
              (b) => plateKey(b.name) === plateKey(data.plate),
            );
            edits.set(row.id, {
              selected: false,
              bikeId: bike?.id || "",
              entryId: "",
              km: data.odometerKm || "",
              date: dateInput(data.invoiceDate),
              tasks: Array.isArray(data.workPerformed)
                ? data.workPerformed.join("\n")
                : data.workPerformed || "",
              oilChanged: false,
              checked: false,
              initialized: ready,
            });
          }
          const prior = edits.get(row.id);
          if (ready && !prior.initialized) {
            const matched = bikes.find(
              (b) => plateKey(b.name) === plateKey(data.plate),
            );
            Object.assign(prior, {
              bikeId: matched?.id || "",
              km: data.odometerKm || "",
              date: dateInput(data.invoiceDate),
              tasks: Array.isArray(data.workPerformed)
                ? data.workPerformed.join("\n")
                : data.workPerformed || "",
              initialized: true,
            });
          }
          const v = edits.get(row.id),
            services = targets.get(v.bikeId)?.services || [];
          if(row.status === "committing" && row.commitIntent)Object.assign(v,{...row.commitIntent,checked:true,initialized:true});
          const locked = row.status === "committing",
            disabled = locked ? " disabled" : "";
          const controls = ready
            ? '<div class="form-grid"><label class="field"><span>Μηχανάκι</span><select data-field="bikeId"' +
              disabled +
              '><option value="">Επιλογή μηχανής</option>' +
              bikes
                .map(
                  (b) =>
                    '<option value="' +
                    esc(b.id) +
                    '"' +
                    (v.bikeId === b.id ? " selected" : "") +
                    ">" +
                    esc(b.name) +
                    "</option>",
                )
                .join("") +
              '</select></label><label class="field"><span>Service προορισμού</span><select data-field="entryId"' +
              disabled +
              '><option value="">Νέο service από προσχέδιο</option>' +
              services
                .map(
                  (s) =>
                    '<option value="' +
                    esc(s.id) +
                    '"' +
                    (v.entryId === s.id ? " selected" : "") +
                    ">" +
                    esc(s.date) +
                    " · " +
                    esc(s.km) +
                    " χλμ</option>",
                )
                .join("") +
              '</select></label><label class="field"><span>Χιλιόμετρα νέου service</span><input data-field="km" type="number" min="0" value="' +
              esc(v.km) +
              '"' +
              disabled +
              '></label><label class="field"><span>Ημερομηνία νέου service</span><input data-field="date" type="date" value="' +
              esc(v.date) +
              '"' +
              disabled +
              '></label></div><label class="field"><span>Εργασίες νέου service</span><textarea data-field="tasks" rows="2"' +
              disabled +
              ">" +
              esc(v.tasks) +
              '</textarea></label><p><label><input data-field="oilChanged" type="checkbox"' +
              (v.oilChanged ? " checked" : "") +
              disabled +
              '> Αλλαγή λαδιών στο νέο service</label></p><p><label><input data-field="checked" type="checkbox"' +
              (v.checked ? " checked" : "") +
              disabled +
              '> Έλεγξα τα στοιχεία και την επιλογή service</label></p><div class="invoice-import-toolbar"><button type="button" class="primary-button" data-action="commit">' +
              (locked ? "Συνέχιση αποθήκευσης" : "Αποθήκευση προσχεδίου") +
              '</button><button type="button" class="secondary-button" data-action="open">Άνοιγμα PDF</button></div>'
            : "";
          return (
            '<section class="invoice-import-row" data-draft="' +
            esc(row.id) +
            '"><header><label><input type="checkbox" data-field="selected"' +
            (v.selected ? " checked" : "") +
            (!ready ? " disabled" : "") +
            "> Προσχέδιο " +
            esc(row.id.slice(0, 8)) +
            "</label><strong>" +
            esc(
              locked
                ? "Αποθήκευση σε εξέλιξη"
                : ready
                  ? "Προς επιβεβαίωση"
                  : row.operationStatus === "failed"
                    ? "Απέτυχε"
                    : row.stage || "Αναμονή Server",
            ) +
            '</strong></header><p class="invoice-import-original">Πινακίδα: ' +
            esc(data.plate || "—") +
            " · Χλμ: " +
            esc(data.odometerKm || "—") +
            "\nΤιμολόγιο: " +
            esc(data.invoiceNumber || "—") +
            " · Ημερομηνία τιμολογίου: " +
            esc(data.invoiceDate || "—") +
            " · Κόστος: " +
            esc(data.totalAmount || "—") +
            "</p>" +
            controls +
            '<p class="form-error">' +
            esc(row.error || row.operationError || "") +
            '</p><div class="invoice-import-toolbar">' +
            (!ready
              ? '<button type="button" class="secondary-button" data-action="retry">Διακοπή & νέα προσπάθεια</button>'
              : "") +
            (!locked
              ? '<button type="button" class="ghost-button" data-action="discard">Αφαίρεση προσχεδίου</button>'
              : "") +
            "</div></section>"
          );
        })
        .join("") ||
      "<p>Δεν υπάρχουν ενεργά προσχέδια. Άνοιξε την κάμερα ή πρόσθεσε συνδέσμους QR.</p>";
    for (const row of active) {
      const value = edits.get(row.id);
      if (value?.bikeId && !targets.has(value.bikeId)) {
        targets.set(value.bikeId, { services: [] });
        loadTargets(row.id);
      }
    }
  }
  function dateInput(value) {
    const text = String(value || "");
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    const m = text.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);
    return m
      ? m[3] + "-" + m[2].padStart(2, "0") + "-" + m[1].padStart(2, "0")
      : "";
  }
  async function commit(id) {
    const value = edits.get(id),
      row = records.find((r) => r.id === id);
    if (!value || !row) return false;
    if (
      row.status !== "committing" &&
      (!value.checked ||
        !value.bikeId ||
        (!value.entryId && (!value.date || String(value.km).trim() === "")))
    ) {
      status(
        "Έλεγξε στοιχεία, μηχανάκι, ημερομηνία και χιλιόμετρα του προσχεδίου " +
          id.slice(0, 8) +
          ".",
      );
      return false;
    }
    const body = { action: "commit", id, ...value, km: Number(value.km) };
    for (let attempt = 0; attempt < 3; attempt++)
      try {
        await api.api("/api/admin/invoice-imports", { body });
        edits.delete(id);
        row.status = "committed";
        api.toast("Το τιμολόγιο συνδέθηκε με το service.");
        return true;
      } catch (error) {
        const d = error.details || {};
        if (error.code === "service_impact" && !body.confirmImpact) {
          if (
            !window.confirm(
              "Επίδραση στο service:\nΤρέχοντα χλμ: " +
                d.before.currentKm +
                " → " +
                d.after.currentKm +
                "\nΕπόμενα λάδια: " +
                d.before.nextServiceKm +
                " → " +
                d.after.nextServiceKm +
                "\nΝα συνεχίσω;",
            )
          )
            return false;
          body.confirmImpact = true;
          continue;
        }
        if (error.code === "duplicate_invoice" && !body.allowDuplicate) {
          if (
            !window.confirm(
              "Το τιμολόγιο υπάρχει ήδη:\n" +
                (d.matches || [])
                  .map((m) => m.bikeName + " · " + m.serviceDate)
                  .join("\n") +
                "\nΘέλεις δεύτερη καταχώρηση;",
            )
          )
            return false;
          body.allowDuplicate = true;
          continue;
        }
        status(error.message);
        return false;
      }
    return false;
  }
  function queueScan(value) {
    value = String(value || "").trim();
    if (!value || sessionScans.has(value) || Number(scanBackoff.get(value)||0)>Date.now()) return;
    sessionScans.add(value);
    requestQueue = requestQueue.then(async () => {
      try {
        const result = await api.api("/api/admin/invoice-imports", {
          body: { action: "scan", value },
        });
        if (result.duplicate) {
          status(
            result.draftId
              ? "Το QR υπάρχει ήδη στα προσχέδια."
              : "Το τιμολόγιο υπάρχει ήδη: " +
                  (result.matches || [])
                    .map((m) => m.bikeName + " · " + m.serviceDate)
                    .join(" / "),
          );
          if (result.matches?.[0]) {
            api.toast(
              "Διπλό QR: " +
                result.matches[0].bikeName +
                " · " +
                result.matches[0].serviceDate,
            );
            const link = document.createElement("button");
            link.type = "button";
            link.className = "secondary-button";
            link.textContent = "Άνοιγμα υπάρχοντος τιμολογίου";
            link.onclick = () => api.openPdf(result.matches[0], false);
            $("invoiceImportStatus").appendChild(link);
          }
        } else status("Το QR προστέθηκε. Συνέχισε με το επόμενο.");
        await refresh(false);
      } catch (error) {
        if(!error.status||error.status===429||error.status>=500){sessionScans.delete(value);scanBackoff.set(value,Date.now()+15000);}
        status(error.message);
      }
    });
  }
  async function startCamera() {
    stopCamera();
    try {
      const acquired = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      if (!dialog.open) {
        acquired.getTracks().forEach((t) => t.stop());
        return;
      }
      stream = acquired;
      const video = $("invoiceImportVideo");
      video.hidden = false;
      video.srcObject = stream;
      await video.play();
      const canvas = document.createElement("canvas"),
        ctx = canvas.getContext("2d", { willReadFrequently: true });
      function scan(now) {
        if (!stream || !dialog.open) return;
        if (now - lastFrame > 250 && video.readyState >= 2) {
          lastFrame = now;
          const scale = Math.min(
            1,
            960 / Math.max(video.videoWidth, video.videoHeight),
          );
          canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          try {
            const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height),
              result = window.jsQR?.(pixels.data, pixels.width, pixels.height, {
                inversionAttempts: "attemptBoth",
              });
            if (result?.data) queueScan(result.data);
          } catch {}
        }
        frame = requestAnimationFrame(scan);
      }
      frame = requestAnimationFrame(scan);
      status("Η κάμερα παραμένει ανοικτή για διαδοχικά QR.");
    } catch (error) {
      status(
        "Δεν άνοιξε η κάμερα. Έλεγξε την άδεια ή βάλε τον σύνδεσμο χειροκίνητα.",
      );
    }
  }
  async function open() {
    if (!api.can("fleet.manage"))
      return api.toast("Χρειάζεται δικαίωμα διαχείρισης στόλου.");
    ensureDialog();
    dialog.showModal();
    sessionScans = new Set();
    if (!window.FleetNavigation) {
      history.pushState({ invoiceImports: true }, "");
      historyOpen = true;
    }
    await refresh(true);
    if (!dialog.open) return;
    timer = setInterval(() => {
      if (!document.hidden) refresh(false);
    }, 5000);
  }
  window.addEventListener("popstate", () => {
    if (historyOpen) {
      historyOpen = false;
      close();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopCamera();
  });
  $("openInvoiceImports")?.addEventListener("click", open);
  $("invoiceBatchPause")?.addEventListener("click", async () => {
    try {
      const result = await api.api(
        "/api/admin/service-documents/reprocess-batch",
      );
      if (!result.batch)
        return api.toast("Δεν υπάρχει ενεργή μαζική ανάγνωση.");
      await api.batchAction(
        result.batch.status === "paused" ? "resume" : "pause",
      );
      api.toast(
        result.batch.status === "paused"
          ? "Η ανάγνωση συνεχίζεται."
          : "Η μαζική ανάγνωση μπήκε σε παύση. Τα νέα QR συνεχίζουν.",
      );
    } catch (error) {
      api.toast(error.message);
    }
  });
  $("invoiceRetryFailed")?.addEventListener("click", () => api.retryFailed());
  $("invoiceReaderRules")?.addEventListener("click", async () => {
    try {
      const result = await api.api("/api/admin/invoice-reader-rules");
      let rulesDialog = $("invoiceRulesDialog");
      if (rulesDialog) rulesDialog.remove();
      rulesDialog = document.createElement("dialog");
      rulesDialog.id = "invoiceRulesDialog";
      rulesDialog.className = "app-dialog";
      rulesDialog.innerHTML =
        '<form><div class="dialog-head"><h2>Κανόνες ανάγνωσης</h2><button type="button" class="ghost-button service-back-button" data-dismiss>← Πίσω</button></div><p class="invoice-import-help">Εγκεκριμένες επικεφαλίδες ανά προμηθευτή. Δεν αντικαθιστούν αριθμούς πινακίδας ή χιλιομέτρων. Ο Server λαμβάνει τις αλλαγές στον επόμενο έλεγχο έως 5 λεπτά.</p><div class="invoice-rules-list">' +
        (result.rules || [])
          .map(
            (r) =>
              "<div><span>" +
              esc(r.supplier) +
              " · " +
              esc(r.label) +
              " → " +
              esc(labels[r.field]) +
              '</span><button type="button" class="secondary-button" data-rule-delete="' +
              esc(r.id) +
              '">Αφαίρεση</button></div>',
          )
          .join("") +
        '</div><label class="field"><span>Προμηθευτής όπως εμφανίζεται στο κείμενο</span><input name="supplier" required minlength="3"></label><label class="field"><span>Επικεφαλίδα όπως γράφεται στο τιμολόγιο</span><input name="label" required minlength="3"></label><label class="field"><span>Πεδίο</span><select name="field">' +
        ["plate", "odometerKm", "invoiceDate", "totalAmount"]
          .map(
            (f) => '<option value="' + f + '">' + esc(labels[f]) + "</option>",
          )
          .join("") +
        '</select></label><p class="form-error" data-error></p><div class="dialog-actions"><button type="button" class="secondary-button" data-dismiss>Πίσω</button><button class="primary-button" type="submit">Έγκριση κανόνα</button></div></form>';
      document.body.appendChild(rulesDialog);
      rulesDialog
        .querySelectorAll("[data-dismiss]")
        .forEach((b) => (b.onclick = () => rulesDialog.close()));
      rulesDialog.onclick = async (e) => {
        const button = e.target.closest("[data-rule-delete]");
        if (!button) return;
        button.disabled = true;
        try {
          await api.api("/api/admin/invoice-reader-rules", {
            body: { action: "delete", id: button.dataset.ruleDelete },
          });
          button.parentElement.remove();
        } catch (error) {
          api.toast(error.message);
        } finally {
          button.disabled = false;
        }
      };
      rulesDialog.querySelector("form").onsubmit = async (e) => {
        e.preventDefault();
        const form = e.target,
          button = form.querySelector('[type="submit"]');
        button.disabled = true;
        try {
          await api.api("/api/admin/invoice-reader-rules", {
            body: Object.fromEntries(new FormData(form)),
          });
          rulesDialog.close();
          api.toast("Ο κανόνας εγκρίθηκε.");
        } catch (error) {
          rulesDialog.querySelector("[data-error]").textContent = error.message;
        } finally {
          button.disabled = false;
        }
      };
      rulesDialog.showModal();
    } catch (error) {
      api.toast(error.message);
    }
  });
  window.FleetInvoiceImports = { open, close, showEvidence };
})();
