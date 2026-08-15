export interface ProgressData {
  downloaded: number;
  total: number;
  percent: number | null;
  speed: string;
  eta: string;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const i = Math.min(Math.floor(Math.log2(bytes) / 10), units.length - 1);
  const value = bytes / 2 ** (10 * i);
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[i]}`;
}

export function parseProgressLine(line: string): ProgressData | null {
  if (!line.startsWith("download:")) return null;
  const parts = line.slice("download:".length).split("|");
  const downloaded = Number(parts[0]) || 0;
  const total = Number(parts[1]) || 0;
  const percentRaw = parts[2] ?? "";
  const percent = percentRaw.endsWith("%") ? Number.parseFloat(percentRaw) : NaN;
  return {
    downloaded,
    total,
    percent: Number.isFinite(percent) ? percent : null,
    speed: parts[3] ?? "",
    eta: parts[4] ?? "",
  };
}

export function renderProgressLine(data: ProgressData, barWidth = 32): string {
  const pct = data.percent ?? (data.total > 0 ? (data.downloaded / data.total) * 100 : NaN);
  const filled = Number.isFinite(pct) ? Math.max(0, Math.min(barWidth, Math.round((pct / 100) * barWidth))) : 0;
  const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
  const pctText = Number.isFinite(pct) ? ` ${pct.toFixed(1)}%` : "";
  const of = data.total > 0 ? ` of ${formatBytes(data.total)}` : ` ${formatBytes(data.downloaded)}`;
  const speed = data.speed ? ` at ${data.speed}` : "";
  const eta = data.eta ? ` ETA ${data.eta}` : "";
  return `[${bar}]${pctText}${of}${speed}${eta}`;
}
