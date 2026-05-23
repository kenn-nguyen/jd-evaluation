function loadRuntimeConfig() {
  var settings = getSettingsMap();
  var properties = PropertiesService.getScriptProperties();

  return {
    aiProvider: 'gemini',
    geminiApiRoute: String(settings.GEMINI_API_ROUTE || 'developer').toLowerCase(),
    scoringModel: String(settings.SCORING_MODEL || 'gemini-2.5-flash'),
    scoringParallelRequests: _normalizePositiveInteger(settings.SCORING_PARALLEL_REQUESTS || 3, 3, 20),
    scoringInstructions: _resolveDefaultableSetting(settings.SCORING_INSTRUCTIONS, _defaultScoringInstructions),
    promptVersion: 'v1',
    targetProfile: String(
      settings.TARGET_PROFILE ||
      _defaultTargetProfile()
    ),
    notifyEmail: String(settings.NOTIFY_EMAIL || '').trim(),
    forceRescore: String(settings.FORCE_RESCORE || 'FALSE').toUpperCase() === 'TRUE',
    apifyPollIntervalMs: 5000,
    apifyRunWaitSeconds: 240,
    apifyTaskIds: _splitCsv(settings.APIFY_TASK_IDS || properties.getProperty('APIFY_TASK_IDS')),
    apifyToken: properties.getProperty('APIFY_TOKEN'),
    vertexProjectId: String(settings.VERTEX_PROJECT_ID || properties.getProperty('VERTEX_PROJECT_ID') || ''),
    vertexLocation: String(settings.VERTEX_LOCATION || 'global'),
    geminiApiKey: properties.getProperty('GEMINI_API_KEY'),
    openAiApiKey: properties.getProperty('OPENAI_API_KEY')
  };
}

