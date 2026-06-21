var CRITICAL_FAILURE_RATIO = 0.5;
var CRITICAL_FAILURE_MIN_COUNT = 5;
var ACTIVE_RUN_STATE_PROPERTY_KEY = 'ACTIVE_JOB_IMPORT_RUN_STATE';
var RESUME_TRIGGER_HANDLER = 'resumeJobImportAndScoring';
var APIFY_ROTATION_RETRY_HANDLER = 'runApifyRotationRetry';
var BACKUP_RESUME_TRIGGER_DELAY_MS = 7 * 60 * 1000;

/**
 * Standardized status-board progress tracker.
 * Holds a progressState object and exposes:
 *   tracker.update(patch)   — merges patch into state and writes to status board immediately
 *   tracker.callback        — drop-in progressCallback for pipeline calls (same as update)
 *   tracker.get()           — returns current state (pass to notification helpers, etc.)
 *
 * Usage:
 *   var tracker = _createProgressTracker({ lastRun: new Date(), status: 'Starting' });
 *   importAndScoreJobs(config, existingIndex, tracker.callback);
 *   tracker.update({ status: 'Writing sheet', processed: '5 / 10', ... });
 */
function _createProgressTracker(initialState) {
  var state = {
    lastRun: new Date(),
    status: '',
    processed: '',
    scrapedCount: '',
    uniqueRolesCount: '',
    toScoreCount: '',
    newJobsCount: '',
    aJobsCount: '',
    failedJobsCount: '',
    scoredJobsCount: '',
    errorMessage: ''
  };
  var keys = Object.keys(initialState || {});
  for (var i = 0; i < keys.length; i++) {
    if (initialState[keys[i]] !== undefined) state[keys[i]] = initialState[keys[i]];
  }

  function update(patch) {
    var patchKeys = Object.keys(patch || {});
    for (var j = 0; j < patchKeys.length; j++) {
      if (patchKeys[j] === 'rows') continue; // rows go to writeJobs, not the status board state
      if (patch[patchKeys[j]] !== undefined) state[patchKeys[j]] = patch[patchKeys[j]];
    }
    updateRunSummary(state);
    if (patch && patch.rows && patch.rows.length) {
      writeJobs(patch.rows); // stream each batch's results to the sheet as they arrive
    }
  }

  function get() { return state; }

  return { update: update, get: get, callback: update };
}

function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('Jobs Pipeline')
    .addItem('Run Now', 'runJobImportAndScoringNow')
    .addItem('Cancel Run', 'cancelRunPrompt')
    .addSeparator()
    .addItem('Assign Selected Rows', 'assignSelectedRowsPrompt')
    .addItem('Reassign by Rules', 'reassignJobsPrompt')
    .addSeparator()
    .addSubMenu(ui.createMenu('Scoring')
      .addItem('Reevaluate Selected Rows', 'reevaluateSelectedRows')
      .addItem('Rerun Raw Data', 'rerunAllFromRawData'))
    .addSubMenu(ui.createMenu('Apify Tools')
      .addItem('Import Run ID...', 'importApifyRunByIdPrompt')
      .addItem('Import Dataset ID...', 'importApifyDatasetByIdPrompt')
      .addItem('Import Last N Runs...', 'importLastNActorRunsPrompt'))
    .addSubMenu(ui.createMenu('Triggers')
      .addItem('Create Run Trigger', 'createRunTrigger')
      .addItem('Remove Run Triggers', 'removeHourlyTriggers'))
    .addItem('Sort & Rank Sheets', 'sortBothSheetsNow')
    .addSubMenu(ui.createMenu('Maintenance')
      .addItem('Prune Old Data...', 'pruneOldDataPrompt')
      .addItem('Initialize Sheets', 'setupJobPriorityWorkbook')
      .addItem('Restore Job Links', 'restoreJobLinks')
      .addItem('Validate Config', 'validateConfiguration'))
    .addToUi();
}

function onInstall() {
  onOpen();
}

function sortBothSheetsNow() {
  ensureWorkbookReadyForRuntime();
  sortAndRankJobs();
  var assignedSheet = _getAssignedSheet();
  if (assignedSheet) _sortAssignedSheet(assignedSheet);
  SpreadsheetApp.getUi().alert('Sort & Rank complete.');
}

function onEdit(e) {
  if (!e || !e.range) return;

  var sheet = e.range.getSheet();
  var sheetName = sheet.getName();
  var row = e.range.getRow();
  var col = e.range.getColumn();

  if (sheetName === JOB_PRIORITY_SHEET_NAME) {
    if (row < JOB_PRIORITY_DATA_START_ROW) return;
    try {
      if (col === JOB_PRIORITY_COLUMN_INDEX.owner) {
        _handleJobPriorityOwnerEdit(sheet, row, e.value, e.oldValue);
      } else if (col === JOB_PRIORITY_COLUMN_INDEX.status) {
        _handleJobPriorityStatusEdit(sheet, row, e.value, e.oldValue);
      } else if (col === JOB_PRIORITY_COLUMN_INDEX.action) {
        _handleJobPriorityActionEdit(sheet, row);
      }
    } catch (err) { Logger.log(err); }
  } else if (sheetName === ASSIGNED_SHEET_NAME) {
    if (row < ASSIGNED_DATA_START_ROW || col !== ASSIGNED_COLUMN_INDEX.status) return;
    try { _handleAssignedStatusEdit(sheet, row, e.value); } catch (err) { Logger.log(err); }
  }
}

function _jobRecordFromJobPriorityRow(sheet, row) {
  var values = sheet.getRange(row, 1, 1, JOB_PRIORITY_COLUMNS.length).getValues()[0];
  var formulas = sheet.getRange(row, 1, 1, JOB_PRIORITY_COLUMNS.length).getFormulas()[0];
  return _sheetRowToJobRecord(values, formulas, row, {});
}

// Owner column edited on Job_Priority: create or remove the assignee's mirror row.
function _handleJobPriorityOwnerEdit(sheet, row, newValue, oldValue) {
  var nv = _stringifyField(newValue);
  if (nv === 'Assignee') {
    var job = _jobRecordFromJobPriorityRow(sheet, row);
    if (job) _pushJobsToAssignedSheet([job]); // resets to New, applies action default, re-sorts queue
  } else if (_stringifyField(oldValue) === 'Assignee') {
    var jobId = _stringifyField(sheet.getRange(row, JOB_PRIORITY_COLUMN_INDEX.job_id).getValue());
    var assignedSheet = _getAssignedSheet();
    if (assignedSheet && jobId) _removeFromAssignedSheet(assignedSheet, jobId);
  }
}

// Status column edited on Job_Priority: mirror down to her row when she owns it.
// Special case: Skip = owner decided this job is dead — remove from Assigned unconditionally.
function _handleJobPriorityStatusEdit(sheet, row, newValue, oldValue) {
  var nv = _stringifyField(newValue);
  var jobId = _stringifyField(sheet.getRange(row, JOB_PRIORITY_COLUMN_INDEX.job_id).getValue());
  var assignedSheet = _getAssignedSheet();
  if (!assignedSheet || !jobId) return;

  if (nv === 'Skip') {
    _removeFromAssignedSheet(assignedSheet, jobId);
    return;
  }

  var owner = _stringifyField(sheet.getRange(row, JOB_PRIORITY_COLUMN_INDEX.owner).getValue());
  if (owner !== 'Assignee') return;
  var arow = _getAssignedJobIdIndex(assignedSheet)[jobId];
  if (arow && ASSIGNED_STATUS_OPTIONS.indexOf(nv) !== -1) {
    assignedSheet.getRange(arow, ASSIGNED_COLUMN_INDEX.status).setValue(nv);
  }
}

