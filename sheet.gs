var JOB_PRIORITY_SHEET_NAME = 'Job_Priority';
var SETTINGS_SHEET_NAME = 'Settings';
var HELP_SHEET_NAME = 'Help';
var DEDUP_ARCHIVE_SHEET_NAME = 'Dedup_Archive';
var RAW_DATA_SHEET_NAME = 'Raw_Data';
var APIFY_ACCOUNTS_SHEET_NAME = 'Apify_Accounts';
var APIFY_ACCOUNTS_COLUMNS = ['label', 'batch_key', 'detail_key', 'active'];
var JOB_PRIORITY_HEADER_ROW = 6;
var JOB_PRIORITY_DATA_START_ROW = 7;
// 'Skip' = you skipped it manually (locked from the rules). 'Skip (auto)' = the rules skipped it
// (visa "No (0%)", excluded company, or low-priority P06+) and the rules may re-evaluate/lift it on
// a later run. 'Closed' = the POSTING is no longer accepting (LinkedIn CLOSED, or expired) — unlike
// Skip it is NOT a judgment on the role, so a genuine re-post (new job_id + newer posted date)
// REOPENS it to New. Only the rules ever write '(auto)'; only the import merge / CLOSED signal write
// 'Closed'. _isSkip() covers the two Skips; _isDeadStatus() covers all three "out of queue" states.
var JOB_PRIORITY_STATUS_OPTIONS = ['New', 'Networking', 'Filled', 'Submitted', 'Skip', 'Skip (auto)', 'Closed', 'Flagged'];
var STATUS_SKIP_AUTO = 'Skip (auto)';
var STATUS_CLOSED = 'Closed';
var JOB_PRIORITY_STATUS_SORT_ORDER = {
  Networking: 0,
  Filled: 1,
  Flagged: 2,
  New: 3,
  Submitted: 4,
  Skip: 5,
  'Skip (auto)': 5,
  Closed: 6
};
// 'Assignee' = a manual delegation (locked from the rules). 'Assignee (auto)' = a rules-set
// assignment that the rules may re-evaluate/pull on later runs. Only the rules ever write the
// '(auto)' value, so no manual action can land in the re-manageable bucket. _isAssignee() treats
// both as "assigned to the assignee" for mirroring/sync/prune.
var OWNER_AUTO_ASSIGNEE = 'Assignee (auto)';
var JOB_PRIORITY_OWNER_OPTIONS = ['Me', 'Assignee', OWNER_AUTO_ASSIGNEE];
var ACTION_OPTIONS = ['Fill & Submit', 'Fill Only'];

