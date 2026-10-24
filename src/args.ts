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
  const 語 = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on", "false", "0", "no", "off"].includes(語)) {
    return !["false", "0", "no", "off"].includes(語);
  }

  process.stderr.write(
    `warning: ${JSON.stringify(String(value))} を真偽値として読み取れません。既定値 ${fallback} を使います。指定できる値: true / false / 1 / 0 / yes / no / on / off。\n`,
  );
  return fallback;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function positiveIntegerValue(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  if (Number.isSafeInteger(value) && value > 0) return value;

  if (raw !== undefined && String(raw).trim() !== "") {
    process.stderr.write(
      `warning: ${JSON.stringify(raw)} は 1 以上の整数（最大 ${Number.MAX_SAFE_INTEGER}）で指定してください。既定値 ${fallback} を使います。\n`,
    );
  }
  return fallback;
}
