var SCORING_CACHE_STATE_KEY = 'GEMINI_SCORING_CACHE_STATE';
var SCORING_CACHE_TTL_SECONDS = 7200;

function loadRuntimeConfig() {
  var settings = getSettingsMap();
  var properties = PropertiesService.getScriptProperties();

  return {
    aiProvider: 'gemini',
    geminiApiRoute: String(settings.GEMINI_API_ROUTE || 'developer').toLowerCase(),
    scoringModel: String(settings.SCORING_MODEL || 'gemini-2.5-flash'),
    scoringParallelRequests: _normalizePositiveInteger(settings.SCORING_PARALLEL_REQUESTS || 3, 3, 20),
    scoringInstructions: _resolveDefaultableSetting(settings.SCORING_INSTRUCTIONS, _defaultScoringInstructions),
    promptVersion: 'v2',
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
    executionSoftLimitMs: 330000,
    executionYieldBufferMs: 45000,
    executionDeadlineMs: Date.now() + 330000,
    apifyToken: String(settings.APIFY_TOKEN || properties.getProperty('APIFY_TOKEN') || '').trim(),
    apifyTaskIds: _splitCsv(settings.APIFY_TASK_IDS || properties.getProperty('APIFY_TASK_IDS')),
    vertexProjectId: String(settings.VERTEX_PROJECT_ID || properties.getProperty('VERTEX_PROJECT_ID') || ''),
    vertexLocation: String(settings.VERTEX_LOCATION || 'global'),
    geminiApiKey: properties.getProperty('GEMINI_API_KEY'),
    openAiApiKey: properties.getProperty('OPENAI_API_KEY'),
    gcsBucket: String(settings.GCS_BUCKET || '').trim(),
    batchMode: String(settings.BATCH_MODE || 'off').toLowerCase().trim(),
    batchAutoThreshold: _normalizePositiveInteger(settings.BATCH_AUTO_THRESHOLD || 50, 50, 10000)
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

  // Batch submission path: submit all scoreable jobs to Vertex Batch Prediction at once
  if (jobsToScore.length && _shouldUseBatch(jobsToScore.length, config)) {
    try {
      _emitProgress(progressCallback, {
        status: 'Submitting batch scoring job',
        processed: rowsToWriteWithoutScoring.length + ' / ' + activeRunState.totalJobsCount
      });

      var batchCacheName = _getOrCreateScoringCache(config) || '';
      var batchRunPrefix = _gcsRunPrefix(config);
      var batchJsonl = _buildBatchInputJsonl(jobsToScore, config, batchCacheName);
      var batchInputUri = _uploadToGcs(batchJsonl, batchRunPrefix + '/input.jsonl', config);
      var batchOutputPrefix = 'gs://' + config.gcsBucket + '/' + batchRunPrefix + '/output/';
      var batchJobName = _submitVertexBatchJob(batchInputUri, batchOutputPrefix, config);

      activeRunState.batchPending = true;
      activeRunState.batchJobName = batchJobName;
      activeRunState.batchOutputGcsPrefix = batchOutputPrefix;
      activeRunState.batchTargetJobIds = jobsToScore.map(function(j) { return j.jobId; });
      activeRunState.totalScoreableCount = jobsToScore.length;
      activeRunState.processedCount = rowsToWriteWithoutScoring.length;
      activeRunState.handledJobIds = _appendUniqueStrings(
        activeRunState.handledJobIds || [],
        rowsToWriteWithoutScoring.map(function(j) { return j.jobId; })
      );
      activeRunState.updatedAt = new Date().toISOString();

      // Include unscored new jobs in rows so they are written to the sheet immediately
      rows = rows.concat(jobsToScore);

      return {
        rows: rows,
        batchPending: true,
        newJobsCount: activeRunState.newJobsCount || 0,
        aJobsCount: activeRunState.aJobsCount || 0,
        duplicateJobsCount: duplicateJobsCount,
        scoredJobsCount: activeRunState.scoredJobsCount || 0,
        failedJobsCount: activeRunState.failedJobsCount || 0,
        importFailedJobsCount: importFailedJobsCount,
        processedCount: activeRunState.processedCount,
        rawScrapedCount: activeRunState.rawScrapedCount,
        uniqueRolesCount: activeRunState.totalJobsCount,
        totalScoreableCount: activeRunState.totalScoreableCount,
        totalJobsCount: activeRunState.totalJobsCount,
        errors: activeRunState.errors || [],
        hasMore: false,
        activeRunState: activeRunState,
        newTopPriorityJobIds: []
      };
    } catch (batchSubmitError) {
      Logger.log('Batch submission failed, falling back to synchronous scoring: ' + batchSubmitError.message);
      errors.push(_truncate('Batch submission failed: ' + batchSubmitError.message, 300));
    }
  }

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
    }).map(function(job) {
      return job.jobId;
    });
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

    if (!_stringifyField(existing.jobDescription)) {
      skippedThisExecution.push(jobId);
      handledJobIdsMap[jobId] = true;
      return;
    }

    fingerprint = _buildScoringFingerprint(existing, config);
    if (_stringifyField(existing.scoringFingerprint) === fingerprint && _hasScoringPayload(existing)) {
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

  if (jobsToScore.length && _shouldUseBatch(jobsToScore.length, config)) {
    try {
      _emitProgress(progressCallback, {
        status: 'Submitting batch scoring job',
        processed: (activeRunState.handledJobIds.length + skippedThisExecution.length) + ' / ' + activeRunState.totalJobsCount
      });

      var revalBatchCacheName = _getOrCreateScoringCache(config) || '';
      var revalBatchRunPrefix = _gcsRunPrefix(config);
      var revalBatchJsonl = _buildBatchInputJsonl(jobsToScore, config, revalBatchCacheName);
      var revalBatchInputUri = _uploadToGcs(revalBatchJsonl, revalBatchRunPrefix + '/input.jsonl', config);
      var revalBatchOutputPrefix = 'gs://' + config.gcsBucket + '/' + revalBatchRunPrefix + '/output/';
      var revalBatchJobName = _submitVertexBatchJob(revalBatchInputUri, revalBatchOutputPrefix, config);

      activeRunState.batchPending = true;
      activeRunState.batchJobName = revalBatchJobName;
      activeRunState.batchOutputGcsPrefix = revalBatchOutputPrefix;
      activeRunState.batchTargetJobIds = jobsToScore.map(function(j) { return j.jobId; });
      activeRunState.totalScoreableCount = jobsToScore.length;
      activeRunState.handledJobIds = _appendUniqueStrings(
        activeRunState.handledJobIds || [],
        skippedThisExecution
      );
      activeRunState.processedCount = activeRunState.handledJobIds.length;
      activeRunState.updatedAt = new Date().toISOString();

      return {
        rows: [],
        batchPending: true,
        newJobsCount: '',
        aJobsCount: activeRunState.aJobsCount || 0,
        duplicateJobsCount: 0,
        scoredJobsCount: activeRunState.scoredJobsCount || 0,
        failedJobsCount: activeRunState.failedJobsCount || 0,
        importFailedJobsCount: 0,
        processedCount: activeRunState.processedCount,
        rawScrapedCount: '',
        uniqueRolesCount: activeRunState.totalJobsCount,
        totalScoreableCount: activeRunState.totalScoreableCount,
        totalJobsCount: activeRunState.totalJobsCount,
        errors: activeRunState.errors || [],
        hasMore: false,
        activeRunState: activeRunState,
        newTopPriorityJobIds: []
      };
    } catch (revalBatchError) {
      Logger.log('Batch submission failed for reevaluation, falling back to synchronous: ' + revalBatchError.message);
      errors.push(_truncate('Batch submission failed: ' + revalBatchError.message, 300));
    }
  }

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
    }).map(function(job) {
      return job.jobId;
    });
  }

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

