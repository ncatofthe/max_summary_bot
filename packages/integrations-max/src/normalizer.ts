import { randomUUID } from "node:crypto";
import type {
  MaxCallbackButtonEvent,
  MaxChatRef,
  MaxFileMetadata,
  MaxFileSourceType,
  MaxInboundEvent,
  MaxMessageRef,
  MaxNormalizationError,
  MaxNormalizationResult,
  MaxNormalizedEnvelope,
  MaxOutboundButton,
  MaxParsedCallbackPayload,
  MaxRawAttachment,
  MaxRawEntity,
  MaxRawUpdateType,
  MaxSummaryButtonActionId,
  MaxSummaryCallbackPayload,
  MaxUserRef
} from "./types";
import {
  maxCallbackPayloadPrefix,
  maxSupportedCommands,
  maxSummaryButtonActionIds
} from "./types";

interface NormalizeOptions {
  receivedAt?: string;
}

interface SummaryButtonDefinition {
  id: MaxSummaryButtonActionId;
  title: string;
}

const summaryButtonDefinitions: SummaryButtonDefinition[] = [
  { id: "summary:mode:detailed", title: "Подробно" },
  { id: "summary:mode:key-points", title: "Тезисы" },
  { id: "summary:mode:action-items", title: "Action items" },
  { id: "summary:length:shorter", title: "Сделать короче" },
  { id: "summary:length:longer", title: "Сделать подробнее" }
];

export function normalizeMaxWebhookPayload(payload: unknown, options: NormalizeOptions = {}): MaxNormalizationResult {
  const receivedAt = options.receivedAt ?? new Date().toISOString();
  const root = asRecord(payload);

  if (!root) {
    return fail("invalid-payload", "MAX webhook payload must be an object.");
  }

  const callback = pickRecord(root, ["callback_query", "callbackQuery"]);

  if (callback) {
    return normalizeCallbackEnvelope(root, callback, receivedAt);
  }

  const message = extractMessageRecord(root);

  if (message) {
    return normalizeMessageEnvelope(root, message, receivedAt);
  }

  return fail("unsupported-update", "MAX webhook payload does not contain a supported message or callback shape.", {
    topLevelKeys: Object.keys(root).join(",")
  });
}

export function buildSummaryActionButtons(documentId: string): MaxOutboundButton[] {
  return summaryButtonDefinitions.map((button) => ({
    id: button.id,
    title: button.title,
    kind: "callback",
    payload: encodeSummaryCallbackPayload({
      kind: "summary",
      actionId: button.id,
      documentId
    })
  }));
}

export function encodeSummaryCallbackPayload(payload: MaxSummaryCallbackPayload): string {
  const params = new URLSearchParams({
    action: payload.actionId,
    documentId: payload.documentId
  });

  return `${maxCallbackPayloadPrefix}${params.toString()}`;
}

export function parseMaxCallbackPayload(data: string): MaxParsedCallbackPayload {
  const trimmed = data.trim();

  if (isMaxSummaryButtonActionId(trimmed)) {
    return {
      kind: "unknown",
      reason: "missing-document-id"
    };
  }

  if (!trimmed.startsWith(maxCallbackPayloadPrefix)) {
    return {
      kind: "unknown",
      reason: "unparseable"
    };
  }

  const params = new URLSearchParams(trimmed.slice(maxCallbackPayloadPrefix.length));
  const actionId = params.get("action")?.trim();
  const documentId = params.get("documentId")?.trim();

  if (!actionId) {
    return {
      kind: "unknown",
      reason: "unparseable"
    };
  }

  if (!isMaxSummaryButtonActionId(actionId)) {
    return {
      kind: "unknown",
      reason: "unsupported-action"
    };
  }

  if (!documentId) {
    return {
      kind: "unknown",
      reason: "missing-document-id"
    };
  }

  return {
    kind: "summary",
    actionId,
    documentId
  };
}