// Action column edited on Job_Priority: mirror down to her row.
function _handleJobPriorityActionEdit(sheet, row) {
  var jobId = _stringifyField(sheet.getRange(row, JOB_PRIORITY_COLUMN_INDEX.job_id).getValue());
  var action = _stringifyField(sheet.getRange(row, JOB_PRIORITY_COLUMN_INDEX.action).getValue());
  var assignedSheet = _getAssignedSheet();
  if (!assignedSheet || !jobId) return;
  var arow = _getAssignedJobIdIndex(assignedSheet)[jobId];
  if (arow) assignedSheet.getRange(arow, ASSIGNED_COLUMN_INDEX.action).setValue(action);
}

// Status edited on the Assigned sheet: mirror up, handle bounce-backs and terminal cleanup.
function _handleAssignedStatusEdit(sheet, row, newValue) {
  var jobId = _stringifyField(sheet.getRange(row, ASSIGNED_COLUMN_INDEX.job_id).getValue()).trim();
  if (!jobId) return;

  var nv = _stringifyField(newValue);
  var jpRow = _findJobPriorityRowByJobId(jobId);
  var jobSheet = _getJobPrioritySheet();
  var now = _formatNow();
  var action = _stringifyField(sheet.getRange(row, ASSIGNED_COLUMN_INDEX.action).getValue());

  sheet.getRange(row, ASSIGNED_COLUMN_INDEX.updated_at).setValue(now);

  if (nv === 'Submitted') {
    if (jpRow) jobSheet.getRange(jpRow, JOB_PRIORITY_COLUMN_INDEX.status).setValue('Submitted');
    sheet.getRange(row, ASSIGNED_COLUMN_INDEX.applied_at).setValue(now);
  } else if (nv === 'Filled') {
    if (action === 'Fill Only') {
      // Bounce back to you to submit.
      if (jpRow) {
        jobSheet.getRange(jpRow, JOB_PRIORITY_COLUMN_INDEX.status).setValue('Filled');
        jobSheet.getRange(jpRow, JOB_PRIORITY_COLUMN_INDEX.owner).setValue('Me');
        jobSheet.getRange(jpRow, JOB_PRIORITY_COLUMN_INDEX.status).setNote('↩ Filled by assignee — ready for you to submit');
      }
      _notifyOwnerBounceBack(jobId, 'filled and ready for you to submit', '');
    } else if (jpRow) {
      jobSheet.getRange(jpRow, JOB_PRIORITY_COLUMN_INDEX.status).setValue('Filled');
    }
  } else if (nv === 'Flagged') {
    var note = _stringifyField(sheet.getRange(row, ASSIGNED_COLUMN_INDEX.notes).getValue());
    if (jpRow) {
      jobSheet.getRange(jpRow, JOB_PRIORITY_COLUMN_INDEX.status).setValue('Flagged');
      jobSheet.getRange(jpRow, JOB_PRIORITY_COLUMN_INDEX.owner).setValue('Me');
      if (note) jobSheet.getRange(jpRow, JOB_PRIORITY_COLUMN_INDEX.referral_contact).setValue('⚑ ' + note);
    }
    _notifyOwnerBounceBack(jobId, 'flagged for your review', note);
  } else if (nv === 'New') {
    if (jpRow) jobSheet.getRange(jpRow, JOB_PRIORITY_COLUMN_INDEX.status).setValue('New');
  }
}

// Called by the time-based trigger — respects quiet hours.
function runJobImportAndScoring() {
  var activeRunState = _loadActiveRunState();

  if (activeRunState && activeRunState.mode === 'reevaluate') {
    return _runJobReevaluationInternal();
  }

  // Only enforce quiet hours when starting a fresh run, not when continuing one
  if (!activeRunState) {
    var settings = getSettingsMap();
    var quietStart = _parseHourSetting(settings.QUIET_START_HOUR, 19);
    var quietEnd = _parseHourSetting(settings.QUIET_END_HOUR, 5);
    if (_isInQuietHours(quietStart, quietEnd)) {
      Logger.log('Skipping run: quiet hours active (' + quietStart + ':00 – ' + quietEnd + ':00 PT).');
      updateRunSummary({ status: 'Skipped (quiet hours ' + quietStart + ':00–' + quietEnd + ':00)' });
      return;
    }
  }

  return _runJobImportAndScoringInternal();
}

// Called by "Run Now" menu — bypasses quiet hours so the user always gets an immediate run.
function runJobImportAndScoringNow() {
  updateRunSummary({ status: 'Starting...' });
  var activeRunState = _loadActiveRunState();
  if (activeRunState && activeRunState.mode === 'reevaluate') {
    return _runJobReevaluationInternal();
  }
  return _runJobImportAndScoringInternal();
}

function resumeJobImportAndScoring() {
  var activeRunState = _loadActiveRunState();
  if (!activeRunState) return; // Nothing to resume — don't start fresh
  if (activeRunState.mode === 'reevaluate') {
    return _runJobReevaluationInternal();
  }
  return _runJobImportAndScoringInternal();
}

// Fired by _scheduleApifyRotationRetry after account rotation. Bypasses quiet hours
// (this is a continuation of a run that already started, not a fresh scheduled check).
function runApifyRotationRetry() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === APIFY_ROTATION_RETRY_HANDLER) ScriptApp.deleteTrigger(t);
  });
  updateRunSummary({ status: 'Retrying with rotated Apify account...' });
  _runJobImportAndScoringInternal();
}

function pruneOldDataPrompt() {
  var ui = SpreadsheetApp.getUi();
  var response = ui.prompt('Prune Old Data', 'Delete rows older than how many days from Job_Priority, Raw_Data, and Assigned?\n(Leave blank for 90)', ui.ButtonSet.OK_CANCEL);

  if (response.getSelectedButton() !== ui.Button.OK) return;

  var input = String(response.getResponseText() || '').trim();
  var days = input === '' ? 90 : parseInt(input, 10);

  if (isNaN(days) || days <= 0) {
    ui.alert('Invalid input. Please enter a positive number of days.');
    return;
  }

  var jpDeleted = pruneExpiredJobRows(days);
  var rawDeleted = pruneRawData(days);
  var assignedDeleted = pruneAssignedRows(days);

  ui.alert(
    'Deleted ' + (jpDeleted.prunedCount || 0) + ' from Job_Priority, ' +
    rawDeleted + ' from Raw_Data, ' +
    assignedDeleted + ' from Assigned.\n(Submitted rows in Job_Priority and active/flagged rows in Assigned are never pruned.)'
  );
}

function importApifyRunByIdPrompt() {
  var ui = SpreadsheetApp.getUi();
  var response = ui.prompt('Import Apify Run ID', 'Enter the Apify run ID to import and score without scraping again.', ui.ButtonSet.OK_CANCEL);

  if (response.getSelectedButton() !== ui.Button.OK) {
    return;
  }

  var runId = String(response.getResponseText() || '').trim();
  if (!runId) {
    ui.alert('Run ID is required.');
    return;
  }

  _runJobImportAndScoringInternal(_buildActiveRunStateFromApifyRunId(runId, false));
}

function resurrectApifyRunByIdPrompt() {
  var ui = SpreadsheetApp.getUi();
  var response = ui.prompt('Retry Apify Run ID', 'Enter the finished Apify run ID to retry in Apify, wait for completion, then import and score it.', ui.ButtonSet.OK_CANCEL);

  if (response.getSelectedButton() !== ui.Button.OK) {
    return;
  }

  var runId = String(response.getResponseText() || '').trim();
  if (!runId) {
    ui.alert('Run ID is required.');
    return;
  }

  _runJobImportAndScoringInternal(_buildActiveRunStateFromApifyRunId(runId, true));
}