function _scoreJobsInBatches(jobs, config, progressCallback, totalJobsCount, initialProcessedCount, statusLabel) {
  var rows = [];
  var errors = [];
  var scoredJobsCount = 0;
  var failedJobsCount = 0;
  var processedCount = 0;
  var failedJobIds = [];
  var batchSize = config.scoringParallelRequests;
  var resolvedStatusLabel = statusLabel || 'Scoring jobs';
  var hitExecutionBudget = false;

  // Initialize Gemini context cache once for this scoring session
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
    var responses = _executeScoreRequests(requests);

    batch.forEach(function(job, index) {
      try {
        var scoreResult = _scoreSingleJobWithRetry(job, config, responses[index]);
        job.score = scoreResult.score;
        job.priority = scoreResult.priority;
        job.usVisaSponsorshipPotential = scoreResult.usVisaSponsorshipPotential;
        job.usVisaReason = scoreResult.usVisaReason;
        job.summary = scoreResult.summary;
        job.why = scoreResult.why;
        job.angle = scoreResult.angle;
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
      processed: (initialProcessedCount + processedCount) + ' / ' + totalJobsCount
    });

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

function _scoreSingleJobWithRetry(job, config, initialResponse) {
  try {
    return _parseScoreResponseByProvider(initialResponse, config.aiProvider);
  } catch (firstError) {
    Logger.log(firstError);
    // Retry without cache in case the cached content expired or is invalid
    var retryConfig = config._scoringCacheName
      ? _cloneConfigWithoutCache(config)
      : config;
    var retryResponse = _executeSingleScoreRequest(_buildScoreRequest(job, retryConfig));

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

function _cloneConfigWithoutCache(config) {
  var clone = {};
  Object.keys(config).forEach(function(key) { clone[key] = config[key]; });
  clone._scoringCacheName = '';
  return clone;
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
  return Math.max(1, Math.min(20, Number(config.maxJobsPerExecution || 20)));
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
    angle: '',
    titleLevel: '',
    jdImpliedLevel: '',
    priority: '',
    score: '',
    status: 'New',
    notes: '',
    importedAt: importedAt,
    scoredAt: '',
    sourceTask: searchString || sourceLabel || '',
    postedSort: postedDate || '',
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
    angle: _truncate(_stringifyField(parsedContent.angle), 250),
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
        enum: ['Likely', 'Possible', 'Unclear', 'Unlikely', 'No'],
        description: 'Estimated US visa sponsorship potential.'
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
      angle: {
        type: 'string',
        description: 'One short sentence describing how to position the candidate.'
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
    required: ['score', 'priority', 'us_visa_sponsorship_potential', 'us_visa_reason', 'summary', 'why', 'angle', 'title_level', 'jd_implied_level']
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

function _defaultScoringInstructions() {
  return [
    'Act as the hiring manager for this exact role and as a pragmatic PM job-screening analyst.',
    '',
    'Objective:',
    'Score interview-conversion priority: how likely this candidate’s truthful, tailored resume is to earn an interview for this exact job.',
    '',
    'Use only the real job title, company, metadata, and raw JD. Ignore prior AI summaries, prior scores, or generated angles.',
    '',
    'Return strict JSON only with exactly these keys:',
    'score, priority, us_visa_sponsorship_potential, us_visa_reason, summary, why, angle.',
    '',
    'Rules:',
    '- score: integer 0-100',
    '- priority: P01, P02, P03, P04, P05, P06, P07, P08, P09, or P10',
    '- us_visa_sponsorship_potential: Likely, Possible, Unclear, Unlikely, or No',
    '- us_visa_reason: one short sentence explaining the evidence for the visa label',
    '- summary, why, and angle: one short sentence each',
    '- No markdown, no extra keys, no extra commentary.',
    '',
    'Evaluate mainly on:',
    '1. proof/evidence match',
    '2. domain advantage',
    '3. seniority fit',
    '4. product ownership/scope',
    '5. practical pursuit value',
    '',
    'Choose priority bucket first, then score inside that bucket.',
    '',
    'Strong proof means the JD maps directly to 2+ candidate proof points: identity/fraud/KYC verification, biometric/liveness authentication, payment authentication, API verification scaling, bank/fintech client product work, risk decisioning, conversion/fraud tradeoffs, integration friction reduction, product expansion/revenue growth, platform standardization, or Lumi-style AI workflow product.',
    '',
    'Direct domain means fintech infrastructure, banking tech, payments, fraud/risk, identity verification, authentication, biometric/liveness, eKYC/KYC, onboarding, risk decisioning, payment authentication, API-based verification, or regulated financial workflows.',
    '',
    'Adjacent domain means AI workflow, agentic AI, API/developer platform, technical platform PM, B2B SaaS, data product, security/governance, enterprise workflow, or regulated non-financial workflow.',
    '',
    'Weak domain means generic AI, generic SaaS, internal tools, cloud support, procurement/supply-chain, healthcare clinical systems, logistics, staffing/marketplaces, consumer growth, media, ads, gaming, investment product, operations, strategy, product marketing, pure engineering, sales, or support.',
    '',
    'Priority buckets:',
    '- P01: rare bullseye; direct domain + strong proof + PM/Senior PM fit + clear ownership + reliable JD. Score 95-100.',
    '- P02: very strong fit; direct domain + strong proof with one minor gap. Score 90-94.',
    '- P03: strong fit with one meaningful gap; direct domain with moderate proof or adjacent domain with unusually strong proof. Score 85-89.',
    '- P04: good adjacent PM fit, not top wedge. Score 80-84.',
    '- P05: adjacent but credible, weaker domain or proof. Score 75-79.',
    '- P06: possible backup. Score 70-74.',
    '- P07: low interview-conversion fit, generic PM or weak domain. Score 60-69.',
    '- P08: poor fit or wrong product area. Score 50-59.',
    '- P09: clear mismatch. Score 35-49.',
    '- P10: hard skip: entry-level, internship, new-grad, pure engineering, pure sales/support/admin, or obvious non-target. Score 0-34.',
    '',
    'Caps:',
    '- P01/P02 require both direct domain and strong proof.',
    '- If proof is weak, max P07.',
    '- If proof is moderate, max P04 unless domain is direct.',
    '- If domain is only adjacent, max P03 and usually P04-P06.',
    '- Generic AI/platform/SaaS/data/cloud-support roles max P04 unless strongly mapped to fintech/payments/fraud/identity/authentication/API verification or Lumi-style AI workflow.',
    '- Famous company alone max P05.',
    '- Financial-institution customer segment does not make the product fintech.',
    '- Staff/Principal/Group/Director/VP+ max P04 unless direct-domain, IC/product-scope heavy, and unusually strong.',
    '- Recruiter/hiring-network/generic/duplicated/unclear-employer JD max P05 unless direct-domain proof is clear.',
    '- Pure strategy, product marketing, sales, support, account management, admin, or operations max P07 unless clear product ownership exists.',
    '',
    'Batch calibration:',
    'For ~1,000 scraped PM jobs, P01 should be rare, P02 selective, P03 strong but not bullseye, most decent jobs should fall into P04-P06, and weak/non-target jobs should fall into P07-P10.',
    '',
    'Visa:',
    '- visa output is informational only',
    '- do not use visa to increase or decrease score or priority',
    '- Likely = sponsorship is explicit or strongly supported by employer and role context',
    '- Possible = sponsorship is not explicit, but still plausibly available',
    '- Unclear = no reliable sponsorship signal',
    '- Unlikely = sponsorship is not stated and role or employer context makes it less likely',
    '- No = posting explicitly says no sponsorship, no current/future sponsorship, or unrestricted US work authorization required',
    '- Do not treat "US applicants only", US location eligibility, or US pay-transparency language by itself as No.',
    '',
    'Level classification:',
    'title_level: Read the job title string only — ignore the JD body. Map to one of: APM, PM, Senior-PM, Staff-PM, Principal-PM, Manager, Senior-Manager, Group-PM, Director, Senior-Director, VP, Head-of-Product, Founding-PM, Unknown.',
    'jd_implied_level: Read the JD body only — ignore the job title. Infer the actual scope and seniority from content signals:',
    '- "first PM", "build from scratch", "wear many hats", seed/Series A stage → Founding-PM',
    '- Manages 5+ PMs, owns org-wide roadmap, sets product strategy across groups → Group-PM or Director',
    '- Explicit "manage a team of PMs" or "manage PMs" → Manager or Senior-Manager',
    '- Cross-functional leadership, no direct reports, sets technical/product direction → Staff-PM or Principal-PM',
    '- Mentors ICs, leads initiatives, owns a significant product surface → Senior-PM',
    '- Clear IC scope, defined product area, execution-focused → PM',
    '- Entry-level signals, "associate", rotational, new-grad → APM',
    '- Cannot determine from JD content → Unknown',
    '',
    'Return only valid JSON.'
  ].join('\n');
}

function _defaultTargetProfile() {
  return [
    'Candidate target profile:',
    '',
    'Experienced product manager / product leader with 10+ years of experience, most recently Senior Product Manager / Associate Product Director level, with Yale SOM and NUS MBA training.',
    '',
    'Primary interview wedge:',
    'fintech infrastructure, banking technology, payments, fraud/risk, identity verification, authentication, biometric/liveness verification, eKYC/KYC, onboarding, risk decisioning, payment authentication, API-based verification platforms, and regulated financial workflows for banks/fintechs.',
    '',
    'Strong proof points:',
    'scaled API-based identity/risk verification from ~500K to ~2M daily verifications across cloud and on-prem; launched biometric payment authentication across 9 tier-1 banks; owned fraud/risk, KYC, liveness, authentication, and API verification products; improved verification/authentication conversion; reduced integration friction; defined ML product/model requirements; supported ~40% YoY ARR/API growth; standardized platform deployments across markets.',
    '',
    'Secondary/adjacent fit:',
    'AI workflow, agentic AI, API/developer platforms, technical platform PM, B2B SaaS, data products, security/governance, and enterprise workflow. Lumi supports AI workflow and product-building evidence, but should not be treated as equivalent to large-scale enterprise AI platform PM experience.',
    '',
    'Direct fit requires the role itself to own payments, fraud/risk, identity, authentication, KYC, onboarding, risk decisioning, API verification, or financial infrastructure. Do not treat a financial-services customer segment or famous employer as direct domain fit.',
    '',
    'Prioritize PM and Senior PM roles. Treat Staff, Principal, Director, VP+, entry-level, pure engineering, pure strategy, product marketing, sales, account management, support, operations, healthcare clinical systems, procurement, supply chain, ads, gaming, marketplace operations, and investment-product roles as lower priority unless the JD has unusually strong product ownership and proof mapping.'
  ].join(' ');
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
    Likely: true,
    Possible: true,
    Unclear: true,
    Unlikely: true,
    No: true
  };
  var potential = _stringifyField(value);
  return allowed[potential] ? potential : 'Unclear';
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
  candidate.postedSort = candidate.postedSort || existing.postedSort || '';
  candidate.status = existing.status || 'New';
  candidate.notes = existing.notes || '';
  candidate.importedAt = existing.importedAt || candidate.importedAt;
  candidate.scoredAt = existing.scoredAt || '';
  candidate.score = existing.score === undefined ? '' : existing.score;
  candidate.priority = existing.priority || '';
  candidate.usVisaSponsorshipPotential = existing.usVisaSponsorshipPotential || '';
  candidate.usVisaReason = existing.usVisaReason || '';
  candidate.summary = existing.summary || '';
  candidate.why = existing.why || '';
  candidate.angle = existing.angle || '';
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

  if ((!refreshed.postedSort || refreshed.postedSort === '') && publishedDate && !isNaN(publishedDate.getTime())) {
    refreshed.postedSort = publishedDate;
  }

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
  var leftTime = _toComparableTime(left.postedSort || left.importedAt || left.scoredAt);
  var rightTime = _toComparableTime(right.postedSort || right.importedAt || right.scoredAt);

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

// --- Vertex AI Batch Prediction ---

function _shouldUseBatch(jobCount, config) {
  if (config.geminiApiRoute !== 'vertex') return false;
  if (!config.gcsBucket) return false;
  var mode = String(config.batchMode || 'off');
  if (mode === 'off') return false;
  if (mode === 'always') return jobCount > 0;
  if (mode === 'auto') return jobCount >= Number(config.batchAutoThreshold || 50);
  return false;
}

function _gcsRunPrefix(config) {
  var ts = config.runStartedAt instanceof Date
    ? config.runStartedAt.getTime()
    : new Date().getTime();
  return 'job-scoring/' + String(ts);
}

function _buildBatchInputJsonl(jobs, config, cacheName) {
  return jobs.map(function(job) {
    var generationConfig = {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: _getScoreResponseSchema()
    };
    var request;
    if (cacheName) {
      request = {
        cachedContent: cacheName,
        contents: [{ role: 'user', parts: [{ text: _buildDynamicJobContent(job) }] }],
        generationConfig: generationConfig
      };
    } else {
      var fullPrompt = _buildStaticScoringContent(config) + '\n\n' + _buildDynamicJobContent(job);
      request = {
        contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
        generationConfig: generationConfig
      };
    }
    return JSON.stringify({ request: request });
  }).join('\n');
}

function _uploadToGcs(content, objectName, config) {
  var bucket = config.gcsBucket;
  var token = ScriptApp.getOAuthToken();

  var response = UrlFetchApp.fetch(
    'https://storage.googleapis.com/upload/storage/v1/b/' + encodeURIComponent(bucket) +
    '/o?uploadType=media&name=' + encodeURIComponent(objectName),
    {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: content,
      muteHttpExceptions: true
    }
  );

  var code = response.getResponseCode();
  if (code >= 300) {
    throw new Error('GCS upload failed (' + code + '): ' + _truncate(response.getContentText(), 200));
  }

  return 'gs://' + bucket + '/' + objectName;
}

function _submitVertexBatchJob(inputGcsUri, outputGcsPrefix, config) {
  var payload = {
    displayName: 'job-scoring-batch',
    model: 'publishers/google/models/' + config.scoringModel,
    inputConfig: {
      instancesFormat: 'jsonl',
      gcsSource: { uris: [inputGcsUri] }
    },
    outputConfig: {
      predictionsFormat: 'jsonl',
      gcsDestination: { outputUriPrefix: outputGcsPrefix }
    }
  };

  var response = UrlFetchApp.fetch(
    'https://aiplatform.googleapis.com/v1/projects/' + encodeURIComponent(config.vertexProjectId) +
    '/locations/' + encodeURIComponent(config.vertexLocation) + '/batchPredictionJobs',
    {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    }
  );

  var code = response.getResponseCode();
  var body = response.getContentText();
  if (code >= 300) {
    throw new Error('Vertex batch job creation failed (' + code + '): ' + _truncate(body, 300));
  }

  return JSON.parse(body).name;
}

function _pollVertexBatchJobState(jobName, config) {
  var response = UrlFetchApp.fetch(
    'https://aiplatform.googleapis.com/v1/' + jobName,
    {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    }
  );

  var code = response.getResponseCode();
  if (code >= 300) {
    throw new Error('Vertex batch job status check failed (' + code + ')');
  }

  var parsed = JSON.parse(response.getContentText());
  return {
    state: String(parsed.state || ''),
    outputDirectory: (parsed.outputInfo && parsed.outputInfo.gcsOutputDirectory)
      ? String(parsed.outputInfo.gcsOutputDirectory)
      : '',
    error: parsed.error ? _truncate(String(parsed.error.message || ''), 300) : ''
  };
}

function _listGcsObjectsByPrefix(gcsDirectoryUri, config) {
  var match = String(gcsDirectoryUri || '').match(/^gs:\/\/([^\/]+)\/?(.*)$/);
  if (!match) return [];
  var bucket = match[1];
  var prefix = match[2];

  var response = UrlFetchApp.fetch(
    'https://storage.googleapis.com/storage/v1/b/' + encodeURIComponent(bucket) +
    '/o?prefix=' + encodeURIComponent(prefix),
    {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    }
  );

  if (response.getResponseCode() >= 300) return [];

  var parsed = JSON.parse(response.getContentText());
  return (parsed.items || [])
    .map(function(item) { return { bucket: bucket, name: item.name }; })
    .sort(function(a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
}

function _downloadGcsObject(bucket, objectName, config) {
  var response = UrlFetchApp.fetch(
    'https://storage.googleapis.com/download/storage/v1/b/' + encodeURIComponent(bucket) +
    '/o/' + encodeURIComponent(objectName) + '?alt=media',
    {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    }
  );

  var code = response.getResponseCode();
  if (code >= 300) {
    throw new Error('GCS download failed for ' + objectName + ' (' + code + ')');
  }

  return response.getContentText();
}

function _readBatchJobResults(activeRunState, outputDirectory, config, existingIndex) {
  var batchTargetJobIds = activeRunState.batchTargetJobIds || [];
  var scoredRows = [];
  var failedJobIds = [];
  var errors = [];
  var lineIndex = 0;

  var objectRefs = _listGcsObjectsByPrefix(outputDirectory, config);
  objectRefs.forEach(function(ref) {
    if (!ref.name.match(/\.jsonl$/i)) return;

    var content;
    try {
      content = _downloadGcsObject(ref.bucket, ref.name, config);
    } catch (e) {
      errors.push('Download failed for ' + ref.name + ': ' + e.message);
      return;
    }

    var lines = content.split('\n');
    lines.forEach(function(line) {
      line = line.trim();
      if (!line) return;

      var jobId = batchTargetJobIds[lineIndex];
      lineIndex += 1;

      if (!jobId) return;

      var existing = existingIndex.byJobId[jobId];
      if (!existing) {
        failedJobIds.push(jobId);
        return;
      }

      try {
        var parsed = JSON.parse(line);
        var status = parsed.status;
        if (status && status.code && status.code !== 0) {
          throw new Error(String(status.message || status.code));
        }

        var response = parsed.response;
        var candidate = response && response.candidates && response.candidates[0];
        var parts = candidate && candidate.content && candidate.content.parts;
        var text = parts && parts.map(function(p) { return p.text || ''; }).join('');

        if (!text) throw new Error('Empty response from batch result');

        var scoreResult = _normalizeScorePayload(_parseJsonSafely(text));
        var scored = _cloneJobRecord(existing);
        scored.existingRowNumber = existing.rowNumber;
        scored.score = scoreResult.score;
        scored.priority = scoreResult.priority;
        scored.usVisaSponsorshipPotential = scoreResult.usVisaSponsorshipPotential;
        scored.usVisaReason = scoreResult.usVisaReason;
        scored.summary = scoreResult.summary;
        scored.why = scoreResult.why;
        scored.angle = scoreResult.angle;
        scored.titleLevel = scoreResult.titleLevel;
        scored.jdImpliedLevel = scoreResult.jdImpliedLevel;
        scored.scoredAt = new Date();
        scored.scoringFingerprint = _buildScoringFingerprint(existing, config);
        scoredRows.push(scored);
      } catch (e) {
        failedJobIds.push(jobId);
        errors.push(_truncate('Batch result parse failed for ' + jobId + ': ' + e.message, 200));
      }
    });
  });

  return {
    scoredRows: scoredRows,
    failedJobIds: failedJobIds,
    scoredJobsCount: scoredRows.length,
    failedJobsCount: failedJobIds.length,
    errors: errors
  };
}
