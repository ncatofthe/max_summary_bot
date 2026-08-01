import type {
  Document,
  ExtractResult,
  ExtractorRequest,
  Job,
  JobStatus,
  SummarizationRequest,
  SummarizationResult
} from "@max-summary/shared-types";

export interface ServiceRuntimeConfig {
  serviceName: string;
  host: string;
  port: number;
  environment: string;
}

export interface CreateDocumentCommand {
  sourceType: Document["sourceType"];
  sourceUri?: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  inlineText?: string;
  language?: string;
  mode: Job["mode"];
}

export interface DocumentIntakePort {
  createDocument(command: CreateDocumentCommand): Promise<{ document: Document; job: Job }>;
}

export interface ExtractionPort {
  extract(document: Document): Promise<ExtractResult>;
}

export interface SummarizationPort {
  summarize(request: SummarizationRequest): Promise<SummarizationResult>;
}

export interface NotificationPort {
  notifyJobAccepted(job: Job): Promise<void>;
  notifyJobCompleted(result: SummarizationResult): Promise<void>;
}

export const queueNames = {
  documentProcessing: "document-processing"
} as const;

export interface DocumentProcessingJobPayload {
  documentId: string;
  jobId: string;
  queuedAt: string;
}

export interface RuntimeDependencyCheck {
  name: string;
  status: "ok" | "error";
  latencyMs: number;
  details?: string;
}

export interface ExtractorRuntimeConfig {
  baseUrl: string;
  timeoutMs: number;
}

export const documentProcessingStatuses = [
  "queued",
  "validating",
  "extracting",
  "chunking",
  "summarizing",
  "formatting",
  "completed"
] as const satisfies readonly JobStatus[];

export function buildRuntimeConfig(
  serviceName: string,
  defaultPort: number,
  hostEnvVar = "HOST",
  portEnvVar = "PORT"
): ServiceRuntimeConfig {
  return {
    serviceName,
    host: process.env[hostEnvVar] ?? "0.0.0.0",
    port: Number(process.env[portEnvVar] ?? defaultPort),
    environment: process.env.NODE_ENV ?? "development"
  };
}

export function isTerminalJobStatus(status: JobStatus): boolean {
  return status === "completed" || status === "failed" || status === "expired";
}

export function defaultExtractorConfig(): ExtractorRuntimeConfig {
  return {
    baseUrl: process.env.EXTRACTOR_URL ?? "http://localhost:8000",
    timeoutMs: readTimeoutMs(process.env.EXTRACTOR_TIMEOUT_MS, 10000)
  };
}

export function buildExtractorRequest(document: Document): ExtractorRequest {
  return {
    documentId: document.id,
    sourceType: document.sourceType,
    ...(document.sourceUri ? { sourceUri: document.sourceUri } : {}),
    ...(document.fileName ? { fileName: document.fileName } : {}),
    ...(document.mimeType ? { mimeType: document.mimeType } : {}),
    ...(document.inlineText ? { inlineText: document.inlineText } : {}),
    ...(document.language ? { language: document.language } : {})
  };
}

export async function extractDocumentViaHttp(
  document: Document,
  config = defaultExtractorConfig()
): Promise<{ request: ExtractorRequest; extractResult: ExtractResult }> {
  const request = buildExtractorRequest(document);
  const endpoint = buildServiceUrl(config.baseUrl, "/extract");

  let response: Response;
  let responseText = "";

  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(config.timeoutMs)
    });
    responseText = await response.text();
  } catch (error) {
    throw new Error(`Extractor request to ${endpoint} failed: ${toErrorMessage(error)}`);
  }

  const responseBody = parseJsonValue(responseText);

  if (!response.ok) {
    throw new Error(
      `Extractor returned ${response.status} ${response.statusText}: ${describeExtractorFailure(
        responseBody,
        responseText
      )}`
    );
  }

  if (isRecord(responseBody)) {
    const statusValue = readOptionalString(responseBody.status);

    if (statusValue && !["ok", "success"].includes(statusValue)) {
      throw new Error(
        `Extractor returned status "${statusValue}": ${describeExtractorFailure(
          responseBody,
          responseText
        )}`
      );
    }
  }

  const extractResult = normalizeExtractResult(document, responseBody);

  return {
    request,
    extractResult
  };
}

export async function checkExtractorReadiness(
  config = defaultExtractorConfig()
): Promise<RuntimeDependencyCheck> {
  const startedAt = Date.now();
  const endpoints = ["/readyz", "/healthz"];

  for (const path of endpoints) {
    const endpoint = buildServiceUrl(config.baseUrl, path);

    try {
      const response = await fetch(endpoint, {
        headers: {
          accept: "application/json"
        },
        signal: AbortSignal.timeout(config.timeoutMs)
      });
      const bodyText = await response.text();
      const body = parseJsonValue(bodyText);

      if (!response.ok) {
        if (response.status === 404 && path !== endpoints[endpoints.length - 1]) {
          continue;
        }

        return {
          name: "extractor",
          status: "error",
          latencyMs: Date.now() - startedAt,
          details: `${response.status} ${response.statusText}: ${describeExtractorFailure(
            body,
            bodyText
          )}`
        };
      }

      if (isRecord(body)) {
        const statusValue = readOptionalString(body.status);

        if (statusValue && !["ok", "ready"].includes(statusValue)) {
          return {
            name: "extractor",
            status: "error",
            latencyMs: Date.now() - startedAt,
            details: `Unexpected readiness status "${statusValue}"`
          };
        }
      }

      return {
        name: "extractor",
        status: "ok",
        latencyMs: Date.now() - startedAt,
        details: endpoint
      };
    } catch (error) {
      if (path === endpoints[endpoints.length - 1]) {
        return {
          name: "extractor",
          status: "error",
          latencyMs: Date.now() - startedAt,
          details: `Unreachable at ${config.baseUrl}: ${toErrorMessage(error)}`
        };
      }
    }
  }

  return {
    name: "extractor",
    status: "error",
    latencyMs: Date.now() - startedAt,
    details: `No readiness endpoint available at ${config.baseUrl}`
  };
}

