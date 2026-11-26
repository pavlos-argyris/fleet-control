CREATE TABLE fleet_baseline_invoice_import (
  id INTEGER PRIMARY KEY CHECK(id=1),
  epoch TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('loading','ready','blocked')),
  reason TEXT NOT NULL DEFAULT '',
  next_row INTEGER NOT NULL DEFAULT 0 CHECK(next_row>=0),
  job_count INTEGER NOT NULL DEFAULT 0 CHECK(job_count>=0)
);

CREATE INDEX fleet_baseline_pending_invoices ON fleet_baseline_rows(ordinal)
  WHERE kind IN ('invoice-job','invoice-draft') OR json_extract(details,'$.pendingInvoice')=1;

CREATE INDEX fleet_baseline_history_job ON fleet_baseline_rows(json_extract(details,'$.invoiceJobId'))
  WHERE kind='history';

CREATE INDEX fleet_baseline_draft_job ON fleet_baseline_rows(json_extract(details,'$.invoiceJobId'))
  WHERE kind='invoice-draft';
