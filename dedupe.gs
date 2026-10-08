// Job identity across Job_Priority rows.
//
// One LinkedIn posting can carry several job ids. A row keeps the id it was first imported under in
// job_id, and every later re-post id is appended to merged_job_ids (_mergeNewJobIntoExistingRow).
// These helpers resolve any of those ids back to the single row that owns it, and repair sheets where
// the same id ended up on two rows — which split the assignee's status sync across two copies.

// Furthest-along wins when duplicate rows are folded together. Anything unlisted (Skip (auto),
// Closed) ranks 0: those are system labels, so any real workflow status on a sibling beats them.
var DEDUPE_STATUS_RANK = { Submitted: 6, Filled: 5, Flagged: 4, Networking: 3, New: 2, Skip: 1 };

// merged_job_ids cells hold either a bare number (Sheets auto-types a single id) or a comma-separated
// string. Read them with getValues(), not getDisplayValues(): a number format with thousands
// separators would display one id as "4,198,546,605" and split into garbage. Tokens that are not a
// job id (e.g. a date-corrupted value) are dropped.
function _parseMergedJobIds(value) {
  if (value === '' || value === null || value === undefined) return [];
  if (typeof value === 'number') return [String(Math.round(value))];
  return String(value).split(',')
    .map(function(part) { return _extractLinkedInJobId(part.trim()); })
    .filter(Boolean);
}

// Canonical job id from a Job_Priority row's job_id cell and job_link formula. Sheets can turn a large
// integer job_id into a date serial, so fall back to the id inside the HYPERLINK formula.
function _canonicalJobIdFromCells(jobIdValue, jobLinkFormula) {
  var rawJobId = _stringifyField(jobIdValue);
  var jobLinkUrl = _extractUrlFromHyperlinkFormula(jobLinkFormula || '') || '';
  return _extractLinkedInJobId(rawJobId) || _extractLinkedInJobId(jobLinkUrl) || rawJobId;
}

// id -> Job_Priority row number, covering primary AND merged ids. A primary id wins over a merged
// alias of the same id: while duplicate rows exist, the row holding the id as job_id is the one the
// import updates (getExistingJobIndex), so status edits must land on that same row. Three column
// reads regardless of size; build it once per batch of lookups, not once per row.
function _buildJobPriorityRowIndex() {
  var index = {};
  var sheet = _getJobPrioritySheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < JOB_PRIORITY_DATA_START_ROW) return index;
  var rowCount = lastRow - JOB_PRIORITY_DATA_START_ROW + 1;
  var IDX = JOB_PRIORITY_COLUMN_INDEX;
  var jobIds = sheet.getRange(JOB_PRIORITY_DATA_START_ROW, IDX.job_id, rowCount, 1).getValues();
  var linkFormulas = sheet.getRange(JOB_PRIORITY_DATA_START_ROW, IDX.job_link, rowCount, 1).getFormulas();
  var mergedIds = sheet.getRange(JOB_PRIORITY_DATA_START_ROW, IDX.merged_job_ids, rowCount, 1).getValues();

  for (var i = 0; i < rowCount; i++) {
    var id = _canonicalJobIdFromCells(jobIds[i][0], linkFormulas[i][0]);
    if (id && !index[id]) index[id] = JOB_PRIORITY_DATA_START_ROW + i;
  }
  for (var j = 0; j < rowCount; j++) {
    _parseMergedJobIds(mergedIds[j][0]).forEach(function(alias) {
      if (!index[alias]) index[alias] = JOB_PRIORITY_DATA_START_ROW + j;
    });
  }
  return index;
}

