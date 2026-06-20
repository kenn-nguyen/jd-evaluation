var JOB_PRIORITY_SHEET_NAME = 'Job_Priority';
var SETTINGS_SHEET_NAME = 'Settings';
var HELP_SHEET_NAME = 'Help';
var DEDUP_ARCHIVE_SHEET_NAME = 'Dedup_Archive';
var RAW_DATA_SHEET_NAME = 'Raw_Data';
var JOB_PRIORITY_HEADER_ROW = 6;
var JOB_PRIORITY_DATA_START_ROW = 7;
var JOB_PRIORITY_STATUS_OPTIONS = ['New', 'Opened', 'Tailoring', 'Applied', 'Skip'];
var JOB_PRIORITY_STATUS_SORT_ORDER = {
  New: 0,
  Opened: 1,
  Tailoring: 2,
  Applied: 3,
  Skip: 4
};
var JOB_PRIORITY_VISIBLE_COLUMNS = [
  'rank',
  'priority',
  'score',
  'us_visa',
  'company',
  'title',
  'title_level',
  'jd_implied_level',
  'status',
  'location',
  'posted',
  'applicants',
  'job_link',
  'summary',
  'why',
  'us_visa_reason'
];
var JOB_PRIORITY_HIDDEN_COLUMNS = [
  'job_id',
  'imported_at',
  'scored_at',
  'scoring_fingerprint',
  'merged_job_ids'
];
var JOB_PRIORITY_COLUMNS = JOB_PRIORITY_VISIBLE_COLUMNS.concat(JOB_PRIORITY_HIDDEN_COLUMNS);
var RAW_DATA_COLUMNS = ['job_id', 'raw_ref'];
var JOB_PRIORITY_COLUMN_INDEX = (function() {
  var map = {};
  for (var i = 0; i < JOB_PRIORITY_COLUMNS.length; i += 1) {
    map[JOB_PRIORITY_COLUMNS[i]] = i + 1;
  }
  return map;
})();
var SETTINGS_DEFAULT_ROWS = [
  ['setting_key', 'setting_value', 'notes'],
  ['APIFY_TOKEN', '', 'Apify API token. You can paste it here directly, or still use Script Properties as a fallback.'],
  ['GEMINI_API_ROUTE', 'developer', 'developer uses Gemini Developer API. vertex uses your linked Google Cloud project and Vertex billing.'],
  ['VERTEX_PROJECT_ID', '', 'Required only when GEMINI_API_ROUTE=vertex. Use your standard Google Cloud project id.'],
  ['VERTEX_LOCATION', 'global', 'Usually keep global for Gemini models on Vertex'],
  ['SCORING_MODEL', 'gemini-2.5-flash', 'Gemini model used for scoring.'],
  ['SCORING_PARALLEL_REQUESTS', '3', 'How many AI scoring requests to send in parallel per batch'],
  ['SCORING_RPM_LIMIT', '0', 'API rate limit in requests per minute. Set to your Vertex/Gemini quota (e.g. 10 for free trial). 0 = no pacing.'],
  ['SCORING_MAX_JOBS_PER_EXECUTION', '0', 'Max jobs scored per Apps Script execution. 0 = auto-calculated from RPM and batch size to fit within 5 minutes. Override if the auto value is too conservative or too aggressive.'],
  ['TARGET_PROFILE', '', 'Leave blank to use the built-in profile defined in prompts.gs (_defaultTargetProfile). Paste your own text here to override it.'],
  ['SCORING_INSTRUCTIONS', 'default', 'Use default to keep the built-in scoring prompt, or replace with your own instruction block. The built-in prompt scores interview-conversion priority and evaluates visa separately at the end.'],
  ['NOTIFY_EMAIL', '', 'Optional. Email address for P01-priority alerts and critical failure alerts'],
  ['FORCE_RESCORE', 'FALSE', 'TRUE rescoring existing jobs in the current fetch'],
  ['APIFY_TASK_IDS', '', 'Your Apify task id, for example masterabctech~linkedin-job-scraper-task'],
  ['RUN_INTERVAL_HOURS', '4', 'How often the pipeline runs (hours). Supported values: 1, 2, 4, 6, 8, 12.'],
  ['QUIET_START_HOUR', '19', 'Hour to stop running, 0-23 Pacific Time. Default 19 = 7pm PT.'],
  ['QUIET_END_HOUR', '5', 'Hour to resume running, 0-23 Pacific Time. Default 5 = 5am PT. Set both to 0 to disable quiet hours.'],
];
var HELP_ROWS = [
  ['Job Priority Help', ''],
  ['What Run Now does', 'Starts your Apify task, waits for it to finish, fetches that batch of jobs, scores new jobs, and writes ranked results into Job_Priority.'],
  ['Step 1', 'Open the Settings sheet and paste APIFY_TOKEN there. Script Properties still work as a fallback, but the sheet is now supported directly.'],
  ['Step 2', 'If using Gemini Developer API, also add Script Property GEMINI_API_KEY and leave GEMINI_API_ROUTE as developer.'],
  ['Step 3', 'If using Vertex billing, switch this Apps Script project to a standard Google Cloud project, enable Vertex AI API there, and set GEMINI_API_ROUTE to vertex.'],
  ['Step 4', 'If GEMINI_API_ROUTE is vertex, fill in VERTEX_PROJECT_ID and usually leave VERTEX_LOCATION as global.'],
  ['Step 5', 'In the same Settings sheet, fill in APIFY_TASK_IDS with your task id.'],
  ['Step 6', 'Leave TARGET_PROFILE blank to use the built-in profile from prompts.gs. Paste your own text to override.'],
  ['Step 7', 'Optional: set NOTIFY_EMAIL if you want email alerts for new P01 jobs and critical failures.'],
  ['Step 8', 'Leave SCORING_INSTRUCTIONS as default to use the built-in prompt, or replace it with your own prompt rules.'],
  ['Step 9', 'Leave SCORING_MODEL as gemini-2.5-flash, or change it to another Gemini model name.'],
  ['Step 10', 'Use Jobs Pipeline > Validate Config, then Jobs Pipeline > Run Now.'],
  ['Import old Apify run', 'Use Jobs Pipeline > Import Apify Run ID... to score a finished Apify run again from its saved dataset without scraping a new batch.'],
  ['Retry failed Apify run', 'Use Jobs Pipeline > Retry Apify Run ID... to rerun a finished or failed Apify run in Apify, wait for completion, then import and score that rerun.'],
  ['Reevaluate active backlog', 'Use Jobs Pipeline > Reevaluate Active Backlog to rescore current New, Opened, and Tailoring rows using the latest prompt/profile. Applied and Skip rows are ignored.'],
  ['Reevaluate selected rows', 'Use Jobs Pipeline > Reevaluate Selected Rows to rescore only the currently selected job rows. Applied and Skip rows are ignored.'],
  ['Rerun Raw Data', 'Use Jobs Pipeline > Rerun Raw Data to force-rescore every record in Job_Priority using the raw JSON stored in Raw_Data. Deduplicates by job ID first, then rescores all records via batch Gemini API with caching. Use this after changing TARGET_PROFILE or SCORING_INSTRUCTIONS to reprice the entire backlog.'],
  ['Large runs', 'Large scoring runs now continue automatically in chunks. If the batch is too large for one Apps Script execution, the script writes partial results, updates Processed, and schedules the next continuation automatically.'],
  ['Resetting prompt default', 'If you want the built-in scoring prompt again, just type default into SCORING_INSTRUCTIONS. You do not need to run setupJobPriorityWorkbook() for that reset.'],
  ['When you change Apify account', 'Usually only APIFY_TOKEN and APIFY_TASK_IDS in the Settings sheet need to change.'],
  ['Task id example', 'masterabctech~linkedin-job-scraper-task'],
  ['Parallel AI requests', 'SCORING_PARALLEL_REQUESTS controls how many jobs are scored in parallel per batch. 3 is a safe default.'],
  ['Notification email', 'If NOTIFY_EMAIL is blank, no email notifications are sent.'],
  ['P01 job alert email', 'Sent when the run finds at least one new P01-priority job. The email includes summary, visa signal, why, and job link.'],
  ['Critical failure email', 'Sent when the whole run fails or when a large share of jobs in the run fail to import or score.'],
  ['If AI output is invalid', 'The script retries that job one time. If it still fails, the job is marked failed for that run and the rest continue.'],
  ['Vertex route', 'Vertex route uses the Vertex AI REST endpoint and Apps Script OAuth against your linked standard Google Cloud project, so usage is billed to that project.']
];

