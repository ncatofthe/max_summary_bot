import type {
  DocumentSourceType,
  SummaryMode,
  SummarizationResult
} from "@max-summary/shared-types";

export interface CreateDocumentRequest {
  sourceType: DocumentSourceType;
  sourceUri?: string;
  fileName?: string;
  mode?: SummaryMode;
}

export interface InternalApiDocumentRef {
  id: string;
  sourceType?: string;
  status?: string;
  fileName?: string;
  sourceUri?: string;
}

export interface InternalApiJobRef {
  id: string;
  status?: string;
  mode?: string;
}

export interface InternalApiCreateDocumentBody {
  message: string;
  status?: string;
  document: InternalApiDocumentRef;
  job?: InternalApiJobRef;
}

export interface InternalApiDocumentStatusBody {
  documentId: string;
  jobId?: string;
  status: string;
  error?: string;
  message?: string;
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface InternalApiDocumentSummaryReadyBody {
  documentId: string;
  status?: string;
  summary: SummarizationResult;
}

export interface InternalApiDocumentSummaryPendingBody {
  documentId: string;
  status?: string;
  message: string;
  error?: string;
}

export interface InternalApiNotFoundBody {
  documentId: string;
  message: string;
  status?: string;
  error?: string;
}

interface InternalApiSuccess<TStatus extends number, TBody> {
  ok: true;
  status: TStatus;
  body: TBody;
}

export interface InternalApiFailure {
  ok: false;
  error: "timeout" | "network" | "not-found" | "bad-status" | "invalid-response";
  message: string;
  status?: number;
  body?: unknown;
}

export type InternalApiCreateDocumentResult =
  | InternalApiSuccess<200 | 202, InternalApiCreateDocumentBody>
  | InternalApiFailure;

export type InternalApiDocumentStatusResult =
  | InternalApiSuccess<200 | 202, InternalApiDocumentStatusBody>
  | InternalApiFailure;

export type InternalApiDocumentSummaryResult =
  | InternalApiSuccess<200, InternalApiDocumentSummaryReadyBody>
  | InternalApiSuccess<202, InternalApiDocumentSummaryPendingBody>
  | InternalApiFailure;

export interface InternalApiClientOptions {
  baseUrl: string;
  timeoutMs: number;
}

export interface InternalApiClientLike {
  createDocument(payload: CreateDocumentRequest): Promise<InternalApiCreateDocumentResult>;
  getDocumentStatus(documentId: string): Promise<InternalApiDocumentStatusResult>;
  getDocumentSummary(documentId: string): Promise<InternalApiDocumentSummaryResult>;
}

interface InternalApiResponse {
  status: number;
  body: unknown;
}

type InternalApiRequestResult =
  | {
      ok: true;
      response: InternalApiResponse;
    }
  | InternalApiFailure;

export class InternalApiClient implements InternalApiClientLike {
  constructor(private readonly options: InternalApiClientOptions) {}

  async createDocument(payload: CreateDocumentRequest): Promise<InternalApiCreateDocumentResult> {
    const request = await this.request("/documents", {
      method: "POST",
      body: payload
    });

    if (!request.ok) {
      return request;
    }

    const { status, body } = request.response;

    if (status === 200 || status === 202) {
      const parsed = parseCreateDocumentBody(body);

      return parsed
        ? {
            ok: true,
            status,
            body: parsed
          }
        : invalidResponse("Internal API createDocument response does not match the expected shape.", status, body);
    }

    if (status === 404) {
      return notFound("Internal API createDocument endpoint was not found.", status, body);
    }

    return badStatus(`Internal API createDocument returned ${status}.`, status, body);
  }

  async getDocumentStatus(documentId: string): Promise<InternalApiDocumentStatusResult> {
    const request = await this.request(`/documents/${encodeURIComponent(documentId)}/status`);

    if (!request.ok) {
      return request;
    }

    const { status, body } = request.response;

    if (status === 200 || status === 202) {
      const parsed = parseDocumentStatusBody(body);

      return parsed
        ? {
            ok: true,
            status,
            body: parsed
          }
        : invalidResponse("Internal API status response does not match the expected shape.", status, body);
    }

    if (status === 404) {
      const parsed = parseNotFoundBody(body);

      return {
        ok: false,
        error: "not-found",
        status,
        body,
        message: parsed?.message ?? "Document status was not found in the internal API."
      };
    }

    return badStatus(`Internal API status endpoint returned ${status}.`, status, body);
  }

  async getDocumentSummary(documentId: string): Promise<InternalApiDocumentSummaryResult> {
    const request = await this.request(`/documents/${encodeURIComponent(documentId)}/summary`);

    if (!request.ok) {
      return request;
    }

    const { status, body } = request.response;

    if (status === 200) {
      const parsed = parseDocumentSummaryReadyBody(body);

      return parsed
        ? {
            ok: true,
            status,
            body: parsed
          }
        : invalidResponse("Internal API summary response does not match the expected ready shape.", status, body);
    }

    if (status === 202) {
      const parsed = parseDocumentSummaryPendingBody(body);

      return parsed
        ? {
            ok: true,
            status,
            body: parsed
          }
        : invalidResponse("Internal API summary response does not match the expected processing shape.", status, body);
    }

    if (status === 404) {
      const parsed = parseNotFoundBody(body);

      return {
        ok: false,
        error: "not-found",
        status,
        body,
        message: parsed?.message ?? "Document summary was not found in the internal API."
      };
    }

    return badStatus(`Internal API summary endpoint returned ${status}.`, status, body);
  }

