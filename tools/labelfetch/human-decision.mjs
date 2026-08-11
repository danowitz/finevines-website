export function markHumanSelected(record, verifiedBy, { visualClearance = false } = {}) {
  record.verifiedBy = verifiedBy;
  record.selectionIdentityVerified = true;
  if (visualClearance) {
    record.watermarkSwept = true;
    record.watermarkSweptBy = 'human review';
    delete record.watermark;
    delete record.watermarkSweepError;
  }
  if (record.funnel) record.funnel.outcome = 'human-selected';
  delete record.failureStage;
  record.review = [];
  delete record.humanRejected;
  return record;
}

export function markHumanRejected(record) {
  record.ok = false;
  delete record.file;
  record.humanRejected = true;
  record.failureStage = 'human-rejected';
  if (record.funnel) record.funnel.outcome = 'failed';
  return record;
}