function setupJobPriorityWorkbook() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var jobSheet = _getOrCreateSheet(spreadsheet, JOB_PRIORITY_SHEET_NAME);
  var settingsSheet = _getOrCreateSheet(spreadsheet, SETTINGS_SHEET_NAME);
  var helpSheet = _getOrCreateSheet(spreadsheet, HELP_SHEET_NAME);
  var rawDataSheet = _getOrCreateSheet(spreadsheet, RAW_DATA_SHEET_NAME);

  _setupJobPrioritySheet(jobSheet);
  _setupSettingsSheet(settingsSheet);
  _setupHelpSheet(helpSheet);
  _setupRawDataSheet(rawDataSheet);
}

function ensureWorkbookReadyForRuntime() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var jobSheet = spreadsheet.getSheetByName(JOB_PRIORITY_SHEET_NAME);
  var settingsSheet = spreadsheet.getSheetByName(SETTINGS_SHEET_NAME);
  var helpSheet = spreadsheet.getSheetByName(HELP_SHEET_NAME);
  var rawDataSheet = spreadsheet.getSheetByName(RAW_DATA_SHEET_NAME);
  var existingHeaders = [];

  if (!jobSheet || !settingsSheet || !helpSheet || !rawDataSheet) {
    setupJobPriorityWorkbook();
    return;
  }

  if (jobSheet.getMaxRows() < JOB_PRIORITY_DATA_START_ROW) {
    setupJobPriorityWorkbook();
    return;
  }

  if (jobSheet.getLastRow() < JOB_PRIORITY_HEADER_ROW) {
    _setupJobPrioritySheet(jobSheet);
    return;
  }

  existingHeaders = jobSheet.getRange(JOB_PRIORITY_HEADER_ROW, 1, 1, JOB_PRIORITY_COLUMNS.length).getValues()[0] || [];
  // Use !== so surplus columns (old schema remnants) also trigger a sync, not just missing columns
  if (jobSheet.getMaxColumns() !== JOB_PRIORITY_COLUMNS.length || !_headerMatches(existingHeaders, JOB_PRIORITY_COLUMNS)) {
    _syncJobPrioritySchemaForRuntime(jobSheet);
  }

  if (rawDataSheet.getMaxColumns() < RAW_DATA_COLUMNS.length ||
      rawDataSheet.getLastRow() < 1 ||
      !_headerMatches(rawDataSheet.getRange(1, 1, 1, RAW_DATA_COLUMNS.length).getValues()[0], RAW_DATA_COLUMNS)) {
    _setupRawDataSheet(rawDataSheet);
  }
}

function getSettingsMap() {
  var sheet = _getSettingsSheet();
  var lastRow = sheet.getLastRow();
  var settings = {};

  if (lastRow < 2) {
    return settings;
  }

  var values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  values.forEach(function(row) {
    if (row[0]) {
      settings[String(row[0]).trim()] = row[1];
    }
  });

  return settings;
}

function getExistingJobIndex() {
  var records = getExistingJobRecords();
  var byJobId = {};
  var groupedByJobId = {};

  records.forEach(function(record) {
    if (record.jobId) {
      if (!groupedByJobId[record.jobId]) {
        groupedByJobId[record.jobId] = [];
      }
      groupedByJobId[record.jobId].push(record);
    }
  });

  Object.keys(groupedByJobId).forEach(function(jobId) {
    byJobId[jobId] = _mergeDuplicateJobRecordsByJobId(groupedByJobId[jobId]);
  });

  return {
    records: records,
    byJobId: byJobId
  };
}

function getExistingJobRecords() {
  var sheet = _getJobPrioritySheet();
  var lastRow = sheet.getLastRow();
  var rawDataIndex = getRawDataIndex();

  if (lastRow < JOB_PRIORITY_DATA_START_ROW) {
    return [];
  }

  var rowCount = lastRow - JOB_PRIORITY_DATA_START_ROW + 1;
  var values = sheet.getRange(
    JOB_PRIORITY_DATA_START_ROW,
    1,
    rowCount,
    JOB_PRIORITY_COLUMNS.length
  ).getValues();
  var formulas = sheet.getRange(
    JOB_PRIORITY_DATA_START_ROW,
    1,
    rowCount,
    JOB_PRIORITY_COLUMNS.length
  ).getFormulas();

  return values.reduce(function(records, row, rowOffset) {
    var record = _sheetRowToJobRecord(row, formulas[rowOffset], JOB_PRIORITY_DATA_START_ROW + rowOffset, rawDataIndex.byJobId);

    if (record) {
      records.push(record);
    }

    return records;
  }, []);
}

function writeJobs(rows) {
  if (!rows || !rows.length) {
    return;
  }

  var sheet = _getJobPrioritySheet();
  _upsertRawDataRows(rows);
  var updates = [];
  var appends = [];
  var appendedJobs = [];

  rows.forEach(function(job) {
    var rowValues = _toSheetRow(job);
    if (job.existingRowNumber) {
      updates.push({
        rowNumber: job.existingRowNumber,
        values: rowValues
      });
    } else {
      appends.push(rowValues);
      appendedJobs.push(job);
    }
  });

  updates.forEach(function(update) {
    sheet.getRange(update.rowNumber, 1, 1, JOB_PRIORITY_COLUMNS.length).setValues([update.values]);
    _applyJobIdColumnFormat(sheet, update.rowNumber, 1);
    _applyDataRowFormat(sheet, update.rowNumber, 1);
  });

  if (appends.length) {
    var startRow = Math.max(sheet.getLastRow() + 1, JOB_PRIORITY_DATA_START_ROW);
    sheet.getRange(startRow, 1, appends.length, JOB_PRIORITY_COLUMNS.length).setValues(appends);
    _applyJobIdColumnFormat(sheet, startRow, appends.length);
    _applyDataRowFormat(sheet, startRow, appends.length);
    appendedJobs.forEach(function(job, i) {
      job.existingRowNumber = startRow + i;
    });
  }

  _applyStatusValidation(sheet);
}