export function isMaxSummaryButtonActionId(value: string): value is MaxSummaryButtonActionId {
  return maxSummaryButtonActionIds.some((candidate) => candidate === value);
}

function normalizeMessageEnvelope(
  root: Record<string, unknown>,
  message: Record<string, unknown>,
  receivedAt: string
): MaxNormalizationResult {
  const chat = normalizeChat(message);

  if (!chat) {
    return fail("missing-chat-context", "MAX message payload must include chat context.");
  }

  const text = readStringFrom(message, ["text", "caption", "body"])?.trim() ?? "";
  const warnings: string[] = [];
  const attachments = normalizeAttachments(message, warnings);

  let event: MaxInboundEvent | null = null;

  if (attachments.length > 0) {
    const file = attachments[0];

    if (!file) {
      return fail("unsupported-message", "MAX file payload could not be normalized.");
    }

    event = {
      type: "file-message",
      file,
      extraAttachmentCount: Math.max(attachments.length - 1, 0),
      ...withOptional("caption", text || undefined)
    };
  } else {
    const commandEvent = parseCommandEvent(text);

    if (commandEvent) {
      event = commandEvent;
    } else {
      const urls = extractUrls(text, readEntities(message));

      if (urls.length > 0 && isUrlOnlyText(text)) {
        const primaryUrl = urls[0];

        if (!primaryUrl) {
          return fail("unsupported-message", "MAX URL payload could not be normalized.");
        }

        event = {
          type: "url-message",
          text,
          url: primaryUrl,
          urls
        };
      } else if (text.length > 0) {
        event = {
          type: "plain-text",
          text,
          urls
        };
      }
    }
  }

  if (!event) {
    return fail(
      "unsupported-message",
      "MAX message payload does not contain a supported command, text, URL, or file metadata."
    );
  }

  return {
    ok: true,
    envelope: buildEnvelope(root, receivedAt, "message", chat, normalizeUser(message), normalizeMessageRef(message), warnings, event)
  };
}

function normalizeCallbackEnvelope(
  root: Record<string, unknown>,
  callback: Record<string, unknown>,
  receivedAt: string
): MaxNormalizationResult {
  const message = pickRecord(callback, ["message"]);
  const chat = (message && normalizeChat(message)) ?? normalizeChat(callback);

  if (!chat) {
    return fail("missing-chat-context", "MAX callback payload must include chat context.");
  }

  const data = readStringFrom(callback, ["data", "callback_data"])?.trim();

  if (!data) {
    return fail("unsupported-message", "MAX callback payload does not include callback data.");
  }

  const parsed = parseMaxCallbackPayload(data);
  const event: MaxCallbackButtonEvent = {
    type: "callback-button",
    actionId: parsed.kind === "summary" ? parsed.actionId : extractCallbackActionId(data),
    data,
    parsed,
    ...withOptional("buttonTitle", readStringFrom(callback, ["button_title", "buttonTitle"]))
  };

  return {
    ok: true,
    envelope: buildEnvelope(
      root,
      receivedAt,
      "callback_query",
      chat,
      normalizeUser(callback),
      message ? normalizeMessageRef(message) : undefined,
      [],
      event
    )
  };
}

function buildEnvelope<TEvent extends MaxInboundEvent>(
  root: Record<string, unknown>,
  receivedAt: string,
  rawUpdateType: MaxRawUpdateType,
  chat: MaxChatRef,
  actor: MaxUserRef | undefined,
  message: MaxMessageRef | undefined,
  warnings: string[],
  event: TEvent
): MaxNormalizedEnvelope<TEvent> {
  return {
    provider: "max",
    envelopeId:
      readStringFrom(root, ["update_id", "event_id"]) ??
      message?.id ??
      actor?.id ??
      randomUUID(),
    receivedAt,
    rawUpdateType,
    updateType: event.type,
    chat,
    warnings,
    event,
    ...withOptional("actor", actor),
    ...withOptional("message", message)
  };
}