function _isAssignee(owner) {
  var v = _stringifyField(owner).trim();
  return v === 'Assignee' || v === OWNER_AUTO_ASSIGNEE;
}
// True for both a manual 'Skip' and a rules-set 'Skip (auto)' — for anything that treats the job
// as dead (remove from Assigned, sort to bottom, dedup). The re-evaluable distinction lives only in
// _routeNewJobs (which may lift 'Skip (auto)' but never touches manual 'Skip').
function _isSkip(status) {
  var v = _stringifyField(status).trim();
  return v === 'Skip' || v === STATUS_SKIP_AUTO;
}
// Any "out of the active queue" status: the two Skips plus Closed. Used for Assigned-sheet removal,
// the reconcile terminal set, and the visa-No sweep guard. (Closed differs from Skip only in that a
// fresh re-post reopens it — handled in _mergeNewJobIntoExistingRow, not here.)
function _isDeadStatus(status) {
  var v = _stringifyField(status).trim();
  return _isSkip(v) || v === STATUS_CLOSED;
}
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
  'owner',
  'action',
  'location',
  'posted',
  'applicants',
  'job_link',
  'summary',
  'why',
  'us_visa_reason',
  'referral_contact'
];
var JOB_PRIORITY_HIDDEN_COLUMNS = [
  'job_id',
  'imported_at',
  'scored_at',
  'scoring_fingerprint',
  'merged_job_ids',
  'jd_fingerprint',
  'level_normalized',
  'requires_people_mgmt',
  'required_yoe_pm',
  'required_yoe_total',
  'sort_key'
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
var ASSIGNED_SHEET_NAME = 'Assigned';
var ASSIGNED_STATUS_OPTIONS = ['New', 'Filled', 'Submitted', 'Flagged'];
var ASSIGNED_COLUMNS = [
  'status', 'action', 'rank', 'priority', 'score', 'us_visa',
  'company', 'title', 'location', 'job_link',
  'summary', 'why', 'us_visa_reason', 'posted',
  'notes', 'updated_at', 'applied_at',
  'job_id'
];
var ASSIGNED_COLUMN_INDEX = (function() {
  var map = {};
  for (var i = 0; i < ASSIGNED_COLUMNS.length; i += 1) {
    map[ASSIGNED_COLUMNS[i]] = i + 1;
  }
  return map;
})();
var ASSIGNED_HEADER_ROW    = 3;  // row with column headers (rows 1-2 = instruction + dashboard)
var ASSIGNED_DATA_START_ROW = 4;  // first data row
// Section header rows use '# Section Name' as the key.
// getSettingsMap() skips them; _setupSettingsSheet() styles them as visual dividers.
var SETTINGS_DEFAULT_ROWS = [
  ['setting_key', 'setting_value', 'notes'],

  ['# Scraping & Apify', '', ''],
  ['APIFY_RUN_INPUT', '', 'JSON search input sent to Apify. Use {f_tpr} for auto-computed lookback in seconds. See Help sheet for example.'],
  ['APIFY_LOOKBACK_HOURS', '', 'Fixed lookback in hours (e.g. 48). Blank = auto-compute from time since last successful run.'],
  ['APIFY_MAX_LOOKBACK_HOURS', '168', 'Cap for auto-computed lookback in hours. Prevents huge result sets after long idle periods (default 7 days).'],

  ['# AI Scoring', '', ''],
  ['GEMINI_API_ROUTE', 'developer', 'developer = Gemini Developer API (free quota). vertex = your Google Cloud project with Vertex billing.'],
  ['VERTEX_PROJECT_ID', '', 'Required only when GEMINI_API_ROUTE=vertex. Your standard Google Cloud project id.'],
  ['VERTEX_LOCATION', 'global', 'Vertex region. Keep as global for Gemini models unless instructed otherwise.'],
  ['SCORING_MODEL', 'gemini-2.5-flash', 'Gemini model used for scoring. gemini-2.5-flash recommended.'],
  ['SCORING_PARALLEL_REQUESTS', '3', 'Number of AI scoring requests sent in parallel per batch. 3 is safe for most quota tiers.'],
  ['SCORING_RPM_LIMIT', '0', 'Rate limit in requests/minute. Set to your Gemini/Vertex quota (e.g. 10 for free tier). 0 = no pacing.'],
  ['SCORING_MAX_JOBS_PER_EXECUTION', '0', '0 = auto (sized to fit the 6-minute Apps Script limit; large runs continue automatically across executions). Set a number only to cap it manually.'],
  ['TARGET_PROFILE', '', 'Blank = use the built-in profile. Paste your own resume/profile text to override.'],
  ['SCORING_INSTRUCTIONS', 'default', 'default = use the built-in scoring prompt. Replace with your own instruction block if needed.'],
  ['FORCE_RESCORE', 'FALSE', 'Set TRUE to force re-scoring of already-scored jobs in the current fetch.'],

  ['# Schedule', '', ''],
  ['RUN_INTERVAL_HOURS', '4', 'How often the pipeline runs automatically — any integer 1-12 hours (fires on the nearest hour). A run landing in quiet hours is skipped; the next run covers the gap. Re-run Create Run Trigger after changing.'],
  ['QUIET_START_HOUR', '19', 'Hour to stop running (0-23, Pacific Time). Default 19 = 7 pm PT.'],
  ['QUIET_END_HOUR', '5', 'Hour to resume running (0-23, Pacific Time). Default 5 = 5 am PT. Set both to 0 to disable.'],

  ['# Routing & Delegation', '', ''],
  ['AUTO_RESERVE_PRIORITIES', 'P01,P02', 'Priorities never auto-delegated. Left with an empty Owner for your review (not stamped Me). See Help → Owner & lanes.'],
  ['AUTO_ASSIGN_PRIORITIES', 'P03,P04,P05', 'Priorities auto-routed to the assignee (Owner set to "Assignee (auto)") after each run, if they clear the visa + score filters.'],
  ['AUTO_ASSIGN_MIN_SCORE', '', 'Minimum score (0-100) for assignee routing. Blank = no minimum. Sub-threshold jobs are left unowned (empty) for your review.'],
  ['AUTO_ASSIGN_VISA', 'Yes (100%),Likely (90%),Possible (70%),Unclear (50%)', 'Comma-separated visa signals eligible for assignee routing. Jobs with weaker signals stay unowned for your review (not delegated). See Help → Visa Signals for what each label means.'],
  ['AUTO_SKIP_VISA_NO', 'TRUE', 'TRUE = jobs scored "No (0%)" are auto-set to status "Skip (auto)" during routing, regardless of priority (the role does not sponsor). "Skip (auto)" = skipped by the rules (re-evaluable); plain "Skip" = you skipped it manually (locked). Set FALSE to disable.'],
  ['RESERVED_COMPANIES', '', 'Companies always kept unowned for your review, never delegated to the assignee; case-insensitive (e.g. Stripe,Airbnb).'],
  ['AUTO_ASSIGN_EXCLUDE_COMPANIES', '', 'Companies to skip entirely during routing, case-insensitive (e.g. Google,Meta).'],

  ['# Notifications', '', ''],
  ['NOTIFY_EMAIL', '', 'Your email. Receives P01-priority alerts and critical failure notifications.'],
  ['NOTIFY_ASSIGNEE_EMAIL', '', 'Assignee email. Notified when new jobs are routed to their queue.'],
];

// Section header rows use '# Section Name' as the first element.
// _setupHelpSheet() styles them as visual dividers.
var HELP_ROWS = [
  ['Help', ''],

  ['# Quick Start', ''],
  ['Step 1 — Apify tokens', 'Run Jobs Pipeline → Maintenance → Initialize Sheets, then open the Apify_Accounts sheet. Add one row per account: Label | Batch Key | Detail Key | Active=TRUE. Get tokens at apify.com → Account → Integrations.'],
  ['Step 2 — Gemini API key', 'In Apps Script editor: Project Settings → Script Properties → add GEMINI_API_KEY with your Gemini Developer API key. Leave GEMINI_API_ROUTE as developer.'],
  ['Step 3 — Vertex billing (optional)', 'To use Vertex instead: link this Apps Script project to a standard Google Cloud project, enable Vertex AI API, set GEMINI_API_ROUTE=vertex, fill in VERTEX_PROJECT_ID.'],
  ['Step 4 — Search input', 'Settings → APIFY_RUN_INPUT: paste your LinkedIn search JSON. Use {f_tpr} as a placeholder for auto-computed lookback. Example in the Apify section below.'],
  ['Step 5 — Target profile (optional)', 'Settings → TARGET_PROFILE: paste your resume/profile text to override the built-in profile. Leave blank to use the built-in default.'],
  ['Step 6 — Routing (optional)', 'Settings → Routing & Delegation: configure which priorities go to you vs. your assignee, reserved companies, and visa filters.'],
  ['Step 7 — Validate and run', 'Jobs Pipeline → Maintenance → Validate Config. Then Jobs Pipeline → Run Now.'],

  ['# Apify & Scraping', ''],
  ['Apify actor', 'This tool only works with cheap_scraper/linkedin-job-scraper. Do not change the actor — it determines the response schema used throughout the pipeline.'],
  ['Account rotation', 'Tokens in the Apify_Accounts sheet rotate in row order. Set Active=FALSE to skip a row. The system resumes from the last working token. If all tokens fail, you receive an email alert.'],
  ['APIFY_RUN_INPUT example', '{"startUrls":["https://www.linkedin.com/jobs/search/?f_TPR={f_tpr}&geoId=90000084&keywords=%22product+manager%22"]} — {f_tpr} auto-expands to e.g. r3600 (LinkedIn relative-time format).'],
  ['Import jobs manually', 'Jobs Pipeline → Import Jobs Manually: paste LinkedIn job URLs or raw job IDs (separated by spaces, commas, or new lines). Duplicates already in the sheet are skipped automatically.'],

  ['# AI Scoring', ''],
  ['Reevaluate rows', 'Jobs Pipeline → Reevaluate Selected Rows: rescores only selected jobs. Only New and Networking rows are eligible.'],
  ['Large runs', 'Large scoring batches continue automatically in chunks. If a batch approaches the 6-minute Apps Script limit, the script saves progress and schedules a continuation — no action needed.'],
  ['Parallel requests', 'SCORING_PARALLEL_REQUESTS controls how many jobs are scored simultaneously. 3 is safe for most quota tiers; increase only if you have high RPM quota.'],
  ['If AI output is invalid', 'The script retries each job once on a bad AI response. If it still fails, that job is skipped and the rest continue.'],
  ['Resetting scoring prompt', 'Type default into SCORING_INSTRUCTIONS to restore the built-in prompt. No need to re-run Initialize Sheets.'],
  ['Vertex route', 'Vertex uses the Vertex AI REST endpoint with Apps Script OAuth, billed to your linked Google Cloud project. Usage does not count against Gemini Developer API quotas.'],

  ['# Visa Signals (US sponsorship)', ''],
  ['What it is', 'An informational read of how likely the employer is to sponsor a US work visa. It never changes a job\'s score or priority — it only affects routing. The % is a rough confidence anchor, not a guarantee.'],
  ['Yes (100%)', 'The job post explicitly offers visa / sponsorship / relocation support.'],
  ['Likely (90%)', 'No explicit offer, but a known strong sponsor — big tech or a large global fintech that routinely sponsors.'],
  ['Possible (70%)', 'A soft positive signal: large/global employer, "open to all candidates", or international-friendly language.'],
  ['Unclear (50%)', 'The post is silent on sponsorship — no signal either way. This is the default.'],
  ['US required (40%)', 'Asks for US applicants / US location / US work authorization, but does not explicitly rule sponsorship out.'],
  ['Unlikely (20%)', 'Silent on sponsorship and the context leans against it — small/early-stage startup, government/defense, or staffing/contract.'],
  ['No (0%)', 'The post explicitly says no sponsorship, or requires citizenship / security clearance. These are auto-set to "Skip (auto)" (see AUTO_SKIP_VISA_NO).'],

  ['# Statuses', ''],
  ['New / Networking / Filled / Submitted', 'The active workflow: New (fresh) → Filled (form done) → Submitted (applied); Networking = working a referral. Only New and Networking are re-scoreable.'],
  ['Skip', 'YOU skipped it manually — a deliberate "not interested in this role" decision. Locked: the rules never touch it, and a later re-post of the same JD stays hidden.'],
  ['Skip (auto)', 'The RULES skipped it (visa No, excluded company, or low priority P06+). The rules may lift it on a later run if it re-qualifies.'],
  ['Closed', 'The POSTING is no longer accepting (LinkedIn CLOSED / expired) — set automatically on import, or by you. NOT a judgment on the role: if the same role is re-posted under a new job_id with a newer date, it automatically REOPENS to New. Use this (not Skip) for expired postings you want to see again if they come back.'],
  ['Flagged', 'Raised for your attention (usually by the assignee). Bounces back to you as Owner=Me with the note.'],

  ['# Owner & lanes', ''],
  ['What Owner means', 'The Owner column decides whose lane a job is in. Set it from the dropdown, or let the rules set it. Empty = unmanaged.'],
  ['(empty)', 'Unmanaged. The rules may act on it each run (route to the assignee, leave it, or Skip it). Your review pool = empty-owner, New, non-Skip jobs.'],
  ['Me', 'Your manual claim. The rules never touch it. Clear it back to empty to hand the job back to the rules.'],
  ['Assignee', 'A manual delegation (you picked it). Locked — the rules never re-evaluate or pull it. Mirrored to the Assigned sheet.'],
  ['Assignee (auto)', 'Set by the rules. The rules may re-evaluate it on later runs and pull it back (clear/Skip) if it no longer qualifies — e.g. after a reevaluation drops its priority or flips visa to No. Only the rules write this value. Also mirrored to Assigned.'],
  ['Bounce-backs', 'When the assignee Flags a job or finishes a Fill-Only job, it returns to you as Owner=Me with the status + a note.'],

  ['# Notifications', ''],
  ['Owner notification email', 'If NOTIFY_EMAIL is blank, no email alerts are sent — not for P01 jobs, not for failures.'],
  ['P01 alert', 'Sent when a run finds at least one new P01-priority job. Includes summary, visa signal, why-score, and job link.'],
  ['Critical failure alert', 'Sent when the whole run fails or when a large share of jobs fail to import or score.'],
  ['Assignee notification', 'If NOTIFY_ASSIGNEE_EMAIL is set, the assignee receives a count summary each time new jobs are routed to their queue.'],
];

function setupJobPriorityWorkbook() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var jobSheet = _getOrCreateSheet(spreadsheet, JOB_PRIORITY_SHEET_NAME);
  var settingsSheet = _getOrCreateSheet(spreadsheet, SETTINGS_SHEET_NAME);
  var helpSheet = _getOrCreateSheet(spreadsheet, HELP_SHEET_NAME);
  var rawDataSheet = _getOrCreateSheet(spreadsheet, RAW_DATA_SHEET_NAME);
  var assignedSheet = _getOrCreateSheet(spreadsheet, ASSIGNED_SHEET_NAME);
  var apifyAccountsSheet = _getOrCreateSheet(spreadsheet, APIFY_ACCOUNTS_SHEET_NAME);

  _setupJobPrioritySheet(jobSheet);
  _setupSettingsSheet(settingsSheet);
  _setupHelpSheet(helpSheet);
  _setupRawDataSheet(rawDataSheet);
  _setupAssignedSheet(assignedSheet);
  _setupApifyAccountsSheet(apifyAccountsSheet);
  _protectSheetsForAssignee(spreadsheet);
  // Installable onEdit trigger so assignee status changes sync to the protected Job_Priority
  // sheet (the simple onEdit cannot — it runs as the assignee and is blocked by protection).
  _ensureEditTrigger();
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

  var apifyAccountsSheet = spreadsheet.getSheetByName(APIFY_ACCOUNTS_SHEET_NAME);
  if (!apifyAccountsSheet) {
    apifyAccountsSheet = _getOrCreateSheet(spreadsheet, APIFY_ACCOUNTS_SHEET_NAME);
    _setupApifyAccountsSheet(apifyAccountsSheet);
  } else if (apifyAccountsSheet.getMaxColumns() < APIFY_ACCOUNTS_COLUMNS.length ||
      apifyAccountsSheet.getLastRow() < APIFY_ACCOUNTS_HEADER_ROW ||
      !_headerMatches(apifyAccountsSheet.getRange(APIFY_ACCOUNTS_HEADER_ROW, 1, 1, APIFY_ACCOUNTS_COLUMNS.length).getValues()[0], APIFY_ACCOUNTS_COLUMNS)) {
    _setupApifyAccountsSheet(apifyAccountsSheet);
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
    var key = String(row[0] || '').trim();
    if (key && key.charAt(0) !== '#') {
      settings[key] = row[1];
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

  rows.forEach(function(job) {
    if (!job.jdFingerprint && job.jobDescription) {
      job.jdFingerprint = _jdContentHash(job.jobDescription);
    }
  });

  var updates = [];
  var newJobs = [];

  rows.forEach(function(job) {
    if (job.existingRowNumber) {
      updates.push({ rowNumber: job.existingRowNumber, values: _toSheetRow(job), job: job });
    } else {
      newJobs.push(job);
    }
  });

  updates.forEach(function(update) {
    sheet.getRange(update.rowNumber, 1, 1, JOB_PRIORITY_COLUMNS.length).setValues([update.values]);
    _applyJobIdColumnFormat(sheet, update.rowNumber, 1);
    _applyDataRowFormat(sheet, update.rowNumber, 1);
    sheet.getRange(update.rowNumber, JOB_PRIORITY_COLUMN_INDEX.job_link)
      .setRichTextValue(_buildJobLinkRichText(update.job.jobId, update.job.mergedJobIds));
  });

  var appendedJobs = [];

  if (newJobs.length) {
    var jdHashIndex = _buildJdHashIndex(sheet);
    var batchHashToIdx = {};

    newJobs.forEach(function(job) {
      var hash = job.jdFingerprint;

      if (hash && jdHashIndex[hash]) {
        _mergeNewJobIntoExistingRow(sheet, jdHashIndex[hash], job);
        return;
      }

      if (hash && batchHashToIdx.hasOwnProperty(hash)) {
        _mergeJobIntoBatchPrimary(appendedJobs[batchHashToIdx[hash]], job);
        return;
      }

      if (hash) batchHashToIdx[hash] = appendedJobs.length;
      appendedJobs.push(job);
    });
  }

  if (appendedJobs.length) {
    // Refresh validation FIRST so a newly-appended 'Closed' status (auto-set from a CLOSED posting)
    // is an accepted value even on a sheet that predates the 'Closed' option — otherwise setValues
    // would be rejected by the stale requireValueInList(allowInvalid=false) rule.
    _applyStatusValidation(sheet);
    var appends = appendedJobs.map(_toSheetRow);
    var startRow = Math.max(sheet.getLastRow() + 1, JOB_PRIORITY_DATA_START_ROW);
    sheet.getRange(startRow, 1, appends.length, JOB_PRIORITY_COLUMNS.length).setValues(appends);
    _applyJobIdColumnFormat(sheet, startRow, appends.length);
    _applyDataRowFormat(sheet, startRow, appends.length);
    _applyJobLinkRichTexts(sheet, startRow, appendedJobs);
    appendedJobs.forEach(function(job, i) { job.existingRowNumber = startRow + i; });
  }

  _applyStatusValidation(sheet);

  var assignedJobs = rows.filter(function(job) {
    return _isAssignee(job.owner);
  });
  if (assignedJobs.length) _syncAssignedRowsForJobs(assignedJobs);
}

function _buildJdHashIndex(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < JOB_PRIORITY_DATA_START_ROW) return {};
  var rowCount = lastRow - JOB_PRIORITY_DATA_START_ROW + 1;
  var col = JOB_PRIORITY_COLUMN_INDEX.jd_fingerprint;
  var values = sheet.getRange(JOB_PRIORITY_DATA_START_ROW, col, rowCount, 1).getValues();
  var index = {};
  values.forEach(function(row, i) {
    var hash = _stringifyField(row[0]);
    if (hash) index[hash] = JOB_PRIORITY_DATA_START_ROW + i;
  });
  return index;
}

function _mergeNewJobIntoExistingRow(sheet, rowNumber, newJob) {
  var values = sheet.getRange(rowNumber, 1, 1, JOB_PRIORITY_COLUMNS.length).getValues()[0];
  var updates = {};

  var locIdx = JOB_PRIORITY_COLUMN_INDEX.location - 1;
  var existingLoc = _stringifyField(values[locIdx]).trim();
  var newLoc = _stringifyField(newJob.location).trim();
  if (newLoc && existingLoc.toLowerCase().indexOf(newLoc.toLowerCase()) === -1) {
    updates[JOB_PRIORITY_COLUMN_INDEX.location] = existingLoc ? existingLoc + ' | ' + newLoc : newLoc;
  }

  if (newJob.applicants) {
    updates[JOB_PRIORITY_COLUMN_INDEX.applicants] = newJob.applicants;
  }

  if (newJob.posted) {
    updates[JOB_PRIORITY_COLUMN_INDEX.posted] = newJob.posted;
  }

  // Stable PK: canonical job_id is set once on first import and never changes.
  // Any new ID for the same posting is appended to merged_job_ids only.
  var primaryId = _stringifyField(values[JOB_PRIORITY_COLUMN_INDEX.job_id - 1]);
  var newJobId = _stringifyField(newJob.jobId);
  if (newJobId && newJobId !== primaryId) {
    var existingMerged = _stringifyField(values[JOB_PRIORITY_COLUMN_INDEX.merged_job_ids - 1]);
    var idList = existingMerged ? existingMerged.split(/,\s*/) : [];
    if (idList.indexOf(newJobId) === -1) {
      idList.push(newJobId);
      // Genuine re-post: a NEW job_id for the same JD (LinkedIn re-issues the id on re-post; a
      // re-scrape keeps the id). If the existing row was 'Closed' (expired posting) and this re-post
      // is newer, REOPEN it to New and hand it back to the rules — the role reappeared. Manual 'Skip'
      // / rules 'Skip (auto)' are deliberate rejections and are NOT reopened.
      var existingStatus = _stringifyField(values[JOB_PRIORITY_COLUMN_INDEX.status - 1]);
      if (existingStatus === STATUS_CLOSED &&
          _toComparableTime(newJob.posted) > _toComparableTime(values[JOB_PRIORITY_COLUMN_INDEX.posted - 1])) {
        updates[JOB_PRIORITY_COLUMN_INDEX.status] = 'New';
        updates[JOB_PRIORITY_COLUMN_INDEX.owner] = '';
        var closedNote = _stringifyField(values[JOB_PRIORITY_COLUMN_INDEX.referral_contact - 1]);
        if (closedNote.indexOf('Closed/expired') !== -1) updates[JOB_PRIORITY_COLUMN_INDEX.referral_contact] = '';
      }
    }
    updates[JOB_PRIORITY_COLUMN_INDEX.merged_job_ids] = idList.join(', ');
  }

  Object.keys(updates).forEach(function(col) {
    sheet.getRange(rowNumber, Number(col), 1, 1).setValue(updates[col]);
  });

  var finalMergedIds = updates.hasOwnProperty(JOB_PRIORITY_COLUMN_INDEX.merged_job_ids)
    ? updates[JOB_PRIORITY_COLUMN_INDEX.merged_job_ids]
    : _stringifyField(values[JOB_PRIORITY_COLUMN_INDEX.merged_job_ids - 1]);
  sheet.getRange(rowNumber, JOB_PRIORITY_COLUMN_INDEX.job_link)
    .setRichTextValue(_buildJobLinkRichText(primaryId, finalMergedIds));
}

function _mergeJobIntoBatchPrimary(primary, secondary) {
  var existingLoc = _stringifyField(primary.location).trim();
  var newLoc = _stringifyField(secondary.location).trim();
  if (newLoc && existingLoc.toLowerCase().indexOf(newLoc.toLowerCase()) === -1) {
    primary.location = existingLoc ? existingLoc + ' | ' + newLoc : newLoc;
  }

  if (!primary.applicants && secondary.applicants) {
    primary.applicants = secondary.applicants;
  }

  if (!primary.posted && secondary.posted) {
    primary.posted = secondary.posted;
  }

  var primaryId = _stringifyField(primary.jobId);
  var secondaryId = _stringifyField(secondary.jobId);
  if (secondaryId && secondaryId !== primaryId) {
    var existing = _stringifyField(primary.mergedJobIds) || '';
    var idList = existing ? existing.split(/,\s*/) : [];
    if (idList.indexOf(secondaryId) === -1) {
      idList.push(secondaryId);
      primary.mergedJobIds = idList.join(', ');
    }
  }
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
    sheet.getRange(update.rowNumber, JOB_PRIORITY_COLUMN_INDEX.job_link)
      .setRichTextValue(_buildJobLinkRichText(update.jobId, ''));
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
  // Safety guard: refuse to wipe the sheet when rows is empty.
  // Every legitimate caller (prune, sort, dedup) should have records to write back.
  // An empty array here almost always means a bug upstream, not intentional clearing.
  if (!rows || !rows.length) {
    Logger.log('replaceAllJobs: called with empty rows — refusing to clear the sheet. No data changed.');
    return;
  }

  var skipRawDataSync = opts && opts.skipRawDataSync;

  var sheet = _getJobPrioritySheet();

  // Clear column-level filter criteria so the rewrite doesn't leave rows hidden
  // behind stale filter values. The filter toggle stays; only per-column criteria clear.
  var filter = sheet.getFilter();
  if (filter) {
    for (var col = 1; col <= JOB_PRIORITY_COLUMNS.length; col++) {
      try { filter.removeColumnFilterCriteria(col); } catch (e) {}
    }
  }

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
    rows.forEach(function(job) {
      if (!job.jdFingerprint && job.jobDescription) {
        job.jdFingerprint = _jdContentHash(job.jobDescription);
      }
    });
    var outputRows = rows.map(_toSheetRow);
    sheet.getRange(
      JOB_PRIORITY_DATA_START_ROW,
      1,
      outputRows.length,
      JOB_PRIORITY_COLUMNS.length
    ).setValues(outputRows);

    _applyJobIdColumnFormat(sheet, JOB_PRIORITY_DATA_START_ROW, outputRows.length);
    _applyDataRowFormat(sheet, JOB_PRIORITY_DATA_START_ROW, outputRows.length);
    _applyJobLinkRichTexts(sheet, JOB_PRIORITY_DATA_START_ROW, rows);

    var assignedJobs = rows.filter(function(job) {
      return _isAssignee(job.owner);
    });
    if (assignedJobs.length) _syncAssignedRowsForJobs(assignedJobs);
  }

  _applyStatusValidation(sheet);
  _applyStatusFormattingRules(sheet);
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
  }

  return {
    duplicateGroupCount: duplicateGroupCount,
    removedRowCount: removedRowCount,
    archivedRowCount: 0,
    finalRowCount: mergedRecords.length || records.length
  };
}

