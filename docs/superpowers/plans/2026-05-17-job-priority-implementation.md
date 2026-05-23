# Job Priority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Google Apps Script v1 that imports Apify jobs into a `Job_Priority` sheet, scores new jobs with AI, ranks them, and supports both manual and hourly runs.

**Architecture:** Use one Apps Script project with three `.gs` files plus the manifest. `main.gs` owns menus, trigger setup, and pipeline orchestration. `pipeline.gs` owns Apify fetch, normalization, dedupe, and AI scoring. `sheet.gs` owns `Job_Priority` and `Settings` sheet setup, row writes, control-strip updates, sorting, and ranking.

**Tech Stack:** Google Apps Script, Google Sheets, Apify API, Gemini API, optional OpenAI fallback, plain JavaScript

---

## File Structure

- Create: `appsscript.json`
  - Manifest for Apps Script timezone and exception logging
- Create: `main.gs`
  - Entry points: menu, setup, manual run, hourly trigger, orchestrator
- Create: `pipeline.gs`
  - Config helpers, Apify fetch, normalization, job identity, AI scoring
- Create: `sheet.gs`
  - Sheet creation, header/control strip setup, reads/writes, sort/rank, validations

### Task 1: Scaffold the Apps Script project and sheet structure

**Files:**
- Create: `appsscript.json`
- Create: `main.gs`
- Create: `sheet.gs`

- [ ] **Step 1: Create the Apps Script manifest**

```json
{
  "timeZone": "America/New_York",
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8"
}
```

- [ ] **Step 2: Add entry points in `main.gs`**

```javascript
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Jobs Pipeline')
    .addItem('Initialize Sheets', 'setupJobPriorityWorkbook')
    .addItem('Run Now', 'runJobImportAndScoring')
    .addItem('Create Hourly Trigger', 'createHourlyTrigger')
    .addItem('Remove Hourly Triggers', 'removeHourlyTriggers')
    .addItem('Validate Config', 'validateConfiguration')
    .addToUi();
}
```

- [ ] **Step 3: Build workbook setup in `sheet.gs`**

```javascript
function setupJobPriorityWorkbook() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var jobSheet = _getOrCreateSheet(spreadsheet, JOB_PRIORITY_SHEET_NAME);
  var settingsSheet = _getOrCreateSheet(spreadsheet, SETTINGS_SHEET_NAME);

  _setupJobPrioritySheet(jobSheet);
  _setupSettingsSheet(settingsSheet);
}
```

- [ ] **Step 4: Verify the sheet contract exists**

Run manually in Apps Script editor:

```text
setupJobPriorityWorkbook()
```

Expected:
- `Job_Priority` sheet exists
- `Settings` sheet exists
- control strip is present
- header row starts at row 6

### Task 2: Implement the main pipeline orchestration and trigger flow

**Files:**
- Modify: `main.gs`
- Modify: `sheet.gs`

- [ ] **Step 1: Implement the orchestrator in `main.gs`**

```javascript
function runJobImportAndScoring() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    setupJobPriorityWorkbook();

    var config = loadRuntimeConfig();
    var runStartedAt = new Date();
    updateRunSummary({
      lastRun: runStartedAt,
      lastStatus: 'Running',
      newJobs: '',
      scoredJobs: '',
      errorMessage: ''
    });

    var importedRows = importAndScoreJobs(config);

    writeJobs(importedRows);
    sortAndRankJobs();
    updateRunSummary({
      lastRun: runStartedAt,
      lastStatus: 'Success',
      newJobs: importedRows.length,
      scoredJobs: importedRows.filter(function(row) {
        return row.score !== '';
      }).length,
      errorMessage: ''
    });
  } catch (error) {
    updateRunSummary({
      lastRun: new Date(),
      lastStatus: 'Failed',
      newJobs: '',
      scoredJobs: '',
      errorMessage: error && error.message ? error.message : String(error)
    });
    throw error;
  } finally {
    lock.releaseLock();
  }
}
```

- [ ] **Step 2: Add hourly trigger helpers**

```javascript
function createHourlyTrigger() {
  removeHourlyTriggers();
  ScriptApp.newTrigger('runJobImportAndScoring').timeBased().everyHours(1).create();
}

function removeHourlyTriggers() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'runJobImportAndScoring') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}
```

- [ ] **Step 3: Add config validation entry point**

