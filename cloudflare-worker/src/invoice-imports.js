// QR drafts never change service history until a manager explicitly commits them.
export const INVOICE_IMPORT_SCHEMA = `CREATE TABLE IF NOT EXISTS invoice_import_drafts (
 id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL, data TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'processing', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS invoice_import_drafts_owner_status ON invoice_import_drafts(owner_id,status,created_at);
CREATE INDEX IF NOT EXISTS invoice_import_drafts_active_qr ON invoice_import_drafts(owner_id,json_extract(data,'$.qrUrl')) WHERE status IN ('processing','ready','committing');`;

export async function invoiceDuplicates(
  env,
  { qrUrl = "", supplier = "", invoiceNumber = "", excludeKey = "" },
) {
  if (!qrUrl && !(supplier && invoiceNumber)) return [];
  const rows = await env.DB.prepare(
    `SELECT json_extract(b.value,'$.id') bikeId,json_extract(b.value,'$.name') bikeName,
    json_extract(h.value,'$.id') entryId,json_extract(h.value,'$.date') serviceDate,json_extract(a.value,'$.key') key,
    json_extract(a.value,'$.name') name FROM fleet_snapshot s,json_each(s.data,'$.bikes') b,
    json_each(b.value,'$.history') h,json_each(h.value,'$.attachments') a
    WHERE s.id=1 AND json_extract(a.value,'$.key')!=? AND ((?!='' AND COALESCE(json_extract(a.value,'$.qrUrl'),json_extract(a.value,'$.qrValue'))=?)
    OR (?!='' AND ?!='' AND lower(trim(json_extract(a.value,'$.ocr.supplier')))=lower(trim(?)) AND upper(trim(json_extract(a.value,'$.ocr.invoiceNumber')))=upper(trim(?))))
    AND NOT EXISTS(SELECT 1 FROM vehicle_archives v WHERE v.active=1 AND v.bike_id=json_extract(b.value,'$.id')) LIMIT 10`,
  )
    .bind(
      excludeKey,
      qrUrl,
      qrUrl,
      supplier,
      invoiceNumber,
      supplier,
      invoiceNumber,
    )
    .all();
  return rows.results || [];
}
export async function readImportDraftForJob(env, jobId) {
  const row = await env.DB.prepare(
    "SELECT d.* FROM invoice_import_drafts d JOIN fleet_operations o ON json_extract(o.payload,'$.draftId')=d.id WHERE o.id=? LIMIT 1",
  )
    .bind(jobId)
    .first();
  return row ? { ...row, data: JSON.parse(row.data) } : null;
}
export async function finishImportDraft(env, draft, attachment) {
  const data = {
    ...draft.data,
    attachment,
    invoiceData: attachment.ocr || {},
    error: attachment.ocrError || "",
  };
  const result = await env.DB.prepare(
    "UPDATE invoice_import_drafts SET data=?,status='ready',updated_at=? WHERE id=? AND status='processing' AND json_extract(data,'$.jobId')=? AND EXISTS(SELECT 1 FROM fleet_operations WHERE id=? AND status='pending')",
  )
    .bind(
      JSON.stringify(data),
      new Date().toISOString(),
      draft.id,
      draft.data.jobId,
      draft.data.jobId,
    )
    .run();
  return {
    attached: Boolean(result.meta?.changes),
    draftId: draft.id,
    status: result.meta?.changes ? 200 : 409,
    error: "Το προσχέδιο διακόπηκε ή ενημερώθηκε.",
  };
}