function pruneExpiredJobRows(days) {
  var EXPIRY_DAYS = (days !== undefined && days !== null && days !== '') ? Number(days) : 90;
  var now = new Date();
  var expiryMs = EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  var records = getExistingJobRecords();
  var keepRecords = [];
  var prunedCount = 0;

  records.forEach(function(record) {
    // Always keep: active outreach, last-mile items, and assignee work — never silently prune these.
    var protectedStatus = record.status === 'Submitted' || record.status === 'Networking' ||
                          record.status === 'Flagged';
    if (protectedStatus || _isAssignee(record.owner)) {
      keepRecords.push(record);
      return;
    }

    var importedTime = _toComparableTime(record.importedAt);
    // posted is a formatted date for most jobs (parses) or a relative label like "2 weeks ago"
    // (returns 0 → ignored, falls back to importedAt). An old posting is likely filled/closed
    // regardless of when we scraped it, so prune on posting age too — same threshold.
    var postedTime = _toComparableTime(record.posted);
    // No usable timestamp at all → keep (never silently purge records without any date).
    if (!importedTime && !postedTime) {
      keepRecords.push(record);
      return;
    }
    var nowMs = now.getTime();
    var importOld = importedTime && (nowMs - importedTime) > expiryMs;
    var postedOld = postedTime && (nowMs - postedTime) > expiryMs;
    // Prune when stale by EITHER how long it has sat in the pipeline or its posting age.
    if (importOld || postedOld) {
      prunedCount++;
      return;
    }
    keepRecords.push(record);
  });

  if (prunedCount > 0) {
    replaceAllJobs(keepRecords);
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
  // The native sort writes to the hidden sort_key column — make sure the schema (incl. that
  // column) exists first, in case we were reached via a path that skipped ensureWorkbookReadyForRuntime.
  if (sheet.getMaxColumns() < JOB_PRIORITY_COLUMNS.length) {
    _syncJobPrioritySchemaForRuntime(sheet);
    sheet = _getJobPrioritySheet();
  }
  var lastRow = sheet.getLastRow();

  if (lastRow < JOB_PRIORITY_DATA_START_ROW) {
    return;
  }

  var numRows = lastRow - JOB_PRIORITY_DATA_START_ROW + 1;
  var IDX = JOB_PRIORITY_COLUMN_INDEX;

  // FAST PATH: sorting only REORDERS rows — the data doesn't change. So instead of reading all
  // records + rewriting the whole sheet (replaceAllJobs: raw-data upsert, format/rich-text rebuild,
  // validation reapply), compute a composite sort key per row and let Sheets' native Range.sort()
  // reorder the rows in place (values, rich-text hyperlinks, and formats all move together).
  // One values read + one formulas read; no rebuild.
  var vals = sheet.getRange(JOB_PRIORITY_DATA_START_ROW, 1, numRows, JOB_PRIORITY_COLUMNS.length).getValues();
  var linkFormulas = sheet.getRange(JOB_PRIORITY_DATA_START_ROW, IDX.job_link, numRows, 1).getFormulas();

  var sortKeys = vals.map(function(row) {
    return [_buildJobSortKey(
      row[IDX.status - 1], row[IDX.priority - 1], row[IDX.posted - 1],
      row[IDX.imported_at - 1], row[IDX.score - 1]
    )];
  });
  var keyRange = sheet.getRange(JOB_PRIORITY_DATA_START_ROW, IDX.sort_key, numRows, 1);
  keyRange.setNumberFormat('@'); // text, so fixed-width numeric keys sort lexicographically
  keyRange.setValues(sortKeys);

  // Native reorder of the whole data block by the sort key (ascending == our display order).
  sheet.getRange(JOB_PRIORITY_DATA_START_ROW, 1, numRows, JOB_PRIORITY_COLUMNS.length)
    .sort([{ column: IDX.sort_key, ascending: true }]);

  // rank = final row position.
  var ranks = [];
  for (var r = 1; r <= numRows; r++) ranks.push([r]);
  sheet.getRange(JOB_PRIORITY_DATA_START_ROW, IDX.rank, numRows, 1).setValues(ranks);

  // Range.sort() moves per-cell formats (number format, alignment, backgrounds) with each row, and
  // the status chip / row-dim colors are range-based conditional-format rules that re-evaluate by
  // formula regardless of order — so none of those need re-applying. The ONE thing sort does not
  // reliably preserve is rich-text link runs, so rebuild the job_link hyperlinks from the now-sorted
  // job_id + merged_job_ids columns (same as _applyJobLinkRichTexts does on a full rewrite).
  var sortedIds = sheet.getRange(JOB_PRIORITY_DATA_START_ROW, IDX.job_id, numRows, 1).getValues();
  var sortedMerged = sheet.getRange(JOB_PRIORITY_DATA_START_ROW, IDX.merged_job_ids, numRows, 1).getValues();
  var jobLinkRichTexts = sortedIds.map(function(row, i) {
    return [_buildJobLinkRichText(_stringifyField(row[0]), sortedMerged[i][0])];
  });
  sheet.getRange(JOB_PRIORITY_DATA_START_ROW, IDX.job_link, numRows, 1).setRichTextValues(jobLinkRichTexts);

  // Self-heal the Assigned sheet on every rank (drop rows the assignee no longer owns; add active
  // ones). Build records from the values we already read — order-agnostic, so the pre-sort snapshot
  // is fine — avoiding a full getExistingJobRecords() (+ raw_data join). Include the display fields
  // the add-pass needs to push a row (_buildAssignedRow); the job_link is rebuilt from jobId there.
  var reconcileRecords = vals.map(function(row, i) {
    var rawId = _stringifyField(row[IDX.job_id - 1]);
    var url = _extractUrlFromHyperlinkFormula(linkFormulas[i][0] || '');
    return {
      jobId: _extractLinkedInJobId(rawId) || _extractLinkedInJobId(url) || rawId,
      owner: row[IDX.owner - 1],
      status: row[IDX.status - 1],
      action: row[IDX.action - 1],
      mergedJobIds: row[IDX.merged_job_ids - 1],
      rank: row[IDX.rank - 1],
      priority: row[IDX.priority - 1],
      score: row[IDX.score - 1],
      usVisaSponsorshipPotential: row[IDX.us_visa - 1],
      usVisaReason: row[IDX.us_visa_reason - 1],
      company: row[IDX.company - 1],
      title: row[IDX.title - 1],
      location: row[IDX.location - 1],
      posted: row[IDX.posted - 1],
      summary: row[IDX.summary - 1],
      why: row[IDX.why - 1]
    };
  });
  _reconcileAssignedSheet(reconcileRecords);
}

// Composite, fixed-width, zero-padded sort key so an ascending text sort reproduces
// _compareJobsForDisplay: status rank -> priority rank -> newest posted -> highest score.
function _buildJobSortKey(status, priority, posted, importedAt, score) {
  var recency = _toComparableTime(posted) || _toComparableTime(importedAt); // ms; 0 if unknown
  var MAX_MS = 9999999999999; // > any realistic epoch-ms for decades; keeps the inverted value 13 digits
  var invPosted = MAX_MS - Math.max(0, Math.min(recency, MAX_MS)); // newest -> smallest -> sorts first
  var sc = Math.max(0, Math.min(Math.round(Number(score) || 0), 9999));
  return _padSortNum(_statusSortRank(status), 2) +
         _padSortNum(_prioritySortRank(priority), 2) +
         _padSortNum(invPosted, 13) +
         _padSortNum(9999 - sc, 4); // higher score -> smaller -> sorts first
}

function _padSortNum(n, width) {
  var str = String(Math.max(0, Math.floor(Number(n) || 0)));
  while (str.length < width) str = '0' + str;
  return str;
}

// Makes the Assigned sheet fully consistent with Job_Priority ownership. Two passes:
//   Remove — drop Assigned rows the assignee no longer owns: JP row missing, JP owner no longer
//            'Assignee' (flagged/bounced/un-assigned), or JP status 'Skip'. Submitted assignee
//            rows are kept as history.
//   Add    — ensure every active assignee-owned job (owner='Assignee', status not Submitted/Skip)
//            is present, covering bulk Owner→Assignee edits the single-cell onEdit handler misses.
// Reuses the already-loaded JP records; both passes are idempotent.
function _reconcileAssignedSheet(records) {
  var assignedSheet = _getAssignedSheet();
  if (!assignedSheet) return;

  // Map every JP id (primary + merged) → its owner/status.
  var jpById = {};
  (records || []).forEach(function(r) {
    var info = { owner: _stringifyField(r.owner), status: _stringifyField(r.status) || 'New' };
    var ids = [r.jobId];
    if (r.mergedJobIds) {
      _stringifyField(r.mergedJobIds).split(',').forEach(function(p) { ids.push(p); });
    }
    ids.forEach(function(id) {
      var key = _stringifyField(id).trim();
      if (key) jpById[key] = info;
    });
  });

  // --- Remove pass (only if the Assigned sheet has data rows) ---
  var lastRow = assignedSheet.getLastRow();
  if (lastRow >= ASSIGNED_DATA_START_ROW) {
    var rowCount = lastRow - ASSIGNED_DATA_START_ROW + 1;
    var ids = assignedSheet.getRange(ASSIGNED_DATA_START_ROW, ASSIGNED_COLUMN_INDEX.job_id, rowCount, 1).getValues();
    var staleRows = [];
    for (var i = 0; i < ids.length; i++) {
      var id = _stringifyField(ids[i][0]).trim();
      if (!id) continue;
      var jp = jpById[id];
      if (!jp || !_isAssignee(jp.owner) || _isDeadStatus(jp.status)) {
        staleRows.push(ASSIGNED_DATA_START_ROW + i);
      }
    }
    // Delete bottom-up so earlier deletions don't shift the remaining indices.
    for (var j = staleRows.length - 1; j >= 0; j--) {
      assignedSheet.deleteRow(staleRows[j]);
    }
  }

  // --- Add pass: push any active assignee-owned job not already present.
  // _pushJobsToAssignedSheet is idempotent (skips existing rows) and re-sorts after appending. ---
  var TERMINAL = { Submitted: true, Skip: true, 'Skip (auto)': true, Closed: true };
  var toAssign = (records || []).filter(function(r) {
    return _isAssignee(r.owner) && !TERMINAL[_stringifyField(r.status) || 'New'];
  });
  if (toAssign.length) {
    _pushJobsToAssignedSheet(toAssign);
  }
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

  _backfillJdFingerprints();
  _applyStatusValidation(sheet);
  _applyStatusFormattingRules(sheet);
  _applyAISummaryColumnGroup(sheet, JOB_PRIORITY_COLUMN_INDEX.summary);
}

function _backfillJdFingerprints() {
  var sheet = _getJobPrioritySheet();
  if (!sheet) return;
  var lastRow = sheet.getLastRow();
  if (lastRow < JOB_PRIORITY_DATA_START_ROW) return;

  var rowCount = lastRow - JOB_PRIORITY_DATA_START_ROW + 1;
  var jdFpCol = JOB_PRIORITY_COLUMN_INDEX.jd_fingerprint;
  var rawDataIndex = getRawDataIndex();

  var fpValues = sheet.getRange(JOB_PRIORITY_DATA_START_ROW, jdFpCol, rowCount, 1).getValues();
  var jobIdValues = sheet.getRange(JOB_PRIORITY_DATA_START_ROW, JOB_PRIORITY_COLUMN_INDEX.job_id, rowCount, 1).getValues();
  var jobLinkFormulas = sheet.getRange(JOB_PRIORITY_DATA_START_ROW, JOB_PRIORITY_COLUMN_INDEX.job_link, rowCount, 1).getFormulas();

  var updated = false;
  fpValues.forEach(function(row, i) {
    if (row[0]) return;
    var rawJobId = _stringifyField(jobIdValues[i][0]);
    var jobLinkUrl = _extractUrlFromHyperlinkFormula(_stringifyField(jobLinkFormulas[i][0]));
    var jobId = _extractLinkedInJobId(rawJobId) || _extractLinkedInJobId(jobLinkUrl) || rawJobId;
    var rawData = jobId ? rawDataIndex.byJobId[jobId] : null;
    var jobDescription = _extractJobDescriptionFromRawRef(rawData && rawData.rawRef);
    if (jobDescription) {
      fpValues[i][0] = _jdContentHash(jobDescription);
      updated = true;
    }
  });

  if (updated) {
    sheet.getRange(JOB_PRIORITY_DATA_START_ROW, jdFpCol, rowCount, 1).setValues(fpValues);
  }
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

function _getApifyAccountsSheet() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(APIFY_ACCOUNTS_SHEET_NAME);
}

// Header row 1, instruction row 2, data from row 3.
var APIFY_ACCOUNTS_HEADER_ROW = 1;
var APIFY_ACCOUNTS_DATA_START_ROW = 3;

function _setupApifyAccountsSheet(sheet) {
  _ensureSheetDimensions(sheet, APIFY_ACCOUNTS_COLUMNS.length, APIFY_ACCOUNTS_DATA_START_ROW);

  sheet.getRange(APIFY_ACCOUNTS_HEADER_ROW, 1, 1, APIFY_ACCOUNTS_COLUMNS.length).setValues([APIFY_ACCOUNTS_COLUMNS]);
  sheet.getRange(APIFY_ACCOUNTS_HEADER_ROW, 1, 1, APIFY_ACCOUNTS_COLUMNS.length)
    .setFontWeight('bold')
    .setBackground('#d0e0e3');

  // Instruction row (row 2) — explains each column. One account per row from row 3 down.
  sheet.getRange(2, 1, 1, APIFY_ACCOUNTS_COLUMNS.length).setValues([[
    'Friendly name (e.g. John) — for your reference only',
    'API token for the BATCH scraper actor (cheap_scraper/linkedin-job-scraper)',
    'API token for the DETAIL actor (apimaestro/linkedin-job-detail) — used by manual import',
    'TRUE to use this account; blank or FALSE to skip it. Row order = rotation order.'
  ]]);
  sheet.getRange(2, 1, 1, APIFY_ACCOUNTS_COLUMNS.length)
    .setFontStyle('italic')
    .setFontColor('#666666')
    .setBackground('#f3f3f3')
    .setWrap(true);

  sheet.setFrozenRows(2);
  sheet.setColumnWidth(1, 140);
  sheet.setColumnWidth(2, 300);
  sheet.setColumnWidth(3, 300);
  sheet.setColumnWidth(4, 80);

  // One-time migration: seed batch keys from the legacy APIFY_ACCOUNTS JSON setting if the
  // accounts table has no data rows yet, so the existing scheduled run keeps the same keys/order.
  if (sheet.getLastRow() < APIFY_ACCOUNTS_DATA_START_ROW) {
    var legacy = _parseLegacyApifyAccounts();
    if (legacy.length) {
      var rows = legacy.map(function(token, i) {
        return ['Account ' + (i + 1), token, '', true];
      });
      sheet.getRange(APIFY_ACCOUNTS_DATA_START_ROW, 1, rows.length, APIFY_ACCOUNTS_COLUMNS.length).setValues(rows);
    }
  }
}

function _parseLegacyApifyAccounts() {
  var raw = String(getSettingsMap().APIFY_ACCOUNTS || '').trim();
  if (!raw) return [];
  try {
    return JSON.parse(raw).filter(function(a) { return typeof a === 'string' && a.trim(); });
  } catch (e) {
    return [];
  }
}

// Reads the Apify_Accounts sheet into ordered key lists for both actors.
// Active rows only (active TRUE or blank). Falls back to the legacy APIFY_ACCOUNTS JSON
// for batch keys when the sheet is empty/missing, so the batch flow never breaks.
function _getApifyAccounts() {
  var sheet = _getApifyAccountsSheet();
  var batch = [];
  var detail = [];
  // Labels are kept PARALLEL to each key array (a label is pushed only when its key is pushed),
  // so batchLabels[i] names batch[i] and detailLabels[i] names detail[i] even when some rows have
  // only one of the two keys.
  var batchLabels = [];
  var detailLabels = [];

  if (sheet && sheet.getLastRow() >= APIFY_ACCOUNTS_DATA_START_ROW) {
    var rowCount = sheet.getLastRow() - APIFY_ACCOUNTS_DATA_START_ROW + 1;
    var values = sheet.getRange(APIFY_ACCOUNTS_DATA_START_ROW, 1, rowCount, APIFY_ACCOUNTS_COLUMNS.length).getValues();
    values.forEach(function(row) {
      var activeRaw = _stringifyField(row[3]).trim().toUpperCase();
      var isActive = activeRaw === '' || activeRaw === 'TRUE' || activeRaw === 'YES' || row[3] === true;
      if (!isActive) return;
      var batchKey = _stringifyField(row[1]).trim();
      var detailKey = _stringifyField(row[2]).trim();
      var label = _stringifyField(row[0]).trim();
      if (batchKey) { batch.push(batchKey); batchLabels.push(label || ('Account ' + batch.length)); }
      if (detailKey) { detail.push(detailKey); detailLabels.push(label || ('Account ' + detail.length)); }
    });
  }

  // Back-compat: no sheet data → use legacy APIFY_ACCOUNTS JSON for batch keys.
  if (!batch.length) {
    batch = _parseLegacyApifyAccounts();
    batchLabels = batch.map(function(_, i) { return 'Account ' + (i + 1); });
  }

  return { batch: batch, detail: detail, batchLabels: batchLabels, detailLabels: detailLabels };
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

  // setValues() strips RichText — rebuild hyperlinks for job_link from job_id + merged_job_ids
  var jobIdColIdx = JOB_PRIORITY_COLUMNS.indexOf('job_id');
  var mergedIdsColIdx = JOB_PRIORITY_COLUMNS.indexOf('merged_job_ids');
  var jobLinkColIdx = JOB_PRIORITY_COLUMNS.indexOf('job_link');
  if (jobLinkColIdx >= 0 && jobIdColIdx >= 0) {
    var richTexts = remappedRows.map(function(row) {
      return [_buildJobLinkRichText(
        _stringifyField(row[jobIdColIdx]),
        mergedIdsColIdx >= 0 ? _stringifyField(row[mergedIdsColIdx]) : ''
      )];
    });
    sheet.getRange(JOB_PRIORITY_DATA_START_ROW, jobLinkColIdx + 1, rowCount, 1).setRichTextValues(richTexts);
  }
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
    var key = String(defaultRow[0] || '').trim();
    if (key.charAt(0) === '#') {
      outputRows.push([key, '', '']);
    } else {
      outputRows.push([
        key,
        existingValues.hasOwnProperty(key) ? existingValues[key] : defaultRow[1],
        defaultRow[2]
      ]);
    }
  }

  sheet.getRange(1, 1, outputRows.length, 3).setValues(outputRows);

  // Reset data row styles, then apply section header styling
  sheet.getRange(2, 1, outputRows.length - 1, 3)
    .setBackground(null).setFontWeight('normal').setFontStyle('normal');
  for (var j = 1; j < outputRows.length; j++) {
    if (String(outputRows[j][0] || '').charAt(0) === '#') {
      sheet.getRange(j + 1, 1, 1, 3)
        .setBackground('#e8eaed').setFontWeight('bold').setFontStyle('italic');
    }
  }

  sheet.getRange(1, 1, 1, 3).setFontWeight('bold').setBackground('#cfe2f3');
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 220);
  sheet.setColumnWidth(2, 300);
  sheet.setColumnWidth(3, 420);
}

