import Fastify from "fastify";
import type { FastifyBaseLogger } from "fastify";
import { Worker, type Job as BullMQJob, type Queue } from "bullmq";
import { StubSummarizer } from "@max-summary/summarizer";
import {
  checkExtractorReadiness,
  defaultExtractorConfig,
  extractDocumentViaHttp,
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
  transitionDocumentJobStatus
} from "@max-summary/storage";

const serviceName = "worker";
const host = process.env.WORKER_HOST ?? "0.0.0.0";
const port = Number(process.env.WORKER_PORT ?? 3003);
const concurrency = Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 2) || 1);

interface WorkerRuntime {
  documents: PostgresDocumentRepository;
  jobs: PostgresJobRepository;
  summaries: PostgresSummaryRepository;
  queue: Queue<DocumentProcessingJobPayload>;
  pool: ReturnType<typeof createPostgresPool>;
  redis: ReturnType<typeof createRedisConnection>;
  workerRedis: ReturnType<typeof createRedisConnection>;
  summarizer: StubSummarizer;
  extractorConfig: ExtractorRuntimeConfig;
}

function buildServer(runtime: WorkerRuntime) {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info"
    }
  });

  app.get("/", async () => {
    return {
      service: serviceName,
      status: "ok",
      queueEngine: Worker.name,
      queueName: "document-processing",
      concurrency
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

  app.get("/queues/document-processing", async () => {
    const counts = await runtime.queue.getJobCounts("wait", "active", "completed", "failed");

    return {
      queueName: "document-processing",
      driver: Worker.name,
      counts
    };
  });

  return app;
}

async function collectDependencyChecks(runtime: WorkerRuntime) {
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

async function checkQueueHealth(runtime: WorkerRuntime) {
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

function createDocumentWorker(runtime: WorkerRuntime, logger: FastifyBaseLogger) {
  return new Worker<DocumentProcessingJobPayload>(
    queueNames.documentProcessing,
    async (bullJob) => {
      await processDocumentJob(bullJob, runtime, logger);
    },
    {
      connection: runtime.workerRedis,
      concurrency
    }
  );
}

async function processDocumentJob(
  bullJob: BullMQJob<DocumentProcessingJobPayload>,
  runtime: WorkerRuntime,
  logger: FastifyBaseLogger
) {
  const persistedJob = await runtime.jobs.findById(bullJob.data.jobId);

  if (!persistedJob) {
    logger.warn(
      {
        bullmqJobId: bullJob.id,
        payload: bullJob.data
      },
      "job missing in postgres; skipping processing"
    );
    return;
  }

  const document = await runtime.documents.findById(persistedJob.documentId);
  const attempt = bullJob.attemptsMade + 1;
  const startedAt = persistedJob.startedAt ?? new Date().toISOString();

  if (!document) {
    const message = `Document ${persistedJob.documentId} not found for job ${persistedJob.id}.`;
    logger.error({ documentId: persistedJob.documentId, jobId: persistedJob.id }, message);
    await runtime.jobs.updateStatus(persistedJob.id, {
      status: "failed",
      attempts: attempt,
      errorMessage: message,
      finishedAt: new Date().toISOString()
    });
    return;
  }

  const existingSummary = await runtime.summaries.findByDocumentId(document.id);

  if (existingSummary) {
    await transitionDocumentJobStatus(runtime.pool, {
      documentId: document.id,
      jobId: persistedJob.id,
      status: "completed",
      attempts: Math.max(persistedJob.attempts, attempt),
      finishedAt: existingSummary.generatedAt,
      clearError: true
    });

    logger.info(
      {
        documentId: document.id,
        jobId: persistedJob.id,
        summaryId: existingSummary.id
      },
      "summary already exists; finalized job idempotently"
    );
    return;
  }

  try {
    await transitionDocumentJobStatus(runtime.pool, {
      documentId: document.id,
      jobId: persistedJob.id,
      status: "validating",
      attempts: attempt,
      startedAt,
      clearError: true
    });

    const validationErrors = validateDocumentForProcessing(document);

    if (validationErrors.length > 0) {
      throw new Error(validationErrors.join(" "));
    }

    await transitionDocumentJobStatus(runtime.pool, {
      documentId: document.id,
      jobId: persistedJob.id,
      status: "extracting",
      attempts: attempt,
      startedAt
    });

    const { request: extractorRequest, extractResult } = await extractDocumentViaHttp(
      document,
      runtime.extractorConfig
    );

    logger.info(
      {
        documentId: document.id,
        jobId: persistedJob.id,
        extractorRequest: {
          documentId: extractorRequest.documentId,
          sourceType: extractorRequest.sourceType,
          sourceUri: extractorRequest.sourceUri,
          fileName: extractorRequest.fileName,
          mimeType: extractorRequest.mimeType,
          inlineTextLength: extractorRequest.inlineText?.length ?? 0,
          language: extractorRequest.language
        }
      },
      "extractor request completed"
    );

    await transitionDocumentJobStatus(runtime.pool, {
      documentId: document.id,
      jobId: persistedJob.id,
      status: "chunking",
      attempts: attempt,
      startedAt
    });

    const chunkCount =
      extractResult.sections.length > 0
        ? extractResult.sections.length
        : extractResult.normalizedText && extractResult.normalizedText.length > 0
          ? 1
          : 0;

    logger.info(
      {
        documentId: document.id,
        jobId: persistedJob.id,
        chunkCount
      },
      "chunking completed"
    );

    await transitionDocumentJobStatus(runtime.pool, {
      documentId: document.id,
      jobId: persistedJob.id,
      status: "summarizing",
      attempts: attempt,
      startedAt
    });

    const summaryResult = await runtime.summarizer.summarize({
      document: {
        ...document,
        status: "summarizing",
        updatedAt: new Date().toISOString()
      },
      job: {
        ...persistedJob,
        status: "summarizing",
        attempts: attempt,
        startedAt,
        updatedAt: new Date().toISOString()
      },
      mode: persistedJob.mode,
      extractResult
    });

    await transitionDocumentJobStatus(runtime.pool, {
      documentId: document.id,
      jobId: persistedJob.id,
      status: "formatting",
      attempts: attempt,
      startedAt
    });

    const savedSummary = await runtime.summaries.upsert(summaryResult);

    await transitionDocumentJobStatus(runtime.pool, {
      documentId: document.id,
      jobId: persistedJob.id,
      status: "completed",
      attempts: attempt,
      startedAt,
      finishedAt: new Date().toISOString(),
      clearError: true
    });

    logger.info(
      {
        documentId: document.id,
        jobId: persistedJob.id,
        summaryId: savedSummary.id
      },
      "job completed"
    );
  } catch (error) {
    const message = toErrorMessage(error);

    await transitionDocumentJobStatus(runtime.pool, {
      documentId: document.id,
      jobId: persistedJob.id,
      status: "failed",
      attempts: attempt,
      errorMessage: message,
      startedAt,
      finishedAt: new Date().toISOString()
    });

    logger.error(
      {
        documentId: document.id,
        jobId: persistedJob.id,
        error
      },
      "job processing failed"
    );

    throw error;
  }
}

function validateDocumentForProcessing(document: {
  sourceType: string;
  sourceUri?: string;
  fileName?: string;
  inlineText?: string;
}): string[] {
  const errors: string[] = [];

  if (document.sourceType === "inline-text" && !document.inlineText) {
    errors.push("Document is missing inlineText for sourceType inline-text.");
  }

  if (document.sourceType === "url" && !document.sourceUri) {
    errors.push("Document is missing sourceUri for sourceType url.");
  }

  if (
    ["pdf", "docx", "txt"].includes(document.sourceType) &&
    !document.sourceUri &&
    !document.fileName &&
    !document.inlineText
  ) {
    errors.push(
      `Document ${document.sourceType} intake must have sourceUri, fileName, or inlineText before extraction.`
    );
  }

  return errors;
}

async function start() {
  const config = defaultStorageConfig();
  const extractorConfig = defaultExtractorConfig();
  const pool = createPostgresPool(config);
  const redis = createRedisConnection(config);
  const workerRedis = createRedisConnection(config);
  const queue = createDocumentQueue<DocumentProcessingJobPayload>(
    redis,
    queueNames.documentProcessing
  );

  await initializeStorage(pool);
  await pool.query("SELECT 1");
  await redis.ping();
  await workerRedis.ping();
  await queue.waitUntilReady();

  const runtime: WorkerRuntime = {
    documents: new PostgresDocumentRepository(pool),
    jobs: new PostgresJobRepository(pool),
    summaries: new PostgresSummaryRepository(pool),
    queue,
    pool,
    redis,
    workerRedis,
    summarizer: new StubSummarizer(),
    extractorConfig
  };
  const app = buildServer(runtime);
  const worker = createDocumentWorker(runtime, app.log);
  await worker.waitUntilReady();

  const shutdown = async (signal: NodeJS.Signals) => {
    app.log.info({ signal }, "shutting down");
    await Promise.allSettled([
      worker.close(),
      app.close(),
      queue.close(),
      closeRedisConnection(workerRedis),
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
