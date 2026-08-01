import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { Queue } from "bullmq";
import type {
  Document,
  DocumentSourceType,
  Job,
  SummaryMode
} from "@max-summary/shared-types";
import {
  documentSourceTypes,
  summaryModes
} from "@max-summary/shared-types";
import {
  checkExtractorReadiness,
  defaultExtractorConfig,
  queueNames,
  toErrorMessage,
  type DocumentProcessingJobPayload,
  type ExtractorRuntimeConfig
} from "@max-summary/core";
import {
  PostgresDocumentRepository,
  PostgresJobRepository,
  PostgresSummaryRepository,
  checkPostgresHealth,
  checkRedisHealth,
  closeRedisConnection,
  createDocumentQueue,
  createPostgresPool,
  createRedisConnection,
  defaultStorageConfig,
  initializeStorage,
  transitionDocumentJobStatus,
  withTransaction
} from "@max-summary/storage";

const serviceName = "api";
const host = process.env.API_HOST ?? "0.0.0.0";
const port = Number(process.env.API_PORT ?? 3002);

type CreateDocumentPayload = Partial<{
  sourceType: DocumentSourceType;
  sourceUri: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  inlineText: string;
  language: string;
  mode: SummaryMode;
}>;

interface ApiRuntime {
  documents: PostgresDocumentRepository;
  jobs: PostgresJobRepository;
  summaries: PostgresSummaryRepository;
  queue: Queue<DocumentProcessingJobPayload>;
  pool: ReturnType<typeof createPostgresPool>;
  redis: ReturnType<typeof createRedisConnection>;
  extractorConfig: ExtractorRuntimeConfig;
}

type ValidationResult =
  | {
      ok: true;
      value: {
        sourceType: DocumentSourceType;
        mode: SummaryMode;
        sourceUri?: string;
        fileName?: string;
        mimeType?: string;
        sizeBytes?: number;
        inlineText?: string;
        language?: string;
      };
    }
  | {
      ok: false;
      errors: string[];
    };

