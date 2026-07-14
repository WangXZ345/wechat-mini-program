const moneyFormatter = new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "CNY",
  minimumFractionDigits: 2
});

export function formatMoney(cents: unknown): string {
  if (typeof cents !== "number" || !Number.isSafeInteger(cents)) return "-";
  return moneyFormatter.format(cents / 100);
}

export function formatDateTime(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

export function createIdempotencyKey(action: string): string {
  return `${action}:${crypto.randomUUID()}`;
}