  private async request(pathname: string, init?: { method?: string; body?: unknown }): Promise<InternalApiRequestResult> {
    const url = new URL(pathname.replace(/^\//u, ""), normalizeBaseUrl(this.options.baseUrl));

    try {
      const response = await fetch(url, {
        method: init?.method ?? "GET",
        headers: {
          accept: "application/json",
          ...(init?.body ? { "content-type": "application/json" } : {})
        },
        ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(this.options.timeoutMs)
      });

      const body = await readResponseBody(response);

      return {
        ok: true,
        response: {
          status: response.status,
          body
        }
      };
    } catch (error) {
      if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
        return {
          ok: false,
          error: "timeout",
          message: `Internal API request timed out after ${this.options.timeoutMs}ms.`
        };
      }

      return {
        ok: false,
        error: "network",
        message: error instanceof Error ? error.message : "Unknown network error while calling internal API."
      };
    }
  }
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();

  if (!text) {
    return null;
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";

  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return {
        parseError: true,
        raw: text
      };
    }
  }

  return text;
}

function parseCreateDocumentBody(value: unknown): InternalApiCreateDocumentBody | undefined {
  const body = asRecord(value);
  const document = body ? asRecord(body.document) : undefined;
  const documentId = document ? readStringValue(document.id) : undefined;

  if (!body || !document || !documentId) {
    return undefined;
  }

  const message = readStringValue(body.message) ?? "Document accepted for processing.";
  const job = asRecord(body.job);

  return {
    message,
    document: {
      id: documentId,
      ...withOptional("sourceType", readStringValue(document.sourceType)),
      ...withOptional("status", readStringValue(document.status)),
      ...withOptional("fileName", readStringValue(document.fileName)),
      ...withOptional("sourceUri", readStringValue(document.sourceUri))
    },
    ...withOptional("status", readStringValue(body.status)),
    ...(job && readStringValue(job.id)
      ? {
          job: {
            id: readStringValue(job.id) as string,
            ...withOptional("status", readStringValue(job.status)),
            ...withOptional("mode", readStringValue(job.mode))
          }
        }
      : {})
  };
}

function parseDocumentStatusBody(value: unknown): InternalApiDocumentStatusBody | undefined {
  const body = asRecord(value);
  const documentId = body ? readStringValue(body.documentId) : undefined;
  const status = body ? readStringValue(body.status) : undefined;

  if (!body || !documentId || !status) {
    return undefined;
  }

  return {
    documentId,
    status,
    ...withOptional("jobId", readStringValue(body.jobId)),
    ...withOptional("error", readStringValue(body.error)),
    ...withOptional("message", readStringValue(body.message)),
    ...withOptional("createdAt", readStringValue(body.createdAt)),
    ...withOptional("updatedAt", readStringValue(body.updatedAt)),
    ...withOptional("startedAt", readStringValue(body.startedAt)),
    ...withOptional("finishedAt", readStringValue(body.finishedAt))
  };
}

function parseDocumentSummaryReadyBody(value: unknown): InternalApiDocumentSummaryReadyBody | undefined {
  const body = asRecord(value);
  const documentId = body ? readStringValue(body.documentId) : undefined;
  const summary = body?.summary;

  if (!body || !documentId || !isSummarizationResult(summary)) {
    return undefined;
  }

  return {
    documentId,
    summary,
    ...withOptional("status", readStringValue(body.status))
  };
}

function parseDocumentSummaryPendingBody(value: unknown): InternalApiDocumentSummaryPendingBody | undefined {
  const body = asRecord(value);
  const documentId = body ? readStringValue(body.documentId) : undefined;
  const message = body ? readStringValue(body.message) : undefined;

  if (!body || !documentId || !message) {
    return undefined;
  }

  return {
    documentId,
    message,
    ...withOptional("status", readStringValue(body.status)),
    ...withOptional("error", readStringValue(body.error))
  };
}

function parseNotFoundBody(value: unknown): InternalApiNotFoundBody | undefined {
  const body = asRecord(value);
  const documentId = body ? readStringValue(body.documentId) : undefined;
  const message = body ? readStringValue(body.message) : undefined;

  if (!body || !documentId || !message) {
    return undefined;
  }

  return {
    documentId,
    message,
    ...withOptional("status", readStringValue(body.status)),
    ...withOptional("error", readStringValue(body.error))
  };
}

function isSummarizationResult(value: unknown): value is SummarizationResult {
  const summary = asRecord(value);

  return Boolean(
    summary &&
      readStringValue(summary.documentId) &&
      readStringValue(summary.jobId) &&
      readStringValue(summary.mode) &&
      readStringValue(summary.shortSummary) &&
      Array.isArray(summary.keyPoints) &&
      Array.isArray(summary.actionItems) &&
      Array.isArray(summary.risks) &&
      readStringValue(summary.generatedAt)
  );
}

function invalidResponse(message: string, status: number, body: unknown): InternalApiFailure {
  return {
    ok: false,
    error: "invalid-response",
    message,
    status,
    body
  };
}

function badStatus(message: string, status: number, body: unknown): InternalApiFailure {
  return {
    ok: false,
    error: "bad-status",
    message,
    status,
    body
  };
}

function notFound(message: string, status: number, body: unknown): InternalApiFailure {
  return {
    ok: false,
    error: "not-found",
    message,
    status,
    body
  };
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function readStringValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number") {
    return String(value);
  }

  return undefined;
}

function withOptional<TKey extends string, TValue>(
  key: TKey,
  value: TValue | undefined
): Partial<Record<TKey, TValue>> {
  return value === undefined ? {} : ({ [key]: value } as Partial<Record<TKey, TValue>>);
}
