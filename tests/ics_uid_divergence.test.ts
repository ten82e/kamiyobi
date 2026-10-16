import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { icsViewDescriptionJa } from "../site/ics.ts";
import { builtSite } from "./built_site.ts";

describe("書き出しの ICS と購読の ICS の識別子", () => {
  it("同じ締切に別の UID が付く事を、書き出しの説明欄が先に言う", () => {
    /* 2026-10-17 實測: 配付物は `kamiyobi-dl2ws2026-29b52d20@kamiyobi`（種別の日本語名の
     * SHA-1 の 8 桁）、畫面の書き出しは `kamiyobi-dl2ws2026-abstract@kamiyobi`（ASCII の
     * 種別の鍵）。同じ締切が別の物として並ぶので、兩方を同じカレンダーに入れると二度出る。 */
    const 文 = icsViewDescriptionJa(
      [{ day: "20261017", at: 1, deadline: true, body: [] }],
      new Date("2026-08-09T00:00:00Z"),
    );
    expect(文, "書き出しの説明が二重に並ぶ事を言っていない").toContain("二度並びます");
    expect(文, "どちらか一方を使う樣に言っていない").toContain("どちらか一方");
    expect(文, "別の識別子を付ける事を言っていない").toContain("別々の識別子");
  });

  it("購読の側の UID は、種別の語を ASCII に落とした物（變へると購読者の暦が入れ替はる）", () => {
    /* 折り返しを戻してから見る（長い UID は 75 オクテットで折られる）。 */
    const ics = readFileSync(join(builtSite(), "deadlines.ics"), "utf8").replace(/\r\n[ \t]/g, "");
    const uids = [...ics.matchAll(/^UID:([^\r\n]+)$/gm)].map((m) => m[1]);
    expect(uids.length, "VEVENT が読めない（前提が崩れた）").toBeGreaterThan(100);
    /* 種別の語を `icsUidSafe` に掛けた形。ASCII が残ればそれを、殘らなければ SHA-1 の
     * 8 桁を使ふ（日本語だけの語は後者）。同じ版で印が重なる行には `-2` を足す。 */
    const 形 = /^kamiyobi-[A-Za-z0-9._-]+(-[0-9a-f]{8})?(-[0-9]+)?@kamiyobi$/;
    const 外れ = uids.filter((u) => !形.test(u));
    expect(外れ, `UID の形が違う: ${外れ.slice(0, 3).join(" / ")}`).toEqual([]);
    expect(new Set(uids).size, "UID が重なっている").toBe(uids.length);
    /* 種別の語が ASCII の物（上流のラベルを続けた行）は、その語がその儘入る –
     * **上流が言葉を書き換へると UID が變はる**（追ひの課題。ここでは今の形を張る）。 */
    const ascii = uids.filter((u) => /-[A-Za-z][A-Za-z0-9._-]*@kamiyobi$/.test(u));
    expect(ascii.length, "ASCII の種別を持つ UID が消えた（形が変わった）").toBeGreaterThan(0);
  });
});
