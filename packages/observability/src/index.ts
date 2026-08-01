export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, metadata?: Record<string, unknown>): void;
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
}

export function createLogger(context: Record<string, unknown> = {}): Logger {
  const write =
    (level: LogLevel) =>
    (message: string, metadata: Record<string, unknown> = {}): void => {
      const payload = {
        level,
        message,
        context,
        metadata,
        timestamp: new Date().toISOString()
      };

      console.log(JSON.stringify(payload));
    };

  return {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error")
  };
}
