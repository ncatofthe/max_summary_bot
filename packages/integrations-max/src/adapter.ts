import { normalizeMaxWebhookPayload } from "./normalizer";
import type {
  MaxNormalizationResult,
  MaxOutboundMessage,
  MaxSendMessageResult
} from "./types";

export interface MaxMessengerAdapter {
  normalize(payload: unknown): MaxNormalizationResult;
  sendMessage(message: MaxOutboundMessage): Promise<MaxSendMessageResult>;
}

export class NoopMaxMessengerAdapter implements MaxMessengerAdapter {
  normalize(payload: unknown): MaxNormalizationResult {
    return normalizeMaxWebhookPayload(payload);
  }

  async sendMessage(_message: MaxOutboundMessage): Promise<MaxSendMessageResult> {
    return {
      delivered: false,
      provider: "noop-max-adapter",
      reason: "MAX outbound delivery is intentionally stubbed at the messenger boundary."
    };
  }
}