function getRawDataIndex() {
  var sheet = _getRawDataSheet();
  var lastRow = sheet ? sheet.getLastRow() : 0;
  var byJobId = {};

  if (!sheet || lastRow < 2) {
    return {
      byJobId: byJobId
    };
  }

  var maxCols = sheet.getMaxColumns();
  var headers = sheet.getRange(1, 1, 1, maxCols).getValues()[0];
  var rawRefColIndex = headers.indexOf('raw_ref');
  if (rawRefColIndex === -1) rawRefColIndex = 1; // fallback: col 2 (0-based index 1)

  var values = sheet.getRange(2, 1, lastRow - 1, maxCols).getValues();

  values.forEach(function(row, offset) {
    var jobId = _extractLinkedInJobId(row[0]) || _stringifyField(row[0]);
    if (!jobId) {
      return;
    }

    byJobId[jobId] = {
      rowNumber: offset + 2,
      jobId: jobId,
      rawRef: row[rawRefColIndex] || ''
    };
  });

  return {
    byJobId: byJobId
  };
}

function repairJobLinksFromRawRefRows() {
  var sheet = _getJobPrioritySheet();
  var records = getExistingJobRecords();
  var updates = [];
  var checkedCount = 0;
  var updatedCount = 0;
  var recoveredJobIdCount = 0;
  var missingRawRefCount = 0;
  var missingJobIdCount = 0;
  var sampleErrors = [];

  records.forEach(function(record) {
    var extractedJobId = '';
    var canonicalLink = '';
    var currentLink = _extractUrlFromHyperlinkFormula(record.jobLinkFormula) || _stringifyField(record.jobLinkCellValue);

    checkedCount += 1;

    extractedJobId = _extractLinkedInJobId(record.jobId) || _extractLinkedInJobIdFromRawRef(record.rawRef);
    canonicalLink = _buildLinkedInJobUrlFromJobId(extractedJobId);

    if (!canonicalLink) {
      if (!_stringifyField(record.rawRef)) {
        missingRawRefCount += 1;
      }
      missingJobIdCount += 1;
      if (sampleErrors.length < 5) {
        sampleErrors.push((record.company || '(unknown company)') + ' — ' + (record.title || '(unknown title)'));
      }
      return;
    }

    if (_stringifyField(record.jobId) === extractedJobId && currentLink === canonicalLink) {
      return;
    }

    updates.push({
      rowNumber: record.rowNumber,
      jobId: extractedJobId || '',
      jobLink: canonicalLink
    });
  });

  updates.forEach(function(update) {
    sheet.getRange(update.rowNumber, JOB_PRIORITY_COLUMN_INDEX.job_id).setValue(update.jobId);
    sheet.getRange(update.rowNumber, JOB_PRIORITY_COLUMN_INDEX.job_link).setFormula(_buildJobLinkFormula(update.jobLink));
    recoveredJobIdCount += 1;
    updatedCount += 1;
  });

  return {
    checkedCount: checkedCount,
    updatedCount: updatedCount,
    recoveredJobIdCount: recoveredJobIdCount,
    missingRawRefCount: missingRawRefCount,
    missingJobIdCount: missingJobIdCount,
    sampleErrors: sampleErrors
  };
}

function migrateRawDataToDedicatedSheet() {
  var sheet = _getJobPrioritySheet();
  var records = getExistingJobRecords();
  var migratedCount = 0;
  var skippedCount = 0;
  var missingJobIdCount = 0;
  var lastRow = sheet.getLastRow();

  if (!records.length) {
    return {
      checkedCount: 0,
      migratedCount: 0,
      skippedCount: 0,
      missingJobIdCount: 0
    };
  }

  migratedCount = _upsertRawDataRows(records);

  records.forEach(function(record) {
    if (!record.jobId) {
      missingJobIdCount += 1;
      return;
    }

    if (_hasAnyRawPayload(record)) {
      return;
    }

    skippedCount += 1;
  });

  if (lastRow >= JOB_PRIORITY_DATA_START_ROW) {
    _clearMainSheetRawPayloadColumns(sheet, lastRow - JOB_PRIORITY_DATA_START_ROW + 1);
  }

  return {
    checkedCount: records.length,
    migratedCount: migratedCount,
    skippedCount: skippedCount,
    missingJobIdCount: missingJobIdCount
  };
}

function replaceAllJobs(rows, opts) {
  var skipRawDataSync = opts && opts.skipRawDataSync;

  var sheet = _getJobPrioritySheet();
  var existingLastRow = sheet.getLastRow();
  var clearRowCount = Math.max(existingLastRow - JOB_PRIORITY_DATA_START_ROW + 1, 0);

  if (!skipRawDataSync && rows && rows.length) {
    _upsertRawDataRows(rows);
  }

  if (clearRowCount > 0) {
    sheet.getRange(
      JOB_PRIORITY_DATA_START_ROW,
      1,
      clearRowCount,
      JOB_PRIORITY_COLUMNS.length
    ).clearContent();
    sheet.getRange(
      JOB_PRIORITY_DATA_START_ROW,
      1,
      clearRowCount,
      JOB_PRIORITY_VISIBLE_COLUMNS.length
    ).clearFormat();
  }

  if (rows && rows.length) {
    var outputRows = rows.map(_toSheetRow);
    sheet.getRange(
      JOB_PRIORITY_DATA_START_ROW,
      1,
      outputRows.length,
      JOB_PRIORITY_COLUMNS.length
    ).setValues(outputRows);

    _applyJobIdColumnFormat(sheet, JOB_PRIORITY_DATA_START_ROW, outputRows.length);
    _applyDataRowFormat(sheet, JOB_PRIORITY_DATA_START_ROW, outputRows.length);
  }

  _applyStatusValidation(sheet);
}

function _applyDataRowFormat(sheet, startRow, numRows) {
  var range = sheet.getRange(startRow, 1, numRows, JOB_PRIORITY_VISIBLE_COLUMNS.length);
  range
    .setHorizontalAlignment('left')
    .setVerticalAlignment('middle')
    .setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP);
}

function deduplicateExistingJobRows() {
  var records = getExistingJobRecords();
  var groupedByJobId = _groupJobRecordsByJobId(records);
  var groupedEntries = Object.keys(groupedByJobId).map(function(jobId) {
    var groupRecords = groupedByJobId[jobId];
    return {
      jobId: jobId,
      records: groupRecords,
      firstRowNumber: groupRecords.reduce(function(minRowNumber, record) {
        return Math.min(minRowNumber, Number(record.rowNumber || 0) || JOB_PRIORITY_DATA_START_ROW);
      }, Number.MAX_SAFE_INTEGER)
    };
  }).sort(function(left, right) {
    return left.firstRowNumber - right.firstRowNumber;
  });

  var mergedRecords = [];
  var duplicateGroupCount = 0;
  var removedRowCount = 0;

  groupedEntries.forEach(function(entry) {
    if (entry.records.length === 1) {
      mergedRecords.push(entry.records[0]);
      return;
    }

    duplicateGroupCount += 1;
    removedRowCount += entry.records.length - 1;

    var mergedRecord = _mergeDuplicateJobRecordsByJobId(entry.records);
    mergedRecords.push(mergedRecord);
  });

  if (removedRowCount > 0) {
    replaceAllJobs(mergedRecords);
    sortAndRankJobs();
  }

  return {
    duplicateGroupCount: duplicateGroupCount,
    removedRowCount: removedRowCount,
    archivedRowCount: 0,
    finalRowCount: mergedRecords.length || records.length
  };
}

function pruneExpiredJobRows() {
  var EXPIRY_DAYS = 45;
  var now = new Date();
  var expiryMs = EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  var records = getExistingJobRecords();
  var keepRecords = [];
  var prunedCount = 0;

  records.forEach(function(record) {
    if (record.status === 'Applied') {
      keepRecords.push(record);
      return;
    }

    var importedTime = _toComparableTime(record.importedAt);
    if (importedTime && (now.getTime() - importedTime) <= expiryMs) {
      keepRecords.push(record);
      return;
    }
    // No importedAt OR older than EXPIRY_DAYS → prune
    prunedCount++;
  });

  if (prunedCount > 0) {
    replaceAllJobs(keepRecords);
    sortAndRankJobs();
  }

  return {
    checkedCount: records.length,
    prunedCount: prunedCount,
    remainingCount: keepRecords.length
  };
}

