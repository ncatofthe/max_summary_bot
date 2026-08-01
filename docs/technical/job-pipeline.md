# Job Pipeline

This MVP pipeline persists document intake in PostgreSQL and uses BullMQ over Redis for background processing.

## Tables

`documents`
- `id`
- `source_type`
- `source_uri`
- `file_name`
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

Schema initialization is idempotent and runs from `@max-summary/storage` on API and worker startup.

## Status Flow

The API creates a `document` and a `job` with status `queued`, then enqueues the BullMQ job.

The worker moves the job through:

`queued -> validating -> extracting -> chunking -> summarizing -> formatting -> completed`

If any step throws, the worker writes `failed`, stores the error text, and updates timestamps.

`documents.status` mirrors the latest job status for the current MVP flow.

## Current Stubs

- Extraction is stubbed with synthetic text built from document metadata.
- Chunking is a lightweight placeholder and only logs a stub chunk count.
- Summarization uses the existing `StubSummarizer`; no real LLM provider is called.
- Only the API and worker services are wired into the queue/persistence foundation here. MAX delivery stays outside this flow.
