// A later search must not erase a verified image that is still staged on disk.
// The fetch and import steps are deliberately separate, so rerunning fetch in
// between them is normal. Only reuse the record when its pixels still exist;
// CI runners do not retain the ignored staging directory between jobs.
export function reusableStagedRecord(record, fileExists) {
  return record?.ok === true && Boolean(record.file) && fileExists === true
    ? record
    : null;
}