function parseCommandEvent(text: string) {
  if (!text.startsWith("/")) {
    return null;
  }

  const match = /^\/([a-z0-9_]+)(?:@\w+)?(?:\s+(.*))?$/iu.exec(text);

  if (!match) {
    return null;
  }

  const commandName = match[1]?.toLowerCase();

  if (!commandName) {
    return null;
  }

  const args = match[2]?.trim() ? match[2].trim().split(/\s+/u) : [];
  const command = maxSupportedCommands.find((candidate) => candidate === commandName) ?? null;

  return {
    type: "command" as const,
    commandName,
    command,
    isSupported: command !== null,
    args,
    text
  };
}

function normalizeChat(value: Record<string, unknown>): MaxChatRef | undefined {
  const chat = pickRecord(value, ["chat", "conversation"]) ?? value;
  const id = readStringFrom(chat, ["id", "chat_id", "conversation_id"]);

  if (!id) {
    return undefined;
  }

  return {
    id,
    ...withOptional("type", readStringFrom(chat, ["type"])),
    ...withOptional("title", readStringFrom(chat, ["title", "name"]))
  };
}

function normalizeUser(value: Record<string, unknown>): MaxUserRef | undefined {
  const user = pickRecord(value, ["from", "sender"]) ?? value;
  const id = readStringFrom(user, ["id", "user_id", "sender_id"]);

  if (!id) {
    return undefined;
  }

  return {
    id,
    ...withOptional("username", readStringFrom(user, ["username"])),
    ...withOptional("displayName", readStringFrom(user, ["display_name", "displayName", "name"])),
    ...withOptional("isBot", readBooleanFrom(user, ["is_bot", "isBot"]))
  };
}

function normalizeMessageRef(value: Record<string, unknown>): MaxMessageRef | undefined {
  const id = readStringFrom(value, ["id", "message_id", "messageId"]);

  if (!id) {
    return undefined;
  }

  return {
    id,
    ...withOptional("sentAt", readStringFrom(value, ["date", "sent_at", "sentAt", "created_at", "createdAt"]))
  };
}

function normalizeAttachments(message: Record<string, unknown>, warnings: string[]): MaxFileMetadata[] {
  const rawAttachments: MaxRawAttachment[] = [];
  const attachments = pickArray(message, ["attachments", "files"]);
  const singleFile = pickRecord(message, ["file"]);

  if (attachments) {
    for (const attachment of attachments) {
      const record = asRecord(attachment);

      if (record) {
        rawAttachments.push(record as MaxRawAttachment);
      }
    }
  }

  if (singleFile) {
    rawAttachments.push(singleFile as MaxRawAttachment);
  }

  return rawAttachments.map((attachment) => normalizeAttachment(attachment, warnings));
}

function normalizeAttachment(attachment: MaxRawAttachment, warnings: string[]): MaxFileMetadata {
  const fileName = attachment.file_name ?? attachment.fileName;
  const mimeType = attachment.mime_type ?? attachment.mimeType;
  const extension = extractFileExtension(fileName);
  const sourceType = detectFileSourceType(mimeType, extension);

  if (!sourceType) {
    warnings.push(`Attachment type is unknown${fileName ? ` for ${fileName}` : ""}; gateway will default to txt for forwarding.`);
  }

  return {
    ...withOptional("id", readIdValue(attachment.id)),
    ...withOptional("kind", attachment.kind),
    ...withOptional("fileName", fileName),
    ...withOptional("mimeType", mimeType),
    ...withOptional("sizeBytes", readNumberValue(attachment.size_bytes ?? attachment.sizeBytes)),
    ...withOptional("sourceUrl", attachment.url ?? attachment.download_url ?? attachment.downloadUrl),
    ...withOptional("extension", extension),
    ...withOptional("sourceType", sourceType)
  };
}