function _setupHelpSheet(sheet) {
  _ensureSheetDimensions(sheet, 2, HELP_ROWS.length + 2);
  sheet.clearContents();
  sheet.getRange(1, 1, HELP_ROWS.length, 2).setValues(HELP_ROWS);

  // Reset styles on data rows, then apply per-row styling
  sheet.getRange(2, 1, HELP_ROWS.length - 1, 2)
    .setBackground(null).setFontWeight('normal').setFontStyle('normal');
  for (var i = 1; i < HELP_ROWS.length; i++) {
    var key = String(HELP_ROWS[i][0] || '').trim();
    if (key.charAt(0) === '#') {
      sheet.getRange(i + 1, 1, 1, 2)
        .setBackground('#e8eaed').setFontWeight('bold').setFontStyle('italic');
    } else {
      sheet.getRange(i + 1, 1, 1, 1).setFontWeight('bold');
    }
  }

  sheet.getRange(1, 1, 1, 2).setFontWeight('bold').setBackground('#fce5cd');
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 230);
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

// Groups summary + why + us_visa_reason into a collapsible column group (collapsed by default).
// Works for both Job_Priority and Assigned sheets via the summaryColIndex param.
function _applyAISummaryColumnGroup(sheet, summaryColIndex) {
  var numCols = 3; // summary, why, us_visa_reason are always consecutive
  var range = sheet.getRange(1, summaryColIndex, 1, numCols);
  var currentDepth = sheet.getColumnGroupDepth(summaryColIndex);
  if (currentDepth > 0) {
    range.shiftColumnGroupDepth(-currentDepth);
  }
  range.shiftColumnGroupDepth(1);
  try {
    sheet.getColumnGroup(summaryColIndex, 1).collapse();
  } catch (e) {
    Logger.log('[ColGroup] Could not collapse AI summary group: ' + e);
  }
}