/**
 * Single pipeline execution engine used by every run entry point.
 *
 * options:
 *   pipelineFn      — importAndScoreJobs or reevaluateExistingJobs
 *   initialStatus   — first status string shown on the status board
 *   requireApify    — boolean; pass true for import runs
 *   validateMode    — if set, throws when activeRunState.mode !== this value
 *   postProcess     — boolean; run prune + dedup after completion (import only)
 *   notify          — boolean; send completion/failure emails (import only)
 *   initialTrackerExtra — extra fields merged into the opening tracker state
 */

// Patches existingIndex records whose rawRef was not populated by the cross-sheet lookup
// (can happen when the job_id column in Job Priority has date-corrupted values). Reads
// Raw_Data directly and fills in rawRef + jobDescription for any record that's missing them.
function _patchIndexWithRawData(existingIndex) {
  var rawDataIndex = getRawDataIndex();
  var records = existingIndex.records || [];
  records.forEach(function(r) {
    if (_stringifyField(r.rawRef)) return;
    var jobId = _extractLinkedInJobId(_stringifyField(r.jobId));
    if (!jobId) return;
    var rawData = rawDataIndex.byJobId[jobId];
    if (!rawData || !rawData.rawRef) return;
    r.rawRef = rawData.rawRef;
    r.jobDescription = r.jobDescription || _extractJobDescriptionFromRawRef(rawData.rawRef);
    if (existingIndex.byJobId[jobId]) {
      existingIndex.byJobId[jobId].rawRef = r.rawRef;
      existingIndex.byJobId[jobId].jobDescription = existingIndex.byJobId[jobId].jobDescription || r.jobDescription;
    }
  });
}

function _runPipelineInternal(activeRunState, options) {
  var lock = LockService.getScriptLock();
  var executionStartedAt = new Date();
  var scoringRunStartedAt = activeRunState && activeRunState.runStartedAt
    ? new Date(activeRunState.runStartedAt) : executionStartedAt;
  var config = null;
  var resumedAfterUnexpectedStop = false;

  var initialTrackerState = { lastRun: executionStartedAt, status: options.initialStatus || 'Running' };
  var extra = options.initialTrackerExtra || {};
  var extraKeys = Object.keys(extra);
  for (var k = 0; k < extraKeys.length; k++) initialTrackerState[extraKeys[k]] = extra[extraKeys[k]];
  var tracker = _createProgressTracker(initialTrackerState);
  tracker.update({}); // Write initial status immediately — before lock wait or any API calls

  lock.waitLock(30000);

  try {
    // Only clear a stale cancel flag on a genuinely fresh start.
    // Resumed executions (resume trigger fired mid-run) must NOT clear it —
    // the user may have clicked Cancel while the previous slice was running.
    var isFreshStart = !PropertiesService.getScriptProperties().getProperty(ACTIVE_RUN_STATE_PROPERTY_KEY);
    if (isFreshStart) _clearCancelRequest();
    ensureWorkbookReadyForRuntime();

    // Clear any stale saved state only when a fresh initialActiveRunState was explicitly passed
    if (options._hadInitialState) {
      _clearActiveRunState();
      _removeResumeTriggers();
    }

    if (options.validateMode && (!activeRunState || activeRunState.mode !== options.validateMode)) {
      throw new Error('No active ' + options.validateMode + ' state was found.');
    }

    config = loadRuntimeConfig();
    config.runStartedAt = scoringRunStartedAt;
    config.activeRunState = activeRunState;
    if (activeRunState && activeRunState.forceRescore) config.forceRescore = true;
    resumedAfterUnexpectedStop = _markTrackedExecutionStarted(activeRunState, executionStartedAt);
    _scheduleResumeTrigger(BACKUP_RESUME_TRIGGER_DELAY_MS);

    validateRuntimeConfig(config, options.requireApify ? undefined : { requireApify: false });
    tracker.update({});

    if (resumedAfterUnexpectedStop) {
      tracker.update({ errorMessage: 'Previous execution stopped unexpectedly, likely due to an Apps Script timeout. Resuming from saved progress.' });
    }

    var existingIndex = getExistingJobIndex();
    // For reevaluation runs, patch any records whose rawRef was not populated by the
    // cross-sheet lookup (e.g. date-corrupted job_id column in Job Priority sheet).
    if (!options.requireApify) {
      _patchIndexWithRawData(existingIndex);
    }
    var result = options.pipelineFn(config, existingIndex, tracker.callback);

    tracker.update({
      status: 'Writing sheet',
      processed: result.processedCount + ' / ' + result.totalJobsCount,
      scrapedCount: result.rawScrapedCount,
      uniqueRolesCount: result.uniqueRolesCount,
      toScoreCount: result.totalScoreableCount,
      newJobsCount: result.newJobsCount,
      aJobsCount: result.aJobsCount,
      failedJobsCount: result.failedJobsCount,
      scoredJobsCount: result.scoredJobsCount
    });

    writeJobs(result.rows);

    if (result.hasMore) {
      _markTrackedExecutionFinished(result.activeRunState, 'yielded');
      _saveActiveRunState(result.activeRunState);
      _scheduleResumeTrigger();
      // Skip sortAndRankJobs here — it holds the lock for 30-90s, which causes the 1-min
      // resume trigger to fail its lock wait (chain relies on backup trigger instead, adding
      // 1+ min of idle time per cycle). Sort happens on final completion only.

      tracker.update({
        status: 'Continuing in next execution',
        processed: result.processedCount + ' / ' + result.totalJobsCount,
        scrapedCount: result.rawScrapedCount,
        uniqueRolesCount: result.uniqueRolesCount,
        toScoreCount: result.totalScoreableCount,
        newJobsCount: result.newJobsCount,
        aJobsCount: result.aJobsCount,
        failedJobsCount: result.failedJobsCount,
        scoredJobsCount: result.scoredJobsCount,
        errorMessage: result.errors.length
          ? _truncate(result.errors.join(' | '), 500)
          : 'Continuation scheduled automatically before the Apps Script execution limit.'
      });

      return result;
    }

    try {
      tracker.update({ status: 'Deduplicating similar JDs' });
      deduplicateSimilarJdRows();
    } catch (dedupError) {
      Logger.log(dedupError);
    }

    sortAndRankJobs();

    _markTrackedExecutionFinished(result.activeRunState, 'completed');
    _clearActiveRunState();
    _removeResumeTriggers();

    if (options.postProcess) {
      try {
        tracker.update({ status: 'Auto-assigning jobs' });
        _routeNewJobs(config);
      } catch (assignError) { Logger.log('Auto-assign error: ' + assignError); }

      result.newAJobs = _getJobsByJobIds(result.newTopPriorityJobIds || []);
    }

    tracker.update({
      status: 'Completed',
      processed: result.processedCount + ' / ' + result.totalJobsCount,
      scrapedCount: result.rawScrapedCount,
      uniqueRolesCount: result.uniqueRolesCount,
      toScoreCount: result.totalScoreableCount,
      newJobsCount: result.newJobsCount,
      aJobsCount: result.aJobsCount,
      failedJobsCount: result.failedJobsCount,
      scoredJobsCount: result.scoredJobsCount,
      errorMessage: result.errors.length ? _truncate(result.errors.join(' | '), 500) : ''
    });

    if (options.notify) {
      _sendCompletionNotifications(config, result, tracker.get());
    }

    return result;
  } catch (error) {
    var errorMsg = error && error.message ? error.message : String(error);
    // Do NOT wipe saved state on timeout — the backup trigger needs it to resume.
    var isTimeout = errorMsg.indexOf('Exceeded maximum execution time') !== -1 ||
                    errorMsg.indexOf('Script execution time') !== -1;
    if (!isTimeout) {
      _clearActiveRunState();
      _removeResumeTriggers();
      if (options.notify) {
        _sendWholeRunFailureNotification(config, tracker.get(), error);
      }
    }
    tracker.update({
      status: isTimeout ? 'Continuing in next execution' : 'Failed',
      errorMessage: _truncate(errorMsg, 500)
    });
    throw error;
  } finally {
    if (lock.hasLock()) {
      lock.releaseLock();
    }
  }
}

