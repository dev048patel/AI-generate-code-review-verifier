/** One JSON object per line on stdout: what log shippers (CloudWatch, Loki, Datadog) ingest without parsing rules. */
export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(base: Record<string, unknown> = {}, write: (line: string) => void = (l) => process.stdout.write(l + "\n")): Logger {
  const log = (level: string) => (msg: string, fields: Record<string, unknown> = {}) =>
    write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...base, ...fields }, errorReplacer));
  return { info: log("info"), warn: log("warn"), error: log("error") };
}

function errorReplacer(_key: string, value: unknown): unknown {
  return value instanceof Error ? { name: value.name, message: value.message.split("\n")[0] } : value;
}

/** Minimal Prometheus-text metrics: counters and summed durations, labelled. */
export class Metrics {
  private counters = new Map<string, number>();

  inc(name: string, labels: Record<string, string> = {}, by = 1): void {
    const key = `${name}${formatLabels(labels)}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  render(): string {
    return [...this.counters.entries()].map(([k, v]) => `${k} ${v}`).join("\n") + "\n";
  }
}

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  return `{${entries.map(([k, v]) => `${k}="${v.replace(/["\\\n]/g, "_")}"`).join(",")}}`;
}
