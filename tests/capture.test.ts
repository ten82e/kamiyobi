import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertSafePageUrl, capturePage, PageCaptureError, writeCasBody } from "../src/capture.ts";

describe("capture safety and SSRF protections", () => {
  it("blocks private, loopback, and documentation IPv4 addresses", () => {
    // Loopback
    expect(() => assertSafePageUrl("https://127.0.0.1/")).toThrow(PageCaptureError);
    expect(() => assertSafePageUrl("https://127.255.255.254/")).toThrow(PageCaptureError);
    // RFC 1918 Private
    expect(() => assertSafePageUrl("https://10.0.0.1/")).toThrow(PageCaptureError);
    expect(() => assertSafePageUrl("https://172.16.0.1/")).toThrow(PageCaptureError);
    expect(() => assertSafePageUrl("https://172.31.255.255/")).toThrow(PageCaptureError);
    expect(() => assertSafePageUrl("https://192.168.1.1/")).toThrow(PageCaptureError);
    // Link local
    expect(() => assertSafePageUrl("https://169.254.169.254/")).toThrow(PageCaptureError);
    // Shared address space (CGNAT)
    expect(() => assertSafePageUrl("https://100.64.0.1/")).toThrow(PageCaptureError);
    expect(() => assertSafePageUrl("https://100.127.255.254/")).toThrow(PageCaptureError);
    // TEST-NETs and reserved
    expect(() => assertSafePageUrl("https://192.0.2.1/")).toThrow(PageCaptureError);
    expect(() => assertSafePageUrl("https://198.51.100.1/")).toThrow(PageCaptureError);
    expect(() => assertSafePageUrl("https://203.0.113.1/")).toThrow(PageCaptureError);
    expect(() => assertSafePageUrl("https://192.0.0.1/")).toThrow(PageCaptureError);
    // Multicast & Class E
    expect(() => assertSafePageUrl("https://224.0.0.1/")).toThrow(PageCaptureError);
    expect(() => assertSafePageUrl("https://240.0.0.1/")).toThrow(PageCaptureError);
  });

  it("blocks uncompressed, compressed, and mapped IPv6 addresses", () => {
    // Unspecified
    expect(() => assertSafePageUrl("https://[::]/")).toThrow(PageCaptureError);
    expect(() => assertSafePageUrl("https://[0:0:0:0:0:0:0:0]/")).toThrow(PageCaptureError);
    // Loopback
    expect(() => assertSafePageUrl("https://[::1]/")).toThrow(PageCaptureError);
    expect(() => assertSafePageUrl("https://[0:0:0:0:0:0:0:1]/")).toThrow(PageCaptureError);
    expect(() => assertSafePageUrl("https://[0000:0000:0000:0000:0000:0000:0000:0001]/")).toThrow(
      PageCaptureError,
    );
    // ULA
    expect(() => assertSafePageUrl("https://[fc00::1]/")).toThrow(PageCaptureError);
    expect(() => assertSafePageUrl("https://[fd12:3456:789a::1]/")).toThrow(PageCaptureError);
    // Link-local
    expect(() => assertSafePageUrl("https://[fe80::1]/")).toThrow(PageCaptureError);
    // Site-local (deprecated RFC 3879)
    expect(() => assertSafePageUrl("https://[fec0::1]/")).toThrow(PageCaptureError);
    // Multicast
    expect(() => assertSafePageUrl("https://[ff02::1]/")).toThrow(PageCaptureError);
    expect(() => assertSafePageUrl("https://[ff05::2]/")).toThrow(PageCaptureError);
    // IPv4-mapped IPv6 (compressed and uncompressed)
    expect(() => assertSafePageUrl("https://[::ffff:127.0.0.1]/")).toThrow(PageCaptureError);
    expect(() => assertSafePageUrl("https://[0:0:0:0:0:ffff:127.0.0.1]/")).toThrow(
      PageCaptureError,
    );
    expect(() => assertSafePageUrl("https://[0:0:0:0:0:ffff:192.168.1.1]/")).toThrow(
      PageCaptureError,
    );
    expect(() => assertSafePageUrl("https://[::ffff:7f00:1]/")).toThrow(PageCaptureError);
    expect(() => assertSafePageUrl("https://[0:0:0:0:0:ffff:7f00:1]/")).toThrow(PageCaptureError);
    // IPv4-compatible IPv6
    expect(() => assertSafePageUrl("https://[::127.0.0.1]/")).toThrow(PageCaptureError);
    expect(() => assertSafePageUrl("https://[0:0:0:0:0:0:127.0.0.1]/")).toThrow(PageCaptureError);
  });

  it("permits safe public addresses", () => {
    const pub4 = assertSafePageUrl("https://93.184.216.34/path");
    expect(pub4.hostname).toBe("93.184.216.34");

    const pub6 = assertSafePageUrl("https://[2606:4700:4700::1111]/path");
    expect(pub6.hostname).toBe("[2606:4700:4700::1111]");
  });

  it("rejects non-http protocols and local hostnames", () => {
    expect(() => assertSafePageUrl("file:///etc/passwd")).toThrow(/unsafe page URL protocol/);
    expect(() => assertSafePageUrl("ftp://example.com/file")).toThrow(/unsafe page URL protocol/);
    expect(() => assertSafePageUrl("gopher://example.com")).toThrow(/unsafe page URL protocol/);
    expect(() => assertSafePageUrl("https://localhost/")).toThrow(/private page hostname/);
    expect(() => assertSafePageUrl("https://myhost.local/")).toThrow(/private page hostname/);
    expect(() => assertSafePageUrl("https://sub.localhost/")).toThrow(/private page hostname/);
  });
});