// Maintenance menu: fold Job_Priority rows that share any job id into one row. Shows the counts and
// asks before deleting anything. Idempotent — a second run finds nothing to fold.
function mergeDuplicateJobRowsPrompt() {
  ensureWorkbookReadyForRuntime();
  var ui = SpreadsheetApp.getUi();
  var sheet = _getJobPrioritySheet();
  var plan = _planJobPriorityDedupe(sheet);

  var reviewNote = plan.reviewIds.length
    ? '\n\n' + plan.reviewIds.length + ' group(s) mix a manual Skip with a live row and are left for you ' +
      'to resolve by hand. Their ids:\n  ' + plan.reviewIds.slice(0, 20).join('\n  ') +
      (plan.reviewIds.length > 20 ? '\n  …' : '')
    : '';

  if (!plan.merges.length) {
    ui.alert('No duplicate job rows to merge.' + reviewNote);
    return;
  }

  var resp = ui.alert(
    'Merge Duplicate Job Rows',
    'Found ' + plan.merges.length + ' job(s) split across ' + (plan.merges.length + plan.loserCount) +
    ' Job_Priority rows.\n\n' +
    'Each keeps its furthest-along row (Submitted > Filled > Flagged > Networking > New) and absorbs ' +
    'the other rows\' job ids into merged_job_ids. ' + plan.loserCount + ' row(s) will be DELETED.' +
    reviewNote + '\n\nProceed?',
    ui.ButtonSet.OK_CANCEL
  );
  if (resp !== ui.Button.OK) return;

  // An import or Sort & Rank writes rows by number. Hold the same lock they take, and re-plan under
  // it, since the sheet may have changed while the dialog was open.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    ui.alert('A pipeline run is in progress. Try again once it finishes.');
    return;
  }
  var deleted;
  try {
    deleted = _applyJobPriorityDedupe(sheet, _planJobPriorityDedupe(sheet));
    SpreadsheetApp.flush();
    // Re-rank (deletions leave gaps) and reconcile the Assigned sheet: an Assigned row keyed by a
    // deleted row's id now resolves, via merged_job_ids, to the kept row and picks up its status.
    sortAndRankJobs();
  } finally {
    lock.releaseLock();
  }
  ui.alert('Merged duplicates: deleted ' + deleted + ' row(s) and re-sorted.');
}