function _runJobImportAndScoringInternal(initialActiveRunState) {
  var executionStartedAt = new Date();
  var activeRunState = initialActiveRunState || _loadActiveRunState() || _createEmptyImportRunState(executionStartedAt);
  return _runPipelineInternal(activeRunState, {
    pipelineFn: importAndScoreJobs,
    initialStatus: 'Starting Apify task',
    requireApify: true,
    postProcess: true,
    notify: true,
    _hadInitialState: !!initialActiveRunState
  });
}

function _runJobReevaluationInternal(initialActiveRunState) {
  var activeRunState = initialActiveRunState || _loadActiveRunState();
  return _runPipelineInternal(activeRunState, {
    pipelineFn: reevaluateExistingJobs,
    initialStatus: 'Reevaluating jobs',
    requireApify: false,
    validateMode: 'reevaluate',
    postProcess: false,
    notify: false,
    _hadInitialState: !!initialActiveRunState,
    initialTrackerExtra: {
      uniqueRolesCount: activeRunState && activeRunState.totalJobsCount ? activeRunState.totalJobsCount : '',
      toScoreCount: activeRunState && activeRunState.totalScoreableCount ? activeRunState.totalScoreableCount : '',
      aJobsCount: activeRunState && activeRunState.aJobsCount ? activeRunState.aJobsCount : ''
    }
  });
}

function createRunTrigger() {
  removeHourlyTriggers();
  var settings = getSettingsMap();
  var intervalHours = _normalizePositiveInteger(settings.RUN_INTERVAL_HOURS || 4, 4, 12);
  ScriptApp.newTrigger('runJobImportAndScoring')
    .timeBased()
    .everyHours(intervalHours)
    .create();
}

function createHourlyTrigger() {
  createRunTrigger();
}

function removeHourlyTriggers() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    var fn = trigger.getHandlerFunction();
    if (fn === 'runJobImportAndScoring' || fn === RESUME_TRIGGER_HANDLER || fn === APIFY_ROTATION_RETRY_HANDLER) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function validateConfiguration() {
  ensureWorkbookReadyForRuntime();

  var config = loadRuntimeConfig();
  validateRuntimeConfig(config);

  SpreadsheetApp.getUi().alert(
    'Config looks valid.\n' +
    'Provider: Gemini\n' +
    'Route: ' + config.geminiApiRoute + '\n' +
    'Vertex project: ' + (config.geminiApiRoute === 'vertex' ? config.vertexProjectId : '(not used)') + '\n' +
    'Model: ' + config.scoringModel + '\n' +
    'Parallel AI requests: ' + config.scoringParallelRequests + '\n' +
    'Notify email: ' + (config.notifyEmail || '(disabled)') + '\n' +
    'Apify accounts: ' + config.apifyAccounts.length + '\n' +
    'Apify wait seconds: ' + config.apifyRunWaitSeconds
  );
}

function pruneExpiredJobs() {
  ensureWorkbookReadyForRuntime();

  var result = pruneExpiredJobRows();
  var message = result.prunedCount
    ? (
      'Expired job pruning completed.\n' +
      'Jobs checked: ' + result.checkedCount + '\n' +
      'Jobs archived and removed: ' + result.prunedCount + '\n' +
      'Remaining jobs: ' + result.remainingCount + '\n' +
      '\nApplied jobs are never pruned regardless of age.'
    )
    : 'No expired jobs found (threshold: 45 days). Applied jobs are always kept.';

  SpreadsheetApp.getUi().alert(message);
}

function deduplicateSimilarJds() {
  ensureWorkbookReadyForRuntime();

  var result = deduplicateSimilarJdRows();
  sortAndRankJobs();
  var message = result.removedRowCount
    ? (
      'Similar-JD deduplication completed.\n' +
      'Duplicate groups merged: ' + result.duplicateGroupCount + '\n' +
      'Rows archived: ' + result.archivedRowCount + '\n' +
      'Rows removed: ' + result.removedRowCount + '\n' +
      'Remaining job rows: ' + result.finalRowCount
    )
    : 'No similar-JD duplicates were found.';

  SpreadsheetApp.getUi().alert(message);
}

function deduplicateExistingJobs() {
  ensureWorkbookReadyForRuntime();

  var result = deduplicateExistingJobRows();
  sortAndRankJobs();
  var message = result.removedRowCount
    ? (
      'Deduplication completed.\n' +
      'Duplicate groups merged: ' + result.duplicateGroupCount + '\n' +
      'Rows archived: ' + result.archivedRowCount + '\n' +
      'Rows removed: ' + result.removedRowCount + '\n' +
      'Remaining job rows: ' + result.finalRowCount
    )
    : 'No duplicate job IDs were found.';

  SpreadsheetApp.getUi().alert(message);
}

function reevaluateActiveBacklog() {
  ensureWorkbookReadyForRuntime();

  var config = loadRuntimeConfig();
  validateRuntimeConfig(config, { requireApify: false });
  var existingIndex = getExistingJobIndex();
  var activeRecords = existingIndex.records.filter(function(record) {
    return _isReevaluationEligibleStatus(record.status);
  });
  var activeRunState = _buildReevaluationStateFromRecords(activeRecords, config, 'active backlog');

  if (!activeRunState.targetJobIds.length) {
    SpreadsheetApp.getUi().alert('No eligible backlog rows were found. Reevaluation only targets New and Assigned rows.');
    return;
  }

  if (!Number(activeRunState.totalScoreableCount || 0)) {
    SpreadsheetApp.getUi().alert('No active backlog rows need reevaluation. They either already match the current scoring fingerprint or have no job description in Raw_Data (re-import first).');
    return;
  }

  _runJobReevaluationInternal(activeRunState);
}

function reevaluateSelectedRows() {
  ensureWorkbookReadyForRuntime();

  var ui = SpreadsheetApp.getUi();
  var jobSheet = _getJobPrioritySheet();
  var range = jobSheet && jobSheet.getActiveRange();

  if (!range) {
    ui.alert('Select one or more job rows first.');
    return;
  }

  // Collect job IDs from selected data rows
  var jobIdCol   = JOB_PRIORITY_COLUMN_INDEX.job_id;
  var statusCol  = JOB_PRIORITY_COLUMN_INDEX.status;
  var jobLinkCol = JOB_PRIORITY_COLUMN_INDEX.job_link;
  var selectedJobIds = {};

  for (var r = range.getRow(); r < range.getRow() + range.getNumRows(); r++) {
    if (r < JOB_PRIORITY_DATA_START_ROW) continue;
    var rowValues   = jobSheet.getRange(r, 1, 1, JOB_PRIORITY_COLUMNS.length).getValues()[0];
    var rowFormulas = jobSheet.getRange(r, 1, 1, JOB_PRIORITY_COLUMNS.length).getFormulas()[0];
    var status = _stringifyField(rowValues[statusCol - 1]);
    if (!_isReevaluationEligibleStatus(status)) continue;

    var rawJobId    = _stringifyField(rowValues[jobIdCol - 1]);
    var linkFormula = _stringifyField(rowFormulas[jobLinkCol - 1]);
    var linkUrl     = linkFormula.match(/=HYPERLINK\("([^"]+)"/i);
    var jobId = _extractLinkedInJobId(rawJobId) ||
                _extractLinkedInJobId(linkUrl ? linkUrl[1] : '');
    if (jobId) selectedJobIds[jobId] = true;
  }

  if (!Object.keys(selectedJobIds).length) {
    ui.alert('No eligible rows selected. Applied and Skip rows are ignored.');
    return;
  }

  // Filter existing records to selected job IDs and route through standard pipeline
  var config = loadRuntimeConfig();
  validateRuntimeConfig(config, { requireApify: false });
  var existingIndex = getExistingJobIndex();
  var selectedRecords = existingIndex.records.filter(function(r) {
    return selectedJobIds[_extractLinkedInJobId(_stringifyField(r.jobId)) || _stringifyField(r.jobId)];
  });
  var activeRunState = _buildReevaluationStateFromRecords(selectedRecords, config, 'selected rows');
  activeRunState.forceRescore = true;

  if (!activeRunState.targetJobIds.length) {
    ui.alert('No eligible rows selected. Applied and Skip rows are ignored.');
    return;
  }

  if (!Number(activeRunState.totalScoreableCount || 0)) {
    ui.alert('Selected rows have no job descriptions in Raw_Data. Run "Run Now" or "Import Apify Run ID" first to populate Raw_Data.');
    return;
  }

  _runJobReevaluationInternal(activeRunState);
}

