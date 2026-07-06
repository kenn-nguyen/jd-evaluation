var SCORING_CACHE_STATE_KEY = 'GEMINI_SCORING_CACHE_STATE';
var SCORING_CACHE_TTL_SECONDS = 18000;
var APIFY_ACTOR_ID = 'cheap_scraper/linkedin-job-scraper';
var APIFY_JOB_DETAIL_ACTOR_ID = 'apimaestro/linkedin-job-detail';
// Prefix for the error thrown by _waitForRunToFinish when the Apps Script execution deadline
// is near. Callers check for this to yield gracefully instead of rotating Apify accounts.
var APIFY_WAIT_PENDING_PREFIX = 'APIFY_WAIT_PENDING:';

function loadRuntimeConfig() {
  var settings = getSettingsMap();
  var properties = PropertiesService.getScriptProperties();
  var _apifyAccountsBundle = _getApifyAccounts();

  return {
    aiProvider: 'gemini',
    geminiApiRoute: String(settings.GEMINI_API_ROUTE || 'developer').toLowerCase(),
    scoringModel: String(settings.SCORING_MODEL || 'gemini-2.5-flash'),
    scoringParallelRequests: _normalizePositiveInteger(settings.SCORING_PARALLEL_REQUESTS || 3, 1, 100),
    scoringRpmLimit: _normalizePositiveInteger(settings.SCORING_RPM_LIMIT || 0, 0, 10000),
    maxJobsPerExecution: _normalizePositiveInteger(settings.SCORING_MAX_JOBS_PER_EXECUTION || 0, 0, 10000),
    scoringInstructions: _resolveDefaultableSetting(settings.SCORING_INSTRUCTIONS, _defaultScoringInstructions),
    promptVersion: 'v11',
    targetProfile: String(
      settings.TARGET_PROFILE ||
      _defaultTargetProfile()
    ),
    notifyEmail: String(settings.NOTIFY_EMAIL || '').trim(),
    forceRescore: String(settings.FORCE_RESCORE || 'FALSE').toUpperCase() === 'TRUE',
    runIntervalHours: _normalizePositiveInteger(settings.RUN_INTERVAL_HOURS || 4, 4, 12),
    quietStartHour: _parseHourSetting(settings.QUIET_START_HOUR, 19),
    quietEndHour: _parseHourSetting(settings.QUIET_END_HOUR, 5),
    apifyPollIntervalMs: 5000,
    apifyRunWaitSeconds: 240,
    // The hard Apps Script kill is 360 s. The deadline below is set AFTER the lock wait,
    // so it is already conservative vs the true start. We use ~330 s of budget and yield
    // ~40 s before it — leaving headroom for the post-loop write + saveState + trigger.
    // A hard kill is still survivable: handledJobIds is checkpointed and the backup
    // trigger resumes mid-batch. Bigger budget + smaller buffer = fewer trigger handoffs,
    // and each handoff costs 1-3 min of real wall-clock, so this is the main speed lever.
    executionSoftLimitMs: 330000,
    executionYieldBufferMs: 40000,
    executionDeadlineMs: Date.now() + 330000,
    apifyActorId: APIFY_ACTOR_ID,
    apifyDetailActorId: APIFY_JOB_DETAIL_ACTOR_ID,
    apifyAccounts: _apifyAccountsBundle.batch,
    apifyDetailAccounts: _apifyAccountsBundle.detail,
    apifyAccountLabels: _apifyAccountsBundle.labels,
    apifyJobDetailInput: String(settings.APIFY_JOB_DETAIL_INPUT || '').trim() || '{"urls": [{urls}]}',
    apifyRunInput: String(settings.APIFY_RUN_INPUT || '').trim() || null,
    apifyLookbackHours: Number(settings.APIFY_LOOKBACK_HOURS) || 0,
    apifyMaxLookbackHours: Number(settings.APIFY_MAX_LOOKBACK_HOURS) || 168,
    vertexProjectId: String(settings.VERTEX_PROJECT_ID || properties.getProperty('VERTEX_PROJECT_ID') || ''),
    vertexLocation: String(settings.VERTEX_LOCATION || 'global'),
    geminiApiKey: properties.getProperty('GEMINI_API_KEY'),
    openAiApiKey: properties.getProperty('OPENAI_API_KEY'),
    autoAssignPriorities: _splitCsv(settings.AUTO_ASSIGN_PRIORITIES || 'P04,P05'),
    reservePriorities: _splitCsv(settings.AUTO_RESERVE_PRIORITIES || 'P01,P02,P03'),
    reservedCompanies: _splitCsv(settings.RESERVED_COMPANIES || 'amazon,amazon web services (aws),amazon music,microsoft,microsoft ai,google,google deepmind,meta,apple,nvidia,nvidia ai,jpmorganchase,capital one,paypal,visa,mastercard,stripe,plaid,ramp,block,robinhood,coinbase,affirm,chime,databricks,snowflake,datadog,cloudflare,okta,servicenow,openai,anthropic,forter,socure,prove,sentilink,american express,bank of america,citi,wells fargo,goldman sachs,morgan stanley,bny,ubs,hsbc,intuit,adobe,airbnb,uber,salesforce,cisco,ebay,blackrock').map(function(s) { return s.toLowerCase(); }).filter(Boolean),
    autoAssignVisa: _splitCsv(settings.AUTO_ASSIGN_VISA || 'Yes (100%),Likely (90%),Possible (70%),Unclear (50%)'),
    autoSkipVisaNo: String(settings.AUTO_SKIP_VISA_NO || 'TRUE').toUpperCase() === 'TRUE',
    autoAssignExcludeCompanies: _splitCsv(settings.AUTO_ASSIGN_EXCLUDE_COMPANIES || 'hackajob,jobs via dice,trusting social,kompato ai').map(function(s) { return s.toLowerCase(); }).filter(Boolean),
    autoAssignMinScore: parseInt(settings.AUTO_ASSIGN_MIN_SCORE, 10) || 0,
    notifyAssigneeEmail: String(settings.NOTIFY_ASSIGNEE_EMAIL || '').trim()
  };
}

function validateRuntimeConfig(config) {
  var options = arguments[1] || {};
  var requireApify = options.requireApify !== false;
  var isDetailImport = config.activeRunState && config.activeRunState.importKind === 'detail';

  if (isDetailImport) {
    if (!config.apifyDetailAccounts || !config.apifyDetailAccounts.length) {
      throw new Error('No Detail Key is set on any active account in the Apify_Accounts sheet. Add the apimaestro/linkedin-job-detail token to at least one active account.');
    }
  } else if (requireApify && (!config.apifyAccounts || !config.apifyAccounts.length)) {
    throw new Error('No active account with a Batch Key found in the Apify_Accounts sheet (or legacy APIFY_ACCOUNTS setting).');
  }

  if (config.geminiApiRoute !== 'developer' && config.geminiApiRoute !== 'vertex') {
    throw new Error('GEMINI_API_ROUTE must be developer or vertex.');
  }

  if (config.geminiApiRoute === 'developer' && !config.geminiApiKey) {
    throw new Error('Missing GEMINI_API_KEY in Script Properties.');
  }

  if (config.geminiApiRoute === 'vertex' && !config.vertexProjectId) {
    throw new Error('VERTEX_PROJECT_ID is required in the Settings sheet for vertex route.');
  }

  if (!isDetailImport && requireApify && (!config.activeRunState || !config.activeRunState.sources || !config.activeRunState.sources.length) && !config.apifyAccounts.length) {
    throw new Error('No active account with a Batch Key found in the Apify_Accounts sheet.');
  }
}

function importAndScoreJobs(config, existingIndex, progressCallback) {
  var activeRunState = _getOrCreateActiveRunState(config, progressCallback);
  config.activeRunState = activeRunState;

  var sourceItems;
  try {
    sourceItems = _fetchApifyItems(config, progressCallback);
  } catch (fetchErr) {
    // Graceful execution-limit yield from _waitForRunToFinish.
    // The runId is already persisted in PropertiesService; _runPipelineInternal will
    // save state and schedule a resume trigger when it sees hasMore: true.
    if (String(fetchErr.message).indexOf(APIFY_WAIT_PENDING_PREFIX) === 0) {
      return {
        hasMore: true,
        activeRunState: activeRunState,
        rows: [],
        processedCount: activeRunState.processedCount || 0,
        rawScrapedCount: activeRunState.rawScrapedCount || 0,
        totalJobsCount: activeRunState.totalJobsCount || 0,
        uniqueRolesCount: activeRunState.uniqueRolesCount || 0,
        totalScoreableCount: activeRunState.totalScoreableCount || 0,
        newJobsCount: 0,
        aJobsCount: 0,
        failedJobsCount: 0,
        scoredJobsCount: 0,
        errors: ['Apify run still in progress — resuming in next execution.']
      };
    }
    throw fetchErr;
  }
  var normalizedJobs = [];
  var rows = [];
  var errors = [];
  var jobsToScore = [];
  var duplicateJobsCount = 0;
  var importFailedJobsCount = 0;
  var rowsToWriteWithoutScoring = [];
  var handledJobIdsMap = _buildLookup(activeRunState.handledJobIds || []);
  var handledThisExecution = [];
  var newTopPriorityJobIds = [];
  var maxJobsPerExecution = _getMaxJobsPerExecution(config);
  var scoreableJobsForThisExecution = [];
  var executionNewJobsCount = 0;
  var executionAJobsCount = 0;
  var executionScoredJobsCount = 0;
  var executionFailedJobsCount = 0;

  _emitProgress(progressCallback, {
    status: 'Deduping jobs',
    processed: ''
  });

  sourceItems.forEach(function(sourceItem) {
    try {
      var normalized = sourceItem.format === 'detail'
        ? _normalizeJobDetail(sourceItem.item, sourceItem.sourceLabel, config.runStartedAt)
        : _normalizeJob(sourceItem.item, sourceItem.sourceLabel, config.runStartedAt);
      normalizedJobs.push(normalized);
    } catch (itemError) {
      importFailedJobsCount += 1;
      errors.push(_truncate('Job import/scoring failed: ' + itemError.message, 300));
      Logger.log(itemError);
    }
  });

  var uniqueJobs = _dedupeJobsByJobId(normalizedJobs);
  duplicateJobsCount = normalizedJobs.length - uniqueJobs.length;
  activeRunState.rawScrapedCount = activeRunState.rawScrapedCount || sourceItems.length;
  activeRunState.totalJobsCount = activeRunState.totalJobsCount || uniqueJobs.length;

  uniqueJobs.forEach(function(normalizedJob) {
    if (handledJobIdsMap[normalizedJob.jobId]) {
      return;
    }

    var existing = existingIndex.byJobId[normalizedJob.jobId];
    var job = _buildCandidateJob(normalizedJob, existing);

    if (existing && !config.forceRescore) {
      rowsToWriteWithoutScoring.push(job);
      handledThisExecution.push(job.jobId);
      handledJobIdsMap[job.jobId] = true;
      return;
    }

    jobsToScore.push(job);
  });

  activeRunState.totalScoreableCount = activeRunState.totalScoreableCount || jobsToScore.length;

  if (rowsToWriteWithoutScoring.length) {
    rows = rows.concat(rowsToWriteWithoutScoring);
  }

  _emitProgress(progressCallback, {
    scrapedCount: activeRunState.rawScrapedCount,
    uniqueRolesCount: activeRunState.totalJobsCount,
    toScoreCount: activeRunState.totalScoreableCount
  });

  scoreableJobsForThisExecution = jobsToScore.slice(0, maxJobsPerExecution);

  _emitProgress(progressCallback, {
    status: 'Scoring jobs',
    processed: (activeRunState.handledJobIds.length + rowsToWriteWithoutScoring.length) + ' / ' + activeRunState.totalJobsCount
  });

  if (scoreableJobsForThisExecution.length) {
    var scoringResult = _scoreJobsInBatches(scoreableJobsForThisExecution, config, progressCallback, activeRunState.totalJobsCount, activeRunState.handledJobIds.length + rowsToWriteWithoutScoring.length);
    rows = rows.concat(scoringResult.rows);
    executionScoredJobsCount += scoringResult.scoredJobsCount;
    executionFailedJobsCount += scoringResult.failedJobsCount;
    errors = errors.concat(scoringResult.errors);
    // Pending Stage 2 jobs are NOT added to handledThisExecution — they stay in queue
    handledThisExecution = handledThisExecution
      .concat(scoringResult.rows.map(function(job) { return job.jobId; }))
      .concat(scoringResult.failedJobIds || []);
    executionNewJobsCount += scoringResult.rows.filter(function(job) {
      return !job.existingRowNumber;
    }).length;
    executionAJobsCount += scoringResult.rows.filter(function(job) {
      return !job.existingRowNumber && _isTopPriority(job.priority);
    }).length;
    newTopPriorityJobIds = scoringResult.rows.filter(function(job) {
      return !job.existingRowNumber && _isTopPriority(job.priority);
    }).map(function(job) { return job.jobId; });

  }

  activeRunState.handledJobIds = _appendUniqueStrings(activeRunState.handledJobIds || [], handledThisExecution);
  activeRunState.newTopPriorityJobIds = _appendUniqueStrings(activeRunState.newTopPriorityJobIds || [], newTopPriorityJobIds);
  activeRunState.newJobsCount = Number(activeRunState.newJobsCount || 0) + executionNewJobsCount;
  activeRunState.aJobsCount = Number(activeRunState.aJobsCount || 0) + executionAJobsCount;
  activeRunState.scoredJobsCount = Number(activeRunState.scoredJobsCount || 0) + executionScoredJobsCount;
  activeRunState.failedJobsCount = Number(activeRunState.failedJobsCount || 0) + executionFailedJobsCount + importFailedJobsCount;
  activeRunState.importFailedJobsCount = Number(activeRunState.importFailedJobsCount || 0) + importFailedJobsCount;
  activeRunState.errors = _appendErrors(activeRunState.errors || [], errors);
  activeRunState.processedCount = Math.min(activeRunState.totalJobsCount, activeRunState.handledJobIds.length);
  activeRunState.updatedAt = new Date().toISOString();

  return {
    rows: rows,
    newJobsCount: activeRunState.newJobsCount,
    aJobsCount: activeRunState.aJobsCount,
    duplicateJobsCount: duplicateJobsCount,
    scoredJobsCount: activeRunState.scoredJobsCount,
    failedJobsCount: activeRunState.failedJobsCount,
    importFailedJobsCount: activeRunState.importFailedJobsCount,
    processedCount: activeRunState.processedCount,
    rawScrapedCount: activeRunState.rawScrapedCount,
    uniqueRolesCount: activeRunState.totalJobsCount,
    totalScoreableCount: activeRunState.totalScoreableCount,
    totalJobsCount: activeRunState.totalJobsCount,
    errors: activeRunState.errors || [],
    hasMore: activeRunState.processedCount < activeRunState.totalJobsCount,
    activeRunState: activeRunState,
    newTopPriorityJobIds: activeRunState.newTopPriorityJobIds || []
  };
}

