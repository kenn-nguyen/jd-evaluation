var SCORING_CACHE_STATE_KEY = 'GEMINI_SCORING_CACHE_STATE';
var SCORING_CACHE_TTL_SECONDS = 18000;

function loadRuntimeConfig() {
  var settings = getSettingsMap();
  var properties = PropertiesService.getScriptProperties();

  return {
    aiProvider: 'gemini',
    geminiApiRoute: String(settings.GEMINI_API_ROUTE || 'developer').toLowerCase(),
    scoringModel: String(settings.SCORING_MODEL || 'gemini-2.5-flash'),
    scoringParallelRequests: _normalizePositiveInteger(settings.SCORING_PARALLEL_REQUESTS || 3, 1, 100),
    scoringRpmLimit: _normalizePositiveInteger(settings.SCORING_RPM_LIMIT || 0, 0, 10000),
    maxJobsPerExecution: _normalizePositiveInteger(settings.SCORING_MAX_JOBS_PER_EXECUTION || 0, 0, 10000),
    scoringInstructions: _resolveDefaultableSetting(settings.SCORING_INSTRUCTIONS, _defaultScoringInstructions),
    promptVersion: 'v7',
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
    executionSoftLimitMs: 300000,
    executionYieldBufferMs: 90000,
    executionDeadlineMs: Date.now() + 300000,
    apifyToken: String(settings.APIFY_TOKEN || properties.getProperty('APIFY_TOKEN') || '').trim(),
    apifyTaskIds: _splitCsv(settings.APIFY_TASK_IDS || properties.getProperty('APIFY_TASK_IDS')),
    vertexProjectId: String(settings.VERTEX_PROJECT_ID || properties.getProperty('VERTEX_PROJECT_ID') || ''),
    vertexLocation: String(settings.VERTEX_LOCATION || 'global'),
    geminiApiKey: properties.getProperty('GEMINI_API_KEY'),
    openAiApiKey: properties.getProperty('OPENAI_API_KEY')
  };
}