```javascript
function validateConfiguration() {
  var config = loadRuntimeConfig();
  SpreadsheetApp.getUi().alert(
    'Config looks valid for provider ' + config.aiProvider + ' and source mode ' + config.apifySourceMode + '.'
  );
}
```

- [ ] **Step 4: Verify triggers and menu wiring**

Manual checks:
- reload the spreadsheet and confirm `Jobs Pipeline` menu appears
- run `createHourlyTrigger()`
- confirm one hourly trigger exists in Apps Script

### Task 3: Implement Apify import, normalization, dedupe, and scoring

**Files:**
- Create: `pipeline.gs`

- [ ] **Step 1: Load settings and secrets**

```javascript
function loadRuntimeConfig() {
  var settings = getSettingsMap();
  var properties = PropertiesService.getScriptProperties();

  return {
    aiProvider: (settings.AI_PROVIDER || properties.getProperty('AI_PROVIDER') || 'openai').toLowerCase(),
    scoringModel: settings.SCORING_MODEL || 'gpt-4.1-mini',
    promptVersion: settings.SCORING_PROMPT_VERSION || 'v1',
    forceRescore: String(settings.FORCE_RESCORE || 'FALSE').toUpperCase() === 'TRUE',
    apifySourceMode: (settings.APIFY_SOURCE_MODE || 'task').toLowerCase(),
    apifyTaskIds: _splitCsv(settings.APIFY_TASK_IDS || properties.getProperty('APIFY_TASK_IDS')),
    apifyDatasetIds: _splitCsv(settings.APIFY_DATASET_IDS || properties.getProperty('APIFY_DATASET_IDS')),
    apifyToken: properties.getProperty('APIFY_TOKEN'),
    openAiApiKey: properties.getProperty('OPENAI_API_KEY')
  };
}
```

- [ ] **Step 2: Fetch Apify items**

```javascript
function _fetchApifyItems(config) {
  if (!config.apifyToken) {
    throw new Error('Missing APIFY_TOKEN in Script Properties.');
  }

  if (config.apifySourceMode === 'task') {
    return _fetchLatestTaskDatasetItems(config);
  }

  if (config.apifySourceMode === 'dataset') {
    return _fetchDatasetItems(config);
  }

  throw new Error('Unsupported APIFY_SOURCE_MODE: ' + config.apifySourceMode);
}
```

- [ ] **Step 3: Normalize jobs and resolve ids**

```javascript
function _normalizeJob(item, sourceTask) {
  var description = item.description || item.jobDescription || item.job_description || '';
  var jobUrl = item.jobUrl || item.url || item.link || '';
  var company = item.companyName || item.company || '';
  var title = item.title || item.positionName || '';
  var location = item.location || '';

  return {
    jobId: _resolveJobId(item, company, title, location, description, jobUrl),
    company: company,
    title: title,
    location: location,
    posted: item.postedAt || item.postedTime || item.posted || '',
    applicants: item.applicantsCount || item.applicants || '',
    jobLink: jobUrl,
    jobDescription: description,
    sourceTask: sourceTask || item.searchString || item.query || '',
    importedAt: new Date(),
    scoredAt: '',
    score: '',
    priority: '',
    summary: '',
    why: '',
    angle: '',
    status: 'New',
    notes: '',
    rawRef: JSON.stringify(item)
  };
}
```

- [ ] **Step 4: Score only new or forced-rescore jobs**

```javascript
function _scoreJobIfNeeded(job, config) {
  if (config.aiProvider !== 'openai') {
    throw new Error('Only openai is implemented in v1. Received: ' + config.aiProvider);
  }

  var prompt = _buildScoringPrompt(job, config);
  var payload = {
    model: config.scoringModel,
    messages: [
      { role: 'system', content: 'You score product management jobs for one power user.' },
      { role: 'user', content: prompt }
    ],
    response_format: { type: 'json_object' },
    temperature: 0.2
  };

  var response = UrlFetchApp.fetch('https://api.openai.com/v1/chat/completions', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + config.openAiApiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  return _parseScoreResponse(response, job);
}
```

- [ ] **Step 5: Verify pipeline helpers**

Manual checks in Apps Script:
- run `validateConfiguration()`
- run a temporary fetch call with one task or dataset configured
- confirm normalized rows contain `jobId`, `company`, `title`, and `jobLink`

