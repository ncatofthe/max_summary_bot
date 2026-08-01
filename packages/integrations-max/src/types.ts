import type { DocumentSourceType, SummaryMode } from "@max-summary/shared-types";

export const maxSupportedCommands = ["start", "help", "modes", "status", "result"] as const;
export type MaxSupportedCommand = (typeof maxSupportedCommands)[number];

export type MaxFileSourceType = Extract<DocumentSourceType, "pdf" | "docx" | "txt">;
export type MaxRawUpdateType = "message" | "callback_query";

export const maxSummaryButtonActionIds = [
  "summary:mode:detailed",
  "summary:mode:key-points",
  "summary:mode:action-items",
  "summary:length:shorter",
  "summary:length:longer"
] as const;
export type MaxSummaryButtonActionId = (typeof maxSummaryButtonActionIds)[number];

export const maxCallbackPayloadPrefix = "max-summary?" as const;

export interface MaxUserRef {
  id: string;
  username?: string;
  displayName?: string;
  isBot?: boolean;
}

export interface MaxChatRef {
  id: string;
  type?: string;
  title?: string;
}

export interface MaxMessageRef {
  id: string;
  sentAt?: string;
}

export interface MaxFileMetadata {
  id?: string;
  kind?: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  sourceUrl?: string;
  extension?: string;
  sourceType?: MaxFileSourceType;
}

export interface MaxCommandEvent {
  type: "command";
  commandName: string;
  command: MaxSupportedCommand | null;
  isSupported: boolean;
  args: string[];
  text: string;
}

export interface MaxPlainTextEvent {
  type: "plain-text";
  text: string;
  urls: string[];
}

export interface MaxUrlMessageEvent {
  type: "url-message";
  text: string;
  url: string;
  urls: string[];
}

export interface MaxFileMessageEvent {
  type: "file-message";
  caption?: string;
  file: MaxFileMetadata;
  extraAttachmentCount: number;
}

export interface MaxSummaryCallbackPayload {
  kind: "summary";
  actionId: MaxSummaryButtonActionId;
  documentId: string;
}

export interface MaxUnknownCallbackPayload {
  kind: "unknown";
  reason: "unparseable" | "unsupported-action" | "missing-document-id";
}

export type MaxParsedCallbackPayload = MaxSummaryCallbackPayload | MaxUnknownCallbackPayload;

export interface MaxCallbackButtonEvent {
  type: "callback-button";
  actionId: string;
  data: string;
  buttonTitle?: string;
  parsed: MaxParsedCallbackPayload;
}

export type MaxInboundEvent =
  | MaxCommandEvent
  | MaxPlainTextEvent
  | MaxUrlMessageEvent
  | MaxFileMessageEvent
  | MaxCallbackButtonEvent;

export interface MaxNormalizedEnvelope<TEvent extends MaxInboundEvent = MaxInboundEvent> {
  provider: "max";
  envelopeId: string;
  receivedAt: string;
  rawUpdateType: MaxRawUpdateType;
  updateType: TEvent["type"];
  chat: MaxChatRef;
  actor?: MaxUserRef;
  message?: MaxMessageRef;
  warnings: string[];
  event: TEvent;
}

export interface MaxNormalizationError {
  code: "invalid-payload" | "unsupported-update" | "unsupported-message" | "missing-chat-context";
  message: string;
  details?: Record<string, string | number | boolean | null>;
}

export type MaxNormalizationResult =
  | {
      ok: true;
      envelope: MaxNormalizedEnvelope;
    }
  | {
      ok: false;
      error: MaxNormalizationError;
    };

export interface MaxOutboundButton {
  id: MaxSummaryButtonActionId;
  title: string;
  kind: "callback";
  payload: string;
}

export const maxOutboundServiceStatuses = [
  "accepted",
  "processing",
  "completed",
  "unsupported",
  "temporarily-unavailable",
  "error"
] as const;
export type MaxOutboundServiceStatus = (typeof maxOutboundServiceStatuses)[number];

export interface MaxOutboundBaseMessage {
  chatId: string;
  correlationId?: string;
  documentId?: string;
  buttons?: MaxOutboundButton[];
}

export interface MaxOutboundTextMessage extends MaxOutboundBaseMessage {
  type: "message";
  text: string;
}

export interface MaxOutboundServiceStatusMessage extends MaxOutboundBaseMessage {
  type: "service-status";
  status: MaxOutboundServiceStatus;
  detailCode: string;
  text: string;
}

export interface MaxOutboundSummaryResponseMessage extends MaxOutboundBaseMessage {
  type: "summary-response";
  mode: SummaryMode;
  text: string;
  shortSummary: string;
  detailedSummary?: string;
  keyPoints?: string[];
  actionItems?: string[];
}

export type MaxOutboundMessage =
  | MaxOutboundTextMessage
  | MaxOutboundServiceStatusMessage
  | MaxOutboundSummaryResponseMessage;

export interface MaxSendMessageResult {
  delivered: boolean;
  provider: string;
  reason?: string;
}

export interface MaxRawEntity {
  type?: string;
  offset?: number;
  length?: number;
  url?: string;
}

export interface MaxRawAttachment {
  id?: string | number;
  kind?: string;
  file_name?: string;
  fileName?: string;
  mime_type?: string;
  mimeType?: string;
  size_bytes?: number;
  sizeBytes?: number;
  url?: string;
  download_url?: string;
  downloadUrl?: string;
}

export interface MaxRawUser {
  id?: string | number;
  username?: string;
  display_name?: string;
  displayName?: string;
  is_bot?: boolean;
  isBot?: boolean;
}

export interface MaxRawChat {
  id?: string | number;
  type?: string;
  title?: string;
  name?: string;
}

export interface MaxRawMessage {
  id?: string | number;
  message_id?: string | number;
  text?: string;
  caption?: string;
  date?: string;
  sent_at?: string;
  sentAt?: string;
  chat?: MaxRawChat;
  conversation?: MaxRawChat;
  from?: MaxRawUser;
  sender?: MaxRawUser;
  entities?: MaxRawEntity[];
  attachments?: MaxRawAttachment[];
  files?: MaxRawAttachment[];
  file?: MaxRawAttachment;
}

export interface MaxRawCallbackQuery {
  id?: string | number;
  data?: string;
  callback_data?: string;
  button_title?: string;
  buttonTitle?: string;
  from?: MaxRawUser;
  sender?: MaxRawUser;
  message?: MaxRawMessage;
}

export interface MaxRawWebhookPayload {
  update_id?: string | number;
  event_id?: string | number;
  message?: MaxRawMessage;
  callback_query?: MaxRawCallbackQuery;
  callbackQuery?: MaxRawCallbackQuery;
}
