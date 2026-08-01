import {
  buildSummaryActionButtons,
  type MaxOutboundMessage,
  type MaxOutboundServiceStatus,
  type MaxSummaryButtonActionId
} from "@max-summary/integrations-max";
import type { SummaryMode, SummarizationResult } from "@max-summary/shared-types";
import type {
  InternalApiDocumentStatusBody,
  InternalApiFailure,
  InternalApiNotFoundBody
} from "./internal-api-client";

interface MessageContext {
  chatId: string;
  correlationId?: string;
  documentId?: string;
}

const processingStageLabels: Record<string, string> = {
  created: "документ создан",
  queued: "документ в очереди",
  validating: "идёт проверка формата",
  extracting: "извлекаю текст",
  chunking: "готовлю фрагменты для summary",
  summarizing: "собираю выжимку",
  formatting: "форматирую ответ",
  sending: "готовлю итоговую выдачу",
  completed: "summary готов",
  failed: "обработка завершилась ошибкой",
  expired: "результат больше недоступен"
};

export function renderOnboardingMessage(context: MessageContext): MaxOutboundMessage[] {
  return [
    {
      type: "message",
      ...baseContext(context),
      text:
        "Привет. Пришли текст, ссылку или файл PDF/DOCX/TXT, и gateway запустит обработку документа. После приёма ты получишь documentId, статус и кнопки для переключения формата summary."
    }
  ];
}

export function renderHelpMessage(context: MessageContext): MaxOutboundMessage[] {
  return [
    {
      type: "message",
      ...baseContext(context),
      text:
        "Поддерживаются plain text, URL и файлы PDF/DOCX/TXT. Команды: /start, /help, /modes, /status <documentId>, /result <documentId>. На этом этапе MAX outbound остаётся structured stub: gateway возвращает, что именно отправил бы обратно в чат."
    }
  ];
}

export function renderModesMessage(context: MessageContext): MaxOutboundMessage[] {
  return [
    {
      type: "message",
      ...baseContext(context),
      text:
        "Режимы summary: brief для быстрой выжимки, detailed для развёрнутого разбора, key-points для тезисов, action-items для следующего шага. После приёма документа gateway сам приложит кнопки переключения режима с documentId внутри callback payload."
    }
  ];
}

export function renderUnsupportedCommandMessage(context: MessageContext, commandName: string): MaxOutboundMessage[] {
  return [
    {
      type: "service-status",
      ...baseContext(context),
      status: "unsupported",
      detailCode: "unsupported-command",
      text: `Команда "/${commandName}" пока не поддерживается. Доступно: /start, /help, /modes, /status <documentId>, /result <documentId>.`
    }
  ];
}

export function renderCommandUsageMessage(
  context: MessageContext,
  commandName: "/status" | "/result",
  usage: string
): MaxOutboundMessage[] {
  return [
    {
      type: "service-status",
      ...baseContext(context),
      status: "error",
      detailCode: "command-usage",
      text: `Нужен documentId. Используй: ${usage}.`
    }
  ];
}

export function renderAcceptedCreateMessage(
  context: MessageContext,
  inputKind: "plain-text" | "url-message" | "file-message"
): MaxOutboundMessage[] {
  if (!context.documentId) {
    return renderGatewayErrorMessage(context, {
      ok: false,
      error: "invalid-response",
      message: "Gateway expected documentId after createDocument, but it was missing."
    });
  }

  return [
    {
      type: "service-status",
      ...baseContext(context),
      status: "accepted",
      detailCode: "document-accepted",
      buttons: buildSummaryActionButtons(context.documentId),
      text:
        `Документ принят в обработку как ${inputKind}. ` +
        `ID: ${context.documentId}. ` +
        `Можно проверять /status ${context.documentId} и /result ${context.documentId}, а кнопки ниже откроют нужный режим, когда summary будет готово.`
    }
  ];
}