function deduplicateSimilarJdRows() {
  var JD_SIMILARITY_THRESHOLD = 0.80;
  var records = getExistingJobRecords();

  if (!records.length) {
    return { duplicateGroupCount: 0, removedRowCount: 0, archivedRowCount: 0, finalRowCount: 0 };
  }

  _precomputeJdFingerprints(records);

  var byCompany = {};
  var noJdRecords = [];

  records.forEach(function(record) {
    var companyKey = _normalizeJdText(record.company || '');
    if (!record._bigramCount || !companyKey) {
      noJdRecords.push(record);
      return;
    }
    if (!byCompany[companyKey]) {
      byCompany[companyKey] = [];
    }
    byCompany[companyKey].push(record);
  });

  // Records with no JD content cannot be reliably compared — pass them through unchanged.
  // JD-based similarity already handles multi-location posts when JD text is available.
  var mergedRecords = noJdRecords.slice();
  var duplicateGroupCount = 0;
  var removedRowCount = 0;

  Object.keys(byCompany).forEach(function(companyKey) {
    var groups = _clusterSimilarJdRecords(byCompany[companyKey], JD_SIMILARITY_THRESHOLD);

    groups.forEach(function(group) {
      if (group.length === 1) {
        mergedRecords.push(group[0]);
        return;
      }

      duplicateGroupCount += 1;
      removedRowCount += group.length - 1;

      var merged = _mergeSimilarJdGroup(group);
      mergedRecords.push(merged);
    });
  });

  if (removedRowCount > 0) {
    replaceAllJobs(mergedRecords);
    sortAndRankJobs();
  }

  return {
    duplicateGroupCount: duplicateGroupCount,
    removedRowCount: removedRowCount,
    archivedRowCount: 0,
    finalRowCount: mergedRecords.length
  };
}

function _clusterSimilarJdRecords(records, threshold) {
  var groups = [];
  var assigned = {};

  records.forEach(function(record, i) {
    if (assigned[i]) return;

    var group = [record];
    assigned[i] = true;

    for (var j = i + 1; j < records.length; j += 1) {
      if (assigned[j]) continue;
      if (!_titlesSanityCheck(record.title, records[j].title)) continue;
      if (_areLikelySameJd(record, records[j], threshold)) {
        group.push(records[j]);
        assigned[j] = true;
      }
    }

    groups.push(group);
  });

  return groups;
}

function _mergeSimilarJdGroup(records) {
  // Newest posting wins for job ID / link / metadata (live posting)
  var newestRecord = records.slice().sort(_compareJobRecencyDesc)[0];
  // Richest manual state wins for status / notes
  var manualWinner = _pickRichestManualJobRecord(records);
  // Most recently scored record wins for AI fields
  var scoredRecords = records.filter(function(r) {
    return r.score !== '' && r.score !== undefined && r.score !== null;
  });
  var scoringWinner = scoredRecords.length
    ? scoredRecords.slice().sort(function(a, b) {
        return _toComparableTime(b.scoredAt) - _toComparableTime(a.scoredAt);
      })[0]
    : null;

  var merged = _cloneJobRecord(newestRecord);

  if (scoringWinner) {
    merged.score = scoringWinner.score;
    merged.priority = scoringWinner.priority;
    merged.usVisaSponsorshipPotential = scoringWinner.usVisaSponsorshipPotential;
    merged.usVisaReason = scoringWinner.usVisaReason;
    merged.summary = scoringWinner.summary;
    merged.why = scoringWinner.why;
    merged.scoringFingerprint = scoringWinner.scoringFingerprint;
    merged.scoredAt = scoringWinner.scoredAt;
  }

  merged.status = manualWinner.status || merged.status || 'New';

  // Concatenate all unique locations across the group
  var seenLocations = {};
  var locations = [];
  records.forEach(function(record) {
    var loc = _stringifyField(record.location).trim();
    if (loc && !seenLocations[loc.toLowerCase()]) {
      seenLocations[loc.toLowerCase()] = true;
      locations.push(loc);
    }
  });
  if (locations.length > 1) {
    merged.location = locations.join(' | ');
  }

  // Earliest importedAt across the group
  var earliestImport = records.reduce(function(earliest, record) {
    var t = _toComparableTime(record.importedAt);
    return t && (!earliest || t < _toComparableTime(earliest)) ? record.importedAt : earliest;
  }, null);
  if (earliestImport) {
    merged.importedAt = earliestImport;
  }

  // Ensure posted: newestRecord may have empty human-readable posted
  if (!_stringifyField(merged.posted)) {
    var withPosted = records.filter(function(r) { return _stringifyField(r.posted); });
    withPosted.sort(_compareJobRecencyDesc);
    if (withPosted.length) {
      merged.posted = withPosted[0].posted;
    }
  }

  // Ensure jobId: take first non-empty jobId from the group (sorted newest first)
  if (!_stringifyField(merged.jobId)) {
    var withJobId = records.slice().sort(_compareJobRecencyDesc).filter(function(r) {
      return _stringifyField(r.jobId);
    });
    if (withJobId.length) {
      merged.jobId = _stringifyField(withJobId[0].jobId);
    }
  }

  // Rebuild jobLink from the canonical jobId if missing
  if (!_stringifyField(merged.jobLink) && _stringifyField(merged.jobId)) {
    merged.jobLink = _buildLinkedInJobUrlFromJobId(_stringifyField(merged.jobId)) || '';
  }

  // Record all jobIds that were merged into this canonical record
  var mergedIntoThis = records
    .filter(function(r) { return _stringifyField(r.jobId) && _stringifyField(r.jobId) !== _stringifyField(merged.jobId); })
    .map(function(r) { return _stringifyField(r.jobId); });
  if (mergedIntoThis.length) {
    var existingMerged = _stringifyField(merged.mergedJobIds) ? merged.mergedJobIds.split(/,\s*/) : [];
    merged.mergedJobIds = existingMerged.concat(mergedIntoThis).filter(function(id, i, arr) {
      return id && arr.indexOf(id) === i;
    }).join(', ');
  }

  return merged;
}

function sortAndRankJobs() {
  var sheet = _getJobPrioritySheet();
  var lastRow = sheet.getLastRow();

  if (lastRow < JOB_PRIORITY_DATA_START_ROW) {
    return;
  }

  var sortedRecords = getExistingJobRecords().sort(_compareJobsForDisplay);
  replaceAllJobs(sortedRecords);

  lastRow = sheet.getLastRow();

  var rankValues = [];
  for (var row = JOB_PRIORITY_DATA_START_ROW; row <= lastRow; row += 1) {
    rankValues.push([row - JOB_PRIORITY_DATA_START_ROW + 1]);
  }

  sheet.getRange(
    JOB_PRIORITY_DATA_START_ROW,
    JOB_PRIORITY_COLUMN_INDEX.rank,
    rankValues.length,
    1
  ).setValues(rankValues);
}