### Task 4: Implement sheet writes, sorting, ranking, and preservation rules

**Files:**
- Modify: `sheet.gs`
- Modify: `pipeline.gs`

- [ ] **Step 1: Preserve manual fields while inserting new jobs**

```javascript
function writeJobs(rows) {
  if (!rows.length) {
    return;
  }

  var sheet = _getJobPrioritySheet();
  var existingIndex = getExistingJobIndex(sheet);
  var appendRows = rows
    .filter(function(row) {
      return !existingIndex[row.jobId];
    })
    .map(_toSheetRow);

  if (appendRows.length) {
    var startRow = Math.max(sheet.getLastRow() + 1, JOB_PRIORITY_DATA_START_ROW);
    sheet.getRange(startRow, 1, appendRows.length, appendRows[0].length).setValues(appendRows);
  }
}
```

- [ ] **Step 2: Add sort and rank logic**

```javascript
function sortAndRankJobs() {
  var sheet = _getJobPrioritySheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < JOB_PRIORITY_DATA_START_ROW) {
    return;
  }

  sheet.getRange(JOB_PRIORITY_DATA_START_ROW, 1, lastRow - JOB_PRIORITY_DATA_START_ROW + 1, JOB_PRIORITY_COLUMNS.length)
    .sort([
      { column: JOB_PRIORITY_COLUMN_INDEX.priority, ascending: true },
      { column: JOB_PRIORITY_COLUMN_INDEX.score, ascending: false },
      { column: JOB_PRIORITY_COLUMN_INDEX.posted, ascending: true }
    ]);

  var rankValues = [];
  for (var i = JOB_PRIORITY_DATA_START_ROW; i <= lastRow; i += 1) {
    rankValues.push([i - JOB_PRIORITY_DATA_START_ROW + 1]);
  }
  sheet.getRange(JOB_PRIORITY_DATA_START_ROW, JOB_PRIORITY_COLUMN_INDEX.rank, rankValues.length, 1).setValues(rankValues);
}
```

- [ ] **Step 3: Add dropdowns and formatting**

```javascript
var statusRule = SpreadsheetApp.newDataValidation()
  .requireValueInList(['New', 'Opened', 'Tailoring', 'Applied', 'Skip'], true)
  .setAllowInvalid(false)
  .build();

sheet.getRange(JOB_PRIORITY_DATA_START_ROW, JOB_PRIORITY_COLUMN_INDEX.status, sheet.getMaxRows() - JOB_PRIORITY_DATA_START_ROW + 1, 1)
  .setDataValidation(statusRule);
```

- [ ] **Step 4: Verify sheet behavior**

Manual checks:
- run `runJobImportAndScoring()`
- confirm new jobs append below row 6 headers
- confirm `status` defaults to `New`
- confirm rerunning does not overwrite `status` or `notes`
- confirm rows sort and ranks rewrite correctly

### Task 5: Final verification and handoff

**Files:**
- Review: `appsscript.json`
- Review: `main.gs`
- Review: `pipeline.gs`
- Review: `sheet.gs`

- [ ] **Step 1: Run syntax checks locally**

Run:

```bash
node --check main.gs
node --check pipeline.gs
node --check sheet.gs
```

Expected:
- all files pass syntax checks with no parse errors

- [ ] **Step 2: Confirm configuration checklist**

Required Script Properties:

```text
APIFY_TOKEN
GEMINI_API_KEY
```

Required `Settings` values:

```text
APIFY_SOURCE_MODE
APIFY_TASK_IDS or APIFY_DATASET_IDS
SCORING_MODEL
SCORING_PROMPT_VERSION
FORCE_RESCORE
```

- [ ] **Step 3: Document known limitations**

```text
- OpenAI is the only implemented scoring provider in v1
- Notifications are not implemented
- The workspace is not a git repository, so no commit step is possible
```

## Self-Review

- Spec coverage: covered primary `Job_Priority` tab, `Settings` support tab, menu-based manual run, hourly trigger, scoring, ranking, and preservation of `status`/`notes`
- Placeholder scan: no `TODO`/`TBD` placeholders remain
- Type consistency: `runJobImportAndScoring`, `loadRuntimeConfig`, `importAndScoreJobs`, `writeJobs`, and `sortAndRankJobs` are used consistently