function repairJobLinksFromRawRef() {
  ensureWorkbookReadyForRuntime();

  var result = repairJobLinksFromRawRefRows();
  var message = [
    'Job-link repair completed.',
    'Rows checked: ' + result.checkedCount,
    'Rows updated: ' + result.updatedCount,
    'Job IDs recovered: ' + result.recoveredJobIdCount,
    'Missing raw_ref: ' + result.missingRawRefCount,
    'Missing job ID in raw_ref: ' + result.missingJobIdCount
  ];

  if (result.sampleErrors && result.sampleErrors.length) {
    message.push('');
    message.push('Examples:');
    message.push(result.sampleErrors.join('\n'));
  }

  SpreadsheetApp.getUi().alert(message.join('\n'));
}


function rerunAllFromRawData() {
  ensureWorkbookReadyForRuntime();

  var ui = SpreadsheetApp.getUi();
  var config = loadRuntimeConfig();
  validateRuntimeConfig(config, { requireApify: false });

  // Read Raw_Data directly — the cross-sheet lookup in getExistingJobIndex may miss rawRef
  // when the job_id column in Job Priority has date-corrupted values.
  var rawDataIndex = getRawDataIndex();
  var allRecords = getExistingJobIndex().records;

  // Patch any records whose rawRef was not populated by the cross-sheet lookup.
  allRecords.forEach(function(r) {
    if (_stringifyField(r.rawRef)) return;
    var jobId = _extractLinkedInJobId(_stringifyField(r.jobId));
    if (!jobId) return;
    var rawData = rawDataIndex.byJobId[jobId];
    if (rawData && rawData.rawRef) {
      r.rawRef = rawData.rawRef;
      r.jobDescription = _extractJobDescriptionFromRawRef(rawData.rawRef);
    }
  });

  // Dedup by job ID — keep only the most recent record per job ID
  var grouped = _groupJobRecordsByJobId(allRecords);
  var deduped = Object.keys(grouped).map(function(jobId) {
    var group = grouped[jobId];
    return group.length === 1 ? group[0] : _mergeDuplicateJobRecordsByJobId(group);
  });

  var scoreable = deduped.filter(function(r) {
    if (!_extractLinkedInJobId(_stringifyField(r.jobId))) return false;
    return _stringifyField(r.jobDescription) || _extractJobDescriptionFromRawRef(_stringifyField(r.rawRef));
  });

  if (!scoreable.length) {
    ui.alert('No scoreable records found. Raw_Data may be empty — run "Import Apify Run ID" or "Run Now" first to populate it.');
    return;
  }

  var response = ui.alert(
    'Rerun Raw Data',
    scoreable.length + ' records will be force-rescored using Gemini. Continue?',
    ui.ButtonSet.OK_CANCEL
  );
  if (response !== ui.Button.OK) return;

  var activeRunState = _buildReevaluationStateFromRecords(scoreable, config, 'all records');
  activeRunState.forceRescore = true;

  _runJobReevaluationInternal(activeRunState);
}


function _buildReevaluationStateFromRecords(records, config, modeLabel) {
  var seen = {};
  var targetJobIds = [];
  var totalScoreableCount = 0;

  (records || []).forEach(function(record) {
    var jobId = _stringifyField(record.jobId);
    var fingerprint = '';

    if (!jobId || seen[jobId]) {
      return;
    }

    seen[jobId] = true;
    targetJobIds.push(jobId);

    if (!_stringifyField(record.jobDescription)) {
      return;
    }

    fingerprint = _buildScoringFingerprint(record, config);
    if (!_hasScoringPayload(record) || _stringifyField(record.scoringFingerprint) !== fingerprint) {
      totalScoreableCount += 1;
    }
  });

  return {
    mode: 'reevaluate',
    modeLabel: modeLabel || 'reevaluate',
    runStartedAt: new Date().toISOString(),
    targetJobIds: targetJobIds,
    totalJobsCount: targetJobIds.length,
    totalScoreableCount: totalScoreableCount,
    processedCount: 0,
    newJobsCount: 0,
    aJobsCount: 0,
    failedJobsCount: 0,
    scoredJobsCount: 0,
    importFailedJobsCount: 0,
    handledJobIds: [],
    pendingStage2JobIds: [],
    newTopPriorityJobIds: [],
    errors: []
  };
}

function _createEmptyImportRunState(runStartedAt) {
  return {
    version: 1,
    runStartedAt: runStartedAt instanceof Date ? runStartedAt.toISOString() : new Date(runStartedAt || new Date()).toISOString(),
    sources: [],
    rawScrapedCount: 0,
    totalJobsCount: 0,
    totalScoreableCount: 0,
    processedCount: 0,
    newJobsCount: 0,
    aJobsCount: 0,
    failedJobsCount: 0,
    scoredJobsCount: 0,
    importFailedJobsCount: 0,
    handledJobIds: [],
    pendingStage2JobIds: [],
    newTopPriorityJobIds: [],
    errors: []
  };
}

function _markTrackedExecutionStarted(activeRunState, executionStartedAt) {
  var hadUnexpectedStop = false;

  if (!activeRunState) {
    return hadUnexpectedStop;
  }

  hadUnexpectedStop = !!(activeRunState.lastExecutionStartedAt && !activeRunState.lastExecutionFinishedAt);
  activeRunState.lastExecutionStartedAt = executionStartedAt instanceof Date
    ? executionStartedAt.toISOString()
    : new Date(executionStartedAt || new Date()).toISOString();
  activeRunState.lastExecutionFinishedAt = '';
  activeRunState.lastExecutionOutcome = 'running';
  activeRunState.updatedAt = new Date().toISOString();
  _saveActiveRunState(activeRunState);

  return hadUnexpectedStop;
}

function _markTrackedExecutionFinished(activeRunState, outcome) {
  if (!activeRunState) {
    return;
  }

  activeRunState.lastExecutionFinishedAt = new Date().toISOString();
  activeRunState.lastExecutionOutcome = outcome || 'completed';
  activeRunState.updatedAt = new Date().toISOString();
}

function _isReevaluationEligibleStatus(status) {
  var normalized = _stringifyField(status) || 'New';
  return normalized === 'New' || normalized === 'Networking';
}

function _hasScoringPayload(record) {
  return _stringifyField(record.priority) &&
    _stringifyField(record.usVisaReason) &&
    _stringifyField(record.summary) &&
    _stringifyField(record.why) &&
    record.score !== '';
}

function _sendCompletionNotifications(config, result, progressState) {
  if (!config || !config.notifyEmail) {
    return;
  }

  if (_shouldNotifyCriticalFailure(result)) {
    _sendCriticalFailureEmail(config, result, progressState);
    return;
  }

  var newAJobs = result.newAJobs || result.rows.filter(function(job) {
    return !job.existingRowNumber && _isTopPriority(job.priority);
  });

  if (!newAJobs.length) {
    return;
  }

  _sendNewAJobsEmail(config, newAJobs);
}