function updateRunSummary(summary) {
  var sheet = _getJobPrioritySheet();

  sheet.getRange('F1').setValue(summary.lastRun || '');
  sheet.getRange('I1').setValue(summary.status || '');
  sheet.getRange('L1').setValue(summary.processed || '');
  sheet.getRange('F2').setValue(summary.scrapedCount || '');
  sheet.getRange('I2').setValue(summary.uniqueRolesCount || '');
  sheet.getRange('L2').setValue(summary.toScoreCount || '');
  sheet.getRange('F3').setValue(summary.newJobsCount || '');
  sheet.getRange('H3').setValue(summary.aJobsCount || '');
  sheet.getRange('J3').setValue(summary.failedJobsCount || '');
  sheet.getRange('F4').setValue(summary.errorMessage || '');
}

function _getOrCreateSheet(spreadsheet, sheetName) {
  var sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
  }
  return sheet;
}

function _getJobPrioritySheet() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(JOB_PRIORITY_SHEET_NAME);
}

function _getSettingsSheet() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SETTINGS_SHEET_NAME);
}

function _getHelpSheet() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HELP_SHEET_NAME);
}

function _getRawDataSheet() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(RAW_DATA_SHEET_NAME);
}

function _setupJobPrioritySheet(sheet) {

  _ensureSheetDimensions(sheet, JOB_PRIORITY_COLUMNS.length, JOB_PRIORITY_DATA_START_ROW);
  _remapJobPriorityDataIfNeeded(sheet);

  sheet.getRange(1, 1, 4, 12).breakApart().clearContent();
  sheet.getRange('E1').setValue('Last run');
  sheet.getRange('F1:G1').merge().setValue('');
  sheet.getRange('H1').setValue('Status');
  sheet.getRange('I1:J1').merge().setValue('');
  sheet.getRange('K1').setValue('Processed');
  sheet.getRange('L1').setValue('');
  sheet.getRange('E2').setValue('Scraped');
  sheet.getRange('F2:G2').merge().setValue('');
  sheet.getRange('H2').setValue('Unique jobs');
  sheet.getRange('I2:J2').merge().setValue('');
  sheet.getRange('K2').setValue('To score');
  sheet.getRange('L2').setValue('');
  sheet.getRange('E3').setValue('New jobs');
  sheet.getRange('G3').setValue('P01 jobs');
  sheet.getRange('I3').setValue('Failed');
  sheet.getRange('K3:L3').clearContent();
  sheet.getRange('E4').setValue('Errors');
  sheet.getRange('F4:L4').merge().setValue('');

  sheet.getRange(JOB_PRIORITY_HEADER_ROW, 1, 1, JOB_PRIORITY_COLUMNS.length).setValues([JOB_PRIORITY_COLUMNS]);
  sheet.getRange('E1:L4').setFontWeight('normal');
  sheet.getRangeList(['E1', 'H1', 'K1', 'E2', 'H2', 'K2', 'E3', 'G3', 'I3', 'E4']).setFontWeight('bold');
  sheet.getRangeList(['F1:L1', 'F4:L4']).setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP);
  sheet.getRange(JOB_PRIORITY_HEADER_ROW, 1, 1, JOB_PRIORITY_COLUMNS.length)
    .setFontWeight('bold')
    .setBackground('#d9ead3');

  sheet.setFrozenRows(JOB_PRIORITY_HEADER_ROW);
  sheet.setFrozenColumns(4);
  sheet.hideColumns(JOB_PRIORITY_VISIBLE_COLUMNS.length + 1, JOB_PRIORITY_HIDDEN_COLUMNS.length);

  sheet.getRange(
    JOB_PRIORITY_DATA_START_ROW,
    JOB_PRIORITY_COLUMN_INDEX.rank,
    Math.max(sheet.getMaxRows() - JOB_PRIORITY_DATA_START_ROW + 1, 1),
    1
  ).setNumberFormat('0');

  sheet.getRange(
    JOB_PRIORITY_DATA_START_ROW,
    JOB_PRIORITY_COLUMN_INDEX.score,
    Math.max(sheet.getMaxRows() - JOB_PRIORITY_DATA_START_ROW + 1, 1),
    1
  ).setNumberFormat('0');

  _applyStatusValidation(sheet);
  _applyStatusFormattingRules(sheet);
}
function _setupRawDataSheet(sheet) {
  _ensureSheetDimensions(sheet, RAW_DATA_COLUMNS.length, 2);
  sheet.getRange(1, 1, 1, RAW_DATA_COLUMNS.length).setValues([RAW_DATA_COLUMNS]);
  sheet.getRange(1, 1, 1, RAW_DATA_COLUMNS.length)
    .setFontWeight('bold')
    .setBackground('#d0e0e3');
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 120);
  sheet.setColumnWidth(2, 180);
  sheet.hideColumns(2, RAW_DATA_COLUMNS.length - 1);
}

function _syncJobPrioritySchemaForRuntime(sheet) {
  // Delete surplus columns FIRST (before remap reads them as valid data)
  var maxCols = sheet.getMaxColumns();
  if (maxCols > JOB_PRIORITY_COLUMNS.length) {
    sheet.deleteColumns(JOB_PRIORITY_COLUMNS.length + 1, maxCols - JOB_PRIORITY_COLUMNS.length);
  }

  _ensureSheetDimensions(sheet, JOB_PRIORITY_COLUMNS.length, JOB_PRIORITY_DATA_START_ROW);
  _remapJobPriorityDataIfNeeded(sheet);
  sheet.getRange(JOB_PRIORITY_HEADER_ROW, 1, 1, JOB_PRIORITY_COLUMNS.length).setValues([JOB_PRIORITY_COLUMNS]);
  sheet.hideColumns(JOB_PRIORITY_VISIBLE_COLUMNS.length + 1, JOB_PRIORITY_HIDDEN_COLUMNS.length);
  _applyStatusValidation(sheet);

  // Repair job_id column: existing cells may hold corrupted date serials or misaligned data.
  // Read each job_link HYPERLINK formula and write the extracted ID back as a plain string.
  var lastRow = sheet.getLastRow();
  if (lastRow >= JOB_PRIORITY_DATA_START_ROW) {
    var rowCount = lastRow - JOB_PRIORITY_DATA_START_ROW + 1;
    var jobIdCol    = JOB_PRIORITY_COLUMN_INDEX.job_id;
    var jobLinkCol  = JOB_PRIORITY_COLUMN_INDEX.job_link;

    var jobIdValues   = sheet.getRange(JOB_PRIORITY_DATA_START_ROW, jobIdCol,   rowCount, 1).getValues();
    var jobLinkFormulas = sheet.getRange(JOB_PRIORITY_DATA_START_ROW, jobLinkCol, rowCount, 1).getFormulas();

    var repairedIds = jobIdValues.map(function(row, i) {
      var rawId  = _stringifyField(row[0]);
      var goodId = _extractLinkedInJobId(rawId);
      if (goodId) return [goodId]; // already valid

      // Fall back to the HYPERLINK formula in job_link
      var url = _extractUrlFromHyperlinkFormula(_stringifyField(jobLinkFormulas[i][0]));
      var fromLink = _extractLinkedInJobId(url);
      return [fromLink || rawId]; // keep original if nothing works
    });

    var jobIdRange = sheet.getRange(JOB_PRIORITY_DATA_START_ROW, jobIdCol, rowCount, 1);
    jobIdRange.setNumberFormat('@').setValues(repairedIds);
  }
}

