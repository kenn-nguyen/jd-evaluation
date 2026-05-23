var JOB_PRIORITY_SHEET_NAME = 'Job_Priority';
var SETTINGS_SHEET_NAME = 'Settings';
var HELP_SHEET_NAME = 'Help';
var DEDUP_ARCHIVE_SHEET_NAME = 'Dedup_Archive';
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
  'status',
  'location',
  'posted',
  'applicants',
  'job_link',
  'summary',
  'why',
  'angle',
  'notes',
  'source_jd'
];
var JOB_PRIORITY_HIDDEN_COLUMNS = [
  'job_id',
  'imported_at',
  'scored_at',
  'source_task',
  'posted_sort',
  'source_url',
  'other_locations',
  'canonical_role_key',
  'raw_ref'
];
var JOB_PRIORITY_COLUMNS = JOB_PRIORITY_VISIBLE_COLUMNS.concat(JOB_PRIORITY_HIDDEN_COLUMNS);
var DEDUP_ARCHIVE_COLUMNS = ['deduped_at', 'canonical_role_key'].concat(JOB_PRIORITY_COLUMNS);
var JOB_PRIORITY_COLUMN_INDEX = (function() {
  var map = {};
  for (var i = 0; i < JOB_PRIORITY_COLUMNS.length; i += 1) {
    map[JOB_PRIORITY_COLUMNS[i]] = i + 1;
  }
  return map;
})();
var SETTINGS_DEFAULT_ROWS = [
  ['setting_key', 'setting_value', 'notes'],
  ['GEMINI_API_ROUTE', 'developer', 'developer uses Gemini Developer API. vertex uses your linked Google Cloud project and Vertex billing.'],
  ['VERTEX_PROJECT_ID', '', 'Required only when GEMINI_API_ROUTE=vertex. Use your standard Google Cloud project id.'],
  ['VERTEX_LOCATION', 'global', 'Usually keep global for Gemini models on Vertex'],
  ['SCORING_MODEL', 'gemini-2.5-flash', 'Editable model name used for scoring'],
  ['SCORING_PARALLEL_REQUESTS', '3', 'How many AI scoring requests to send in parallel per batch'],
  ['TARGET_PROFILE', 'Product manager and product leader with 10+ years of experience, most recently at Senior Product Manager / Associate Product Director level, with graduate business training from Yale SOM and NUS MBA. Strongest domains include fintech, banking, payments, identity verification, fraud detection, risk decisioning, authentication, eKYC/KYC, trust and safety, AI/ML-enabled products, API platforms, SDKs, enterprise SaaS, and regulated financial-institution workflows. Experience includes scaling API-based identity and fraud products, launching biometric payment authentication, defining ML model requirements, improving verification and authentication conversion, reducing integration friction, and supporting portfolio growth across APAC and LATAM. Strengths include product strategy, 0-to-1 launch, technical and platform/API product management, customer discovery, enterprise problem solving, fraud-versus-conversion tradeoff management, roadmap prioritization, and cross-functional leadership. Prioritize Product Manager and Senior Product Manager roles as the primary target, especially in fintech, payments, fraud/risk, identity, trust and safety, AI/ML platforms, developer/API platforms, enterprise SaaS, and AI workflow products. PM-adjacent bridge roles can still be attractive when they offer real product scope and strong US-market value. Lead, Staff, Senior Staff, Principal, Director, and higher product roles should usually be treated as stretch opportunities and lower practical priority unless the fit is unusually strong and the likelihood of consideration is clearly high.', 'Editable scoring context. Replace this with your own resume-derived profile text as needed.'],
  ['SCORING_INSTRUCTIONS', 'default', 'Use default to keep the built-in scoring prompt, or replace with your own instruction block. The built-in prompt scores role fit first and evaluates visa separately at the end.'],
  ['NOTIFY_EMAIL', '', 'Optional. Email address for A-priority alerts and critical failure alerts'],
  ['FORCE_RESCORE', 'FALSE', 'TRUE rescoring existing jobs in the current fetch'],
  ['APIFY_TASK_IDS', '', 'Your Apify task id, for example masterabctech~linkedin-job-scraper-task']
];
var HELP_ROWS = [
  ['Job Priority Help', ''],
  ['What Run Now does', 'Starts your Apify task, waits for it to finish, fetches that batch of jobs, scores new jobs, and writes ranked results into Job_Priority.'],
  ['Step 1', 'Open Apps Script Project Settings and add Script Property APIFY_TOKEN.'],
  ['Step 2', 'If using Gemini Developer API, also add Script Property GEMINI_API_KEY and leave GEMINI_API_ROUTE as developer.'],
  ['Step 3', 'If using Vertex billing, switch this Apps Script project to a standard Google Cloud project, enable Vertex AI API there, and set GEMINI_API_ROUTE to vertex.'],
  ['Step 4', 'If GEMINI_API_ROUTE is vertex, fill in VERTEX_PROJECT_ID and usually leave VERTEX_LOCATION as global.'],
  ['Step 5', 'Open the Settings sheet and fill in APIFY_TASK_IDS with your task id.'],
  ['Step 6', 'Edit TARGET_PROFILE directly with your current resume-derived summary or job-targeting profile.'],
  ['Step 7', 'Optional: set NOTIFY_EMAIL if you want email alerts for new A jobs and critical failures.'],
  ['Step 8', 'Leave SCORING_INSTRUCTIONS as default to use the built-in prompt, or replace it with your own prompt rules.'],
  ['Step 9', 'Leave SCORING_MODEL as gemini-2.5-flash unless you want another Gemini model.'],
  ['Step 10', 'Use Jobs Pipeline > Validate Config, then Jobs Pipeline > Run Now.'],
  ['Import old Apify run', 'Use Jobs Pipeline > Import Apify Run ID... to score a finished Apify run again from its saved dataset without scraping a new batch.'],
  ['Retry failed Apify run', 'Use Jobs Pipeline > Retry Apify Run ID... to rerun a finished or failed Apify run in Apify, wait for completion, then import and score that rerun.'],
  ['Large runs', 'Large scoring runs now continue automatically in chunks. If the batch is too large for one Apps Script execution, the script writes partial results, updates Processed, and schedules the next continuation automatically.'],
  ['Resetting prompt default', 'If you want the built-in scoring prompt again, just type default into SCORING_INSTRUCTIONS. You do not need to run setupJobPriorityWorkbook() for that reset.'],
  ['Deduplicate Existing Jobs', 'Use Jobs Pipeline > Deduplicate Existing Jobs to merge existing duplicate rows by canonical company + title + job-description fingerprint and archive removed rows into Dedup_Archive.'],
  ['When you change Apify account', 'Usually only APIFY_TOKEN and APIFY_TASK_IDS need to change.'],
  ['Task id example', 'masterabctech~linkedin-job-scraper-task'],
  ['Parallel AI requests', 'SCORING_PARALLEL_REQUESTS controls how many jobs are scored in parallel per batch. 3 is a safe default.'],
  ['Notification email', 'If NOTIFY_EMAIL is blank, no email notifications are sent.'],
  ['A job alert email', 'Sent when the run finds at least one new A-priority job. The email includes summary, visa signal, why, and job link.'],
  ['Critical failure email', 'Sent when the whole run fails or when a large share of jobs in the run fail to import or score.'],
  ['If AI output is invalid', 'The script retries that job one time. If it still fails, the job is marked failed for that run and the rest continue.'],
  ['Vertex route', 'Vertex route uses the Vertex AI REST endpoint and Apps Script OAuth against your linked standard Google Cloud project, so usage is billed to that project.']
];