function reevaluateExistingJobs(config, existingIndex, progressCallback) {
  var activeRunState = config.activeRunState || {};
  var targetJobIds = activeRunState.targetJobIds || [];
  var handledJobIdsMap = _buildLookup(activeRunState.handledJobIds || []);
  var rows = [];
  var errors = [];
  var jobsToScore = [];
  var handledThisExecution = [];
  var skippedThisExecution = [];
  var newTopPriorityJobIds = [];
  var executionTopPriorityCount = 0;
  var executionScoredJobsCount = 0;
  var executionFailedJobsCount = 0;
  var maxJobsPerExecution = _getMaxJobsPerExecution(config);

  activeRunState.totalJobsCount = Number(activeRunState.totalJobsCount || targetJobIds.length || 0);

  _emitProgress(progressCallback, {
    status: 'Reevaluating jobs',
    processed: '',
    uniqueRolesCount: activeRunState.totalJobsCount,
    toScoreCount: activeRunState.totalScoreableCount || 0
  });

  targetJobIds.forEach(function(jobId) {
    if (handledJobIdsMap[jobId]) {
      return;
    }

    var existing = existingIndex.byJobId[jobId];
    var fingerprint = '';
    var reevaluateJob;

    if (!existing) {
      skippedThisExecution.push(jobId);
      handledJobIdsMap[jobId] = true;
      return;
    }

    if (!_stringifyField(existing.jobDescription) && !_extractJobDescriptionFromRawRef(existing.rawRef)) {
      skippedThisExecution.push(jobId);
      handledJobIdsMap[jobId] = true;
      return;
    }

    fingerprint = _buildScoringFingerprint(existing, config);
    if (!config.forceRescore && _stringifyField(existing.scoringFingerprint) === fingerprint && _hasScoringPayload(existing)) {
      skippedThisExecution.push(jobId);
      handledJobIdsMap[jobId] = true;
      return;
    }

    reevaluateJob = _refreshStoredJobForReevaluation(existing);
    reevaluateJob.existingRowNumber = existing.rowNumber;
    reevaluateJob.scoringFingerprint = fingerprint;
    jobsToScore.push(reevaluateJob);
  });

  if (!activeRunState.totalScoreableCount && activeRunState.totalScoreableCount !== 0) {
    activeRunState.totalScoreableCount = jobsToScore.length;
  }

  _emitProgress(progressCallback, {
    status: 'Reevaluating jobs',
    processed: (activeRunState.handledJobIds.length + skippedThisExecution.length) + ' / ' + activeRunState.totalJobsCount,
    uniqueRolesCount: activeRunState.totalJobsCount,
    toScoreCount: activeRunState.totalScoreableCount
  });

  if (jobsToScore.length) {
    var scoringResult = _scoreJobsInBatches(
      jobsToScore.slice(0, maxJobsPerExecution),
      config,
      progressCallback,
      activeRunState.totalJobsCount,
      activeRunState.handledJobIds.length + skippedThisExecution.length,
      'Reevaluating jobs'
    );

    rows = rows.concat(scoringResult.rows);
    executionScoredJobsCount += scoringResult.scoredJobsCount;
    executionFailedJobsCount += scoringResult.failedJobsCount;
    errors = errors.concat(scoringResult.errors);
    handledThisExecution = handledThisExecution
      .concat(scoringResult.rows.map(function(job) { return job.jobId; }))
      .concat(scoringResult.failedJobIds || []);
    executionTopPriorityCount += scoringResult.rows.filter(function(job) {
      return _isTopPriority(job.priority);
    }).length;
    newTopPriorityJobIds = scoringResult.rows.filter(function(job) {
      return _isTopPriority(job.priority);
    }).map(function(job) { return job.jobId; });
  }

  _finalizeExecutionState(activeRunState, skippedThisExecution, handledThisExecution, errors, executionScoredJobsCount, executionFailedJobsCount, newTopPriorityJobIds, executionTopPriorityCount);
  return _buildReevaluationResult(rows, activeRunState);
}

function _finalizeExecutionState(activeRunState, skippedThisExecution, handledThisExecution, errors, executionScoredJobsCount, executionFailedJobsCount, newTopPriorityJobIds, executionTopPriorityCount) {
  activeRunState.handledJobIds = _appendUniqueStrings(
    activeRunState.handledJobIds || [],
    skippedThisExecution.concat(handledThisExecution)
  );
  activeRunState.newTopPriorityJobIds = _appendUniqueStrings(activeRunState.newTopPriorityJobIds || [], newTopPriorityJobIds);
  activeRunState.aJobsCount = Number(activeRunState.aJobsCount || 0) + executionTopPriorityCount;
  activeRunState.scoredJobsCount = Number(activeRunState.scoredJobsCount || 0) + executionScoredJobsCount;
  activeRunState.failedJobsCount = Number(activeRunState.failedJobsCount || 0) + executionFailedJobsCount;
  activeRunState.errors = _appendErrors(activeRunState.errors || [], errors);
  activeRunState.processedCount = Math.min(activeRunState.totalJobsCount, activeRunState.handledJobIds.length);
  activeRunState.updatedAt = new Date().toISOString();
}

function _buildReevaluationResult(rows, activeRunState) {
  return {
    rows: rows,
    newJobsCount: '',
    aJobsCount: activeRunState.aJobsCount,
    duplicateJobsCount: 0,
    scoredJobsCount: activeRunState.scoredJobsCount,
    failedJobsCount: activeRunState.failedJobsCount,
    importFailedJobsCount: 0,
    processedCount: activeRunState.processedCount,
    rawScrapedCount: '',
    uniqueRolesCount: activeRunState.totalJobsCount,
    totalScoreableCount: activeRunState.totalScoreableCount,
    totalJobsCount: activeRunState.totalJobsCount,
    errors: activeRunState.errors || [],
    hasMore: activeRunState.processedCount < activeRunState.totalJobsCount,
    activeRunState: activeRunState,
    newTopPriorityJobIds: activeRunState.newTopPriorityJobIds || []
  };
}