function _remapJobPriorityDataIfNeeded(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < JOB_PRIORITY_HEADER_ROW) {
    return;
  }

  var existingHeaders = sheet.getRange(JOB_PRIORITY_HEADER_ROW, 1, 1, JOB_PRIORITY_COLUMNS.length).getValues()[0];
  if (_headerMatches(existingHeaders, JOB_PRIORITY_COLUMNS)) {
    return;
  }

  if (lastRow < JOB_PRIORITY_DATA_START_ROW) {
    return;
  }

  var rowCount = lastRow - JOB_PRIORITY_DATA_START_ROW + 1;
  var values = sheet.getRange(JOB_PRIORITY_DATA_START_ROW, 1, rowCount, JOB_PRIORITY_COLUMNS.length).getValues();
  var formulas = sheet.getRange(JOB_PRIORITY_DATA_START_ROW, 1, rowCount, JOB_PRIORITY_COLUMNS.length).getFormulas();
  var oldIndexMap = {};

  existingHeaders.forEach(function(header, index) {
    if (header) {
      oldIndexMap[String(header)] = index;
    }
  });

  var remappedRows = values.map(function(row, rowIndex) {
    return JOB_PRIORITY_COLUMNS.map(function(columnName) {
      if (!oldIndexMap.hasOwnProperty(columnName)) {
        return '';
      }

      var oldColumnIndex = oldIndexMap[columnName];
      return formulas[rowIndex][oldColumnIndex] || row[oldColumnIndex];
    });
  });

  sheet.getRange(JOB_PRIORITY_DATA_START_ROW, 1, rowCount, JOB_PRIORITY_COLUMNS.length).setValues(remappedRows);
}

function _headerMatches(actualHeaders, expectedHeaders) {
  if (!actualHeaders || actualHeaders.length < expectedHeaders.length) {
    return false;
  }

  for (var i = 0; i < expectedHeaders.length; i += 1) {
    if (String(actualHeaders[i] || '') !== String(expectedHeaders[i])) {
      return false;
    }
  }

  return true;
}

function _setupSettingsSheet(sheet) {
  _ensureSheetDimensions(sheet, 3, SETTINGS_DEFAULT_ROWS.length + 2);

  var existingValues = {};
  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    var rows = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
    rows.forEach(function(row) {
      if (row[0]) {
        existingValues[String(row[0]).trim()] = row[1];
      }
    });
  }

  sheet.clearContents();

  var outputRows = [SETTINGS_DEFAULT_ROWS[0]];
  for (var i = 1; i < SETTINGS_DEFAULT_ROWS.length; i += 1) {
    var defaultRow = SETTINGS_DEFAULT_ROWS[i];
    outputRows.push([
      defaultRow[0],
      existingValues.hasOwnProperty(defaultRow[0]) ? existingValues[defaultRow[0]] : defaultRow[1],
      defaultRow[2]
    ]);
  }

  sheet.getRange(1, 1, outputRows.length, 3).setValues(outputRows);
  sheet.getRange(1, 1, 1, 3).setFontWeight('bold').setBackground('#cfe2f3');
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 200);
  sheet.setColumnWidth(2, 300);
  sheet.setColumnWidth(3, 420);
}

function _setupHelpSheet(sheet) {
  _ensureSheetDimensions(sheet, 2, HELP_ROWS.length + 2);
  sheet.clearContents();
  sheet.getRange(1, 1, HELP_ROWS.length, 2).setValues(HELP_ROWS);
  sheet.getRange(1, 1, 1, 2).setFontWeight('bold').setBackground('#fce5cd');
  sheet.getRange(2, 1, HELP_ROWS.length - 1, 1).setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 210);
  sheet.setColumnWidth(2, 760);
  sheet.getRange(1, 1, HELP_ROWS.length, 2).setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP);
}

function _ensureSheetDimensions(sheet, minColumns, minRows) {
  var currentColumns = sheet.getMaxColumns();
  var currentRows = sheet.getMaxRows();

  if (currentColumns < minColumns) {
    sheet.insertColumnsAfter(currentColumns, minColumns - currentColumns);
  }

  if (currentRows < minRows) {
    sheet.insertRowsAfter(currentRows, minRows - currentRows);
  }
}

function _applyJobIdColumnFormat(sheet, startRow, numRows) {
  // LinkedIn job IDs are large integers (e.g. 4416623195). Without explicit text formatting,
  // Google Sheets auto-converts them to date serials and displays "invalid date".
  sheet.getRange(startRow, JOB_PRIORITY_COLUMN_INDEX.job_id, numRows, 1)
    .setNumberFormat('@');
}

function _applyStatusValidation(sheet) {
  var statusRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(JOB_PRIORITY_STATUS_OPTIONS, true)
    .setAllowInvalid(false)
    .build();

  sheet.getRange(
    JOB_PRIORITY_DATA_START_ROW,
    JOB_PRIORITY_COLUMN_INDEX.status,
    Math.max(sheet.getMaxRows() - JOB_PRIORITY_DATA_START_ROW + 1, 1),
    1
  ).setDataValidation(statusRule);
}

function _applyStatusFormattingRules(sheet) {
  var existingRules = sheet.getConditionalFormatRules() || [];
  var statusCol = '$' + _columnToLetter(JOB_PRIORITY_COLUMN_INDEX.status);
  var statusRow = JOB_PRIORITY_DATA_START_ROW;
  // Only Applied and Skip rows are greyed — Opened/Tailoring/New stay white.
  var formula = '=OR(' + statusCol + statusRow + '="Applied",' + statusCol + statusRow + '="Skip")';
  // Old formula used in prior versions — filter it out alongside the new one.
  var oldFormula = '=AND(' + statusCol + statusRow + '<>"",' + statusCol + statusRow + '<>"New")';
  var targetRange = sheet.getRange(
    JOB_PRIORITY_DATA_START_ROW,
    1,
    Math.max(sheet.getMaxRows() - JOB_PRIORITY_DATA_START_ROW + 1, 1),
    JOB_PRIORITY_VISIBLE_COLUMNS.length
  );
  var filteredRules = existingRules.filter(function(rule) {
    try {
      var booleanCondition = rule.getBooleanCondition();
      if (!booleanCondition || booleanCondition.getCriteriaType() !== SpreadsheetApp.BooleanCriteria.CUSTOM_FORMULA) return true;
      var ruleFormula = booleanCondition.getCriteriaValues() && booleanCondition.getCriteriaValues()[0];
      return ruleFormula !== formula && ruleFormula !== oldFormula;
    } catch (error) {
      return true;
    }
  });

  filteredRules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(formula)
      .setBackground('#f3f4f6')
      .setFontColor('#6b7280')
      .setRanges([targetRange])
      .build()
  );

  sheet.setConditionalFormatRules(filteredRules);
}


function _toSheetRow(job) {
  var jobUrl = _buildLinkedInJobUrlFromJobId(job.jobId) || job.jobLink || job.sourceUrl || '';

  return [
    '',
    job.priority || '',
    job.score === '' ? '' : Number(job.score),
    job.usVisaSponsorshipPotential || '',
    job.company || '',
    job.title || '',
    job.titleLevel || '',
    job.jdImpliedLevel || '',
    job.status || 'New',
    job.location || '',
    job.posted || '',
    job.applicants || '',
    _buildJobLinkFormula(jobUrl),
    job.summary || '',
    job.why || '',
    job.usVisaReason || '',
    job.jobId || '',
    job.importedAt || '',
    job.scoredAt || '',
    job.scoringFingerprint || '',
    job.mergedJobIds || ''
  ];
}

function _buildJobLinkFormula(url) {
  if (!url) {
    return '';
  }

  return '=HYPERLINK("' + String(url).replace(/"/g, '""') + '","Open")';
}