function _applyJobIdColumnFormat(sheet, startRow, numRows) {
  // LinkedIn job IDs are large integers (e.g. 4416623195). Without explicit text formatting,
  // Google Sheets auto-converts them to date serials and displays "invalid date".
  sheet.getRange(startRow, JOB_PRIORITY_COLUMN_INDEX.job_id, numRows, 1)
    .setNumberFormat('@');
}

function _applyStatusValidation(sheet) {
  var numRows = Math.max(sheet.getMaxRows() - JOB_PRIORITY_DATA_START_ROW + 1, 1);

  var statusRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(JOB_PRIORITY_STATUS_OPTIONS, true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange(JOB_PRIORITY_DATA_START_ROW, JOB_PRIORITY_COLUMN_INDEX.status, numRows, 1)
    .setDataValidation(statusRule);

  var ownerRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(JOB_PRIORITY_OWNER_OPTIONS, true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange(JOB_PRIORITY_DATA_START_ROW, JOB_PRIORITY_COLUMN_INDEX.owner, numRows, 1)
    .setDataValidation(ownerRule);

  var actionRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(ACTION_OPTIONS, true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange(JOB_PRIORITY_DATA_START_ROW, JOB_PRIORITY_COLUMN_INDEX.action, numRows, 1)
    .setDataValidation(actionRule);
}

function _applyStatusFormattingRules(sheet) {
  var existingRules = sheet.getConditionalFormatRules() || [];
  var statusCol = '$' + _columnToLetter(JOB_PRIORITY_COLUMN_INDEX.status);
  var statusRow = JOB_PRIORITY_DATA_START_ROW;

  var rowDimFormula = '=OR(' + statusCol + statusRow + '="Submitted",' + statusCol + statusRow + '="Skip",' + statusCol + statusRow + '="Skip (auto)",' + statusCol + statusRow + '="Closed")';
  var oldFormula = '=AND(' + statusCol + statusRow + '<>"",' + statusCol + statusRow + '<>"New")';

  var chipDefs = [
    { formula: '=' + statusCol + statusRow + '="New"',        bg: '#dbeafe', fg: '#1e40af' },
    { formula: '=' + statusCol + statusRow + '="Networking"', bg: '#fef9c3', fg: '#713f12' },
    { formula: '=' + statusCol + statusRow + '="Filled"',     bg: '#bfdbfe', fg: '#1e3a8a' },
    { formula: '=' + statusCol + statusRow + '="Flagged"',    bg: '#fde68a', fg: '#92400e' },
    { formula: '=' + statusCol + statusRow + '="Submitted"',  bg: '#bbf7d0', fg: '#14532d' },
    { formula: '=' + statusCol + statusRow + '="Skip"',        bg: '#e5e7eb', fg: '#374151' },
    { formula: '=' + statusCol + statusRow + '="Skip (auto)"', bg: '#f1f5f9', fg: '#64748b' },
    { formula: '=' + statusCol + statusRow + '="Closed"',       bg: '#fee2e2', fg: '#991b1b' }
  ];

  var managedFormulas = [rowDimFormula, oldFormula].concat(chipDefs.map(function(c) { return c.formula; }));

  var targetRange = sheet.getRange(
    JOB_PRIORITY_DATA_START_ROW, 1,
    Math.max(sheet.getMaxRows() - JOB_PRIORITY_DATA_START_ROW + 1, 1),
    JOB_PRIORITY_VISIBLE_COLUMNS.length
  );
  var statusRange = sheet.getRange(
    JOB_PRIORITY_DATA_START_ROW,
    JOB_PRIORITY_COLUMN_INDEX.status,
    Math.max(sheet.getMaxRows() - JOB_PRIORITY_DATA_START_ROW + 1, 1),
    1
  );

  var filteredRules = existingRules.filter(function(rule) {
    try {
      var bc = rule.getBooleanCondition();
      if (!bc || bc.getCriteriaType() !== SpreadsheetApp.BooleanCriteria.CUSTOM_FORMULA) return true;
      var f = bc.getCriteriaValues() && bc.getCriteriaValues()[0];
      return managedFormulas.indexOf(f) === -1;
    } catch (e) { return true; }
  });

  // Chip colors on status cell — added first so they win over the row-dim rule for that cell
  chipDefs.forEach(function(chip) {
    filteredRules.push(
      SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied(chip.formula)
        .setBackground(chip.bg)
        .setFontColor(chip.fg)
        .setRanges([statusRange])
        .build()
    );
  });

  // Row-level dim for Applied/Skip (other columns only, since chip rule wins on status cell)
  filteredRules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(rowDimFormula)
      .setBackground('#f3f4f6')
      .setFontColor('#6b7280')
      .setRanges([targetRange])
      .build()
  );

  sheet.setConditionalFormatRules(filteredRules);
}


function _toSheetRow(job) {
  return [
    job.rank || '',
    job.priority || '',
    job.score === '' ? '' : Number(job.score),
    job.usVisaSponsorshipPotential || '',
    job.company || '',
    job.title || '',
    job.titleLevel || '',
    job.jdImpliedLevel || '',
    job.status || 'New',
    job.owner || '',
    job.action || '',
    job.location || '',
    job.posted || '',
    job.applicants || '',
    '',  // job_link — set separately as rich text via _applyJobLinkRichTexts
    job.summary || '',
    job.why || '',
    job.usVisaReason || '',
    job.referralContact || '',
    job.jobId || '',
    job.importedAt || '',
    job.scoredAt || '',
    job.scoringFingerprint || '',
    job.mergedJobIds || '',
    job.jdFingerprint || '',
    job.levelNormalized || '',
    (job.requiresPeopleMgmt === true || job.requiresPeopleMgmt === false) ? job.requiresPeopleMgmt : '',
    (job.requiredYoePm === 0 || job.requiredYoePm) ? job.requiredYoePm : '',
    (job.requiredYoeTotal === 0 || job.requiredYoeTotal) ? job.requiredYoeTotal : '',
    job.sortKey || ''  // scratch column; recomputed and used by sortAndRankJobs' native sort
  ];
}

function _buildJobLinkRichText(jobId, mergedJobIds) {
  var primaryId = _stringifyField(jobId).trim();
  var merged = mergedJobIds
    ? String(mergedJobIds).split(',').map(function(s) { return s.trim(); }).filter(Boolean)
    : [];

  // Display newest link first: merged_job_ids are appended in chronological order,
  // so the last entry is the most recently scraped ID — most likely to still be a live posting.
  // The canonical job_id (stable PK, oldest) goes last as a fallback.
  var ids = merged.slice().reverse();
  if (primaryId && ids.indexOf(primaryId) === -1) ids.push(primaryId);
  if (!ids.length) return SpreadsheetApp.newRichTextValue().setText('').build();

  var isMultiple = ids.length > 1;
  var text = '';
  var links = [];
  ids.forEach(function(id, i) {
    if (i > 0) text += ' | ';
    var start = text.length;
    text += id;
    var url = _buildLinkedInJobUrlFromJobId(id);
    if (url) links.push({ start: start, end: text.length, url: url });
    if (i === 0 && isMultiple) text += ' (newest)';
  });

  var builder = SpreadsheetApp.newRichTextValue().setText(text);
  links.forEach(function(link) {
    builder.setLinkUrl(link.start, link.end, link.url);
  });
  return builder.build();
}

function _applyJobLinkRichTexts(sheet, startRow, jobs) {
  if (!jobs.length) return;
  var col = JOB_PRIORITY_COLUMN_INDEX.job_link;
  var richTexts = jobs.map(function(job) {
    return [_buildJobLinkRichText(job.jobId, job.mergedJobIds)];
  });
  sheet.getRange(startRow, col, richTexts.length, 1).setRichTextValues(richTexts);
}

function restoreJobLinks() {
  var sheet = _getJobPrioritySheet();
  if (!sheet) { SpreadsheetApp.getUi().alert('Job_Priority sheet not found.'); return; }
  var lastRow = sheet.getLastRow();
  if (lastRow < JOB_PRIORITY_DATA_START_ROW) { SpreadsheetApp.getUi().alert('No data rows.'); return; }
  var rowCount = lastRow - JOB_PRIORITY_DATA_START_ROW + 1;
  var jobIds    = sheet.getRange(JOB_PRIORITY_DATA_START_ROW, JOB_PRIORITY_COLUMN_INDEX.job_id,         rowCount, 1).getValues();
  var mergedIds = sheet.getRange(JOB_PRIORITY_DATA_START_ROW, JOB_PRIORITY_COLUMN_INDEX.merged_job_ids, rowCount, 1).getValues();
  var richTexts = jobIds.map(function(row, i) {
    return [_buildJobLinkRichText(_stringifyField(row[0]), _stringifyField(mergedIds[i][0]))];
  });
  sheet.getRange(JOB_PRIORITY_DATA_START_ROW, JOB_PRIORITY_COLUMN_INDEX.job_link, rowCount, 1).setRichTextValues(richTexts);
  SpreadsheetApp.getActiveSpreadsheet().toast('Restored links for ' + rowCount + ' rows.', 'Done');
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

  // Within a priority: freshest POSTING on top. Fall back to import date only when posted is a
  // relative label / missing (returns 0), so those rows don't all sink to the bottom.
  var leftRecency = _toComparableTime(left.posted) || _toComparableTime(left.importedAt);
  var rightRecency = _toComparableTime(right.posted) || _toComparableTime(right.importedAt);
  if (leftRecency !== rightRecency) {
    return rightRecency - leftRecency;
  }

  // Same priority + same posting date → higher score first.
  var leftScore = Number(left.score || 0);
  var rightScore = Number(right.score || 0);
  if (leftScore !== rightScore) {
    return rightScore - leftScore;
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
  // Fall back to the raw string so non-LinkedIn job IDs can still look up Raw_Data
  // (getRawDataIndex also uses _stringifyField(row[0]) as fallback — keep in sync).
  var jobId = _extractLinkedInJobId(rawJobId) || _extractLinkedInJobId(jobLinkUrl) || rawJobId;
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
    owner: row[JOB_PRIORITY_COLUMN_INDEX.owner - 1] || '',
    action: row[JOB_PRIORITY_COLUMN_INDEX.action - 1] || '',
    referralContact: row[JOB_PRIORITY_COLUMN_INDEX.referral_contact - 1] || '',
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
    rawRef: rawRef,
    jdFingerprint: _stringifyField(row[JOB_PRIORITY_COLUMN_INDEX.jd_fingerprint - 1]),
    levelNormalized: row[JOB_PRIORITY_COLUMN_INDEX.level_normalized - 1] || '',
    requiresPeopleMgmt: row[JOB_PRIORITY_COLUMN_INDEX.requires_people_mgmt - 1],
    requiredYoePm: row[JOB_PRIORITY_COLUMN_INDEX.required_yoe_pm - 1],
    requiredYoeTotal: row[JOB_PRIORITY_COLUMN_INDEX.required_yoe_total - 1]
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
    // apimaestro/linkedin-job-detail nests the JD under job_info.description.
    if (parsed && parsed.job_info && parsed.job_info.description) {
      description = _truncate(_cleanJobDescription(parsed.job_info.description), 12000);
      if (description) {
        return description;
      }
    }
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
    if (p && p.job_info && p.job_info.job_url) {
      return _stringifyField(p.job_info.job_url);
    }
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
    if (parsed && parsed.job_info && parsed.job_info.job_posting_id) {
      directJobId = _extractLinkedInJobId(_stringifyField(parsed.job_info.job_posting_id));
      if (directJobId) {
        return directJobId;
      }
    }
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

// Returns a set (plain object) of all job IDs tracked in Job_Priority — both canonical and merged.
// Used by pruneRawData to avoid deleting raw_refs for jobs that are still being tracked.
function _getActiveJobPriorityIds() {
  var result = {};
  var jpSheet = _getJobPrioritySheet();
  if (!jpSheet) return result;
  var lastRow = jpSheet.getLastRow();
  if (lastRow < JOB_PRIORITY_DATA_START_ROW) return result;
  var rowCount = lastRow - JOB_PRIORITY_DATA_START_ROW + 1;
  var primaryIds = jpSheet.getRange(JOB_PRIORITY_DATA_START_ROW, JOB_PRIORITY_COLUMN_INDEX.job_id, rowCount, 1).getValues();
  var mergedIds  = jpSheet.getRange(JOB_PRIORITY_DATA_START_ROW, JOB_PRIORITY_COLUMN_INDEX.merged_job_ids, rowCount, 1).getValues();
  for (var i = 0; i < primaryIds.length; i++) {
    var pid = _stringifyField(primaryIds[i][0]).trim();
    if (pid) result[pid] = true;
    var m = _stringifyField(mergedIds[i][0]);
    if (m) m.split(',').forEach(function(s) { var id = s.trim(); if (id) result[id] = true; });
  }
  return result;
}

function pruneRawData(days) {
  var sheet = _getRawDataSheet();
  if (!sheet) return 0;

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;

  // Load all IDs still in Job_Priority so we never orphan their raw job descriptions.
  // A row whose job is still tracked in JP is kept regardless of age.
  var activeJobIds = _getActiveJobPriorityIds();

  var maxCols = sheet.getMaxColumns();
  var headers = sheet.getRange(1, 1, 1, maxCols).getValues()[0];
  var jobIdColIndex = headers.indexOf('job_id');
  if (jobIdColIndex === -1) jobIdColIndex = 0;

  var dataRowCount = lastRow - 1;
  var values = sheet.getRange(2, 1, dataRowCount, maxCols).getValues();

  // Keep raw_refs for jobs still tracked in Job_Priority (primary OR merged id) — their JD may be
  // needed for re-scoring. Every other row is an ORPHAN (its JP row was deleted/pruned, or a
  // scrape that never landed in JP), so its raw_ref is dead weight — dropped regardless of age.
  var keep = values.filter(function(row) {
    var id = _stringifyField(row[jobIdColIndex]).trim();
    return id && activeJobIds[id];
  });

  var deletedCount = dataRowCount - keep.length;
  if (deletedCount <= 0) return 0;

  // Bulk rewrite — never per-row deleteRow (that times out on thousands of rows). Overwrite the
  // survivors at the top in ONE setValues, then remove the trailing block in ONE deleteRows call:
  // O(1) sheet ops regardless of how many orphans there are. (Raw_Data is an unordered lookup, so
  // compacting survivors to the top is fine.)
  if (keep.length) {
    sheet.getRange(2, 1, keep.length, maxCols).setValues(keep);
    // Keep job_id as text so large numeric ids are never coerced to dates.
    sheet.getRange(2, jobIdColIndex + 1, keep.length, 1).setNumberFormat('@');
  }
  var firstTrailingRow = 2 + keep.length;
  var trailingCount = lastRow - firstTrailingRow + 1;
  if (trailingCount > 0) {
    sheet.deleteRows(firstTrailingRow, trailingCount);
  }

  return deletedCount;
}

function pruneAssignedRows(days) {
  var sheet = _getAssignedSheet();
  if (!sheet) return 0;
  var lastRow = sheet.getLastRow();
  if (lastRow < ASSIGNED_DATA_START_ROW) return 0;

  var cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  // Load JP IDs AFTER pruneExpiredJobRows has already run — orphaned Assigned rows
  // (whose JP parent was just pruned) should be cleaned up regardless of status/age.
  var activeJpIds = _getActiveJobPriorityIds();

  var rowCount = lastRow - ASSIGNED_DATA_START_ROW + 1;
  var values = sheet.getRange(ASSIGNED_DATA_START_ROW, 1, rowCount, ASSIGNED_COLUMNS.length).getValues();

  var rowsToDelete = [];
  values.forEach(function(row, offset) {
    var assignedJobId = _stringifyField(row[ASSIGNED_COLUMN_INDEX.job_id - 1]).trim();
    // Orphan: JP parent was pruned — remove regardless of status or age.
    if (assignedJobId && !activeJpIds[assignedJobId]) {
      rowsToDelete.push(ASSIGNED_DATA_START_ROW + offset);
      return;
    }

    var status = _stringifyField(row[ASSIGNED_COLUMN_INDEX.status - 1]);
    // Keep all active/in-progress rows permanently; only age-prune Submitted history rows.
    if (status === 'New' || status === 'Filled' || status === 'Flagged') return;

    var updatedAt = row[ASSIGNED_COLUMN_INDEX.updated_at - 1];
    if (!updatedAt) return;
    var updatedDate = new Date(updatedAt);
    if (isNaN(updatedDate.getTime())) return;

    if (updatedDate < cutoff) rowsToDelete.push(ASSIGNED_DATA_START_ROW + offset);
  });

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

  // A rules-set 'Skip (auto)' and a posting-state 'Closed' are system labels, not manual workflow
  // decisions — treat them like 'New' here so a real manual status on a duplicate row wins the merge.
  if (status && status !== 'New' && status !== 'Skip (auto)' && status !== 'Closed') {
    score += 10;
  }
  if (status === 'Submitted') {
    score += 4;
  } else if (status === 'Filled') {
    score += 3;
  } else if (status === 'Networking') {
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

// ── Assigned sheet helpers ─────────────────────────────────────────────────

function _getAssignedSheet() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ASSIGNED_SHEET_NAME) || null;
}

function _getAssignedJobIdIndex(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < ASSIGNED_DATA_START_ROW) return {};
  var rowCount = lastRow - ASSIGNED_DATA_START_ROW + 1;
  var col = ASSIGNED_COLUMN_INDEX.job_id;
  var values = sheet.getRange(ASSIGNED_DATA_START_ROW, col, rowCount, 1).getValues();
  var index = {};
  values.forEach(function(row, i) {
    var id = _stringifyField(row[0]).trim();
    if (id) index[id] = ASSIGNED_DATA_START_ROW + i;
  });
  return index;
}

function _formatNow() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
}

function _buildAssignedRow(job, status) {
  return [
    status || 'New',
    job.action || 'Fill & Submit',
    job.rank || '',
    job.priority || '',
    job.score === '' ? '' : (job.score !== undefined ? Number(job.score) : ''),
    job.usVisaSponsorshipPotential || '',
    job.company || '',
    job.title || '',
    job.location || '',
    '',  // job_link — set separately as rich text
    job.summary || '',
    job.why || '',
    job.usVisaReason || '',
    job.posted || '',
    '',  // notes
    _formatNow(),  // updated_at
    '',  // applied_at
    job.jobId || ''
  ];
}

function _setupAssignedSheet(sheet) {
  // ── Migration: if old header is at row 1 (no instruction rows yet), insert 2 rows ──
  var firstCell = _stringifyField(sheet.getRange(1, 1).getValue()).trim().toLowerCase();
  if (firstCell === ASSIGNED_COLUMNS[0].toLowerCase()) {
    sheet.insertRowsBefore(1, ASSIGNED_HEADER_ROW - 1);
  }

  _ensureSheetDimensions(sheet, ASSIGNED_COLUMNS.length, ASSIGNED_DATA_START_ROW);

  // ── Row 1: Instructions ──
  var instrRange = sheet.getRange(1, 1, 1, ASSIGNED_COLUMNS.length);
  instrRange.merge();
  instrRange.setValue(
    'Your application queue — jobs routed here by the pipeline. ' +
    'Status flow: New → Filled (form done) → Submitted (applied). ' +
    'To flag: set Status to Flagged and write why in the Notes column (either order works — the note syncs to the owner). Use this for anything problematic (failed, can\'t fill, expired, etc.).'
  );
  instrRange.setFontSize(10).setWrap(true)
    .setBackground('#f0fdf4').setFontColor('#374151')
    .setVerticalAlignment('middle');
  sheet.setRowHeight(1, 44);

  // ── Row 2: Live dashboard ──
  var sLetter = _columnToLetter(ASSIGNED_COLUMN_INDEX.status);
  var sRange  = '$' + sLetter + '$' + ASSIGNED_DATA_START_ROW + ':$' + sLetter;
  var dashRow = new Array(ASSIGNED_COLUMNS.length).fill('');
  dashRow[0]  = 'Queue';
  dashRow[1]  = 'New';
  dashRow[2]  = '=COUNTIF(' + sRange + ',"New")';
  dashRow[3]  = 'Filled';
  dashRow[4]  = '=COUNTIF(' + sRange + ',"Filled")';
  dashRow[5]  = 'Flagged';
  dashRow[6]  = '=COUNTIF(' + sRange + ',"Flagged")';
  dashRow[7]  = 'Submitted';
  dashRow[8]  = '=COUNTIF(' + sRange + ',"Submitted")';
  dashRow[9]  = '';
  dashRow[10] = '';
  dashRow[11] = 'Total';
  dashRow[12] = '=COUNTA(' + sRange + ')';
  sheet.getRange(2, 1, 1, ASSIGNED_COLUMNS.length).setValues([dashRow]);
  // Style: prefix bold, label cells muted, count cells larger+bold
  sheet.getRange(2, 1).setFontWeight('bold').setFontSize(10).setFontColor('#374151');
  [2, 4, 6, 8, 10, 12].forEach(function(c) {
    sheet.getRange(2, c).setFontWeight('bold').setFontSize(9).setFontColor('#6b7280');
  });
  [3, 5, 7, 9, 11, 13].forEach(function(c) {
    sheet.getRange(2, c).setFontWeight('bold').setFontSize(12).setFontColor('#111827');
  });
  sheet.getRange(2, 1, 1, ASSIGNED_COLUMNS.length).setBackground('#f0fdf4');
  sheet.setRowHeight(2, 30);

  // ── Row ASSIGNED_HEADER_ROW: column headers ──
  sheet.getRange(ASSIGNED_HEADER_ROW, 1, 1, ASSIGNED_COLUMNS.length).setValues([ASSIGNED_COLUMNS]);
  sheet.getRange(ASSIGNED_HEADER_ROW, 1, 1, ASSIGNED_COLUMNS.length)
    .setFontWeight('bold')
    .setBackground('#d9ead3');
  sheet.setFrozenRows(ASSIGNED_HEADER_ROW);

  var assignedRowSpan = Math.max(sheet.getMaxRows() - ASSIGNED_DATA_START_ROW + 1, 1);
  var statusRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(ASSIGNED_STATUS_OPTIONS, true)
    .setAllowInvalid(false)
    .build();
  var assignedStatusRange = sheet.getRange(ASSIGNED_DATA_START_ROW, ASSIGNED_COLUMN_INDEX.status,
    assignedRowSpan, 1);
  assignedStatusRange.setDataValidation(statusRule);

  var actionRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(ACTION_OPTIONS, true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange(ASSIGNED_DATA_START_ROW, ASSIGNED_COLUMN_INDEX.action, assignedRowSpan, 1)
    .setDataValidation(actionRule);

  var assignedStatusCol = '$' + _columnToLetter(ASSIGNED_COLUMN_INDEX.status);
  var assignedStatusRow = ASSIGNED_DATA_START_ROW;
  var assignedChipDefs = [
    { formula: '=' + assignedStatusCol + assignedStatusRow + '="New"',       bg: '#dbeafe', fg: '#1e40af' },
    { formula: '=' + assignedStatusCol + assignedStatusRow + '="Filled"',    bg: '#fed7aa', fg: '#9a3412' },
    { formula: '=' + assignedStatusCol + assignedStatusRow + '="Submitted"', bg: '#bbf7d0', fg: '#14532d' },
    { formula: '=' + assignedStatusCol + assignedStatusRow + '="Flagged"',   bg: '#fde68a', fg: '#92400e' }
  ];
  var existingAssignedRules = sheet.getConditionalFormatRules() || [];
  var assignedManagedFormulas = assignedChipDefs.map(function(c) { return c.formula; });
  var filteredAssignedRules = existingAssignedRules.filter(function(rule) {
    try {
      var bc = rule.getBooleanCondition();
      if (!bc || bc.getCriteriaType() !== SpreadsheetApp.BooleanCriteria.CUSTOM_FORMULA) return true;
      var f = bc.getCriteriaValues() && bc.getCriteriaValues()[0];
      return assignedManagedFormulas.indexOf(f) === -1;
    } catch (e) { return true; }
  });
  assignedChipDefs.forEach(function(chip) {
    filteredAssignedRules.push(
      SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied(chip.formula)
        .setBackground(chip.bg)
        .setFontColor(chip.fg)
        .setRanges([assignedStatusRange])
        .build()
    );
  });
  sheet.setConditionalFormatRules(filteredAssignedRules);

  sheet.hideColumns(ASSIGNED_COLUMN_INDEX.job_id);
  // job_id stores large LinkedIn integers — force text format so Sheets never auto-converts them.
  sheet.getRange(ASSIGNED_DATA_START_ROW, ASSIGNED_COLUMN_INDEX.job_id,
    Math.max(sheet.getMaxRows() - ASSIGNED_DATA_START_ROW + 1, 1), 1).setNumberFormat('@');
  _applyAISummaryColumnGroup(sheet, ASSIGNED_COLUMN_INDEX.summary);

  var colWidths = {
    summary: 300, why: 250, us_visa_reason: 200,
    title: 200, company: 150, location: 150,
    notes: 200, job_link: 160
  };
  Object.keys(colWidths).forEach(function(col) {
    if (ASSIGNED_COLUMN_INDEX[col]) {
      sheet.setColumnWidth(ASSIGNED_COLUMN_INDEX[col], colWidths[col]);
    }
  });
}

function _pushJobsToAssignedSheet(jobs) {
  if (!jobs || !jobs.length) return 0;
  var assignedSheet = _getAssignedSheet();
  if (!assignedSheet) return 0;

  var existingIndex = _getAssignedJobIdIndex(assignedSheet);

  // Re-assign: reset any existing Flagged row back to New so the job re-enters the queue.
  var toReset = jobs.filter(function(job) {
    var id = _stringifyField(job.jobId).trim();
    if (!id || !existingIndex[id]) return false;
    var rowNum = existingIndex[id];
    var status = _stringifyField(assignedSheet.getRange(rowNum, ASSIGNED_COLUMN_INDEX.status).getValue());
    return status === 'Flagged';
  });
  toReset.forEach(function(job) {
    var rowNum = existingIndex[_stringifyField(job.jobId).trim()];
    assignedSheet.getRange(rowNum, ASSIGNED_COLUMN_INDEX.status).setValue('New');
    assignedSheet.getRange(rowNum, ASSIGNED_COLUMN_INDEX.notes).setValue('');
    assignedSheet.getRange(rowNum, ASSIGNED_COLUMN_INDEX.updated_at).setValue(_formatNow());
  });

  var toAdd = jobs.filter(function(job) {
    var id = _stringifyField(job.jobId).trim();
    return id && !existingIndex[id];
  });
  if (!toAdd.length && !toReset.length) return 0;
  if (!toAdd.length) { _sortAssignedSheet(assignedSheet); return toReset.length; }

  var startRow = Math.max(assignedSheet.getLastRow() + 1, ASSIGNED_DATA_START_ROW);
  var rows = toAdd.map(function(job) { return _buildAssignedRow(job, 'New'); });
  assignedSheet.getRange(startRow, 1, rows.length, ASSIGNED_COLUMNS.length).setValues(rows);
  assignedSheet.getRange(startRow, ASSIGNED_COLUMN_INDEX.job_id, rows.length, 1).setNumberFormat('@');

  var richTexts = toAdd.map(function(job) {
    return [_buildJobLinkRichText(job.jobId, job.mergedJobIds)];
  });
  assignedSheet.getRange(startRow, ASSIGNED_COLUMN_INDEX.job_link, richTexts.length, 1)
    .setRichTextValues(richTexts);

  // Mark ownership on the master sheet (lane = Owner, not status). Preserve an existing assignee
  // flavor (esp. rules' 'Assignee (auto)'); only stamp plain 'Assignee' when it wasn't assigned
  // yet (e.g. the "Assign Selected Rows" menu, where owner was empty/Me — a manual delegation).
  var jobSheet = _getJobPrioritySheet();
  toAdd.forEach(function(job) {
    var rowNum = _findJobPriorityRowByJobId(_stringifyField(job.jobId));
    if (rowNum) {
      jobSheet.getRange(rowNum, JOB_PRIORITY_COLUMN_INDEX.owner)
        .setValue(_isAssignee(job.owner) ? job.owner : 'Assignee');
      var act = _stringifyField(job.action) || 'Fill & Submit';
      jobSheet.getRange(rowNum, JOB_PRIORITY_COLUMN_INDEX.action).setValue(act);
    }
  });

  _sortAssignedSheet(assignedSheet);
  return toAdd.length;
}

function _sortAssignedSheet(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < ASSIGNED_DATA_START_ROW) return;
  var numRows = lastRow - ASSIGNED_DATA_START_ROW + 1;
  if (numRows < 1) return;

  var dataRange = sheet.getRange(ASSIGNED_DATA_START_ROW, 1, numRows, ASSIGNED_COLUMNS.length);
  var values = dataRange.getValues();
  var richTexts = sheet.getRange(ASSIGNED_DATA_START_ROW, ASSIGNED_COLUMN_INDEX.job_link, numRows, 1).getRichTextValues();

  // Sort by index so we can reorder richTexts in parallel.
  // Rule: Submitted rows sink to the bottom. All other statuses (New/Filled/Flagged)
  // are active work and sorted together by priority → newest posted date → score
  // (matches the Job_Priority sort so the rank column and row order stay consistent).
  var indices = values.map(function(_, i) { return i; });
  indices.sort(function(a, b) {
    var rowA = values[a], rowB = values[b];
    var isSubmittedA = _stringifyField(rowA[ASSIGNED_COLUMN_INDEX.status - 1]) === 'Submitted' ? 1 : 0;
    var isSubmittedB = _stringifyField(rowB[ASSIGNED_COLUMN_INDEX.status - 1]) === 'Submitted' ? 1 : 0;
    if (isSubmittedA !== isSubmittedB) return isSubmittedA - isSubmittedB;
    var pA = _prioritySortRank(_stringifyField(rowA[ASSIGNED_COLUMN_INDEX.priority - 1]));
    var pB = _prioritySortRank(_stringifyField(rowB[ASSIGNED_COLUMN_INDEX.priority - 1]));
    if (pA !== pB) return pA - pB;
    // Freshest posting first within a priority (unparseable/label posted → 0, sinks).
    var postedA = _toComparableTime(rowA[ASSIGNED_COLUMN_INDEX.posted - 1]);
    var postedB = _toComparableTime(rowB[ASSIGNED_COLUMN_INDEX.posted - 1]);
    if (postedA !== postedB) return postedB - postedA;
    var scoreA = Number(rowA[ASSIGNED_COLUMN_INDEX.score - 1]) || 0;
    var scoreB = Number(rowB[ASSIGNED_COLUMN_INDEX.score - 1]) || 0;
    return scoreB - scoreA;
  });

  var sortedValues = indices.map(function(i) { return values[i]; });
  var sortedRichTexts = indices.map(function(i) { return richTexts[i]; });
  dataRange.setValues(sortedValues);
  // Re-apply '@' format so job_id integers are never auto-converted to dates by Sheets.
  sheet.getRange(ASSIGNED_DATA_START_ROW, ASSIGNED_COLUMN_INDEX.job_id, numRows, 1).setNumberFormat('@');

  // Restore sorted rich texts. For any cell whose captured rich text is empty (can happen when
  // the preceding flush hasn't propagated writes from a different sheet reference), rebuild the
  // URL from the sorted job_id value so the cell is never left blank.
  var finalRichTexts = sortedRichTexts.map(function(rt, j) {
    if (rt[0] && rt[0].getText()) return rt;
    var jobId = _stringifyField(sortedValues[j][ASSIGNED_COLUMN_INDEX.job_id - 1]).trim();
    return [_buildJobLinkRichText(jobId, '')];
  });
  sheet.getRange(ASSIGNED_DATA_START_ROW, ASSIGNED_COLUMN_INDEX.job_link, numRows, 1).setRichTextValues(finalRichTexts);
}

function _syncAssignedRowsForJobs(jobs) {
  if (!jobs || !jobs.length) return;
  var assignedSheet = _getAssignedSheet();
  if (!assignedSheet) return;

  var existingIndex = _getAssignedJobIdIndex(assignedSheet);
  var now = _formatNow();

  jobs.forEach(function(job) {
    var id = _stringifyField(job.jobId).trim();
    var rowNum = id ? existingIndex[id] : null;
    if (!rowNum) return;

    var updates = [
      [ASSIGNED_COLUMN_INDEX.rank, job.rank || ''],
      [ASSIGNED_COLUMN_INDEX.priority, job.priority || ''],
      [ASSIGNED_COLUMN_INDEX.score, job.score === '' ? '' : (job.score !== undefined ? Number(job.score) : '')],
      [ASSIGNED_COLUMN_INDEX.us_visa, job.usVisaSponsorshipPotential || ''],
      [ASSIGNED_COLUMN_INDEX.summary, job.summary || ''],
      [ASSIGNED_COLUMN_INDEX.why, job.why || ''],
      [ASSIGNED_COLUMN_INDEX.us_visa_reason, job.usVisaReason || ''],
      [ASSIGNED_COLUMN_INDEX.updated_at, now]
    ];
    updates.forEach(function(u) {
      assignedSheet.getRange(rowNum, u[0]).setValue(u[1]);
    });
    assignedSheet.getRange(rowNum, ASSIGNED_COLUMN_INDEX.job_link)
      .setRichTextValue(_buildJobLinkRichText(job.jobId, job.mergedJobIds));
  });
}

function _removeFromAssignedSheet(assignedSheet, jobId) {
  var id = _stringifyField(jobId).trim();
  if (!id) return;
  var index = _getAssignedJobIdIndex(assignedSheet);
  var rowNum = index[id];
  if (!rowNum) return;
  assignedSheet.deleteRow(rowNum);
}

function _findJobPriorityRowByJobId(jobId) {
  var id = _stringifyField(jobId).trim();
  if (!id) return null;
  var sheet = _getJobPrioritySheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < JOB_PRIORITY_DATA_START_ROW) return null;
  var rowCount = lastRow - JOB_PRIORITY_DATA_START_ROW + 1;
  // First pass: exact match on canonical job_id
  var primaryIds = sheet.getRange(JOB_PRIORITY_DATA_START_ROW, JOB_PRIORITY_COLUMN_INDEX.job_id, rowCount, 1).getValues();
  for (var i = 0; i < primaryIds.length; i++) {
    if (_stringifyField(primaryIds[i][0]).trim() === id) return JOB_PRIORITY_DATA_START_ROW + i;
  }
  // Second pass: check merged_job_ids in case the ID was retired during a merge
  var mergedIds = sheet.getRange(JOB_PRIORITY_DATA_START_ROW, JOB_PRIORITY_COLUMN_INDEX.merged_job_ids, rowCount, 1).getValues();
  for (var j = 0; j < mergedIds.length; j++) {
    var parts = _stringifyField(mergedIds[j][0]).split(',');
    for (var k = 0; k < parts.length; k++) {
      if (parts[k].trim() === id) return JOB_PRIORITY_DATA_START_ROW + j;
    }
  }
  return null;
}

function _protectSheetsForAssignee(spreadsheet) {
  var sheetsToProtect = [JOB_PRIORITY_SHEET_NAME, SETTINGS_SHEET_NAME, HELP_SHEET_NAME, RAW_DATA_SHEET_NAME, APIFY_ACCOUNTS_SHEET_NAME];

  sheetsToProtect.forEach(function(name) {
    var sheet = spreadsheet.getSheetByName(name);
    if (!sheet) return;
    var existing = sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET);
    existing.forEach(function(p) { p.remove(); });
    var protection = sheet.protect().setDescription('Owner only');
    protection.removeEditors(protection.getEditors());
    // Spreadsheet owner always retains edit access regardless of protection — no need to add explicitly
  });
}