export async function restartImportDraft(
  env,
  draft,
  now = new Date().toISOString(),
) {
  if (!draft || draft.status !== "processing") return null;
  const jobId = crypto.randomUUID(),
    next = { ...draft.data, jobId };
  const payload = {
    ...next,
    draftId: draft.id,
    bikeId: "draft-" + draft.id,
    entryId: "draft",
    requestedAt: now,
    progress: 5,
    progressStage: "Νέα προσπάθεια προσχεδίου",
    attemptCount: 0,
  };
  const result = await env.DB.batch([
    env.DB.prepare(
      "UPDATE fleet_operations SET status='cancelled' WHERE id=? AND EXISTS(SELECT 1 FROM invoice_import_drafts WHERE id=? AND status='processing' AND json_extract(data,'$.jobId')=?)",
    ).bind(draft.data.jobId, draft.id, draft.data.jobId),
    env.DB.prepare(
      "INSERT INTO fleet_operations(id,source,type,payload,status,created_at) SELECT ?,'invoice-import','service_document_render',?,'pending',? WHERE EXISTS(SELECT 1 FROM invoice_import_drafts WHERE id=? AND status='processing' AND json_extract(data,'$.jobId')=?)",
    ).bind(jobId, JSON.stringify(payload), now, draft.id, draft.data.jobId),
    env.DB.prepare(
      "UPDATE invoice_import_drafts SET data=?,updated_at=? WHERE id=? AND status='processing' AND json_extract(data,'$.jobId')=?",
    ).bind(JSON.stringify(next), now, draft.id, draft.data.jobId),
  ]);
  return result[2].meta?.changes ? { jobId } : null;
}