function validateRuntimeConfig(config) {
  if (!config.apifyToken) {
    throw new Error('Missing APIFY_TOKEN in Script Properties.');
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

  if ((!config.activeRunState || !config.activeRunState.sources || !config.activeRunState.sources.length) && !config.apifyTaskIds.length) {
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
  var handledCanonicalKeysMap = _buildLookup(activeRunState.handledCanonicalKeys || []);
  var handledThisExecution = [];
  var newAJobCanonicalKeys = [];
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

  var canonicalClusters = _clusterJobsByCanonicalRole(normalizedJobs);
  duplicateJobsCount = normalizedJobs.length - canonicalClusters.length;
  activeRunState.rawScrapedCount = activeRunState.rawScrapedCount || sourceItems.length;
  activeRunState.totalJobsCount = activeRunState.totalJobsCount || canonicalClusters.length;

  canonicalClusters.forEach(function(cluster) {
    if (handledCanonicalKeysMap[cluster.canonicalRoleKey]) {
      return;
    }

    var existing = _findExistingCanonicalRecord(cluster, existingIndex);
    var job = _buildCanonicalCandidateJob(cluster, existing);

    if (existing && !config.forceRescore) {
      rowsToWriteWithoutScoring.push(job);
      handledThisExecution.push(cluster.canonicalRoleKey);
      handledCanonicalKeysMap[cluster.canonicalRoleKey] = true;
      return;
    }

    jobsToScore.push(job);
  });

  activeRunState.totalScoreableCount = activeRunState.totalScoreableCount || jobsToScore.length;
  scoreableJobsForThisExecution = jobsToScore.slice(0, maxJobsPerExecution);

  if (rowsToWriteWithoutScoring.length) {
    rows = rows.concat(rowsToWriteWithoutScoring);
  }

  _emitProgress(progressCallback, {
    scrapedCount: activeRunState.rawScrapedCount,
    uniqueRolesCount: activeRunState.totalJobsCount,
    toScoreCount: activeRunState.totalScoreableCount
  });

  _emitProgress(progressCallback, {
    status: 'Scoring jobs',
    processed: (activeRunState.handledCanonicalKeys.length + rowsToWriteWithoutScoring.length) + ' / ' + activeRunState.totalJobsCount
  });

  if (scoreableJobsForThisExecution.length) {
    var scoringResult = _scoreJobsInBatches(scoreableJobsForThisExecution, config, progressCallback, activeRunState.totalJobsCount, activeRunState.handledCanonicalKeys.length + rowsToWriteWithoutScoring.length);
    rows = rows.concat(scoringResult.rows);
    executionScoredJobsCount += scoringResult.scoredJobsCount;
    executionFailedJobsCount += scoringResult.failedJobsCount;
    errors = errors.concat(scoringResult.errors);
    handledThisExecution = handledThisExecution
      .concat(scoringResult.rows.map(function(job) { return job.canonicalRoleKey; }))
      .concat(scoringResult.failedCanonicalKeys || []);
    executionNewJobsCount += scoringResult.rows.filter(function(job) {
      return !job.existingRowNumber;
    }).length;
    executionAJobsCount += scoringResult.rows.filter(function(job) {
      return !job.existingRowNumber && job.priority === 'A';
    }).length;
    newAJobCanonicalKeys = scoringResult.rows.filter(function(job) {
      return !job.existingRowNumber && job.priority === 'A';
    }).map(function(job) {
      return job.canonicalRoleKey;
    });
  }

  activeRunState.handledCanonicalKeys = _appendUniqueStrings(activeRunState.handledCanonicalKeys || [], handledThisExecution);
  activeRunState.newAJobCanonicalKeys = _appendUniqueStrings(activeRunState.newAJobCanonicalKeys || [], newAJobCanonicalKeys);
  activeRunState.newJobsCount = Number(activeRunState.newJobsCount || 0) + executionNewJobsCount;
  activeRunState.aJobsCount = Number(activeRunState.aJobsCount || 0) + executionAJobsCount;
  activeRunState.scoredJobsCount = Number(activeRunState.scoredJobsCount || 0) + executionScoredJobsCount;
  activeRunState.failedJobsCount = Number(activeRunState.failedJobsCount || 0) + executionFailedJobsCount + importFailedJobsCount;
  activeRunState.importFailedJobsCount = Number(activeRunState.importFailedJobsCount || 0) + importFailedJobsCount;
  activeRunState.errors = _appendErrors(activeRunState.errors || [], errors);
  activeRunState.processedCount = Math.min(activeRunState.totalJobsCount, activeRunState.handledCanonicalKeys.length);
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
    newAJobCanonicalKeys: activeRunState.newAJobCanonicalKeys || []
  };
}

function _scoreJobsInBatches(jobs, config, progressCallback, totalJobsCount, initialProcessedCount) {
  var rows = [];
  var errors = [];
  var scoredJobsCount = 0;
  var failedJobsCount = 0;
  var processedCount = 0;
  var failedCanonicalKeys = [];
  var batchSize = config.scoringParallelRequests;

  for (var start = 0; start < jobs.length; start += batchSize) {
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
        job.summary = scoreResult.summary;
        job.why = scoreResult.why;
        job.angle = scoreResult.angle;
        job.scoredAt = new Date();

        rows.push(job);
        scoredJobsCount += 1;
      } catch (scoreError) {
        failedJobsCount += 1;
        failedCanonicalKeys.push(job.canonicalRoleKey);
        errors.push(_truncate('AI scoring failed for ' + (job.title || job.jobId) + ': ' + scoreError.message, 300));
        Logger.log(scoreError);
      }
    });

    processedCount += batch.length;
    _emitProgress(progressCallback, {
      status: 'Scoring jobs',
      processed: (initialProcessedCount + processedCount) + ' / ' + totalJobsCount
    });
  }

  return {
    rows: rows,
    scoredJobsCount: scoredJobsCount,
    failedJobsCount: failedJobsCount,
    processedCount: processedCount,
    errors: errors,
    failedCanonicalKeys: failedCanonicalKeys
  };
}