function buildServer(runtime: ApiRuntime) {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info"
    }
  });

  app.get("/", async () => {
    return {
      service: serviceName,
      status: "ok",
      purpose: "document intake and orchestration"
    };
  });

  app.get("/healthz", async (_request, reply) => {
    const health = await collectDependencyChecks(runtime);
    reply.code(health.status === "ok" ? 200 : 503);

    return {
      status: health.status,
      service: serviceName,
      timestamp: new Date().toISOString(),
      checks: health.checks
    };
  });

  app.get("/readyz", async (_request, reply) => {
    const readiness = await collectDependencyChecks(runtime);
    reply.code(readiness.status === "ok" ? 200 : 503);

    return {
      status: readiness.status === "ok" ? "ready" : "not-ready",
      service: serviceName,
      checks: readiness.checks
    };
  });

  app.post<{ Body: CreateDocumentPayload }>("/documents", async (request, reply) => {
    const validation = validateCreateDocumentPayload(request.body);

    if (!validation.ok) {
      reply.code(400);
      return {
        message: "Invalid document payload.",
        errors: validation.errors
      };
    }

    const now = new Date().toISOString();
    const queuedStatus = "queued" as const;

    const document: Document = {
      id: randomUUID(),
      sourceType: validation.value.sourceType,
      status: queuedStatus,
      createdAt: now,
      updatedAt: now,
      ...(validation.value.sourceUri ? { sourceUri: validation.value.sourceUri } : {}),
      ...(validation.value.fileName ? { fileName: validation.value.fileName } : {}),
      ...(validation.value.mimeType ? { mimeType: validation.value.mimeType } : {}),
      ...(typeof validation.value.sizeBytes === "number"
        ? { sizeBytes: validation.value.sizeBytes }
        : {}),
      ...(validation.value.inlineText ? { inlineText: validation.value.inlineText } : {}),
      ...(validation.value.language ? { language: validation.value.language } : {})
    };

    const job: Job = {
      id: randomUUID(),
      documentId: document.id,
      mode: validation.value.mode,
      status: queuedStatus,
      attempts: 0,
      createdAt: now,
      updatedAt: now
    };

    await withTransaction(runtime.pool, async (client) => {
      const documents = new PostgresDocumentRepository(client);
      const jobs = new PostgresJobRepository(client);
      await documents.create(document);
      await jobs.create(job);
    });

    try {
      await runtime.queue.add(
        queueNames.documentProcessing,
        {
          documentId: document.id,
          jobId: job.id,
          queuedAt: now
        },
        {
          jobId: job.id
        }
      );
    } catch (error) {
      const message = `Failed to enqueue document job: ${toErrorMessage(error)}`;
      await transitionDocumentJobStatus(runtime.pool, {
        documentId: document.id,
        jobId: job.id,
        status: "failed",
        errorMessage: message,
        finishedAt: new Date().toISOString()
      });

      reply.code(503);
      return {
        message,
        documentId: document.id,
        jobId: job.id,
        status: "failed"
      };
    }

    reply.code(202);

    return {
      message: "Document accepted for processing.",
      document,
      job,
      status: job.status
    };
  });

  app.get<{ Params: { id: string } }>("/documents/:id/status", async (request, reply) => {
    const document = await runtime.documents.findById(request.params.id);

    if (!document) {
      reply.code(404);
      return {
        documentId: request.params.id,
        message: "Document not found."
      };
    }

    const job = await runtime.jobs.findLatestByDocumentId(document.id);

    if (!job) {
      reply.code(404);
      return {
        documentId: document.id,
        message: "No processing job found for document."
      };
    }

    return {
      documentId: document.id,
      sourceType: document.sourceType,
      jobId: job.id,
      status: job.status,
      error: job.error,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt
    };
  });

  app.get<{ Params: { id: string } }>("/documents/:id/summary", async (request, reply) => {
    const document = await runtime.documents.findById(request.params.id);

    if (!document) {
      reply.code(404);
      return {
        documentId: request.params.id,
        message: "Document not found."
      };
    }

    const summary = await runtime.summaries.findByDocumentId(document.id);

    if (summary) {
      return {
        documentId: document.id,
        status: document.status,
        summary
      };
    }

    const job = await runtime.jobs.findLatestByDocumentId(document.id);

    if (!job) {
      reply.code(404);
      return {
        documentId: document.id,
        message: "No processing job found for document."
      };
    }

    if (job.status === "failed") {
      reply.code(404);
      return {
        documentId: document.id,
        status: job.status,
        message: "Summary generation failed.",
        error: job.error
      };
    }

    reply.code(202);

    return {
      documentId: document.id,
      status: job.status,
      message: "Summary is not ready yet."
    };
  });

  return app;
}

function validateCreateDocumentPayload(payload: unknown): ValidationResult {
  const errors: string[] = [];
  const input =
    payload === undefined
      ? {}
      : isRecord(payload)
        ? payload
        : (errors.push("Payload must be a JSON object."), {});

  const sourceType = readEnumValue(
    input.sourceType,
    documentSourceTypes,
    "sourceType",
    "pdf",
    errors
  );
  const mode = readEnumValue(input.mode, summaryModes, "mode", "brief", errors);
  const sourceUri = readOptionalTrimmedString(input.sourceUri, "sourceUri", errors);
  const fileName = readOptionalTrimmedString(input.fileName, "fileName", errors);
  const mimeType = readOptionalTrimmedString(input.mimeType, "mimeType", errors);
  const language = readOptionalTrimmedString(input.language, "language", errors);
  const inlineText = readOptionalText(input.inlineText, "inlineText", errors);
  const sizeBytes = readOptionalSizeBytes(input.sizeBytes, errors);

  if (sourceUri) {
    validateAbsoluteUrl(sourceUri, "sourceUri", errors);
  }

  if (sourceType === "inline-text" && !inlineText) {
    errors.push("inlineText is required when sourceType is inline-text.");
  }

  if (sourceType === "url" && !sourceUri) {
    errors.push("sourceUri is required when sourceType is url.");
  }

  if (
    ["pdf", "docx", "txt"].includes(sourceType) &&
    !sourceUri &&
    !fileName &&
    !inlineText
  ) {
    errors.push(
      `Provide sourceUri, fileName, or inlineText for ${sourceType} intake so the extractor has usable input.`
    );
  }

  if (errors.length > 0) {
    return {
      ok: false,
      errors
    };
  }

  return {
    ok: true,
    value: {
      sourceType,
      mode,
      ...(sourceUri ? { sourceUri } : {}),
      ...(fileName ? { fileName } : {}),
      ...(mimeType ? { mimeType } : {}),
      ...(typeof sizeBytes === "number" ? { sizeBytes } : {}),
      ...(inlineText ? { inlineText } : {}),
      ...(language ? { language } : {})
    }
  };
}

