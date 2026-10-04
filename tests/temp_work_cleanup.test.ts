/* 検査が使う一時目録の片付け（第 482 回）
 *
 * 実測（2026-11-08）で、`$TMPDIR` に検査の使い捨て目録が **139 546 個・約 40 GB** 積まつて居た
 * （`kamiyobi-reverify-*` が 76 271 個など – 一個の検査が一個の目録を作り、誰も消さなかつた）。
 * 其れでディスクは 97 % まで詰まつた。なので検査の入口（`tests/helpers.ts` の `tempWork`）を
 * 片付けるやうにした – ①プロセスが終る時に自分が作った目録を消す ②読む時に、一時間より古い
 * 同じ接頭辞の目録を掃く（vitest のワーカーは殺されることが在って、其の場合①が走らない –
 * 実測で 98 個が残つた為）。此の頁は其の二つを張る。*/
import { mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { tempWork, 古い一時目録を掃く } from "./helpers.ts";

const 作った物: string[] = [];
function 手製(接頭辞: string): string {
  const dir = mkdtempSync(join(tmpdir(), 接頭辞));
  作った物.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of 作った物) rmSync(dir, { recursive: true, force: true });
});

describe("検査の一時目録は片付けられる（第 482 回）", () => {
  it("tempWork が作った目録は使える（中に書ける）", () => {
    const dir = tempWork("kamiyobi-hygiene-test-");
    writeFileSync(join(dir, "証.txt"), "在る");
    expect(readdirSync(dir)).toContain("証.txt");
  });
  it("一時間より古い同じ接頭辞の目録は、次に tempWork を呼んだ時に掃かれる", () => {
    const 古 = 手製("kamiyobi-hygiene-stale-");
    writeFileSync(join(古, "ゴミ.txt"), "古い");
    const 過去の時刻 = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(古, 過去の時刻, 過去の時刻);
    const 新 = 手製("kamiyobi-hygiene-fresh-");
    const 新時刻 = new Date();
    utimesSync(新, 新時刻, 新時刻);
    古い一時目録を掃く(); // 此の頁では直接呼んで張る（実運用では tempWork が呼ぶ）
    const 使 = tempWork("kamiyobi-hygiene-sweep-");
    expect(() => statSync(使)).not.toThrow();
    expect(() => statSync(古)).toThrow(); // 古い物は消えた
    expect(() => statSync(新)).not.toThrow(); // 一時間以内の物は残る（同時に走る検査の守り）
  });
  it("其它の家系の目録名は掃かない（此の検査が触らぬ物の張り）", () => {
    const 他所 = 手製("other-project-hygiene-");
    const 過去 = new Date(Date.now() - 3 * 60 * 60 * 1000);
    utimesSync(他所, 過去, 過去);
    古い一時目録を掃く();
    const 使 = tempWork("kamiyobi-hygiene-keep-");
    expect(() => statSync(使)).not.toThrow();
    expect(() => statSync(他所)).not.toThrow();
  });
  it("tempWork の目録名は自分自身の PID を持つ（第 482 回 – 掃除が生きたプロセスを見分ける為）", () => {
    const 道 = tempWork("kamiyobi-hygiene-pid-");
    expect(道).toContain(`p${process.pid}-`);
    // 其の目録を掃除口が触らぬ事（生きて居る PID は残す）。
    古い一時目録を掃く();
    expect(() => statSync(道)).not.toThrow();
  });
});
