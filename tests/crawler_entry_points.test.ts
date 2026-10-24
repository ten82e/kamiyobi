import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { builtSite } from "./built_site.ts";

/** 生成物から正本の絶対 URL を取る（`site.base_url` が正本 – SPEC §4）。 */
function baseUrl(out: string): string {
  const catalog = JSON.parse(readFileSync(join(out, "catalog.json"), "utf8")) as {
    site?: { base_url?: string };
  };
  return String(catalog.site?.base_url ?? "").replace(/\/+$/, "");
}

describe("機械と AI の入口（robots.txt と sitemap.xml）", () => {
  it("robots.txt が全てを許し、site map と AI の索引の絶対 URL を名指す", () => {
    const out = builtSite();
    const base = baseUrl(out);
    expect(base, "site.base_url が空（前提が崩れた）").toMatch(/^https?:\/\//);
    const text = readFileSync(join(out, "robots.txt"), "utf8");
    expect(text, "全てを許していない").toContain("User-agent: *");
    expect(text, "Allow が無い").toContain("Allow: /");
    /* 群は空行で切れる（RFC 9309）。`Sitemap` を群の中に置くと、群の一部として読まれる。 */
    const 群 = text.split(/\n\s*\n/)[0];
    expect(群, "Sitemap を群の中に置いた").not.toContain("Sitemap:");
    expect(text, "site map の絶対 URL が無い").toContain(`Sitemap: ${base}/sitemap.xml`);
    expect(text, "AI の索引の絶対 URL が無い").toContain(`${base}/llms.txt`);
  });

  it("sitemap.xml が人が開ける口だけを並べ、そのファイルが実在する", () => {
    const out = builtSite();
    const base = baseUrl(out);
    const text = readFileSync(join(out, "sitemap.xml"), "utf8");
    expect(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), "XML の宣言が無い").toBe(
      true,
    );
    expect(text, "urlset の名前空間が違う").toContain(
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    );
    const locs = [...text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs.length, "口が 4 つでない").toBe(4);
    for (const loc of locs) {
      expect(loc.startsWith(`${base}/`), `絶対 URL でない: ${loc}`).toBe(true);
      const file = loc.slice(base.length + 1) || "index.html";
      expect(existsSync(join(out, file)), `並べた口が実在しない: ${file}`).toBe(true);
    }
    /* 頁でない物を site map に混ぜない（データのファイルは索引が名指す）。 */
    for (const データ of ["data.json", "data.csv", "catalog.json", "deadlines.ics"])
      expect(text, `頁でない物を並べた: ${データ}`).not.toContain(`/${データ}<`);
    expect(text, "lastmod が無い").toMatch(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
  });

  it("どちらも health.json と publish.json の一覧に入る", () => {
    const out = builtSite();
    const health = JSON.parse(readFileSync(join(out, "health.json"), "utf8")) as {
      output_files?: Record<string, unknown>;
    };
    const publish = JSON.parse(readFileSync(join(out, "publish.json"), "utf8")) as {
      artifacts?: Record<string, { bytes?: number; sha256?: string }>;
    };
    for (const name of ["robots.txt", "sitemap.xml"]) {
      expect(Object.keys(health.output_files ?? {}), `health に ${name} が無い`).toContain(name);
      const artifact = publish.artifacts?.[name];
      expect(artifact, `publish に ${name} が無い`).toBeTruthy();
      expect(artifact?.bytes, `${name} が空`).toBeGreaterThan(0);
      expect(artifact?.sha256, `${name} のハッシュが無い`).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("索引（llms.txt）も同じ二つを説明する", () => {
    const out = builtSite();
    const text = readFileSync(join(out, "llms.txt"), "utf8");
    for (const name of ["robots.txt", "sitemap.xml"])
      expect(text, `索引が ${name} を説明していない`).toContain(`- ${name}：`);
  });
});
