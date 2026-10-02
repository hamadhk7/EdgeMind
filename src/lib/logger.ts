type Level = "debug" | "info" | "warn" | "error";
type Fields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  child(fields: Fields): Logger;
}

/**
 * Structured JSON logger. Workers Logs indexes JSON fields, so every line can be
 * filtered by `traceId`, `runId`, `agent`, etc. in the dashboard.
 */
export function createLogger(base: Fields = {}): Logger {
  const write = (level: Level, msg: string, fields?: Fields) => {
    const line = JSON.stringify({ level, msg, ...base, ...fields, ts: new Date().toISOString() });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  };
  return {
    debug: (msg, fields) => write("debug", msg, fields),
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    error: (msg, fields) => write("error", msg, fields),
    child: (fields) => createLogger({ ...base, ...fields }),
  };
}
