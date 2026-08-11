function funnel(record) {
  record.funnel ||= {};
  return record.funnel;
}

export function markWatermarkClean(record) {
  Object.assign(funnel(record), {
    watermarkClean: 1,
    watermarkRejected: 0,
    watermarkUnresolved: 0,
    outcome: 'watermark-clean',
  });
  delete record.failureStage;
}

export function markWatermarkRejected(record) {
  Object.assign(funnel(record), {
    watermarkClean: 0,
    watermarkRejected: 1,
    watermarkUnresolved: 0,
    outcome: 'failed',
  });
  record.failureStage = 'watermark';
}

export function markWatermarkUnresolved(record) {
  Object.assign(funnel(record), {
    watermarkClean: 0,
    watermarkRejected: 0,
    watermarkUnresolved: 1,
    outcome: 'pending',
  });
  record.failureStage = 'watermark-unresolved';
}

export function markImportOutcome(record, stage, { imported = false, unresolved = false } = {}) {
  Object.assign(funnel(record), {
    imported: imported ? 1 : 0,
    importStage: stage,
    outcome: imported ? 'imported' : unresolved ? 'pending' : 'failed',
  });
  if (imported) delete record.failureStage;
  else record.failureStage = `import-${stage}`;
}