function _loadActiveRunState() {
  var raw = PropertiesService.getScriptProperties().getProperty(ACTIVE_RUN_STATE_PROPERTY_KEY);
  var state = null;

  if (!raw) {
    return null;
  }

  try {
    state = JSON.parse(raw);
    if (state && state.handledCanonicalKeys && !state.handledJobIds) {
      state.handledJobIds = state.handledCanonicalKeys.slice();
    }
    if (state && state.newAJobCanonicalKeys && !state.newTopPriorityJobIds) {
      state.newTopPriorityJobIds = state.newAJobCanonicalKeys.slice();
    }
    if (state && state.targetCanonicalKeys && !state.targetJobIds) {
      state.targetJobIds = state.targetCanonicalKeys.slice();
    }
    return state;
  } catch (error) {
    Logger.log(error);
    PropertiesService.getScriptProperties().deleteProperty(ACTIVE_RUN_STATE_PROPERTY_KEY);
    return null;
  }
}

function _saveActiveRunState(state) {
  PropertiesService.getScriptProperties().setProperty(
    ACTIVE_RUN_STATE_PROPERTY_KEY,
    JSON.stringify(state)
  );
}

function _clearActiveRunState() {
  PropertiesService.getScriptProperties().deleteProperty(ACTIVE_RUN_STATE_PROPERTY_KEY);
}

function _removeResumeTriggers() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === RESUME_TRIGGER_HANDLER) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function _scheduleResumeTrigger(delayMs) {
  _removeResumeTriggers();
  ScriptApp.newTrigger(RESUME_TRIGGER_HANDLER)
    .timeBased()
    .after(Math.max(1000, Number(delayMs || 1000)))
    .create();
}

function _getJobsByJobIds(jobIds) {
  var wanted = {};
  var jobs = [];

  (jobIds || []).forEach(function(jobId) {
    if (jobId) {
      wanted[String(jobId)] = true;
    }
  });

  getExistingJobRecords().forEach(function(record) {
    if (record.jobId && wanted[record.jobId]) {
      jobs.push(record);
    }
  });

  return jobs.sort(_compareJobsForDisplay);
}

function _findTokenForRunId(runId, config) {
  var accounts = config.apifyAccounts;
  for (var i = 0; i < accounts.length; i++) {
    try {
      var info = _getRunInfo(runId, accounts[i]);
      if (info && info.id) return accounts[i];
    } catch (e) { /* try next */ }
  }
  throw new Error('Run ' + runId + ' not found in any of your ' + accounts.length + ' Apify accounts.');
}

function _buildActiveRunStateFromApifyRunId(runId, shouldResurrect) {
  var config = loadRuntimeConfig();
  validateRuntimeConfig(config);
  var token = _findTokenForRunId(runId, config);
  var runInfo;
  var sourceLabel;

  if (shouldResurrect) {
    runInfo = _resurrectApifyRun(runId, token);
    runInfo = _waitForRunToFinish(runId, 'run ' + runId, token, config);
  } else {
    runInfo = _getRunInfo(runId, token);
    if (runInfo.status && !_isRunStatusSuccess(String(runInfo.status || ''))) {
      if (_isRunStatusFailure(String(runInfo.status || ''))) {
        throw new Error('Run ' + runId + ' ended with status ' + runInfo.status + '. The run cannot be imported in this state.');
      }
      runInfo = _waitForRunToFinish(runId, 'run ' + runId, token, config);
    }
  }

  if (!runInfo.defaultDatasetId) {
    throw new Error('Run ' + runId + ' does not have a default dataset to import.');
  }

  sourceLabel = runInfo.actorTaskId || runInfo.actId || ('run ' + runId);

  return {
    version: 1,
    runStartedAt: runInfo.startedAt || new Date().toISOString(),
    sources: [
      {
        taskId: sourceLabel,
        runId: runId,
        datasetId: runInfo.defaultDatasetId,
        token: token
      }
    ],
    rawScrapedCount: 0,
    totalJobsCount: 0,
    totalScoreableCount: 0,
    processedCount: 0,
    newJobsCount: 0,
    aJobsCount: 0,
    failedJobsCount: 0,
    scoredJobsCount: 0,
    importFailedJobsCount: 0,
    handledJobIds: [],
    pendingStage2JobIds: [],
    newTopPriorityJobIds: [],
    errors: []
  };
}

function _sendWholeRunFailureNotification(config, progressState, error) {
  if (!config || !config.notifyEmail) {
    return;
  }

  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var sheetUrl = spreadsheet ? spreadsheet.getUrl() : '';
  var subject = '[Job Pipeline] Critical failure';
  var body = [
    'The run failed before completion.',
    '',
    'Status: ' + (progressState.status || 'Failed'),
    'Processed: ' + (progressState.processed || ''),
    'Error: ' + _truncate(error && error.message ? error.message : String(error), 500),
    '',
    'Open sheet:',
    sheetUrl
  ].join('\n');

  _sendEmailSafely({
    to: config.notifyEmail,
    subject: subject,
    body: body
  });
}

function _shouldNotifyCriticalFailure(result) {
  var candidateCount = Number(result.totalJobsCount || 0) + Number(result.importFailedJobsCount || 0);
  var failedCount = Number(result.failedJobsCount || 0);

  if (failedCount >= CRITICAL_FAILURE_MIN_COUNT) {
    return true;
  }

  if (!candidateCount) {
    return false;
  }

  return (failedCount / candidateCount) >= CRITICAL_FAILURE_RATIO;
}

function _sendCriticalFailureEmail(config, result, progressState) {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var sheetUrl = spreadsheet ? spreadsheet.getUrl() : '';
  var candidateCount = Number(result.totalJobsCount || 0) + Number(result.importFailedJobsCount || 0);
  var failedCount = Number(result.failedJobsCount || 0);
  var ratioText = candidateCount ? Math.round((failedCount / candidateCount) * 100) + '%' : 'n/a';
  var subject = '[Job Pipeline] Critical failure';
  var body = [
    'The run completed with a critical number of job failures.',
    '',
    'Status: ' + (progressState.status || 'Completed'),
    'Processed: ' + (progressState.processed || ''),
    'Failed jobs: ' + failedCount,
    'Failure ratio: ' + ratioText,
    'New jobs: ' + Number(result.newJobsCount || 0),
    'Scored jobs: ' + Number(result.scoredJobsCount || 0),
    '',
    'Error summary:',
    result.errors.length ? _truncate(result.errors.join(' | '), 1000) : 'No detailed error message captured.',
    '',
    'Open sheet:',
    sheetUrl
  ].join('\n');

  _sendEmailSafely({
    to: config.notifyEmail,
    subject: subject,
    body: body
  });
}

function _sendNewAJobsEmail(config, jobs) {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var sheetUrl = spreadsheet ? spreadsheet.getUrl() : '';
  var subject = _buildAJobsEmailSubject(jobs);
  var lines = [jobs.length + ' new P01-priority job' + (jobs.length === 1 ? '' : 's') + ' found.', ''];

  jobs.forEach(function(job, index) {
    lines.push((index + 1) + '. ' + _emailSafe(job.company) + ' — ' + _emailSafe(job.title));
    lines.push('Score: ' + _emailSafe(job.score) + ' | Visa: ' + _emailSafe(job.usVisaSponsorshipPotential));
    lines.push('What: ' + _emailSafe(job.summary));
    lines.push('Why it fits: ' + _emailSafe(job.why));
    lines.push('Job: ' + _emailSafe(job.jobLink));
    lines.push('');
  });

  lines.push('Open sheet:');
  lines.push(sheetUrl);

  var htmlBody = _buildAJobsHtmlEmail(jobs, sheetUrl);

  _sendEmailSafely({
    to: config.notifyEmail,
    subject: subject,
    body: lines.join('\n'),
    htmlBody: htmlBody
  });
}