function _runSingleStageScoringLoop(jobs, config, progressCallback, totalJobsCount, initialProcessedCount, statusLabel) {
  var rows = [];
  var errors = [];
  var scoredJobsCount = 0;
  var failedJobsCount = 0;
  var processedCount = 0;
  var failedJobIds = [];
  var batchSize = config.scoringParallelRequests;
  var resolvedStatusLabel = statusLabel || 'Scoring jobs';
  var hitExecutionBudget = false;
  var runScoredByFingerprint = {};

  // Initialize Gemini context cache once per run (keyed by model + prompt fingerprint)
  if (!config._scoringCacheAttempted) {
    config._scoringCacheAttempted = true;
    config._scoringCacheName = _getOrCreateScoringCache(config) || '';
  }

  for (var start = 0; start < jobs.length; start += batchSize) {
    if (start > 0 && _isCancelRequested()) {
      _clearCancelRequest();
      Logger.log('Run cancelled by user after ' + processedCount + ' jobs.');
      break;
    }

    if (start > 0 && _shouldYieldExecution(config)) {
      hitExecutionBudget = true;
      break;
    }

    var batch = jobs.slice(start, start + batchSize);
    var prevRowCount = rows.length;

    // Split batch: jobs whose fingerprint was already scored this run vs jobs needing API calls
    var toScore = [];
    var reused = [];
    batch.forEach(function(job) {
      var fp = job.scoringFingerprint;
      if (fp && runScoredByFingerprint[fp]) {
        reused.push({ job: job, result: runScoredByFingerprint[fp] });
      } else {
        toScore.push(job);
      }
    });

    // Apply reused scores (no API call needed)
    reused.forEach(function(item) {
      var r = item.result;
      var job = item.job;
      job.score = r.score;
      job.priority = r.priority;
      job.usVisaSponsorshipPotential = r.usVisaSponsorshipPotential;
      job.usVisaReason = r.usVisaReason;
      job.summary = r.summary;
      job.why = r.why;
      job.titleLevel = r.titleLevel;
      job.jdImpliedLevel = r.jdImpliedLevel;
      job.levelNormalized = r.levelNormalized;
      job.requiresPeopleMgmt = r.requiresPeopleMgmt;
      job.requiredYoePm = r.requiredYoePm;
      job.requiredYoeTotal = r.requiredYoeTotal;
      job.scoredAt = new Date();
      rows.push(job);
      scoredJobsCount += 1;
    });

    var batchStartedAt = Date.now();

    if (toScore.length) {
      var requests = toScore.map(function(job) {
        return _buildScoreRequest(job, config);
      });
      var responses = _executeScoreRequests(requests);

      toScore.forEach(function(job, index) {
        try {
          var scoreResult = _scoreSingleJobWithRetry(job, config, responses[index]);
          job.score = scoreResult.score;
          job.priority = scoreResult.priority;
          job.usVisaSponsorshipPotential = scoreResult.usVisaSponsorshipPotential;
          job.usVisaReason = scoreResult.usVisaReason;
          job.summary = scoreResult.summary;
          job.why = scoreResult.why;
          job.titleLevel = scoreResult.titleLevel;
          job.jdImpliedLevel = scoreResult.jdImpliedLevel;
          job.levelNormalized = scoreResult.levelNormalized;
          job.requiresPeopleMgmt = scoreResult.requiresPeopleMgmt;
          job.requiredYoePm = scoreResult.requiredYoePm;
          job.requiredYoeTotal = scoreResult.requiredYoeTotal;
          job.scoredAt = new Date();
          job.scoringFingerprint = job.scoringFingerprint || _buildScoringFingerprint(job, config);
          if (job.scoringFingerprint) {
            runScoredByFingerprint[job.scoringFingerprint] = scoreResult;
          }

          rows.push(job);
          scoredJobsCount += 1;
        } catch (scoreError) {
          failedJobsCount += 1;
          failedJobIds.push(job.jobId);
          errors.push(_truncate('AI scoring failed for ' + (job.title || job.jobId) + ': ' + scoreError.message, 300));
          Logger.log(scoreError);
        }
      });
    }

    processedCount += batch.length;
    _emitProgress(progressCallback, {
      status: resolvedStatusLabel,
      processed: (initialProcessedCount + processedCount) + ' / ' + totalJobsCount,
      rows: rows.slice(prevRowCount)
    });

    // Adaptive rate-limit pacing based on actual API calls made this batch.
    // With no RPM limit, enforce a 1 s minimum to avoid quota exhaustion.
    var hasMoreBatches = (start + batch.length) < jobs.length;
    if (hasMoreBatches && toScore.length) {
      var elapsed = Date.now() - batchStartedAt;
      var windowMs = config.scoringRpmLimit > 0
        ? Math.floor(60000 * toScore.length / config.scoringRpmLimit)
        : 1000;
      var sleepMs = windowMs - elapsed;
      if (sleepMs > 0) {
        Utilities.sleep(sleepMs);
      }
    }

    if (_shouldYieldExecution(config) && (start + batch.length) < jobs.length) {
      hitExecutionBudget = true;
      break;
    }
  }

  return {
    rows: rows,
    scoredJobsCount: scoredJobsCount,
    failedJobsCount: failedJobsCount,
    processedCount: processedCount,
    errors: errors,
    failedJobIds: failedJobIds,
    hitExecutionBudget: hitExecutionBudget
  };
}

function _scoreJobsInBatches(jobs, config, progressCallback, totalJobsCount, initialProcessedCount, statusLabel) {
  config._scoringCacheAttempted = false;
  config._scoringCacheName = '';
  return _runSingleStageScoringLoop(jobs, config, progressCallback, totalJobsCount, initialProcessedCount || 0, statusLabel || 'Scoring jobs');
}

function _scoreSingleJobWithRetry(job, config, initialResponse) {
  try {
    return _parseScoreResponseByProvider(initialResponse, config.aiProvider);
  } catch (firstError) {
    Logger.log(firstError);

    var isRateLimit = firstError.message && firstError.message.indexOf('429') !== -1;
    var isCacheMiss = !isRateLimit && firstError.message && firstError.message.indexOf('404') !== -1;
    if (isCacheMiss) {
      // Cache expired — clear in-memory flag so remaining jobs this run skip the stale ID,
      // and purge from PropertiesService so the next trigger doesn't reload and reuse it.
      config._scoringCacheName = '';
      _clearScoringCacheState();
    }
    var noCache = config._scoringCacheName
      ? Object.assign({}, config, { _scoringCacheName: '' })
      : config;

    if (isRateLimit) {
      // Exponential backoff for 429 RESOURCE_EXHAUSTED: wait before each retry
      var backoffDelays = [10000, 30000, 90000];
      var lastErr = firstError;
      for (var i = 0; i < backoffDelays.length; i++) {
        Utilities.sleep(backoffDelays[i]);
        try {
          var rateLimitResp = _executeSingleScoreRequest(_buildScoreRequest(job, noCache));
          return _parseScoreResponseByProvider(rateLimitResp, config.aiProvider);
        } catch (retryErr) {
          lastErr = retryErr;
          Logger.log('Rate-limit retry ' + (i + 1) + ' failed: ' + _truncate(retryErr.message, 120));
          if (retryErr.message.indexOf('429') === -1) break;
        }
      }
      throw new Error('Rate-limit retries exhausted. Last error: ' + _truncate(lastErr.message, 200));
    }

    // Non-429: retry once without cache (original behavior)
    var retryResponse = _executeSingleScoreRequest(_buildScoreRequest(job, noCache));
    try {
      return _parseScoreResponseByProvider(retryResponse, config.aiProvider);
    } catch (retryError) {
      throw new Error(
        'retry failed after initial error [' + _truncate(firstError.message, 120) + '], final error [' +
        _truncate(retryError.message, 120) + ']'
      );
    }
  }
}

function _executeScoreRequests(requests) {
  try {
    return UrlFetchApp.fetchAll(requests);
  } catch (batchError) {
    Logger.log(batchError);
    return requests.map(function(request) {
      return UrlFetchApp.fetch(request.url, _toFetchOptions(request));
    });
  }
}

function _fetchApifyItems(config, progressCallback) {
  if (config.activeRunState && config.activeRunState.sources && config.activeRunState.sources.length) {
    var sources = config.activeRunState.sources;

    // A previous execution was killed mid-poll: sources have runId but no datasetId.
    // Resume waiting for the existing run(s) instead of starting new ones.
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];
      if (!s.runId || s.datasetId) continue;
      var resumeToken = s.token ||
        (s.format === 'detail' ? (config.apifyDetailAccounts[0] || '') : (config.apifyAccounts[0] || ''));
      _emitProgress(progressCallback, { status: 'Resuming Apify wait', processed: '' });
      var runInfo = _waitForRunToFinish(s.runId, s.taskId || s.runId, resumeToken, config);
      s.datasetId = runInfo.defaultDatasetId;
      // Persist the completed datasetId so future resumes skip straight to dataset fetch.
      _saveActiveRunState(config.activeRunState);
    }

    return _fetchItemsForSources(sources, config, progressCallback);
  }

  // Manual detail import: start the apimaestro/linkedin-job-detail actor with the pasted URLs.
  if (config.activeRunState && config.activeRunState.importKind === 'detail') {
    var detailSources = _startJobDetailSource(config, progressCallback);
    config.activeRunState.sources = detailSources;
    return _fetchItemsForSources(detailSources, config, progressCallback);
  }

  return _runTasksAndFetchItems(config, progressCallback);
}

function _startJobDetailSource(config, progressCallback) {
  var jobIds = (config.activeRunState && config.activeRunState.detailJobIds) || [];
  if (!jobIds.length) {
    throw new Error('Manual import has no job IDs to fetch.');
  }
  var runInputJson = _buildJobDetailRunInput(jobIds);
  var source = _tryApifyDetailAccountsInOrder(config, runInputJson, progressCallback);
  return [source];
}

function _buildJobDetailRunInput(jobIds) {
  return JSON.stringify({ job_id: jobIds.map(String) });
}

function _tryApifyDetailAccountsInOrder(config, runInputJson, progressCallback) {
  var props = PropertiesService.getScriptProperties();
  var accounts = config.apifyDetailAccounts;
  var actorId = config.apifyDetailActorId;

  var preferredIdx = parseInt(props.getProperty('APIFY_DETAIL_LAST_WORKING_INDEX') || '0') % accounts.length;
  var token = accounts[preferredIdx];

  Logger.log('[ApifyDetail] Account ' + (preferredIdx + 1) + '/' + accounts.length + ' (preferred)');
  _emitProgress(progressCallback, { status: 'Starting Apify detail (account ' + (preferredIdx + 1) + ')', processed: '' });

  try {
    var runId = _startActorRun(actorId, runInputJson, token);

    // Persist the runId BEFORE waiting so that a mid-poll execution timeout lets the
    // backup trigger resume this same Apify run rather than launching a new one.
    if (config.activeRunState) {
      config.activeRunState.sources = [{ token: token, taskId: actorId, runId: runId, format: 'detail' }];
      _saveActiveRunState(config.activeRunState);
    }

    _emitProgress(progressCallback, { status: 'Waiting for Apify', processed: '' });
    var runInfo = _waitForRunToFinish(runId, actorId, token, config);
    if (!runInfo.defaultDatasetId) throw new Error('No datasetId returned from detail account ' + (preferredIdx + 1) + '.');
    props.setProperty('APIFY_DETAIL_LAST_WORKING_INDEX', String(preferredIdx));
    props.deleteProperty('APIFY_DETAIL_ROTATION_ATTEMPTS');
    Logger.log('[ApifyDetail] Account ' + (preferredIdx + 1) + ' succeeded, run ' + runId);
    return { token: token, taskId: actorId, runId: runId, datasetId: runInfo.defaultDatasetId, format: 'detail' };
  } catch (err) {
    // Execution deadline reached mid-poll — runId is already in PropertiesService.
    // Re-throw without rotation: the Apify run is still alive.
    if (String(err.message).indexOf(APIFY_WAIT_PENDING_PREFIX) === 0) throw err;

    Logger.log('[ApifyDetail] Account ' + (preferredIdx + 1) + ' failed: ' + err);

    if (accounts.length <= 1) {
      throw new Error('Only one Apify detail account configured and it failed: ' + err.message);
    }

    var rotationAttempts = parseInt(props.getProperty('APIFY_DETAIL_ROTATION_ATTEMPTS') || '0');
    if (rotationAttempts >= accounts.length - 1) {
      props.deleteProperty('APIFY_DETAIL_ROTATION_ATTEMPTS');
      throw new Error('All ' + accounts.length + ' Apify detail accounts failed after full rotation. Last error: ' + err.message);
    }

    var nextIdx = (preferredIdx + 1) % accounts.length;
    props.setProperty('APIFY_DETAIL_LAST_WORKING_INDEX', String(nextIdx));
    props.setProperty('APIFY_DETAIL_ROTATION_ATTEMPTS', String(rotationAttempts + 1));
    Logger.log('[ApifyDetail] Rotating to account ' + (nextIdx + 1) + '/' + accounts.length +
      ' (attempt ' + (rotationAttempts + 1) + '/' + (accounts.length - 1) + '). Scheduling fresh retry...');
    _scheduleApifyRotationRetry();

    throw new Error(
      '[ApifyDetail] Account ' + (preferredIdx + 1) + ' failed. Rotated to account ' + (nextIdx + 1) +
      ' — retry scheduled in ~60 s.'
    );
  }
}