export function renderStatusResponse(
  context: MessageContext,
  payload: InternalApiDocumentStatusBody
): MaxOutboundMessage[] {
  const mapped = mapDocumentStatusToOutboundStatus(payload.status);
  const stage = processingStageLabels[payload.status] ?? "обработка идёт";
  const suffix =
    payload.status === "failed"
      ? payload.error
        ? ` Ошибка: ${payload.error}.`
        : " Обработка завершилась ошибкой."
      : payload.status === "completed"
        ? ` Результат можно открыть командой /result ${payload.documentId}.`
        : ` Проверь ещё раз через /result ${payload.documentId}.`;

  return [
    {
      type: "service-status",
      ...baseContext({
        ...context,
        documentId: payload.documentId
      }),
      status: mapped,
      detailCode: `document-status-${payload.status}`,
      ...(payload.documentId ? { buttons: buildSummaryActionButtons(payload.documentId) } : {}),
      text: `Статус документа ${payload.documentId}: ${stage}.${suffix}`
    }
  ];
}

export function renderProcessingMessage(
  context: MessageContext,
  documentId: string,
  statusText?: string
): MaxOutboundMessage[] {
  return [
    {
      type: "service-status",
      ...baseContext({
        ...context,
        documentId
      }),
      status: "processing",
      detailCode: "summary-processing",
      buttons: buildSummaryActionButtons(documentId),
      text:
        `Документ ${documentId} ещё обрабатывается.` +
        (statusText ? ` Текущий этап: ${statusText}.` : "") +
        ` Попробуй /status ${documentId} или /result ${documentId} чуть позже.`
    }
  ];
}

export function renderSummaryMessage(
  context: MessageContext,
  documentId: string,
  summary: SummarizationResult
): MaxOutboundMessage[] {
  const textParts = [
    "Готово. Вот короткая выжимка по документу.",
    summary.shortSummary,
    formatSection("Тезисы", takeOrFallback(summary.keyPoints, "Содержательные тезисы появятся здесь, когда summary будет богаче."))
  ];

  return [
    {
      type: "summary-response",
      ...baseContext({
        ...context,
        documentId
      }),
      mode: "brief",
      buttons: buildSummaryActionButtons(documentId),
      text: joinSections(textParts),
      shortSummary: summary.shortSummary,
      ...(summary.detailedSummary ? { detailedSummary: summary.detailedSummary } : {}),
      ...(summary.keyPoints.length > 0 ? { keyPoints: summary.keyPoints } : {}),
      ...(summary.actionItems.length > 0 ? { actionItems: summary.actionItems } : {})
    }
  ];
}

export function renderModeSpecificSummaryMessage(
  context: MessageContext,
  documentId: string,
  summary: SummarizationResult,
  actionId: MaxSummaryButtonActionId
): MaxOutboundMessage[] {
  const rendered = renderSummaryVariant(summary, actionId);

  return [
    {
      type: "summary-response",
      ...baseContext({
        ...context,
        documentId
      }),
      mode: rendered.mode,
      buttons: buildSummaryActionButtons(documentId),
      text: rendered.text,
      shortSummary: summary.shortSummary,
      ...(summary.detailedSummary ? { detailedSummary: summary.detailedSummary } : {}),
      ...(summary.keyPoints.length > 0 ? { keyPoints: summary.keyPoints } : {}),
      ...(summary.actionItems.length > 0 ? { actionItems: summary.actionItems } : {})
    }
  ];
}

export function renderNotFoundMessage(
  context: MessageContext,
  details: InternalApiNotFoundBody | { documentId?: string; message: string },
  detailCode: string
): MaxOutboundMessage[] {
  return [
    {
      type: "service-status",
      ...baseContext({
        ...context,
        ...(details.documentId ? { documentId: details.documentId } : {})
      }),
      status: "error",
      detailCode,
      text: details.documentId ? `Документ ${details.documentId} не найден. ${details.message}` : details.message
    }
  ];
}