function _scoreSingleJobWithRetry(job, config, initialResponse) {
  try {
    return _parseScoreResponseByProvider(initialResponse, config.aiProvider);
  } catch (firstError) {
    Logger.log(firstError);
    var retryResponse = _executeSingleScoreRequest(_buildScoreRequest(job, config));

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
    handledCanonicalKeys: [],
    newAJobCanonicalKeys: [],
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
  var jobLink = _buildCanonicalLinkedInJobUrl(_pickFirstValue(item, ['linkedinJobId', 'jobId', 'jobPostingId']), rawJobLink) || rawJobLink;
  var searchString = _stringifyField(_pickFirstValue(item, ['searchString', 'searchQuery', 'query']));
  var contractType = _stringifyField(_pickFirstValue(item, ['contractType', 'employmentType']));
  var experienceLevel = _stringifyField(_pickFirstValue(item, ['experienceLevel', 'seniorityLevel']));
  var workType = _stringifyField(_pickFirstValue(item, ['workType', 'functionArea']));
  var publishedAt = _stringifyField(_pickFirstValue(item, ['publishedAt', 'postedAt', 'createdAt']));
  var importedAt = runStartedAt ? new Date(runStartedAt.getTime()) : new Date();

  return {
    jobId: _resolveJobId(item, company, title, location, description, jobLink),
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
    priority: '',
    score: '',
    status: 'New',
    notes: '',
    importedAt: importedAt,
    scoredAt: '',
    sourceTask: searchString || sourceLabel || '',
    postedSort: postedDate || '',
    rawRef: _truncate(JSON.stringify(item), 40000),
    jobDescription: description,
    otherLocations: '',
    canonicalRoleKey: _buildCanonicalRoleKey(company, title, description),
    contractType: contractType,
    experienceLevel: experienceLevel,
    workType: workType,
    publishedAt: publishedAt
  };
}

function _resolveJobId(item, company, title, location, description, jobLink) {
  var directJobId = _pickFirstValue(item, ['linkedinJobId', 'jobId', 'jobPostingId']);
  if (directJobId) {
    return 'linkedin_' + String(directJobId);
  }

  if (jobLink) {
    return 'url_' + _sha1(jobLink);
  }

  return 'hash_' + _sha1([company, title, location, description.slice(0, 500)].join('|'));
}

function _buildCanonicalLinkedInJobUrl(jobId, fallbackUrl) {
  var resolvedJobId = _extractLinkedInJobId(jobId) || _extractLinkedInJobId(fallbackUrl);
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
  var prompt = _buildScoringPrompt(job, config);
  var generationConfig = {
    temperature: 0.2,
    responseMimeType: 'application/json'
  };
  var payload = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: 'You score product management jobs for a single power user. Return strict JSON only.\n\n' + prompt
          }
        ]
      }
    ],
    generationConfig: generationConfig
  };

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
      headers: {
        Authorization: 'Bearer ' + ScriptApp.getOAuthToken()
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };
  }

  generationConfig.responseJsonSchema = _getScoreResponseSchema();
  return {
    url: 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(config.scoringModel) + ':generateContent',
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-goog-api-key': config.geminiApiKey
    },
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

