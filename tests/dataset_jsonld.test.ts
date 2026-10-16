import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toDatasetJsonLd } from "../src/build.ts";
import { builtSite } from "./built_site.ts";

interface 自己紹介 {
  "@context"?: string;
  "@type"?: string;
  name?: string;
  description?: string;
  url?: string;
  inLanguage?: string;
  isAccessibleForFree?: boolean;
  dateModified?: string;
  temporalCoverage?: string;
  license?: string;
  creator?: { "@type"?: string; url?: string };
  keywords?: string[];
  distribution?: Array<{ "@type"?: string; encodingFormat?: string; contentUrl?: string }>;
}

/** 配付した `index.html` から自己紹介を取り出す（頁に置いた物をそのまま読む）。 */
function 取り出す(out: string): 自己紹介 {
  const html = readFileSync(join(out, "index.html"), "utf8");
  const matched = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  expect(matched, "index.html に自己紹介（JSON-LD）が無い").toBeTruthy();
  /* 頁の中に置くので `</` を退避してある。読む側は戻してから解く。 */
  return JSON.parse(String(matched?.[1]).replace(/<\\\//g, "</")) as 自己紹介;
}

describe("機械可読の自己紹介（schema.org の Dataset）", () => {
  it("頁の中に、解ける JSON として 1 つだけ入っている", () => {
    const out = builtSite();
    const html = readFileSync(join(out, "index.html"), "utf8");
    const 数 = [...html.matchAll(/<script type="application\/ld\+json">/g)].length;
    expect(数, "自己紹介が 1 つでない").toBe(1);
    /* 早く閉じる印を中に残していない（`</script>` で頁が割れる）。 */
    const 中身 = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
    expect(中身, "中身に生の </ が残っている").not.toContain("</");
    const o = 取り出す(out);
    expect(o["@context"], "schema.org を指していない").toBe("https://schema.org");
    expect(o["@type"], "Dataset でない").toBe("Dataset");
    expect(o.inLanguage, "日本語の頁だと書いていない").toBe("ja");
    expect(o.isAccessibleForFree, "無料で読めると書いていない").toBe(true);
  });

  it("値はビルドが数えた実測（題・説明・生成時刻・収録の期間）", () => {
    const out = builtSite();
    const o = 取り出す(out);
    const html = readFileSync(join(out, "index.html"), "utf8");
    /* 題と説明は雛形の 1 か所から取る（同じ文を二か所に書かない）。 */
    const title = /<title>([\s\S]*?)<\/title>/.exec(html)?.[1]?.trim();
    const description = /<meta name="description" content="([^"]*)"/.exec(html)?.[1]?.trim();
    expect(o.name, "題が頁と違う").toBe(title);
    expect(o.description, "説明が頁と違う").toBe(description);
    const data = JSON.parse(readFileSync(join(out, "data.json"), "utf8")) as {
      generated_at?: string;
    };
    expect(o.dateModified, "生成時刻が data.json と違う").toBe(data.generated_at);
    /* 収録の期間は締切の実測（`2019-05-25/2028-03-30` の形）。定数を書くと次のビルドで
     * 噓になるので、`data.json` を数え直した値と突き合わせる。 */
    const 日々: string[] = [];
    for (const conf of (data as { conferences?: Array<{ editions?: unknown[] }> }).conferences ??
      [])
      for (const ed of (conf.editions ?? []) as Array<{ deadlines?: unknown[] }>)
        for (const dl of (ed.deadlines ?? []) as Array<Record<string, unknown>>) {
          const utc = typeof dl.utc === "string" ? Date.parse(dl.utc) : Number.NaN;
          const 日 = Number.isFinite(utc)
            ? new Date(utc + 9 * 3600000).toISOString().slice(0, 10)
            : String(dl.local_date ?? "").slice(0, 10);
          if (/^\d{4}-\d{2}-\d{2}$/.test(日)) 日々.push(日);
        }
    expect(日々.length, "締切を数えられない（前提が崩れた）").toBeGreaterThan(100);
    expect(o.temporalCoverage, "収録の期間が data.json の実測と違う").toBe(
      `${日々.reduce((a, b) => (a < b ? a : b))}/${日々.reduce((a, b) => (a > b ? a : b))}`,
    );
    expect(o.url, "頁の絶対 URL でない").toMatch(/^https?:\/\/.+\/$/);
    expect(o.license, "ライセンスの行き先が無い").toContain("/blob/main/LICENSE");
    expect(o.creator?.url, "作り手の行き先が無い").toMatch(/^https?:\/\//);
    expect(o.keywords?.length, "語が無い").toBeGreaterThan(2);
  });

  it("配付する 4 本を名指し、そのファイルが実在する", () => {
    const out = builtSite();
    const o = 取り出す(out);
    const 名 = (o.distribution ?? []).map((d) =>
      String(d.contentUrl ?? "")
        .split("/")
        .pop(),
    );
    expect(名.sort(), "配付物の一覧が違う").toEqual([
      "data.csv",
      "data.json",
      "deadlines.ics",
      "llms.txt",
    ]);
    for (const d of o.distribution ?? []) {
      expect(d["@type"], "DataDownload でない").toBe("DataDownload");
      expect(String(d.encodingFormat), "形式が無い").toMatch(/^[a-z]+\/[a-z0-9.+-]+$/);
      const file =
        String(d.contentUrl ?? "")
          .split("/")
          .pop() ?? "";
      expect(existsSync(join(out, file)), `名指したファイルが実在しない: ${file}`).toBe(true);
    }
    /* `embeddings.json` は `--no-embeddings` で消えるので並べない（無い物を名指さない）。 */
    expect(JSON.stringify(o), "消えうる物を並べた").not.toContain("embeddings.json");
  });

  it("題や説明が無い入力でも、壊れた JSON を書かない", () => {
    const 素 = toDatasetJsonLd({});
    expect(素.startsWith('<script type="application/ld+json">'), "器が違う").toBe(true);
    const o = JSON.parse(素.slice(素.indexOf(">") + 1, 素.lastIndexOf("</script>"))) as 自己紹介;
    expect(o["@type"]).toBe("Dataset");
    expect(o.url, "所在地が空").toBe("index.html");
    /* `</script>` を含む説明を渡しても、頁を割らない。 */
    const 危ない = toDatasetJsonLd({ description: "危ない </script> を含む文" });
    const 中身 = 危ない.slice(危ない.indexOf(">") + 1, 危ない.lastIndexOf("</script>"));
    expect(中身, "生の </ を書いた").not.toContain("</");
    expect(JSON.parse(中身.replace(/<\\\//g, "</")).description).toContain("</script>");
  });
});