// Groups Job_Priority rows that share any id (primary or merged, transitively) and picks the row to
// keep per group. One block read; sized for ~10k rows. Returns:
//   merges     — [{ keep, drop[], jobId, mergedJobIds }] with 0-based offsets into the data rows
//   loserCount — total rows to delete
//   reviewIds  — one id per group left alone because it pairs a manual Skip with a live row
//   values     — the block read, reused by _applyJobPriorityDedupe for the sort keys
function _planJobPriorityDedupe(sheet) {
  var plan = { merges: [], loserCount: 0, reviewIds: [], values: [] };
  var lastRow = sheet.getLastRow();
  if (lastRow < JOB_PRIORITY_DATA_START_ROW) return plan;
  var rowCount = lastRow - JOB_PRIORITY_DATA_START_ROW + 1;
  var IDX = JOB_PRIORITY_COLUMN_INDEX;
  var values = sheet.getRange(JOB_PRIORITY_DATA_START_ROW, 1, rowCount, JOB_PRIORITY_COLUMNS.length).getValues();
  var linkFormulas = sheet.getRange(JOB_PRIORITY_DATA_START_ROW, IDX.job_link, rowCount, 1).getFormulas();
  plan.values = values;

  // Union-find over row offsets: two rows join when any id appears on both.
  var parent = [];
  var find = function(i) {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  var primaryIds = [];
  var mergedIds = [];
  var rowById = {};
  for (var i = 0; i < rowCount; i++) {
    parent.push(i);
    primaryIds.push(_canonicalJobIdFromCells(values[i][IDX.job_id - 1], linkFormulas[i][0]));
    mergedIds.push(_parseMergedJobIds(values[i][IDX.merged_job_ids - 1]));
    var ids = primaryIds[i] ? [primaryIds[i]].concat(mergedIds[i]) : mergedIds[i];
    for (var k = 0; k < ids.length; k++) {
      if (rowById.hasOwnProperty(ids[k])) parent[find(i)] = find(rowById[ids[k]]);
      else rowById[ids[k]] = i;
    }
  }

  var groups = {};
  for (var r = 0; r < rowCount; r++) {
    var root = find(r);
    (groups[root] = groups[root] || []).push(r);
  }

  Object.keys(groups).forEach(function(root) {
    var rows = groups[root];
    if (rows.length < 2) return;
    var statusOf = function(row) { return _stringifyField(values[row][IDX.status - 1]) || 'New'; };

    // A manual Skip is a deliberate rejection. Folding it into a live copy would silently undo it,
    // and folding a live copy into it would drop real work — so neither is decided automatically.
    var hasManualSkip = rows.some(function(row) { return statusOf(row) === 'Skip'; });
    var hasLive = rows.some(function(row) { return !_isDeadStatus(statusOf(row)); });
    if (hasManualSkip && hasLive) {
      plan.reviewIds.push(primaryIds[rows[0]] || mergedIds[rows[0]][0]);
      return;
    }

    // Furthest-along status, then a scored row over an unscored one, then the higher row.
    var ranked = rows.slice().sort(function(a, b) {
      var byStatus = (DEDUPE_STATUS_RANK[statusOf(b)] || 0) - (DEDUPE_STATUS_RANK[statusOf(a)] || 0);
      if (byStatus) return byStatus;
      var scoredA = _stringifyField(values[a][IDX.score - 1]) ? 1 : 0;
      var scoredB = _stringifyField(values[b][IDX.score - 1]) ? 1 : 0;
      if (scoredA !== scoredB) return scoredB - scoredA;
      return a - b;
    });
    var keep = ranked[0];
    var drop = ranked.slice(1);

    // Kept row's own merged ids first (their order drives the newest-link-first display), then every
    // id the dropped rows carried.
    var folded = [];
    var addId = function(id) {
      if (id && id !== primaryIds[keep] && folded.indexOf(id) === -1) folded.push(id);
    };
    mergedIds[keep].forEach(addId);
    drop.forEach(function(row) {
      addId(primaryIds[row]);
      mergedIds[row].forEach(addId);
    });

    plan.merges.push({ keep: keep, drop: drop, jobId: primaryIds[keep], mergedJobIds: folded.join(', ') });
    plan.loserCount += drop.length;
  });

  return plan;
}

// Writes a plan: folds ids into each kept row, then deletes the dropped rows with the same
// mark/sort/delete idiom as pruneExpiredJobRows. Per-row writes are O(duplicate groups), never
// O(sheet rows). Returns the number of rows deleted.
function _applyJobPriorityDedupe(sheet, plan) {
  if (!plan.merges.length) return 0;
  var IDX = JOB_PRIORITY_COLUMN_INDEX;
  var rowCount = plan.values.length;

  // job_link is rich text, so the kept rows' cells are rewritten one by one rather than rewriting the
  // whole column (a full-column rich-text write would replace any legacy HYPERLINK formulas).
  plan.merges.forEach(function(merge) {
    var rowNumber = JOB_PRIORITY_DATA_START_ROW + merge.keep;
    sheet.getRange(rowNumber, IDX.merged_job_ids).setValue(merge.mergedJobIds);
    sheet.getRange(rowNumber, IDX.job_link).setRichTextValue(_buildJobLinkRichText(merge.jobId, merge.mergedJobIds));
  });

  // Fresh keys for EVERY row: rows appended since the last Sort & Rank have a blank sort_key, and
  // blanks sort after the delete marker, which would put survivors inside the deleted block.
  var doomed = {};
  plan.merges.forEach(function(merge) { merge.drop.forEach(function(row) { doomed[row] = true; }); });
  var DELETE_KEY = '~~~~~~~~'; // '~' > any digit, so marked rows sort after every real key
  var sortKeys = plan.values.map(function(row, i) {
    if (doomed[i]) return [DELETE_KEY];
    return [_buildJobSortKey(row[IDX.status - 1], row[IDX.priority - 1], row[IDX.posted - 1],
      row[IDX.imported_at - 1], row[IDX.score - 1])];
  });
  var keyRange = sheet.getRange(JOB_PRIORITY_DATA_START_ROW, IDX.sort_key, rowCount, 1);
  keyRange.setNumberFormat('@');
  keyRange.setValues(sortKeys);
  sheet.getRange(JOB_PRIORITY_DATA_START_ROW, 1, rowCount, JOB_PRIORITY_COLUMNS.length)
    .sort([{ column: IDX.sort_key, ascending: true }]);
  sheet.deleteRows(JOB_PRIORITY_DATA_START_ROW + rowCount - plan.loserCount, plan.loserCount);
  return plan.loserCount;
}