function _buildScoringPrompt(job, config) {
  return [
    'Target profile:',
    config.targetProfile,
    '',
    'Scoring instructions:',
    config.scoringInstructions,
    '',
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
    summary: _truncate(_stringifyField(parsedContent.summary), 200),
    why: _truncate(_stringifyField(parsedContent.why), 300),
    angle: _truncate(_stringifyField(parsedContent.angle), 250)
  };
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
        enum: ['A', 'B', 'C', 'Skip'],
        description: 'Priority bucket.'
      },
      us_visa_sponsorship_potential: {
        type: 'string',
        enum: ['Likely', 'Possible', 'Unclear', 'Unlikely', 'No'],
        description: 'Estimated US visa sponsorship potential.'
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
      }
    },
    required: ['score', 'priority', 'us_visa_sponsorship_potential', 'summary', 'why', 'angle']
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
    'Act as the hiring manager for this exact role and as a pragmatic PM job-screening analyst for an international product manager candidate.',
    '',
    'Score the job against the target profile for role fit and practical pursuit priority.',
    '',
    'Important judgment rule:',
    'Judge the actual position, not just the employer. Responsibilities, required qualifications, product area, customer/user type, and success criteria matter more than company industry or brand. Do not assume a role is a fintech fit just because the employer is in finance.',
    '',
    'Return strict JSON only with exactly these keys: score, priority, us_visa_sponsorship_potential, summary, why, angle.',
    '',
    'Rules:',
    '- score: integer 0-100',
    '- priority: A, B, C, or Skip',
    '- us_visa_sponsorship_potential: Likely, Possible, Unclear, Unlikely, or No',
    '- summary, why, and angle: one short sentence each',
    '',
    'First infer:',
    '1. what domain or problem area the role actually owns',
    '2. what the person will do day to day',
    '3. what the hiring team will screen for',
    '4. whether the target profile shows direct, adjacent, or weak evidence',
    '',
    'Then score based on:',
    '- actual role domain fit',
    '- product scope',
    '- match to must-have requirements',
    '- seniority fit',
    '- company quality',
    '- realistic chance of being considered',
    '- location fit',
    '- posting urgency',
    '- whether the role creates a credible path toward stronger PM roles',
    '',
    'Do not use visa sponsorship, work authorization uncertainty, or immigration friction to increase or decrease score or priority.',
    '',
    'Priority:',
    '- A = apply first',
    '- B = review/apply soon',
    '- C = backup',
    '- Skip = do not apply',
    '',
    'Bands:',
    '- 90-100: A',
    '- 80-89: A or B',
    '- 65-79: B',
    '- 45-64: C',
    '- 0-44: Skip',
    '',
    'Calibration:',
    '- Product Manager and Senior Product Manager roles are the primary target range.',
    '- Lead, Staff, Senior Staff, Principal, Director, and higher product roles should usually be treated as stretch roles and lower practical priority unless fit and likelihood are unusually strong.',
    '- Product-adjacent roles can score well if they include product ownership, roadmap influence, customer discovery, requirements, technical solutioning, implementation strategy, or a credible PM path.',
    '- Do not over-score pure sales, account management, support, admin coordination, or generic operations.',
    '- Consumer media, ads, and gaming PM roles usually default to C unless PM scope, company quality, or bridge value is clearly strong.',
    '- Do not give A just because the company is famous or in finance.',
    '',
    'After deciding score and priority, classify visa separately.',
    '',
    'Visa:',
    '- visa output is informational only',
    '- do not use visa to increase or decrease score or priority',
    '- Likely = sponsorship is explicit or strongly supported by employer and role context',
    '- Possible = sponsorship is not explicit, but still plausibly available',
    '- Unclear = the posting gives no reliable sponsorship signal',
    '- Unlikely = sponsorship is not stated and role or employer context makes it less likely',
    '- No = the posting explicitly says no sponsorship, no current or future sponsorship, or explicitly requires unrestricted US work authorization',
    '- Do not treat wording like "US applicants only", US location eligibility, or US pay-transparency language by itself as No. If sponsorship is not explicitly ruled out, use Unclear instead.',
    '',
    'Return only valid JSON with no extra text.'
  ].join('\n');
}

