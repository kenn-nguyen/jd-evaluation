# Job Priority v1 Design

## Summary

Build a Google Sheets-first job review workflow for a single power user.

Apify is the source of truth for search setup, schedules, and scraping. Google Apps Script imports Apify results, deduplicates jobs, scores new jobs with AI, and writes the output into one primary operator sheet with a minimal settings support tab.

The user experience is intentionally lightweight:

- one primary working tab
- one small support settings tab
- one manual run action
- one hourly background trigger
- one ranked table for daily review

## Goals

- Let the user open one sheet and immediately see which jobs deserve attention.
- Keep the system low-code and easy to operate manually.
- Preserve user workflow fields like status and notes across automated runs.
- Make the AI output useful for fast review, not verbose analysis.

## Non-Goals

- Search configuration inside Google Sheets
- Multi-screen web app UI
- Notification workflows in v1
- Deep analytics dashboards in v1

## System Ownership

### Apify

Apify owns:

- LinkedIn search queries
- scraper settings
- schedules
- dataset generation

### Apps Script

Apps Script owns:

- dataset import
- normalization
- job identity resolution
- deduplication
- AI scoring
- sorting and rank assignment
- logging last-run metadata into the sheet

### Google Sheet

Google Sheets owns:

- the visible ranked operator table
- editable settings
- manual workflow fields such as status and notes

## UX Structure

Use one primary sheet tab named `Job_Priority`.

Add one small support tab named `Settings` for editable non-secret configuration.

Daily workflow happens in `Job_Priority`. `Settings` is not part of the day-to-day review surface.

The `Job_Priority` tab has two zones:

1. A compact control strip in the top rows
2. The ranked jobs table below it

No separate dashboard or runs tab is required for v1.

## Control Strip

Reserve the top of the sheet for a small operator strip, for example rows 1 to 4.

Visible fields:

- `Manual run`
- `Last run`
- `Last status`
- `New jobs last run`
- `Scored last run`
- `Errors`

`Manual run` should indicate that the operator starts the pipeline from a custom Apps Script menu. A drawing-button can be added later if needed, but the default interaction should be a menu item because it is simpler and more reliable.

## Main Working Table

Start the table at row 6.

Visible columns:

```text
rank
priority
score
company
title
location
posted
applicants
job_link
summary
why
angle
status
notes
```

### Column Intent

- `rank`: generated after sorting; 1 is the top job to review
- `priority`: `A`, `B`, `C`, or `Skip`
- `score`: integer from 0 to 100
- `company`: company name
- `title`: job title
- `location`: normalized location string
- `posted`: human-readable or normalized recency field from source
- `applicants`: application count or range if available
- `job_link`: clickable source link
- `summary`: one short line describing what the role is about
- `why`: one short line explaining the fit or skip reason
- `angle`: one short line on how to position the user for this role
- `status`: manual workflow state
- `notes`: free-text user notes

## Hidden System Columns

Keep a few system fields on the far right or hidden to support stable automation:

```text
job_id
imported_at
scored_at
source_task
raw_ref
```

These fields should not be part of the daily review surface, but they are required for safe deduplication, rescoring, and debugging.

## Status Workflow

Use a simple manual status flow:

```text
New
Opened
Tailoring
Applied
Skip
```

Apps Script must never overwrite user-managed `status` or `notes` fields during import refreshes.

## AI Output Contract

The AI scoring layer should return a small structured result, not a long narrative.

Target output:

```json
{
  "score": 91,
  "priority": "A",
  "summary": "Payments risk PM role for merchant fraud and trust tooling.",
  "why": "Strong fit across fintech, payments, fraud, and platform product work.",
  "angle": "Position as a fintech platform PM with fraud, identity, and API scaling experience.",
  "decision": "Focus first"
}
```

Allowed values:

- `priority`: `A`, `B`, `C`, `Skip`
- `decision`: `Focus first`, `Review`, `Low priority`, `Skip`

`decision` is useful for internal logic, but does not need to be shown in the visible table if `priority` already covers the workflow.

## Sorting and Ranking

After each scoring run, sort rows by:

1. `priority` with `A` first, then `B`, then `C`, then `Skip`
2. `score` descending
3. `posted` newest first where parsing is possible

After sorting, rewrite `rank` from top to bottom.

## Triggers and Entry Points

The system has two execution paths:

1. Manual run from the custom menu
2. Automatic hourly trigger in Apps Script

Both paths call the same pipeline function so behavior stays consistent.

## Settings Model

Keep one small `Settings` sheet for non-secret values only.

Expected settings:

- `SCORING_MODEL`
- `SCORING_PROMPT_VERSION`
- `MIN_SCORE_NOTIFY`
- `FORCE_RESCORE`
- `APIFY_DATASET_MODE`

Keep secrets in Script Properties, not in the sheet:

- `APIFY_TOKEN`
- `GEMINI_API_KEY`
- `OPENAI_API_KEY`
- other provider keys if needed

## Data Flow

The runtime flow is:

1. Fetch latest Apify dataset items
2. Normalize each job
3. Resolve `job_id`
4. Skip duplicates
5. Insert new rows into `Job_Priority`
6. Score new jobs
7. Write `score`, `priority`, `summary`, `why`, and `angle`
8. Sort rows
9. Recompute `rank`
10. Update control-strip run metadata

## Error Handling

For v1, keep error handling visible and simple:

- show last run status in the control strip
- show last error message in the control strip
- do not clear existing job rows on failure
- allow the next run to retry normally

## Testing Expectations

The implementation should be validated with:

- one manual import run
- one duplicate-import run to confirm no double insert
- one scoring run on at least a few jobs
- one hourly trigger setup check
- one verification that `status` and `notes` survive reruns

## Open Constraints

- This folder is not currently a git repository, so the design doc can be stored locally but not committed unless the project is later initialized as a repo.
