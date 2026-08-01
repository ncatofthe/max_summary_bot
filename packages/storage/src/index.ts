import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { Pool, type PoolClient } from "pg";
import type {
  Document,
  Job,
  JobStatus,
  Summary,
  SummarizationResult
} from "@max-summary/shared-types";

export interface StorageConfig {
  postgresUrl: string;
  redisUrl: string;
}

export interface DependencyCheck {
  name: string;
  status: "ok" | "error";
  latencyMs: number;
  details?: string;
}

export interface DocumentRepository {
  create(document: Document): Promise<Document>;
  findById(id: string): Promise<Document | null>;
  updateStatus(id: string, status: JobStatus): Promise<Document | null>;
}

export interface UpdateJobStatusInput {
  status: JobStatus;
  attempts?: number;
  errorMessage?: string;
  clearError?: boolean;
  startedAt?: string;
  finishedAt?: string;
}

export interface JobRepository {
  create(job: Job): Promise<Job>;
  findById(id: string): Promise<Job | null>;
  findLatestByDocumentId(documentId: string): Promise<Job | null>;
  updateStatus(id: string, input: UpdateJobStatusInput): Promise<Job | null>;
}

export interface SummaryRepository {
  upsert(result: SummarizationResult, summaryId?: string): Promise<Summary>;
  findByDocumentId(documentId: string): Promise<Summary | null>;
}

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

type TimestampValue = Date | string;
const STORAGE_SCHEMA_LOCK_ID = 2_024_041_601;

interface DocumentRow {
  id: string;
  source_type: Document["sourceType"];
  source_uri: string | null;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  inline_text: string | null;
  sha256: string | null;
  storage_key: string | null;
  language: string | null;
  status: JobStatus;
  created_at: TimestampValue;
  updated_at: TimestampValue;
}

interface JobRow {
  id: string;
  document_id: string;
  mode: Job["mode"];
  status: JobStatus;
  attempts: number;
  error: string | null;
  created_at: TimestampValue;
  updated_at: TimestampValue;
  started_at: TimestampValue | null;
  finished_at: TimestampValue | null;
}

interface SummaryRow {
  id: string;
  document_id: string;
  job_id: string;
  mode: Summary["mode"];
  short_summary: string;
  detailed_summary: string | null;
  key_points: string[];
  action_items: string[];
  risks: string[];
  sections: Summary["sections"] | null;
  warnings: string[];
  generated_at: TimestampValue;
  created_at: TimestampValue;
  updated_at: TimestampValue;
}

export const STORAGE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_uri TEXT,
  file_name TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  inline_text TEXT,
  sha256 TEXT,
  storage_key TEXT,
  language TEXT,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_documents_status ON documents (status);

ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_uri TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS file_name TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS mime_type TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS size_bytes INTEGER;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS inline_text TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS language TEXT;

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_jobs_document_id ON jobs (document_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status);

CREATE TABLE IF NOT EXISTS summaries (
  id UUID PRIMARY KEY,
  document_id UUID NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  short_summary TEXT NOT NULL,
  detailed_summary TEXT,
  key_points JSONB NOT NULL DEFAULT '[]'::jsonb,
  action_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  risks JSONB NOT NULL DEFAULT '[]'::jsonb,
  sections JSONB,
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  generated_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

export function defaultStorageConfig(): StorageConfig {
  return {
    postgresUrl:
      process.env.POSTGRES_URL ?? "postgres://postgres:postgres@localhost:5432/max_summary_bot",
    redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379"
  };
}

export function createPostgresPool(config = defaultStorageConfig()): Pool {
  return new Pool({
    connectionString: config.postgresUrl
  });
}

export function createRedisConnection(config = defaultStorageConfig()): Redis {
  return new Redis(config.redisUrl, {
    maxRetriesPerRequest: null
  });
}

export function createDocumentQueue<TData>(connection: Redis, queueName: string): Queue<TData> {
  return new Queue<TData>(queueName, {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 100
    }
  });
}

export async function initializeStorage(db: Queryable): Promise<void> {
  await db.query("SELECT pg_advisory_lock($1)", [STORAGE_SCHEMA_LOCK_ID]);

  try {
    await db.query(STORAGE_SCHEMA_SQL);
  } finally {
    await db.query("SELECT pg_advisory_unlock($1)", [STORAGE_SCHEMA_LOCK_ID]);
  }
}