describe("capturePage resource cleanup and error mapping", () => {
  it("cancels response body stream when content-length exceeds maxBodyBytes", async () => {
    let bodyCancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        bodyCancelled = true;
      },
    });

    const mockFetch: typeof fetch = async () =>
      new Response(stream, {
        status: 200,
        headers: { "content-length": "100000" },
      });

    await expect(
      capturePage("https://example.com/large", {
        fetchImpl: mockFetch,
        maxBodyBytes: 500,
      }),
    ).rejects.toThrow(/response body exceeds 500 bytes/);

    expect(bodyCancelled).toBe(true);
  });

  it("cancels response body when response.url redirects to unsafe address", async () => {
    let bodyCancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        bodyCancelled = true;
      },
    });

    const mockFetch: typeof fetch = async () => {
      const resp = new Response(stream, { status: 200 });
      Object.defineProperty(resp, "url", { value: "https://127.0.0.1/secret" });
      return resp;
    };

    await expect(
      capturePage("https://example.com/redirect", { fetchImpl: mockFetch }),
    ).rejects.toThrow(/private page address/);

    expect(bodyCancelled).toBe(true);
  });

  it("classifies TimeoutError and aborted signals as timeout errors", async () => {
    const timeoutErr = new Error("The operation timed out");
    timeoutErr.name = "TimeoutError";

    const mockFetch: typeof fetch = async () => {
      throw timeoutErr;
    };

    await expect(
      capturePage("https://example.com/slow", { fetchImpl: mockFetch }),
    ).rejects.toMatchObject({
      code: "timeout",
    });
  });

  it("stores and validates CAS bodies correctly", () => {
    const dir = mkdtempSync(join(tmpdir(), "kamiyobi-cas-test-"));
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const hash = "74f81fe167d99b4cb41d6d0ccda82278caee9f3e2f25d5e5a3936ff3dcec60d0";

    const path = writeCasBody(dir, hash, data);
    expect(readFileSync(path)).toEqual(Buffer.from(data));

    // Writing again with identical content is idempotent
    const path2 = writeCasBody(dir, hash, data);
    expect(path2).toBe(path);

    // Mismatched content throws
    const corruptData = new Uint8Array([9, 9, 9]);
    const corruptFile = join(
      dir,
      "0000000000000000000000000000000000000000000000000000000000000000.body",
    );
    writeFileSync(corruptFile, corruptData);
    expect(() =>
      writeCasBody(
        dir,
        "0000000000000000000000000000000000000000000000000000000000000000",
        new Uint8Array([1]),
      ),
    ).toThrow(/content-addressed body mismatch/);
  });

  it("preserves cached contentLength on 304 Not Modified", async () => {
    const mockFetch: typeof fetch = async () => new Response(null, { status: 304 });
    const res = await capturePage("https://example.com/cached", {
      fetchImpl: mockFetch,
      previous: {
        contentLength: 4242,
        contentHash: "abcdef",
        bodyRef: "test.body",
      },
    });
    expect(res.notModified).toBe(true);
    expect(res.contentLength).toBe(4242);
    expect(res.contentHash).toBe("abcdef");
    expect(res.bodyRef).toBe("test.body");
  });

  it("throws clear network error when redirect response lacks Location header", async () => {
    const mockFetch: typeof fetch = async () => new Response(null, { status: 302 });
    await expect(
      capturePage("https://example.com/bad-redirect", { fetchImpl: mockFetch }),
    ).rejects.toMatchObject({
      code: "network",
      message: expect.stringContaining("missing Location header"),
    });
  });
});