function setupJobPriorityWorkbook() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var jobSheet = _getOrCreateSheet(spreadsheet, JOB_PRIORITY_SHEET_NAME);
  var settingsSheet = _getOrCreateSheet(spreadsheet, SETTINGS_SHEET_NAME);
  var helpSheet = _getOrCreateSheet(spreadsheet, HELP_SHEET_NAME);
  var dedupArchiveSheet = _getOrCreateSheet(spreadsheet, DEDUP_ARCHIVE_SHEET_NAME);

  _setupJobPrioritySheet(jobSheet);
  _setupSettingsSheet(settingsSheet);
  _setupHelpSheet(helpSheet);
  _setupDedupArchiveSheet(dedupArchiveSheet);
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
  var groupedByCanonical = {};
  var sheet = _getJobPrioritySheet();
  var byJobId = {};
  var byCanonicalRoleKey = {};

  records.forEach(function(record) {
    if (record.jobId) {
      byJobId[String(record.jobId)] = record;
    }
    if (record.canonicalRoleKey) {
      if (!groupedByCanonical[record.canonicalRoleKey]) {
        groupedByCanonical[record.canonicalRoleKey] = [];
      }
      groupedByCanonical[record.canonicalRoleKey].push(record);
    }
  });

  Object.keys(groupedByCanonical).forEach(function(canonicalRoleKey) {
    byCanonicalRoleKey[canonicalRoleKey] = _mergeDuplicateJobRecords(groupedByCanonical[canonicalRoleKey]);
  });

  return {
    records: records,
    byJobId: byJobId,
    byCanonicalRoleKey: byCanonicalRoleKey
  };
}

