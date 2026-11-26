CREATE INDEX fleet_mutation_invoice_file ON fleet_mutations(json_extract(data,'$.sha256'))
  WHERE kind='invoice' AND deleted=0;

CREATE INDEX fleet_mutation_invoice_source ON fleet_mutations(json_extract(data,'$.sourceSha256'))
  WHERE kind='invoice' AND deleted=0;