export async function routeInvoiceImports(request, env, deps) {
  const path = new URL(request.url).pathname;
  const rules =
    path === "/api/admin/invoice-reader-rules" ||
    path === "/api/server/invoice-reader-rules";
  const drafts = path === "/api/admin/invoice-imports";
  const targets = path === "/api/admin/invoice-imports/targets";
  const duplicateCheck = path === "/api/admin/service-documents/duplicates";
  if (!rules && !drafts && !duplicateCheck && !targets) return null;
  if (
    !["GET", "POST"].includes(request.method) ||
    (targets && request.method !== "GET") ||
    (duplicateCheck && request.method !== "POST")
  )
    return deps.json({ error: "Μη έγκυρη μέθοδος." }, 405);
  let actor;
  if (path.startsWith("/api/server/")) {
    if (
      request.method !== "GET" ||
      !(await deps.serverAuthorized(request, env))
    )
      return deps.json({ error: "Μη έγκυρος Server." }, 401);
    actor = { id: "android-server" };
  } else {
    try {
      actor = await deps.authenticateExternal(
        request,
        env,
        request.method === "GET" ? "fleet.view" : "fleet.manage",
      );
    } catch (e) {
      return deps.json(
        { error: e.message || "Χρειάζεται σύνδεση." },
        e.status || 401,
      );
    }
    if (!actor) return deps.json({ error: "Χρειάζεται σύνδεση." }, 401);
    actor = { ...actor, id: actor.user_id || actor.id };
    if (!actor.id)
      return deps.json({ error: "Η συνεδρία δεν περιέχει χρήστη." }, 401);
  }
  const body =
    request.method === "GET" ? {} : await request.json().catch(() => ({}));
  if (rules) {
    let list = [];
    try {
      list = JSON.parse(
        (
          await env.DB.prepare(
            "SELECT value FROM system_settings WHERE key='invoice_reader_rules'",
          ).first()
        )?.value || "[]",
      );
    } catch {}
    if (request.method === "GET") return deps.json({ rules: list });
    if (body.action === "delete") list = list.filter((r) => r.id !== body.id);
    else {
      const supplier = deps.cleanText(body.supplier, 120),
        label = deps.cleanText(body.label, 80),
        field = body.field;
      if (
        supplier.length < 3 ||
        label.length < 3 ||
        !["plate", "odometerKm", "invoiceDate", "totalAmount"].includes(field)
      )
        return deps.json(
          {
            error:
              "Διάλεξε πεδίο και γράψε προμηθευτή/επικεφαλίδα τουλάχιστον 3 χαρακτήρων.",
          },
          400,
        );
      if (list.length >= 30)
        return deps.json(
          {
            error:
              "Υπάρχουν ήδη 30 κανόνες. Αφαίρεσε έναν πριν προσθέσεις άλλον.",
          },
          409,
        );
      list.push({
        id: crypto.randomUUID(),
        supplier,
        field,
        label,
        approvedBy: actor.id,
        approvedAt: new Date().toISOString(),
      });
    }
    await env.DB.prepare(
      "INSERT INTO system_settings(key,value,updated_at,updated_by) VALUES('invoice_reader_rules',?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,updated_by=excluded.updated_by",
    )
      .bind(JSON.stringify(list), new Date().toISOString(), actor.id)
      .run();
    await deps.recordExternalAudit(
      env,
      request,
      actor,
      "invoice_reader_rule",
      "settings",
      "invoice_reader_rules",
      null,
      { action: body.action || "add" },
      "Εγκεκριμένος κανόνας επικεφαλίδας τιμολογίου",
      false,
    );
    return deps.json({ ok: true, rules: list });
  }
  if (duplicateCheck)
    return deps.json({
      matches: await invoiceDuplicates(env, {
        qrUrl: deps.qrUrlFromValue(body.qrUrl || body.value),
        supplier: deps.cleanText(body.supplier, 120),
        invoiceNumber: deps.cleanText(body.invoiceNumber, 120),
        excludeKey: deps.cleanText(body.excludeKey, 500),
      }),
    });
  if (targets) {
    const located = await deps.readSnapshotBike(
      env,
      deps.cleanText(new URL(request.url).searchParams.get("bikeId"), 80),
    );
    if (!located) return deps.json({ error: "Το μηχανάκι δεν βρέθηκε." }, 404);
    const b = located.bike;
    return deps.json({
      bike: {
        id: b.id,
        name: b.name,
        currentKm: b.currentKm,
        lastServiceKm: b.lastServiceKm,
        nextServiceKm: b.nextServiceKm,
        intervalKm: b.intervalKm,
      },
      services: (b.history || [])
        .filter((e) => e.type !== "check")
        .map((e) => ({ id: e.id, date: e.date, km: e.km, tasks: e.tasks }))
        .sort((a, b) => String(b.date).localeCompare(String(a.date))),
    });
  }
  if (request.method === "GET") {
    const records =
      (
        await env.DB.prepare(
          "SELECT d.*,o.status operationStatus,o.payload operationPayload FROM invoice_import_drafts d LEFT JOIN fleet_operations o ON o.id=json_extract(d.data,'$.jobId') WHERE d.owner_id=? AND d.status!='discarded' ORDER BY CASE WHEN d.status='committed' THEN 1 ELSE 0 END,d.created_at DESC LIMIT 200",
        )
          .bind(actor.id)
          .all()
      ).results || [];
    return deps.json({
      drafts: records.map((r) => {
        let op = {};
        try {
          op = JSON.parse(r.operationPayload || "{}");
        } catch {}
        return {
          id: r.id,
          status: r.status,
          createdAt: r.created_at,
          ...JSON.parse(r.data),
          operationStatus: r.operationStatus,
          progress: Number(op.progress || 5),
          stage: op.progressStage || "",
          operationError: op.lastError || "",
        };
      }),
      bikes: await deps.fleetNames(env),
    });
  }
  if (body.action === "scan") {
    const qrUrl = deps.qrUrlFromValue(body.value);
    if (!qrUrl || !deps.isPublicExternalQrUrl(qrUrl))
      return deps.json(
        { error: "Το QR δεν περιέχει ασφαλή δημόσιο σύνδεσμο." },
        422,
      );
    const matches = await invoiceDuplicates(env, { qrUrl });
    if (matches.length && !body.allowDuplicate)
      return deps.json({ duplicate: true, matches });
    const prior = await env.DB.prepare(
      "SELECT id FROM invoice_import_drafts WHERE owner_id=? AND status IN('processing','ready','committing') AND json_extract(data,'$.qrUrl')=? LIMIT 1",
    )
      .bind(actor.id, qrUrl)
      .first();
    if (prior)
      return deps.json({
        duplicate: true,
        draftId: prior.id,
        message: "Το QR υπάρχει ήδη στα προσχέδια.",
      });
    const count = await env.DB.prepare(
      "SELECT COUNT(*) count FROM invoice_import_drafts WHERE owner_id=? AND status IN('processing','ready','committing')",
    )
      .bind(actor.id)
      .first();
    if (Number(count.count) >= 200)
      return deps.json(
        {
          error:
            "Υπάρχουν 200 ενεργά προσχέδια. Ολοκλήρωσε μερικά πριν συνεχίσεις.",
        },
        409,
      );
    const id = crypto.randomUUID(),
      jobId = crypto.randomUUID(),
      now = new Date().toISOString();
    const data = { jobId, qrUrl, qrValue: qrUrl };
    const payload = {
      ...data,
      draftId: id,
      bikeId: "draft-" + id,
      entryId: "draft",
      requestedAt: now,
      progress: 5,
      progressStage: "Προσχέδιο QR · αναμονή Server",
      attemptCount: 0,
    };
    // Atomic insert guards prevent racing scans without a unique constraint
    // that would reject older draft rows during a merge-style backup restore.
    const inserted=await env.DB.batch([
      env.DB.prepare("INSERT INTO invoice_import_drafts(id,owner_id,data,status,created_at,updated_at) SELECT ?,?,?,'processing',?,? WHERE NOT EXISTS(SELECT 1 FROM invoice_import_drafts WHERE owner_id=? AND status IN('processing','ready','committing') AND json_extract(data,'$.qrUrl')=?) AND (SELECT COUNT(*) FROM invoice_import_drafts WHERE owner_id=? AND status IN('processing','ready','committing'))<200")
        .bind(id,actor.id,JSON.stringify(data),now,now,actor.id,qrUrl,actor.id),
      env.DB.prepare("INSERT INTO fleet_operations(id,source,type,payload,status,created_at) SELECT ?,'invoice-import','service_document_render',?,'pending',? WHERE EXISTS(SELECT 1 FROM invoice_import_drafts WHERE id=?)")
        .bind(jobId,JSON.stringify(payload),now,id)
    ]);
    if(!inserted[0].meta?.changes){
      const existing=await env.DB.prepare("SELECT id FROM invoice_import_drafts WHERE owner_id=? AND status IN('processing','ready','committing') AND json_extract(data,'$.qrUrl')=? LIMIT 1").bind(actor.id,qrUrl).first();
      return existing?deps.json({duplicate:true,draftId:existing.id}):deps.json({error:'Υπάρχουν ήδη 200 ενεργά προσχέδια.'},409);
    }
    return deps.json({ queued: true, draftId: id, jobId }, 202);
  }
  const row = await env.DB.prepare(
    "SELECT * FROM invoice_import_drafts WHERE id=? AND owner_id=?",
  )
    .bind(deps.cleanText(body.id, 120), actor.id)
    .first();
  if (!row) return deps.json({ error: "Το προσχέδιο δεν βρέθηκε." }, 404);
  const data = JSON.parse(row.data),
    now = new Date().toISOString();
  if (body.action === "discard") {
    const updates = await env.DB.batch([
      env.DB.prepare(
        "UPDATE fleet_operations SET status='cancelled' WHERE id=? AND EXISTS(SELECT 1 FROM invoice_import_drafts WHERE id=? AND status IN('processing','ready'))",
      ).bind(data.jobId, row.id),
      env.DB.prepare(
        "UPDATE invoice_import_drafts SET status='discarded',updated_at=? WHERE id=? AND status IN('processing','ready')",
      ).bind(now, row.id),
    ]);
    if (!updates[1].meta?.changes)
      return deps.json(
        { error: "Το προσχέδιο αποθηκεύεται ή έχει ήδη ολοκληρωθεί." },
        409,
      );
    if (data.attachment?.key) {
      const linked = await env.DB.prepare(
        "SELECT 1 found FROM fleet_snapshot s,json_each(s.data,'$.bikes') b,json_each(b.value,'$.history') h,json_each(h.value,'$.attachments') a WHERE s.id=1 AND json_extract(a.value,'$.key')=? LIMIT 1",
      )
        .bind(data.attachment.key)
        .first();
      if (!linked)
        await (env.SERVICE_DOCS || env.RELEASES)?.delete(data.attachment.key);
    }
    return deps.json({ ok: true });
  }
  if (body.action === "retry") {
    if (row.status !== "processing")
      return deps.json(
        { error: "Το προσχέδιο δεν χρειάζεται νέα προσπάθεια QR." },
        409,
      );
    const result = await restartImportDraft(env, { ...row, data }, now);
    if (!result)
      return deps.json(
        { error: "Έγινε ήδη άλλη προσπάθεια. Ανανέωσε τα προσχέδια." },
        409,
      );
    const jobId = result.jobId;
    return deps.json({ ok: true, jobId });
  }
  if (body.action !== "commit")
    return deps.json({ error: "Μη έγκυρη ενέργεια." }, 400);
  if (row.status === "committed")
    return deps.json({
      ok: true,
      alreadyCommitted: true,
      bikeId: data.bikeId,
      entryId: data.entryId,
    });
  if (!["ready", "committing"].includes(row.status) || !data.attachment)
    return deps.json({ error: "Περίμενε να ολοκληρωθεί η ανάλυση." }, 409);
  const matches = (await invoiceDuplicates(env, {
    qrUrl: data.qrUrl,
    supplier: data.invoiceData?.supplier || "",
    invoiceNumber: data.invoiceData?.invoiceNumber || "",
  })).filter(match=>!(row.status==='committing'&&match.key===data.attachment.key&&match.bikeId===data.commitIntent?.bikeId&&match.entryId===(data.commitIntent?.entryId||'draft-service-'+row.id)));
  if (matches.length && !body.allowDuplicate)
    return deps.json(
      {
        error: "Το τιμολόγιο υπάρχει ήδη σε άλλο service.",
        code: "duplicate_invoice",
        matches,
      },
      409,
    );
  const intent = row.status === "committing" ? data.commitIntent : body;
  if (!intent)
    return deps.json(
      {
        error:
          "Δεν βρέθηκε η επιβεβαιωμένη επιλογή. Ζήτησε έλεγχο υποστήριξης.",
      },
      409,
    );
  const bikeId = deps.cleanText(intent.bikeId, 80);
  let entryId = deps.cleanText(intent.entryId, 120),
    version = 0;
  if (!bikeId) return deps.json({ error: "Διάλεξε μηχανάκι." }, 400);
  if (row.status === "ready") {
    const claimed = await env.DB.prepare(
      "UPDATE invoice_import_drafts SET status='committing',data=?,updated_at=? WHERE id=? AND status='ready'",
    )
      .bind(JSON.stringify({ ...data, commitIntent: body }), now, row.id)
      .run();
    if (!claimed.meta?.changes)
      return deps.json(
        { error: "Το προσχέδιο αποθηκεύεται ήδη. Ανανέωσε και συνέχισε." },
        409,
      );
  }
  // The persisted intent fixes the destination across retries and blocks concurrent discard.
  const releaseClaim = async () =>
    env.DB.prepare(
      "UPDATE invoice_import_drafts SET status='ready',updated_at=? WHERE id=? AND status='committing'",
    )
      .bind(now, row.id)
      .run();
  if (!entryId) {
    const km = Number(intent.km),
      date = String(intent.date || "");
    if (
      !Number.isInteger(km) ||
      km < 0 ||
      km > 2000000000 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date
    ) {
      await releaseClaim();
      return deps.json(
        {
          error:
            "Συμπλήρωσε και επιβεβαίωσε ημερομηνία service και χιλιόμετρα.",
        },
        400,
      );
    }
    entryId = "draft-service-" + row.id;
    for (let attempt = 0; attempt < 5; attempt++) {
      const located = await deps.readSnapshotBike(env, bikeId);
      if (!located) {
        await releaseClaim();
        return deps.json({ error: "Το μηχανάκι δεν βρέθηκε." }, 404);
      }
      const bike = located.bike;
      if ((bike.history || []).some((e) => e.id === entryId)) break;
      if ((bike.history || []).length >= 500) {
        await releaseClaim();
        return deps.json({ error: "Η μηχανή έχει 500 εγγραφές." }, 409);
      }
      const changes =
        km > Number(bike.currentKm) ||
        (intent.oilChanged && km >= Number(bike.lastServiceKm));
      if (changes && !intent.confirmImpact) {
        await releaseClaim();
        return deps.json(
          {
            error:
              "Αυτή η καταχώρηση αλλάζει τα τρέχοντα χιλιόμετρα ή τον κύκλο λαδιών. Επιβεβαίωσε την επίδραση.",
            code: "service_impact",
            before: {
              currentKm: bike.currentKm,
              lastServiceKm: bike.lastServiceKm,
              nextServiceKm: bike.nextServiceKm,
            },
            after: {
              currentKm: Math.max(Number(bike.currentKm), km),
              nextServiceKm:
                intent.oilChanged && km >= Number(bike.lastServiceKm)
                  ? km + Number(bike.intervalKm)
                  : bike.nextServiceKm,
            },
          },
          409,
        );
      }
      const tasks = deps.cleanText(
        intent.tasks ||
          data.invoiceData?.workPerformed ||
          "Καταχώρηση τιμολογίου",
        2000,
      );
      bike.history = [
        ...(bike.history || []),
        {
          id: entryId,
          type: "service",
          km,
          date,
          notes: tasks,
          tasks: tasks.split("\n").filter(Boolean),
          oilChanged: intent.oilChanged === true,
          attachments: [],
          createdAt: now,
          updatedAt: now,
        },
      ];
      bike.currentKm = Math.max(Number(bike.currentKm) || 0, km);
      bike.updatedAt = now;
      const normalized = deps.normalizeBike(bike);
      version = await deps.writeSnapshotBike(
        env,
        located,
        normalized,
        "invoice-draft-service",
        now,
      );
      if (version) break;
      if (attempt === 4) {
        await releaseClaim();
        return deps.json(
          { error: "Η μηχανή ενημερώθηκε ταυτόχρονα. Δοκίμασε ξανά." },
          409,
        );
      }
    }
  }
  const attached = await deps.attachServiceDocumentMetadata(
    env,
    bikeId,
    entryId,
    data.attachment,
  );
  if (!attached.attached) {
    if (intent.entryId) await releaseClaim();
    return deps.json(
      { error: attached.error || "Δεν βρέθηκε διαθέσιμο service." },
      attached.status || 404,
    );
  }
  await env.DB.prepare(
    "UPDATE invoice_import_drafts SET status='committed',data=?,updated_at=? WHERE id=? AND status='committing'",
  )
    .bind(JSON.stringify({ ...data, bikeId, entryId }), now, row.id)
    .run();
  await deps.recordExternalAudit(
    env,
    request,
    actor,
    "invoice_import_commit",
    "service",
    entryId,
    null,
    { draftId: row.id, bikeId },
    "Επιβεβαιωμένη καταχώρηση προσχεδίου QR",
    false,
  );
  return deps.json({
    ok: true,
    bikeId,
    entryId,
    version: attached.version || version,
  });
}
