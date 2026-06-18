var CRITICAL_FAILURE_RATIO = 0.5;
var CRITICAL_FAILURE_MIN_COUNT = 5;
var ACTIVE_RUN_STATE_PROPERTY_KEY = 'ACTIVE_JOB_IMPORT_RUN_STATE';
var RESUME_TRIGGER_HANDLER = 'resumeJobImportAndScoring';
var BACKUP_RESUME_TRIGGER_DELAY_MS = 7 * 60 * 1000;

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Jobs Pipeline')
    .addItem('Initialize Sheets', 'setupJobPriorityWorkbook')
    .addItem('Run Now', 'runJobImportAndScoring')
    .addItem('Deduplicate Existing Jobs', 'deduplicateExistingJobs')
    .addItem('Deduplicate Similar JDs', 'deduplicateSimilarJds')
    .addItem('Prune Expired Jobs', 'pruneExpiredJobs')
    .addItem('Repair Job Links from Raw Ref', 'repairJobLinksFromRawRef')
    .addItem('Migrate Raw Data', 'migrateRawData')
    .addItem('Reevaluate Active Backlog', 'reevaluateActiveBacklog')
    .addItem('Reevaluate Selected Rows', 'reevaluateSelectedRows')
    .addSeparator()
    .addItem('Import Apify Run ID...', 'importApifyRunByIdPrompt')
    .addItem('Retry Apify Run ID...', 'resurrectApifyRunByIdPrompt')
    .addSeparator()
    .addItem('Create Run Trigger', 'createRunTrigger')
    .addItem('Remove Run Triggers', 'removeHourlyTriggers')
    .addSeparator()
    .addItem('Validate Config', 'validateConfiguration')
    .addToUi();
}

function onInstall() {
  onOpen();
}

function onEdit(e) {
  if (!e || !e.range) {
    return;
  }

  var sheet = e.range.getSheet();
  if (!sheet || sheet.getName() !== JOB_PRIORITY_SHEET_NAME) {
    return;
  }

  if (e.range.getRow() < JOB_PRIORITY_DATA_START_ROW || e.range.getColumn() !== JOB_PRIORITY_COLUMN_INDEX.status) {
    return;
  }
}

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
      return;
    }
  }

  return _runJobImportAndScoringInternal();
}

