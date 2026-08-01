import Fastify from "fastify";
import {
  normalizeMaxWebhookPayload,
  type MaxCallbackButtonEvent,
  type MaxCommandEvent,
  type MaxFileMetadata,
  type MaxInboundEvent,
  type MaxNormalizationError,
  type MaxNormalizedEnvelope,
  type MaxOutboundMessage,
  type MaxSummaryButtonActionId
} from "@max-summary/integrations-max";
import type { DocumentSourceType, JobStatus } from "@max-summary/shared-types";
import {
  InternalApiClient,
  type CreateDocumentRequest,
  type InternalApiClientLike,
  type InternalApiCreateDocumentResult,
  type InternalApiDocumentStatusResult,
  type InternalApiDocumentSummaryResult
} from "./internal-api-client";
import {
  renderAcceptedCreateMessage,
  renderCommandUsageMessage,
  renderGatewayErrorMessage,
  renderHelpMessage,
  renderModesMessage,
  renderModeSpecificSummaryMessage,
  renderNotFoundMessage,
  renderOnboardingMessage,
  renderProcessingMessage,
  renderStatusResponse,
  renderSummaryMessage,
  renderUnsupportedCallbackMessage,
  renderUnsupportedCommandMessage
} from "./renderers";

const serviceName = "bot-gateway";
const host = process.env.BOT_GATEWAY_HOST ?? "0.0.0.0";
const port = Number(process.env.BOT_GATEWAY_PORT ?? 3001);
const internalApiBaseUrl = process.env.INTERNAL_API_BASE_URL ?? process.env.API_BASE_URL ?? "http://127.0.0.1:3002";
const internalApiTimeoutMs = Number(process.env.BOT_GATEWAY_API_TIMEOUT_MS ?? 4000);
const gatewayStatus: JobStatus = "queued";

type GatewayRoutingDecision =
  | {
      route: "command.start" | "command.help" | "command.modes" | "command.unsupported";
      action: "render-local";
      outcome: "rendered";
    }
  | {
      route: "command.status";
      action: "render-local" | "fetch-status";
      outcome: "rendered" | "status-found" | "not-found" | "api-error";
      documentId?: string | undefined;
      fetch?: {
        endpoint: "GET /documents/:id/status";
        result: InternalApiDocumentStatusResult;
      };
    }
  | {
      route: "command.result";
      action: "render-local" | "fetch-summary";
      outcome: "rendered" | "summary-ready" | "summary-processing" | "not-found" | "api-error";
      documentId?: string | undefined;
      fetch?: {
        endpoint: "GET /documents/:id/summary";
        result: InternalApiDocumentSummaryResult;
      };
    }
  | {
      route: "documents.create";
      action: "forward-to-api";
      outcome: "forwarded" | "api-error";
      intakeKind: "plain-text" | "url-message" | "file-message";
      documentId?: string | undefined;
      forward: {
        endpoint: "POST /documents";
        request: CreateDocumentRequest;
        result: InternalApiCreateDocumentResult;
      };
      notes?: string[] | undefined;
    }
  | {
      route: "callback.summary";
      action: "fetch-summary";
      outcome: "summary-ready" | "summary-processing" | "not-found" | "api-error";
      documentId: string;
      actionId: MaxSummaryButtonActionId;
      fetch: {
        endpoint: "GET /documents/:id/summary";
        result: InternalApiDocumentSummaryResult;
      };
    }
  | {
      route: "callback.unsupported";
      action: "render-local";
      outcome: "rendered";
      actionId: string;
      reason: string;
    };

interface GatewayAcceptedWebhookResponse {
  accepted: true;
  service: string;
  normalized: MaxNormalizedEnvelope;
  decision: GatewayRoutingDecision;
  outbound: MaxOutboundMessage[];
}

interface GatewayRejectedWebhookResponse {
  accepted: false;
  service: string;
  error: MaxNormalizationError;
}

interface BuildServerOptions {
  apiClient?: InternalApiClientLike;
}

interface GatewayRouteResult {
  decision: GatewayRoutingDecision;
  outbound: MaxOutboundMessage[];
}