function getExistingJobRecords() {
  var sheet = _getJobPrioritySheet();
  var lastRow = sheet.getLastRow();

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
    var record = _sheetRowToJobRecord(row, formulas[rowOffset], JOB_PRIORITY_DATA_START_ROW + rowOffset);

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
  var updates = [];
  var appends = [];

  rows.forEach(function(job) {
    var rowValues = _toSheetRow(job);
    if (job.existingRowNumber) {
      updates.push({
        rowNumber: job.existingRowNumber,
        values: rowValues
      });
    } else {
      appends.push(rowValues);
    }
  });

  updates.forEach(function(update) {
    sheet.getRange(update.rowNumber, 1, 1, JOB_PRIORITY_COLUMNS.length).setValues([update.values]);
  });

  if (appends.length) {
    var startRow = Math.max(sheet.getLastRow() + 1, JOB_PRIORITY_DATA_START_ROW);
    sheet.getRange(startRow, 1, appends.length, JOB_PRIORITY_COLUMNS.length).setValues(appends);
  }

  _applyStatusValidation(sheet);
}

function replaceAllJobs(rows) {
  var sheet = _getJobPrioritySheet();
  var existingLastRow = sheet.getLastRow();
  var clearRowCount = Math.max(existingLastRow - JOB_PRIORITY_DATA_START_ROW + 1, 0);

  if (clearRowCount > 0) {
    sheet.getRange(
      JOB_PRIORITY_DATA_START_ROW,
      1,
      clearRowCount,
      JOB_PRIORITY_COLUMNS.length
    ).clearContent();
  }

  if (rows && rows.length) {
    var outputRows = rows.map(_toSheetRow);
    sheet.getRange(
      JOB_PRIORITY_DATA_START_ROW,
      1,
      outputRows.length,
      JOB_PRIORITY_COLUMNS.length
    ).setValues(outputRows);
  }

  _applyStatusValidation(sheet);
}