export function renderGatewayErrorMessage(context: MessageContext, failure: InternalApiFailure): MaxOutboundMessage[] {
  const status: MaxOutboundServiceStatus =
    failure.error === "timeout" || failure.error === "network" ? "temporarily-unavailable" : "error";

  return [
    {
      type: "service-status",
      ...baseContext(context),
      status,
      detailCode: `gateway-${failure.error}`,
      text:
        status === "temporarily-unavailable"
          ? "Внутренний API временно недоступен. Gateway сохранил controlled response и не делает реальную отправку в MAX."
          : failure.message
    }
  ];
}

export function renderUnsupportedCallbackMessage(
  context: MessageContext,
  actionId: string,
  reason: string
): MaxOutboundMessage[] {
  return [
    {
      type: "service-status",
      ...baseContext(context),
      status: "unsupported",
      detailCode: "callback-unsupported",
      text: `Callback "${actionId}" не обработан: ${reason}.`
    }
  ];
}

function renderSummaryVariant(
  summary: SummarizationResult,
  actionId: MaxSummaryButtonActionId
): { mode: SummaryMode; text: string } {
  switch (actionId) {
    case "summary:mode:detailed":
      return {
        mode: "detailed",
        text: joinSections([
          "Подробный разбор готов.",
          summary.detailedSummary ?? summary.shortSummary,
          formatSection("Ключевые тезисы", takeOrFallback(summary.keyPoints, "Тезисы появятся здесь, когда summary станет богаче.")),
          formatSection("Риски", takeOrFallback(summary.risks, "Явных рисков не выделено."))
        ])
      };
    case "summary:mode:key-points":
      return {
        mode: "key-points",
        text: joinSections([
          "Главное по документу.",
          formatSection("Тезисы", takeOrFallback(summary.keyPoints, summary.shortSummary))
        ])
      };
    case "summary:mode:action-items":
      return {
        mode: "action-items",
        text: joinSections([
          "Вот что стоит сделать дальше.",
          formatSection("Action items", takeOrFallback(summary.actionItems, "Явных action items не найдено."))
        ])
      };
    case "summary:length:shorter":
      return {
        mode: "brief",
        text: joinSections(["Собрал короткую версию.", summary.shortSummary])
      };
    case "summary:length:longer":
      return {
        mode: "detailed",
        text: joinSections([
          "Развернул summary подробнее.",
          summary.detailedSummary ?? summary.shortSummary,
          formatSection("Что важно", takeOrFallback(summary.keyPoints, "Дополнительные тезисы не выделены.")),
          formatSection("Следующие шаги", takeOrFallback(summary.actionItems, "Следующие шаги не были выделены."))
        ])
      };
  }
}

function mapDocumentStatusToOutboundStatus(status: string): MaxOutboundServiceStatus {
  switch (status) {
    case "created":
    case "queued":
      return "accepted";
    case "completed":
      return "completed";
    case "failed":
    case "expired":
      return "error";
    default:
      return "processing";
  }
}

function baseContext(context: MessageContext) {
  return {
    chatId: context.chatId,
    ...withOptional("correlationId", context.correlationId),
    ...withOptional("documentId", context.documentId)
  };
}

function takeOrFallback(items: string[], fallback: string): string[] {
  return items.length > 0 ? items : [fallback];
}

function formatSection(title: string, content: string[] | string): string {
  if (Array.isArray(content)) {
    return `${title}:\n${content.map((item) => `- ${item}`).join("\n")}`;
  }

  return `${title}:\n${content}`;
}

function joinSections(parts: string[]): string {
  return parts.filter((part) => part.trim().length > 0).join("\n\n");
}

function withOptional<TKey extends string, TValue>(
  key: TKey,
  value: TValue | undefined
): Partial<Record<TKey, TValue>> {
  return value === undefined ? {} : ({ [key]: value } as Partial<Record<TKey, TValue>>);
}