function _runTasksAndFetchItems(config, progressCallback) {
  var sources = _startTaskSources(config, progressCallback);
  if (config.activeRunState) {
    config.activeRunState.sources = sources;
  }
  return _fetchItemsForSources(sources, config, progressCallback);
}

function _startTaskSources(config, progressCallback) {
  var runInputJson = _buildApifyRunInput(config);
  var source = _tryApifyAccountsInOrder(config, runInputJson, progressCallback);
  PropertiesService.getScriptProperties().setProperty('LAST_SUCCESSFUL_RUN_AT', new Date().toISOString());
  return [source];
}

function _tryApifyAccountsInOrder(config, runInputJson, progressCallback) {
  var props = PropertiesService.getScriptProperties();
  var accounts = config.apifyAccounts;
  var actorId = config.apifyActorId;

  // Always start from the last known working account.
  var preferredIdx = parseInt(props.getProperty('APIFY_LAST_WORKING_INDEX') || '0') % accounts.length;
  var token = accounts[preferredIdx];

  Logger.log('[Apify] Account ' + (preferredIdx + 1) + '/' + accounts.length + ' (preferred)');
  _emitProgress(progressCallback, { status: 'Starting Apify (account ' + (preferredIdx + 1) + ')', processed: '' });

  try {
    var runId = _startActorRun(actorId, runInputJson, token);

    // Persist the runId BEFORE waiting. If the Apps Script execution is killed during
    // the poll, the backup trigger can resume by polling this same run instead of
    // starting a brand-new one.
    if (config.activeRunState) {
      config.activeRunState.sources = [{ token: token, taskId: actorId, runId: runId }];
      _saveActiveRunState(config.activeRunState);
    }

    _emitProgress(progressCallback, { status: 'Waiting for Apify', processed: '' });
    var runInfo = _waitForRunToFinish(runId, actorId, token, config);
    if (!runInfo.defaultDatasetId) throw new Error('No datasetId returned from account ' + (preferredIdx + 1) + '.');
    // Confirmed working — persist and reset rotation counter.
    props.setProperty('APIFY_LAST_WORKING_INDEX', String(preferredIdx));
    props.deleteProperty('APIFY_ROTATION_ATTEMPTS');
    Logger.log('[Apify] Account ' + (preferredIdx + 1) + ' succeeded, run ' + runId);
    return { token: token, taskId: actorId, runId: runId, datasetId: runInfo.defaultDatasetId };
  } catch (err) {
    // Execution deadline reached mid-poll — runId is already in PropertiesService.
    // Re-throw without rotation: the Apify run is still alive.
    if (String(err.message).indexOf(APIFY_WAIT_PENDING_PREFIX) === 0) throw err;

    Logger.log('[Apify] Account ' + (preferredIdx + 1) + ' failed: ' + err);

    if (accounts.length <= 1) {
      throw new Error('Only one Apify account configured and it failed: ' + err.message);
    }

    // Guard against an infinite rotation loop — stop after trying every account once.
    var rotationAttempts = parseInt(props.getProperty('APIFY_ROTATION_ATTEMPTS') || '0');
    if (rotationAttempts >= accounts.length - 1) {
      props.deleteProperty('APIFY_ROTATION_ATTEMPTS');
      throw new Error('All ' + accounts.length + ' Apify accounts failed after full rotation. Last error: ' + err.message);
    }

    // Rotate to the next account, save it as preferred, then fire a fresh one-shot
    // trigger rather than continuing here — gives the retry a clean 6-min time budget.
    var nextIdx = (preferredIdx + 1) % accounts.length;
    props.setProperty('APIFY_LAST_WORKING_INDEX', String(nextIdx));
    props.setProperty('APIFY_ROTATION_ATTEMPTS', String(rotationAttempts + 1));
    Logger.log('[Apify] Rotating to account ' + (nextIdx + 1) + '/' + accounts.length +
      ' (attempt ' + (rotationAttempts + 1) + '/' + (accounts.length - 1) + '). Scheduling fresh retry...');
    _scheduleApifyRotationRetry();

    throw new Error(
      '[Apify] Account ' + (preferredIdx + 1) + ' failed. Rotated to account ' + (nextIdx + 1) +
      ' — retry scheduled in ~60 s.'
    );
  }
}

function _scheduleApifyRotationRetry() {
  // Remove any stacked rotation retry triggers before creating a new one.
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'runApifyRotationRetry') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runApifyRotationRetry').timeBased().after(60 * 1000).create();
}

function _buildApifyRunInput(config) {
  if (!config.apifyRunInput) return null;

  var fTpr;
  if (config.apifyLookbackHours > 0) {
    fTpr = config.apifyLookbackHours * 3600;
  } else {
    var lastRunIso = PropertiesService.getScriptProperties().getProperty('LAST_SUCCESSFUL_RUN_AT');
    if (lastRunIso) {
      var elapsed = Math.floor((Date.now() - new Date(lastRunIso).getTime()) / 1000);
      var intervalSec = config.runIntervalHours * 3600;
      var maxSec = config.apifyMaxLookbackHours * 3600;
      // Floor at the run interval so a recent manual run or rotation retry never
      // shrinks the lookback window below what the schedule requires.
      fTpr = Math.min(Math.max(elapsed, intervalSec), maxSec);
    } else {
      fTpr = 72 * 3600;
    }
  }

  Logger.log('[Apify] f_tpr = r' + fTpr + 's (' + Math.round(fTpr / 3600) + 'h)');
  return config.apifyRunInput.replace(/\{f_tpr\}/gi, 'r' + String(fTpr));
}

function _fetchItemsForSources(sources, config, progressCallback) {
  var allItems = [];
  sources.forEach(function(source) {
    _emitProgress(progressCallback, {
      status: 'Fetching jobs',
      processed: ''
    });
    var token = source.token ||
      (source.format === 'detail' ? config.apifyDetailAccounts[0] : config.apifyAccounts[0]) || '';
    var responseItems = _fetchDatasetItemsById(
      source.datasetId,
      'task ' + source.taskId + ' run ' + source.runId,
      token
    );
    responseItems.forEach(function(item) {
      allItems.push({
        sourceLabel: source.taskId,
        format: source.format || 'batch',
        item: item
      });
    });
  });

  return allItems;
}