export async function withTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function checkPostgresHealth(db: Queryable): Promise<DependencyCheck> {
  const startedAt = Date.now();

  try {
    await db.query("SELECT 1");
    return {
      name: "postgres",
      status: "ok",
      latencyMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      name: "postgres",
      status: "error",
      latencyMs: Date.now() - startedAt,
      details: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function checkRedisHealth(redis: Redis): Promise<DependencyCheck> {
  const startedAt = Date.now();

  try {
    const response = await redis.ping();
    return {
      name: "redis",
      status: response === "PONG" ? "ok" : "error",
      latencyMs: Date.now() - startedAt,
      ...(response === "PONG" ? {} : { details: `Unexpected response: ${response}` })
    };
  } catch (error) {
    return {
      name: "redis",
      status: "error",
      latencyMs: Date.now() - startedAt,
      details: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function closeRedisConnection(redis: Redis): Promise<void> {
  if (redis.status === "end") {
    return;
  }

  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
}

export class PostgresDocumentRepository implements DocumentRepository {
  constructor(private readonly db: Queryable) {}

  async create(document: Document): Promise<Document> {
    const result = await this.db.query<DocumentRow>(
      `
        INSERT INTO documents (
          id,
          source_type,
          source_uri,
          file_name,
          mime_type,
          size_bytes,
          inline_text,
          sha256,
          storage_key,
          language,
          status,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING *
      `,
      [
        document.id,
        document.sourceType,
        document.sourceUri ?? null,
        document.fileName ?? null,
        document.mimeType ?? null,
        document.sizeBytes ?? null,
        document.inlineText ?? null,
        document.sha256 ?? null,
        document.storageKey ?? null,
        document.language ?? null,
        document.status,
        document.createdAt,
        document.updatedAt
      ]
    );

    return mapRequiredRow(result.rows, mapDocumentRow, "document insert returned no rows");
  }

  async findById(id: string): Promise<Document | null> {
    const result = await this.db.query<DocumentRow>(
      `
        SELECT *
        FROM documents
        WHERE id = $1
      `,
      [id]
    );

    return mapSingleRow(result.rows, mapDocumentRow);
  }

  async updateStatus(id: string, status: JobStatus): Promise<Document | null> {
    const result = await this.db.query<DocumentRow>(
      `
        UPDATE documents
        SET status = $2, updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [id, status]
    );

    return mapSingleRow(result.rows, mapDocumentRow);
  }
}

export class PostgresJobRepository implements JobRepository {
  constructor(private readonly db: Queryable) {}

  async create(job: Job): Promise<Job> {
    const result = await this.db.query<JobRow>(
      `
        INSERT INTO jobs (
          id,
          document_id,
          mode,
          status,
          attempts,
          error,
          created_at,
          updated_at,
          started_at,
          finished_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *
      `,
      [
        job.id,
        job.documentId,
        job.mode,
        job.status,
        job.attempts,
        job.error ?? null,
        job.createdAt,
        job.updatedAt,
        job.startedAt ?? null,
        job.finishedAt ?? null
      ]
    );

    return mapRequiredRow(result.rows, mapJobRow, "job insert returned no rows");
  }

  async findById(id: string): Promise<Job | null> {
    const result = await this.db.query<JobRow>(
      `
        SELECT *
        FROM jobs
        WHERE id = $1
      `,
      [id]
    );

    return mapSingleRow(result.rows, mapJobRow);
  }

  async findLatestByDocumentId(documentId: string): Promise<Job | null> {
    const result = await this.db.query<JobRow>(
      `
        SELECT *
        FROM jobs
        WHERE document_id = $1
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [documentId]
    );

    return mapSingleRow(result.rows, mapJobRow);
  }

  async updateStatus(id: string, input: UpdateJobStatusInput): Promise<Job | null> {
    const values: unknown[] = [id, input.status];
    const assignments = ["status = $2", "updated_at = NOW()"];

    if (typeof input.attempts === "number") {
      values.push(input.attempts);
      assignments.push(`attempts = $${values.length}`);
    }

    if (input.clearError) {
      assignments.push("error = NULL");
    }

    if (typeof input.errorMessage === "string") {
      values.push(input.errorMessage);
      assignments.push(`error = $${values.length}`);
    }

    if (typeof input.startedAt === "string") {
      values.push(input.startedAt);
      assignments.push(`started_at = $${values.length}`);
    }

    if (typeof input.finishedAt === "string") {
      values.push(input.finishedAt);
      assignments.push(`finished_at = $${values.length}`);
    }

    const result = await this.db.query<JobRow>(
      `
        UPDATE jobs
        SET ${assignments.join(", ")}
        WHERE id = $1
        RETURNING *
      `,
      values
    );

    return mapSingleRow(result.rows, mapJobRow);
  }
}

export class PostgresSummaryRepository implements SummaryRepository {
  constructor(private readonly db: Queryable) {}

  async upsert(result: SummarizationResult, summaryId = randomUUID()): Promise<Summary> {
    const queryResult = await this.db.query<SummaryRow>(
      `
        INSERT INTO summaries (
          id,
          document_id,
          job_id,
          mode,
          short_summary,
          detailed_summary,
          key_points,
          action_items,
          risks,
          sections,
          warnings,
          generated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (document_id)
        DO UPDATE SET
          job_id = EXCLUDED.job_id,
          mode = EXCLUDED.mode,
          short_summary = EXCLUDED.short_summary,
          detailed_summary = EXCLUDED.detailed_summary,
          key_points = EXCLUDED.key_points,
          action_items = EXCLUDED.action_items,
          risks = EXCLUDED.risks,
          sections = EXCLUDED.sections,
          warnings = EXCLUDED.warnings,
          generated_at = EXCLUDED.generated_at,
          updated_at = NOW()
        RETURNING *
      `,
      [
        summaryId,
        result.documentId,
        result.jobId,
        result.mode,
        result.shortSummary,
        result.detailedSummary ?? null,
        JSON.stringify(result.keyPoints),
        JSON.stringify(result.actionItems),
        JSON.stringify(result.risks),
        result.sections ? JSON.stringify(result.sections) : null,
        JSON.stringify(result.warnings ?? []),
        result.generatedAt
      ]
    );

    return mapRequiredRow(queryResult.rows, mapSummaryRow, "summary upsert returned no rows");
  }

  async findByDocumentId(documentId: string): Promise<Summary | null> {
    const result = await this.db.query<SummaryRow>(
      `
        SELECT *
        FROM summaries
        WHERE document_id = $1
      `,
      [documentId]
    );

    return mapSingleRow(result.rows, mapSummaryRow);
  }
}

export interface TransitionDocumentJobStatusInput extends UpdateJobStatusInput {
  documentId: string;
  jobId: string;
}

export async function transitionDocumentJobStatus(
  pool: Pool,
  input: TransitionDocumentJobStatusInput
): Promise<{ document: Document | null; job: Job | null }> {
  return withTransaction(pool, async (client) => {
    const documents = new PostgresDocumentRepository(client);
    const jobs = new PostgresJobRepository(client);
    const document = await documents.updateStatus(input.documentId, input.status);
    const job = await jobs.updateStatus(input.jobId, input);

    return { document, job };
  });
}

function mapDocumentRow(row: DocumentRow): Document {
  return {
    id: row.id,
    sourceType: row.source_type,
    status: row.status,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    ...(row.source_uri ? { sourceUri: row.source_uri } : {}),
    ...(row.file_name ? { fileName: row.file_name } : {}),
    ...(row.mime_type ? { mimeType: row.mime_type } : {}),
    ...(typeof row.size_bytes === "number" ? { sizeBytes: row.size_bytes } : {}),
    ...(row.inline_text ? { inlineText: row.inline_text } : {}),
    ...(row.sha256 ? { sha256: row.sha256 } : {}),
    ...(row.storage_key ? { storageKey: row.storage_key } : {}),
    ...(row.language ? { language: row.language } : {})
  };
}

function mapJobRow(row: JobRow): Job {
  return {
    id: row.id,
    documentId: row.document_id,
    mode: row.mode,
    status: row.status,
    attempts: row.attempts,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    ...(row.error ? { error: row.error } : {}),
    ...(row.started_at ? { startedAt: toIsoString(row.started_at) } : {}),
    ...(row.finished_at ? { finishedAt: toIsoString(row.finished_at) } : {})
  };
}

function mapSummaryRow(row: SummaryRow): Summary {
  return {
    id: row.id,
    documentId: row.document_id,
    jobId: row.job_id,
    mode: row.mode,
    shortSummary: row.short_summary,
    keyPoints: row.key_points,
    actionItems: row.action_items,
    risks: row.risks,
    warnings: row.warnings,
    generatedAt: toIsoString(row.generated_at),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    ...(row.detailed_summary ? { detailedSummary: row.detailed_summary } : {}),
    ...(row.sections ? { sections: row.sections } : {})
  };
}

function mapSingleRow<TInput, TOutput>(
  rows: TInput[],
  mapper: (row: TInput) => TOutput
): TOutput | null {
  const row = rows[0];

  return row ? mapper(row) : null;
}

function mapRequiredRow<TInput, TOutput>(
  rows: TInput[],
  mapper: (row: TInput) => TOutput,
  message: string
): TOutput {
  const row = rows[0];

  if (!row) {
    throw new Error(message);
  }

  return mapper(row);
}

function toIsoString(value: TimestampValue): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