function _compareJobsForDisplay(left, right) {
  var statusDifference = _statusSortRank(left.status) - _statusSortRank(right.status);
  if (statusDifference !== 0) {
    return statusDifference;
  }

  var priorityDifference = _prioritySortRank(left.priority) - _prioritySortRank(right.priority);
  if (priorityDifference !== 0) {
    return priorityDifference;
  }

  var leftScore = Number(left.score || 0);
  var rightScore = Number(right.score || 0);
  if (leftScore !== rightScore) {
    return rightScore - leftScore;
  }

  var importedDifference = _toComparableTime(right.importedAt) - _toComparableTime(left.importedAt);
  if (importedDifference !== 0) {
    return importedDifference;
  }

  return 0;
}

function _statusSortRank(status) {
  var normalized = _stringifyField(status) || 'New';
  if (JOB_PRIORITY_STATUS_SORT_ORDER.hasOwnProperty(normalized)) {
    return JOB_PRIORITY_STATUS_SORT_ORDER[normalized];
  }
  return JOB_PRIORITY_STATUS_OPTIONS.length + 1;
}

function _prioritySortRank(priority) {
  var normalized = _stringifyField(priority).toUpperCase();
  var order = {
    P01: 0,
    P02: 1,
    P03: 2,
    P04: 3,
    P05: 4,
    P06: 5,
    P07: 6,
    P08: 7,
    P09: 8,
    P10: 9,
    A: 0,
    B: 4,
    C: 6,
    SKIP: 9
  };

  if (order.hasOwnProperty(normalized)) {
    return order[normalized];
  }

  return 10;
}

function _columnToLetter(columnNumber) {
  var letter = '';
  var current = Number(columnNumber || 0);

  while (current > 0) {
    var remainder = (current - 1) % 26;
    letter = String.fromCharCode(65 + remainder) + letter;
    current = Math.floor((current - remainder - 1) / 26);
  }

  return letter;
}

function _sheetRowToJobRecord(row, formulas, rowNumber, rawDataByJobId) {
  var rawJobId = _stringifyField(row[JOB_PRIORITY_COLUMN_INDEX.job_id - 1]);
  // job_id cells can get auto-formatted as dates by Sheets (large integers treated as date serials).
  // Always try the HYPERLINK formula as the authoritative source.
  var jobLinkFormula = formulas[JOB_PRIORITY_COLUMN_INDEX.job_link - 1] || '';
  var jobLinkUrl = _extractUrlFromHyperlinkFormula(jobLinkFormula) || '';
  var jobId = _extractLinkedInJobId(rawJobId) || _extractLinkedInJobId(jobLinkUrl);
  var rawData = rawDataByJobId && jobId ? rawDataByJobId[jobId] : null;
  var rawRef = rawData ? (rawData.rawRef || '') : '';
  var company = row[JOB_PRIORITY_COLUMN_INDEX.company - 1];
  var title = row[JOB_PRIORITY_COLUMN_INDEX.title - 1];

  if (!jobId && !company && !title) {
    return null;
  }

  var sourceUrl = _extractSourceUrlFromRawRef(rawData && rawData.rawRef);
  var jobLinkCellValue = row[JOB_PRIORITY_COLUMN_INDEX.job_link - 1] || '';
  var jobLink = jobLinkUrl || _buildLinkedInJobUrlFromJobId(jobId) || sourceUrl;
  var jobDescription = _extractJobDescriptionFromRawRef(rawData && rawData.rawRef);
  var sourceTask = (function() {
    if (!rawData || !rawData.rawRef) return '';
    try { return _stringifyField(JSON.parse(String(rawData.rawRef)).searchString || ''); } catch (e) { return ''; }
  })();
  var mergedJobIds = _stringifyField(row[JOB_PRIORITY_COLUMN_INDEX.merged_job_ids - 1]);

  return {
    rowNumber: rowNumber,
    rank: row[JOB_PRIORITY_COLUMN_INDEX.rank - 1],
    priority: row[JOB_PRIORITY_COLUMN_INDEX.priority - 1],
    score: row[JOB_PRIORITY_COLUMN_INDEX.score - 1],
    usVisaSponsorshipPotential: row[JOB_PRIORITY_COLUMN_INDEX.us_visa - 1] || '',
    company: company || '',
    title: title || '',
    status: row[JOB_PRIORITY_COLUMN_INDEX.status - 1] || 'New',
    location: row[JOB_PRIORITY_COLUMN_INDEX.location - 1] || '',
    posted: row[JOB_PRIORITY_COLUMN_INDEX.posted - 1] || '',
    applicants: row[JOB_PRIORITY_COLUMN_INDEX.applicants - 1] || '',
    jobLink: jobLink || '',
    jobLinkFormula: jobLinkFormula,
    jobLinkCellValue: jobLinkCellValue,
    titleLevel: row[JOB_PRIORITY_COLUMN_INDEX.title_level - 1] || '',
    jdImpliedLevel: row[JOB_PRIORITY_COLUMN_INDEX.jd_implied_level - 1] || '',
    summary: row[JOB_PRIORITY_COLUMN_INDEX.summary - 1] || '',
    why: row[JOB_PRIORITY_COLUMN_INDEX.why - 1] || '',
    jobDescription: jobDescription,
    usVisaReason: row[JOB_PRIORITY_COLUMN_INDEX.us_visa_reason - 1] || '',
    jobId: jobId || '',
    importedAt: _toDateField(row[JOB_PRIORITY_COLUMN_INDEX.imported_at - 1]),
    scoredAt: _toDateField(row[JOB_PRIORITY_COLUMN_INDEX.scored_at - 1]),
    sourceTask: sourceTask,
    sourceUrl: sourceUrl,
    scoringFingerprint: row[JOB_PRIORITY_COLUMN_INDEX.scoring_fingerprint - 1] || '',
    mergedJobIds: mergedJobIds,
    rawRef: rawRef
  };
}

function _extractUrlFromHyperlinkFormula(formula) {
  var text = String(formula || '');
  var match = text.match(/^=HYPERLINK\("([^"]+)"/i);
  return match ? match[1] : '';
}

function _extractJobDescriptionFromRawRef(rawRef) {
  var parsed;
  var description = '';
  var keys = ['jobDescription', 'descriptionText', 'description', 'job_description', 'details'];

  if (!_stringifyField(rawRef)) {
    return '';
  }

  try {
    parsed = JSON.parse(String(rawRef));
    description = _pickFirstValue(parsed || {}, keys);
    description = _truncate(_cleanJobDescription(description), 12000);
    if (description) {
      return description;
    }
  } catch (error) {
    // Fall through to a regex-based recovery attempt for older truncated rows.
  }

  for (var i = 0; i < keys.length; i += 1) {
    description = _extractJsonStringField(rawRef, keys[i]);
    description = _truncate(_cleanJobDescription(description), 12000);
    if (description) {
      return description;
    }
  }

  return '';
}

function _extractSourceUrlFromRawRef(rawRef) {
  if (!rawRef) return '';
  try {
    var p = JSON.parse(String(rawRef));
    return _stringifyField(p.jobUrl || p.applyUrl || p.url || p.link || p.postingUrl || '');
  } catch (e) { return ''; }
}