function resumeJobImportAndScoring() {
  var activeRunState = _loadActiveRunState();
  if (activeRunState && activeRunState.mode === 'reevaluate') {
    return _runJobReevaluationInternal();
  }

  return _runJobImportAndScoringInternal();
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

function _runJobImportAndScoringInternal(initialActiveRunState) {
  var lock = LockService.getScriptLock();
  var executionStartedAt = new Date();
  var activeRunState = initialActiveRunState || _loadActiveRunState() || _createEmptyImportRunState(executionStartedAt);
  var scoringRunStartedAt = activeRunState && activeRunState.runStartedAt ? new Date(activeRunState.runStartedAt) : executionStartedAt;
  var config = null;
  var resumedAfterUnexpectedStop = false;
  var progressState = {
    lastRun: executionStartedAt,
    status: 'Starting Apify task',
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

  lock.waitLock(30000);

  try {
    ensureWorkbookReadyForRuntime();

    if (initialActiveRunState) {
      _clearActiveRunState();
      _removeResumeTriggers();
    }

    config = loadRuntimeConfig();
    config.runStartedAt = scoringRunStartedAt;
    config.activeRunState = activeRunState;
    resumedAfterUnexpectedStop = _markTrackedExecutionStarted(activeRunState, executionStartedAt);
    _scheduleResumeTrigger(BACKUP_RESUME_TRIGGER_DELAY_MS);
    validateRuntimeConfig(config);
    updateRunSummary(progressState);

    if (resumedAfterUnexpectedStop) {
      progressState.errorMessage = 'Previous execution stopped unexpectedly, likely due to an Apps Script timeout. Resuming from saved progress.';
      updateRunSummary(progressState);
    }

    var existingIndex = getExistingJobIndex();
    var result = importAndScoreJobs(config, existingIndex, function(nextState) {
      if (nextState.status) {
        progressState.status = nextState.status;
      }
      if (nextState.processed !== undefined) {
        progressState.processed = nextState.processed;
      }
      if (nextState.scrapedCount !== undefined) {
        progressState.scrapedCount = nextState.scrapedCount;
      }
      if (nextState.uniqueRolesCount !== undefined) {
        progressState.uniqueRolesCount = nextState.uniqueRolesCount;
      }
      if (nextState.toScoreCount !== undefined) {
        progressState.toScoreCount = nextState.toScoreCount;
      }
      if (nextState.errorMessage !== undefined) {
        progressState.errorMessage = nextState.errorMessage;
      }
      updateRunSummary(progressState);
    });

    progressState.status = 'Writing sheet';
    progressState.processed = result.processedCount + ' / ' + result.totalJobsCount;
    progressState.scrapedCount = result.rawScrapedCount;
    progressState.uniqueRolesCount = result.uniqueRolesCount;
    progressState.toScoreCount = result.totalScoreableCount;
    progressState.newJobsCount = result.newJobsCount;
    progressState.aJobsCount = result.aJobsCount;
    progressState.failedJobsCount = result.failedJobsCount;
    progressState.scoredJobsCount = result.scoredJobsCount;
    updateRunSummary(progressState);

    writeJobs(result.rows);
    sortAndRankJobs();

    if (result.hasMore) {
      _markTrackedExecutionFinished(result.activeRunState, 'yielded');
      _saveActiveRunState(result.activeRunState);
      _scheduleResumeTrigger();

      progressState.status = 'Continuing in next execution';
      progressState.processed = result.processedCount + ' / ' + result.totalJobsCount;
      progressState.scrapedCount = result.rawScrapedCount;
      progressState.uniqueRolesCount = result.uniqueRolesCount;
      progressState.toScoreCount = result.totalScoreableCount;
      progressState.newJobsCount = result.newJobsCount;
      progressState.aJobsCount = result.aJobsCount;
      progressState.failedJobsCount = result.failedJobsCount;
      progressState.scoredJobsCount = result.scoredJobsCount;
      progressState.errorMessage = result.errors.length
        ? _truncate(result.errors.join(' | '), 500)
        : 'Continuation scheduled automatically before the Apps Script execution limit.';
      updateRunSummary(progressState);

      return result;
    }

    _markTrackedExecutionFinished(result.activeRunState, 'completed');
    _clearActiveRunState();
    _removeResumeTriggers();

    try {
      progressState.status = 'Pruning expired jobs';
      updateRunSummary(progressState);
      pruneExpiredJobRows();
    } catch (pruneError) {
      Logger.log(pruneError);
    }

    try {
      progressState.status = 'Deduplicating similar JDs';
      updateRunSummary(progressState);
      deduplicateSimilarJdRows();
    } catch (dedupError) {
      Logger.log(dedupError);
    }

    result.newAJobs = _getJobsByJobIds(result.newTopPriorityJobIds || []);

    progressState.status = 'Completed';
    progressState.processed = result.processedCount + ' / ' + result.totalJobsCount;
    progressState.scrapedCount = result.rawScrapedCount;
    progressState.uniqueRolesCount = result.uniqueRolesCount;
    progressState.toScoreCount = result.totalScoreableCount;
    progressState.newJobsCount = result.newJobsCount;
    progressState.aJobsCount = result.aJobsCount;
    progressState.failedJobsCount = result.failedJobsCount;
    progressState.scoredJobsCount = result.scoredJobsCount;
    progressState.errorMessage = result.errors.length ? _truncate(result.errors.join(' | '), 500) : '';
    updateRunSummary(progressState);
    _sendCompletionNotifications(config, result, progressState);

    return result;
  } catch (error) {
    _clearActiveRunState();
    _removeResumeTriggers();
    progressState.status = 'Failed';
    progressState.errorMessage = _truncate(error && error.message ? error.message : String(error), 500);
    updateRunSummary(progressState);
    _sendWholeRunFailureNotification(config, progressState, error);
    throw error;
  } finally {
    if (lock.hasLock()) {
      lock.releaseLock();
    }
  }
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
    if (trigger.getHandlerFunction() === 'runJobImportAndScoring' || trigger.getHandlerFunction() === RESUME_TRIGGER_HANDLER) {
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
    'Apify task count: ' + config.apifyTaskIds.length + '\n' +
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
    SpreadsheetApp.getUi().alert('No eligible backlog rows were found. Reevaluation only targets New, Opened, and Tailoring rows.');
    return;
  }

  if (!Number(activeRunState.totalScoreableCount || 0)) {
    SpreadsheetApp.getUi().alert('No active backlog rows need reevaluation. They either already match the current scoring fingerprint or are missing source_jd.');
    return;
  }

  _runJobReevaluationInternal(activeRunState);
}

function reevaluateSelectedRows() {
  ensureWorkbookReadyForRuntime();

  var sheet = _getJobPrioritySheet();
  var range = sheet && sheet.getActiveRange();
  var selectedRows = {};
  var selectedRecords = [];

  if (!range) {
    SpreadsheetApp.getUi().alert('Select one or more job rows first.');
    return;
  }

  for (var row = range.getRow(); row < range.getRow() + range.getNumRows(); row += 1) {
    if (row >= JOB_PRIORITY_DATA_START_ROW) {
      selectedRows[row] = true;
    }
  }

  var config = loadRuntimeConfig();
  validateRuntimeConfig(config, { requireApify: false });
  var existingIndex = getExistingJobIndex();
  existingIndex.records.forEach(function(record) {
    if (selectedRows[record.rowNumber] && _isReevaluationEligibleStatus(record.status)) {
      selectedRecords.push(record);
    }
  });

  var activeRunState = _buildReevaluationStateFromRecords(selectedRecords, config, 'selected rows');

  if (!activeRunState.targetJobIds.length) {
    SpreadsheetApp.getUi().alert('No eligible selected rows were found. Reevaluation ignores Applied and Skip rows.');
    return;
  }

  if (!Number(activeRunState.totalScoreableCount || 0)) {
    SpreadsheetApp.getUi().alert('No selected rows need reevaluation. They either already match the current scoring fingerprint or are missing source_jd.');
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

function migrateRawData() {
  ensureWorkbookReadyForRuntime();

  var result = migrateRawDataToDedicatedSheet();
  var message = [
    'Raw-data migration completed.',
    'Rows checked: ' + result.checkedCount,
    'Rows migrated: ' + result.migratedCount,
    'Rows skipped: ' + result.skippedCount,
    'Missing job_id: ' + result.missingJobIdCount
  ];

  SpreadsheetApp.getUi().alert(message.join('\n'));
}

function _runJobReevaluationInternal(initialActiveRunState) {
  var lock = LockService.getScriptLock();
  var executionStartedAt = new Date();
  var activeRunState = initialActiveRunState || _loadActiveRunState();
  var scoringRunStartedAt = activeRunState && activeRunState.runStartedAt ? new Date(activeRunState.runStartedAt) : executionStartedAt;
  var config = null;
  var resumedAfterUnexpectedStop = false;
  var progressState = {
    lastRun: executionStartedAt,
    status: 'Reevaluating jobs',
    processed: '',
    scrapedCount: '',
    uniqueRolesCount: activeRunState && activeRunState.totalJobsCount ? activeRunState.totalJobsCount : '',
    toScoreCount: activeRunState && activeRunState.totalScoreableCount ? activeRunState.totalScoreableCount : '',
    newJobsCount: '',
    aJobsCount: activeRunState && activeRunState.aJobsCount ? activeRunState.aJobsCount : '',
    failedJobsCount: '',
    scoredJobsCount: '',
    errorMessage: ''
  };

  lock.waitLock(30000);

  try {
    ensureWorkbookReadyForRuntime();

    if (initialActiveRunState) {
      _clearActiveRunState();
      _removeResumeTriggers();
    }

    if (!activeRunState || activeRunState.mode !== 'reevaluate') {
      throw new Error('No active reevaluation state was found.');
    }

    config = loadRuntimeConfig();
    config.runStartedAt = scoringRunStartedAt;
    config.activeRunState = activeRunState;
    resumedAfterUnexpectedStop = _markTrackedExecutionStarted(activeRunState, executionStartedAt);
    _scheduleResumeTrigger(BACKUP_RESUME_TRIGGER_DELAY_MS);
    validateRuntimeConfig(config, { requireApify: false });
    updateRunSummary(progressState);

    if (resumedAfterUnexpectedStop) {
      progressState.errorMessage = 'Previous execution stopped unexpectedly, likely due to an Apps Script timeout. Resuming from saved progress.';
      updateRunSummary(progressState);
    }

    var existingIndex = getExistingJobIndex();
    var result = reevaluateExistingJobs(config, existingIndex, function(nextState) {
      if (nextState.status) {
        progressState.status = nextState.status;
      }
      if (nextState.processed !== undefined) {
        progressState.processed = nextState.processed;
      }
      if (nextState.uniqueRolesCount !== undefined) {
        progressState.uniqueRolesCount = nextState.uniqueRolesCount;
      }
      if (nextState.toScoreCount !== undefined) {
        progressState.toScoreCount = nextState.toScoreCount;
      }
      if (nextState.errorMessage !== undefined) {
        progressState.errorMessage = nextState.errorMessage;
      }
      updateRunSummary(progressState);
    });

    progressState.status = 'Writing sheet';
    progressState.processed = result.processedCount + ' / ' + result.totalJobsCount;
    progressState.uniqueRolesCount = result.uniqueRolesCount;
    progressState.toScoreCount = result.totalScoreableCount;
    progressState.aJobsCount = result.aJobsCount;
    progressState.failedJobsCount = result.failedJobsCount;
    progressState.scoredJobsCount = result.scoredJobsCount;
    updateRunSummary(progressState);

    writeJobs(result.rows);
    sortAndRankJobs();

    if (result.hasMore) {
      _markTrackedExecutionFinished(result.activeRunState, 'yielded');
      _saveActiveRunState(result.activeRunState);
      _scheduleResumeTrigger();

      progressState.status = 'Continuing in next execution';
      progressState.processed = result.processedCount + ' / ' + result.totalJobsCount;
      progressState.uniqueRolesCount = result.uniqueRolesCount;
      progressState.toScoreCount = result.totalScoreableCount;
      progressState.aJobsCount = result.aJobsCount;
      progressState.failedJobsCount = result.failedJobsCount;
      progressState.scoredJobsCount = result.scoredJobsCount;
      progressState.errorMessage = result.errors.length
        ? _truncate(result.errors.join(' | '), 500)
        : 'Continuation scheduled automatically before the Apps Script execution limit.';
      updateRunSummary(progressState);

      return result;
    }

    _markTrackedExecutionFinished(result.activeRunState, 'completed');
    _clearActiveRunState();
    _removeResumeTriggers();

    progressState.status = 'Completed';
    progressState.processed = result.processedCount + ' / ' + result.totalJobsCount;
    progressState.uniqueRolesCount = result.uniqueRolesCount;
    progressState.toScoreCount = result.totalScoreableCount;
    progressState.aJobsCount = result.aJobsCount;
    progressState.failedJobsCount = result.failedJobsCount;
    progressState.scoredJobsCount = result.scoredJobsCount;
    progressState.errorMessage = result.errors.length ? _truncate(result.errors.join(' | '), 500) : '';
    updateRunSummary(progressState);

    return result;
  } catch (error) {
    _clearActiveRunState();
    _removeResumeTriggers();
    progressState.status = 'Failed';
    progressState.errorMessage = _truncate(error && error.message ? error.message : String(error), 500);
    updateRunSummary(progressState);
    throw error;
  } finally {
    if (lock.hasLock()) {
      lock.releaseLock();
    }
  }
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
  return normalized === 'New' || normalized === 'Opened' || normalized === 'Tailoring';
}

function _hasScoringPayload(record) {
  return _stringifyField(record.priority) &&
    _stringifyField(record.usVisaReason) &&
    _stringifyField(record.summary) &&
    _stringifyField(record.why) &&
    _stringifyField(record.angle) &&
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

function _buildActiveRunStateFromApifyRunId(runId, shouldResurrect) {
  var config = loadRuntimeConfig();
  validateRuntimeConfig(config);
  var runInfo;
  var sourceLabel;

  if (shouldResurrect) {
    runInfo = _resurrectApifyRun(runId, config);
    runInfo = _waitForRunToFinish(runId, 'run ' + runId, config);
  } else {
    runInfo = _getRunInfo(runId, config);
    if (runInfo.status && !_isRunStatusSuccess(String(runInfo.status || ''))) {
      if (_isRunStatusFailure(String(runInfo.status || ''))) {
        throw new Error('Run ' + runId + ' ended with status ' + runInfo.status + '. Use Retry Apify Run ID... if you want to rerun that Apify job.');
      }
      runInfo = _waitForRunToFinish(runId, 'run ' + runId, config);
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
        datasetId: runInfo.defaultDatasetId
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