function validateRuntimeConfig(config) {
  var options = arguments[1] || {};
  var requireApify = options.requireApify !== false;

  if (requireApify && !config.apifyToken) {
    throw new Error('Missing APIFY_TOKEN in the Settings sheet or Script Properties.');
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

  if (requireApify && (!config.activeRunState || !config.activeRunState.sources || !config.activeRunState.sources.length) && !config.apifyTaskIds.length) {
    throw new Error('APIFY_TASK_IDS is required in the Settings sheet.');
  }
}

function importAndScoreJobs(config, existingIndex, progressCallback) {
  var activeRunState = _getOrCreateActiveRunState(config, progressCallback);
  config.activeRunState = activeRunState;
  var sourceItems = _fetchApifyItems(config, progressCallback);
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
      normalizedJobs.push(_normalizeJob(sourceItem.item, sourceItem.sourceLabel, config.runStartedAt));
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

  // Initialize Gemini context cache once per run (keyed by model + prompt fingerprint)
  if (!config._scoringCacheAttempted) {
    config._scoringCacheAttempted = true;
    config._scoringCacheName = _getOrCreateScoringCache(config) || '';
  }

  for (var start = 0; start < jobs.length; start += batchSize) {
    if (start > 0 && _shouldYieldExecution(config)) {
      hitExecutionBudget = true;
      break;
    }

    var batch = jobs.slice(start, start + batchSize);
    var requests = batch.map(function(job) {
      return _buildScoreRequest(job, config);
    });
    var batchStartedAt = Date.now();
    var responses = _executeScoreRequests(requests);
    var prevRowCount = rows.length;

    batch.forEach(function(job, index) {
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
        job.scoredAt = new Date();
        job.scoringFingerprint = job.scoringFingerprint || _buildScoringFingerprint(job, config);

        rows.push(job);
        scoredJobsCount += 1;
      } catch (scoreError) {
        failedJobsCount += 1;
        failedJobIds.push(job.jobId);
        errors.push(_truncate('AI scoring failed for ' + (job.title || job.jobId) + ': ' + scoreError.message, 300));
        Logger.log(scoreError);
      }
    });

    processedCount += batch.length;
    _emitProgress(progressCallback, {
      status: resolvedStatusLabel,
      processed: (initialProcessedCount + processedCount) + ' / ' + totalJobsCount,
      rows: rows.slice(prevRowCount)  // flush this batch's results to the sheet immediately
    });

    // Adaptive rate-limit pacing: if SCORING_RPM_LIMIT is set, sleep only the time
    // remaining in the rate window — batch execution time already counts toward it.
    // With no RPM limit, enforce a 1 s minimum to avoid quota exhaustion.
    var hasMoreBatches = (start + batch.length) < jobs.length;
    if (hasMoreBatches) {
      var elapsed = Date.now() - batchStartedAt;
      var windowMs = config.scoringRpmLimit > 0
        ? Math.floor(60000 * batch.length / config.scoringRpmLimit)
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
    return _fetchItemsForSources(config.activeRunState.sources, config, progressCallback);
  }

  return _runTasksAndFetchItems(config, progressCallback);
}

function _runTasksAndFetchItems(config, progressCallback) {
  var sources = _startTaskSources(config, progressCallback);
  if (config.activeRunState) {
    config.activeRunState.sources = sources;
  }
  return _fetchItemsForSources(sources, config, progressCallback);
}

function _startTaskSources(config, progressCallback) {
  var sources = [];

  config.apifyTaskIds.forEach(function(taskId) {
    _emitProgress(progressCallback, {
      status: 'Starting Apify task',
      processed: ''
    });
    var runId = _startTaskRun(taskId, config);
    _emitProgress(progressCallback, {
      status: 'Waiting for Apify',
      processed: ''
    });
    var runInfo = _waitForRunToFinish(runId, taskId, config);
    var datasetId = runInfo.defaultDatasetId;

    if (!datasetId) {
      throw new Error('Task ' + taskId + ' run ' + runId + ' finished without defaultDatasetId.');
    }

    sources.push({
      taskId: taskId,
      runId: runId,
      datasetId: datasetId
    });
  });

  return sources;
}

function _fetchItemsForSources(sources, config, progressCallback) {
  var allItems = [];
  sources.forEach(function(source) {
    _emitProgress(progressCallback, {
      status: 'Fetching jobs',
      processed: ''
    });
    var responseItems = _fetchDatasetItemsById(
      source.datasetId,
      config,
      'task ' + source.taskId + ' run ' + source.runId
    );
    responseItems.forEach(function(item) {
      allItems.push({
        sourceLabel: source.taskId,
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

function _shouldYieldExecution(config) {
  var bufferMs = Number((config && config.executionYieldBufferMs) || 45000);
  var deadlineMs = Number((config && config.executionDeadlineMs) || 0);

  if (!deadlineMs) {
    return false;
  }

  return (Date.now() + bufferMs) >= deadlineMs;
}

function _startTaskRun(taskId, config) {
  var response = UrlFetchApp.fetch(
    'https://api.apify.com/v2/actor-tasks/' + encodeURIComponent(taskId) + '/runs?token=' + encodeURIComponent(config.apifyToken),
    {
      method: 'post',
      muteHttpExceptions: true
    }
  );
  var runInfo = _parseApifyObjectResponse(response, 'task run start ' + taskId);

  if (!runInfo.id) {
    throw new Error('Task ' + taskId + ' did not return a run id.');
  }

  return runInfo.id;
}

function _waitForRunToFinish(runId, sourceLabel, config) {
  var deadline = Date.now() + (config.apifyRunWaitSeconds * 1000);

  while (Date.now() <= deadline) {
    var runInfo = _getRunInfo(runId, config);
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

function _getRunInfo(runId, config) {
  var response = UrlFetchApp.fetch(
    'https://api.apify.com/v2/actor-runs/' + encodeURIComponent(runId) + '?token=' + encodeURIComponent(config.apifyToken),
    { muteHttpExceptions: true }
  );

  return _parseApifyObjectResponse(response, 'run ' + runId);
}

function _resurrectApifyRun(runId, config) {
  var response = UrlFetchApp.fetch(
    'https://api.apify.com/v2/actor-runs/' + encodeURIComponent(runId) + '/resurrect?token=' + encodeURIComponent(config.apifyToken),
    {
      method: 'post',
      muteHttpExceptions: true
    }
  );

  return _parseApifyObjectResponse(response, 'resurrect run ' + runId);
}

function _fetchDatasetItemsById(datasetId, config, sourceLabel) {
  var response = UrlFetchApp.fetch(
    'https://api.apify.com/v2/datasets/' + encodeURIComponent(datasetId) + '/items?clean=true&format=json&token=' + encodeURIComponent(config.apifyToken),
    { muteHttpExceptions: true }
  );

  return _parseApifyArrayResponse(response, sourceLabel);
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
    jdImpliedLevel: _normalizeJobLevel(parsedContent.jd_implied_level)
  };
}

function _buildScoringFingerprint(job, config) {
  return _sha1([
    config.aiProvider || '',
    config.geminiApiRoute || '',
    config.scoringModel || '',
    config.promptVersion || '',
    _buildScoringPrompt(job, config)
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
        enum: ['Likely (90%)', 'Possible (70%)', 'Unclear (50%)', 'Unlikely (20%)', 'No (0%)'],
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
        description: 'Actual seniority implied by the JD body — ignore the job title for this field.'
      }
    },
    required: ['score', 'priority', 'us_visa_sponsorship_potential', 'us_visa_reason', 'summary', 'why', 'title_level', 'jd_implied_level']
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
    'Likely (90%)': true,
    'Possible (70%)': true,
    'Unclear (50%)': true,
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

  preservedJobId = _extractLinkedInJobId(candidate.jobId) ||
    _extractLinkedInJobId(existing.jobId) ||
    _stringifyField(candidate.jobId) ||
    _stringifyField(existing.jobId);

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
  candidate.scoringFingerprint = existing.scoringFingerprint || '';

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
    record._jdHash = _jdContentHash(jd);
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