function _extractLinkedInJobIdFromRawRef(rawRef) {
  var parsed;
  var directJobId = '';
  var keys = ['linkedinJobId', 'jobId', 'jobPostingId'];

  if (!_stringifyField(rawRef)) {
    return '';
  }

  try {
    parsed = JSON.parse(String(rawRef));
    directJobId = _extractLinkedInJobId(_pickFirstValue(parsed || {}, keys));
    if (directJobId) {
      return directJobId;
    }
  } catch (error) {
    // Fall through to regex extraction for older rows.
  }

  for (var i = 0; i < keys.length; i += 1) {
    directJobId = _extractLinkedInJobId(_extractJsonScalarField(rawRef, keys[i]));
    if (directJobId) {
      return directJobId;
    }
  }

  return '';
}

function _extractJsonStringField(rawText, fieldName) {
  var pattern = new RegExp('"' + fieldName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&') + '"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"', 'i');
  var match = String(rawText || '').match(pattern);

  if (!match || !match[1]) {
    return '';
  }

  try {
    return JSON.parse('"' + match[1] + '"');
  } catch (error) {
    return '';
  }
}

function _extractJsonScalarField(rawText, fieldName) {
  var pattern = new RegExp('"' + fieldName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&') + '"\\s*:\\s*("((?:\\\\.|[^"\\\\])*)"|[-]?\\d+)', 'i');
  var match = String(rawText || '').match(pattern);

  if (!match || !match[1]) {
    return '';
  }

  if (match[2] !== undefined) {
    try {
      return JSON.parse('"' + match[2] + '"');
    } catch (error) {
      return '';
    }
  }

  return match[1];
}

function _upsertRawDataRows(jobs) {
  if (!jobs || !jobs.length) {
    return 0;
  }

  var sheet = _getRawDataSheet() || _getOrCreateSheet(SpreadsheetApp.getActiveSpreadsheet(), RAW_DATA_SHEET_NAME);
  if (sheet.getMaxColumns() < RAW_DATA_COLUMNS.length || sheet.getLastRow() < 1) {
    _setupRawDataSheet(sheet);
  }
  var rawDataIndex = getRawDataIndex().byJobId;
  var updates = [];
  var appends = [];
  var writtenJobIds = {};
  var writtenCount = 0;

  jobs.forEach(function(job) {
    var jobId = _extractLinkedInJobId(job && job.jobId) || _stringifyField(job && job.jobId);
    var existing = null;
    var payload = null;

    if (!jobId || writtenJobIds[jobId]) {
      return;
    }

    existing = rawDataIndex[jobId] || null;
    payload = _buildRawDataPayload(job, existing);

    if (!_hasAnyRawPayload(payload)) {
      return;
    }

    writtenJobIds[jobId] = true;

    if (existing) {
      updates.push({
        rowNumber: existing.rowNumber,
        values: _toRawDataRow(payload)
      });
    } else {
      appends.push(_toRawDataRow(payload));
    }

    writtenCount += 1;
  });

  updates.forEach(function(update) {
    sheet.getRange(update.rowNumber, 1, 1, RAW_DATA_COLUMNS.length).setValues([update.values]);
    sheet.getRange(update.rowNumber, 1, 1, 1).setNumberFormat('@');
  });

  if (appends.length) {
    var startRow = Math.max(sheet.getLastRow() + 1, 2);
    sheet.getRange(startRow, 1, appends.length, RAW_DATA_COLUMNS.length).setValues(appends);
    sheet.getRange(startRow, 1, appends.length, 1).setNumberFormat('@');
  }

  return writtenCount;
}

function _buildRawDataPayload(job, existing) {
  return {
    jobId: _extractLinkedInJobId(job && job.jobId) || _stringifyField(job && job.jobId),
    rawRef: _stringifyField(job && job.rawRef) || (existing && existing.rawRef) || ''
  };
}

function _toRawDataRow(rawData) {
  return [
    rawData.jobId || '',
    rawData.rawRef || ''
  ];
}

function _hasAnyRawPayload(record) {
  return !!_stringifyField(record && record.rawRef);
}

function pruneRawData(days) {
  var sheet = _getRawDataSheet();
  if (!sheet) {
    return 0;
  }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return 0;
  }

  var maxCols = sheet.getMaxColumns();
  var headers = sheet.getRange(1, 1, 1, maxCols).getValues()[0];
  var rawRefColIndex = headers.indexOf('raw_ref');
  if (rawRefColIndex === -1) rawRefColIndex = 1;

  var values = sheet.getRange(2, 1, lastRow - 1, maxCols).getValues();
  var cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  var rowsToDelete = [];

  values.forEach(function(row, offset) {
    var rawRef = row[rawRefColIndex];
    if (!rawRef) return;

    var parsed;
    try {
      parsed = JSON.parse(rawRef);
    } catch (e) {
      return;
    }

    // Use publishedAt as the anchor for resolving postedTime relative offsets.
    // _derivePostedDate tries postedTime first (e.g. "54 minutes ago" → anchor - 54min),
    // then falls back to publishedAt/postedAt/createdAt/listedAt directly.
    var anchorStr = parsed.publishedAt || parsed.postedAt || parsed.createdAt || parsed.listedAt || '';
    if (!anchorStr) return;

    var anchorDate = new Date(anchorStr);
    if (isNaN(anchorDate.getTime())) return;

    var postedDate = _derivePostedDate(parsed, parsed.postedTime || '', anchorDate);
    if (!postedDate || isNaN(postedDate.getTime())) {
      postedDate = anchorDate;
    }

    if (postedDate < cutoff) {
      rowsToDelete.push(offset + 2); // 1-based sheet row (data starts at row 2)
    }
  });

  // Delete in reverse order so row numbers stay valid
  for (var i = rowsToDelete.length - 1; i >= 0; i--) {
    sheet.deleteRow(rowsToDelete[i]);
  }

  return rowsToDelete.length;
}

function _clearMainSheetRawPayloadColumns(sheet, rowCount) {
  // source_jd, source_task, source_url, and raw_ref have been removed from the main sheet schema.
  // Raw data now lives exclusively in Raw_Data. This function is a no-op in the new schema.
}

function _groupJobRecordsByJobId(records) {
  return records.reduce(function(groups, record) {
    var jobId = _stringifyField(record.jobId) || ('row_' + String(record.rowNumber || ''));
    if (!groups[jobId]) {
      groups[jobId] = [];
    }
    groups[jobId].push(record);
    return groups;
  }, {});
}

function _mergeDuplicateJobRecordsByJobId(records) {
  if (!records || !records.length) {
    return null;
  }

  var metadataWinner = records.slice().sort(_compareJobRecencyDesc)[0];
  var manualWinner = _pickRichestManualJobRecord(records);
  var merged = _cloneJobRecord(metadataWinner);

  merged.status = manualWinner && manualWinner.status ? manualWinner.status : (merged.status || 'New');

  return merged;
}

function _pickRichestManualJobRecord(records) {
  return records.slice().sort(function(left, right) {
    var scoreDifference = _manualWorkflowScore(right) - _manualWorkflowScore(left);
    if (scoreDifference !== 0) {
      return scoreDifference;
    }
    return _compareJobRecencyDesc(left, right);
  })[0];
}

function _manualWorkflowScore(record) {
  var score = 0;
  var status = String(record.status || 'New');

  if (status && status !== 'New') {
    score += 10;
  }
  if (status === 'Applied') {
    score += 4;
  } else if (status === 'Tailoring') {
    score += 3;
  } else if (status === 'Opened') {
    score += 2;
  } else if (status === 'Skip') {
    score += 1;
  }
  return score;
}

function _cloneJobRecord(job) {
  var clone = {};
  Object.keys(job || {}).forEach(function(key) {
    clone[key] = job[key];
  });
  return clone;
}