function deduplicateExistingJobRows() {
  var records = getExistingJobRecords();
  var groupedByCanonical = _groupJobRecordsByCanonicalRole(records);
  var groupedEntries = Object.keys(groupedByCanonical).map(function(canonicalRoleKey) {
    var groupRecords = groupedByCanonical[canonicalRoleKey];
    return {
      canonicalRoleKey: canonicalRoleKey,
      records: groupRecords,
      firstRowNumber: groupRecords.reduce(function(minRowNumber, record) {
        return Math.min(minRowNumber, Number(record.rowNumber || 0) || JOB_PRIORITY_DATA_START_ROW);
      }, Number.MAX_SAFE_INTEGER)
    };
  }).sort(function(left, right) {
    return left.firstRowNumber - right.firstRowNumber;
  });

  var mergedRecords = [];
  var archiveRows = [];
  var duplicateGroupCount = 0;
  var removedRowCount = 0;
  var dedupedAt = new Date();

  groupedEntries.forEach(function(entry) {
    if (entry.records.length === 1) {
      mergedRecords.push(entry.records[0]);
      return;
    }

    duplicateGroupCount += 1;
    removedRowCount += entry.records.length - 1;

    var metadataWinner = entry.records.slice().sort(_compareJobRecencyDesc)[0];
    var mergedRecord = _mergeDuplicateJobRecords(entry.records);

    entry.records.forEach(function(record) {
      if (record.rowNumber !== metadataWinner.rowNumber) {
        var archivedRecord = _cloneJobRecord(record);
        archivedRecord.dedupedAt = dedupedAt;
        archivedRecord.canonicalRoleKey = entry.canonicalRoleKey;
        archiveRows.push(archivedRecord);
      }
    });

    mergedRecords.push(mergedRecord);
  });

  if (archiveRows.length) {
    _appendDedupArchiveRows(archiveRows);
    replaceAllJobs(mergedRecords);
    sortAndRankJobs();
  }

  return {
    duplicateGroupCount: duplicateGroupCount,
    removedRowCount: removedRowCount,
    archivedRowCount: archiveRows.length,
    finalRowCount: mergedRecords.length || records.length
  };
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

function _getDedupArchiveSheet() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DEDUP_ARCHIVE_SHEET_NAME);
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
  sheet.getRange('H2').setValue('Unique roles');
  sheet.getRange('I2:J2').merge().setValue('');
  sheet.getRange('K2').setValue('To score');
  sheet.getRange('L2').setValue('');
  sheet.getRange('E3').setValue('New jobs');
  sheet.getRange('G3').setValue('A jobs');
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
  _applyColumnWidths(sheet);
  _applyWrappedColumns(sheet);
  _applyStatusFormattingRules(sheet);
}

