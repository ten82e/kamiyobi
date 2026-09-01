import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join } from "node:path";

export const DEFAULT_CAPTURE_LIMITS = {
  maxBodyBytes: 5 * 1024 * 1024,
  timeoutMs: 15_000,
  maxRedirects: 5,
} as const;

export interface PageObservation {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  retrievedAt: string;
  contentType: string;
  contentLength: number;
  headers: {
    etag?: string;
    lastModified?: string;
    retryAfter?: string;
  };
  contentHash: string;
  sourceRevision: string;
  parserVersion: string;
  bodyRef: string;
}

export interface CapturedPage extends PageObservation {
  body?: Uint8Array;
  notModified: boolean;
  retryable: boolean;
}

export interface CapturePageOptions {
  fetchImpl?: typeof fetch;
  bodyRoot?: string;
  previous?: Partial<PageObservation> | null;
  parserVersion?: string;
  maxBodyBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  allowHttpHosts?: string[];
  dnsLookup?: (hostname: string) => Promise<Array<{ address: string }>>;
  now?: Date;
}

export class PageCaptureError extends Error {
  readonly code: "unsafe-url" | "body-too-large" | "timeout" | "network";

  constructor(code: PageCaptureError["code"], message: string) {
    super(message);
    this.name = "PageCaptureError";
    this.code = code;
  }
}

function blockedIpv4(value: string): boolean {
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return true;
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function blockedIpv6(value: string): boolean {
  const lower = value.toLowerCase();
  if (lower === "::" || lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd"))
    return true;
  if (
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb")
  )
    return true;
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return Boolean(mapped && blockedIpv4(mapped[1]));
}

function assertPublicAddress(address: string): void {
  const addressType = isIP(address);
  if ((addressType === 4 && blockedIpv4(address)) || (addressType === 6 && blockedIpv6(address)))
    throw new PageCaptureError("unsafe-url", `private page address: ${address}`);
}

function normalizedHost(url: URL): string {
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

export function assertSafePageUrl(value: string, allowHttpHosts: string[] = []): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PageCaptureError("unsafe-url", `invalid page URL: ${value}`);
  }
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      allowHttpHosts.map((host) => host.toLowerCase()).includes(url.hostname.toLowerCase())
    )
  )
    throw new PageCaptureError("unsafe-url", `unsafe page URL protocol: ${url.protocol}`);
  const host = normalizedHost(url);
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local"))
    throw new PageCaptureError("unsafe-url", `private page hostname: ${host}`);
  assertPublicAddress(host);
  return url;
}

async function assertSafeResolvedPageUrl(
  value: string,
  options: Pick<CapturePageOptions, "allowHttpHosts" | "dnsLookup">,
): Promise<URL> {
  const url = assertSafePageUrl(value, options.allowHttpHosts);
  if (isIP(normalizedHost(url))) return url;
  const resolveDns =
    options.dnsLookup ??
    (async (hostname: string) =>
      (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => ({ address })));
  try {
    for (const { address } of await resolveDns(url.hostname)) assertPublicAddress(address);
  } catch (error) {
    if (error instanceof PageCaptureError) throw error;
    // DNS failures are reported by fetch as a network error; they are not proof
    // that a hostname resolves to a private address.
  }
  return url;
}

function safeHeaders(response: Response): PageObservation["headers"] {
  const headers: PageObservation["headers"] = {};
  const etag = response.headers.get("etag");
  const lastModified = response.headers.get("last-modified");
  const retryAfter = response.headers.get("retry-after");
  if (etag) headers.etag = etag;
  if (lastModified) headers.lastModified = lastModified;
  if (retryAfter) headers.retryAfter = retryAfter;
  return headers;
}

async function bytesOf(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new PageCaptureError("body-too-large", `response body exceeds ${maxBytes} bytes`);
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes)
      throw new PageCaptureError("body-too-large", `response body exceeds ${maxBytes} bytes`);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new PageCaptureError("body-too-large", `response body exceeds ${maxBytes} bytes`);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function conditionalHeaders(previous: Partial<PageObservation> | null | undefined): HeadersInit {
  const headers: Record<string, string> = {};
  if (previous?.headers?.etag) headers["If-None-Match"] = previous.headers.etag;
  if (previous?.headers?.lastModified) headers["If-Modified-Since"] = previous.headers.lastModified;
  return headers;
}

/** Fetch one page, preserve the raw-byte hash, and optionally store it in CAS. */
export async function capturePage(
  requestedUrl: string,
  options: CapturePageOptions = {},
): Promise<CapturedPage> {
  const maxBytes = options.maxBodyBytes ?? DEFAULT_CAPTURE_LIMITS.maxBodyBytes;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CAPTURE_LIMITS.timeoutMs;
  const maxRedirects = options.maxRedirects ?? DEFAULT_CAPTURE_LIMITS.maxRedirects;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new TypeError("capture now must be a valid date");
  let url = await assertSafeResolvedPageUrl(requestedUrl, options);
  let response: Response | null = null;
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      response = await fetchImpl(url, {
        redirect: "manual",
        headers: conditionalHeaders(options.previous),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError")
        throw new PageCaptureError("timeout", `page request timed out after ${timeoutMs} ms`);
      throw new PageCaptureError("network", `page request failed: ${String(error)}`);
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 304 || response.status < 300 || response.status >= 400) break;
    const location = response.headers.get("location");
    if (!location || redirect === maxRedirects)
      throw new PageCaptureError("network", `redirect chain exceeded ${maxRedirects} hops`);
    url = await assertSafeResolvedPageUrl(new URL(location, url).toString(), options);
  }
  if (!response) throw new PageCaptureError("network", "page request returned no response");
  if (response.url) await assertSafeResolvedPageUrl(response.url, options);
  const headers = safeHeaders(response);
  const contentType = response.headers.get("content-type") ?? "";
  const retryable = response.status === 429 || response.status === 503;
  const notModified = response.status === 304;
  let bytes: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let contentHash = options.previous?.contentHash ?? "";
  let bodyRef = options.previous?.bodyRef ?? "";
  if (!notModified && !retryable) {
    bytes = await bytesOf(response, maxBytes);
    contentHash = createHash("sha256").update(bytes).digest("hex");
    if (options.bodyRoot) {
      const target = join(options.bodyRoot, `${contentHash}.body`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
      bodyRef = target;
    }
  }
  const sourceRevision =
    headers.etag ??
    headers.lastModified ??
    (contentHash ? `sha256:${contentHash}` : (options.previous?.sourceRevision ?? ""));
  return {
    requestedUrl,
    finalUrl: response.url || url.toString(),
    status: response.status,
    retrievedAt: now.toISOString(),
    contentType,
    contentLength: bytes.byteLength,
    headers,
    contentHash,
    sourceRevision,
    parserVersion: options.parserVersion ?? "capture/1",
    bodyRef,
    ...(bytes.length > 0 ? { body: bytes } : {}),
    notModified,
    retryable,
  };
}