export function buildServer(options: BuildServerOptions = {}) {
  const apiClient =
    options.apiClient ??
    new InternalApiClient({
      baseUrl: internalApiBaseUrl,
      timeoutMs: internalApiTimeoutMs
    });

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info"
    }
  });

  app.get("/", async () => {
    return {
      service: serviceName,
      status: "demo-ready",
      adapter: "MAX messenger boundary",
      currentStubStatus: gatewayStatus,
      supportedUpdateTypes: [
        "command",
        "plain-text",
        "url-message",
        "file-message",
        "callback-button"
      ],
      supportedCommands: ["/start", "/help", "/modes", "/status <documentId>", "/result <documentId>"],
      supportedCallbacks: [
        "summary:mode:detailed",
        "summary:mode:key-points",
        "summary:mode:action-items",
        "summary:length:shorter",
        "summary:length:longer"
      ],
      internalApiBaseUrl
    };
  });

  app.get("/healthz", async () => {
    return {
      status: "ok",
      service: serviceName,
      timestamp: new Date().toISOString()
    };
  });

  app.get("/readyz", async (_request, reply) => {
    reply.code(200);

    return {
      status: "ready",
      service: serviceName,
      checks: [
        { name: "http", status: "ok" },
        { name: "max-normalizer", status: "ok" },
        { name: "max-outbound", status: "structured-stub" },
        { name: "internal-api-target", status: "configured", target: internalApiBaseUrl }
      ]
    };
  });

  app.post<{ Body: unknown; Reply: GatewayAcceptedWebhookResponse | GatewayRejectedWebhookResponse }>(
    "/max/webhook",
    async (request, reply) => {
      const normalized = normalizeMaxWebhookPayload(request.body);

      if (!normalized.ok) {
        reply.code(422);

        return {
          accepted: false,
          service: serviceName,
          error: normalized.error
        };
      }

      const routed = await routeNormalizedEnvelope(normalized.envelope, apiClient);

      app.log.info(
        {
          route: routed.decision.route,
          action: routed.decision.action,
          outcome: routed.decision.outcome,
          updateType: normalized.envelope.updateType,
          rawUpdateType: normalized.envelope.rawUpdateType,
          chatId: normalized.envelope.chat.id,
          actorId: normalized.envelope.actor?.id,
          messageId: normalized.envelope.message?.id,
          warnings: normalized.envelope.warnings,
          event: buildEventLogSummary(normalized.envelope.event),
          outboundTypes: routed.outbound.map((message) => message.type)
        },
        "processed MAX webhook"
      );

      reply.code(202);

      return {
        accepted: true,
        service: serviceName,
        normalized: normalized.envelope,
        decision: routed.decision,
        outbound: routed.outbound
      };
    }
  );

  return app;
}

async function routeNormalizedEnvelope(
  envelope: MaxNormalizedEnvelope,
  apiClient: InternalApiClientLike
): Promise<GatewayRouteResult> {
  switch (envelope.event.type) {
    case "command":
      return routeCommandEvent(envelope as MaxNormalizedEnvelope<MaxCommandEvent>, envelope.event, apiClient);
    case "plain-text":
      return forwardDocumentIntake(envelope, apiClient, "plain-text", {
        sourceType: "inline-text",
        sourceUri: buildInlineTextSourceUri(envelope),
        mode: "brief",
        ...(envelope.message?.id ? { fileName: `max-message-${envelope.message.id}.txt` } : {})
      });
    case "url-message":
      return forwardDocumentIntake(envelope, apiClient, "url-message", {
        sourceType: "url",
        sourceUri: envelope.event.url,
        mode: "brief"
      });
    case "file-message":
      return forwardDocumentIntake(
        envelope,
        apiClient,
        "file-message",
        buildFileDocumentRequest(envelope as MaxNormalizedEnvelope<Extract<MaxInboundEvent, { type: "file-message" }>>)
      );
    case "callback-button":
      return routeCallbackEvent(envelope as MaxNormalizedEnvelope<MaxCallbackButtonEvent>, envelope.event, apiClient);
  }

  return assertNever(envelope.event);
}

