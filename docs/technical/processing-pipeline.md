# Processing Pipeline

## Intake Contract

`POST /documents` accepts:

- `sourceType`
- `sourceUri?`
- `fileName?`
- `mimeType?`
- `sizeBytes?`
- `inlineText?`
- `language?`
- `mode?`

Validation rules:

- `sourceType=inline-text` requires non-empty `inlineText`
- `sourceType=url` requires absolute `sourceUri`
- `sourceType=pdf|docx|txt` requires at least one usable extractor input: `sourceUri`, `fileName`, or `inlineText`
- `sizeBytes`, when provided, must be a non-negative integer

## Persistence

`documents`
- `id`
- `source_type`
- `source_uri`
- `file_name`
- `mime_type`
- `size_bytes`
- `inline_text`
- `language`
- `status`
- `created_at`
- `updated_at`

`jobs`
- `id`
- `document_id`
- `mode`
- `status`
- `attempts`
- `error`
- `created_at`
- `updated_at`
- `started_at`
- `finished_at`

`summaries`
- `id`
- `document_id`
- `job_id`
- `mode`
- `short_summary`
- `detailed_summary`
- `key_points`
- `action_items`
- `risks`
- `sections`
- `warnings`
- `generated_at`
- `created_at`
- `updated_at`

Schema initialization stays code-driven and idempotent. New document columns are added with `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so the runtime can upgrade an existing local database without a migration framework.

## Worker Flow

API creates `documents` and `jobs` in PostgreSQL with status `queued`, then enqueues BullMQ job `document-processing`.

Worker transitions:

`queued -> validating -> extracting -> chunking -> summarizing -> formatting -> completed`

If extraction or summarization throws, the job becomes `failed`, `jobs.error` is filled, and `finished_at` is written.

Terminal statuses:

- `completed`
- `failed`
- `expired`

`documents.status` mirrors the latest job status in this MVP flow.

## Extractor Bridge

Worker calls:

`POST ${EXTRACTOR_URL}/extract`

JSON body:

```json
{
  "documentId": "uuid",
  "sourceType": "inline-text",
  "sourceUri": "https://example.com/doc",
  "fileName": "note.txt",
  "mimeType": "text/plain",
  "inlineText": "Real source text",
  "language": "ru"
}
```

Success handling:

- `2xx` response
- no error-like status such as `error`, `failed`, or `not_implemented`
- response contains a usable extract result for the summarizer contract

Failure handling:

- extractor unreachable
- non-`2xx`
- extractor JSON status signals error/not implemented
- malformed extraction payload

All of these fail the job and persist the error in PostgreSQL.

## Summary Flow

After successful extraction the worker:

1. computes lightweight chunk metadata from extractor output
2. builds `SummarizationRequest`
3. calls the existing summarizer contract
4. stores the result in `summaries`

`GET /documents/:id/summary` returns:

- `200` with saved summary when ready
- `202` while processing continues
- `404` for missing document/job or failed summary generation

## Health and Readiness

API and worker expose best-effort checks for:

- PostgreSQL
- Redis
- BullMQ
- extractor target readiness via `GET /readyz` or fallback `GET /healthz`

If extractor target is unavailable, worker `readyz` becomes `503` and includes extractor failure details.

## Remaining Stubs

- chunking is still lightweight bookkeeping, not semantic chunk planning
- summarization still does not call a real LLM provider; current behavior depends on the existing non-LLM summarizer implementation
- binary upload/object-storage driven document retrieval is still outside this processing layer
- MAX delivery remains outside this processing layer