function _buildAJobsEmailSubject(jobs) {
  var topJobs = jobs.slice(0, 3).map(function(job) {
    return _emailSafe(job.company) + ' (' + _emailSafe(job.score) + ')';
  }).join(', ');

  return '[Job Pipeline] ' + jobs.length + ' P01 job' + (jobs.length === 1 ? '' : 's') + (topJobs ? ': ' + topJobs : '');
}

function _buildAJobsHtmlEmail(jobs, sheetUrl) {
  var summaryLine = jobs.slice(0, 3).map(function(job) {
    return _escapeHtml(_emailSafe(job.company)) + ' ' + _escapeHtml(_emailSafe(job.score));
  }).join(' · ');

  var cardsHtml = jobs.map(function(job) {
    return [
      '<div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;padding:20px;margin:0 0 16px 0;">',
      '  <div style="margin:0 0 10px 0;">',
      '    <span style="display:inline-block;background:#e8f5e9;color:#166534;font-weight:700;font-size:12px;line-height:1;padding:8px 10px;border-radius:999px;margin-right:8px;">Score ' + _escapeHtml(_emailSafe(job.score)) + '</span>',
      '    <span style="display:inline-block;background:#eef2ff;color:#3730a3;font-weight:600;font-size:12px;line-height:1;padding:8px 10px;border-radius:999px;">Visa: ' + _escapeHtml(_emailSafe(job.usVisaSponsorshipPotential)) + '</span>',
      '  </div>',
      '  <div style="font-size:20px;line-height:1.3;font-weight:700;color:#111827;margin:0 0 4px 0;">' + _escapeHtml(_emailSafe(job.title)) + '</div>',
      '  <div style="font-size:14px;line-height:1.4;color:#6b7280;margin:0 0 16px 0;">' + _escapeHtml(_emailSafe(job.company)) + ' · ' + _escapeHtml(_emailSafe(job.location)) + '</div>',
      '  <div style="font-size:12px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:#6b7280;margin:0 0 6px 0;">What</div>',
      '  <div style="font-size:15px;line-height:1.6;color:#111827;margin:0 0 14px 0;">' + _escapeHtml(_emailSafe(job.summary)) + '</div>',
      '  <div style="font-size:12px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:#6b7280;margin:0 0 6px 0;">Why it fits</div>',
      '  <div style="font-size:15px;line-height:1.6;color:#111827;margin:0 0 18px 0;">' + _escapeHtml(_emailSafe(job.why)) + '</div>',
      '  <a href="' + _escapeHtml(_emailSafe(job.jobLink)) + '" style="display:inline-block;background:#1a73e8;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;line-height:1;padding:12px 16px;border-radius:10px;">Open job</a>',
      '</div>'
    ].join('');
  }).join('');

  return [
    '<!DOCTYPE html>',
    '<html>',
    '<body style="margin:0;padding:24px;background:#f5f7fa;font-family:Arial,Helvetica,sans-serif;color:#111827;">',
    '  <div style="max-width:640px;margin:0 auto;">',
    '    <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;padding:24px;margin:0 0 18px 0;">',
    '      <div style="font-size:26px;line-height:1.2;font-weight:700;color:#111827;margin:0 0 8px 0;">' + jobs.length + ' new P01-priority job' + (jobs.length === 1 ? '' : 's') + '</div>',
    (summaryLine ? '      <div style="font-size:14px;line-height:1.5;color:#6b7280;margin:0 0 16px 0;">Top scores: ' + summaryLine + '</div>' : ''),
    '      <a href="' + _escapeHtml(sheetUrl) + '" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;line-height:1;padding:12px 16px;border-radius:10px;">Open sheet</a>',
    '    </div>',
         cardsHtml,
    '    <div style="text-align:center;font-size:13px;line-height:1.5;color:#6b7280;padding:8px 0 0 0;">',
    '      <a href="' + _escapeHtml(sheetUrl) + '" style="color:#1a73e8;text-decoration:none;font-weight:700;">Open sheet</a>',
    '    </div>',
    '  </div>',
    '</body>',
    '</html>'
  ].join('');
}

function _emailSafe(value) {
  return value === null || value === undefined || value === '' ? '-' : String(value);
}