async function routeCommandEvent(
  envelope: MaxNormalizedEnvelope<MaxCommandEvent>,
  event: MaxCommandEvent,
  apiClient: InternalApiClientLike
): Promise<GatewayRouteResult> {
  if (!event.isSupported || !event.command) {
    return {
      decision: {
        route: "command.unsupported",
        action: "render-local",
        outcome: "rendered"
      },
      outbound: renderUnsupportedCommandMessage(messageContext(envelope), event.commandName)
    };
  }

  switch (event.command) {
    case "start":
      return {
        decision: {
          route: "command.start",
          action: "render-local",
          outcome: "rendered"
        },
        outbound: renderOnboardingMessage(messageContext(envelope))
      };
    case "help":
      return {
        decision: {
          route: "command.help",
          action: "render-local",
          outcome: "rendered"
        },
        outbound: renderHelpMessage(messageContext(envelope))
      };
    case "modes":
      return {
        decision: {
          route: "command.modes",
          action: "render-local",
          outcome: "rendered"
        },
        outbound: renderModesMessage(messageContext(envelope))
      };
    case "status":
      return routeStatusCommand(envelope, event, apiClient);
    case "result":
      return routeResultCommand(envelope, event, apiClient);
  }

  return assertNever(event.command);
}

async function routeStatusCommand(
  envelope: MaxNormalizedEnvelope<MaxCommandEvent>,
  event: MaxCommandEvent,
  apiClient: InternalApiClientLike
): Promise<GatewayRouteResult> {
  const documentId = extractDocumentIdArg(event);

  if (!documentId) {
    return {
      decision: {
        route: "command.status",
        action: "render-local",
        outcome: "rendered"
      },
      outbound: renderCommandUsageMessage(messageContext(envelope), "/status", "/status <documentId>")
    };
  }

  const result = await apiClient.getDocumentStatus(documentId);

  if (result.ok) {
    return {
      decision: {
        route: "command.status",
        action: "fetch-status",
        outcome: "status-found",
        documentId,
        fetch: {
          endpoint: "GET /documents/:id/status",
          result
        }
      },
      outbound: renderStatusResponse(messageContext(envelope, documentId), result.body)
    };
  }

  if (result.error === "not-found") {
    return {
      decision: {
        route: "command.status",
        action: "fetch-status",
        outcome: "not-found",
        documentId,
        fetch: {
          endpoint: "GET /documents/:id/status",
          result
        }
      },
      outbound: renderNotFoundMessage(
        messageContext(envelope, documentId),
        { documentId, message: result.message },
        "document-status-not-found"
      )
    };
  }

  return {
    decision: {
      route: "command.status",
      action: "fetch-status",
      outcome: "api-error",
      documentId,
      fetch: {
        endpoint: "GET /documents/:id/status",
        result
      }
    },
    outbound: renderGatewayErrorMessage(messageContext(envelope, documentId), result)
  };
}

async function routeResultCommand(
  envelope: MaxNormalizedEnvelope<MaxCommandEvent>,
  event: MaxCommandEvent,
  apiClient: InternalApiClientLike
): Promise<GatewayRouteResult> {
  const documentId = extractDocumentIdArg(event);

  if (!documentId) {
    return {
      decision: {
        route: "command.result",
        action: "render-local",
        outcome: "rendered"
      },
      outbound: renderCommandUsageMessage(messageContext(envelope), "/result", "/result <documentId>")
    };
  }

  const result = await apiClient.getDocumentSummary(documentId);

  if (result.ok && result.status === 200) {
    return {
      decision: {
        route: "command.result",
        action: "fetch-summary",
        outcome: "summary-ready",
        documentId,
        fetch: {
          endpoint: "GET /documents/:id/summary",
          result
        }
      },
      outbound: renderSummaryMessage(messageContext(envelope, documentId), documentId, result.body.summary)
    };
  }

  if (result.ok && result.status === 202) {
    return {
      decision: {
        route: "command.result",
        action: "fetch-summary",
        outcome: "summary-processing",
        documentId,
        fetch: {
          endpoint: "GET /documents/:id/summary",
          result
        }
      },
      outbound: renderProcessingMessage(
        messageContext(envelope, documentId),
        documentId,
        result.body.status
      )
    };
  }

  if (!result.ok && result.error === "not-found") {
    return {
      decision: {
        route: "command.result",
        action: "fetch-summary",
        outcome: "not-found",
        documentId,
        fetch: {
          endpoint: "GET /documents/:id/summary",
          result
        }
      },
      outbound: renderNotFoundMessage(
        messageContext(envelope, documentId),
        { documentId, message: result.message },
        "document-summary-not-found"
      )
    };
  }

  return {
    decision: {
      route: "command.result",
      action: "fetch-summary",
      outcome: "api-error",
      documentId,
      fetch: {
        endpoint: "GET /documents/:id/summary",
        result
      }
    },
    outbound: renderGatewayErrorMessage(messageContext(envelope, documentId), result)
  };
}