function _setupDedupArchiveSheet(sheet) {
  _ensureSheetDimensions(sheet, DEDUP_ARCHIVE_COLUMNS.length, 2);
  sheet.getRange(1, 1, 1, DEDUP_ARCHIVE_COLUMNS.length).setValues([DEDUP_ARCHIVE_COLUMNS]);
  sheet.getRange(1, 1, 1, DEDUP_ARCHIVE_COLUMNS.length)
    .setFontWeight('bold')
    .setBackground('#f4cccc');
  sheet.setFrozenRows(1);
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
  var formula = '=AND($' + _columnToLetter(JOB_PRIORITY_COLUMN_INDEX.status) + JOB_PRIORITY_DATA_START_ROW + '<>"",$' +
    _columnToLetter(JOB_PRIORITY_COLUMN_INDEX.status) + JOB_PRIORITY_DATA_START_ROW + '<>"New")';
  var targetRange = sheet.getRange(
    JOB_PRIORITY_DATA_START_ROW,
    1,
    Math.max(sheet.getMaxRows() - JOB_PRIORITY_DATA_START_ROW + 1, 1),
    JOB_PRIORITY_VISIBLE_COLUMNS.length
  );
  var filteredRules = existingRules.filter(function(rule) {
    try {
      var booleanCondition = rule.getBooleanCondition();
      return !(booleanCondition && booleanCondition.getCriteriaType() === SpreadsheetApp.BooleanCriteria.CUSTOM_FORMULA &&
        booleanCondition.getCriteriaValues() &&
        booleanCondition.getCriteriaValues()[0] === formula);
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

function _applyColumnWidths(sheet) {
  var widths = {
    1: 60,
    2: 70,
    3: 70,
    4: 90,
    5: 170,
    6: 240,
    7: 110,
    8: 150,
    9: 110,
    10: 95,
    11: 90,
    12: 260,
    13: 300,
    14: 280,
    15: 240,
    16: 130
  };

  Object.keys(widths).forEach(function(columnIndex) {
    sheet.setColumnWidth(Number(columnIndex), widths[columnIndex]);
  });
}

function _applyWrappedColumns(sheet) {
  [JOB_PRIORITY_COLUMN_INDEX.summary, JOB_PRIORITY_COLUMN_INDEX.why, JOB_PRIORITY_COLUMN_INDEX.angle, JOB_PRIORITY_COLUMN_INDEX.notes]
    .forEach(function(columnIndex) {
      sheet.getRange(
        JOB_PRIORITY_DATA_START_ROW,
        columnIndex,
        Math.max(sheet.getMaxRows() - JOB_PRIORITY_DATA_START_ROW + 1, 1),
        1
      ).setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP);
    });

  sheet.getRange(
    JOB_PRIORITY_DATA_START_ROW,
    JOB_PRIORITY_COLUMN_INDEX.source_jd,
    Math.max(sheet.getMaxRows() - JOB_PRIORITY_DATA_START_ROW + 1, 1),
    1
  ).setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
}

function _toSheetRow(job) {
  return [
    '',
    job.priority || '',
    job.score === '' ? '' : Number(job.score),
    job.usVisaSponsorshipPotential || '',
    job.company || '',
    job.title || '',
    job.status || 'New',
    job.location || '',
    job.posted || '',
    job.applicants || '',
    _buildJobLinkFormula(job.jobLink),
    job.summary || '',
    job.why || '',
    job.angle || '',
    job.notes || '',
    job.jobDescription || '',
    job.jobId || '',
    job.importedAt || '',
    job.scoredAt || '',
    job.sourceTask || '',
    job.postedSort || '',
    job.sourceUrl || '',
    job.otherLocations || '',
    job.canonicalRoleKey || _buildCanonicalRoleKey(job.company, job.title, job.jobDescription || ''),
    job.rawRef || ''
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

  var postedDifference = _toComparableTime(right.postedSort) - _toComparableTime(left.postedSort);
  if (postedDifference !== 0) {
    return postedDifference;
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
  var normalized = _stringifyField(priority);
  var order = {
    A: 0,
    B: 1,
    C: 2,
    Skip: 3
  };

  if (order.hasOwnProperty(normalized)) {
    return order[normalized];
  }

  return 4;
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

function _sheetRowToJobRecord(row, formulas, rowNumber) {
  var jobId = row[JOB_PRIORITY_COLUMN_INDEX.job_id - 1];
  var company = row[JOB_PRIORITY_COLUMN_INDEX.company - 1];
  var title = row[JOB_PRIORITY_COLUMN_INDEX.title - 1];

  if (!jobId && !company && !title) {
    return null;
  }

  var sourceUrl = row[JOB_PRIORITY_COLUMN_INDEX.source_url - 1] || '';
  var jobLinkFormula = formulas[JOB_PRIORITY_COLUMN_INDEX.job_link - 1] || '';
  var jobLink = _extractUrlFromHyperlinkFormula(jobLinkFormula) || _buildCanonicalLinkedInJobUrl(jobId, sourceUrl) || sourceUrl;
  var jobDescription = row[JOB_PRIORITY_COLUMN_INDEX.source_jd - 1] || '';
  var canonicalRoleKey = row[JOB_PRIORITY_COLUMN_INDEX.canonical_role_key - 1] || _buildCanonicalRoleKey(company, title, jobDescription);

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
    summary: row[JOB_PRIORITY_COLUMN_INDEX.summary - 1] || '',
    why: row[JOB_PRIORITY_COLUMN_INDEX.why - 1] || '',
    angle: row[JOB_PRIORITY_COLUMN_INDEX.angle - 1] || '',
    notes: row[JOB_PRIORITY_COLUMN_INDEX.notes - 1] || '',
    jobDescription: jobDescription,
    jobId: jobId || '',
    importedAt: row[JOB_PRIORITY_COLUMN_INDEX.imported_at - 1] || '',
    scoredAt: row[JOB_PRIORITY_COLUMN_INDEX.scored_at - 1] || '',
    sourceTask: row[JOB_PRIORITY_COLUMN_INDEX.source_task - 1] || '',
    postedSort: row[JOB_PRIORITY_COLUMN_INDEX.posted_sort - 1] || '',
    sourceUrl: sourceUrl,
    otherLocations: row[JOB_PRIORITY_COLUMN_INDEX.other_locations - 1] || '',
    canonicalRoleKey: canonicalRoleKey,
    rawRef: row[JOB_PRIORITY_COLUMN_INDEX.raw_ref - 1] || ''
  };
}

function _extractUrlFromHyperlinkFormula(formula) {
  var text = String(formula || '');
  var match = text.match(/^=HYPERLINK\("([^"]+)"/i);
  return match ? match[1] : '';
}

function _appendDedupArchiveRows(rows) {
  if (!rows || !rows.length) {
    return;
  }

  var sheet = _getDedupArchiveSheet();
  var outputRows = rows.map(function(row) {
    return [
      row.dedupedAt || '',
      row.canonicalRoleKey || '',
      _toSheetRow(row)
    ];
  }).map(function(row) {
    return [row[0], row[1]].concat(row[2]);
  });
  var startRow = Math.max(sheet.getLastRow() + 1, 2);
  sheet.getRange(startRow, 1, outputRows.length, DEDUP_ARCHIVE_COLUMNS.length).setValues(outputRows);
}

function _groupJobRecordsByCanonicalRole(records) {
  return records.reduce(function(groups, record) {
    var canonicalRoleKey = record.canonicalRoleKey || _buildCanonicalRoleKey(record.company, record.title, record.jobDescription);
    if (!groups[canonicalRoleKey]) {
      groups[canonicalRoleKey] = [];
    }
    groups[canonicalRoleKey].push(record);
    return groups;
  }, {});
}

function _mergeDuplicateJobRecords(records) {
  if (!records || !records.length) {
    return null;
  }

  var metadataWinner = records.slice().sort(_compareJobRecencyDesc)[0];
  var manualWinner = _pickRichestManualJobRecord(records);
  var merged = _cloneJobRecord(metadataWinner);
  var locationParts = [];

  records.forEach(function(record) {
    locationParts = locationParts.concat(_collectJobLocations(record));
  });

  merged.status = manualWinner && manualWinner.status ? manualWinner.status : (merged.status || 'New');
  merged.notes = manualWinner && manualWinner.notes ? manualWinner.notes : (merged.notes || '');
  merged.otherLocations = _formatOtherLocations(locationParts, merged.location);
  merged.canonicalRoleKey = merged.canonicalRoleKey || _buildCanonicalRoleKey(merged.company, merged.title, merged.jobDescription);

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
  if (_stringifyField(record.notes)) {
    score += 5;
  }

  return score;
}

function _collectJobLocations(record) {
  var locations = [];

  if (_stringifyField(record.location)) {
    locations.push(_stringifyField(record.location));
  }

  _splitLocationList(record.otherLocations).forEach(function(location) {
    locations.push(location);
  });

  return locations;
}

function _splitLocationList(value) {
  if (!value) {
    return [];
  }

  return String(value)
    .split(/\n+/)
    .map(function(part) {
      return part.trim();
    })
    .filter(function(part) {
      return part.length > 0;
    });
}

function _formatOtherLocations(locations, primaryLocation) {
  var seen = {};
  var primaryKey = _normalizeLocationKey(primaryLocation);
  var output = [];

  locations.forEach(function(location) {
    var normalized = _normalizeLocationKey(location);
    var display = _stringifyField(location);

    if (!display || normalized === primaryKey || seen[normalized]) {
      return;
    }

    seen[normalized] = true;
    output.push(display);
  });

  return output.join('\n');
}

function _normalizeLocationKey(value) {
  return _stringifyField(value).toLowerCase().replace(/\s+/g, ' ');
}

function _cloneJobRecord(job) {
  var clone = {};
  Object.keys(job || {}).forEach(function(key) {
    clone[key] = job[key];
  });
  return clone;
}