export function buildStubExtractResult(document: Document): ExtractResult {
  const rawText = [
    `Stub extraction for document ${document.id}.`,
    `Source type: ${document.sourceType}.`,
    document.fileName ? `File name: ${document.fileName}.` : undefined,
    document.sourceUri ? `Source URI: ${document.sourceUri}.` : undefined,
    "Real extractor integration will replace this placeholder text in a later iteration."
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");

  return {
    documentId: document.id,
    sourceType: document.sourceType,
    rawText,
    normalizedText: rawText,
    sections: [{ heading: "Stub Content", text: rawText }],
    warnings: ["stub-extraction"],
    metadata: {
      stub: true,
      sourceType: document.sourceType
    },
    extractedAt: new Date().toISOString()
  };
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function normalizeExtractResult(document: Document, payload: unknown): ExtractResult {
  const candidate = extractExtractResultCandidate(payload);

  if (!candidate) {
    throw new Error("Extractor response did not contain an extract result.");
  }

  const rawText = readOptionalString(candidate.rawText) ?? readOptionalString(candidate.text);

  if (!rawText) {
    throw new Error("Extractor response did not contain rawText.");
  }

  const normalizedText = readOptionalString(candidate.normalizedText) ?? rawText;
  const sections = normalizeSections(candidate.sections, normalizedText);
  const pageCount = readOptionalNumber(candidate.pageCount);
  const language = readOptionalString(candidate.language) ?? document.language;
  const warnings = normalizeStringArray(candidate.warnings);
  const metadata = normalizeMetadata(candidate.metadata);
  const extractedAt = readOptionalString(candidate.extractedAt) ?? new Date().toISOString();

  return {
    documentId: readOptionalString(candidate.documentId) ?? document.id,
    sourceType: document.sourceType,
    rawText,
    normalizedText,
    sections,
    extractedAt,
    ...(language ? { language } : {}),
    ...(typeof pageCount === "number" ? { pageCount } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(metadata ? { metadata } : {})
  };
}

function extractExtractResultCandidate(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload)) {
    return null;
  }

  if (isRecord(payload.extractResult)) {
    return payload.extractResult;
  }

  if (isRecord(payload.result)) {
    return payload.result;
  }

  if (isRecord(payload.data)) {
    return payload.data;
  }

  return payload;
}

function normalizeSections(
  value: unknown,
  fallbackText: string
): ExtractResult["sections"] {
  if (!Array.isArray(value) || value.length === 0) {
    return [{ heading: "Content", text: fallbackText }];
  }

  const sections = value.flatMap((section, index) => {
    if (!isRecord(section)) {
      return [];
    }

    const text = readOptionalString(section.text);

    if (!text) {
      return [];
    }

    const heading = readOptionalString(section.heading);
    const pageStart = readOptionalNumber(section.pageStart);
    const pageEnd = readOptionalNumber(section.pageEnd);

    return [
      {
        ...(heading ? { heading } : { heading: `Section ${index + 1}` }),
        text,
        ...(typeof pageStart === "number" ? { pageStart } : {}),
        ...(typeof pageEnd === "number" ? { pageEnd } : {})
      }
    ];
  });

  return sections.length > 0 ? sections : [{ heading: "Content", text: fallbackText }];
}

function normalizeMetadata(
  value: unknown
): ExtractResult["metadata"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const metadataEntries = Object.entries(value).flatMap(([key, entryValue]) => {
    if (
      entryValue === null ||
      typeof entryValue === "string" ||
      typeof entryValue === "number" ||
      typeof entryValue === "boolean"
    ) {
      return [[key, entryValue] as const];
    }

    return [];
  });

  return metadataEntries.length > 0 ? Object.fromEntries(metadataEntries) : undefined;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => (typeof entry === "string" && entry.length > 0 ? [entry] : []));
}

function describeExtractorFailure(body: unknown, rawText: string): string {
  if (isRecord(body)) {
    const fragments = [
      readOptionalString(body.message),
      readOptionalString(body.error),
      readOptionalString(body.details)
    ].filter((value): value is string => Boolean(value));

    if (fragments.length > 0) {
      return fragments.join(" | ");
    }
  }

  const trimmed = rawText.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 500) : "empty response body";
}

function parseJsonValue(text: string): unknown {
  if (text.trim().length === 0) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function buildServiceUrl(baseUrl: string, path: string): string {
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readTimeoutMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