function _escapeHtml(value) {
  return _emailSafe(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _sendEmailSafely(message) {
  try {
    MailApp.sendEmail(message);
  } catch (error) {
    Logger.log(error);
  }
}

// Emailed during a pipeline run (authorized context) when new jobs land in the assignee's queue.
function _notifyAssigneeOfNewJobs(config, count) {
  if (!config || !config.notifyAssigneeEmail || !count) return;
  _sendEmailSafely({
    to: config.notifyAssigneeEmail,
    subject: count + ' new job(s) in your queue',
    body: count + ' new job(s) have been assigned to you in the Assigned sheet. Please review and apply.'
  });
}

// Best-effort owner alert on a bounce-back. Called from onEdit (a simple trigger), so MailApp may be
// unauthorized and silently fail — the in-sheet cell note added by the caller is the reliable signal.
function _notifyOwnerBounceBack(jobId, reason, note) {
  var config;
  try { config = loadRuntimeConfig(); } catch (e) { return; }
  if (!config || !config.notifyEmail) return;
  var body = 'Job ' + jobId + ' has been ' + reason + ' and is now in your lane.';
  if (note) body += '\n\nNote from assignee: ' + note;
  _sendEmailSafely({
    to: config.notifyEmail,
    subject: 'Job needs your attention: ' + reason,
    body: body
  });
}

function cancelRunPrompt() {
  var ui = SpreadsheetApp.getUi();
  _removeResumeTriggers();
  _clearActiveRunState();
  PropertiesService.getScriptProperties().setProperty(CANCEL_REQUEST_KEY, 'true');
  updateRunSummary({ status: 'Cancelled' });
  ui.alert('Run cancelled. All run state and continuation triggers have been cleared.');
}

// Routes blank-Owner New jobs into lanes. Sticky: never touches a row that already has an Owner.
// Returns { assigned, reserved, skipped }.
function _routeNewJobs(config) {
  var counts = { assigned: 0, reserved: 0, skipped: 0 };
  if (!config) return counts;

  var reservePriorities = config.reservePriorities || [];
  var assigneePriorities = config.autoAssignPriorities || [];
  var reservedCompanies = config.reservedCompanies || [];
  var excludeCompanies = config.autoAssignExcludeCompanies || [];
  var visas = config.autoAssignVisa || [];
  var minScore = config.autoAssignMinScore || 0;

  var jobSheet = _getJobPrioritySheet();
  if (!jobSheet) return counts;
  var lastRow = jobSheet.getLastRow();
  if (lastRow < JOB_PRIORITY_DATA_START_ROW) return counts;

  var records = getExistingJobRecords();
  var numRows = lastRow - JOB_PRIORITY_DATA_START_ROW + 1;
  var ownerColVals = jobSheet.getRange(JOB_PRIORITY_DATA_START_ROW, JOB_PRIORITY_COLUMN_INDEX.owner, numRows, 1).getValues();
  var statusColVals = jobSheet.getRange(JOB_PRIORITY_DATA_START_ROW, JOB_PRIORITY_COLUMN_INDEX.status, numRows, 1).getValues();
  var actionColVals = jobSheet.getRange(JOB_PRIORITY_DATA_START_ROW, JOB_PRIORITY_COLUMN_INDEX.action, numRows, 1).getValues();
  var assigneeJobs = [];

  records.forEach(function(r) {
    var idx = r.rowNumber - JOB_PRIORITY_DATA_START_ROW;
    if (idx < 0 || idx >= numRows) return;
    if (_stringifyField(ownerColVals[idx][0])) return;              // sticky: already owned
    if (_stringifyField(statusColVals[idx][0] || 'New') !== 'New') return;

    var priority = _stringifyField(r.priority);
    var company = (_stringifyField(r.company) || '').toLowerCase().trim();

    // Hard exclude → skip
    if (excludeCompanies.indexOf(company) !== -1) {
      ownerColVals[idx][0] = 'Me'; statusColVals[idx][0] = 'Skip'; counts.skipped++; return;
    }
    // Reserved company or top priority → my lane (networking)
    if (reservedCompanies.indexOf(company) !== -1 || reservePriorities.indexOf(priority) !== -1) {
      ownerColVals[idx][0] = 'Me'; counts.reserved++; return;
    }
    // Assignee band → her lane if it clears visa + score
    if (assigneePriorities.indexOf(priority) !== -1) {
      var visaOk = visas.length === 0 || visas.indexOf(_stringifyField(r.usVisaSponsorshipPotential)) !== -1;
      var scoreOk = true;
      if (minScore > 0) { var s = Number(r.score); scoreOk = !isNaN(s) && s >= minScore; }
      if (visaOk && scoreOk) {
        ownerColVals[idx][0] = 'Assignee'; actionColVals[idx][0] = 'Fill & Submit';
        r.owner = 'Assignee'; r.action = 'Fill & Submit';
        assigneeJobs.push(r); counts.assigned++; return;
      }
      ownerColVals[idx][0] = 'Me'; counts.reserved++; return;       // in-band but filtered out → owner decides
    }
    // Everything else (P06+) → skip
    ownerColVals[idx][0] = 'Me'; statusColVals[idx][0] = 'Skip'; counts.skipped++;
  });

  jobSheet.getRange(JOB_PRIORITY_DATA_START_ROW, JOB_PRIORITY_COLUMN_INDEX.owner, numRows, 1).setValues(ownerColVals);
  jobSheet.getRange(JOB_PRIORITY_DATA_START_ROW, JOB_PRIORITY_COLUMN_INDEX.status, numRows, 1).setValues(statusColVals);
  jobSheet.getRange(JOB_PRIORITY_DATA_START_ROW, JOB_PRIORITY_COLUMN_INDEX.action, numRows, 1).setValues(actionColVals);

  if (assigneeJobs.length) {
    _pushJobsToAssignedSheet(assigneeJobs);
    if (config.notifyAssigneeEmail) _notifyAssigneeOfNewJobs(config, assigneeJobs.length);
  }
  return counts;
}

function assignSelectedRowsPrompt() {
  ensureWorkbookReadyForRuntime();
  var ui = SpreadsheetApp.getUi();
  var jobSheet = _getJobPrioritySheet();
  var range = jobSheet && jobSheet.getActiveRange();
  if (!range) { ui.alert('Select one or more job rows first.'); return; }

  var records = getExistingJobRecords();
  var selectedRows = {};
  for (var r = range.getRow(); r <= range.getLastRow(); r++) selectedRows[r] = true;
  var selected = records.filter(function(rec) { return selectedRows[rec.rowNumber]; });
  if (!selected.length) { ui.alert('No valid job rows selected.'); return; }

  var assigned = _pushJobsToAssignedSheet(selected);
  ui.alert(assigned > 0
    ? assigned + ' job(s) assigned. Already-assigned jobs were skipped.'
    : 'All selected jobs are already in the Assigned sheet.');
}

function reassignJobsPrompt() {
  ensureWorkbookReadyForRuntime();
  var ui = SpreadsheetApp.getUi();
  var config = loadRuntimeConfig();

  var counts = _routeNewJobs(config);
  var total = counts.assigned + counts.reserved + counts.skipped;
  if (!total) { ui.alert('No unrouted New jobs to route.'); return; }

  ui.alert(
    'Routed ' + total + ' new job(s):\n' +
    '• ' + counts.assigned + ' → assignee lane\n' +
    '• ' + counts.reserved + ' → your lane (networking)\n' +
    '• ' + counts.skipped + ' → skipped (low priority/excluded)'
  );
}

function _findTokenForDatasetId(datasetId, config) {
  var accounts = config.apifyAccounts;
  for (var i = 0; i < accounts.length; i++) {
    try {
      var meta = _getDatasetMetadata(datasetId, accounts[i]);
      if (meta && meta.id) return accounts[i];
    } catch (e) { /* try next */ }
  }
  // Try without token (public datasets)
  try {
    var meta = _getDatasetMetadata(datasetId, '');
    if (meta && meta.id) return '';
  } catch (e) {}
  throw new Error('Dataset ' + datasetId + ' not accessible with any of your ' + accounts.length + ' Apify accounts.');
}

function importApifyDatasetByIdPrompt() {
  var ui = SpreadsheetApp.getUi();
  var response = ui.prompt('Import Apify Dataset', 'Enter the Apify dataset ID to import:', ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() !== ui.Button.OK) return;
  var datasetId = response.getResponseText().trim();
  if (!datasetId) { ui.alert('No dataset ID entered.'); return; }

  var config = loadRuntimeConfig();
  validateRuntimeConfig(config);
  var token = _findTokenForDatasetId(datasetId, config);

  var state = {
    version: 1,
    runStartedAt: new Date().toISOString(),
    sources: [{ taskId: datasetId, runId: '', datasetId: datasetId, token: token }],
    rawScrapedCount: 0, totalJobsCount: 0, totalScoreableCount: 0,
    processedCount: 0, newJobsCount: 0, aJobsCount: 0,
    failedJobsCount: 0, scoredJobsCount: 0, importFailedJobsCount: 0,
    handledJobIds: [], pendingStage2JobIds: [], newTopPriorityJobIds: [], errors: []
  };
  _runJobImportAndScoringInternal(state);
}

function importLastNActorRunsPrompt() {
  var ui = SpreadsheetApp.getUi();
  var response = ui.prompt('Import Last N Runs', 'How many recent successful runs to import? (Leave blank for 5):', ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() !== ui.Button.OK) return;
  var raw = response.getResponseText().trim();
  var n = raw ? parseInt(raw, 10) : 5;
  if (isNaN(n) || n < 1) { ui.alert('Please enter a positive number.'); return; }

  var config = loadRuntimeConfig();
  validateRuntimeConfig(config);
  var accounts = config.apifyAccounts;
  var actorId = config.apifyActorId;

  var allRuns = [];
  for (var i = 0; i < accounts.length; i++) {
    var runs = _listActorRuns(actorId, accounts[i], n);
    for (var j = 0; j < runs.length; j++) {
      runs[j]._token = accounts[i];
    }
    allRuns = allRuns.concat(runs);
  }

  allRuns.sort(function(a, b) {
    return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();
  });

  var topRuns = allRuns.slice(0, n).filter(function(r) { return r.defaultDatasetId; });
  if (!topRuns.length) { ui.alert('No successful runs with datasets found.'); return; }

  var sources = topRuns.map(function(r) {
    return { taskId: actorId, runId: r.id, datasetId: r.defaultDatasetId, token: r._token };
  });

  ui.alert('Importing ' + topRuns.length + ' run(s). This may take a moment…');
  var state = {
    version: 1,
    runStartedAt: new Date().toISOString(),
    sources: sources,
    rawScrapedCount: 0, totalJobsCount: 0, totalScoreableCount: 0,
    processedCount: 0, newJobsCount: 0, aJobsCount: 0,
    failedJobsCount: 0, scoredJobsCount: 0, importFailedJobsCount: 0,
    handledJobIds: [], pendingStage2JobIds: [], newTopPriorityJobIds: [], errors: []
  };
  _runJobImportAndScoringInternal(state);
}