function detectFileSourceType(mimeType?: string, extension?: string): MaxFileSourceType | undefined {
  const normalizedMimeType = mimeType?.toLowerCase();
  const normalizedExtension = extension?.toLowerCase();

  if (normalizedMimeType === "application/pdf" || normalizedExtension === "pdf") {
    return "pdf";
  }

  if (
    normalizedMimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    normalizedExtension === "docx"
  ) {
    return "docx";
  }

  if (normalizedMimeType?.startsWith("text/") || normalizedExtension === "txt") {
    return "txt";
  }

  return undefined;
}

function extractUrls(text: string, entities: MaxRawEntity[]): string[] {
  const urls = new Set<string>();

  for (const entity of entities) {
    const entityType = entity.type?.toLowerCase();

    if (entityType === "text_link" && entity.url) {
      urls.add(entity.url);
      continue;
    }

    if (entityType === "url" && typeof entity.offset === "number" && typeof entity.length === "number") {
      const extracted = text.slice(entity.offset, entity.offset + entity.length).trim();

      if (extracted) {
        urls.add(extracted);
      }
    }
  }

  for (const match of text.matchAll(/https?:\/\/[^\s]+/giu)) {
    if (match[0]) {
      urls.add(match[0]);
    }
  }

  return Array.from(urls);
}

function readEntities(message: Record<string, unknown>): MaxRawEntity[] {
  const entities = pickArray(message, ["entities"]);

  if (!entities) {
    return [];
  }

  return entities.flatMap((entity) => {
    const record = asRecord(entity);

    return record ? [record as MaxRawEntity] : [];
  });
}

function extractCallbackActionId(data: string): string {
  const match = /^[a-z0-9._-]+(?:[:][a-z0-9._-]+)*/iu.exec(data);

  return match?.[0] ?? data;
}

function extractMessageRecord(root: Record<string, unknown>): Record<string, unknown> | undefined {
  const nestedMessage = pickRecord(root, ["message"]);

  if (nestedMessage) {
    return nestedMessage;
  }

  if (pickRecord(root, ["chat", "conversation"])) {
    return root;
  }

  return undefined;
}

function isUrlOnlyText(text: string): boolean {
  return text.replace(/https?:\/\/[^\s]+/giu, "").trim().length === 0;
}

function extractFileExtension(fileName?: string): string | undefined {
  if (!fileName || !fileName.includes(".")) {
    return undefined;
  }

  const parts = fileName.split(".");
  const extension = parts.at(-1)?.trim().toLowerCase();

  return extension || undefined;
}

function fail(
  code: MaxNormalizationError["code"],
  message: string,
  details?: Record<string, string | number | boolean | null>
): MaxNormalizationResult {
  return {
    ok: false,
    error: {
      code,
      message,
      ...withOptional("details", details)
    }
  };
}

function withOptional<TKey extends string, TValue>(
  key: TKey,
  value: TValue | undefined
): Partial<Record<TKey, TValue>> {
  return value === undefined ? {} : ({ [key]: value } as Partial<Record<TKey, TValue>>);
}

function pickRecord(value: Record<string, unknown>, keys: string[]): Record<string, unknown> | undefined {
  for (const key of keys) {
    const nested = asRecord(value[key]);

    if (nested) {
      return nested;
    }
  }

  return undefined;
}

function pickArray(value: Record<string, unknown>, keys: string[]): unknown[] | undefined {
  for (const key of keys) {
    const candidate = value[key];

    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function readStringFrom(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = readStringValue(value[key]);

    if (candidate !== undefined) {
      return candidate;
    }
  }

  return undefined;
}

function readBooleanFrom(value: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const candidate = value[key];

    if (typeof candidate === "boolean") {
      return candidate;
    }
  }

  return undefined;
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

function readNumberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function readIdValue(value: unknown): string | undefined {
  return readStringValue(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}