function _getOrCreateActiveRunState(config, progressCallback) {
  if (config.activeRunState) {
    return config.activeRunState;
  }

  return {
    version: 1,
    runStartedAt: config.runStartedAt instanceof Date ? config.runStartedAt.toISOString() : new Date(config.runStartedAt || new Date()).toISOString(),
    sources: _startTaskSources(config, progressCallback),
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

function _buildLookup(values) {
  return (values || []).reduce(function(map, value) {
    if (value) {
      map[String(value)] = true;
    }
    return map;
  }, {});
}

function _appendUniqueStrings(target, values) {
  var seen = _buildLookup(target || []);
  var output = (target || []).slice();

  (values || []).forEach(function(value) {
    var text = _stringifyField(value);
    if (!text || seen[text]) {
      return;
    }
    seen[text] = true;
    output.push(text);
  });

  return output;
}

function _appendErrors(existingErrors, nextErrors) {
  var merged = (existingErrors || []).slice();

  (nextErrors || []).forEach(function(errorText) {
    if (merged.length < 50) {
      merged.push(errorText);
    }
  });

  return merged;
}

function _getMaxJobsPerExecution(config) {
  var batchSize = Math.max(1, Number((config && config.scoringParallelRequests) || 3));
  var rpmLimit  = Number((config && config.scoringRpmLimit) || 0);

  // How long does one batch take?
  // With a rate-limit: the window is forced to 60 * batchSize / RPM seconds.
  // Without: use a conservative 12-second estimate for parallel API calls.
  var secondsPerBatch = rpmLimit > 0
    ? (60 * batchSize / rpmLimit)
    : 12;

  // Stage 2 re-scores roughly 50% of jobs (P01-P05 at default threshold).
  // Use 0.6 as a conservative estimate so Stage 2 doesn't blow the budget.
  var stage2Factor = 1.6;

  // Leave ~60 s for setup, writeJobs, saveState, and scheduleResumeTrigger.
  // executionSoftLimitMs defaults to 300 s (5 min), so scoring budget ≈ 240 s.
  var scoringBudgetSeconds = (Number((config && config.executionSoftLimitMs) || 300000) / 1000) - 60;

  // N jobs → ceil(N/B) Stage-1 batches + ceil(N*0.6/B) Stage-2 batches.
  // Solve for N: N = scoringBudget / (stage2Factor * secondsPerBatch / batchSize)
  var computed = Math.floor(scoringBudgetSeconds * batchSize / (stage2Factor * secondsPerBatch));

  // Honor an explicit user override (from SCORING_MAX_JOBS_PER_EXECUTION setting),
  // but never let it exceed the time-derived safe limit.
  var explicit = Number((config && config.maxJobsPerExecution) || 0);
  var limit = explicit > 0 ? Math.min(explicit, computed) : computed;

  return Math.max(1, limit);
}

var CANCEL_REQUEST_KEY = 'PIPELINE_CANCEL_REQUESTED';

function _isCancelRequested() {
  return PropertiesService.getScriptProperties().getProperty(CANCEL_REQUEST_KEY) === 'true';
}

function _clearCancelRequest() {
  PropertiesService.getScriptProperties().deleteProperty(CANCEL_REQUEST_KEY);
}

function _shouldYieldExecution(config) {
  var bufferMs = Number((config && config.executionYieldBufferMs) || 45000);
  var deadlineMs = Number((config && config.executionDeadlineMs) || 0);

  if (!deadlineMs) {
    return false;
  }

  return (Date.now() + bufferMs) >= deadlineMs;
}

function _startActorRun(actorId, runInputJson, token) {
  var options = { method: 'post', muteHttpExceptions: true };
  if (runInputJson) {
    options.contentType = 'application/json';
    options.payload = runInputJson;
  }
  var response = UrlFetchApp.fetch(
    'https://api.apify.com/v2/acts/' + encodeURIComponent(actorId) + '/runs?token=' + encodeURIComponent(token),
    options
  );
  var runInfo = _parseApifyObjectResponse(response, 'actor run start ' + actorId);

  if (!runInfo.id) {
    throw new Error('Actor ' + actorId + ' did not return a run id.');
  }

  return runInfo.id;
}

function _waitForRunToFinish(runId, sourceLabel, token, config) {
  var pollDeadline = Date.now() + (config.apifyRunWaitSeconds * 1000);
  // Leave a 60 s buffer before the Apps Script 6-min hard kill.
  // executionDeadlineMs is set to Date.now()+300 000 at loadRuntimeConfig() time,
  // which is typically ~30 s into the execution, giving an effective safety margin.
  var execDeadline = (config && config.executionDeadlineMs) ? Number(config.executionDeadlineMs) : Infinity;
  var EXEC_BUFFER_MS = 60000;

  while (Date.now() <= pollDeadline) {
    if (_isCancelRequested()) {
      _clearCancelRequest();
      throw new Error('Apify wait cancelled by user.');
    }

    // Approaching the Apps Script execution wall — yield gracefully.
    // The caller has already persisted the runId in PropertiesService, so the
    // resume trigger will poll this same run instead of starting a new one.
    if (Date.now() + EXEC_BUFFER_MS >= execDeadline) {
      throw new Error(APIFY_WAIT_PENDING_PREFIX + runId);
    }

    var runInfo = _getRunInfo(runId, token);
    var status = String(runInfo.status || '');

    if (_isRunStatusSuccess(status)) {
      return runInfo;
    }

    if (_isRunStatusFailure(status)) {
      throw new Error(
        'Apify run failed for ' + sourceLabel + ' with status ' + status +
        (runInfo.statusMessage ? ': ' + runInfo.statusMessage : '')
      );
    }

    Utilities.sleep(config.apifyPollIntervalMs);
  }

  throw new Error(
    'Timed out waiting for Apify run ' + runId + ' from ' + sourceLabel +
    ' after ' + config.apifyRunWaitSeconds + ' seconds.'
  );
}

function _getRunInfo(runId, token) {
  var response = UrlFetchApp.fetch(
    'https://api.apify.com/v2/actor-runs/' + encodeURIComponent(runId) + '?token=' + encodeURIComponent(token),
    { muteHttpExceptions: true }
  );

  return _parseApifyObjectResponse(response, 'run ' + runId);
}

function _resurrectApifyRun(runId, token) {
  var response = UrlFetchApp.fetch(
    'https://api.apify.com/v2/actor-runs/' + encodeURIComponent(runId) + '/resurrect?token=' + encodeURIComponent(token),
    {
      method: 'post',
      muteHttpExceptions: true
    }
  );

  return _parseApifyObjectResponse(response, 'resurrect run ' + runId);
}

function _fetchDatasetItemsById(datasetId, sourceLabel, token) {
  var response = UrlFetchApp.fetch(
    'https://api.apify.com/v2/datasets/' + encodeURIComponent(datasetId) + '/items?clean=true&format=json&token=' + encodeURIComponent(token),
    { muteHttpExceptions: true }
  );

  return _parseApifyArrayResponse(response, sourceLabel);
}

function _getDatasetMetadata(datasetId, token) {
  var url = 'https://api.apify.com/v2/datasets/' + encodeURIComponent(datasetId) +
            (token ? '?token=' + encodeURIComponent(token) : '');
  var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  return _parseApifyObjectResponse(response, 'dataset ' + datasetId);
}

function _listActorRuns(actorId, token, limit) {
  var url = 'https://api.apify.com/v2/acts/' + encodeURIComponent(actorId) +
            '/runs?status=SUCCEEDED&sortBy=startedAt&desc=1&limit=' + limit +
            (token ? '&token=' + encodeURIComponent(token) : '');
  var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  var code = response.getResponseCode();
  if (code >= 300) return [];
  try {
    var parsed = JSON.parse(response.getContentText());
    var data = parsed.data || parsed;
    return Array.isArray(data.items) ? data.items : [];
  } catch (e) { return []; }
}

function _parseApifyArrayResponse(response, sourceLabel) {
  var code = response.getResponseCode();
  var body = response.getContentText();

  if (code >= 300) {
    throw new Error('Apify request failed for ' + sourceLabel + ': ' + code + ' ' + _truncate(body, 300));
  }

  var parsed = JSON.parse(body);
  if (!Array.isArray(parsed)) {
    throw new Error('Apify response for ' + sourceLabel + ' was not an array.');
  }

  return parsed;
}

function _parseApifyObjectResponse(response, sourceLabel) {
  var code = response.getResponseCode();
  var body = response.getContentText();

  if (code >= 300) {
    throw new Error('Apify request failed for ' + sourceLabel + ': ' + code + ' ' + _truncate(body, 300));
  }

  var parsed = JSON.parse(body);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Apify response for ' + sourceLabel + ' was not an object.');
  }

  return parsed.data || parsed;
}

function _isRunStatusSuccess(status) {
  return status === 'SUCCEEDED';
}

function _isRunStatusFailure(status) {
  return status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT';
}

function _normalizeJob(item, sourceLabel, runStartedAt) {
  var description = _truncate(_cleanJobDescription(_pickFirstValue(item, [
    'jobDescription',
    'descriptionText',
    'description',
    'job_description',
    'details'
  ])), 12000);
  var company = _stringifyField(_pickFirstValue(item, ['companyName', 'company', 'organizationName']));
  var title = _stringifyField(_pickFirstValue(item, ['jobTitle', 'title', 'positionName']));
  var location = _stringifyField(_pickFirstValue(item, ['location', 'jobLocation', 'formattedLocation']));
  var postedLabel = _stringifyField(_pickFirstValue(item, ['postedTime', 'postedAt', 'posted', 'publishedAt', 'listedAt']));
  var postedDate = _derivePostedDate(item, postedLabel, runStartedAt);
  var applicants = _normalizeApplicantsCount(_pickFirstValue(item, [
    'applicantsCount',
    'applicantCount',
    'applicationsCount',
    'applicants'
  ]));
  var rawJobLink = _stringifyField(_pickFirstValue(item, ['jobUrl', 'applyUrl', 'url', 'link', 'postingUrl']));
  var jobId = _resolveJobId(item, rawJobLink);
  var jobLink = _buildLinkedInJobUrlFromJobId(jobId) || rawJobLink;
  var searchString = _stringifyField(_pickFirstValue(item, ['searchString', 'searchQuery', 'query']));
  var contractType = _stringifyField(_pickFirstValue(item, ['contractType', 'employmentType']));
  var experienceLevel = _stringifyField(_pickFirstValue(item, ['experienceLevel', 'seniorityLevel']));
  var workType = _stringifyField(_pickFirstValue(item, ['workType', 'functionArea']));
  var publishedAt = _stringifyField(_pickFirstValue(item, ['publishedAt', 'postedAt', 'createdAt']));
  var importedAt = runStartedAt ? new Date(runStartedAt.getTime()) : new Date();

  return {
    jobId: jobId,
    company: company,
    title: title,
    location: location,
    posted: postedDate ? _formatDateTimeForDisplay(postedDate) : postedLabel,
    applicants: applicants,
    jobLink: jobLink,
    sourceUrl: rawJobLink,
    summary: '',
    why: '',
    titleLevel: '',
    jdImpliedLevel: '',
    priority: '',
    score: '',
    status: 'New',
    importedAt: importedAt,
    scoredAt: '',
    sourceTask: searchString || sourceLabel || '',
    rawRef: _serializeRawRef(item),
    jobDescription: description,
    contractType: contractType,
    experienceLevel: experienceLevel,
    workType: workType,
    publishedAt: publishedAt
  };
}

// Normalizer for the apimaestro/linkedin-job-detail actor, whose JSON nests data under
// job_info / company_info / apply_details / salary_info. Maps to the same job record shape
// _normalizeJob produces, so everything downstream (scoring, writeJobs, dedup) is unchanged.
function _normalizeJobDetail(item, sourceLabel, runStartedAt) {
  var info = (item && item.job_info) || {};
  var companyInfo = (item && item.company_info) || {};
  var applyInfo = (item && item.apply_details) || {};
  var salaryInfo = (item && item.salary_info) || null;

  var company = _stringifyField(companyInfo.name);
  var title = _stringifyField(info.title);
  var location = _stringifyField(info.location);
  var rawDescription = _truncate(_cleanJobDescription(_stringifyField(info.description)), 12000);

  // Prepend a one-line salary banner (when structured comp is provided) so the scorer sees it.
  var salaryBanner = _formatDetailSalaryBanner(salaryInfo);
  var description = salaryBanner ? _truncate(salaryBanner + '\n\n' + rawDescription, 12000) : rawDescription;

  var postedLabel = _stringifyField(info.listed_at || info.original_listed_at);
  var postedDate = _derivePostedDate(info, postedLabel, runStartedAt);
  var applicants = _normalizeApplicantsCount(applyInfo.total_applies);

  var rawJobLink = _stringifyField(info.job_url);
  // job_posting_id arrives as a JSON number — stringify before the regex-based extractor.
  var jobId = _extractLinkedInJobId(_stringifyField(info.job_posting_id)) ||
              _resolveJobId(info, rawJobLink);
  var jobLink = _buildLinkedInJobUrlFromJobId(jobId) || rawJobLink;

  var contractType = _stringifyField(info.employment_status);
  var experienceLevel = _stringifyField(info.experience_level);
  var workType = _stringifyField((info.workplace_types && info.workplace_types[0]) || '');
  var publishedAt = _stringifyField(info.listed_at);
  var importedAt = runStartedAt ? new Date(runStartedAt.getTime()) : new Date();

  // Flag postings LinkedIn has already closed/expired so the owner notices.
  var jobState = _stringifyField(info.job_state).toUpperCase();
  var referralContact = jobState === 'CLOSED' ? '⚠ Closed/expired on LinkedIn' : '';

  // Mark the raw payload's format so the nested-aware raw-ref readers know how to dig in later.
  var markedItem = item || {};
  markedItem.__sourceFormat = 'apimaestro-job-detail';

  return {
    jobId: jobId,
    company: company,
    title: title,
    location: location,
    posted: postedDate ? _formatDateTimeForDisplay(postedDate) : postedLabel,
    applicants: applicants,
    jobLink: jobLink,
    sourceUrl: rawJobLink,
    summary: '',
    why: '',
    titleLevel: '',
    jdImpliedLevel: '',
    priority: '',
    score: '',
    status: 'New',
    referralContact: referralContact,
    importedAt: importedAt,
    scoredAt: '',
    sourceTask: sourceLabel || APIFY_JOB_DETAIL_ACTOR_ID,
    rawRef: _serializeRawRef(markedItem),
    jobDescription: description,
    contractType: contractType,
    experienceLevel: experienceLevel,
    workType: workType,
    publishedAt: publishedAt
  };
}

function _formatDetailSalaryBanner(salaryInfo) {
  if (!salaryInfo) return '';
  var min = _formatSalaryNumber(salaryInfo.min_salary);
  var max = _formatSalaryNumber(salaryInfo.max_salary);
  var currency = _stringifyField(salaryInfo.currency_code);
  var period = _stringifyField(salaryInfo.pay_period);
  if (!min && !max) return '';
  var amount = (min && max) ? (min + '–' + max) : (min || max);
  return ('Salary: ' + amount + (currency ? ' ' + currency : '') + (period ? ' / ' + period : '')).trim();
}

function _formatSalaryNumber(value) {
  var n = Number(value);
  if (!isFinite(n) || n <= 0) return '';
  return String(Math.round(n));
}

function _resolveJobId(item, rawJobLink) {
  var directJobId = _extractLinkedInJobId(_pickFirstValue(item, ['linkedinJobId', 'jobId', 'jobPostingId']));
  if (directJobId) {
    return directJobId;
  }

  if (rawJobLink) {
    directJobId = _extractLinkedInJobId(rawJobLink);
    if (directJobId) {
      return directJobId;
    }
    return 'url_' + _sha1(rawJobLink);
  }

  return 'hash_' + _sha1(JSON.stringify(item || {}));
}

function _buildLinkedInJobUrlFromJobId(jobId) {
  var resolvedJobId = _extractLinkedInJobId(jobId);
  if (!resolvedJobId) {
    return '';
  }

  return 'https://www.linkedin.com/jobs/view/' + encodeURIComponent(resolvedJobId) + '/';
}

function _extractLinkedInJobId(value) {
  var text = _stringifyField(value);
  var match = null;

  if (!text) {
    return '';
  }

  if (/^\d+$/.test(text)) {
    return text;
  }

  match = text.match(/^linkedin_(\d+)$/i);
  if (match) {
    return match[1];
  }

  match = text.match(/\/jobs\/view\/(\d+)(?:[/?]|$)/i);
  if (match) {
    return match[1];
  }

  match = text.match(/\/jobs\/view\/[^?/#]*-(\d+)(?:[/?]|$|\?)/i);
  if (match) {
    return match[1];
  }

  return '';
}

function _derivePostedDate(item, postedLabel, anchorDate) {
  var relativeDate = _parseRelativePosted(postedLabel, anchorDate);
  var directDate = _pickFirstValue(item, ['publishedAt', 'listedAt', 'postedAt', 'createdAt']);

  if (relativeDate) {
    return relativeDate;
  }

  if (directDate) {
    var parsedDate = new Date(directDate);
    if (!isNaN(parsedDate.getTime())) {
      return parsedDate;
    }
  }

  return '';
}

function _parseRelativePosted(postedLabel, anchorDate) {
  if (!postedLabel) {
    return '';
  }

  var label = String(postedLabel).trim().toLowerCase();
  if (label === 'just now') {
    return anchorDate ? new Date(anchorDate.getTime()) : new Date();
  }

  var match = label.match(/(\d+)\s*(minute|minutes|min|m|hour|hours|hr|h|day|days|d|week|weeks|w)\s*(?:ago)?/);

  if (!match) {
    return '';
  }

  var amount = Number(match[1]);
  var unit = match[2];
  var now = anchorDate ? new Date(anchorDate.getTime()) : new Date();
  var minutes = 0;

  if (unit === 'minute' || unit === 'minutes' || unit === 'min' || unit === 'm') {
    minutes = amount;
  } else if (unit === 'hour' || unit === 'hours' || unit === 'hr' || unit === 'h') {
    minutes = amount * 60;
  } else if (unit === 'day' || unit === 'days' || unit === 'd') {
    minutes = amount * 60 * 24;
  } else if (unit === 'week' || unit === 'weeks' || unit === 'w') {
    minutes = amount * 60 * 24 * 7;
  }

  return new Date(now.getTime() - minutes * 60 * 1000);
}

function _formatDateTimeForDisplay(date) {
  if (!date || isNaN(date.getTime())) {
    return '';
  }

  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'M/d/yyyy h:mm a');
}

function _buildScoreRequest(job, config) {
  if (config.aiProvider === 'gemini') {
    return _buildGeminiScoreRequest(job, config);
  }

  if (config.aiProvider === 'openai') {
    return _buildOpenAiScoreRequest(job, config);
  }

  throw new Error('Unsupported AI provider: ' + config.aiProvider);
}

function _buildGeminiScoreRequest(job, config) {
  var generationConfig = {
    temperature: 0.2,
    responseMimeType: 'application/json'
  };
  var payload;

  if (config._scoringCacheName) {
    // Cached prefix — only send the dynamic job content
    payload = {
      cachedContent: config._scoringCacheName,
      contents: [{ role: 'user', parts: [{ text: _buildDynamicJobContent(job) }] }],
      generationConfig: generationConfig
    };
  } else {
    // Full prompt fallback
    payload = {
      contents: [{
        role: 'user',
        parts: [{ text: 'You score product management jobs for a single power user. Return strict JSON only.\n\n' + _buildScoringPrompt(job, config) }]
      }],
      generationConfig: generationConfig
    };
  }

  if (config.geminiApiRoute === 'vertex') {
    generationConfig.responseSchema = _getScoreResponseSchema();
    return {
      url: 'https://aiplatform.googleapis.com/v1/projects/' +
        encodeURIComponent(config.vertexProjectId) +
        '/locations/' + encodeURIComponent(config.vertexLocation) +
        '/publishers/google/models/' + encodeURIComponent(config.scoringModel) +
        ':generateContent',
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };
  }

  generationConfig.responseJsonSchema = _getScoreResponseSchema();
  return {
    url: 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(config.scoringModel) + ':generateContent',
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': config.geminiApiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
}

function _buildOpenAiScoreRequest(job, config) {
  var prompt = _buildScoringPrompt(job, config);
  var payload = {
    model: config.scoringModel,
    messages: [
      {
        role: 'system',
        content: 'You score product management jobs for a single power user. Return strict JSON only.'
      },
      {
        role: 'user',
        content: prompt
      }
    ],
    response_format: {
      type: 'json_object'
    },
    temperature: 0.2
  };

  return {
    url: 'https://api.openai.com/v1/chat/completions',
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + config.openAiApiKey
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
}

function _buildStaticScoringContent(config) {
  return [
    'You score product management jobs for a single power user. Return strict JSON only.',
    '',
    'Target profile:',
    config.targetProfile,
    '',
    'Scoring instructions:',
    config.scoringInstructions
  ].join('\n');
}

function _buildDynamicJobContent(job) {
  return [
    'Job:',
    'Company: ' + job.company,
    'Title: ' + job.title,
    'Location: ' + job.location,
    'Contract type: ' + job.contractType,
    'Experience level: ' + job.experienceLevel,
    'Work type: ' + job.workType,
    'Posted: ' + job.posted,
    'Published at: ' + job.publishedAt,
    'Applicants: ' + job.applicants,
    'Source: ' + job.sourceTask,
    'Description:',
    job.jobDescription || ''
  ].join('\n');
}

function _buildFingerprintJobContent(job) {
  return [
    'Company: ' + (job.company || ''),
    'Title: ' + (job.title || ''),
    'Contract type: ' + (job.contractType || ''),
    'Experience level: ' + (job.experienceLevel || ''),
    'Work type: ' + (job.workType || ''),
    'Description:',
    job.jobDescription || ''
  ].join('\n');
}

function _buildScoringPrompt(job, config) {
  return [
    'Target profile:',
    config.targetProfile,
    '',
    'Scoring instructions:',
    config.scoringInstructions,
    '',
    _buildDynamicJobContent(job)
  ].join('\n');
}

function _getScoringCacheFingerprint(config) {
  return _sha1(config.scoringModel + '|' + config.promptVersion + '|' + _buildStaticScoringContent(config));
}

function _loadScoringCacheState() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(SCORING_CACHE_STATE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function _saveScoringCacheState(state) {
  PropertiesService.getScriptProperties().setProperty(SCORING_CACHE_STATE_KEY, JSON.stringify(state));
}

function _clearScoringCacheState() {
  PropertiesService.getScriptProperties().deleteProperty(SCORING_CACHE_STATE_KEY);
}

function _getOrCreateScoringCache(config) {
  if (config.aiProvider !== 'gemini') return null;

  var fingerprint = _getScoringCacheFingerprint(config);
  var stored = _loadScoringCacheState();

  if (stored && stored.fingerprint === fingerprint && stored.name) {
    return stored.name;
  }

  try {
    var name = _createGeminiCachedContent(config);
    if (name) {
      _saveScoringCacheState({ name: name, fingerprint: fingerprint });
    }
    return name || null;
  } catch (e) {
    Logger.log('Gemini cache creation failed, falling back to uncached: ' + e.message);
    return null;
  }
}

function _createGeminiCachedContent(config) {
  var staticContent = _buildStaticScoringContent(config);
  var payload;
  var request;

  if (config.geminiApiRoute === 'vertex') {
    payload = {
      model: 'projects/' + config.vertexProjectId + '/locations/' + config.vertexLocation + '/publishers/google/models/' + config.scoringModel,
      contents: [{ role: 'user', parts: [{ text: staticContent }] }],
      ttl: SCORING_CACHE_TTL_SECONDS + 's'
    };
    request = {
      url: 'https://aiplatform.googleapis.com/v1beta1/projects/' + encodeURIComponent(config.vertexProjectId) +
        '/locations/' + encodeURIComponent(config.vertexLocation) + '/cachedContents',
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };
  } else {
    payload = {
      model: 'models/' + config.scoringModel,
      contents: [{ role: 'user', parts: [{ text: staticContent }] }],
      ttl: SCORING_CACHE_TTL_SECONDS + 's'
    };
    request = {
      url: 'https://generativelanguage.googleapis.com/v1beta/cachedContents',
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': config.geminiApiKey },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };
  }

  var response = UrlFetchApp.fetch(request.url, _toFetchOptions(request));
  var code = response.getResponseCode();
  var body = response.getContentText();

  if (code >= 300) {
    Logger.log('Gemini cachedContent creation failed: ' + code + ' ' + _truncate(body, 300));
    return null;
  }

  var parsed = JSON.parse(body);
  return parsed.name || null;
}

function _parseScoreResponseByProvider(response, aiProvider) {
  if (aiProvider === 'gemini') {
    return _parseGeminiScoreResponse(response);
  }

  if (aiProvider === 'openai') {
    return _parseOpenAiScoreResponse(response);
  }

  throw new Error('Unsupported AI provider: ' + aiProvider);
}

function _parseGeminiScoreResponse(response) {
  var code = response.getResponseCode();
  var body = response.getContentText();

  if (code >= 300) {
    throw new Error('Gemini request failed: ' + code + ' ' + _truncate(body, 300));
  }

  var parsedResponse = JSON.parse(body);
  var candidate = parsedResponse &&
    parsedResponse.candidates &&
    parsedResponse.candidates[0];
  var parts = candidate &&
    candidate.content &&
    candidate.content.parts;
  var content = _extractGeminiText(parts);

  if (!content) {
    throw new Error('Gemini response did not include candidate text.');
  }

  return _normalizeScorePayload(_parseJsonSafely(content));
}

function _parseOpenAiScoreResponse(response) {
  var code = response.getResponseCode();
  var body = response.getContentText();

  if (code >= 300) {
    throw new Error('OpenAI request failed: ' + code + ' ' + _truncate(body, 300));
  }

  var parsedResponse = JSON.parse(body);
  var content = parsedResponse &&
    parsedResponse.choices &&
    parsedResponse.choices[0] &&
    parsedResponse.choices[0].message &&
    parsedResponse.choices[0].message.content;

  if (!content) {
    throw new Error('OpenAI response did not include message content.');
  }

  return _normalizeScorePayload(_parseJsonSafely(content));
}

function _normalizeScorePayload(parsedContent) {
  return {
    score: _normalizeScore(parsedContent.score),
    priority: _normalizePriority(parsedContent.priority),
    usVisaSponsorshipPotential: _normalizeVisaSponsorshipPotential(parsedContent.us_visa_sponsorship_potential),
    usVisaReason: _truncate(_stringifyField(parsedContent.us_visa_reason), 220),
    summary: _truncate(_stringifyField(parsedContent.summary), 200),
    why: _truncate(_stringifyField(parsedContent.why), 300),
    titleLevel: _normalizeJobLevel(parsedContent.title_level),
    jdImpliedLevel: _normalizeJobLevel(parsedContent.jd_implied_level),
    levelNormalized: _normalizeJobLevel(parsedContent.level_normalized),
    requiresPeopleMgmt: parsedContent.requires_people_mgmt === true || String(parsedContent.requires_people_mgmt).toLowerCase() === 'true',
    requiredYoePm: _normalizeYoe(parsedContent.required_yoe_pm),
    requiredYoeTotal: _normalizeYoe(parsedContent.required_yoe_total)
  };
}

function _normalizeYoe(value) {
  var n = parseInt(value, 10);
  if (isNaN(n) || n < 0) return '';
  return n;
}

function _buildScoringFingerprint(job, config) {
  return _sha1([
    config.aiProvider || '',
    config.geminiApiRoute || '',
    config.scoringModel || '',
    config.promptVersion || '',
    _buildStaticScoringContent(config),
    _buildFingerprintJobContent(job)
  ].join('|'));
}

function _getScoreResponseSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      score: {
        type: 'integer',
        minimum: 0,
        maximum: 100,
        description: 'Overall fit score from 0 to 100.'
      },
      priority: {
        type: 'string',
        enum: ['P01', 'P02', 'P03', 'P04', 'P05', 'P06', 'P07', 'P08', 'P09', 'P10'],
        description: 'Priority bucket.'
      },
      us_visa_sponsorship_potential: {
        type: 'string',
        enum: ['Yes (100%)', 'Likely (90%)', 'Possible (70%)', 'Unclear (50%)', 'US required (40%)', 'Unlikely (20%)', 'No (0%)'],
        description: 'Estimated US visa sponsorship potential, with an informational probability anchor.'
      },
      us_visa_reason: {
        type: 'string',
        description: 'One short sentence explaining the evidence for the visa label.'
      },
      summary: {
        type: 'string',
        description: 'One short sentence describing what the job is about.'
      },
      why: {
        type: 'string',
        description: 'One short sentence explaining the fit or skip reason.'
      },
      title_level: {
        type: 'string',
        enum: ['APM', 'PM', 'Senior-PM', 'Staff-PM', 'Principal-PM', 'Manager', 'Senior-Manager', 'Group-PM', 'Director', 'Senior-Director', 'VP', 'Head-of-Product', 'Founding-PM', 'Unknown'],
        description: 'Seniority level extracted from the job title string only — do not read the JD body for this field.'
      },
      jd_implied_level: {
        type: 'string',
        enum: ['APM', 'PM', 'Senior-PM', 'Staff-PM', 'Principal-PM', 'Manager', 'Senior-Manager', 'Group-PM', 'Director', 'Senior-Director', 'VP', 'Head-of-Product', 'Founding-PM', 'Unknown'],
        description: 'IC scope/seniority implied by the JD body only — ignore the job title; do NOT encode people-management here.'
      },
      level_normalized: {
        type: 'string',
        enum: ['APM', 'PM', 'Senior-PM', 'Staff-PM', 'Principal-PM', 'Manager', 'Senior-Manager', 'Group-PM', 'Director', 'Senior-Director', 'VP', 'Head-of-Product', 'Founding-PM', 'Unknown'],
        description: 'Real market level after reconciling title_level and jd_implied_level THROUGH the company leveling regime (deflate big-tech / inflate startup / bank-VP band).'
      },
      requires_people_mgmt: {
        type: 'boolean',
        description: 'True only if the JD requires managing/leading/growing a team of PMs or direct reports (drives the hard veto). False for IC work.'
      },
      required_yoe_pm: {
        type: 'integer',
        minimum: 0,
        description: 'Minimum years of product-management-specific experience the JD requires; 0 if unspecified.'
      },
      required_yoe_total: {
        type: 'integer',
        minimum: 0,
        description: 'Minimum years of overall/general experience the JD requires; 0 if unspecified.'
      }
    },
    required: ['score', 'priority', 'us_visa_sponsorship_potential', 'us_visa_reason', 'summary', 'why', 'title_level', 'jd_implied_level', 'level_normalized', 'requires_people_mgmt', 'required_yoe_pm', 'required_yoe_total']
  };
}

function _extractGeminiText(parts) {
  if (!parts || !parts.length) {
    return '';
  }

  return parts
    .map(function(part) {
      return part && part.text ? part.text : '';
    })
    .join('\n')
    .trim();
}

function _parseHourSetting(value, defaultValue) {
  var parsed = Math.floor(Number(value));
  return (isNaN(parsed) || parsed < 0 || parsed > 23) ? defaultValue : parsed;
}

function _isInQuietHours(quietStartHour, quietEndHour) {
  if (quietStartHour === quietEndHour) return false;
  var currentHour = Number(Utilities.formatDate(new Date(), 'America/Los_Angeles', 'H'));
  if (quietStartHour > quietEndHour) {
    // window wraps midnight: e.g. 19 → 5 means quiet if hour >= 19 OR hour < 5
    return currentHour >= quietStartHour || currentHour < quietEndHour;
  }
  return currentHour >= quietStartHour && currentHour < quietEndHour;
}

function _normalizePositiveInteger(value, defaultValue, maxValue) {
  var parsed = Number(value);

  if (isNaN(parsed) || parsed < 1) {
    return defaultValue;
  }

  parsed = Math.floor(parsed);
  if (maxValue && parsed > maxValue) {
    return maxValue;
  }

  return parsed;
}

function _resolveDefaultableSetting(value, defaultFn) {
  var text = _stringifyField(value);

  if (!text || text.toLowerCase() === 'default') {
    return String(defaultFn());
  }

  return text;
}

function _toFetchOptions(request) {
  return {
    method: request.method,
    contentType: request.contentType,
    headers: request.headers,
    payload: request.payload,
    muteHttpExceptions: request.muteHttpExceptions
  };
}

function _executeSingleScoreRequest(request) {
  return UrlFetchApp.fetch(request.url, _toFetchOptions(request));
}

function _emitProgress(progressCallback, state) {
  if (typeof progressCallback === 'function') {
    progressCallback(state);
  }
}

function _parseJsonSafely(content) {
  var cleaned = String(content)
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '');

  return JSON.parse(cleaned);
}

function _normalizeScore(value) {
  var score = Number(value);
  if (isNaN(score)) {
    return '';
  }

  score = Math.round(score);
  return Math.max(0, Math.min(100, score));
}

function _normalizePriority(value) {
  var priority = _stringifyField(value).toUpperCase();
  var allowed = {
    P01: true,
    P02: true,
    P03: true,
    P04: true,
    P05: true,
    P06: true,
    P07: true,
    P08: true,
    P09: true,
    P10: true
  };
  var legacyMap = {
    A: 'P01',
    B: 'P05',
    C: 'P07',
    SKIP: 'P10'
  };

  if (allowed[priority]) {
    return priority;
  }

  if (legacyMap[priority]) {
    return legacyMap[priority];
  }

  return 'P07';
}

function _isTopPriority(value) {
  return _normalizePriority(value) === 'P01';
}

function _normalizeJobLevel(value) {
  var VALID_LEVELS = {
    'APM': true, 'PM': true, 'Senior-PM': true, 'Staff-PM': true,
    'Principal-PM': true, 'Manager': true, 'Senior-Manager': true,
    'Group-PM': true, 'Director': true, 'Senior-Director': true,
    'VP': true, 'Head-of-Product': true, 'Founding-PM': true, 'Unknown': true
  };
  var text = _stringifyField(value);
  if (VALID_LEVELS[text]) return text;
  var keys = Object.keys(VALID_LEVELS);
  var lower = text.toLowerCase();
  for (var i = 0; i < keys.length; i += 1) {
    if (keys[i].toLowerCase() === lower) return keys[i];
  }
  return 'Unknown';
}

function _normalizeVisaSponsorshipPotential(value) {
  var allowed = {
    'Yes (100%)': true,
    'Likely (90%)': true,
    'Possible (70%)': true,
    'Unclear (50%)': true,
    'US required (40%)': true,
    'Unlikely (20%)': true,
    'No (0%)': true
  };
  var potential = _stringifyField(value);
  return allowed[potential] ? potential : 'Unclear (50%)';
}

function _dedupeJobsByJobId(jobs) {
  var seenJobIds = {};
  var dedupedJobs = [];

  (jobs || []).forEach(function(job) {
    var jobId = _stringifyField(job && job.jobId);

    if (!jobId || seenJobIds[jobId]) {
      return;
    }

    seenJobIds[jobId] = true;
    dedupedJobs.push(job);
  });

  return dedupedJobs;
}

function _buildCandidateJob(job, existing) {
  var candidate = _cloneJobRecord(job);
  var preservedJobId = '';

  if (!existing) {
    return candidate;
  }

  // Stable PK: existing sheet ID is canonical; incoming Apify ID is only a fallback for new rows.
  preservedJobId = _extractLinkedInJobId(existing.jobId) ||
    _extractLinkedInJobId(candidate.jobId) ||
    _stringifyField(existing.jobId) ||
    _stringifyField(candidate.jobId);

  candidate.existingRowNumber = existing.rowNumber;
  candidate.jobId = preservedJobId || '';
  candidate.jobLink = _buildLinkedInJobUrlFromJobId(candidate.jobId) ||
    _stringifyField(candidate.jobLink) ||
    _buildLinkedInJobUrlFromJobId(existing.jobId) ||
    _stringifyField(existing.jobLink) ||
    _stringifyField(existing.sourceUrl) ||
    '';
  candidate.sourceUrl = _stringifyField(candidate.sourceUrl) || _stringifyField(existing.sourceUrl) || '';
  candidate.sourceTask = _stringifyField(candidate.sourceTask) || _stringifyField(existing.sourceTask) || '';
  candidate.jobDescription = _stringifyField(candidate.jobDescription) || _stringifyField(existing.jobDescription) || '';
  candidate.rawRef = _stringifyField(candidate.rawRef) || _stringifyField(existing.rawRef) || '';
  candidate.company = _stringifyField(candidate.company) || _stringifyField(existing.company) || '';
  candidate.title = _stringifyField(candidate.title) || _stringifyField(existing.title) || '';
  candidate.location = _stringifyField(candidate.location) || _stringifyField(existing.location) || '';
  candidate.posted = _stringifyField(candidate.posted) || _stringifyField(existing.posted) || '';
  candidate.applicants = _stringifyField(candidate.applicants) || _stringifyField(existing.applicants) || '';
  candidate.contractType = _stringifyField(candidate.contractType) || _stringifyField(existing.contractType) || '';
  candidate.experienceLevel = _stringifyField(candidate.experienceLevel) || _stringifyField(existing.experienceLevel) || '';
  candidate.workType = _stringifyField(candidate.workType) || _stringifyField(existing.workType) || '';
  candidate.publishedAt = _stringifyField(candidate.publishedAt) || _stringifyField(existing.publishedAt) || '';
  candidate.status = existing.status || 'New';
  candidate.importedAt = existing.importedAt || candidate.importedAt;
  candidate.scoredAt = existing.scoredAt || '';
  candidate.score = existing.score === undefined ? '' : existing.score;
  candidate.priority = existing.priority || '';
  candidate.usVisaSponsorshipPotential = existing.usVisaSponsorshipPotential || '';
  candidate.usVisaReason = existing.usVisaReason || '';
  candidate.summary = existing.summary || '';
  candidate.why = existing.why || '';
  candidate.titleLevel = existing.titleLevel || '';
  candidate.jdImpliedLevel = existing.jdImpliedLevel || '';
  candidate.levelNormalized = existing.levelNormalized || '';
  candidate.requiresPeopleMgmt = existing.requiresPeopleMgmt;
  candidate.requiredYoePm = existing.requiredYoePm;
  candidate.requiredYoeTotal = existing.requiredYoeTotal;
  candidate.scoringFingerprint = existing.scoringFingerprint || '';
  // User-managed fields — never overwrite with Apify data; always carry forward from the sheet
  candidate.owner = existing.owner || '';
  candidate.action = existing.action || '';
  candidate.referralContact = existing.referralContact || '';
  candidate.mergedJobIds = existing.mergedJobIds || '';

  return candidate;
}

function _refreshStoredJobForReevaluation(existing) {
  var refreshed = _cloneJobRecord(existing);
  var rawRefData = _parseRawRefObject(existing.rawRef);
  var recoveredDescription = _extractJobDescriptionFromRawRef(existing.rawRef);
  var recoveredJobId = _extractLinkedInJobId(_pickFirstValue(rawRefData, ['linkedinJobId', 'jobId', 'jobPostingId'])) ||
    _extractLinkedInJobId(existing.jobId);
  var recoveredSourceUrl = _stringifyField(_pickFirstValue(rawRefData, ['jobUrl', 'applyUrl', 'url', 'link', 'postingUrl'])) ||
    _stringifyField(existing.sourceUrl);
  var recoveredPublishedAt = _stringifyField(_pickFirstValue(rawRefData, ['publishedAt', 'postedAt', 'createdAt', 'listedAt']));
  var recoveredApplicants = _normalizeApplicantsCount(_pickFirstValue(rawRefData, [
    'applicantsCount',
    'applicantCount',
    'applicationsCount',
    'applicants'
  ]));
  var publishedDate = recoveredPublishedAt ? new Date(recoveredPublishedAt) : null;

  refreshed.jobId = recoveredJobId || refreshed.jobId || '';
  refreshed.jobLink = _buildLinkedInJobUrlFromJobId(refreshed.jobId) || recoveredSourceUrl || refreshed.jobLink || '';
  refreshed.sourceUrl = recoveredSourceUrl || refreshed.sourceUrl || '';
  refreshed.company = _stringifyField(_pickFirstValue(rawRefData, ['companyName', 'company', 'organizationName'])) || refreshed.company || '';
  refreshed.title = _stringifyField(_pickFirstValue(rawRefData, ['jobTitle', 'title', 'positionName'])) || refreshed.title || '';
  refreshed.location = _stringifyField(_pickFirstValue(rawRefData, ['location', 'jobLocation', 'formattedLocation'])) || refreshed.location || '';
  refreshed.contractType = _stringifyField(_pickFirstValue(rawRefData, ['contractType', 'employmentType'])) || refreshed.contractType || '';
  refreshed.experienceLevel = _stringifyField(_pickFirstValue(rawRefData, ['experienceLevel', 'seniorityLevel'])) || refreshed.experienceLevel || '';
  refreshed.workType = _stringifyField(_pickFirstValue(rawRefData, ['workType', 'functionArea'])) || refreshed.workType || '';
  refreshed.jobDescription = recoveredDescription || refreshed.jobDescription || '';
  refreshed.publishedAt = recoveredPublishedAt || refreshed.publishedAt || '';
  refreshed.applicants = recoveredApplicants || refreshed.applicants || '';

  if ((!refreshed.posted || refreshed.posted === '') && publishedDate && !isNaN(publishedDate.getTime())) {
    refreshed.posted = _formatDateTimeForDisplay(publishedDate);
  }

  return refreshed;
}

function _parseRawRefObject(rawRef) {
  if (!_stringifyField(rawRef)) {
    return {};
  }

  try {
    return JSON.parse(String(rawRef));
  } catch (error) {
    return {};
  }
}

function _compareJobRecencyDesc(left, right) {
  // Freshest LIVE POSTING first: this ranks which duplicate is the "current" one for canonical
  // link / job_id / metadata selection. Posting date is the right signal — import time is only
  // when WE scraped it, so a re-scraped OLD posting must not outrank a genuinely newer posting.
  // record.posted is a formatted date for most jobs (parses); a relative label returns 0 and
  // falls through to the import/scored fallbacks below.
  var leftPosted = _toComparableTime(left.posted);
  var rightPosted = _toComparableTime(right.posted);
  if (leftPosted !== rightPosted) {
    return rightPosted - leftPosted;
  }

  var leftTime = _toComparableTime(left.importedAt || left.scoredAt);
  var rightTime = _toComparableTime(right.importedAt || right.scoredAt);

  if (leftTime !== rightTime) {
    return rightTime - leftTime;
  }

  var leftImported = _toComparableTime(left.importedAt);
  var rightImported = _toComparableTime(right.importedAt);

  if (leftImported !== rightImported) {
    return rightImported - leftImported;
  }

  return Number(right.rowNumber || 0) - Number(left.rowNumber || 0);
}

function _toComparableTime(value) {
  if (!value) {
    return 0;
  }

  if (value instanceof Date) {
    return isNaN(value.getTime()) ? 0 : value.getTime();
  }

  var parsed = new Date(value);
  if (!isNaN(parsed.getTime())) {
    return parsed.getTime();
  }

  return 0;
}

function _toDateField(value) {
  if (!value) return '';
  if (value instanceof Date) return isNaN(value.getTime()) ? '' : value;
  var d = new Date(value);
  return isNaN(d.getTime()) ? '' : d;
}

function _pickFirstValue(item, keys) {
  for (var i = 0; i < keys.length; i += 1) {
    var value = item[keys[i]];
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }

  return '';
}

function _splitCsv(value) {
  if (!value) {
    return [];
  }

  return String(value)
    .split(',')
    .map(function(part) {
      return part.trim();
    })
    .filter(function(part) {
      return part.length > 0;
    });
}

function _stringifyField(value) {
  if (value === undefined || value === null) {
    return '';
  }

  return String(value).trim();
}

function _cleanJobDescription(value) {
  var text = _stringifyField(value);

  if (!text) {
    return '';
  }

  return text
    .replace(/\bShow more Show less\b/gi, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function _serializeRawRef(item) {
  var full = JSON.stringify(item || {});
  var compact;
  var description;

  if (full.length <= 40000) {
    return full;
  }

  description = _truncate(_cleanJobDescription(_pickFirstValue(item || {}, [
    'jobDescription',
    'descriptionText',
    'description',
    'job_description',
    'details'
  ])), 12000);

  compact = JSON.stringify({
    linkedinJobId: _pickFirstValue(item || {}, ['linkedinJobId', 'jobId', 'jobPostingId']),
    companyName: _pickFirstValue(item || {}, ['companyName', 'company', 'organizationName']),
    jobTitle: _pickFirstValue(item || {}, ['jobTitle', 'title', 'positionName']),
    location: _pickFirstValue(item || {}, ['location', 'jobLocation', 'formattedLocation']),
    jobUrl: _pickFirstValue(item || {}, ['jobUrl', 'applyUrl', 'url', 'link', 'postingUrl']),
    publishedAt: _pickFirstValue(item || {}, ['publishedAt', 'postedAt', 'createdAt', 'listedAt']),
    jobDescription: description
  });

  if (compact.length <= 40000) {
    return compact;
  }

  return JSON.stringify({
    linkedinJobId: _pickFirstValue(item || {}, ['linkedinJobId', 'jobId', 'jobPostingId']),
    companyName: _pickFirstValue(item || {}, ['companyName', 'company', 'organizationName']),
    jobTitle: _pickFirstValue(item || {}, ['jobTitle', 'title', 'positionName']),
    location: _pickFirstValue(item || {}, ['location', 'jobLocation', 'formattedLocation']),
    jobUrl: _pickFirstValue(item || {}, ['jobUrl', 'applyUrl', 'url', 'link', 'postingUrl']),
    publishedAt: _pickFirstValue(item || {}, ['publishedAt', 'postedAt', 'createdAt', 'listedAt']),
    jobDescriptionExcerpt: _truncate(description, 4000)
  });
}

function _normalizeApplicantsCount(value) {
  var text = _stringifyField(value);
  var lower;
  var match;

  if (!text) {
    return '';
  }

  lower = text.toLowerCase();
  match = lower.match(/first\s+(\d+)/);
  if (match) {
    return '<' + match[1];
  }

  match = lower.match(/over\s+(\d+)/);
  if (match) {
    return match[1] + '+';
  }

  match = lower.match(/(\d+)\s*applicants?/);
  if (match) {
    return match[1];
  }

  return _truncate(text, 40);
}

function _truncate(value, maxLength) {
  var text = _stringifyField(value);
  if (text.length <= maxLength) {
    return text;
  }

  return text.slice(0, maxLength - 3) + '...';
}

function _sha1(value) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_1, value);
  return digest.map(function(byte) {
    var normalized = byte;
    if (normalized < 0) {
      normalized += 256;
    }
    var hex = normalized.toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  }).join('');
}

// --- JD content similarity ---

function _normalizeJdText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function _buildWordBigrams(text) {
  var words = _normalizeJdText(text).split(' ').filter(function(w) { return w.length > 1; });
  var bigrams = {};
  for (var i = 0; i < words.length - 1; i += 1) {
    bigrams[words[i] + ' ' + words[i + 1]] = true;
  }
  return bigrams;
}

function _jdContentHash(text) {
  return _sha1(_normalizeJdText(text));
}

function _canReachJaccardThreshold(countA, countB, threshold) {
  if (!countA || !countB) return false;
  return Math.min(countA, countB) / Math.max(countA, countB) >= threshold;
}

function _buildBigramSketch(bigrams) {
  return Object.keys(bigrams).sort().slice(0, 30);
}

function _sketchOverlapRatio(sketchA, sketchB) {
  var setB = {};
  sketchB.forEach(function(b) { setB[b] = true; });
  var shared = sketchA.filter(function(a) { return setB[a]; }).length;
  return shared / Math.max(sketchA.length, sketchB.length, 1);
}

function _jaccardBigramSimilarity(bigramsA, bigramsB) {
  var keysA = Object.keys(bigramsA);
  var keysB = Object.keys(bigramsB);
  if (!keysA.length && !keysB.length) return 1.0;
  if (!keysA.length || !keysB.length) return 0.0;
  var intersection = 0;
  keysA.forEach(function(k) { if (bigramsB[k]) intersection += 1; });
  return intersection / (keysA.length + keysB.length - intersection);
}

function _precomputeJdFingerprints(records) {
  records.forEach(function(record) {
    var jd = _stringifyField(record.jobDescription);
    var bigrams = _buildWordBigrams(jd);
    record._jdHash = record.jdFingerprint || _jdContentHash(jd);
    record._bigrams = bigrams;
    record._bigramCount = Object.keys(bigrams).length;
    record._bigramSketch = _buildBigramSketch(bigrams);
  });
}

function _areLikelySameJd(recordA, recordB, threshold) {
  // Stage 1: exact normalized hash
  if (recordA._jdHash && recordA._jdHash === recordB._jdHash) return true;

  // No content to compare
  if (!recordA._bigramCount || !recordB._bigramCount) return false;

  // Stage 2: length ratio — mathematical bound: if Jaccard >= T then min/max >= T
  if (!_canReachJaccardThreshold(recordA._bigramCount, recordB._bigramCount, threshold)) return false;

  // Stage 3: sketch overlap — cheap soft gate before full Jaccard
  if (_sketchOverlapRatio(recordA._bigramSketch, recordB._bigramSketch) < 0.25) return false;

  // Stage 4: full Jaccard
  return _jaccardBigramSimilarity(recordA._bigrams, recordB._bigrams) >= threshold;
}

function _titlesSanityCheck(titleA, titleB) {
  // At least one significant word (>3 chars) must be shared between titles
  var wordsA = _normalizeJdText(titleA).split(' ').filter(function(w) { return w.length > 3; });
  var wordsB = _normalizeJdText(titleB).split(' ').filter(function(w) { return w.length > 3; });
  var setB = {};
  wordsB.forEach(function(w) { setB[w] = true; });
  return wordsA.some(function(w) { return setB[w]; });
}

