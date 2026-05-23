var CRITICAL_FAILURE_RATIO = 0.5;
var CRITICAL_FAILURE_MIN_COUNT = 5;
var ACTIVE_RUN_STATE_PROPERTY_KEY = 'ACTIVE_JOB_IMPORT_RUN_STATE';
var RESUME_TRIGGER_HANDLER = 'resumeJobImportAndScoring';

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Jobs Pipeline')
    .addItem('Initialize Sheets', 'setupJobPriorityWorkbook')
    .addItem('Run Now', 'runJobImportAndScoring')
    .addItem('Deduplicate Existing Jobs', 'deduplicateExistingJobs')
    .addSeparator()
    .addItem('Import Apify Run ID...', 'importApifyRunByIdPrompt')
    .addItem('Retry Apify Run ID...', 'resurrectApifyRunByIdPrompt')
    .addSeparator()
    .addItem('Create Hourly Trigger', 'createHourlyTrigger')
    .addItem('Remove Hourly Triggers', 'removeHourlyTriggers')
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

  sortAndRankJobs();
}

function runJobImportAndScoring() {
  return _runJobImportAndScoringInternal();
}

function resumeJobImportAndScoring() {
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
  var activeRunState = initialActiveRunState || _loadActiveRunState();
  var scoringRunStartedAt = activeRunState && activeRunState.runStartedAt ? new Date(activeRunState.runStartedAt) : executionStartedAt;
  var config = null;
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
    setupJobPriorityWorkbook();

    if (initialActiveRunState) {
      _clearActiveRunState();
      _removeResumeTriggers();
    }

    config = loadRuntimeConfig();
    config.runStartedAt = scoringRunStartedAt;
    config.activeRunState = activeRunState;
    validateRuntimeConfig(config);
    updateRunSummary(progressState);

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
      _saveActiveRunState(result.activeRunState);
      _scheduleResumeTrigger();

      progressState.status = 'Scoring jobs';
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

      return result;
    }

    _clearActiveRunState();
    _removeResumeTriggers();
    result.newAJobs = _getJobsByCanonicalKeys(result.newAJobCanonicalKeys || []);

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

function createHourlyTrigger() {
  removeHourlyTriggers();
  ScriptApp.newTrigger('runJobImportAndScoring')
    .timeBased()
    .everyHours(1)
    .create();
}

function removeHourlyTriggers() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'runJobImportAndScoring' || trigger.getHandlerFunction() === RESUME_TRIGGER_HANDLER) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function validateConfiguration() {
  setupJobPriorityWorkbook();

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

function deduplicateExistingJobs() {
  setupJobPriorityWorkbook();

  var result = deduplicateExistingJobRows();
  var message = result.removedRowCount
    ? (
      'Deduplication completed.\n' +
      'Duplicate groups merged: ' + result.duplicateGroupCount + '\n' +
      'Rows archived: ' + result.archivedRowCount + '\n' +
      'Rows removed: ' + result.removedRowCount + '\n' +
      'Remaining job rows: ' + result.finalRowCount
    )
    : 'No duplicate canonical job groups were found.';

  SpreadsheetApp.getUi().alert(message);
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
    return !job.existingRowNumber && job.priority === 'A';
  });

  if (!newAJobs.length) {
    return;
  }

  _sendNewAJobsEmail(config, newAJobs);
}

function _loadActiveRunState() {
  var raw = PropertiesService.getScriptProperties().getProperty(ACTIVE_RUN_STATE_PROPERTY_KEY);

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
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

function _scheduleResumeTrigger() {
  _removeResumeTriggers();
  ScriptApp.newTrigger(RESUME_TRIGGER_HANDLER)
    .timeBased()
    .after(1000)
    .create();
}

function _getJobsByCanonicalKeys(canonicalKeys) {
  var wanted = {};
  var jobs = [];

  (canonicalKeys || []).forEach(function(key) {
    if (key) {
      wanted[String(key)] = true;
    }
  });

  getExistingJobRecords().forEach(function(record) {
    if (record.canonicalRoleKey && wanted[record.canonicalRoleKey]) {
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
    handledCanonicalKeys: [],
    newAJobCanonicalKeys: [],
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
  var lines = [jobs.length + ' new A-priority job' + (jobs.length === 1 ? '' : 's') + ' found.', ''];

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

  return '[Job Pipeline] ' + jobs.length + ' A job' + (jobs.length === 1 ? '' : 's') + (topJobs ? ': ' + topJobs : '');
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
    '      <div style="font-size:26px;line-height:1.2;font-weight:700;color:#111827;margin:0 0 8px 0;">' + jobs.length + ' new A-priority job' + (jobs.length === 1 ? '' : 's') + '</div>',
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