async function routeCallbackEvent(
  envelope: MaxNormalizedEnvelope<MaxCallbackButtonEvent>,
  event: MaxCallbackButtonEvent,
  apiClient: InternalApiClientLike
): Promise<GatewayRouteResult> {
  if (event.parsed.kind !== "summary") {
    return {
      decision: {
        route: "callback.unsupported",
        action: "render-local",
        outcome: "rendered",
        actionId: event.actionId,
        reason: event.parsed.reason
      },
      outbound: renderUnsupportedCallbackMessage(
        messageContext(envelope),
        event.actionId,
        mapUnsupportedCallbackReason(event.parsed.reason)
      )
    };
  }

  const result = await apiClient.getDocumentSummary(event.parsed.documentId);

  if (result.ok && result.status === 200) {
    return {
      decision: {
        route: "callback.summary",
        action: "fetch-summary",
        outcome: "summary-ready",
        documentId: event.parsed.documentId,
        actionId: event.parsed.actionId,
        fetch: {
          endpoint: "GET /documents/:id/summary",
          result
        }
      },
      outbound: renderModeSpecificSummaryMessage(
        messageContext(envelope, event.parsed.documentId),
        event.parsed.documentId,
        result.body.summary,
        event.parsed.actionId
      )
    };
  }

  if (result.ok && result.status === 202) {
    return {
      decision: {
        route: "callback.summary",
        action: "fetch-summary",
        outcome: "summary-processing",
        documentId: event.parsed.documentId,
        actionId: event.parsed.actionId,
        fetch: {
          endpoint: "GET /documents/:id/summary",
          result
        }
      },
      outbound: renderProcessingMessage(
        messageContext(envelope, event.parsed.documentId),
        event.parsed.documentId,
        result.body.status
      )
    };
  }

  if (!result.ok && result.error === "not-found") {
    return {
      decision: {
        route: "callback.summary",
        action: "fetch-summary",
        outcome: "not-found",
        documentId: event.parsed.documentId,
        actionId: event.parsed.actionId,
        fetch: {
          endpoint: "GET /documents/:id/summary",
          result
        }
      },
      outbound: renderNotFoundMessage(
        messageContext(envelope, event.parsed.documentId),
        { documentId: event.parsed.documentId, message: result.message },
        "callback-summary-not-found"
      )
    };
  }

  return {
    decision: {
      route: "callback.summary",
      action: "fetch-summary",
      outcome: "api-error",
      documentId: event.parsed.documentId,
      actionId: event.parsed.actionId,
      fetch: {
        endpoint: "GET /documents/:id/summary",
        result
      }
    },
    outbound: renderGatewayErrorMessage(messageContext(envelope, event.parsed.documentId), result)
  };
}

async function forwardDocumentIntake(
  envelope: MaxNormalizedEnvelope,
  apiClient: InternalApiClientLike,
  intakeKind: "plain-text" | "url-message" | "file-message",
  request: CreateDocumentRequest & { notes?: string[] }
): Promise<GatewayRouteResult> {
  const { notes, ...forwardRequest } = request;
  const result = await apiClient.createDocument(forwardRequest);

  if (result.ok) {
    const documentId = result.body.document.id;

    return {
      decision: {
        route: "documents.create",
        action: "forward-to-api",
        outcome: "forwarded",
        intakeKind,
        documentId,
        forward: {
          endpoint: "POST /documents",
          request: forwardRequest,
          result
        },
        ...(notes ? { notes } : {})
      },
      outbound: renderAcceptedCreateMessage(messageContext(envelope, documentId), intakeKind)
    };
  }

  return {
    decision: {
      route: "documents.create",
      action: "forward-to-api",
      outcome: "api-error",
      intakeKind,
      forward: {
        endpoint: "POST /documents",
        request: forwardRequest,
        result
      },
      ...(notes ? { notes } : {})
    },
    outbound: renderGatewayErrorMessage(messageContext(envelope), result)
  };
}