function _defaultTargetProfile() {
  return [
    'Product manager and product leader with 10+ years of experience, most recently at Senior Product Manager / Associate Product Director level, with graduate business training from Yale SOM and NUS MBA.',
    'Strongest domains include fintech, banking, payments, identity verification, fraud detection, risk decisioning, authentication, eKYC/KYC, trust and safety, AI/ML-enabled products, API platforms, SDKs, enterprise SaaS, and regulated financial-institution workflows.',
    'Experience includes scaling API-based identity and fraud products, launching biometric payment authentication, defining ML model requirements, improving verification and authentication conversion, reducing integration friction, and supporting portfolio growth across APAC and LATAM.',
    'Strengths include product strategy, 0-to-1 launch, technical and platform/API product management, customer discovery, enterprise problem solving, fraud-versus-conversion tradeoff management, roadmap prioritization, and cross-functional leadership.',
    'Prioritize Product Manager and Senior Product Manager roles as the primary target, especially in fintech, payments, fraud/risk, identity, trust and safety, AI/ML platforms, developer/API platforms, enterprise SaaS, and AI workflow products.',
    'PM-adjacent bridge roles can still be attractive when they offer real product scope and strong US-market value.',
    'Lead, Staff, Senior Staff, Principal, Director, and higher product roles should usually be treated as stretch opportunities and lower practical priority unless the fit is unusually strong and the likelihood of consideration is clearly high.'
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
  var allowed = {
    A: true,
    B: true,
    C: true,
    Skip: true
  };
  var priority = _stringifyField(value);

  if (allowed[priority]) {
    return priority;
  }

  if (priority.toLowerCase() === 'skip') {
    return 'Skip';
  }

  return 'C';
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

function _buildCanonicalRoleKey(company, title, description) {
  return [
    _normalizeCanonicalText(company),
    _normalizeCanonicalText(title),
    _sha1(_cleanJobDescription(description || ''))
  ].join('|');
}

function _normalizeCanonicalText(value) {
  return _stringifyField(value)
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function _clusterJobsByCanonicalRole(jobs) {
  var clusters = {};
  var seenJobIds = {};

  jobs.forEach(function(job) {
    var canonicalRoleKey = job.canonicalRoleKey || _buildCanonicalRoleKey(job.company, job.title, job.jobDescription);

    if (seenJobIds[job.jobId]) {
      return;
    }

    seenJobIds[job.jobId] = true;

    if (!clusters[canonicalRoleKey]) {
      clusters[canonicalRoleKey] = {
        canonicalRoleKey: canonicalRoleKey,
        jobs: []
      };
    }

    clusters[canonicalRoleKey].jobs.push(job);
  });

  return Object.keys(clusters).map(function(canonicalRoleKey) {
    var cluster = clusters[canonicalRoleKey];
    cluster.primaryJob = cluster.jobs.slice().sort(_compareJobRecencyDesc)[0];
    return cluster;
  });
}

function _findExistingCanonicalRecord(cluster, existingIndex) {
  var existing = existingIndex.byCanonicalRoleKey[cluster.canonicalRoleKey];

  if (existing) {
    return existing;
  }

  for (var i = 0; i < cluster.jobs.length; i += 1) {
    existing = existingIndex.byJobId[cluster.jobs[i].jobId];
    if (existing) {
      return existing;
    }
  }

  return null;
}

function _buildCanonicalCandidateJob(cluster, existing) {
  var primaryJob = _cloneJobRecord(cluster.primaryJob);
  var locationParts = [];

  cluster.jobs.forEach(function(job) {
    locationParts.push(job.location);
  });

  if (existing) {
    _collectJobLocations(existing).forEach(function(location) {
      locationParts.push(location);
    });

    primaryJob.existingRowNumber = existing.rowNumber;
    primaryJob.location = existing.location || primaryJob.location;
    primaryJob.status = existing.status || 'New';
    primaryJob.notes = existing.notes || '';
    primaryJob.importedAt = existing.importedAt || primaryJob.importedAt;
    primaryJob.scoredAt = existing.scoredAt || '';
    primaryJob.score = existing.score === undefined ? '' : existing.score;
    primaryJob.priority = existing.priority || '';
    primaryJob.usVisaSponsorshipPotential = existing.usVisaSponsorshipPotential || '';
    primaryJob.summary = existing.summary || '';
    primaryJob.why = existing.why || '';
    primaryJob.angle = existing.angle || '';
  }

  primaryJob.otherLocations = _formatOtherLocations(locationParts, primaryJob.location);
  primaryJob.canonicalRoleKey = cluster.canonicalRoleKey;

  return primaryJob;
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
