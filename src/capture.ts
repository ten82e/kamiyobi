import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";

export const DEFAULT_CAPTURE_LIMITS = {
  maxBodyBytes: 5 * 1024 * 1024,
  timeoutMs: 15_000,
  maxRedirects: 5,
} as const;

const SHA256 = /^[0-9a-f]{64}$/i;

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

export function writeCasBody(bodyRoot: string, contentHash: string, bytes: Uint8Array): string {
  if (!SHA256.test(contentHash)) throw new TypeError("contentHash must be a SHA-256 hex digest");
  const target = join(bodyRoot, `${contentHash}.body`);
  mkdirSync(dirname(target), { recursive: true });
  try {
    writeFileSync(target, bytes, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!lstatSync(target).isFile())
      throw new Error(`content-addressed body must be a regular file: ${target}`);
    const existingHash = createHash("sha256").update(readFileSync(target)).digest("hex");
    if (existingHash !== contentHash.toLowerCase())
      throw new Error(`content-addressed body mismatch: ${target}`);
  }
  return target;
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
  if (mapped) return blockedIpv4(mapped[1]);
  const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!mappedHex) return false;
  const first = Number.parseInt(mappedHex[1], 16);
  const second = Number.parseInt(mappedHex[2], 16);
  return blockedIpv4(`${first >> 8}.${first & 0xff}.${second >> 8}.${second & 0xff}`);
}

function assertPublicAddress(address: string): void {
  const addressType = isIP(address);
  if ((addressType === 4 && blockedIpv4(address)) || (addressType === 6 && blockedIpv6(address)))
    throw new PageCaptureError("unsafe-url", `private page address: ${address}`);
}

function assertResolvedPublicAddress(address: string): void {
  if (isIP(address) === 0)
    throw new PageCaptureError("unsafe-url", `invalid resolved page address: ${address}`);
  assertPublicAddress(address);
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
  requireDns: boolean,
  signal?: AbortSignal,
): Promise<{ url: URL; address?: string }> {
  const url = assertSafePageUrl(value, options.allowHttpHosts);
  const host = normalizedHost(url);
  if (isIP(host)) return { url, address: host };
  if (!requireDns) return { url };
  const resolveDns =
    options.dnsLookup ??
    (async (hostname: string) =>
      (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => ({ address })));
  try {
    const addresses = await raceAbort(
      resolveDns(url.hostname),
      signal,
      "page DNS lookup timed out",
    );
    if (!addresses.length)
      throw new PageCaptureError("unsafe-url", `page hostname did not resolve: ${host}`);
    for (const { address } of addresses) assertResolvedPublicAddress(address);
    return { url, address: addresses[0]!.address };
  } catch (error) {
    if (error instanceof PageCaptureError) throw error;
    throw new PageCaptureError(
      "unsafe-url",
      `page DNS lookup failed for ${host}: ${String(error)}`,
    );
  }
}

function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  message: string,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new PageCaptureError("timeout", message));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(new PageCaptureError("timeout", message));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function cancelBody(response: Response, signal?: AbortSignal): Promise<void> {
  if (!response.body) return;
  await raceAbort(response.body.cancel(), signal, "page response cleanup timed out").catch(
    () => undefined,
  );
}

function fetchPinned(url: URL, address: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  const lookup: LookupFunction = (_hostname, _options, callback) =>
    callback(null, address, isIP(address));
  return new Promise((resolve, reject) => {
    const options = {
      protocol: url.protocol,
      hostname: normalizedHost(url),
      ...(url.port ? { port: url.port } : {}),
      path: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(headers),
      lookup,
      agent: false,
      ...(init.signal ? { signal: init.signal } : {}),
    };
    const onResponse = (incoming: IncomingMessage): void => {
      const responseHeaders = new Headers();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2)
        responseHeaders.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!);
      resolve(
        new Response(Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>, {
          status: incoming.statusCode ?? 0,
          statusText: incoming.statusMessage,
          headers: responseHeaders,
        }),
      );
    };
    const request =
      url.protocol === "https:"
        ? httpsRequest(options, onResponse)
        : httpRequest(options, onResponse);
    request.once("error", reject);
    request.end();
  });
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

async function bytesOf(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
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
      const next = await raceAbort(reader.read(), signal, "page body read timed out");
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        await raceAbort(reader.cancel(), signal, "page body cleanup timed out").catch(
          () => undefined,
        );
        throw new PageCaptureError("body-too-large", `response body exceeds ${maxBytes} bytes`);
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (signal?.aborted) await reader.cancel().catch(() => undefined);
    throw error;
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
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new TypeError("capture now must be a valid date");
  const signal = AbortSignal.timeout(timeoutMs);
  // A supplied fetch is an in-process test seam; the default path pins DNS before connecting.
  let resolved = await assertSafeResolvedPageUrl(
    requestedUrl,
    options,
    !options.fetchImpl || Boolean(options.dnsLookup),
    signal,
  );
  let response: Response | null = null;
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    try {
      response = await raceAbort(
        options.fetchImpl
          ? options.fetchImpl(resolved.url, {
              redirect: "manual",
              headers: conditionalHeaders(options.previous),
              signal,
            })
          : fetchPinned(resolved.url, resolved.address!, {
              redirect: "manual",
              headers: conditionalHeaders(options.previous),
              signal,
            }),
        signal,
        `page request timed out after ${timeoutMs} ms`,
      );
    } catch (error) {
      if (error instanceof PageCaptureError) throw error;
      if (error instanceof Error && error.name === "AbortError")
        throw new PageCaptureError("timeout", `page request timed out after ${timeoutMs} ms`);
      throw new PageCaptureError("network", `page request failed: ${String(error)}`);
    }
    if (response.status === 304 || response.status < 300 || response.status >= 400) break;
    const location = response.headers.get("location");
    if (!location || redirect === maxRedirects) {
      await cancelBody(response, signal);
      throw new PageCaptureError("network", `redirect chain exceeded ${maxRedirects} hops`);
    }
    await cancelBody(response, signal);
    resolved = await assertSafeResolvedPageUrl(
      new URL(location, resolved.url).toString(),
      options,
      !options.fetchImpl || Boolean(options.dnsLookup),
      signal,
    );
  }
  if (!response) throw new PageCaptureError("network", "page request returned no response");
  if (response.url)
    resolved = await assertSafeResolvedPageUrl(
      response.url,
      options,
      !options.fetchImpl || Boolean(options.dnsLookup),
      signal,
    );
  const headers = safeHeaders(response);
  const contentType = response.headers.get("content-type") ?? "";
  const retryable = response.status === 429 || response.status === 503;
  const notModified = response.status === 304;
  let bytes: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let contentHash = options.previous?.contentHash ?? "";
  let bodyRef = options.previous?.bodyRef ?? "";
  if (!notModified && !retryable) {
    bytes = await bytesOf(response, maxBytes, signal);
    contentHash = createHash("sha256").update(bytes).digest("hex");
    if (options.bodyRoot) {
      bodyRef = writeCasBody(options.bodyRoot, contentHash, bytes);
    }
  } else {
    await cancelBody(response, signal);
  }
  const sourceRevision =
    headers.etag ??
    headers.lastModified ??
    (contentHash ? `sha256:${contentHash}` : (options.previous?.sourceRevision ?? ""));
  return {
    requestedUrl,
    finalUrl: response.url || resolved.url.toString(),
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
