export function normalizeShortEquals(
  argv: string[] | null | undefined,
  aliases: Readonly<Record<string, string>>,
): string[] {
  return (Array.isArray(argv) ? argv : []).map((arg) => {
    const match = /^-([A-Za-z])=(.*)$/.exec(arg);
    return match && aliases[match[1]] ? `--${aliases[match[1]]}=${match[2]}` : arg;
  });
}

export function booleanValue(value: unknown, fallback = true): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  return !["false", "0", "no", "off"].includes(String(value).toLowerCase());
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function positiveIntegerValue(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