function buildFileDocumentRequest(
  envelope: MaxNormalizedEnvelope<Extract<MaxInboundEvent, { type: "file-message" }>>
): CreateDocumentRequest & { notes?: string[] } {
  const notes = [...envelope.warnings];
  const sourceType = resolveFileSourceType(envelope.event.file, notes);

  return {
    sourceType,
    sourceUri:
      envelope.event.file.sourceUrl ??
      `max-file://chat/${encodeURIComponent(envelope.chat.id)}/message/${encodeURIComponent(
        envelope.message?.id ?? envelope.envelopeId
      )}/attachment/${encodeURIComponent(envelope.event.file.id ?? "primary")}`,
    mode: "brief",
    ...(envelope.event.file.fileName ? { fileName: envelope.event.file.fileName } : {}),
    ...(notes.length > 0 ? { notes } : {})
  };
}

function resolveFileSourceType(file: MaxFileMetadata, notes: string[]): DocumentSourceType {
  if (file.sourceType) {
    return file.sourceType;
  }

  notes.push("Unknown attachment type was forwarded as txt because the current /documents contract only accepts shared DocumentSourceType.");

  return "txt";
}

function buildInlineTextSourceUri(envelope: MaxNormalizedEnvelope): string {
  return `max-message://chat/${encodeURIComponent(envelope.chat.id)}/message/${encodeURIComponent(
    envelope.message?.id ?? envelope.envelopeId
  )}`;
}

function extractDocumentIdArg(event: MaxCommandEvent): string | undefined {
  const [firstArg] = event.args;
  const normalized = firstArg?.trim();

  return normalized && normalized.length > 0 ? normalized : undefined;
}

function mapUnsupportedCallbackReason(reason: "missing-document-id" | "unsupported-action" | "unparseable"): string {
  switch (reason) {
    case "missing-document-id":
      return "в payload отсутствует documentId";
    case "unsupported-action":
      return "action не входит в поддержанный demo set";
    case "unparseable":
      return "payload не совпал с форматом max-summary?action=...&documentId=...";
  }
}

function messageContext(envelope: MaxNormalizedEnvelope, documentId?: string) {
  return {
    chatId: envelope.chat.id,
    ...(envelope.envelopeId ? { correlationId: envelope.envelopeId } : {}),
    ...(documentId ? { documentId } : {})
  };
}

function buildEventLogSummary(event: MaxInboundEvent): Record<string, string | number | boolean | null> {
  switch (event.type) {
    case "command":
      return {
        type: event.type,
        commandName: event.commandName,
        isSupported: event.isSupported,
        argsCount: event.args.length
      };
    case "plain-text":
      return {
        type: event.type,
        textLength: event.text.length,
        urlCount: event.urls.length
      };
    case "url-message":
      return {
        type: event.type,
        url: event.url,
        urlCount: event.urls.length
      };
    case "file-message":
      return {
        type: event.type,
        fileName: event.file.fileName ?? null,
        mimeType: event.file.mimeType ?? null,
        extraAttachmentCount: event.extraAttachmentCount
      };
    case "callback-button":
      return {
        type: event.type,
        actionId: event.actionId,
        callbackKind: event.parsed.kind,
        documentId: event.parsed.kind === "summary" ? event.parsed.documentId : null
      };
  }

  return assertNever(event);
}

export async function start() {
  const app = buildServer();

  const shutdown = async (signal: NodeJS.Signals) => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await app.listen({ host, port });
  app.log.info({ host, port }, "service started");
}

if (require.main === module) {
  void start();
}

function assertNever(value: never): never {
  throw new Error(`Unhandled value: ${JSON.stringify(value)}`);
}