async function collectDependencyChecks(runtime: ApiRuntime) {
  const [postgres, redis, queue, extractor] = await Promise.all([
    checkPostgresHealth(runtime.pool),
    checkRedisHealth(runtime.redis),
    checkQueueHealth(runtime),
    checkExtractorReadiness(runtime.extractorConfig)
  ]);
  const checks = [postgres, redis, queue, extractor];

  return {
    status: checks.every((check) => check.status === "ok") ? "ok" : "error",
    checks
  };
}

async function checkQueueHealth(runtime: ApiRuntime) {
  const startedAt = Date.now();

  try {
    const counts = await runtime.queue.getJobCounts("wait", "active", "completed", "failed");
    return {
      name: "bullmq",
      status: "ok" as const,
      latencyMs: Date.now() - startedAt,
      details: JSON.stringify(counts)
    };
  } catch (error) {
    return {
      name: "bullmq",
      status: "error" as const,
      latencyMs: Date.now() - startedAt,
      details: toErrorMessage(error)
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readEnumValue<TValue extends string>(
  value: unknown,
  allowedValues: readonly TValue[],
  fieldName: string,
  fallback: TValue,
  errors: string[]
): TValue {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "string" || !allowedValues.includes(value as TValue)) {
    errors.push(`${fieldName} must be one of: ${allowedValues.join(", ")}.`);
    return fallback;
  }

  return value as TValue;
}

function readOptionalTrimmedString(
  value: unknown,
  fieldName: string,
  errors: string[]
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    errors.push(`${fieldName} must be a string.`);
    return undefined;
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    errors.push(`${fieldName} cannot be empty.`);
    return undefined;
  }

  return trimmed;
}

function readOptionalText(
  value: unknown,
  fieldName: string,
  errors: string[]
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    errors.push(`${fieldName} must be a string.`);
    return undefined;
  }

  if (value.trim().length === 0) {
    errors.push(`${fieldName} cannot be empty.`);
    return undefined;
  }

  return value;
}

function readOptionalSizeBytes(value: unknown, errors: string[]): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    errors.push("sizeBytes must be a non-negative integer.");
    return undefined;
  }

  return value;
}

function validateAbsoluteUrl(value: string, fieldName: string, errors: string[]): void {
  try {
    new URL(value);
  } catch {
    errors.push(`${fieldName} must be an absolute URL.`);
  }
}

async function start() {
  const config = defaultStorageConfig();
  const extractorConfig = defaultExtractorConfig();
  const pool = createPostgresPool(config);
  const redis = createRedisConnection(config);
  const queue = createDocumentQueue<DocumentProcessingJobPayload>(
    redis,
    queueNames.documentProcessing
  );

  await initializeStorage(pool);
  await pool.query("SELECT 1");
  await redis.ping();
  await queue.waitUntilReady();

  const runtime: ApiRuntime = {
    documents: new PostgresDocumentRepository(pool),
    jobs: new PostgresJobRepository(pool),
    summaries: new PostgresSummaryRepository(pool),
    queue,
    pool,
    redis,
    extractorConfig
  };
  const app = buildServer(runtime);

  const shutdown = async (signal: NodeJS.Signals) => {
    app.log.info({ signal }, "shutting down");
    await Promise.allSettled([
      app.close(),
      queue.close(),
      closeRedisConnection(redis),
      pool.end()
    ]);
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await app.listen({ host, port });
  app.log.info({ host, port }, "service started");
}

void start().catch((error) => {
  console.error(error);
  process.exit(1);
});
