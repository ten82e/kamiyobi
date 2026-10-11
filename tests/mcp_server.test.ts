/**
 * kamiyobi の MCP サーバ（第 714 回）。
 *
 * 確かめる事 – ①MCP の手順（initialize / tools/list / tools/call）が正しく話せる
 * ②**數字と案内文が畫面と同じ**（同じ検索核と、同じ收錄の窓を使つて居る）
 * ③0 件の時に、人が見るのと同じ案内文を返す。
 *
 * 窓は `scope: "all"`（`data/snapshot.json`）で確かめる – 畫面の窓（`public/catalog.json`）は
 * 建てた時だけ在る物なので、檢査が其れに依ると、配付物を持たない手元で落ちる。
 */

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { recommendationAxes } from "../site/recommendation-core.ts";
import Recommender from "../site/recommender.ts";
import { FILTER_RUNTIME_STUBS, site } from "./built_golden_shared.ts";
import { REPO_ROOT } from "./helpers.ts";
import { jsFunction, siteRuntime, vmSafeSource } from "./runtime_extract.ts";

/** MCP の客户の眞似をして、行ごとの JSON-RPC をやり取りする。 */
function mcpClient() {
  const child = spawn(process.execPath, [join(REPO_ROOT, "src", "mcp.ts")], {
    cwd: REPO_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let buffer = "";
  let stderr = "";
  const waiters: Array<(msg: Record<string, unknown>) => void> = [];
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let at = buffer.indexOf("\n");
    while (at >= 0) {
      const raw = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (raw) {
        const msg = JSON.parse(raw) as Record<string, unknown>;
        const next = waiters.shift();
        if (next) next(msg);
      }
      at = buffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const send = (message: Record<string, unknown>): void => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const ask = (message: Record<string, unknown>): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      waiters.push(resolve);
      send(message);
    });
  return { child, ask, send, stderr: () => stderr };
}

const client = mcpClient();
afterAll(() => {
  client.child.kill();
});

/** 道具を呼んで、返つた文字を取る。 */
async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const res = (await client.ask({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name, arguments: args },
  })) as { result?: { content?: Array<{ text?: string }> } };
  return String(res.result?.content?.[0]?.text ?? "");
}

describe("MCP の手順が話せる（第 714 回）", () => {
  it("initialize に名乘りと道具の能力を返す", async () => {
    const res = (await client.ask({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", clientInfo: { name: "test", version: "0" } },
    })) as {
      result?: {
        protocolVersion?: string;
        capabilities?: { tools?: unknown };
        serverInfo?: { name?: string; version?: string };
      };
    };
    expect(res.result?.protocolVersion, "版を返して居ない").toBe("2025-06-18");
    expect(res.result?.serverInfo?.name, "名乘りが違ふ").toBe("kamiyobi");
    expect(res.result?.capabilities?.tools, "道具の能力を名乘つて居ない").toBeTruthy();
    /* 支度の通知（返事を書かない物）を送つても、其れらしい返事が來ない事。 */
    client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const pong = (await client.ask({ jsonrpc: "2.0", id: 99, method: "ping" })) as {
      result?: unknown;
    };
    expect(pong.result, "ping に返事が無い").toEqual({});
  });

  it("道具の一覽が讀める（六つ・どれも入力の形を持つ）", async () => {
    const res = (await client.ask({ jsonrpc: "2.0", id: 3, method: "tools/list" })) as {
      result?: { tools?: Array<{ name?: string; description?: string; inputSchema?: unknown }> };
    };
    const tools = res.result?.tools ?? [];
    expect(tools.map((t) => t.name).sort()).toEqual([
      "collection_stats",
      "explain_word",
      "list_upcoming",
      "recommend_venues",
      "search_deadlines",
      "venue_info",
    ]);
    for (const tool of tools) {
      expect(String(tool.description ?? "").length, `説明が空: ${tool.name}`).toBeGreaterThan(20);
      expect(tool.inputSchema, `入力の形が無い: ${tool.name}`).toBeTruthy();
    }
  });

  it("知らない道具の失敗文は、讀める形で返す（第 890 回）", async () => {
    /* 實測 2026-10-22: 知らない道具を呼ぶと「道具の実行に失敗: Error: 知らない道具: nope」と
     * 出て居た。`String(error)` は `Error:` を先頭に付けるので、AI でも人でも讀める文に剝ぐ
     * （併せて `isError` は立つたまま – 呼んだ側が失敗と判る）。 */
    const res = (await client.ask({
      jsonrpc: "2.0",
      id: 90,
      method: "tools/call",
      params: { name: "nope" },
    })) as { result?: { content?: Array<{ text?: string }>; isError?: boolean } };
    const 文 = String(res.result?.content?.[0]?.text ?? "");
    expect(res.result?.isError, "失敗と判る印が立って居ん").toBe(true);
    expect(文, "內部の錯誤の接頭語が殘つて居る").not.toContain("Error:");
    expect(文, "道具の實行に失敗した事を言つて居ん").toContain("道具の実行に失敗");
    /* どこの道具だか分かる（打ち直しが出來る）。 */
    expect(文, "知らない道具の名を言つて居ん").toContain("nope");
    /* 引數が缺けた呼び出しでも、文で落ちる（例外を露出しない）。 */
    const 缺け = (await client.ask({
      jsonrpc: "2.0",
      id: 91,
      method: "tools/call",
      params: { name: "search_deadlines" },
    })) as { result?: { content?: Array<{ text?: string }>; isError?: boolean } };
    const 缺け文 = String(缺け.result?.content?.[0]?.text ?? "");
    expect(缺け.result?.isError, "引數の缺けを失敗として居ん").toBeFalsy();
    expect(缺け文).not.toContain("Error:");
    expect(缺け文, "何を足せばよいか言つて居ん").toContain("検索語が空です");
  });

  it("知らない呼び出しには誤りを返す（默らない）", async () => {
    const res = (await client.ask({ jsonrpc: "2.0", id: 4, method: "not/a/method" })) as {
      error?: { code?: number };
    };
    expect(res.error?.code, "知らない呼び出しに誤りを返して居ない").toBe(-32601);
  });
});

describe("AI 向けの索引が、MCP の在り處を書いて居る（第 714 回）", () => {
  it("llms.txt の組み立てに、MCP の節と道具の名が在る", () => {
    /* `llms.txt` はビルドの生成物なので、組み立ての側を檢べる（配付物を持たない手元でも
     * 檢べられる – 第 714 回）。*/
    const build = readFileSync(join(REPO_ROOT, "src", "build.ts"), "utf8");
    expect(build, "llms.txt に AI 向けの節が無い").toContain("## AI から引く（MCP）");
    for (const 名 of [
      "search_deadlines",
      "list_upcoming",
      "venue_info",
      "explain_word",
      "collection_stats",
      "recommend_venues",
    ]) {
      expect(build, `道具の名が書かれて居ない: ${名}`).toContain(名);
    }
    /* 索引の説明が、實装とずれて居ない事（第 731 回 – 第 726〜728 回に足した物）。
     * 人が讀む索引なので、實装に無い事を書いて居たら迷はす。*/
    for (const 印 of ['["all"]', "kind", "kinds", "略称", "scope"]) {
      expect(build, `索引に ${印} の話が無い（實装とずれて居る）`).toContain(印);
    }
    /* CSV の説明が「日本語は書かない」と言い切っていたのを直した（第 732 回 – 実測: 七列
     * （title・full_name・label・place・date_text・date_field・event_segments）に上流の原文の
     * 日本語が入る）。**サイトが付ける印は書かない**という意味だと書き直す。 */
    expect(build, "CSV の説明が日本語の混在を言っていない").toContain(
      "上流の原文に日本語が在れば其の侭出す",
    );
    expect(build, "印を書かない事を言っていない").not.toContain(
      "「未確認」「該当なし」などの日本語は書かない",
    );
    /* 置けない物を「在る」と書いて居ない事（靜的サイトにサーバは置けない）。 */
    expect(build, "置き場所の斷りが無い").toContain("読み取り専用");
  });
});

describe("數字と案内が畫面と同じ（第 714 回）", () => {
  /* 同じ検索核・同じ收錄から、此方で数えて突き合はせる（數字を檢査に寫さない）。 */
  const rows = Recommender.candidateRows(
    JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as never,
  ) as unknown as Array<{
    hay: string;
    t: number;
    est: boolean;
    kind: string;
    conf: { title: string };
  }>;

  function 畫面の既定で數へる(語: string, now: number): number {
    const 照合 = Recommender.searchMatcher(Recommender.expandRelativeMonths(語, now), now);
    return rows.filter(
      (r) =>
        照合(r.hay) === true &&
        !Recommender.deadlineRowIsPast(r, now) &&
        !r.est &&
        ["abstract", "paper", "journal"].includes(r.kind),
    ).length;
  }

  it("search_deadlines の件數が、同じ絞り込みで數へた物と一致する", async () => {
    const now = Date.now();
    for (const 語 of ["セキュリティ", "機械学習", "海外開催"]) {
      const text = await call("search_deadlines", { query: 語, scope: "all", limit: 1 });
      const 出た = Number(/に当たる締切: (\d+) 件/.exec(text)?.[1] ?? -1);
      expect(出た, `件數が讀めない: ${語}`).toBeGreaterThanOrEqual(0);
      expect(出た, `畫面の數へ方と違ふ: ${語}`).toBe(畫面の既定で數へる(語, now));
    }
  });

  it("0 件の時は、人が見るのと同じ案内文を返す", async () => {
    const 語 = "ビザが必要な会議";
    const text = await call("explain_word", { word: 語, scope: "all" });
    const 人の案内 = String(Recommender.uiWordNoteJa(語, false) ?? "").trim();
    expect(人の案内, "此の檢査の前提（案内の在る語）が崩れた").not.toBe("");
    expect(text, "人が見る案内と同じ物を返して居ない").toContain(人の案内);
    expect(text, "0 行である事を言つて居ない").toContain("0 行");
  });

  it("行が出る語には、案内を付けずに行を返す", async () => {
    /* 語は此方で数えてから使ふ（0 件に成る語を選ぶと、檢査が空振りする）。 */
    const 語 = "機械学習";
    const 正 = 畫面の既定で數へる(語, Date.now());
    expect(正, `此の檢査の前提（既定の絞り込みで行が出る語）が崩れた: ${語}`).toBeGreaterThan(0);
    const text = await call("search_deadlines", { query: 語, scope: "all", limit: 2 });
    expect(text, "行を返して居ない").toContain(`に当たる締切: ${正} 件`);
    expect(text, "行が出て居るのに案内を付けた").not.toContain("案内:");
    /* 日付・種別・会議名が讀める形で返る（人が見る列と同じ順）。 */
    expect(text, "行の形が違ふ").toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("会議の版と締切を、名前の一部から引ける", async () => {
    const 一つ = rows.find((r) => r.conf.title.includes("AsiaCCS"));
    expect(一つ, "此の檢査の前提（AsiaCCS が收錄に在る）が崩れた").toBeTruthy();
    const text = await call("venue_info", { name: "AsiaCCS", scope: "all" });
    expect(text, "会議の名を返して居ない").toContain("会議:");
    expect(text, "版を返して居ない").toContain("版:");
    expect(text, "締切の行を返して居ない").toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("会議は略稱でも引ける（key で一意に指せる）", async () => {
    /* 實測 2026-10-06: 略稱（`KDD` `CCS`）では見付からなかつた – 題は長く、略稱は別の欄に在る。*/
    const text = await call("venue_info", { key: "sigkdd", scope: "all" });
    expect(text, "key で引け無い").toContain("会議:");
    expect(text, "分野を日本語で出して居ん（畫面と同じ語）").toMatch(
      /分野: (人工知能|データベース)/,
    );
    expect(text, "機械向けのキーの侭").not.toMatch(/分野: (ai|db|hpc)$/m);
  });

  it("種別は all で全部、知らないキーは其の旨を言ふ（第 727 回）", async () => {
    /* 實測 2026-10-06: `kinds: ["all"]` を彈いて居たので、**全ての種別を見る道が無く**、
     * 「kinds を試してください」と言はれても試す物が無かつた。未知のキーは 0 件に成るので、
     * 默らず「知らない種別」と名指す（AI が打ち直せる樣に）。*/
    const 全部 = await call("search_deadlines", {
      query: "セキュリティ",
      kinds: ["all"],
      scope: "all",
      limit: 1,
    });
    const 既定 = await call("search_deadlines", { query: "セキュリティ", scope: "all", limit: 1 });
    const 數 = (t: string): number => Number(/に当たる締切: (\d+) 件/.exec(t)?.[1] ?? -1);
    expect(數(全部), "all で絞られて居る").toBeGreaterThan(數(既定));
    const 未知 = await call("search_deadlines", {
      query: "セキュリティ",
      kinds: ["xxx"],
      scope: "all",
      limit: 1,
    });
    expect(未知, "知らない種別を名指して居ん").toContain("知らない種別");
    /* 既定では屆かん種別も、名指せば屆く（camera_ready は既定の三つに入らん）。 */
    const カメラ = await call("search_deadlines", {
      query: "カメラレディ",
      kinds: ["camera_ready"],
      scope: "all",
      limit: 1,
    });
    expect(カメラ, "名指した種別に屆いて居ん").toMatch(/に当たる締切: [1-9]\d* 件/);
  });

  it("種別の名は道具の間で揃って居る（kind でも kinds でも受ける・第 728 回）", async () => {
    /* 實測 2026-10-06: `list_upcoming` は `kind`（單數）、`search_deadlines` は `kinds`（複數）で、
     * 同じ事を指して居た。片方を覺えた機械が 0 件で默るのを防ぐ。*/
    const 數 = (t: string): number => Number(/締切: (\d+) 件/.exec(t)?.[1] ?? -1);
    const 單 = await call("list_upcoming", { days: 60, kind: "paper", scope: "all" });
    const 複 = await call("list_upcoming", { days: 60, kinds: ["paper"], scope: "all" });
    expect(數(單), "kind で絞れて居ん").toBeGreaterThan(0);
    expect(數(複), "kinds で絞れて居ん").toBe(數(單));
    const 全部 = await call("list_upcoming", { days: 60, kind: "all", scope: "all" });
    expect(數(全部), "all で廣がつて居ん").toBeGreaterThan(數(單));
    /* search_deadlines も單數の名を受ける。 */
    const 檢 = await call("search_deadlines", {
      query: "カメラレディ",
      kind: "camera_ready",
      scope: "all",
      limit: 1,
    });
    expect(檢, "search_deadlines が kind を受けて居ん").toMatch(/に当たる締切: [1-9]\d* 件/);
  });

  it("曖昧な名では決め打たず、候補を並べる", async () => {
    /* `KDD` は kdd・sigkdd・pakdd・ecmlpkdd に当たる。決め打つと別の会議の版を混ぜて返す。*/
    const text = await call("venue_info", { name: "KDD", scope: "all" });
    expect(text, "候補を並べて居ん").toContain("会議が当たりました");
    expect(text, "key を添へて居ん").toContain("（key: ");
    /* 候補には公式の繋ぎ先も添へる（第 750 回 – 名前と key だけでは、どれが探して居る物か
     * 決められん。人は URL を見て選ぶ）。 */
    expect(text, "候補に繋ぎ先が無い").toMatch(/https?:\/\//);
  });

  it("收錄に無い会議は、無いと言ふ（在る樣に裝はない）", async () => {
    const text = await call("venue_info", { name: "ぬけぬけ会議", scope: "all" });
    expect(text, "無いと言つて居ない").toContain("収録に在りません");
  });
});

it("会議の一覽は、今後の物から並ぶ（第 752 回）", async () => {
  /* 實測 2026-10-06: `venue sigkdd` の一覽が 2021 年から始まつて居た（日の早い順に並べて居た）。
   * 人は「次はいつか」を聞いて居るので、過去を先に讀ませない。今後の行を持つ会議で、
   * **最初の日付の行が過去で無い**事を見る（此の会議には今後が在る – 前提も張る）。 */
  const text = await call("venue_info", { key: "sigkdd", scope: "all" });
  const 日付の行 = text.split("\n").filter((l) => /^\d{4}-\d{2}-\d{2}/.test(l));
  expect(日付の行.length, "此の檢査の前提（日付の行が在る）が崩れた").toBeGreaterThan(1);
  const 今後 = 日付の行.filter((l) => !l.includes("（過ぎた）"));
  expect(今後.length, "此の檢査の前提（今後の締切が在る）が崩れた").toBeGreaterThan(0);
  expect(日付の行[0], "過去の行を先に並べて居る").not.toContain("（過ぎた）");
});

it("今後の締切が無い会議では、其の事を先に言ふ（第 754 回）", async () => {
  /* 過ぎた行だけを並べると、讀む人（と AI）が「次はこれ」と取り違へる。 */
  const 過去だけ = await call("venue_info", { key: "aft", scope: "all" });
  expect(過去だけ, "今後の締切が無い事を言つて居ん").toContain("今後の締切は収録にありません");
  expect(過去だけ, "過ぎた物だと斷つて居ん").toContain("（過ぎた）");
  /* 今後が在る会議には付けない（雜音を増やさない）。 */
  const 今後あり = await call("venue_info", { key: "sigkdd", scope: "all" });
  expect(今後あり, "要らない斷りを付けた").not.toContain("今後の締切は収録にありません");
});

it("0 件の時に、畫面と同じ「打ち直すなら」を渡す（第 762 回）", async () => {
  /* 實測 2026-10-06: 畫面は 0 件の時に次の一手を出すのに、MCP は案内文だけで止まつて居た。
   * 第 756 回に一度載せたが、**件數と結果が食ひ違つた**（「デモが」を 7 件と數へるのに、
   * 其の語で引くと 0 件）ので讓つた。今は**照合そのもので數へる**ので一致する。 */
  const text = await call("search_deadlines", {
    query: "デモができる会議",
    scope: "all",
    limit: 1,
  });
  expect(text, "行き止まりへ送る提案を出した").not.toContain("打ち直すなら");

  const 有益 = await call("search_deadlines", { query: "参加費が高い", scope: "all", limit: 1 });
  expect(有益, "打ち直す手を渡して居ん").toContain("打ち直すなら");
  const word = /検索語を「([^」]+)」/.exec(有益)?.[1] ?? "";
  const 件數 = Number(/（(?:両方を書く行が )?([\d,]+) 件/.exec(有益)?.[1]?.replace(/,/g, "") ?? -1);
  expect(word, "提案の語が讀めない").not.toBe("");
  expect(件數, "提案の件數が讀めない").toBeGreaterThan(0);
  /* **提案の件數と、其の語で引いた結果が一致する。** */
  const 次 = await call("search_deadlines", { query: word, scope: "all", limit: 1 });
  const 出た = Number(/に当たる締切: ([\d,]+) 件/.exec(次)?.[1]?.replace(/,/g, "") ?? -1);
  expect(出た, `提案の件數と結果が違ふ: ${word}`).toBe(件數);
});

it("explain_word でも、同じ「打ち直すなら」を渡す（第 763 回）", async () => {
  /* 語を調べる人が「では何と打てばよいか」まで一往復で分かるように、search_deadlines と同じ
   * 扱いに揃える。件數は照合そのもので數へるので、其の語で引いた結果と一致する（第 762 回）。 */
  const text = await call("explain_word", { word: "参加費が高い", scope: "all" });
  expect(text, "0 行である事を言つて居ん").toContain("0 行");
  expect(text, "打ち直す手を渡して居ん").toContain("打ち直すなら");
  const word = /検索語を「([^」]+)」/.exec(text)?.[1] ?? "";
  expect(word, "提案の語が讀めない").not.toBe("");
  const 次 = await call("search_deadlines", { query: word, scope: "all", limit: 1 });
  expect(次, `提案が空振り: ${word}`).toMatch(/に当たる締切: [1-9]\d* 件/);
  /* 行が出る語には付けない。 */
  const 有 = await call("explain_word", { word: "ポスター", scope: "all" });
  expect(有, "行が出る語に提案を付けた").not.toContain("打ち直すなら");
});

it("会議の一覽の見出しが、並びと切り詰めを言ふ（第 765 回）", async () => {
  /* 第 751 回に「今後の物が先」へ變へたので、見出しの「日本時間の早い順」だけでは過去が先に
   * 來る意味に讀めた。切り詰め（60 件）も默らない – 言はないと「これで全部」と讀まれる。 */
  const text = await call("venue_info", { key: "sigkdd", scope: "all" });
  expect(text, "並びの説明が古い").toContain("今後の物から");
  /* 切り詰めた時だけ件數を添へる（此の会議は 60 件に滿たないので付かない）。 */
  const 行數 = text.split("\n").filter((l) => /^\d{4}-\d{2}-\d{2}/.test(l)).length;
  if (行數 >= 60) expect(text, "切り詰めを默つて居る").toContain("のうち 60 件");
  else expect(text, "切り詰めて居ないのに件數を添へた").not.toContain("のうち 60 件");
});

it("道具の說明が、實装の要る所を言つて居る（第 766 回）", async () => {
  /* AI は此の說明だけを見て道具を選ぶ。此の數回に足した舉動が說明から落ちると、使はれなくなる。 */
  const res = (await client.ask({ jsonrpc: "2.0", id: 5, method: "tools/list" })) as {
    result?: { tools?: Array<{ name?: string; description?: string }> };
  };
  const 說明 = new Map(
    (res.result?.tools ?? []).map((t) => [String(t.name), String(t.description)]),
  );
  const 要る: Array<[string, string]> = [
    ["search_deadlines", "打ち直すなら"],
    ["list_upcoming", "種別では絞らない"],
    ["venue_info", "今後の物から"],
    ["venue_info", "略称"],
    ["explain_word", "打ち直すなら"],
  ];
  for (const [道具, 語] of 要る) {
    expect(說明.get(道具) ?? "", `${道具} の說明に「${語}」が無い`).toContain(語);
  }
});

it("索引（llms.txt の組み立て）が、道具の説明と同じ事を言っている（第 768 回）", () => {
  /* 索引は人が読む物でもあるので、実装が増えたのに索引が古いと「できる事」が伝わらない
   * （第 731・767 回に実際にずれた）。組み立ての側を読んで、要る語が入っているかを見る。 */
  const build = readFileSync(join(REPO_ROOT, "src", "build.ts"), "utf8");
  for (const 語 of ["次の一手まで返す", "切り詰めは黙らない", "今後の物から"]) {
    expect(build, `索引に「${語}」の話が無い（道具の説明とずれている）`).toContain(語);
  }
});

it("collection_stats が、收錄その物の數と檔案を返す（第 769 回）", async () => {
  /* AI が「この收錄は何か」「人に渡すなら何を渡せばよいか」に一往復で答へられるようにした。
   * 數字は出典（`data/snapshot.json`）を名乘り、人が讀む檔案を並べる。 */
  const text = await call("collection_stats", {});
  expect(text, "会議の數を返して居ん").toMatch(/会議 \d+ 件/);
  expect(text, "締切の行を返して居ん").toMatch(/締切の行 [\d,]+ 行/);
  expect(text, "出典を名乘つて居ん").toContain("data/snapshot.json");
  for (const 檔案 of ["upcoming.md", "data.csv", "deadlines.ics", "data.json", "llms.txt"]) {
    expect(text, `${檔案} を並べて居ん`).toContain(檔案);
  }
  /* 会議の數は、收錄その物（snapshot）の会議數と一致する（行から數へると減る – 第 769 回に
   * 一度それを踏んだ）。 */
  const 收錄 = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as {
    conferences?: unknown[];
  };
  const 數 = (收錄.conferences ?? []).length;
  expect(text, "会議の數が収録と合はん").toContain(`会議 ${數} 件`);
  /* 締切の行の數も**收錄その物**の締切の數と合ふ（行から數へると「締切を持つ版」だけに
   * 成る – 第 769 回と同じ穴）。數へ方は `conferences[].editions[].deadlines[]` の全覆盖。 */
  const 全ての版 = ((收錄.conferences ?? []) as Array<{ editions?: unknown[] }>).flatMap(
    (c) => (c.editions ?? []) as Array<{ deadlines?: unknown[] }>,
  );
  const 締切の數 = 全ての版.reduce(
    (n: number, e: { deadlines?: unknown[] }) => n + (e.deadlines ?? []).length,
    0,
  );
  expect(締切の數, "この檢查の前提（締切が數へられない）が崩れた").toBeGreaterThan(1000);
  /* 千の桁を區切る（第 987 回 – MCP の統計の行が「5,069」を出すやうにした – 索引（llms.txt）と同じ形）。 */
  const 千の桁 = (n: number): string => String(n).replace(/(\d)(?=(\d{3})+(?!\d))/g, "$1,");
  expect(text, "締切の行の數が収録と合はん").toContain(`締切の行 ${千の桁(締切の數)} 行`);
  /* 確認の狀態の數も收錄の `verification.status` と合ふ。`parser-failed` は畫面上
   * 「複数候補のため要確認」に**同じ札**で出る（第 912 回 – 二つを別に數へると齟齬する）。 */
  const 締切々 = 全ての版.flatMap(
    (e) => (e.deadlines ?? []) as Array<{ verification?: { status?: unknown } }>,
  );
  const 狀態の數 = 締切々.reduce((數へる: Map<string, number>, d) => {
    const st = String(d.verification?.status ?? "");
    if (st) 數へる.set(st, (數へる.get(st) ?? 0) + 1);
    return 數へる;
  }, new Map<string, number>());
  const 複數 = (狀態の數.get("manual-required") ?? 0) + (狀態の數.get("parser-failed") ?? 0);
  expect(複數, "この檢查の前提（複數候補が數へられない）が崩れた").toBeGreaterThan(100);
  expect(text, "「複数候補のため要確認」の數が収録と合はん").toContain(
    `複数候補のため要確認 ${String(複數)} 行`,
  );
  expect(text, "「確認済み」の數が収録と合はん").toContain(
    `確認済み ${狀態の數.get("verified") ?? 0} 行`,
  );
  /* 「確認の記録なし」も收錄で `verification` が無い行の數と合ふ（行ごとの札が無いだけ）。 */
  const 記録なしの數 = 締切々.filter((d) => !String(d.verification?.status ?? "")).length;
  expect(text, "「確認の記録なし」の數が収録と合はん").toContain(
    `確認の記録なし ${記録なしの數} 行`,
  );
});

it("語を省いて、種別だけでも引ける（第 793 回）", async () => {
  /* 實測 2026-10-06: 「登録締切を全部見たい」と云ふ聞き方に、語が空だと斷つて居た。種別を
   * 指定して居れば語が無くても返す（人も AI も同じ聞き方をする）。 */
  const text = await call("search_deadlines", {
    query: "",
    kind: "registration",
    scope: "all",
    limit: 2,
  });
  expect(text, "語が無いと斷つて居る").toContain("語を指定せず、絞り込みだけ");
  expect(text, "件數を返して居ん").toMatch(/絞り込みだけ: [1-9]\d* 件/);
  /* 語も種別も無い時は、今まで通り斷る（何を見ればよいか分からん）。 */
  const 空 = await call("search_deadlines", { query: "" });
  expect(空, "種別も無いのに返した").toContain("検索語が空です");
  expect(空, "代はりの聞き方を敎へて居ん").toContain("kind / kinds");
});

it("explain_word は、行が出る時に中身を少し見せる（第 796 回）", async () => {
  /* 前は「search_deadlines で引けます」とだけ言っていたので、語を調べた人がもう一往復する
   * 必要があった（AI も同じ）。行は search_deadlines と同じ形（`line()`）で 3 行まで。 */
  const text = await call("explain_word", { word: "セキュリティ", scope: "all" });
  expect(text, "行數を言つて居ん").toMatch(
    /素の照合で [1-9]\d* 行・画面の既定の絞り込み（[^）]*）を通すと \d+ 行/,
  );
  const 行 = text.split("\n").filter((l) => l.startsWith("- 20"));
  expect(行.length, "中身を見せて居ん").toBeGreaterThan(0);
  expect(行.length, "見せる行が多過ぎる").toBeLessThanOrEqual(3);
  /* **件數は search_deadlines と違ふ事が在る**（此方は素の照合で數へ、向こうは語の畳みや
   * 絞り込みを通す – 第 796 回に實測: `ポスター` は此方 9 行・向こう 0 件）。其の事が説明に
   * 書いて在る事を見る（同じ數字だと思はせない）。 */
  const 一覽 = (await client.ask({ jsonrpc: "2.0", id: 6, method: "tools/list" })) as {
    result?: { tools?: Array<{ name?: string; description?: string }> };
  };
  const 説明 = (一覽.result?.tools ?? []).find((t) => t.name === "explain_word")?.description ?? "";
  expect(説明, "數へ方の違ひを説明して居ん").toContain("素の照合");
});

it("索引が、0 件の時の振る舞いを書いている（第 812 回）", () => {
  /* 畫面の 0 件案内（次に打つ手と、いまの絞り込みで数へた件数）は、索引を読む人と AI にも
   * 要る（第 758〜761 回に数へ方を直したが、索引には書いていなかった）。 */
  const build = readFileSync(join(REPO_ROOT, "src", "build.ts"), "utf8");
  expect(build, "0 件の時の振る舞いが索引に無い").toContain("0 件の時は、次に打つ手を示す");
  expect(build, "件数の基準が索引に無い").toContain("いまの絞り込みを通過した行で数へる");
});

it("索引が、會期の日付の確かさ（event_date_precision）を説明している（第 813 回）", () => {
  /* 實測 2026-10-06: data.json の版には event_date_precision が全 2,603 版に在り、値は六つ
   * （exact-range・single-day・month-only・split-dates・unverified・not-announced）だが、
   * 索引（llms.txt）に一度も出て居なかった – 讀む人（と AI）は其の欄を讀めない。 */
  const build = readFileSync(join(REPO_ROOT, "src", "build.ts"), "utf8");
  expect(build, "event_date_precision を索引が説明して居ん").toContain("event_date_precision");
  for (const 値 of [
    "exact-range",
    "single-day",
    "month-only",
    "split-dates",
    "unverified",
    "not-announced",
  ]) {
    expect(build, `${値} の説明が索引に無い`).toContain(値);
  }
});

it("索引が、data.json の残りの鍵も説明している（第 814 回）", () => {
  /* 實測 2026-10-06: data.json の各階層を總當たりすると、索引に一度も出て居ない鍵が八つ在つた
   * （会議 upstream_sub／版 call_identity・legacy_ids・event_review／締切 track・verification・
   * superseded_deadlines・promotion_ref）。讀む人（と AI）は其れ等を讀めない。 */
  const build = readFileSync(join(REPO_ROOT, "src", "build.ts"), "utf8");
  for (const 鍵 of [
    "upstream_sub",
    "call_identity",
    "legacy_ids",
    "event_review",
    "track",
    "verification",
    "superseded_deadlines",
    "promotion_ref",
  ]) {
    expect(build, `${鍵} の説明が索引に無い`).toContain(鍵);
  }
  expect(build, "付く頻度の實測が索引に無い").toContain("稀にしか付かない物と");
});

it("索引が、元の収録と建てた表示で数が違ふ事を書いている（第 816 回）", () => {
  /* 實測 2026-10-06: MCP の collection_stats は data/snapshot.json を数へるので「版 2,659」と
   * 言ふが、索引は「版 2,603」と書いて居た（建てた表示）。出所が違ふ事を索引が言はないと、
   * 讀む人（と AI）は同じ物の數だと思つて突き合はせる。 */
  const build = readFileSync(join(REPO_ROOT, "src", "build.ts"), "utf8");
  expect(build, "數の出所の違ひが索引に無い").toContain("元の収録と建てた表示で数が違ふ事がある");
  expect(build, "實測の數が索引に無い").toContain("版 2,659 ⇔ 建てた表示 2,603");
});

it("索引が、上流の英語の印（TBD）を説明している（第 833 回）", () => {
  /* 實測 2026-10-06: data.csv の `date_text` 65 行・`place` 10 行が上流の原文 `TBD` だつた。
   * 索引は「此方が付ける印は書かない」とだけ言つて居たので、讀む人（と AI）は `TBD` を
   * 此方の印と讀みかねない（空欄とは意味が違ふ）。 */
  const build = readFileSync(join(REPO_ROOT, "src", "build.ts"), "utf8");
  expect(build, "上流の英語の印の説明が索引に無い").toContain("上流が英語の印を書いて居る事がある");
  expect(build, "實測の行數が索引に無い").toContain("`date_text` 65 行・`place` 10 行");
});

it("索引が、data.csv の列名と data.json の鍵の關係を書いている（第 839 回）", () => {
  /* 實測 2026-10-06: 28 列のうち 24 列は「同じ名（又は接頭辭を外した名）」で data.json の鍵へ
   * 辿れる（deadline_* → deadlines[]、event_* → editions[]、rank_* → conferences[].rank、
   * estimate_window_* → editions[].estimate）。索引は一般的な出所しか書いて居なかった。 */
  const build = readFileSync(join(REPO_ROOT, "src", "build.ts"), "utf8");
  expect(build, "列名の規則が索引に無い").toContain("多くが `data.json` の鍵と同じ名である");
  expect(build, "實測の列數が索引に無い").toContain("31 列のうち 26 列が此の規則で辿れる");
});

it("索引が、6 道具の引數の名を書いている（第 843 回・第 857 回に推薦の分を足した）", () => {
  /* 實測 2026-10-06: 索引は kinds / kind / scope / key / name / word は書いて居たが、query・
   * limit・include_past・include_estimated・days を書いて居なかつた（道具の schema を見ない
   * 讀み手には、何が渡せるか分からん）。 */
  const build = readFileSync(join(REPO_ROOT, "src", "build.ts"), "utf8");
  for (const 名 of [
    "`query`",
    "`limit`",
    "`include_past`",
    "`include_estimated`",
    "`days`",
    "`paper`",
    "`rank`",
  ]) {
    expect(build, `${名} が索引に無い`).toContain(名);
  }
});

/* ---- 第 854 回: 返り値の文と、データ生成の言ひ方を畫面に揃へる ---- */

/** 舊字體（此の計畫の內側では使ふが、利用者に出る文では使はない）。 */
const 舊字體 =
  "亞惡壓圍爲醫壹榮衞驛悅圓緣艷鹽奧應歐毆櫻橫溫價畫會懷繪擴殼學嶽樂渴卷陷勸寬歡罐觀關顏歸" +
  "氣龜僞戲犧舊據擧峽狹鄕曉區驅勳薰羣徑惠揭溪經繼莖螢輕鷄藝擊缺儉劍圈檢權獻硏縣險顯驗嚴廣效" +
  "恆鑛號國黑濟碎齋劑冱雜參慘蠶贊殘絲齒兒辭濕實舍壽收從澁獸縱肅處敍將燒獎條狀乘淨剩疊孃讓" +
  "釀囑觸寢愼盡圖粹醉穗隨髓數樞瀨聲靜齊攝竊專淺戰纖禪曾雙壯爭莊搜巢裝騷增藏臟屬續墮體對帶" +
  "滯臺瀧擇澤單膽團彈斷癡遲蟲鑄廳徵聽懲鎭遞鐵點轉傳燈當黨盜稻鬪德獨讀屆繩惱腦霸廢拜賣麥發" +
  "髮拔蠻祕拂佛變邊辨瓣辯舖步寶豐襃沒飜槇每萬滿默彌藥與搖樣謠來賴亂覽龍兩獵綠淚壘禮勵戾靈" +
  "齡曆歷戀鍊爐勞樓郞錄灣眞";

/** TS の字句を讀み、**此方が書いた文**（文字列リテラルの內、`${…}` の外）だけを集める。
 * 註と識別子は入れない（識別子を文として數へると、字の掃除が改名に化ける – 第 774 回）。 */
function 文を集める(本文: string): Array<{ 行: number; 文: string }> {
  const out: Array<{ 行: number; 文: string }> = [];
  let i = 0;
  let 行 = 1;
  const 長さ = 本文.length;

  const 文字列 = (引用: string): void => {
    const 開始 = 行;
    let buf = "";
    while (i < 長さ) {
      const c = 本文[i];
      if (c === "\\") {
        buf += 本文.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === 引用) {
        i += 1;
        break;
      }
      if (c === "\n") {
        行 += 1;
        if (引用 !== "`") break;
        buf += c;
        i += 1;
        continue;
      }
      if (引用 === "`" && c === "$" && 本文[i + 1] === "{") {
        i += 2;
        式();
        continue;
      }
      buf += c;
      i += 1;
    }
    out.push({ 行: 開始, 文: buf });
  };

  const 式 = (): void => {
    let 深さ = 1;
    while (i < 長さ && 深さ > 0) {
      const c = 本文[i];
      if (c === "\n") {
        行 += 1;
        i += 1;
        continue;
      }
      if (c === "/" && 本文[i + 1] === "/") {
        while (i < 長さ && 本文[i] !== "\n") i += 1;
        continue;
      }
      if (c === "/" && 本文[i + 1] === "*") {
        i += 2;
        while (i < 長さ && !(本文[i] === "*" && 本文[i + 1] === "/")) {
          if (本文[i] === "\n") 行 += 1;
          i += 1;
        }
        i += 2;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        i += 1;
        文字列(c);
        continue;
      }
      if (c === "{") 深さ += 1;
      else if (c === "}") 深さ -= 1;
      i += 1;
    }
  };

  while (i < 長さ) {
    const c = 本文[i];
    if (c === "\n") {
      行 += 1;
      i += 1;
      continue;
    }
    if (c === "/" && 本文[i + 1] === "/") {
      while (i < 長さ && 本文[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && 本文[i + 1] === "*") {
      i += 2;
      while (i < 長さ && !(本文[i] === "*" && 本文[i + 1] === "/")) {
        if (本文[i] === "\n") 行 += 1;
        i += 1;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i += 1;
      文字列(c);
      continue;
    }
    i += 1;
  }
  return out;
}

/** 收錄その物の生成時刻（`data/snapshot.json` の `snapshot_metadata`）。 */
function 收錄の生成時刻(): string {
  const 收錄 = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as {
    snapshot_metadata?: { generated_at?: string };
  };
  return String(收錄.snapshot_metadata?.generated_at ?? "");
}

/** 畫面の右上と同じ書き方（`YYYY-MM-DD(曜) HH:MM JST`）を此方で組んで突き合はせる。 */
function 畫面の書き方(iso: string): string {
  const jst = new Date(Date.parse(iso) + 9 * 3600000);
  const 曜 = ["日", "月", "火", "水", "木", "金", "土"][jst.getUTCDay()];
  const 二桁 = (n: number): string => String(n).padStart(2, "0");
  return `${jst.getUTCFullYear()}-${二桁(jst.getUTCMonth() + 1)}-${二桁(jst.getUTCDate())}(${曜}) ${二桁(jst.getUTCHours())}:${二桁(jst.getUTCMinutes())} JST`;
}

it("入力の形が、道具の説明と一致する（第 854 回）", async () => {
  /* 實測 2026-10-08: `search_deadlines` の說明は「**語を省いて `kind` / `kinds` だけでも
   * 引ける**」と言ひ、實装も其う動くのに、schema は `required: ["query"]` と言つて居た –
   * 引數を schema で檢める客户は、說明に在る呼び方を彈く。同じく、說明と實装が受ける
   * `kind`（單數）が `properties` に無かつた（第 728 回に受ける樣にしたが、形に書いて
   * 居なかつた）。 */
  const res = (await client.ask({ jsonrpc: "2.0", id: 7, method: "tools/list" })) as {
    result?: {
      tools?: Array<{
        name?: string;
        description?: string;
        inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
      }>;
    };
  };
  const tools = res.result?.tools ?? [];
  for (const tool of tools) {
    for (const 名 of tool.inputSchema?.required ?? []) {
      expect(
        Object.keys(tool.inputSchema?.properties ?? {}),
        `${tool.name} の必須 ${名} が properties に無い（形が自分と食ひ違ふ）`,
      ).toContain(名);
    }
  }
  /* **實装が受ける引數と、形に書いた物を突き合はせる**（表で持つ – 引數を足したのに形へ
   * 書き忘れると、引數を形で檢める客户が其の引數を彈く。第 858 回に `rank` を實装へ足して
   * 形へ書き忘れ、第 860 回に此の檢查で見付けた）。 */
  const 期待: Record<string, string[]> = {
    search_deadlines: [
      "query",
      "limit",
      "include_past",
      "include_estimated",
      "kinds",
      "kind",
      "rank",
      "domestic",
      "online",
      "within_days",
      "scope",
    ],
    list_upcoming: ["days", "kind", "kinds", "scope"],
    venue_info: ["key", "name", "scope"],
    recommend_venues: ["paper", "limit"],
    explain_word: ["word", "scope"],
    collection_stats: [],
  };
  for (const [道具, 鍵] of Object.entries(期待)) {
    const t = tools.find((x) => x.name === 道具);
    expect(t, `道具が無い: ${道具}`).toBeTruthy();
    expect(Object.keys(t?.inputSchema?.properties ?? {}).sort(), `${道具} の引數が違ふ`).toEqual(
      [...鍵].sort(),
    );
  }
  const 檢索 = tools.find((t) => t.name === "search_deadlines");
  expect(String(檢索?.description ?? ""), "語を省ける事を說明して居ん").toContain("語を省いて");
  expect(
    檢索?.inputSchema?.required ?? [],
    "說明は語を省けると言ふのに、形は query を必須にして居る",
  ).not.toContain("query");
  expect(
    Object.keys(檢索?.inputSchema?.properties ?? {}),
    "說明と實装が受ける kind（單數）が形に無い",
  ).toContain("kind");
  /* 擧動でも確かめる（形だけ直して、受け方が違つては意味が無い）。 */
  const 數 = (t: string): number =>
    Number(/絞り込みだけ: ([\d,]+) 件/.exec(t)?.[1]?.replace(/,/g, "") ?? -1);
  const 單 = await call("search_deadlines", { kind: "paper", scope: "all", limit: 1 });
  const 複 = await call("search_deadlines", { kinds: ["paper"], scope: "all", limit: 1 });
  expect(數(單), "語を省いて kind だけでは引け無い").toBeGreaterThan(0);
  expect(數(複), "kind と kinds で數が違ふ").toBe(數(單));
});

it("collection_stats が、畫面の右上と同じ書き方でデータ生成を返す（第 854 回）", async () => {
  /* 畫面は右上に「データ生成」を常に出し、生成から 3 日以上なら其の旨も出す。MCP が何も
   * 言はないと、人が見た日付と AI の答へが違ふ（第 803・804 回と同じ考へ – 人が見る物と
   * AI が言ふ物を同じにする）。**同じ檔案から、同じ書き方で**出す。 */
  const 生成 = 收錄の生成時刻();
  expect(生成, "此の檢査の前提（收錄の生成時刻）が崩れた").not.toBe("");
  const text = await call("collection_stats", {});
  expect(text, "データ生成を言つて居ん").toContain(`データ生成: ${畫面の書き方(生成)}`);
  expect(text, "畫面と違ふ書き方（UTC の侭・秒まで）").toMatch(
    /データ生成: \d{4}-\d{2}-\d{2}\([日月火水木金土]\) \d{2}:\d{2} JST/,
  );
  /* 説明にも書く（AI は説明だけを見て道具を選ぶ – 第 766 回）。 */
  const 一覽 = (await client.ask({ jsonrpc: "2.0", id: 8, method: "tools/list" })) as {
    result?: { tools?: Array<{ name?: string; description?: string }> };
  };
  const 説明 = (一覽.result?.tools ?? []).find((t) => t.name === "collection_stats")?.description;
  expect(String(説明 ?? ""), "データ生成時刻を言ふ事を説明して居ん").toContain("データ生成時刻");
  /* 畫面が最初に讀む窓は別の檔案なので、其方の生成時刻も別に言ふ。 */
  const 品書 = join(REPO_ROOT, "public", "catalog.json");
  if (existsSync(品書)) {
    const catalog = JSON.parse(readFileSync(品書, "utf8")) as { generated_at?: string };
    const 窓 = String(catalog.generated_at ?? "");
    if (窓) expect(text, "窓の生成時刻を言つて居ん").toContain(畫面の書き方(窓));
  }
});

it("收錄が古ければ、畫面と同じ斷りを付ける（第 854 回）", async () => {
  /* 畫面は生成から 3 日以上で「データは N 日前に生成されたものです」と出す。MCP も
   * **同じ函數から**取る – 別に書くと、畫面と AI で日數も閾値もずれる。 */
  const 今 = Date.now();
  const 元の斷り = String(Recommender.dataAgeNoteJa(收錄の生成時刻(), 今) ?? "").trim();
  const 全體 = await call("search_deadlines", { query: "セキュリティ", scope: "all", limit: 1 });
  if (元の斷り) expect(全體, "古いのに斷りが無い").toContain(元の斷り);
  else expect(全體, "新しいのに斷りを付けた").not.toContain("日前に生成された");
  /* 窓を見る時は、窓の生成時刻で數へる（出所の檔案が違ふ）。 */
  const 品書 = join(REPO_ROOT, "public", "catalog.json");
  if (!existsSync(品書)) return;
  const catalog = JSON.parse(readFileSync(品書, "utf8")) as { generated_at?: string };
  const 窓の斷り = String(Recommender.dataAgeNoteJa(catalog.generated_at, 今) ?? "").trim();
  const 窓 = await call("search_deadlines", { query: "セキュリティ", scope: "screen", limit: 1 });
  if (窓の斷り) expect(窓, "窓の古さを言つて居ん").toContain(窓の斷り);
  else expect(窓, "新しい窓に斷りを付けた").not.toContain("日前に生成された");
  /* 二つの窓の古さが違ふ時は、取り違へて居ない事まで見る（別の檔案を讀んで居る證據）。 */
  if (元の斷り && 窓の斷り && 元の斷り !== 窓の斷り) {
    expect(全體, "窓の古さを混ぜた").not.toContain(窓の斷り);
    expect(窓, "收錄の古さを混ぜた").not.toContain(元の斷り);
  }
});

it("MCP が返す文に、舊字體を混ぜない（第 854 回）", () => {
  /* 畫面は「画面」「収録」「残り」と書く。MCP の文が「畫面」「收錄」「殘り」だと、AI が
   * 其の侭人に返し、畫面の語と食ひ違ふ。第 803・804 回に手で洗つたが守りが無かつたので、
   * 第 848 回と同じ考へで機械に止めさせる。**見るのは此方が書いた文だけ** – 註と識別子は
   * 內側の文体（第 774 回）。 */
  const 文々 = 文を集める(readFileSync(join(REPO_ROOT, "src", "mcp.ts"), "utf8"));
  expect(文々.length, "文を一つも集められて居ない（走査が壊れて居る）").toBeGreaterThan(100);
  for (const { 行, 文 } of 文々) {
    /* 走査が崩れて居たら氣付ける樣に、集めた文に註の記号が混ざつて居ない事も見る（字句の
     * 讀み方が崩れると、文で無い物を文として見たり、本當の文を見落としたりする）。 */
    expect(/\/\*|\*\//.test(文), `src/mcp.ts:${行} の走査が崩れて居る`).toBe(false);
    const 混ざり = [...new Set([...文].filter((c) => 舊字體.includes(c)))];
    expect(混ざり.join(""), `src/mcp.ts:${行} の文に舊字體: ${文.slice(0, 60)}`).toBe("");
  }
});

it("建造物（畫面が讀む JS）の文にも、舊字體を混ぜない（第 952 回）", async () => {
  /* ソースの檢查（第 851 回）の**出口**を見る – 實測 2026-11-12: `public/app.js` と
   * `public/recommender.js` の文字列リテラルを同じ走査に掛ける。 建造物は alias 表を
   * まるごと持つので、舊字体の打ち手（`國際` 等）が其の儘殘る – 其れは**鍵**なので對象外
   * （第 772 回と同じ決まり）。此處で見たいのは「此方が書いた文」だけ。 */
  if (!existsSync(join(REPO_ROOT, "public", "app.js"))) return; // 建造物は CI が作る
  for (const 相 of ["public/app.js", "public/recommender.js"]) {
    const 本文 = readFileSync(join(REPO_ROOT, 相), "utf8");
    const 文々 = 文を集める(本文);
    const 行々 = 本文.split("\n");
    const 見つけた: string[] = [];
    for (const { 行, 文 } of 文々) {
      /* **表の鍵**（寄せ表・語の一覽）は舊字体の打ち手を受け付けるので對象外 – 監査の
       * 「鍵らしい」と同じ決まり（第 772 回）。實測 2026-11-12: 建造物の `UI_WORD_TAILS_JA`
       * は `"殘る"` と `"残る"` の**兩方**を載せて居る（どちらで打つても受け付ける爲）。 */
      const 元の行 = 行々[行 - 1] ?? "";
      if (/^\s*\[/.test(元の行)) continue; // 寄せ表の行（`["國際", …]`）
      if (/^\s*["'`][^"'`]*["'`],?\s*$/.test(元の行)) continue; // 語の一覽の行
      const 混ざり = [...new Set([...文].filter((c) => 舊字體.includes(c)))];
      if (混ざり.length) 見つけた.push(`${相}:${行}: ${混ざり.join("")}｜${文.slice(0, 50)}`);
    }
    expect(見つけた, `建造物の文に舊字體:\n${見つけた.join("\n")}`).toEqual([]);
  }
});

it("畫面の文にも、舊字體を混ぜない（第 851 回の畫面版）", async () => {
  /* 第 854 回が MCP の文を見た。**畫面の文**も同じ目で見る – 實測 2026-11-12:
   * `site/app.ts` の文字列リテラルを集めて數へると、舊字體は 0 字だつた（聲と樣は
   * 註と識別子だけ）。此れを守りにする（次の人が畫面の文に舊字體を書いても氣づく）。
   *
   * 見るのは**此方が書いた文**だけ（識別子と註は内側の文体 – 第 774 回）。 */
  /* `src/build.ts` は此の走査が註の中の逆引用符で迷ふ（實測 2026-11-12: 3,253 行の註の
   * 尻切れが「文」として集まる）。build.ts の利用者に見える文は索引（`llms.txt`）として
   * 出る物 – 其方は第 926・927 回の實測檢査で値の正しさを見て居る。此では **畫面の2ファイル**
   * を見る（瀏覽器の中の文）。 */
  for (const 相 of ["site/app.ts", "site/recommender.ts"]) {
    const 文々 = 文を集める(readFileSync(join(REPO_ROOT, 相), "utf8"));
    expect(文々.length, `${相} の文を一つも集められて居ない（走査が壊れて居る）`).toBeGreaterThan(
      10,
    );
    const 行々 = readFileSync(join(REPO_ROOT, 相), "utf8").split("\n");
    for (const { 行, 文 } of 文々) {
      /* **寄せ表の鍵**は舊字体の打ち手を受け付ける為に意図的に置いてある（`國際` を打つ人を
       * `international` へ送る – 第 772 回に一括置換で檢查七本が落ちた）。行が表の書き出し
       * （配列の要素・`words:`・`寄せ`）なら、此の檢查の對象外（監査の「鍵らしい」と同じ）。 */
      const 元の行 = 行々[行 - 1] ?? "";
      if (
        /^\s*\[/.test(元の行) ||
        /^\s*["'`][^"'`]*["'`],?\s*$/.test(元の行) ||
        /words:|寄せ|\bretype\b/.test(元の行)
      ) {
        continue;
      }
      const 混ざり = [...new Set([...文].filter((c) => 舊字體.includes(c)))];
      expect(混ざり.join(""), `${相}:${行} の文に舊字體: ${文.slice(0, 50)}`).toBe("");
    }
  }
});

it("投稿先の推薦が、畫面と同じ核で出る（第 857 回）", async () => {
  /* 畫面の「投稿先を探す」は此の計畫の看板だが、MCP に出口が無く、AI は「この論文は何處に
   * 出せる?」に此の收錄を使って答へられなかつた。**同じ推薦核**（`venueRecommendations`）を
   * 使ふので、候補も順も畫面と一致する（語の一致だけの道 – 埋め込みは讀まない）。 */
  const 索引 = JSON.parse(
    readFileSync(join(REPO_ROOT, "public", "recommendation-index.json"), "utf8"),
  ) as { conferences?: unknown[]; reranker?: unknown };
  expect(索引.conferences?.length, "此の檢査の前提（建てた推薦の索引）が崩れた").toBeGreaterThan(0);
  Recommender.setNameIdf(Recommender.buildNameIdf(索引.conferences ?? []));
  Recommender.setReranker(索引.reranker ?? null);
  const 題 =
    "Time-Sensitive Networking Scheduling for Deterministic Industrial Networks | tsn, real-time, scheduling, deterministic";
  const now = Date.now();
  /* pool は**畫面と同じ** – 品書（畫面が讀む一覽）の行から、これからの締切 + 常時受付の
   * ジャーナル + これからの締切が無い會議の過去代表 1 行を選ぶ（第 894 回。其れ迄は索引の
   * 行をそのまま使つて居た – 2,458 本の内 2,270 本が過ぎた締切だつた）。 */
  const 品書 = join(REPO_ROOT, "public", "catalog.json");
  const 品書の會議 = existsSync(品書)
    ? ((JSON.parse(readFileSync(品書, "utf8")) as { conferences?: unknown[] }).conferences ?? [])
    : (索引.conferences ?? []);
  索引.conferences = 品書の會議; // 行・ジャーナルとも品書から（MCP と同じ出所）
  const 行 = Recommender.candidateRows(索引 as never);
  const pool = (行 as unknown as Parameters<typeof Recommender.deadlineRowIsPast>[0][])
    .filter((r) => !Recommender.deadlineRowIsPast(r as never, now))
    .concat(Recommender.journalRows(索引.conferences ?? [], now) as unknown as never[])
    .concat(Recommender.pastRepresentatives(行 as never, now) as unknown as never[]);
  const 正 = Recommender.venueRecommendations(
    pool as never,
    Recommender.parsePaperLines(題),
    null,
    now,
    { fieldedLexical: true },
  ).filter((r) => r.fit.score >= 10);
  expect(正.length, "此の檢査の前提（候補が出る題名）が崩れた").toBeGreaterThan(0);
  const text = await call("recommend_venues", { paper: 題, limit: 5 });
  expect(text, "件數が核と違ふ").toContain(`に合う投稿先: ${正.length} 件`);
  expect(text, "先頭の候補が核と違ふ").toContain(String(正[0].row.conf.title));
  /* **何で評價して居るか**を頭で斷る（意味検索の埋め込みを讀まない事・點が畫面と動く事。
   * 人が見る數と AI が言ふ數が違ふのが一番惡い）。 */
  expect(text, "何で評價して居るか言つて居ん").toContain("語の一致と再学習の重みで評価");
  expect(text, "埋め込みを讀まない事を言つて居ん").toContain("埋め込みは読まない");
  expect(text, "切り詰めを默つて居る").toContain("残り");
  /* 題名が空なら、打ち方を敎へる（默らない）。 */
  const 空 = await call("recommend_venues", { paper: "" });
  expect(空, "空の題名に答へて居ん").toContain("論文の題名");
  expect(空, "入力の形を敎へて居ん").toContain("題名 | キーワード");
});

it("行にランクが付き、等級で厳密に絞れる（畫面のランク列と同じ語・同じ判定・第 858 回）", async () => {
  /* 畫面の一覧にはランクの列が在り「A*ランク」のボタンで絞れるのに、MCP の行にはランクが
   * 無く、語で引いても厳密に絞れなかった（實測 2026-10-08: `CCF A` の語は 101 行に當たるが、
   * `ccf:A` を持つ行は 34 行 – 語の檢索では等級も體系も卷き込む）。 */
  const rows = Recommender.candidateRows(
    JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as never,
  );
  const now = Date.now();
  const 語 = "セキュリティ";
  const 照合 = Recommender.searchMatcher(Recommender.expandRelativeMonths(語, now), now);
  const 正 = rows.filter(
    (r) =>
      照合(r.hay) === true &&
      r.t >= now &&
      !r.est &&
      ["abstract", "paper", "journal"].includes(r.kind) &&
      Recommender.rankMatches(r.rankPairs ?? [], "A*"),
  ).length;
  expect(正, "此の檢査の前提（A* の行が在る）が崩れた").toBeGreaterThan(0);
  const 數 = (t: string): number => Number(/に当たる締切: (\d+) 件/.exec(t)?.[1] ?? -1);
  const text = await call("search_deadlines", { query: 語, rank: "A*", scope: "all", limit: 1 });
  expect(數(text), "A* の絞り込みが畫面の判定と違ふ").toBe(正);
  expect(text, "頭にランクを出して居ん").toContain("／ランク A*");
  /* 行その物にもランクが付く（畫面のランク列と同じ語 – 内部の `ccf:A` は出さない）。 */
  const 広 = await call("search_deadlines", { query: 語, scope: "all", limit: 5 });
  expect(広, "行にランクが無い").toMatch(/\| (CCF|CORE|THCPL) [^|]*\|/);
  expect(広, "ランクの内部の書き方を出して居る").not.toMatch(/\| (ccf|core|thcpl):/);
  /* どのランク表にも載って居ない行は、畫面と同じく「ランク未確認」と書く。 */
  const 全部 = await call("search_deadlines", {
    query: "研究会",
    kinds: ["all"],
    scope: "all",
    limit: 20,
  });
  expect(全部, "「ランク未確認」を書いて居ん").toContain("ランク未確認");
  /* 無い等級は名指す（其の侭では 0 件に成る）。 */
  const 無 = await call("search_deadlines", { query: 語, rank: "A+", scope: "all", limit: 1 });
  expect(無, "知らない等級を名指して居ん").toContain("知らないランク");
  expect(無, "等級の一覧を敎へて居ん").toContain("A*・A・B・C・N");
});

it("venue_info が、分野とランクを返す（第 858 回）", async () => {
  const text = await call("venue_info", { key: "sigkdd", scope: "all" });
  expect(text, "分野を返して居ん").toContain("分野:");
  expect(text, "ランクを返して居ん").toMatch(/ランク: (CCF|CORE|THCPL)/);
  expect(text, "ランクの語を書き寫して居る").not.toMatch(/ランク: (ccf|core|thcpl):/);
});

it("行に会期が付く（畫面の「会期」列と同じ入口・第 859 回）", async () => {
  /* 畫面の一覧には「会期」の列が在るのに、MCP の行は締切だけを言つて居た – AI は
   * 「NSDI 2027 はいつ開かれる?」に此の收錄で答えられなかつた（出張の段取りは此れで決める）。 */
  const rows = Recommender.candidateRows(
    JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as never,
  );
  const 題 = await call("venue_info", { key: "nsdi", scope: "all" });
  const 會期 = [
    ...new Set(rows.filter((r) => r.conf.key === "nsdi").map((r) => Recommender.eventCellJa(r))),
  ].filter(Boolean);
  expect(會期.length, "此の檢査の前提（NSDI の会期）が崩れた").toBeGreaterThan(0);
  expect(題, "会期を出して居ん").toContain(`会期 ${會期[0]}`);
  /* **どの行にも会期の欄が在る**（決まって居ない行も「未確認」と書く – 默ると
   * 「無い」と讀まれる）。 */
  const 一覽 = await call("list_upcoming", { days: 90, scope: "all" });
  const 行 = 一覽.split("\n").filter((l) => /^\d{4}-\d{2}-\d{2}/.test(l));
  expect(行.length, "此の檢査の前提（日付の行が在る）が崩れた").toBeGreaterThan(3);
  for (const l of 行) {
    expect(l, `会期の欄が無い行が在る: ${l.slice(0, 60)}`).toMatch(/\| 会期 [^|]+ \|/);
  }
  /* 値は畫面と同じ助っ人（`eventCellJa`）から取つた物で突き合はせる – 上の `toContain` が
   * 其れ（書き寫すと、會期の言ひ方がずれる）。 */
});

it("行に、延長と確認の状態の札が付く（畫面の一覧の札と同じ語・第 860 回）", async () => {
  /* 畫面の一覧の行には札が付く（延長・確認の状態）。MCP の行には無かったので、AI は
   * **上流に候補が複数ある締切**（複数候補のため要確認）を、確定した締切として答へて居た。 */
  const rows = Recommender.candidateRows(
    JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as never,
  );
  const 檢 = (r: (typeof rows)[number]): unknown =>
    (r.dl as { verification?: unknown } | undefined)?.verification;
  const 印 = (r: (typeof rows)[number]): string =>
    String(Recommender.verificationStatusLabelJa(檢(r)) ?? "").trim();
  const 要確認 = rows.find((r) => r.conf?.key && 印(r));
  expect(要確認, "此の檢査の前提（印の付く行）が崩れた").toBeTruthy();
  const text = await call("venue_info", { key: String(要確認?.conf.key), scope: "all" });
  expect(text, "確認の状態の札が無い").toContain(印(要確認!));
  expect(text, "內部の狀態の名を出して居る").not.toContain("manual-required");
  /* 確認済みには札を付けない（畫面も印を出さない – 默るのが正しい）。 */
  const 確認済み = rows.find(
    (r) =>
      r.conf?.key &&
      String((檢(r) as { status?: unknown } | undefined)?.status ?? "") === "verified",
  );
  if (確認済み) {
    const t2 = await call("venue_info", { key: String(確認済み.conf.key), scope: "all" });
    /* **行の札**には付けない（確認済みの行は畫面も印を出さない）。第 868 回に足した
     * 「確認: 」の內譯の行は別 – 其方は狀態の語を数えて出す物。 */
    for (const l of t2.split("\n").filter((l) => /^\d{4}-\d{2}-\d{2}/.test(l)))
      expect(l, `確認済みの行に札を付けた: ${l.slice(0, 60)}`).not.toContain("確認済み");
  }
  /* 延長の札（上流の締切名に Extended と付く行）。 */
  const 延長 = rows.find((r) => r.conf?.key && Recommender.isExtendedDeadline(r.dl));
  if (延長)
    expect(
      await call("venue_info", { key: String(延長.conf.key), scope: "all" }),
      "延長の札が無い",
    ).toContain(String(Recommender.extendedLabelJa()));
});

it("国内・オンラインの絞り込みが、画面のチェック欄と同じ集合を返す（第 865 回）", async () => {
  /* 畫面のチェック欄（「国内研究会・国内シンポジウムのみ」「オンライン参加可のみ」）と
   * **同じ判定**を引數にした。語（「国内」「オンライン参加可」）でも同じ集合に成る事は
   * 實測して居るが、AI が魔法の語を知らないと使へない – 引數なら畫面のボタンと同じ物が
   * 其の侭使へる。 */
  const rows = Recommender.candidateRows(
    JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as never,
  );
  const now = Date.now();
  const 既定 = (r: (typeof rows)[number]): boolean =>
    !Recommender.deadlineRowIsPast(r, now) &&
    !r.est &&
    ["abstract", "paper", "journal"].includes(r.kind);
  const 國內 = rows.filter((r) => 既定(r) && (r.tags ?? []).indexOf("domestic-jp") >= 0).length;
  const オンライン = rows.filter(
    (r) => 既定(r) && Recommender.placeOffersOnline(r.ed.place),
  ).length;
  expect(國內, "此の檢査の前提（國內の行）が崩れた").toBeGreaterThan(0);
  expect(オンライン, "此の檢査の前提（オンラインの行）が崩れた").toBeGreaterThan(0);
  const 數 = (t: string): number =>
    Number(/絞り込みだけ: ([\d,]+) 件/.exec(t)?.[1]?.replace(/,/g, "") ?? -1);
  /* 語を省いても、絞り込みだけで引ける（「國內の締切を全部」の樣な聞き方）。 */
  const 國 = await call("search_deadlines", { domestic: true, scope: "all", limit: 1 });
  expect(數(國), "國內の件數が畫面の判定と違ふ").toBe(國內);
  expect(國, "頭に絞り込みを書いて居ん").toContain("／国内のみ");
  const 網 = await call("search_deadlines", { online: true, scope: "all", limit: 1 });
  expect(數(網), "オンラインの件數が畫面の判定と違ふ").toBe(オンライン);
  expect(網, "頭に絞り込みを書いて居ん").toContain("／オンライン参加可のみ");
  /* 語で引いた時と同じ集合（同じ數に成る）。 */
  const 語 = await call("search_deadlines", { query: "国内", scope: "all", limit: 1 });
  expect(Number(/に当たる締切: ([\d,]+) 件/.exec(語)?.[1]?.replace(/,/g, "") ?? -1)).toBe(國內);
  /* 兩方のチェックは重ねられる（畫面と同じ – 國內のオンライン參加可）。 */
  const 兩方 = await call("search_deadlines", {
    domestic: true,
    online: true,
    scope: "all",
    limit: 1,
  });
  expect(數(兩方), "兩方の絞り込みが重なつて居ん").toBeLessThanOrEqual(國內);
});

it("締切の行が 1 本も無い会議を「収録に無い」と言わない（第 866 回）", async () => {
  /* 畫面は「収録に無い」と「収録に在るが締切が 1 本も無い」を分けて居る（第 294 回の實測:
   * 品書の會議 248 件のうち 74 件は締切が 1 本も無い）。行から引いて居たので、MCP は
   * 締切を持たん會議に「収録に在りません」と答へて居た（會期だけの會議は upcoming.md に
   * 「開催」として載つて居るのに、其れも言はなかつた）。 */
  const snap = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as {
    conferences?: Array<{ key?: string; editions?: Array<{ event_start?: string }> }>;
  };
  const 會 = snap.conferences ?? [];
  const 行の鍵 = new Set(
    Recommender.candidateRows(snap as never).map((r) => String(r.conf?.key ?? "")),
  );
  const 締切なし = 會.filter((c) => c.key && !行の鍵.has(String(c.key)));
  expect(締切なし.length, "此の檢査の前提（締切の行が無い會議）が崩れた").toBeGreaterThan(0);
  const 會期あり = 締切なし.find((c) => (c.editions ?? []).some((e) => e.event_start));
  const 會期なし = 締切なし.find((c) => !(c.editions ?? []).some((e) => e.event_start));
  for (const c of [會期あり, 會期なし].filter(Boolean)) {
    const text = await call("venue_info", { key: String(c?.key), scope: "all" });
    expect(text, `${c?.key} を「収録に無い」と言つた`).not.toContain("収録に在りません");
    expect(text, `${c?.key} に締切が無い事を言つて居ん`).toContain("締切の行が 1 本もありません");
  }
  if (會期あり) {
    const text = await call("venue_info", { key: String(會期あり.key), scope: "all" });
    expect(text, "會期の行き先を敎へて居ん").toContain("upcoming.md");
  }
  /* 收錄その物の數（`collection_stats` と同じ）を言ふ – 行から數へると 622 に成つて居た。 */
  const 無 = await call("venue_info", { name: "ぬけぬけ会議", scope: "all" });
  expect(無, "收錄の數が收錄その物と違ふ").toContain(`収録 ${會.length} 会議`);
});

it("0 件の時、収録の会議の名前に当たっていれば其の旨を言う（第 867 回）", async () => {
  /* 畫面の 0 件案内は「名簿に在るのに締切の行が 1 本も無い會議」を名指す（第 294 回）が、
   * 其の計算は畫面の側に在り、MCP は Recommender 層の案内しか使つて居なかつた –
   * 締切を持たん會議の名前で引くと「1 行も出ません」とだけ言ひ、**収録に在る事**も、
   * 會期が何處に載るかも言はなかつた。 */
  const snap = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as {
    conferences?: Array<{ key?: string; editions?: Array<{ event_start?: string }> }>;
  };
  const 會 = snap.conferences ?? [];
  const 行の鍵 = new Set(
    Recommender.candidateRows(snap as never).map((r) => String(r.conf?.key ?? "")),
  );
  const 締切なし = 會.find(
    (c) =>
      c.key &&
      !行の鍵.has(String(c.key)) &&
      (c.editions ?? []).some((e) => String(e.event_start ?? "").trim()),
  );
  expect(締切なし, "此の檢査の前提（締切の行が無く會期だけの會議）が崩れた").toBeTruthy();
  const text = await call("search_deadlines", {
    query: String(締切なし?.key),
    scope: "all",
    limit: 1,
  });
  expect(text, "1 行も出ないと言ふだけ").toContain("収録の会議の名前には");
  expect(text, "締切が無い事を言つて居ん").toContain("締切の行が 1 本もありません");
  expect(text, "會期の行き先を敎へて居ん").toContain("upcoming.md");
  expect(text, "「収録に無い」と言つた").not.toContain("収録に在りません");
  /* 収録に無い語では、此の案内を出さない（默るのが正しい）。 */
  const 無 = await call("search_deadlines", { query: "ぬけぬけ会議", scope: "all", limit: 1 });
  expect(無, "収録に無い語に名前の案内を付けた").not.toContain("収録の会議の名前には");
  /* 語が當たる時は、此の案内を出さない（行が出るので要らない）。 */
  const 有 = await call("search_deadlines", { query: "セキュリティ", scope: "all", limit: 1 });
  expect(有, "行が出て居るのに名前の案内を付けた").not.toContain("収録の会議の名前には");
});

it("確認の状態の内訳を、画面と同じ語で返す（第 868 回）", async () => {
  /* 「この収録は信用できるか」は研究者が最初に聞く事。畫面は行ごとの札と行の詳細で答へて
   * 居るが、MCP は行ごとの札しか言はなかつたので、收錄全體の內譯（公式で確認済みが何行か）を
   * 答へられなかつた。語は畫面と同じ正本から取る。 */
  const rows = Recommender.candidateRows(
    JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as never,
  );
  const 表 = Recommender.verificationStatusLabelTable() as Record<string, string>;
  const 期待 = new Map<string, number>();
  let 記録なし = 0;
  for (const r of rows) {
    const s = String(
      (r.dl as { verification?: { status?: string } } | undefined)?.verification?.status ?? "",
    ).trim();
    if (!s) {
      記録なし += 1;
      continue;
    }
    const 語 = 表[s] || "再確認待ち";
    期待.set(語, (期待.get(語) ?? 0) + 1);
  }
  expect(期待.size, "此の檢査の前提（確認の狀態）が崩れた").toBeGreaterThan(0);
  const text = await call("collection_stats", {});
  const 行 = text.split("\n").find((l) => l.startsWith("確認の状態: "));
  expect(行, "確認の状態の行が無い").toBeTruthy();
  for (const [語, n] of 期待) expect(行, `${語} の數が違ふ`).toContain(`${語} ${n} 行`);
  expect(行, "記録なしを数えて居ん").toContain(`確認の記録なし ${記録なし} 行`);
  /* 內部の狀態の名（`manual-required` など）は出さない（畫面と同じ語だけ）。 */
  expect(text, "內部の狀態の名を出して居る").not.toContain("manual-required");
  /* 會議ごとの內譯も言ふ（行ごとの札だけでは、其の會議の偏りが分からん）。 */
  const 題 = await call("venue_info", { key: "sigkdd", scope: "all" });
  expect(題, "會議ごとの確認が無い").toMatch(/確認: .+\d+ 行/);
});

it("窓の外にだけ在る締切を「無い」と言わない（第 869 回）", async () => {
  /* 畫面は窓の外の締切を「収録の全体を読み込む」で出せる（第 290 回）。MCP にも
   * `scope: "all"` があるのに、窓で 0 件の時に其の事を言はなかつた – 實測 2026-10-08:
   * 「2028年」は窓 0 行・収録の全体 12 行で、AI が「2028 年の締切は無い」と答へてしまふ。 */
  /* 窓（`public/catalog.json`）は建てた時だけ在る物なので、無い手元では此の檢査は空振りに
   * 成る（此の檔案の約束 – 配付物を持たない手元で落とさない）。窓が無い時は最初から収録の
   * 全體を見るので、此の案内は出ない（それで正しい）。 */
  const 品書 = join(REPO_ROOT, "public", "catalog.json");
  if (!existsSync(品書)) return;
  const snap = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as never;
  const 全行 = Recommender.candidateRows(snap);
  const 窓行 = Recommender.candidateRows(JSON.parse(readFileSync(品書, "utf8")) as never);
  const now = Date.now();
  /* 窓の果てより後の年を探す（収録の全體にだけ在る語）。 */
  const 最晚年 = Math.max(...全行.map((r) => new Date(r.t).getUTCFullYear()));
  const 語 = `${最晚年}年`;
  const 照合 = Recommender.searchMatcher(Recommender.expandRelativeMonths(語, now), now);
  expect(
    全行.filter((r) => 照合(r.hay) === true).length,
    "此の檢査の前提（収録の全体に当たる年）が崩れた",
  ).toBeGreaterThan(0);
  expect(
    窓行.filter((r) => 照合(r.hay) === true).length,
    `此の檢査の前提（窓の外の年）が崩れた: ${語}`,
  ).toBe(0);
  const text = await call("search_deadlines", { query: 語, limit: 1 });
  expect(text, "窓の外を「無い」と言つた").toContain("収録の全体には");
  expect(text, "scope: all を敎へて居ん").toContain('scope: "all"');
  /* `scope: "all"` で引けば、其の先の事（絞り込みで 0 件か）を言ふ。 */
  const 全 = await call("search_deadlines", { query: 語, scope: "all", limit: 1 });
  expect(全, "窓の外の案内を出し続けて居る").not.toContain("収録の全体には");
  /* 語を調べる道具でも同じ事を言ふ。 */
  const 語の = await call("explain_word", { word: 語 });
  expect(語の, "explain_word が窓の外を敎へて居ん").toContain("収録の全体には");
});

it("日数の幅は、同じ幅を引ける検索語に置き換へて敎へる（第 871 回）", async () => {
  /* 畫面は「1か月以内」を「『締切まで』の選擇欄で『30 日以内』を選ぶと同じ話です」と送る
   * （`dayRangeNoteJa`）が、**MCP に其の欄は無い**。實測 2026-10-08（窓 870 行）: `1か月以内` は
   * 0 件で案内も無く、同じ幅の `30日以内` は 90 件だつた – AI は「1 か月以内の締切は無い」と
   * 答へてしまふ。 */
  const text = await call("search_deadlines", { query: "1か月以内", scope: "all", limit: 1 });
  expect(text, "日数の幅を其の侭檢索語として扱つた").toContain(
    "日数の幅はそのままでは検索語に当たりません",
  );
  const m = /語を省いて `within_days: (\d+)` で引けます（([\d,]+) 件当たります）/.exec(text);
  expect(m, "同じ幅を引く引数を敎へて居ん").toBeTruthy();
  const 敎へた日數 = Number(m?.[1]);
  const 敎へた件數 = Number(String(m?.[2]).replace(/,/g, ""));
  expect(敎へた件數, "敎へた引数が 0 件（行き止まりへ送つた）").toBeGreaterThan(0);
  /* **敎へた引数で引くと、言つた件數と一致する**（其の侭打ち直せる – 第 762 回と同じ約束）。 */
  const 引いた = await call("search_deadlines", {
    within_days: 敎へた日數,
    scope: "all",
    limit: 1,
  });
  const 出た = Number(/絞り込みだけ: ([\d,]+) 件/.exec(引いた)?.[1]?.replace(/,/g, "") ?? -1);
  expect(出た, `敎へた件數と結果が違ふ: within_days ${敎へた日數}`).toBe(敎へた件數);
  /* 幅の終はりが書かれて居ない言ひ方（過去の幅）は、過去を出す引数を敎へる（行は作らない）。 */
  const 過去 = await call("search_deadlines", { query: "3日前まで", scope: "all", limit: 1 });
  expect(過去, "過去の幅に何も言はん").toContain("include_past: true");
  /* 語を調べる道具でも同じ事を言ふ（第 869 回の窓の外と同じ扱ひ）。 */
  const 語の = await call("explain_word", { word: "1か月以内", scope: "all" });
  expect(語の, "explain_word が同じ幅を敎へて居ん").toContain(`within_days: ${敎へた日數}`);
  /* 時間・分の幅は日で丸める（此の表は締切を日單位で持つ – 丸めた事を隱さない）。 */
  const 時間 = await call("search_deadlines", { query: "3時間以内", scope: "all", limit: 1 });
  expect(時間, "時間の幅に丸めた事を言はん").toContain("時間・分の幅は日で丸めます");
  /* 行が出る語には付けない（要らない斷りを増やさない）。 */
  const 有 = await call("search_deadlines", { query: "30日以内", scope: "all", limit: 1 });
  expect(有, "行が出る幅に斷りを付けた").not.toContain("日数の幅はそのままでは");
});

it("収録の果てより先の日付を「無い」と言はない（第 871 回）", async () => {
  /* 第 293 回の畫面と同じ決めごと – 幅の終はりが分からん物を「無い」と斷定しない。
   * 窓の外の案内（第 869 回）は**収録にその語の行が在る時**だけなので、収録の果てより先は
   * 依然として「この語では 1 行も出ません」とだけ返つて居た。 */
  const snap = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as never;
  const 全行 = Recommender.candidateRows(snap);
  /* 果ての數へ方は畫面と同じ（表示して居る暦日 = `tShown`。無ければ `t`。JST の暦日で出す）。 */
  let 一番遠い = Number.NEGATIVE_INFINITY;
  for (const r of 全行) {
    const s = typeof r.tShown === "number" && Number.isFinite(r.tShown) ? r.tShown : r.t;
    if (Number.isFinite(s) && s > 一番遠い) 一番遠い = s;
  }
  const d = new Date(一番遠い + 9 * 3600000);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const 果て = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  /* 果てより先で、**素の照合でも 0 行**の月を探す（前提を此の檢查の中で確かめる –
   * 會期の日付が果てより先に在る事があるので、年だけで決め打たない）。 */
  const now = Date.now();
  let 語 = "";
  for (let 年 = d.getUTCFullYear() + 1; 年 < d.getUTCFullYear() + 12 && !語; 年 += 1) {
    const 候補 = `${年}年${d.getUTCMonth() + 1}月`;
    const 照合 = Recommender.searchMatcher(Recommender.expandRelativeMonths(候補, now), now);
    if (全行.filter((r) => 照合(r.hay) === true).length === 0) 語 = 候補;
  }
  expect(語, "此の檢查の前提（収録の果てより先で 0 行の月）が崩れた").not.toBe("");
  const text = await call("search_deadlines", { query: 語, scope: "all", limit: 1 });
  expect(text, "果ての日を言つて居ん").toContain(`一番遠い締切 ${果て} より先です`);
  expect(text, "確かめて居ない事を言つて居ん").toContain("まだ確認できていません");
  expect(text, "「無い」と斷定した").not.toContain("この語では 1 行も出ません");
  /* 語を調べる道具でも同じ事を言ふ。 */
  const 語の = await call("explain_word", { word: 語, scope: "all" });
  expect(語の, "explain_word が果てを敎へて居ん").toContain(`一番遠い締切 ${果て} より先です`);
  /* 行が出る語には付けない。 */
  const 有 = await call("search_deadlines", { query: "ポスター", scope: "all", limit: 1 });
  expect(有, "行が出る語に果ての斷りを付けた").not.toContain("より先です");
});

/** 畫面（`app.js`）の窓の式を拔き出して、使へる形にする（第 872 回の突き合はせ用）。 */
function 畫面の窓(): {
  limit: (win: string, now: number) => number;
  floor: (win: string, now: number) => number;
} {
  const app = siteRuntime();
  const src = [
    jsFunction(app, "windowLimitMs"),
    jsFunction(app, "windowFloorMs"),
    "return { limit: windowLimitMs, floor: windowFloorMs };",
  ].join("\n");
  return new Function("DAY", vmSafeSource(src))(86400000) as {
    limit: (win: string, now: number) => number;
    floor: (win: string, now: number) => number;
  };
}

/** 瞬間を JST の暦日（`YYYY-MM-DD`）で書く。 */
function 日Ja(ms: number): string {
  const d = new Date(ms + 9 * 3600000);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

it("「締切まで N 日」の窓の式が、畫面と一致する（第 872 回）", () => {
  /* 畫面側の `windowLimitMs`・`windowFloorMs` は 10 本の檢查が拔き出して使ふので動かせない。
   * 同じ式を `site/recommender.ts` に置いた（MCP が同じ引數を持つ爲）ので、**値を突き合はせる** –
   * ずれると、同じ日に人が見る行と AI が言ふ行が違ふ（窓は JST の暦日で切る – 第 202 回）。 */
  const 畫面 = 畫面の窓();
  const 時 = [
    Date.parse("2026-10-08T14:59:59Z"), // JST の 0 時の直前
    Date.parse("2026-10-08T15:00:00Z"), // JST の 0 時ちょうど
    Date.parse("2026-10-09T14:59:59Z"), // JST の翌日 0 時の直前
    Date.parse("2026-12-31T16:30:00Z"),
    Date.parse("2027-02-28T23:59:00Z"),
    Date.parse("2028-02-29T00:00:00Z"), // 閏日
  ];
  for (const now of 時) {
    for (const 日 of [1, 7, 30, 90, 180, 365, 730]) {
      const 印 = new Date(now).toISOString();
      expect(Recommender.withinDaysLimitMs(日, now), `上限が違ふ: ${日} 日 / ${印}`).toBe(
        畫面.limit(`${日}d`, now),
      );
      expect(Recommender.withinDaysFloorMs(日, now), `下限が違ふ: ${日} 日 / ${印}`).toBe(
        畫面.floor(`${日}d`, now),
      );
    }
  }
});

it("within_days は、畫面の「締切まで N 日」と同じ行を返す（第 872 回）", async () => {
  /* 第 871 回までは、AI が日数の幅を言はれても檢索語（「30日以内」）で代はるしか無く、其れは
   * **締切の瞬間**で數へる別の物だつた（窓は JST の暦日で切る）。畫面の選擇欄と同じ引數を持つ。 */
  const snap = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as never;
  const 全行 = Recommender.candidateRows(snap);
  const 畫面 = 畫面の窓();
  /* 畫面の既定（今後・投稿締切の種別・推定を除く）と同じ土俵で數へる。 */
  const 期待 = (日: number, now: number, 過去も: boolean): number =>
    全行.filter((r) => {
      /* 過去も出す時は「今後の物だけ」の絞り込みが外れる（畫面と同じ）。過去かどうかは
       * `deadlineRowIsPast` で見る – 時刻未確認の行は「一番遅い可能性の日」で判定する
       * （第 917 回。`r.t < now` だと此方の數が画面より 1 件多くなる）。 */
      if (!過去も && Recommender.deadlineRowIsPast(r, now)) return false;
      if (r.est) return false;
      if (!["abstract", "paper", "journal"].includes(r.kind)) return false;
      const d = typeof r.tShown === "number" && Number.isFinite(r.tShown) ? r.tShown : r.t;
      if (d >= 畫面.limit(`${日}d`, now)) return false;
      if (過去も && d < 畫面.floor(`${日}d`, now)) return false;
      return true;
    }).length;
  const 件數を讀む = (text: string): number =>
    Number(/絞り込みだけ: ([\d,]+) 件/.exec(text)?.[1]?.replace(/,/g, "") ?? -1);

  /* 語を省いて、窓だけで引ける（第 793 回の「絞り込みだけ」の仲間に入れた）。 */
  const 前 = Date.now();
  const text = await call("search_deadlines", { within_days: 30, scope: "all", limit: 1 });
  const 後 = Date.now();
  expect(text, "語を省いて窓だけで引ける事を言つて居ん").toContain("語を指定せず、絞り込みだけ");
  expect(text, "窓を頭に書いて居ん").toContain("／締切まで 30 日");
  /* 數へ方は**呼び出しの前後**の時計で挾む（道具は自分の時計で數へるので、境目を跨いでも
   * 落ちない樣に – 其の幅の中で一致する事を見る）。 */
  const 幅 = [期待(30, 前, false), 期待(30, 後, false)].sort((a, b) => a - b);
  const 出た = 件數を讀む(text);
  expect(出た, `畫面の式と違ふ（${幅[0]}〜${幅[1]} の筈）`).toBeGreaterThanOrEqual(幅[0]);
  expect(出た, `畫面の式と違ふ（${幅[0]}〜${幅[1]} の筈）`).toBeLessThanOrEqual(幅[1]);

  /* 過去も出す時は下側も効く（第 202 回 – 上側だけだと 2019 年まで殘り、窓が意味を失ふ）。 */
  const 前2 = Date.now();
  const 過去 = await call("search_deadlines", {
    within_days: 7,
    include_past: true,
    scope: "all",
    limit: 100,
  });
  const 後2 = Date.now();
  const 幅2 = [期待(7, 前2, true), 期待(7, 後2, true)].sort((a, b) => a - b);
  const 出た2 = 件數を讀む(過去);
  expect(出た2, `過去込みの數が畫面の式と違ふ（${幅2[0]}〜${幅2[1]} の筈）`).toBeGreaterThanOrEqual(
    幅2[0],
  );
  expect(出た2, `過去込みの數が畫面の式と違ふ（${幅2[0]}〜${幅2[1]} の筈）`).toBeLessThanOrEqual(
    幅2[1],
  );
  /* 返つた行の日を讀んで、窓の中だけである事を見る（數だけ合つて中身が違ふ、を止める）。
   * 上限は「翌日の開始」なので、窓に入る最後の日は其の前日。 */
  const 下限日 = 日Ja(畫面.floor("7d", 前2));
  const 上限日 = 日Ja(畫面.limit("7d", 前2) - 86400000);
  const 日々 = 過去
    .split("\n")
    .filter((l) => /^\d{4}-\d{2}-\d{2}/.test(l))
    .map((l) => l.slice(0, 10));
  expect(日々.length, "行が 1 本も無い（此の檢查の前提が崩れた）").toBeGreaterThan(0);
  for (const 日 of 日々) {
    expect(日 >= 下限日 && 日 <= 上限日, `窓の外の行を返した: ${日}（${下限日}〜${上限日}）`).toBe(
      true,
    );
  }
  /* 窓は語と一緒にも使へる（絞り込みの一つとして効く）。 */
  const 語と = await call("search_deadlines", {
    query: "セキュリティ",
    within_days: 30,
    scope: "all",
  });
  expect(語と, "語と窓の併用が効いて居ん").toContain("／締切まで 30 日");
});

it("欄の名前を打たれたら、値で打ち直す案内を返す（第 873 回）", async () => {
  /* 畫面は「『分野』はこの表の欄の名前で、値その物ではありません。値で打ってください（例: …）」
   * と送る（第 244 回）が、MCP は其れを言はず、窓の外の案内と名乘りだけを返して居た –
   * AI は「『分野』に當たる行が 5 件あります」と答へてしまふ（實測 2026-10-09: 窓 0 行・
   * 收錄 5 行。其の 5 行は會議の説明文に「分野」の語が在るだけで、欄の名前を探した物ではない）。 */
  const text = await call("search_deadlines", { query: "種別", scope: "all", limit: 1 });
  expect(text, "欄の名前だと言つて居ん").toContain("この表の欄の名前で、値その物ではありません");
  expect(text, "値の例を名指して居ん").toContain("論文締切");
  /* **案内の例で打つと行が出る**（行き止まりへ送つて居ない）。 */
  const 値 = await call("search_deadlines", { query: "論文締切", scope: "all", limit: 1 });
  expect(値, "案内の例で行が出ん").toMatch(/に当たる締切: [1-9]\d* 件/);
  /* 行が出る語には付けない（要らない斷りを増やさない）。 */
  const 有 = await call("search_deadlines", { query: "締切", scope: "all", limit: 1 });
  expect(有, "行が出る語に欄の案内を付けた").not.toContain("欄の名前で");
  /* 語を調べる道具でも同じ事を言ふ（第 869 回の窓の外と同じ扱ひ）。 */
  const 語の = await call("explain_word", { word: "参加形式", scope: "all" });
  expect(語の, "explain_word が欄の名前を敎へて居ん").toContain("欄の名前で");
});

it("「と」「や」で繋いだ打ち方に、どちらかだけで打つ案内を返す（第 873 回）", async () => {
  /* 畫面は「『A』を書く行は N 件、『B』を書く行は M 件ありますが、『と』で繋いで打つと兩方を含む
   * 行を探すため 0 件に成ります。どちらかだけで打つてください」と言ふ（第 612 回）。MCP は
   * 「打ち直すなら」しか返して居なかつた – 語に割れるので、どちらが足りんのかが讀めん。 */
  const snap = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as never;
  const 全行 = Recommender.candidateRows(snap);
  const now = Date.now();
  const 素 = (語: string): number => {
    const m = Recommender.searchMatcher(Recommender.expandRelativeMonths(語, now), now);
    return 全行.filter((r) => m(r.hay) === true).length;
  };
  const text = await call("search_deadlines", {
    query: "ネットワークとセキュリティ",
    scope: "all",
    limit: 1,
  });
  expect(text, "繋いだ打ち方だと言つて居ん").toContain(
    "「と」で繋いで打つと両方を含む行を探すため",
  );
  expect(text, "どちらかだけで打つ樣に言つて居ん").toContain("どちらかだけで打ってください");
  /* **言つた件數は、收錄の行を同じ照合で數へた物と一致する**（畫面と同じ數字）。 */
  const m = /「ネットワーク」を書く行は ([\d,]+) 件/.exec(text);
  expect(m, "片方の件数を言つて居ん").toBeTruthy();
  expect(Number(String(m?.[1]).replace(/,/g, "")), "件數が收錄と違ふ").toBe(素("ネットワーク"));
  const m2 = /「セキュリティ」を書く行は ([\d,]+) 件/.exec(text);
  expect(Number(String(m2?.[1]).replace(/,/g, "")), "件數が收錄と違ふ").toBe(素("セキュリティ"));
  /* 片方だけで打てば行が出る（案内が行き止まりへ送つて居ない）。 */
  const 片 = await call("search_deadlines", { query: "セキュリティ", scope: "all", limit: 1 });
  expect(片, "片方だけで行が出ん").toMatch(/に当たる締切: [1-9]\d* 件/);
  /* 兩方を含む行が在る打ち方には付けない（行が出るので案内は立たない）。 */
  const 兩方 = await call("search_deadlines", {
    query: "AIとセキュリティ",
    scope: "all",
    limit: 1,
  });
  expect(兩方, "行が出る打ち方に斷りを付けた").not.toContain("繋いで打つと");
  /* 欄の名前の案内が立つ時は重ねない（畫面と同じ順 – 同じ事を二度言はない）。 */
  const 欄と = await call("search_deadlines", { query: "締切と会場", scope: "all", limit: 1 });
  /* 欄の名前に別名が在る語は「欄（開催地）の名前で」と書く（畫面と同じ語）。 */
  expect(欄と, "欄の名前の案内を出して居ん").toContain("の名前で、値その物ではありません");
  expect(欄と, "欄の名前と接続の案内を重ねた").not.toContain("繋いで打つと");
});

it("list_upcoming と search_deadlines は、同じ條件なら同じ件数を返す（第 874 回）", async () => {
  /* 同じ「N 日以内」の問に、二つの道具が違ふ數を返して居た – `list_upcoming` の上は
   * **經由 24 時間**で切つて居たため（窓は JST の暦日で切る – 第 202 回）。實測 2026-10-10
   * （窓・論文のみ）: 7 日で 16 件／19 件、90 日で 134 件／128 件。今は同じ式を持つ。
   * 殘る違いは**推定の締切**（`search_deadlines` の既定は外す・`list_upcoming` は入れる）
   * だけなので、其れを揃へて比べる。 */
  const 一覽の件數 = (text: string): number => Number(/(\d+) 件/.exec(text)?.[1] ?? -1);
  const 檢索の件數 = (text: string): number =>
    Number(/絞り込みだけ: ([\d,]+) 件/.exec(text)?.[1]?.replace(/,/g, "") ?? -1);
  for (const 日 of [7, 30, 90]) {
    const 一覽 = await call("list_upcoming", { days: 日, kind: "paper", scope: "screen" });
    const 檢索 = await call("search_deadlines", {
      within_days: 日,
      kinds: ["paper"],
      include_estimated: true,
      scope: "screen",
      limit: 1,
    });
    const 求 = 一覽の件數(一覽);
    expect(求, `list_upcoming の件數が讀めない: ${日} 日`).toBeGreaterThan(0);
    expect(檢索の件數(檢索), `${日} 日で二つの道具の數が違ふ`).toBe(求);
  }
  /* 片方に推定が入つて居る事を、道具の説明で隱さない（ extrapolated を默つて外すと
   * 「數が違ふ」に成る）。 */
  const 說明 = String(
    (
      (await client.ask({ jsonrpc: "2.0", id: 99, method: "tools/list" })) as {
        result?: { tools?: Array<{ name?: string; description?: string }> };
      }
    ).result?.tools?.find((t) => t.name === "list_upcoming")?.description ?? "",
  );
  expect(說明, "推定の取扱ひを說明して居ん").toContain("推定");
});

it("名簿の案内が、畫面と同じ規則で名を探す（第 875 回）", async () => {
  /* 「X 2027」の樣に**年を添えて**打つと、MCP は名前にその年を要求して居て 0 件・無言だつた
   * （實測 2026-10-11: `ACSAC 2027` は收錄 0 行・案内も無し。人は「ACSAC 2027 の締切は？」と
   * 譯に「無い」と受け取る）。畫面は**數字と日付の部品だけの語を名前の語から外す**（第 296 回）
   * ので、「打った語に似た名前の会議（ACSAC）は、収録の名簿に見えます」と言ふ。
   * 畫面の函數は 10 本の檢查が拔き出して使ふので動かせない – 拔き出した畫面の函數と
   * **突き合はせる**（第 872 回の窓の式と同じやり方）。 */
  const 品書 = join(REPO_ROOT, "public", "catalog.json");
  if (!existsSync(品書)) return; // 畫面側の名簿は建てた時だけ在る（此の檔案の約束）。
  const 品書の會議 = (
    JSON.parse(readFileSync(品書, "utf8")) as { conferences?: unknown[] }
  ).conferences?.filter((c) => c && typeof c === "object" && !Array.isArray(c));
  expect(品書の會議?.length, "此の檢查の前提（品書の名簿）が崩れた").toBeGreaterThan(0);
  const 拔く = jsFunction(siteRuntime(), "nameOnlyConferenceMatch");
  const 畫面 = new Function(
    "DATA",
    "Recommender",
    vmSafeSource(`${拔く}\nreturn nameOnlyConferenceMatch;`),
  )({ conferences: 品書の會議 }, Recommender) as (
    q: string,
    rows: unknown[],
    now: number,
  ) => { count: number; terms: string[] } | null;
  /* 意圖的に混ぜる – 年に年が在る物・在らん物・日本語の名前・英字の短い略稱。 */
  for (const 語 of ["ACSAC 2027", "CoNLL 2027", "NSDI 2028", "apnoms", "情報処理学会 HPC 研究会"]) {
    const 見 = 畫面(語, [], Date.now());
    if (!見 || (!見.count && !見.terms.length)) continue; // 畫面も默る問は比べる意味が無い
    /* 既定の窓（畫面と同じ）で引く – 收錄にまで行が在る問（`CoNLL 2027` は收錄 1 行）は
     * MCP が行を返して默るので、比べるのは畫面と同じ窓。 */
    const text = await call("search_deadlines", { query: 語, limit: 1 });
    const 會議を名指した = text.includes("収録の会議の名前には");
    const 語を名指した = text.includes("名簿に、その語に似た名前の会議は在ります");
    /* 畫面が**會議を 1 件に定めた**時は、MCP も會議を名指さねばならん（狀態を添へる方が
     * 役に立つ – 「締切の行が 1 本もありません」「絞り込みを外すと出ます」は會議の話に付く）。
     * 畫面が語だけを見付けた時は、語を名指すので足りる。 */
    expect(
      見.count > 0 ? 會議を名指した : 語を名指した || 會議を名指した,
      `「${語}」は畫面が名簿を名指す（count ${見.count}・語 ${見.terms.join("・")}）のに、MCP は同し事を言つて居ない`,
    ).toBe(true);
  }
  /* 英字の語は名前の中で**獨立に立つ**事を要求する（畫面と同じ – `st` は多くの名前に
   * 部分として含まるが、どれにも立たない）。部分一致に戻すと、名前にその語を含むだけの
   * 會議を「名簿に在る」と言之てしまふ。 */
  /* 前提を此の方で確かめる – `st` は名前に部分として含まるが、どれにも**語として立たん**。 */
  const 殻 = (品書の會議 ?? []).map((c) =>
    `${String((c as { acronym?: unknown }).acronym ?? "")} ${String((c as { title?: unknown }).title ?? "")} ${String((c as { full_name?: unknown }).full_name ?? "")} ${String((c as { key?: unknown }).key ?? "")}`.toLowerCase(),
  );
  expect(
    殻.some((h) => /(^|[^a-z0-9])st([^a-z0-9]|$)/u.test(h)),
    "此の檢查の前提（`st` がどこにも立たん）が崩れた",
  ).toBe(false);
  const 部分 = await call("search_deadlines", { query: "st", scope: "all", limit: 1 });
  expect(部分, "部分一致の語を名簿の名指しに使つた").not.toContain("収録の会議の名前には");
  expect(部分, "部分一致の語を名簿の名指しに使つた").not.toContain(
    "名簿に、その語に似た名前の会議は在ります",
  );
  /* 畫面も默る問には、MCP も名簿の話を立てない（行が出るのであれば、どちらも默る）。 */
  const 默る = 畫面("zzzznotaconference", [], Date.now());
  expect(默る, "此の檢查の前提（畫面が默る問）が崩れた").toBeNull();
  const 默る答 = await call("search_deadlines", {
    query: "zzzznotaconference",
    scope: "all",
    limit: 1,
  });
  expect(默る答, "畫面が默る問に名簿の話を立てた").not.toContain("収録の会議の名前には");
});

it("key で問はれた時は、其の会議の事を言ふ（第 876 回）", async () => {
  /* 實測 2026-10-12: `venue_info({key: "sc", scope: "screen"})`（窓に行が無い）が、
   * **全く別の会議**（jornadas-dl2）を「その会議は収録に在りますが…」と返して居た。key を
   * 受けた時に名が空の儘名前で名簿を探すと、`title.includes("")` がどれにも當たつて
   * **先頭の会議**を拾ふため。AI は「その会議の締切は無い」と問はた會議の事として言つてしまふ。 */
  const text = await call("venue_info", { key: "sc", scope: "screen" });
  expect(text, "問はた會議を名指して居ん").toContain("key: sc");
  expect(text, "別の會議の事を言つた").not.toContain("jornadas");
  expect(text, "問はた會議の名を出して居ん").toContain("SC");
  /* 大文字の key も受け付ける（照合は畫面と同じ）。 */
  const 大 = await call("venue_info", { key: "SC", scope: "screen" });
  expect(大, "大文字の key を別の會議と取り違へた").toContain("key: sc");
  expect(大).not.toContain("jornadas");
  /* 收錄に無い key は「無い」と言ふ（第 866 回 – 別の會議を渡さない）。 */
  const 無 = await call("venue_info", { key: "nosuchconfkey", scope: "screen" });
  expect(無, "收錄に無い時に別の會議を返した").toContain("その会議");
  /* 名の一部で問はれた時は候補を並べる（一つに決め打たない – 第 726 回の儘）。 */
  const 名 = await call("venue_info", { name: "sc", scope: "screen" });
  expect(名, "名の一部で候補を並べて居ん").toContain("会議が当たりました");
});

it("使へない數の引數は默つて既定に戻さない（第 878 回）", async () => {
  /* 實測 2026-10-13: `search_deadlines({within_days: 0})` は窓が掛からず 214 件を返して居た
   * –「0 日以内」の問に 214 件と答へる形で、**其の値が無視された事をどこにも書いて居なかつた**
   * （`list_upcoming({days: "abc"})` も默つて既定の 30 日に戻る）。知らない種別（第 727 回）・
   * 知らないランク（第 858 回）を頭で名指すのと同じ扱ひにした。 */
  const 檢索 = await call("search_deadlines", { query: "セキュリティ", within_days: 0 });
  expect(檢索, "使ひ切れない値を默つた").toContain("within_days は 1 以上の数で指定してください");
  expect(檢索, "其の值を使つた事にして居る").toContain("其の值は使はないので、既定の儘引きます");
  expect(檢索, "窓を書いた").not.toContain("／締切まで");
  /* 負の値・數でない値も（`Number("abc")` は NaN になる）。 */
  const 負 = await call("search_deadlines", { query: "セキュリティ", within_days: -5 });
  expect(負, "負の値を默つた").toContain("within_days は 1 以上の数で指定してください");
  const 文字 = await call("search_deadlines", { query: "セキュリティ", within_days: "三" });
  expect(文字, "數でない値を默つた").toContain("within_days は 1 以上の数で指定してください");
  /* 使へる値は其の儘通す（斷りを付けない）。 */
  const 使へる = await call("search_deadlines", { query: "セキュリティ", within_days: 30 });
  expect(使へる, "使へる値に斷りを付けた").not.toContain("1 以上の数で指定してください");
  expect(使へる, "窓を書いて居ん").toContain("／締切まで 30 日");
  /* 他の數の引數も同じ（`limit`・`days`）。 */
  const 件數 = await call("search_deadlines", { query: "ai", limit: 0 });
  expect(件數, "limit を默つた").toContain("limit は 1 以上の数で指定してください");
  const 一覽 = await call("list_upcoming", { days: "abc" });
  expect(一覽, "days を默つた").toContain("days は 1 以上の数で指定してください");
  expect(一覽, "既定で讀んだ事を書いて居ん").toContain("30 日（既定）");
  /* 省略された時は何も言はない（既定を使つた事を毎回書かない）。 */
  const 省いた = await call("list_upcoming", {});
  expect(省いた, "省いた時に斷りを付けた").not.toContain("1 以上の数で指定してください");
  expect(省いた, "省略時に既定の表示に變はつた").toContain("30 日以内");
  /* 推薦の `limit` も同じ。 */
  const 推薦 = await call("recommend_venues", {
    paper: "Low-Latency Networking | network",
    limit: 0,
  });
  expect(推薦, "推薦の limit を默つた").toContain("limit は 1 以上の数で指定してください");
});

it("表に出さん種別の語は、選び方を件數つきで敿へる（第 879 回）", async () => {
  /* 畫面は「検索語は『採否通知』の種別に當たります（表には投稿締切だけを出します）」と言ふ
   * （第 244 回）。MCP は「既定の絞り込みで 0 件。include_past / include_estimated / kinds を
   * 試して」とだけで、**其の種別が收錄に在る事**を言つて居なかつた – 實測 2026-10-14:
   * `カメラレディ` は 70 行當たるのに、AI は「カメラレディの締切は無い」と受け取りかねない。 */
  for (const [語, 種別] of [
    ["採否通知", "notification"],
    ["カメラレディ", "camera_ready"],
    ["査読結果", "review_release"],
    ["登録締切", "registration"],
  ] as const) {
    const text = await call("search_deadlines", { query: 語 });
    expect(text, `「${語}」に種別の話が無い`).toContain("の種別に当たります");
    expect(text, `「${語}」が表の既定を言つて居ん`).toContain("表には投稿締切だけを出します");
    const m = new RegExp(`kinds: \\[\\"${種別}\\"\\] で引けます（([\\d,]+) 件当たります）`).exec(
      text,
    );
    expect(m, `「${語}」に選び方が書かれて居ん`).toBeTruthy();
    /* **敎へた件數は、其の指定で實際に引いた結果と一致する**（第 762 回と同じ約束）。 */
    const 敎へた = Number(String(m?.[1]).replace(/,/g, ""));
    expect(敎へた, `「${語}」の件數が讀めない`).toBeGreaterThan(0);
    const 引いた = await call("search_deadlines", { query: 語, kinds: [種別] });
    const 出た = Number(/に当たる締切: ([\d,]+) 件/.exec(引いた)?.[1]?.replace(/,/g, "") ?? -1);
    expect(出た, `「${語}」の件數が實際と違ふ: ${敎へた} ≠ ${出た}`).toBe(敎へた);
  }
  /* 投稿締切の種別を打つた人には付けない（其の種別は既定で出る）。 */
  const 論文 = await call("search_deadlines", { query: "論文締切" });
  expect(論文, "投稿締切に種別の話を付けた").not.toContain("の種別に当たります");
  /* 畫面が默る問（どの種別の語でも無い）にも付けない。 */
  const 默る = await call("search_deadlines", { query: "インターネット" });
  const 默る數 = /に當たる締切: ([\d,]+) 件/.exec(默る);
  if (默る數 && Number(默る數[1]) > 0)
    expect(默る, "行が出る問に種別の話を付けた").not.toContain("の種別に当たります");
});

it("語を並べて打つた時、收錄に無い語を名指す（第 880 回）", async () => {
  /* 畫面は「検索語のうち『GPU』は収録データにも見当たりません。その語を外すと増えます」と
   * 言ふ（第 258 回）。MCP は「打ち直すなら『ネットワーク』だけに絞る（20 件）」とだけで、
   * **收錄が其の語を一つも持たん事**が讀めなかつた。實測 2026-10-15: `ネットワーク GPU` は
   * GPU が窓 0 行・收錄 0 行。 */
  const text = await call("search_deadlines", { query: "ネットワーク GPU" });
  expect(text, "收錄に無い語を名指して居ん").toContain("は収録データにも見当たりません");
  expect(text, "外すと増える事を言つて居ん").toContain("その語を外すと増えます");
  /* 語ごとの件數も、畫面と同じ正典（`queryTermCounts`）で數へた物と一致する。 */
  const 窓 = Recommender.candidateRows(
    JSON.parse(readFileSync(join(REPO_ROOT, "public", "catalog.json"), "utf8")) as never,
  ) as Array<{ hay: string }>;
  const now = Date.now();
  const 件數 = Recommender.queryTermCounts(
    Recommender.expandRelativeMonths("ネットワーク GPU", now),
    窓.map((r) => r.hay),
    now,
  );
  const 死んだ語 = 件數.filter((t) => t.count === 0).map((t) => t.term);
  expect(死んだ語.length, "此の檢查の前提（死語が在る問）が崩れた").toBeGreaterThan(0);
  expect(text, `死語の名が違ふ: ${死んだ語.join("・")}`).toContain(`「${死んだ語[0]}」`);
  /* どれも收錄に在るのに「全部を含む行」が無い時 – 語ごとの件數を並べて、どれを外すか選ばせる。 */
  const 兩方 = await call("search_deadlines", { query: "セキュリティ 福岡" });
  expect(兩方, "死語としてゐない問に死語の話をした").not.toContain("見当たりません");
  expect(兩方, "語ごとの件數を書いて居ん").toContain("語をすべて含む行はありません");
  expect(兩方, "福岡の件數が書かれて居ん").toContain("「福岡」");
  /* 語が一つの時は他の家（打ち直し・種別の話）に讓る（重ねて二度言はない）。 */
  const 一つ = await call("search_deadlines", { query: "閏年" });
  expect(一つ, "語が一つの問に語ごとの話を付けた").not.toContain("語をすべて含む行はありません");
});

it("URL を貼つた人を、ドメインの部品の話に引きずり込まない（第 881 回）", async () => {
  /* 畫面は第 153 回から、URL を貼つた人に**打つた文字列を「語が無い」と言はない**
   * （分解された語はドメインの一部で、檢索の失敗理由では無い）。實測 2026-10-16:
   * `https://icde2027.example.org/cfp` に MCP は「『example』は収録データにも見当たりません」
   * 「名簿に『cfp』に似た名前の会議が在ります」と出して居た – 兩方とも部品の話。 */
  const text = await call("search_deadlines", { query: "https://icde2027.example.org/cfp" });
  expect(text, "收錄の中心を言つて居ん").toContain("検索語の URL の会議は収録に見当たりません");
  expect(text, "會議名で試す事を言つて居ん").toContain("会議名（「ICDE」など）で試してください");
  expect(text, "ドメインの部品を語として扱つた").not.toContain("「example」");
  expect(text, "ドメインの部品を會議の名として扱つた").not.toContain("「cfp」に似た名前");
  /* http が無い形（ドメインだけ）も受ける。 */
  const ドメイン = await call("search_deadlines", { query: "icde2027.example.org" });
  expect(ドメイン, "ドメインだけの形に URL の話をして居ん").toContain(
    "検索語の URL の会議は収録に見当たりません",
  );
  expect(ドメイン).not.toContain("「example」");
  /* 會議の URL が收錄に在る時は、默つて行を返す（畫面と同じ – 0 件の時にだけ立てる）。 */
  const 在る = await call("search_deadlines", { query: "https://www.sigcomm.org/" });
  expect(在る).toContain("検索語");
  /* 通常の語には効かない（URL の話を出さん）。 */
  const 通常 = await call("search_deadlines", { query: "ネットワーク GPU" });
  expect(通常, "URL でない問に URL の話を付けた").not.toContain("検索語の URL の会議は");
  expect(通常, "死語の話が恢復して居らん").toContain("「gpu」");
});

it("畫面のてびきが、MCP の全ての道具を名指す（第 882 回）", async () => {
  /* てびきは「締切の検索・直近の一覧・会議ごとの版・語の案内の四つ」と書いた儘で、
   * **collection_stats（第 769 回）と recommend_venues（第 857 回）を言つて居なかつた** –
   * 實測 2026-10-17。道具を增すたびに古くなる文は、數を書かずに**一つづつ名指す**形にして、
   * 此の檢查で張る（新增の道具が默つた儘に成らない）。 */
  const 頁 = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const 段 = ((): string => {
    const i = 頁.indexOf("AI に聞く");
    expect(i, "てびきに「AI に聞く」の段が無い").toBeGreaterThan(0);
    return 頁.slice(i, 頁.indexOf("</dd>", i));
  })();
  const 道具の言ひ方: Record<string, string> = {
    search_deadlines: "締切の検索",
    list_upcoming: "直近の一覧",
    venue_info: "会議ごとの版",
    explain_word: "語の案内",
    collection_stats: "収録の数",
    recommend_venues: "論文に合う投稿先",
  };
  /* 實装が持つ道具の一覽（`tools/list`）と、てびきが名指す文を突き合はせる。 */
  const res = (await client.ask({ jsonrpc: "2.0", id: 98, method: "tools/list" })) as {
    result?: { tools?: Array<{ name?: string }> };
  };
  const 名々 = (res.result?.tools ?? []).map((t) => String(t.name ?? "")).sort();
  expect(名々.length, "此の檢查の前提（道具の一覽）が崩れた").toBeGreaterThan(0);
  for (const 名 of 名々) {
    const 言ひ方 = 道具の言ひ方[名];
    expect(言ひ方, `てびきの文を決めて居ない道具が增えた: ${名}（此の表に足す事）`).toBeTruthy();
    expect(段, `てびきが ${名}（${言ひ方}）を名指して居ん`).toContain(言ひ方);
  }
  /* 雙方の樣に數も變へた（「四つ」が殘つて居ると讀む人が古い數を信じる）。 */
  expect(段, "てびきが「四つ」の儘").not.toContain("の四つ）");
});

it("道具の説明と索引の例に、データ依存の件數を書かない（第 883 回）", async () => {
  /* 說明の例に「44 件當たります」と書くと、讀む AI は其の數字を其の儘答へに使ひかねない
   * – データは每日變はる。實測 2026-10-17: `search_deadlines` の說明に「88 件」「44 件」
   * 「76 件」「154 件」、一番遠い締切の例に「2028-06-05」が固めてあつた。**實際に數へる事は
   * 返り値が請け合ふ**（第 762 回）ので、説明が持つべきは形だけ。 */
  const res = (await client.ask({ jsonrpc: "2.0", id: 97, method: "tools/list" })) as {
    result?: { tools?: Array<{ name?: string; description?: string }> };
  };
  const 檢索 = String(
    res.result?.tools?.find((t) => t.name === "search_deadlines")?.description ?? "",
  );
  expect(檢索, "search_deadlines の說明が讀めない").toContain("語を省いて");
  const データ依存の例: Array<[string, RegExp]> = [
    ["件數の例（N 件にして居る）", /\d+ 件当たります/u],
    ["語ごとの件數の例", /を書く行は \d+ 件/u],
    ["一番遠い締切の例", /一番遠い締切 \d{4}-\d{2}-\d{2}/u],
  ];
  for (const [名, 形] of データ依存の例)
    expect(形.test(檢索), `${名}を固めた數で書いて居る（N 件にする事）`).toBe(false);
  /* 形は殘つて居る（例を消して「件數つき」と言ふだけにしては、AI がどう書くか分からん）。 */
  expect(檢索, "件數を添へる形を書いて居ん").toContain("N 件当たります");
  /* 索引（建てた `llms.txt`）の MCP の節も同じ（此方が持つ實測の數は、建てた時に數へた物
   * なので正しい – 見るのは**例**の文だけ）。 */
  const 索引 = readFileSync(join(site, "llms.txt"), "utf8");
  const 節 = 索引.slice(索引.indexOf("## AI から引く（MCP）"));
  expect(節, "索引に AI の節が無い").toContain("MCP");
  for (const [名, 形] of データ依存の例)
    expect(形.test(節), `索引の${名}を固めた數で書いて居る`).toBe(false);
  expect(節, "索引の例の形が消えて居る").toContain("N 件当たります");
});

/** 畫面（`app.js`）の 0 件案內を、最小の材料で拔き出して走らせる（第 884 回の突き合はせ）。 */
function 畫面の受皿(query: string): string {
  const app = siteRuntime();
  const s = app;
  const i = s.indexOf("function emptyDeadlineHint");
  if (i < 0) return "";
  let d = 0;
  let k = s.indexOf("{", i);
  while (true) {
    if (s[k] === "{") d += 1;
    else if (s[k] === "}") {
      d -= 1;
      if (d === 0) break;
    }
    k += 1;
  }
  const countJa = (n: number): string => n.toLocaleString("ja-JP");
  const fn = new Function(
    "Recommender",
    "countJa",
    `${s.slice(i, k + 1)}\nreturn emptyDeadlineHint;`,
  )(Recommender, countJa) as (f: Record<string, unknown>) => string;
  const 品書 = JSON.parse(readFileSync(join(REPO_ROOT, "public", "catalog.json"), "utf8")) as {
    categories?: Record<string, string>;
    conferences?: unknown[];
  };
  const rows = Recommender.candidateRows(品書 as never) as Array<{ hay: string }>;
  return fn({
    window: "all",
    past: false,
    cats: 0,
    domestic: false,
    online: false,
    rank: "",
    kind: "",
    est: false,
    hidden: {},
    hiddenKindWords: [],
    urlQuery: Recommender.looksLikeUrlQuery(query),
    query,
    termCounts: Recommender.queryTermCounts(
      query,
      rows.map((r) => r.hay),
      Date.now(),
    ),
    catalogConferences: rows.length,
    clearable: true,
    pastShown: false,
    loadedLastDay: "",
    recordLastDay: "",
    horizonDays: 0,
    nameOnly: null,
    categoryNames: Object.keys(品書.categories ?? {})
      .sort((a, b) => {
        const la = Recommender.categoryChipLabelJa(a, String(品書.categories?.[a] || ""));
        const lb = Recommender.categoryChipLabelJa(b, String(品書.categories?.[b] || ""));
        return la.localeCompare(lb, "ja") || a.localeCompare(b);
      })
      .map((k) => Recommender.categoryChipLabelJa(k, String(品書.categories?.[k] || ""))),
    queryMatch: { catalog: 0, journal: 0 },
  });
}

it("どの案内にも當たらなかつた問に、此の表が何を出す画面なのかを言ふ（第 884 回）", async () => {
  /* 畫面は「別の語で試す」の受皿に、①此の表が何を出す画面なのか（催し物の名前・締切の日・
   * 分野・種別・開催地・參加形式 – 第 240 回）、②**分野の欄が何を幾つ持つか**（第 679 回 –
   * `脳科學` の樣な情報處理の九分野外の語でも空振りさせない爲に名前を並べる）を置く。
   * MCP は默つて居た – 實測 2026-10-18: `脳科学` は見出しと古さの斷りしか返さかつた。 */
  const text = await call("search_deadlines", { query: "脳科学" });
  expect(text, "此の表が何を出す畫面なのかを言つて居ん").toContain(
    "この表が出すのは催し物の名前・締切の日・分野・種別・開催地・参加形式で",
  );
  expect(text, "他の語で試す事を言つて居ん").toContain(
    "別の語で試す（分野名・主題・開催地の日本語でも引けます）",
  );
  /* 分野の名は**品書が持つ地圖**から、畫面のと同じ順・同じ札で（固定の一覽を書くと
   * 增えた分野が落ちる – 第 679 回）。 */
  const 品書 = JSON.parse(readFileSync(join(REPO_ROOT, "public", "catalog.json"), "utf8")) as {
    categories?: Record<string, string>;
  };
  const 地圖 = 品書.categories ?? {};
  const 期待 = Object.keys(地圖)
    .sort((a, b) => {
      const la = Recommender.categoryChipLabelJa(a, String(地圖[a] || ""));
      const lb = Recommender.categoryChipLabelJa(b, String(地圖[b] || ""));
      return la.localeCompare(lb, "ja") || a.localeCompare(b);
    })
    .map((k) => Recommender.categoryChipLabelJa(k, String(地圖[k] || "")));
  expect(期待.length, "此の檢查の前提（品書の分野）が崩れた").toBeGreaterThan(0);
  expect(text, `分野の欄が畫面と同じ言ひ方でない: ${期待.join("・")}`).toContain(
    `分野の欄は${期待.join("・")}の${期待.length}種だけで`,
  );
  /* 畫面の文と突き合はせる（拔き出した `emptyDeadlineHint` に同じ問を通す）。 */
  const 畫面の文 = 畫面の受皿("脳科学");
  if (畫面の文) {
    /* 兩方に「この表が出すのは」が在る事まで（文言は畫面が正本）。 */
    expect(畫面の文, "畫面の文が變はつた（此の檢查を見直す）").toContain(
      "この表が出すのは催し物の名前",
    );
  }
  /* 他の案内が立つ問には重ねない（二度言はない – 第 530 回と同じ決めごと）。 */
  for (const 問 of ["ネットワーク GPU", "セキュリティ 福岡", "カメラレディ", "採否通知"]) {
    const 答 = await call("search_deadlines", { query: 問 });
    expect(
      答.includes("この表が出すのは") &&
        !答.includes("見当たりません") &&
        !答.includes("種別に当たります"),
      `「${問}」に受皿を重ねた`,
    ).toBe(false);
  }
  /* 「打ち直すなら」が立つ時も讓る。 */
  const 打ち直し = await call("search_deadlines", { query: "参加費が高い" });
  if (打ち直し.includes("打ち直すなら"))
    expect(打ち直し, "打ち直しが立つのに受皿を重ねた").not.toContain("この表が出すのは");
  /* 總當たり – 0 件になる問を片つて引いて、**受皿が他の案内と重ならない事**を見る
   * （第 530 回と同じ決めごと。重ねると「どうすれば良い」が讀めなく成る）。 */
  const 問ひ = [
    "脳科学",
    "ケルビン",
    "閏年",
    "あ Healthcare",
    "ネットワーク GPU",
    "セキュリティ 福岡",
    "カメラレディ",
    "採否通知",
    "登録締切",
    "分野",
    "種別",
    "会場",
    "締め切り",
    "使い方",
    "書き出し",
    "購読",
    "ネットワークとセキュリティ",
    "1か月以内",
    "3日前まで",
    "2029年3月",
    "2028年9月",
    "ACSAC 2027",
    "apnoms",
    "情報処理学会 HPC 研究会",
    "https://icde2027.example.org/cfp",
    "zzzznotaword",
    "参加費が高い",
  ];
  const 他の案内の印 = [
    "の種別に当たります",
    "欄の名前で",
    "はこの表が持つ欄の名前ではありません",
    "見当たりません",
    "語をすべて含む行はありません",
    "収録の全体には",
    "より先です",
    "収録の会議の名前には",
    "名簿に、その語に似た名前の会議",
    "検索語の URL の会議は",
    "within_days",
    "include_past",
  ];
  for (const q of 問ひ) {
    const 答 = await call("search_deadlines", { query: q, limit: 1 });
    if (!答.includes("この表が出すのは")) continue;
    const 重ねた = 他の案内の印.filter((印) => 答.includes(印));
    expect(重ねた, `「${q}」に受皿と他の案内を重ねた: ${重ねた.join("・")}`).toEqual([]);
    /* 「打ち直すなら」とも重ねない。 */
    expect(答, `「${q}」に受皿と打ち直しを重ねた`).not.toContain("打ち直すなら");
  }
});

it("list_upcoming の種別はどれかで選び、知らない種別を名指す（第 886 回）", async () => {
  /* 實測 2026-10-19: `list_upcoming({kinds: ["paper","zzz"]})` は**0 件**だつた – 空白で繫いで
   * 「paper zzz」といふ存在せぬ種別にして居た（どれかに當たる行として選んで居なかつた）。
   * 知らない種別（`kind: "nosuchkind"`・`PAPER` の樣な大文字）も默つて居た – `search_deadlines`
   * は第 858 回から名指して居るのに、此方だけ缺けて居た。 */
  /* 複數の種別は**どれか**（61 件 = `paper` だけと同じ）。 */
  const 複数 = await call("list_upcoming", { kinds: ["paper", "zzz"] });
  expect(複数, "どれかで選べて居ん").toMatch(/締切: [1-9]\d* 件/);
  expect(複数, "知らない種別を名指して居ん").toContain(
    "知らない種別（其の侭では 0 件に成ります）: zzz",
  );
  /* 大文字でも受け付ける（AI は `PAPER` を送る）。 */
  const 大文字 = await call("list_upcoming", { kind: "PAPER" });
  expect(大文字, "大文字の種別を受け付けて居ん").toMatch(/締切: [1-9]\d* 件/);
  const 小文字 = await call("list_upcoming", { kind: "paper" });
  const 數 = (t: string): string => /締切: ([\d,]+) 件/.exec(t)?.[1] ?? "-1";
  expect(數(大文字), "大文字と小文字で件數が違ふ").toBe(數(小文字));
  /* 知らない種別だけの時は 0 件だが、其の種別が在る事を言ふ。 */
  const 知らん = await call("list_upcoming", { kind: "nosuchkind" });
  expect(知らん).toContain("知らない種別");
  expect(知らん, "知らない種別が在る様に見せて居る").toMatch(/締切: 0 件/);
  /* 知つて居る種別には斷りを付けない。 */
  for (const 語 of ["paper", "all"]) {
    const 答 = await call("list_upcoming", { kind: 語 });
    expect(答, `「${語}」に知らない種別の斷りを付けた`).not.toContain("知らない種別");
  }
  /* `search_deadlines` と同じ言ひ方（兩方の道具で同じ文を返す）。 */
  const 檢索 = await call("search_deadlines", { kinds: ["zzz", "paper"] });
  expect(檢索, "檢索の方が知らない種別を名指して居ん").toContain("知らない種別");
});

it("venue_info は正式名で引き、版の識別子を會議に敿へる（第 887 回）", async () => {
  /* 實測 2026-10-20 で二つ:
   * ① `name: "Supercomputing"` は「收錄に在りません」と答へて居た。正式名
   *   （`ICS` = ACM International Conference on Supercomputing）にしか出て居ない語で、
   *   搜检索側（`search_deadlines`）は 37 行出すのに venue_info は默つて居た。
   * ② `key: "sc26"`（版の識別子）も「收錄に在りません」。`data.csv` の `edition_id` や
   *   `data.json` の `editions[].id` を其の儘渡すことは實際に在る（AI は讀んで居る）。 */
  const 正式名 = await call("venue_info", { name: "Supercomputing" });
  expect(正式名, "正式名で引けて居ん").not.toContain("その会議");
  /* 行が見付かつた**上で**候補を並べる（名簿の受皿に落とさない – 其れは「締切の行が 1 本も
   * ありません」といふ噓に成る。ICS は正式名の語で 37 行持って居る）。 */
  expect(正式名, "正式名の會議を教へて居ん").toContain("ICS");
  expect(正式名, "名簿の受皿に落ちた（締切が在るのに無いと言ふ）").not.toContain(
    "締切の行が 1 本もありません",
  );
  /* 搜检索が行を出す語は、此方でも會議を見付ける（同じ評價を持つ – 第 726 回の延長）。 */
  const rows = Recommender.candidateRows(
    JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as never,
  );
  const now = Date.now();
  const m = Recommender.searchMatcher(Recommender.expandRelativeMonths("Supercomputing", now), now);
  const 搜した = rows.filter((r) => m(String(r.hay)) === true);
  expect(搜した.length, "此の檢查の前提（搜检索が行を出す語）が崩れた").toBeGreaterThan(0);
  expect(正式名).toContain(`${[...new Set(搜した.map((r) => String(r.conf.title)))][0]}`);

  /* 版の識別子は「無い」と言はない（會議の key を教へる）。 */
  const 版 = await call("venue_info", { key: "sc26" });
  expect(版, "版の識別子を無いと言つた").not.toContain("その会議");
  expect(版, "版だと言つて居ん").toContain("版（edition）の識別子");
  expect(版, "會議の key を教へて居ん").toContain("`sc`");
  /* 大文字の版の識別子も受け付ける。 */
  const 大文字 = await call("venue_info", { key: "SC26" });
  expect(大文字, "大文字の版の識別子を受け付けて居ん").toContain("`sc`");
  /* 會議の key は其の儘通す（版の話を出さない）。 */
  const 會議 = await call("venue_info", { key: "sc" });
  expect(會議, "會議の key に版の話を付けた").not.toContain("版（edition）の識別子");
  expect(會議).toContain("会議:");
  /* どちらでも無い識別子は「無い」と言ふ（第 876 回の儘）。 */
  const 無し = await call("venue_info", { key: "nosuchconfkey" });
  expect(無し, "收錄に無い時に別の會議を返した").toContain("その会議");
});

it("explain_word も search_deadlines と同じ案内を出す（第 888 回）", async () => {
  /* 語を調べる道具は「0 件の時に画面が出す案内文を其の儘返す」と請け合つて居るのに、
   * 檢索の方に足した案内（第 879〜884 回）が inert こなかつた。實測 2026-10-21:
   * `explain_word("カメラレディ")` は 70 行ある事だけ言つて、其の種別の選び方を言はなかつた。
   * `explain_word("ネットワーク GPU")` は「（案内は無し＝表の語では無い語）」と書きながら、
   * 次の行に名簿の案内を出して居た（「無し」と言之ながら有る物を出すのは噓）。 */
  /* ① 素の照合で行が在るのに、畫面の既定で 0 件に成る語 – 其の**理由**を言ふ。 */
  const 種別 = await call("explain_word", { word: "カメラレディ" });
  expect(種別, "0 件に成る理由を言つて居ん").toContain("画面の既定の絞り込みで 0 件に成る理由");
  expect(種別, "種別の選び方を言つて居ん").toContain('kinds: ["camera_ready"]');
  /* 檢索が言ふ件數と同じ（其の指定で實際に引いた數 – 第 762 回）。 */
  const 檢索 = await call("search_deadlines", { query: "カメラレディ" });
  const 件數 = (t: string): string =>
    /kinds: \["camera_ready"\] で引けます（([\d,]+) 件/.exec(t)?.[1] ?? "";
  expect(件數(種別), `語の案内と檢索で件數が違ふ: ${件數(種別)} ≠ ${件數(檢索)}`).toBe(件數(檢索));
  /* ② 語ごとの件數（第 880 回）も出す。 */
  const 死語 = await call("explain_word", { word: "ネットワーク GPU" });
  expect(死語, "收錄に無い語を名指して居ん").toContain("は収録データにも見当たりません");
  /* ③ 「案内は無し」は何も無い時だけ（次の行に名簿の案内が在るのに「無し」は噓）。 */
  expect(死語, "名簿の案内が在るのに「無し」と書いた").toContain("収録の名簿に");
  expect(死語.split("\n").some((l) => l.includes("案内は無し") && l.includes("名簿"))).toBe(false);
  expect(
    (await call("explain_word", { word: "ネットワーク GPU" })).includes("案内は無し"),
    "案内が在るのに「無し」を出した",
  ).toBe(false);
  /* ④ URL（第 881 回）と受皿（第 884 回）も出す。 */
  const URLの答 = await call("explain_word", { word: "https://icde2027.example.org/cfp" });
  expect(URLの答, "URL の案内を出して居ん").toContain("検索語の URL の会議は収録に見当たりません");
  const 受皿 = await call("explain_word", { word: "脳科学" });
  expect(受皿, "此の表が何を出す畫面なのかを言つて居ん").toContain("この表が出すのは催し物の名前");
  /* ⑤ 行が出る語には理由を付けない（餘計な斷りを増やさない）。 */
  const 行あり = await call("explain_word", { word: "セキュリティ" });
  expect(行あり, "行が出る語に理由を付けた").not.toContain("0 件に成る理由");
  expect(行あり).toContain("素の照合で");
});

it("檢索と言語の道具で、案内の有無が一致する（第 889 回）", async () => {
  /* 第 888 回で突き合はせたが、**次の回でまた片方だけが古く成る**可能性が有る（實際に
   * 第 879〜884 回の五つが inert こなつた）。なので、同じ問の束を兩方へ通して、
   * **どの案内が出るか**を照らし合はせる。 */
  const 問ひ = [
    "カメラレディ",
    "採否通知",
    "査読結果",
    "ネットワーク GPU",
    "セキュリティ 福岡",
    "https://icde2027.example.org/cfp",
    "脳科学",
    "閏年",
    "1か月以内",
    "3日前まで",
    "2029年3月",
    "2028年9月",
    "分野",
    "種別",
    "締め切り",
    "使い方",
    "ネットワークとセキュリティ",
    "ACSAC 2027",
    "apnoms",
    "情報処理学会 HPC 研究会",
    "zzzznotaword",
    "参加費が高い",
  ];
  const 印: Array<[string, RegExp]> = [
    ["隱れた種別", /の種別に当たります/u],
    ["語ごとの件數", /見当たりません|語をすべて含む行はありません/u],
    ["URL", /検索語の URL の会議は/u],
    ["名簿", /収録の名簿に|収録の会議の名前には/u],
    ["日數の幅", /within_days: \d+/u],
    ["過去の幅", /include_past: true/u],
    ["收錄の果て", /一番遠い締切/u],
    ["窓の外", /収録の全体には/u],
    ["受皿", /この表が出すのは/u],
    ["打ち直し", /打ち直すなら/u],
  ];
  for (const q of 問ひ) {
    const 檢索 = await call("search_deadlines", { query: q, limit: 1 });
    const 言語 = await call("explain_word", { word: q });
    for (const [名, 形] of 印) {
      const 檢索に出る = 形.test(檢索);
      const 言語に出る = 形.test(言語);
      /* 兩方に出るか、兩方に出ないか（片方だけだと、讀む人と AI で答へが違ふ）。 */
      expect(言語に出る, `「${q}」の「${名}」が explain_word にだけ出た（檢索は出ない）`).toBe(
        檢索に出る,
      );
      expect(檢索に出る, `「${q}」の「${名}」が search_deadlines にだけ出た（言語は出ない）`).toBe(
        言語に出る,
      );
    }
  }
});

it("窓が無い手元では、何を讀んで居るかを言ふ（第 892 回）", async () => {
  /* 品書（`public/catalog.json`）を build して居ない手元では、窓が無いので收錄の全體を見る。
   * 默つて居ると**件數が配布先の畫面と違ふ理由が讀めない** – 實測 2026-10-23: 品書が在る時は
   * `セキュリティ` 37 件・無い時は 42 件。AI は「畫面と違ふ」で躪き、利用者は噓を疑ふ。
   * 讀み込みは起動時に一度だけなので、此の檢查は**別の手順を起こして**試す（長生きのサーバは
   * 既に品書を讀んで仕舞ふ – 實測 2026-10-23 に踏んだ）。 */
  const 品書 = join(REPO_ROOT, "public", "catalog.json");
  if (!existsSync(品書)) return; // 品書が無い時は threshold の確認なので空振り。
  const 控え = `${品書}.bak-test`;
  copyFileSync(品書, 控え);
  try {
    rmSync(品書);
    const 聞く = (call: Record<string, unknown>): string => {
      const 返事 = spawnSync(process.execPath, [join(REPO_ROOT, "src", "mcp.ts")], {
        input: `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", clientInfo: { name: "t", version: "0" } },
        })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: call })}\n`,
        encoding: "utf8",
        timeout: 180_000,
      });
      const 行 = (返事.stdout || "")
        .trim()
        .split("\n")
        .map((l) => {
          try {
            return JSON.parse(l) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .find((m) => m && m.id === 2);
      return String(
        (行?.result as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text ??
          "",
      );
    };
    const 斷り = "public/catalog.json）がこの手元に無い";
    const 檢索 = 聞く({ name: "search_deadlines", arguments: { query: "セキュリティ", limit: 1 } });
    expect(檢索, "窓が無い事を言つて居ん").toContain(斷り);
    expect(檢索, "どうすればよいか言つて居ん").toContain("npm run build");
    const 一覽 = 聞く({ name: "list_upcoming", arguments: { days: 30, scope: "screen" } });
    expect(一覽, "一覽が窓が無い事を言つて居ん").toContain(斷り);
    const 語 = 聞く({ name: "explain_word", arguments: { word: "ネットワーク GPU" } });
    expect(語, "語の案内が窓が無い事を言つて居ん").toContain(斷り);
  } finally {
    copyFileSync(控え, 品書);
    rmSync(控え);
  }
  /* 品書が在る時は斷りを出さない（騷音を増やさない）。 */
  const 在る = await call("search_deadlines", { query: "セキュリティ", limit: 1 });
  expect(在る, "品書が在る時に斷りを付けた").not.toContain("この手元に無い");
  expect(在る, "品書が在る時に窓の名を變へた").toContain("画面が最初に読む窓");
});

it("venue_info は次の投稿締切を先頭で言ふ（第 893 回）", async () => {
  /* 實測 2026-10-24: `venue sigkdd` の一覽の先頭は「反論期間終了」と「採否通知」で、
   * 「KDD の次の締切は？」と聞いた人が**投稿の締切**を探すのに 60 を越える行を讀まなければ
   * 成らなかつた（「締切」と言へば投稿の締切を指すのが普通）。行の一覽は變へず、先頭に
   * 投稿の種別（論文・概要）の行を 1 本だけ添へる。 */
  const 今後の在る = await call("venue_info", { key: "icde", scope: "all" });
  expect(今後の在る, "次の投稿締切を言つて居ん").toContain("次の投稿締切: 20");
  /* 画面と同じ行の形（`line()`）なので、何時・どの回・札が讀める。 */
  expect(今後の在る, "投稿の締切の行が細い").toContain("論文締切");
  expect(今後の在る, "確認の札が付いて居ん").toContain("複数候補のため要確認");
  /* 今後の投稿締切が無い会議では、**一番遲い過去**を言ふ（一番古い過去では「5 年前に終はつた」
   * と讀めてしまふ – 實測で 2021 年が出て居た）。 */
  const 過ぎた = await call("venue_info", { key: "sigkdd", scope: "all" });
  expect(過ぎた, "今後の投稿締切が無い事を言つて居ん").toContain(
    "次の投稿締切: 今後の収録にありません",
  );
  const 直近 = /直近では (\d{4})-\d{2}-\d{2}/.exec(過ぎた)?.[1] ?? "";
  expect(Number(直近), "一番遲い過去が出て居ん").toBeGreaterThan(2024);
  /* 行の一覽は變へない（默つて減らさない）。 */
  const 行數 = 過ぎた.split("\n").filter((l) => /^\d{4}-\d{2}-\d{2}/.test(l)).length;
  expect(行數, "行の一覽が減つた").toBeGreaterThan(1);
});

it("推薦の pool は畫面と同じ組み立て（第 894 回）", async () => {
  /* 實測 2026-10-25: `recommend_venues` は索引の行（2,458 本）をそのまま pool に使つて居た。
   * 其の 92% は**過ぎた締切**なので、「おすすめの投稿先」の 1・2 番目に締め切つた會報が
   * 擧がり、AI は「來年でなく今出せる」と誤つて勧めてしまふ。畫面は「これからの締切 +
   * 常時受付のジャーナル + これからの締切が無い會議の過去代表 1 行」で選ぶので、其れに揃へる。 */
  const 品書 = join(REPO_ROOT, "public", "catalog.json");
  if (!existsSync(品書)) return; // 品書は建てた時だけ在る（此の檔案の約束）。
  const 索引 = JSON.parse(
    readFileSync(join(REPO_ROOT, "public", "recommendation-index.json"), "utf8"),
  ) as { conferences?: unknown[]; reranker?: unknown };
  Recommender.setNameIdf(Recommender.buildNameIdf(索引.conferences ?? []));
  Recommender.setReranker(索引.reranker ?? null);
  const catalog = JSON.parse(readFileSync(品書, "utf8"));
  const rows = Recommender.candidateRows(catalog) as unknown as Array<Record<string, unknown>>;
  const now = Date.now();
  /* 畫面の pool を此方で組み立てる（`site/app.ts` の `pool` と同じ 3 つ）。 */
  const pool = (rows as unknown as Parameters<typeof Recommender.deadlineRowIsPast>[0][])
    .filter((r) => !Recommender.deadlineRowIsPast(r as never, now))
    .concat(Recommender.journalRows(catalog.conferences ?? [], now) as unknown as never[])
    .concat(Recommender.pastRepresentatives(rows as never, now) as unknown as never[]);
  const 題 =
    "Time-Sensitive Networking Scheduling for Deterministic Industrial Networks | tsn, real-time, scheduling, deterministic";
  const 正 = Recommender.venueRecommendations(
    pool as never,
    Recommender.parsePaperLines(題),
    null,
    now,
    { fieldedLexical: true },
  ).filter((r) => r.fit.score >= 10);
  expect(正.length, "畫面と同じ pool で候補が出ない（此の檢查の前提が崩れた）").toBeGreaterThan(0);
  const text = await call("recommend_venues", { paper: 題, limit: 5 });
  expect(text, `候補の數が畫面と同じ pool と違ふ: ${正.length} 件の筈`).toContain(
    `に合う投稿先: ${正.length} 件`,
  );
  expect(text, "先頭の候補が違ふ").toContain(String(正[0].row.conf.title));
  /* **過ぎた候補が幾つあるか**を頭で分けて言ふ（默つて居ると AI が今出せる樣に勧める）。 */
  const 過ぎた = 正.filter((r) => Number(r.row.t) < now).length;
  if (過ぎた > 0)
    expect(text, "過ぎた候補の件數を言つて居ん").toContain(`うち ${過ぎた} 件は締切が過ぎた会議`);
});

it("品書が再學習の重みを持つ – 畫面の推薦が MCP と同じ順に成る（第 895 回）", async () => {
  /* 實測 2026-10-26: 畫面は `catalog.reranker` を讀む樣にして居る（`site/app.ts` の
   * `setReranker(catalog.reranker ?? null)`）が、**品書が其れを載せて居なかつた**ので常に
   * `null`（重み無し）だつた。推薦の順が畫面（語の一致だけ）と MCP（重み付き）で違つて居た –
   * 第 894 回で pool を揃へたのは其の半分。サイズは 5 KB（品書 2.2 MB の 0.2%）。 */
  const 品書 = join(REPO_ROOT, "public", "catalog.json");
  if (!existsSync(品書)) return; // 品書は建てた時だけ在る（此の檔案の約束）。
  const catalog = JSON.parse(readFileSync(品書, "utf8")) as {
    reranker?: unknown;
    conferences?: unknown[];
  };
  expect(catalog.reranker, "品書が再學習の重みを載せて居ん").toBeTruthy();
  /* 畫面が讀む通りに讀んで、MCP と同じ順序が出ることを確かめる（第 894 回の pool で）。 */
  const paper =
    "Time-Sensitive Networking Scheduling for Deterministic Industrial Networks | tsn, real-time, scheduling, deterministic";
  const now = Date.now();
  const rows = Recommender.candidateRows(catalog as never);
  const pool = (rows as unknown as Parameters<typeof Recommender.deadlineRowIsPast>[0][])
    .filter((r) => !Recommender.deadlineRowIsPast(r as never, now))
    .concat(Recommender.journalRows(catalog.conferences ?? [], now) as unknown as never[])
    .concat(Recommender.pastRepresentatives(rows as never, now) as unknown as never[]);
  Recommender.setNameIdf(
    Recommender.buildNameIdf((catalog as { conferences?: unknown[] }).conferences ?? []),
  );
  Recommender.setReranker(catalog.reranker ?? null);
  const 正 = Recommender.venueRecommendations(
    pool as never,
    Recommender.parsePaperLines(paper),
    null,
    now,
    {
      fieldedLexical: true,
    },
  )
    .filter((r) => r.fit.score >= 10)
    .slice(0, 5)
    .map((r) => String(r.row.conf.title));
  const text = await call("recommend_venues", { paper, limit: 5 });
  for (const 名 of 正) {
    expect(text, `畫面が表示する上位（${名}）が MCP の返りに無い`).toContain(名);
  }
  /* 順序も確かめる（上の 5 つが同じ順に並ぶ – 先頭の 3 つで見る）。 */
  const 順 = 正.slice(0, 3);
  const 位置 = 順.map((名) => text.indexOf(名));
  expect(位置[0] < 位置[1] && 位置[1] < 位置[2], `上位の順が MCP と違ふ: ${位置.join("・")}`).toBe(
    true,
  );
});

it("推薦の札の意味を、畫面てびきと同じ言い回しで添える（第 896 回）", async () => {
  /* 實測 2026-10-27: 札（「候補」・「重なりうすい」）を其の儘返すだけで、何を意味するか讀めなかつた。
   * AI が「候補」を「當たる見込みが高い」と取ると、推薦の强さが變はつてしまふ – 札は**一致の
   * 證據の强さ**で、採択の予測ではない（畫面のてびきの「いちばん近い會議との差が小さい」）。 */
  const text = await call("recommend_venues", {
    paper:
      "Time-Sensitive Networking Scheduling for Deterministic Industrial Networks | tsn, real-time, scheduling",
    limit: 3,
  });
  expect(text, "札の意味を言つて居ん").toContain("いちばん近い会議との差が小さい");
  expect(text, "札の意味を言つて居ん").toContain("言葉の重なりが弱い");
  /* 數値（點）の讀み方も默らない（並べるための目安で採択の予測ではない – 畫面のてびきの約束）。 */
  expect(text, "數値の讀み方を言つて居ん").toContain("採択の予測ではありません");
});

it("推薦の行に、畫面と同じ選定理由が付く（第 897 回）", async () => {
  /* 實測 2026-10-28: MCP の推薦行は「點」と「札」だけで、**何で此の會報か**が分からなかつた。
   * 畫面のカードは「選定理由: 分野の一致 / 会議名一致」と言ふ（`site/app.ts` の
   * `reasonSignals` – 同じ 5 つ + 過去掲載先。重みは書かない – 畫面が「スコアと合はない」
   * 實測で削つた）。默つて落とすと、AI は根拠を言へず「おすすめです」に成る。 */
  const 品書 = join(REPO_ROOT, "public", "catalog.json");
  if (!existsSync(品書)) return;
  const catalog = JSON.parse(readFileSync(品書, "utf8")) as {
    reranker?: unknown;
    conferences?: unknown[];
  };
  const paper =
    "Time-Sensitive Networking Scheduling for Deterministic Industrial Networks | tsn, real-time, scheduling";
  /* 畫面が表示する札と同じ理由を此方で組む。 */
  const now = Date.now();
  const rows = Recommender.candidateRows(catalog as never);
  const pool = (rows as unknown as Parameters<typeof Recommender.deadlineRowIsPast>[0][])
    .filter((r) => !Recommender.deadlineRowIsPast(r as never, now))
    .concat(Recommender.journalRows(catalog.conferences ?? [], now) as unknown as never[])
    .concat(Recommender.pastRepresentatives(rows as never, now) as unknown as never[]);
  Recommender.setNameIdf(Recommender.buildNameIdf(catalog.conferences ?? []));
  Recommender.setReranker(catalog.reranker ?? null);
  const 正 = Recommender.venueRecommendations(
    pool as never,
    Recommender.parsePaperLines(paper),
    null,
    now,
    { fieldedLexical: true },
  ).filter((r) => r.fit.score >= 10);
  expect(正.length, "此の檢査の前提（候補が出る題名）が崩れた").toBeGreaterThan(0);
  const 理由の形 = (r: { match?: { agg?: Record<string, number> }; boosted?: boolean }): string => {
    const agg = r.match?.agg ?? {};
    const 號: Array<[string, number]> = [
      ["分野の一致", agg.domain ?? 0],
      ["会議名一致", agg.venueName ?? 0],
      ["採択論文一致", agg.paper ?? 0],
      ["日本語一致", agg.jp ?? 0],
      ["主題の一致", agg.tags ?? 0],
    ];
    const 出 = 號.filter(([, v]) => v > 0).map(([名]) => 名);
    if ((agg.venue ?? 0) > 0) 出.push("過去掲載先一致");
    if (r.boosted) 出.push("同じ分野（掲載先から推定）");
    return 出.length ? 出.join(" / ") : "目立つ一致はないが候補に入った";
  };
  const 期待 = 理由の形(正[0]);
  const text = await call("recommend_venues", { paper, limit: 5 });
  expect(text, "選定理由を言つて居ん").toContain("選定理由: ");
  expect(text, `先頭の候補の理由が畫面と違ふ: ${期待}`).toContain(`選定理由: ${期待}`);
  /* 重みは書かない（畫面と同じ – 數字を並べると「點と合はない」と誤讀させる）。 */
  expect(text, "重みの數字を書いた").not.toMatch(/選定理由: [^\n]*\d+ 点/);
});

it("推薦の行に、畫面と同じ締切の確認狀況が付く（第 898 回）", async () => {
  /* 實測 2026-10-29: 推薦行は日付と種別だけを出して、**その締切が公式確認できて居るか**を
   * 言はなかつた。AI が「次は 2027-01-29 です」と言へても、推定の日付なのか分からん。
   * 畫面のカードは 4 つの軸（日期・時刻・タイムゾーン・種別）を出す – 軸の計算は
   * `site/recommendation-core.ts` の共有関數（畫面と同じ入口）。 */
  const paper =
    "Time-Sensitive Networking Scheduling for Deterministic Industrial Networks | tsn, real-time, scheduling";
  const text = await call("recommend_venues", { paper, limit: 3 });
  const 行 = text.split("\n").filter((l) => /^\d+\. 一致評価 /.test(l));
  expect(行.length, "推薦行が出て居ん（此の檢查の前提が崩れた）").toBeGreaterThan(0);
  for (const l of 行) {
    expect(l, "確認狀況が付いて居ない行がある").toContain("締切の確認状況: 日付");
    for (const 軸 of ["時刻", "タイムゾーン", "種別"])
      expect(l, `${軸}の軸が無い`).toContain(`${軸} `);
    /* **內部の表記を見せない**（畫面と同じ約束 – `official` をそのまま出さない）。 */
    expect(l, "內部の語をそのまま出した").not.toMatch(
      /(official|unverified|assumption|aggregator|publisher)\b/,
    );
  }
  /* 軸の値は共有の函數が數へたものと同じ（畫面と一體）。 */
  const 品書 = join(REPO_ROOT, "public", "catalog.json");
  if (existsSync(品書)) {
    const catalog = JSON.parse(readFileSync(品書, "utf8")) as { conferences?: unknown[] };
    const 語: Record<string, string> = {
      official: "公式確認",
      publisher: "出版社確認",
      "curated-manual": "手動確認",
      aggregator: "集約情報",
      assumption: "推定",
      unverified: "未確認",
    };
    const now = Date.now();
    for (const conf of (catalog.conferences ?? []).slice(0, 40)) {
      const 軸 = recommendationAxes(conf as Record<string, unknown>, null, now);
      const 信 = 軸.deadline_trust;
      const 期待 = `締切の確認状況: 日付 ${語[信.date] ?? 信.date} ／ 時刻 ${語[信.time] ?? 信.time} ／ タイムゾーン ${
        語[信.timezone] ?? 信.timezone
      } ／ 種別 ${語[信.kind] ?? 信.kind}`;
      /* 會議名と confidence の語が揃ふ行が在れば、その文が出tein – 全部の會議を一就有に
       * 並べると行が可笑しいので、會議名と狀況の兩方が同じ行にある時だけ確かめる。 */
      const 名 = String((conf as { title?: unknown }).title ?? "").slice(0, 12);
      if (名 && text.includes(名)) {
        expect(text.includes(`｜${期待}｜`), `「${名}」の確認狀況が共有の函數と違ふ`).toBe(true);
        break;
      }
    }
  }
});

it("推薦の行は、取得狀態と締切の競合が普通でない時だけ書く（第 899 回）", async () => {
  /* 實測 2026-10-30: 會議 696 件の取得狀態は**全部**「今回あたって確認」、締切の競合が有るのは
   * 4 會議だけ（ALT / COMPSAC / cvm / ICST）。畫面のカードは常に 2 つを出すが、MCP の返り値は
   * AI が讀む文 – 常套の文を各行に足すと、變な 1 行だけが埋もれる。普通の時は黙つて居る。 */
  const 静か = await call("recommend_venues", {
    paper:
      "Time-Sensitive Networking Scheduling for Deterministic Industrial Networks | tsn, real-time, scheduling",
    limit: 5,
  });
  expect(静か, "普通の時に取得狀態を書いた").not.toContain("取得状態: ");
  expect(静か, "競合 0 件の時に競合を書いた").not.toContain("締切の競合:");
  /* 競合がある會議では** contrario に書く**（黙ると其の會議だけ読まれない）。 */
  const 競合 = await call("recommend_venues", {
    paper: "ALT algorithmic learning theory | learning theory, algorithms",
    limit: 10,
  });
  expect(競合, "候補が出て居ん（此の檢查の前提が崩れた）").toMatch(/一致評価/);
  /* 競合が有る會議の中に 1 件でも推荐されたなら、その行には競合の件數がある。 */
  const 競合の行 = 競合
    .split("\n")
    .filter((l) => /一致評価/.test(l))
    .filter((l) => /ALT/.test(l));
  if (競合の行.length) {
    expect(競合の行[0], "競合のある行に件數が無い").toMatch(/締切の競合: [1-9]\d* 件/);
  }
});

it("品書の推薦の軸は全版で数えて居る – 新規の會議を新規と言ひ切らない（第 900 回）", async () => {
  /* 實測 2026-10-31: 画面は `r.conf.recommendation_axes` が無いと其場で軸を求めるが、品書の
   * 會議は**窓の版**しか持って居ないので历年が 1 年になり、`ICDE` が「新規・確認した年 1 年」
   * と出て居た（実物は「成長中・確認した年 7 年」）。会議 696 件の內 627 件が「新規」になつて
   * 居た – 選擇の材料を壊して居た。索引には全版で數へた軸が在つたが、画面は索引を読まない。 */
  const 品書 = join(REPO_ROOT, "public", "catalog.json");
  if (!existsSync(品書)) return;
  const catalog = JSON.parse(readFileSync(品書, "utf8")) as {
    conferences?: Array<{
      key?: string;
      recommendation_axes?: {
        venue_maturity?: { status?: string; evidence?: { yearsObserved?: number } };
      };
    }>;
  };
  const 會議 = catalog.conferences ?? [];
  const 軸を持つ = 會議.filter((c) => c.recommendation_axes?.venue_maturity);
  expect(軸を持つ.length, "品書に推薦の軸が無い（此の檢査の前提が崩れた）").toBe(會議.length);
  /* 窓の版から其場で數へると 1 年に成る會議が、少なからず在る（= 其れ曾是「新規」だった）。 */
  const 直で數へた = 會議.filter((c) => {
    const 窓の版 = (c as unknown as { editions?: unknown[] }).editions ?? [];
    const 年 = new Set(
      窓の版.map((e) => Number((e as { year?: unknown }).year)).filter((y) => y > 0),
    );
    return (
      年.size <= 1 &&
      Number(c.recommendation_axes?.venue_maturity?.evidence?.yearsObserved ?? 0) >= 2
    );
  });
  expect(
    直で數へた.length,
    "窓の版で數へると 1 年になるのに、載せた軸が 2 年以上 – 實測と違ふ",
  ).toBeGreaterThan(0);
  /* MCP は**載せた軸**を使う（會議の續いて居る年数が其の値になる）。 */
  const text = await call("recommend_venues", {
    paper: "ICDE International Conference on Data Engineering | icde, database, data mining",
    limit: 5,
  });
  expect(text, "成熟度の文を言つて居ん").toContain("会議の続いている年数: ");
  /* 內部の語を出さない（畫面と同じ約束）。 */
  expect(text, "內部の語をそのまま出した").not.toMatch(/(established|emerging|unverified)\b/);
});

it("推薦の軸が畫面の行まで届く（第 901 回）", async () => {
  /* 第 900 回は品書に軸を載せたが、`normalizeConference` が其れを落として居た – 行列の
   * `conf.recommendation_axes` が常に空で、畫面は其場で計算するesy fall back に落ちて居た。
   * 實測 2026-10-31: `ICDE` の行が「新規・確認した年 1 年」を持って居た。 */
  const 品書 = join(REPO_ROOT, "public", "catalog.json");
  if (!existsSync(品書)) return;
  const catalog = JSON.parse(readFileSync(品書, "utf8"));
  const rows = Recommender.candidateRows(catalog as never) as unknown as Array<{
    conf?: {
      key?: string;
      recommendation_axes?: {
        venue_maturity?: { status?: string; evidence?: { yearsObserved?: number } };
      };
    };
  }>;
  expect(rows.length, "此の檢査の前提（行が出て居ない）が崩れた").toBeGreaterThan(0);
  const 軸のある行 = rows.filter((r) => r.conf?.recommendation_axes);
  expect(軸のある行.length, "行の conf に推薦の軸が届いて居ん").toBe(rows.length);
  /* 窓の版しか無くて其場で計算すると 1 年になる行が、2 年以上の値を持って居る。 */
  const icde = rows.find((r) => r.conf?.key === "icde");
  expect(
    icde?.conf?.recommendation_axes?.venue_maturity?.status,
    "ICDE の成熟度が見当たらない",
  ).toBeTruthy();
  expect(
    Number(icde?.conf?.recommendation_axes?.venue_maturity?.evidence?.yearsObserved ?? 0),
    "ICDE の観測年数が 1 年以下 – 窓の版から其場で計算して居る",
  ).toBeGreaterThan(1);
});

it("人が道具の名を間違えたら、跡ytics ではなく助けを書く（第 904 回）", () => {
  /* 實測 2026-10-31: `node src/mcp.ts 検索` は Node の stack trace が出て居た。一到來た人が
   * 其の儘打入した語であらうと、何を書けばよいかが読めない。`--help` と同じ一覧を出す。 */
  const 実行 = (args: string[]): string => {
    const r = spawnSync(process.execPath, [join(REPO_ROOT, "src", "mcp.ts"), ...args], {
      encoding: "utf8",
      timeout: 180_000,
    });
    return `${r.stdout ?? ""}${r.stderr ?? ""}`;
  };
  /* 道具の日本語名や、字を一つ増やした名前 – 人がよく打つ誤り。 */
  for (const 語 of ["検索", "venue_infoe", "saerch"]) {
    const 出 = 実行([語]);
    expect(出, `「${語}」で stack trace が出て居る`).not.toContain("at Object.");
    expect(出, `「${語}」の跡yticsを出して居ない`).not.toContain("ReferenceError");
    expect(出, `「${語}」が道具の名だと言ふ案内が無い`).toContain(`知らない道具「${語}」`);
    /* 道具の名を全部出す（どれを書けば良いかが分かる）。 */
    for (const 名 of [
      "search_deadlines",
      "list_upcoming",
      "venue_info",
      "explain_word",
      "collection_stats",
      "recommend_venues",
    ]) {
      expect(出, `「${語}」の助けに ${名} が無い`).toContain(名);
    }
  }
  /* 短い別名は 6 つとも在る（`collection_stats` には `stats` – 其它 5 つに有るのに其在無かった）。
   * 別名ごとに**同じ道具**に繋がることを、返り値の先頭の文で確かめる。 */
  for (const [別名, 引数, 期待] of [
    ["search", "セキュリティ", "検索語「セキュリティ」に当たる締切"],
    ["upcoming", "", "今日から 30 日以内"],
    ["venue", "sigkdd", "会議: KDD"],
    ["explain", "締切", "「締切」は"],
    ["recommend", "tsn", "に合う投稿先"],
    ["stats", "", "収録（data/snapshot.json）"],
  ] as const) {
    const 出 = 実行(引数 === "" ? [別名] : [別名, 引数]);
    expect(出, `別名 ${別名} が利かない`).toContain(期待);
    expect(出, `別名 ${別名} が道具に繋げて居ない`).not.toContain("知らない道具");
  }
});

it("「収録の全体」を押す前に、読み込む容量を数字で示す（第 905 回）", () => {
  /* 實測 2026-10-31: 画面の案内は「一覧より大きめのデータを読みます」だけで、實測すると
   * `data.json` は 9,490,437 バイト（約 9.1 MB）。內部の註釋は今も 6 MB 強と書いて居た。
   * 押す前に**読める量**を知らせ無いと、讀む人は自分の通信量で選べるのに其れが分から無い。 */
  const 品書 = join(REPO_ROOT, "public", "catalog.json");
  if (!existsSync(品書)) return;
  const catalog = JSON.parse(readFileSync(品書, "utf8")) as {
    history_ref?: string;
    history_bytes?: number;
  };
  expect(catalog.history_bytes, "品書が容量を載せて居ん").toBeGreaterThan(0);
  /* 申告した數字が**其の物の寸法**と一致する（別の物を数えて居ない – 第 289 回の決めごと）。 */
  const 実寸 = statSync(join(REPO_ROOT, "public", String(catalog.history_ref ?? "data.json"))).size;
  expect(
    catalog.history_bytes,
    `品書の申告 ${String(catalog.history_bytes)} と實寸 ${実寸} が違ふ`,
  ).toBe(実寸);

  /* 畫面の文は容量を数字で出す。容量を持た無い古い品書では從來の言葉に戻る（第 293 回の
   * 決めごと – 品書が申告が無い時に數を作らない）。 */
  const app = siteRuntime();
  const 函數を拔く = (量: number): string => {
    const src = [
      `const countJa = ${jsFunction(app, "countJa")};`,
      // 第 905 回: 容量を数字で示す為、`fullRecordNoteJa` が `bytesJa` を呼ぶ樣になった。
      `const bytesJa = ${jsFunction(app, "bytesJa")};`,
      `const fullRecordNoteJa = ${jsFunction(app, "fullRecordNoteJa")};`,
      `console.log(fullRecordNoteJa("2027-02-04", "2028-06-05", 180, ${量}));`,
    ].join("\n");
    const proc = spawnSync("node", ["-e", vmSafeSource(src)], {
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(proc.status, proc.stderr.slice(0, 300)).toBe(0);
    return proc.stdout.trim();
  };
  const 有り = 函數を拔く(Number(catalog.history_bytes));
  expect(有り, "容量を数字で言つて居ん").toMatch(/(KB|MB)/);
  expect(有り, "容量が無いのに從來の言葉のまま").not.toContain("大きめのデータ");
  const 無し = 函數を拔く(0);
  expect(無し, "容量が無い時に從來の言葉へ戻らない").toContain("大きめのデータ");
  expect(無し, "容量が無い時に數を作つた").not.toMatch(/(KB|MB)/);
});

it("collection_stats は data.json の容量を、測れる時にだけ書く（第 906 回）", async () => {
  /* 畫面は「収録の全体」を押す前に容量を数字で示す樣にした（第 905 回）。AI 側も
   * 「全部取り込むのにどれくらい要るか」が分から無いと、道具を使ふ判断がつかない。
   * 品書が `history_bytes` を載せて居れば其れを使い、無ければ其の物を測り、
   * **どちらも無ければ書かない**（數をでっち上げない）。 */
  const 品書 = join(REPO_ROOT, "public", "catalog.json");
  const text = await call("collection_stats", {});
  expect(text, "ファイルの案内が出て居ん").toContain("data.json（収録の全体");
  if (!existsSync(品書)) {
    expect(text, "集群が無くても容量をでっち上げた").not.toMatch(/約 [\d.]+ (KB|MB)/);
    return;
  }
  const catalog = JSON.parse(readFileSync(品書, "utf8")) as { history_bytes?: number };
  const 実 = statSync(join(REPO_ROOT, "public", "data.json")).size;
  expect(実, "此の檢査の前提（data.json が在る）が崩れた").toBeGreaterThan(0);
  /* 品書の申告（過去實測で 9,490,437 バイト）と同じ測定結果に丸められる。 */
  const 期待 = catalog.history_bytes
    ? `約 ${(Number(catalog.history_bytes) / (1024 * 1024)).toFixed(1)} MB`
    : `約 ${(実 / (1024 * 1024)).toFixed(1)} MB`;
  expect(text, `容量の数字が容量の實測と違ふ（${期待} の筈）`).toContain(
    `data.json（収録の全体。機械可読の正・${期待}）`,
  );
});

it("scope の別名を受け、知らない値は名指す（第 908 回）", async () => {
  /* 實測 2026-11-01: `scope: "collection"`（索引の語「収録の全体」）も `scope: "nosuch"` も
   * 黙って**窓**を返して居た。schema には `screen` / `all` の 2 つしか無いので、AI が資料の
   * 語或其の儕の打鍵違いで別の物を見る – 第 886 回の「知らない種別」と同じ括り。 */
  const 窓 = await call("search_deadlines", { query: "セキュリティ", scope: "screen", limit: 1 });
  const 全 = await call("search_deadlines", { query: "セキュリティ", scope: "all", limit: 1 });
  expect(窓).toContain("画面が最初に読む窓");
  expect(全).toContain("収録の全体");
  /* 別名は `all` と**同じ答え**を返す（資料の語をそのまま使える）。 */
  for (const 別名 of ["collection", "full"]) {
    const 答 = await call("search_deadlines", { query: "セキュリティ", scope: 別名, limit: 1 });
    expect(答, `別名 ${別名} が all と違ふ`).toBe(全);
  }
  for (const 別名 of ["window", "catalog"]) {
    const 答 = await call("search_deadlines", { query: "セキュリティ", scope: 別名, limit: 1 });
    expect(答, `別名 ${別名} が screen と違ふ`).toBe(窓);
  }
  /* 知らない値は**名指す**（黙って別の物を返さない）。 */
  for (const 道具 of [
    { name: "search_deadlines", args: { query: "セキュリティ", scope: "nosuch", limit: 1 } },
    { name: "list_upcoming", args: { days: 7, scope: "nosuch" } },
    { name: "explain_word", args: { word: "ネットワーク GPU", scope: "nosuch" } },
    { name: "venue_info", args: { key: "sigkdd", scope: "nosuch" } },
  ] as const) {
    const 答 = await call(道具.name, 道具.args as Record<string, unknown>);
    expect(答, `${道具.name} が知らない scope を名指して居ん`).toContain(
      "知らない scope「nosuch」",
    );
  }
  /* 省いた時は名指さない（騷音を増やさない）。 */
  const 省 = await call("search_deadlines", { query: "セキュリティ", limit: 1 });
  expect(省, "scope を省いたのに名指した").not.toContain("知らない scope");
});

it("真偽の引数は文字列でも効く – 読めない値は名指す（第 909 回）", async () => {
  /* 實測 2026-11-01: `include_past: "true"` を渡しても `=== true` の比較一つで黙って外れて居た
   * – 89 件のはずが 37 件になり、AI は「過去の締切を出した中得到 37 件」と返す（絞り込みが
   * 付かないのに其在言わない）。數の引數（第 878 回）と同じ扱いにした。 */
  const 基本 = await call("search_deadlines", { query: "セキュリティ", limit: 1 });
  const 件數 = (t: string): string => /締切: ([\d,]+) 件/.exec(t)?.[1] ?? "";
  const 過去 = await call("search_deadlines", {
    query: "セキュリティ",
    limit: 1,
    include_past: true,
  });
  expect(件數(過去), "include_past が効いて居ん").not.toBe(件數(基本));
  /* 文字列・數字・-other の読みやすい形も同じ答えにする。 */
  for (const 値 of ["true", "1", "yes", "on", "真"]) {
    const 答 = await call("search_deadlines", {
      query: "セキュリティ",
      limit: 1,
      include_past: 値,
    });
    expect(答, `include_past: "${値}" が効かない`).toBe(過去);
  }
  for (const 値 of ["false", "0", "no", "off", "偽"]) {
    const 答 = await call("search_deadlines", {
      query: "セキュリティ",
      limit: 1,
      include_past: 値,
    });
    expect(答, `include_past: "${値}" が基本と違ふ`).toBe(基本);
  }
  /* 読めない値は**名指す**（數の引數と同じ – 黙って既定に戻さない）。 */
  for (const [名, 値] of [
    ["include_past", "bogus"],
    ["include_estimated", "maybe"],
    ["domestic", "x"],
    ["online", "はい"],
  ] as const) {
    const 答 = await call("search_deadlines", { query: "セキュリティ", limit: 1, [名]: 値 });
    expect(答, `${名} の讀めない値を名指して居ん`).toContain(
      `${名} は true か false で指定してください`,
    );
  }
  /* `domestic` / `online` も讀める形では効く（頭の「国内のみ」の札が出る）。 */
  const 國內 = await call("search_deadlines", {
    query: "セキュリティ",
    limit: 1,
    domestic: "true",
  });
  expect(國內, "domestic の文字列が効いて居ん").toContain("国内のみ");
  expect(件數(國內)).not.toBe(件數(基本));
  /* 省いた時は名指さない。 */
  expect(基本, "省いたのに名指した").not.toContain("true か false で指定してください");
});

it("list_upcoming に会期（開催）の行を出す（第 910 回）", async () => {
  /* 実測 2026-11-02: 会議がいつなのかを聞いた AI は、畫面・MCP・カレンダーのどれでも
   * 会期の行が出ずに「会議が在らない」と答えて居た – 会期の行は upcoming.md /
   * upcoming.html にしか無かった。会期は edition の event_start / event_end（分段が在る版は
   * event_segments）に在るので、同じ所から引く（推定の版は入れない – 畫面の表と同じ規則）。 */
  const text = await call("list_upcoming", { days: 30, scope: "all", limit: 1 });
  expect(text, "開催の節が無い").toContain("開催（会期の行）");
  /* **どこにも無い物ではない**ことを書く（AI が表に讀みに行く様に）。 */
  expect(text, "同じ表の場所を言つて居ん").toContain("upcoming.md");
  expect(text, "畫面とカレンダーに出ない事を言つて居ん").toContain(
    "画面の一覧とカレンダーには出ない",
  );
  const 件 = /開催（会期の行）: ([\d,]+) 件/.exec(text)?.[1]?.replace(/,/g, "") ?? "0";
  expect(Number(件), "開催の行が 1 件も出て居ん").toBeGreaterThan(0);
  /* 件数と行数が合う（切り詰めた時も它的に書く – 第 765 回の決めごと）。 */
  const 行 = text
    .split("\n")
    .slice(text.split("\n").findIndex((l) => l.includes("開催（会期の行）")) + 1)
    .filter((l) => l.startsWith("- 20"));
  expect(行.length, `開催の行が ${件} 件と違ふ`).toBe(Number(件));
  /* 各行は会期を持つ（`- 2026-10-11(土) 〜 2026-10-15(木) | 会議名（key: …）`）。 */
  expect(行[0], "会期の行の形が違う").toMatch(/^- 20\d\d-\d\d-\d\d\(.\).*\| .+（key: [^）]+）/u);
  /* 締切の行も出て居る（開催の節を足しても、締切の行は減らして居ない）。 */
  expect(text, "締切の行が見えない").toMatch(/^20\d\d-\d\d-\d\d/mu);
});

it("collection_stats が分野別の会議数を出す – health.json と同じ数（第 911 回）", async () => {
  /* 實測 2026-11-03: 分野別の会議数は `health.json` の `category_counts` に在るのに、
   * 道具のどれからも出て居なかった。「此の収録は何を覆うか」を数へずに多想 – AI は
   * 9 分野の名（索引には在る）だけから中身を当てずに見積もりを書く。 */
  const text = await call("collection_stats", {});
  expect(text, "分野別の件数が無い").toContain("分野別の会議数（多い順");
  /* 數へるものは收錄の會議から – 公開している `health.json` の數と**一つも違わない**。 */
  const 品書 = join(REPO_ROOT, "public", "catalog.json");
  const health = join(REPO_ROOT, "public", "health.json");
  if (!existsSync(品書) || !existsSync(health)) return;
  const healthJson = JSON.parse(readFileSync(health, "utf8")) as {
    category_counts?: Record<string, number>;
  };
  const 數 = healthJson.category_counts ?? {};
  expect(
    Object.keys(數).length,
    "此の檢查の前提（health.json の分野別が在る）が崩れた",
  ).toBeGreaterThan(0);
  for (const [key, n] of Object.entries(數)) {
    const 名 = Recommender.categoryLabelJa(key) ?? key;
    expect(
      text,
      `health.json の ${名} ${n} 件と答が違ふ（別の集計に居ると数が合わない）`,
    ).toContain(`${名} ${n}`);
  }
  /* 多い順に並ぶ（讀む人が最初に見る物から順に – 索引の 9 分野の順ではない）。 */
  const 並び = [
    ...text.matchAll(
      /(人工知能|システム|セキュリティ|ネットワーク|高性能計算|データベース|計算理論|グラフィックス|人間情報処理) (\d+)/g,
    ),
  ];
  expect(並び.length, "分野の数が出て居ん").toBe(9);
  const 數々 = 並び.map((m) => Number(m[2]));
  expect(
    [...數々].sort((a, b) => b - a),
    "多い順に並んで居ない",
  ).toEqual(數々);
});

it("collection_stats が上流のソースの状態を出す – 品書と同じ（第 912 回）", async () => {
  /* 實測 2026-11-03: health.json の `source_status` と品書の `source_updates` に在る
   * （上流から新しく取ったか、前回のキャッシュで足りたか）が、道具のどれからも出て居た。
   * 収録が新しいかは數字ではなく出所で決まるので、**數だけで當てるのは危ない**。 */
  const 品書 = join(REPO_ROOT, "public", "catalog.json");
  if (!existsSync(品書)) return; // 品書は建てた時だけ在る。
  const catalog = JSON.parse(readFileSync(品書, "utf8")) as {
    source_updates?: Array<{ name?: string; status?: string }>;
  };
  const 更新 = catalog.source_updates ?? [];
  expect(更新.length, "此の檢査の前提（品書にソースの更新が在る）が崩れた").toBeGreaterThan(0);
  const text = await call("collection_stats", {});
  expect(text, "上流のソースの行が無い").toContain("上流のソース:");
  /* 品書の值と同じ言葉で出す（`fresh` / `cache-fallback` 等の內部の語を見せない）。 */
  expect(text, "內部の語をそのまま出した").not.toMatch(/(cache-fallback|snapshot-fallback)\b/);
  const 期待: Record<string, string> = {
    fresh: "今回あたって取得",
    "cache-fallback": "前回の取得データ（今回は上流にあたらず）",
    "snapshot-fallback": "確定済みの収録データ（今回は上流にあたらず）",
  };
  for (const u of 更新) {
    const 名 = String(u.name ?? "");
    const 狀態 = 期待[String(u.status)] ?? String(u.status);
    expect(text, `ソース ${名} の状態を言つて居ん`).toContain(`${名}: ${狀態}`);
  }
  /* **5 種類すべての狀態**を日本語で言える（`HealthSourceStatus` – `src/build.ts`）。內部の語
   * （`failed` / `success`）をそのまま出さない – 取得できなかつたソースが在ると、其の分の會議が
   * 收录に無いので|その分を知る必要がある）。 */
  const 狀態の語 = [
    ["fresh", "今回あたって取得"],
    ["success", "今回あたって取得"],
    ["cache-fallback", "前回の取得データ（今回は上流にあたらず）"],
    ["snapshot-fallback", "確定済みの収録データ（今回は上流にあたらず）"],
    ["failed", "上流から取得できませんでした"],
  ] as const;
  const 控え = `${品書}.bak-status`;
  copyFileSync(品書, 控え);
  try {
    const 品 = JSON.parse(readFileSync(品書, "utf8")) as { source_updates?: unknown[] };
    品.source_updates = 狀態の語.map(([status]) => ({
      name: `t${status}`,
      status,
      fetched_at: null,
    }));
    writeFileSync(品書, `${JSON.stringify(品, null, 2)}\n`);
    /* 讀み込みは起動時に一度だけ – 別の手順を起こして試す（第 892 回と同じ扱い）。 */
    const 答 = (() => {
      const 手順 = spawnSync(process.execPath, [join(REPO_ROOT, "src", "mcp.ts"), "stats"], {
        encoding: "utf8",
        timeout: 180_000,
      });
      return `${手順.stdout ?? ""}${手順.stderr ?? ""}`;
    })();
    for (const [status, 日本語] of 狀態の語) {
      expect(答, `狀態 ${status} を日本語で言つて居ん`).toContain(`t${status}: ${日本語}`);
    }
    expect(答, "內部の語をそのまま出した").not.toMatch(
      /(failed|success|cache-fallback|snapshot-fallback)\*\//u,
    );
  } finally {
    copyFileSync(控え, 品書);
    rmSync(控え);
  }
});

it("道具の說明が、實際に出ているものを名指す（第 914 回）", async () => {
  /* 実態を増やしても說明が追ひ付かないと、AI は其れを知らずに道具を選べない（読む前に分からない – 第 891 回の README と同じ括り）。返り値に**在る節**を說明が
   * 一つずつ名指して居ることを見る。 */
  const 必要な語: Array<[string, string[]]> = [
    ["search_deadlines", ["0 件", "within_days", "scope", "kinds"]],
    ["list_upcoming", ["開催", "kind", "days"]],
    ["venue_info", ["key", "次の投稿締切", "版"]],
    ["explain_word", ["0 行", "案内"]],
    ["recommend_venues", ["一致評価", "選定理由", "pool"]],
    ["collection_stats", ["分野別の会議数", "上流のソース"]],
  ];
  const res = (await client.ask({ jsonrpc: "2.0", id: 92, method: "tools/list" })) as {
    result?: { tools?: Array<{ name: string; description?: string }> };
  };
  const listed = res.result?.tools ?? [];
  if (process.env.DEBUG_TOOLS) {
    const d = listed.find((t) => t.name === "recommend_venues")?.description ?? "";
    console.log("DEBUG len", d.length, "has:", d.includes("選定理由"), d.slice(-120));
  }
  const 有二 = listed.filter((t) => 必要な語.some(([名]) => 名 === t.name));
  expect(有二.length, "道具が六つ揃つて居ない（此の檢査の前提が崩れた）").toBe(必要な語.length);
  for (const [名, 語々] of 必要な語) {
    const 説 = 有二.find((t) => t.name === 名)?.description ?? "";
    for (const 語 of 語々) {
      if (process.env.DEBUG_TOOLS)
        console.log(
          名,
          JSON.stringify(語),
          説.includes(語),
          "len",
          説.length,
          "indexOf",
          説.indexOf("選定理由"),
        );
      expect(説, `${名} の說明が「${語}」を名指して居ん`).toContain(語);
    }
  }
  /* 實際の返り値にその語が在ることも見る（說明だけの書き起こしが reality とずれない – 第 910 回の開催）。 */
  const 上記 = await call("collection_stats", {});
  expect(上記, "說明に在る節が實際の返り値に無い").toContain("分野別の会議数");
  const 一覧 = await call("list_upcoming", { days: 30, scope: "all", limit: 1 });
  expect(一覧, "說明に在る開催の節が實際の返り値に無い").toContain("開催（会期の行）");
});

it("畫面も「其の月だけ」を件數欄に書く（第 940 回の畫面側）", async () => {
  /* 第 940・941 回で MCP が「判定: 2026年10月 = 2026年10月の締切（其の月だけ…）」を
   * 出す樣にした。畫面は**同じ函數**（`relativeDayNotes`）で其れを出す – 兩者が同じ事を
   * 同じ言葉で言つて居ることを見る。 */

  /* 1. **同じ函數**を呼んで居る（ソースの約束 – 畫面が別の物を書き出したら此處で落ちる）。 */
  const 畫面の註 = readFileSync(join(REPO_ROOT, "site", "app.ts"), "utf8");
  expect(畫面の註, "畫面が件數欄の注に relativeDayNotes を呼んで居ない").toContain(
    "Recommender.relativeDayNotes(searchQuery",
  );

  /* 2. **同じ言ふ方** – MCP の判定の行は、此の方（正典の函數）と同じ文を含む。實測
   *    2026-11-12: 兩者は「其の月だけ – 年全体ではありません」を共有する。 */
  const 正典の注 = Recommender.relativeDayNotes(
    Recommender.expandRelativeMonths("今月", Date.now()),
    Date.now(),
  );
  expect(正典の注.length, "正典の函數が注を返さない（此の檢查の前提が崩れた）").toBeGreaterThan(0);
  expect(正典の注[0], "正典が其の月だけを名乗つて居ない").toContain("其の月だけ");
  const mcp = await call("search_deadlines", { query: "今月", limit: 1 });
  const 判定 = mcp.split("\n").find((l) => l.startsWith("判定:")) ?? "";
  expect(判定, "MCP が判定を出して居ん").not.toBe("");
  /* 兩者の**年と月**が一致する（「2026年10月」の部分）。 */
  const 年と月 = /(\d{4}年\d{1,2}月)/.exec(正典の注[0])?.[1] ?? "";
  expect(年と月, "正典の注から年と月が讀めない").not.toBe("");
  expect(判定, `畫面と同じ年と月に成つて居ない（${年と月}）`).toContain(年と月);
});

it("畫面と MCP が、同じ問に同じ行を出す（第 917 回）", async () => {
  /* 件數が一致することは第 858・894・895 回で確かめた。**どの行**が出るかまでは見て
   * 居なかつた – AI が「載せる」と-entry 人や 画面と別の會報を答えても、中の件数は同じで
   * 氣づかれない。畫面の絞り込みを**正本から**拔いて、同じ問の束で兩方の行を突き合はせる。 */
  const 品書 = join(REPO_ROOT, "public", "catalog.json");
  if (!existsSync(品書)) return;
  const html = siteRuntime();
  const rowsFile = join(tmpdir(), `kamiyobi-screen-rows-${process.pid}.json`);
  writeFileSync(
    rowsFile,
    JSON.stringify(Recommender.candidateRows(JSON.parse(readFileSync(品書, "utf8")))),
  );
  afterAll(() => {
    rmSync(rowsFile, { force: true });
  });
  const 畫面の行 = (問: string): string[] => {
    const script = [
      "const DAY = 86400000;",
      `const FILTER = ${JSON.stringify(jsFunction(html, "filter"))};`,
      `const NOW = ${Date.now()};`,
      "class FakeDate extends Date { static now() { return NOW; } }",
      "const fs = require('node:fs');",
      `const catalog = JSON.parse(fs.readFileSync(${JSON.stringify(品書)}, 'utf8'));`,
      FILTER_RUNTIME_STUBS, // 連結済みの 1 本の文字列（配列ではない）
      /* 行は**此方で作って**渡す（`public/recommender.js` は ESM なので probe 里面の require で
       * は讀めない – 此方差分はこっち側の同じ函数を使う）。 */
      `const rows = JSON.parse(fs.readFileSync(${JSON.stringify(rowsFile)}, 'utf8'));`,
      `const state = { q: ${JSON.stringify(問)}, cats: [], kind: "", rank: "", win: "all", est: false };`,
      "const filter = new Function('Date','DAY','rows','state','sortAsc','sortKey',",
      "  'return (' + FILTER + ')')(FakeDate, DAY, rows, state, false, 'time');",
      "const filterRows = filter();",
      "console.log(JSON.stringify([...new Set(filterRows.map((r) => r.ed.id))].sort()));",
    ].join("\n");
    const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
      encoding: "utf8",
      timeout: 120_000,
      /* 畫面と MCP の**時を同じにする** – 差分は時でずれる（實測 2026-11-06: 畫面 probe の
       * 凍結時刻が 1 日前だつた爲に「今月」で 5 行が違ふ樣に見えた）。 */
    });
    expect(proc.status, `畫面の絞り込みが動かない（${問}）: ${proc.stderr.slice(0, 300)}`).toBe(0);
    return JSON.parse(proc.stdout.trim()) as string[];
  };
  /* 第 943 回 – 今囘の三直し（今月・今月の締切・ics）が入る形を齊の中に足した。
   * 「今月の締切」は絞り込みに使ふ機能語が續く形で、`ics` は曖昧に當たる形 – どちらも
   * 畫面と同じ行を返さねばならない（文を足したので行が動じて居ないことの保險）。 */
  for (const 問 of [
    "AAMAS",
    "セキュリティ",
    "今月",
    "今月の締切",
    "ics",
    "来週",
    "2026年11月",
    "ネットワーク GPU",
    "ICDE",
  ]) {
    const 畫面 = 畫面の行(問);
    const 答 = await call("search_deadlines", { query: 問, limit: 400 });
    /* MCP の行は「… | 種別 | 札 | 會議名（版の識別子）| ランク | 会期 | 開催地 URL」。
     * **行を `|` で切って、會議名の欄だけ**を取る（第 1035 回 – 種別の欄に
     * 「論文締切（regular）」の樣にトラックを出すやうになつたので、凡ゆる丸括弧を拾ふと
     * 種別の方を版の識別子と誤認する）。版の識別子は**會議名の後ろの丸括弧**で、
     * `|` で切る前の欄なので、會議名の欄の**最初の丸括弧**を取ればよい。 */
    const mcp = [
      ...new Set(
        答
          .split("\n")
          .filter((l) => /^2\d{3}-/.test(l))
          .flatMap((l) => {
            /* 札は在る時だけ入る（6 つか 7 つ – 第 1061 囮で實測して直した。會議名とランクが
             * 續いて居るので數へ方が違つて居た）。會議名の欄は札のある
             * 行が 4 番目・無い行が 3 番目。**丸括弧が入る欄**で探す。 */
            /* 會議名の欄は「…（版の識別子）| ランク…」で、**必ず `| ランク` が續く**
             * （空白は入らない – `）| ラ`）。種別の欄（「論文締切（regular）」）は其の續きが
             * 無いので、其れで區別できる（第 1035 回 – トラックを種別に足した時に凡ゆる
             * 丸括弧を拾ふ正則が誤認した）。 */
            for (const f of l.split(" | ")) {
              const m = /^(.+?)（([a-z0-9][a-z0-9.'-]*)）\| .+$/.exec(f.trim());
              if (m && m[1].trim().length > 0) return [m[2]];
            }
            return [];
          }),
      ),
    ].sort();
    expect(
      mcp,
      `「${問}」で兩者の行が違ふ（画面 ${畫面.length} 件 / MCP ${mcp.length} 件）`,
    ).toEqual(畫面);
  }
});

it("recommend_venues の見出しは、題名の最初の一行だけを出す（第 918 回）", async () => {
  /* 實測 2026-11-08: 3 行の摘要を渡すと、見出しが三行の全部を「 / 」で繋いだ 1 行になって
   * 目的を覆ふ。畫面は摘要 其侭の紙面を出さず、候補の行に會議を出す – 此方も最初の一行を
   * 題として出す（其の他の行も計算には使うので、行数を書く）。 */
  const 三行 = [
    "時間スケジューリング手法を用いた協調型edge computing",
    "我々は分散したIoT機器群の間でジョブを分散実行する枠組みを提案する。",
    "keywords: scheduling, edge computing, IoT",
  ].join("\n");
  const text = await call("recommend_venues", { paper: 三行, limit: 2 });
  const 頭 = text.split("\n")[0] ?? "";
  expect(頭, "最初の一行の題が出て居ん").toContain(
    "時間スケジューリング手法を用いた協調型edge computing",
  );
  expect(頭, "2 行目以降を繋いで居る（目的が覆ふ）").not.toContain("分散したIoT機器群");
  expect(頭, "其の他の行も見て居ることを言つて居ん").toContain("ほか 2 行の語も見て居ます");
  /* 1 行だけなら「ほか」の文は出さない（騒音を増やさない）。 */
  const 一行 = await call("recommend_venues", {
    paper: "Time-Sensitive Networking | tsn",
    limit: 2,
  });
  expect(一行.split("\n")[0] ?? "", "1 行で「ほか」を出した").not.toContain("行の語も見て居ます");
  /* 長い題名は 40 字で切る（1 行でも見出しが壁にならない）。 */
  const 長い = await call("recommend_venues", { paper: `${"A".repeat(80)} | tsn`, limit: 1 });
  const 長い頭 = 長い.split("\n")[0] ?? "";
  expect(長い頭, "長い題名を切り詰めなかった").toContain("…");
  expect(長い頭, "切り詰めたのに 80 字出て居る").not.toContain("A".repeat(60));
});

it("道具の返り値に、壊れた補間の跡（$）が残らない（第 919 回）", async () => {
  /* 2026-11-08 の事故: 編集中に模板リテラルの `${…}` を数箇所壊し、biome の誤復旧で
   * `$…` に変わった（`$限定.斷り`・`$件數`）。**型検査は通る** – 文字列の中の只是別の文字列だ
   * からで、`includes()` が落ちたのは其の後の検査だけ。一览無盡の事故なので、**返り値に `$` が
   * 出ないこと**を検査にする（此の MCP の返り値に 正当なドルは 1 つも無い –
   * 實測 2026-11-08 で 10 呼びを實測して 0 件）。 */
  const 呼び: Array<[string, Record<string, unknown>]> = [
    ["search_deadlines", { query: "セキュリティ" }],
    ["search_deadlines", { query: "セキュリティ", include_past: true }],
    ["search_deadlines", { query: "カメラレディ" }],
    ["search_deadlines", { query: "1か月以内" }],
    ["search_deadlines", { query: "脳科学" }],
    ["search_deadlines", { query: "https://icde2027.example.org/cfp" }],
    ["search_deadlines", { query: "ネットワーク GPU", scope: "nosuch" }],
    ["list_upcoming", { days: 7 }],
    ["list_upcoming", { days: 30, scope: "all" }],
    ["list_upcoming", { days: 30, kind: "nosuchkind" }],
    ["venue_info", { key: "sigkdd" }],
    ["venue_info", { name: "KDD" }],
    ["venue_info", { key: "sc26" }],
    ["venue_info", { key: "nosuchkey" }],
    ["explain_word", { word: "ネットワーク GPU" }],
    ["explain_word", { word: "締切" }],
    ["recommend_venues", { paper: "Time-Sensitive Networking | tsn", limit: 3 }],
    ["recommend_venues", { paper: "1行だけ", limit: 2 }],
    ["collection_stats", {}],
  ];
  const 見つかった: string[] = [];
  for (const [道具, 引數] of 呼び) {
    const 答 = await call(道具, 引數);
    const 行 = 答.split("\n").find((l) => l.includes("$"));
    if (行 !== undefined) 見つかった.push(`${道具} ${JSON.stringify(引數)}: ${行.slice(0, 80)}`);
  }
  expect(
    見つかった,
    `返り値にドルが出て居る（壊れた補間の跡 – 第 919 回）:\n${見つかった.join("\n")}`,
  ).toEqual([]);
});

it("recommend_venues は、効かない絞り込みの引数を名指す（第 920 回）", async () => {
  /* 實測 2026-11-09: `rank` `domestic` `scope` `within_days` `include_past` を渡しても件数が
   * 其のままで、どこにも書かれなかった – AI が「CCF A の會報だけで」と頼んでも、絞らない答が
   * 返る。畫面の推薦モードもチップを無視する（`site/app.ts` の `if (!inRecommend && …）`）ので、
   * **其れと同じ** – 順位で選ぶのが畫面と同じ用法。ただし**黙って捨てない**。 */
  const 題 = "Time-Sensitive Networking | tsn";
  const 素 = await call("recommend_venues", { paper: 題, limit: 2 });
  expect(素.split("\n")[0] ?? "", "絞り込みが無い時に名指した").not.toContain("無視した絞り込み");
  for (const 鍵 of ["rank", "domestic", "online", "scope", "within_days", "include_past"]) {
    const 答 = await call("recommend_venues", {
      paper: 題,
      limit: 2,
      [鍵]: 鍵 === "rank" ? "A" : true,
    });
    expect(答, `\`${鍵}\` を渡しても名指して居ん`).toContain("無視した絞り込み");
    expect(答.split("\n")[0] ?? "", `\`${鍵}\` の名前が出て居ん`).toContain(鍵);
    /* 絞り込まないことを文字でも示す（順位で選ぶ）。 */
    expect(答, "順位で選ぶ謀を言つて居ん").toContain("順位と点で選びます");
  }
  /* 空文字の絞り込みは「渡して無い」と見る（混入した空値で騒音を増やさない）。 */
  const 空 = await call("recommend_venues", { paper: 題, limit: 2, rank: "" });
  expect(空.split("\n")[0] ?? "", "空文字列で名指した").not.toContain("無視した絞り込み");
});

it("二つ與えた片方を黙って捨てない（第 921 回）", async () => {
  /* 默って片方を捨てると、讀む人は両方効いたと思ふ。二つの道具で其れが在つた（實測 2026-11-09）。 */
  const 檢 = await call("search_deadlines", {
    query: "セキュリティ",
    kinds: ["paper"],
    kind: "notification",
    limit: 1,
  });
  expect(檢.split("\n")[0] ?? "", "`kinds` と `kind` を両方渡しても名指して居ん").toContain(
    "kind は kinds と共に与えられたので見て居ません",
  );
  /* 片方だけなら名指さない（騒音を増やさない）。 */
  const 片 = await call("search_deadlines", { query: "セキュリティ", kind: "paper", limit: 1 });
  expect(片.split("\n")[0] ?? "", "片方だけなのに名指した").not.toContain("見て居ません");
  /* どちらを渡しても答えは同じ（`kinds` が勝つ – 第 727 回の約束）。 */
  const 両方 = await call("search_deadlines", {
    query: "セキュリティ",
    kinds: ["paper"],
    kind: "notification",
    limit: 1,
  });
  const 件數 = (t: string): string => /締切: ([\d,]+) 件/.exec(t)?.[1] ?? "-1";
  expect(件數(両方), "`kind` を効かせてしまつた").toBe(件數(片));
  /* venue_info も – `key` と `name` を両方渡した時は `name` を見て居ない。 */
  const 會 = await call("venue_info", { key: "sigkdd", name: "ICDE" });
  expect(會, "`key` と `name` を両方渡しても名指して居ん").toContain(
    "name は key と共に与えられたので見て居ません",
  );
  const 片會 = await call("venue_info", { key: "sigkdd" });
  expect(片會, "片方だけなのに名指した").not.toContain("見て居ません");
  /* 空文字は「渡して無い」と見る。 */
  const 空 = await call("venue_info", { key: "sigkdd", name: "" });
  expect(空, "空文字列で名指した").not.toContain("見て居ません");
});

it("collection_stats も絞り込みの引数を黙って捨てない（第 922 回）", async () => {
  /* この道具は収録の全体を數へる物（行から數へると「締切を持つ物」だけに成り、建てた表示と
   * 食ひ違ふ – 第 769 回）。`scope` を渡す AI が居ても**黙って捨てない** – 第 920・921 と同じ
   * 括り（この道具で絞り込めないことを、名前で示す）。 */
  const 素 = await call("collection_stats", {});
  expect(素.split("\n")[0] ?? "", "絞り込みが無い時に注を付けた").not.toContain("無視した絞り込み");
  const 付 = await call("collection_stats", { scope: "screen" });
  expect(付.split("\n")[0] ?? "", "`scope` を渡しても名指して居ん").toContain(
    "無視した絞り込み scope",
  );
  expect(付.split("\n")[0] ?? "", "収録の全体を数えます の語が無い").toContain(
    "収録の全体を数えます",
  );
  /* 数そのものは変わらない（絞り込んで居ないことの証明）。 */
  const 数 = (t: string): string => (t.match(/会議 [\d,]+ 件/) ?? [""])[0];
  expect(数(付), "絞り込んで居ない（件数が同じ）").toBe(数(素));
  /* 空文字は「渡して無い」と見る。 */
  const 空 = await call("collection_stats", { scope: "" });
  expect(空.split("\n")[0] ?? "", "空文字列で注を付けた").not.toContain("無視した絞り込み");
});

it("limit は整数で、打ち切って無い時は言わない（第 924 回）", async () => {
  /* 實測 2026-11-10: `limit: 3.7` で「3.7 件まで表示」と出て、`slice(0, 3.7)` の 3 行と
   * 数が合わない文になった。また 37 件しか無い時に `limit: 50` を渡すと「50 件まで表示」と
   * 書きながら 37 行しか出ない – 読む人は 50 行が来ると思ふ。 */
  const 全文 = (t: string): string => t;
  const 劈いた = async (l: unknown): Promise<string> =>
    全文(await call("search_deadlines", { query: "セキュリティ", limit: l }));
  const 行數 = (t: string): number => t.split("\n").filter((l) => /^20\d\d-/.test(l)).length;

  /* 打ち切る時は limit を言って、行數と一致する。 */
  const t = await call("search_deadlines", { query: "セキュリティ", limit: 100 });
  const 全部の件 = Number(
    (/に当たる締切: ([\d,]+) 件/.exec(t.split("\n")[0] ?? "") ?? [0, "0"])[1].replace(/,/g, ""),
  );
  const 五 = await 劈いた(5);
  expect(五.split("\n")[1] ?? "", "5 件で切り詰めた時に limit を言つて居ん").toContain(
    `5 件まで表示・残り ${全部の件 - 5} 件`,
  );
  expect(行數(五), "5 件まで表示なのに 5 行出て居ない").toBe(5);

  /* 小数は**切り捨て**（3.7 は 3 行、且つ文も整数）。 */
  const 小 = await 劈いた(3.7);
  expect(行數(小), "3.7 を 3 行に切り詰めなかった").toBe(3);
  expect(小.split("\n")[1] ?? "", "小数をそのまま書いた").toContain("3 件まで表示");
  expect(小.split("\n")[1] ?? "", "小数點が传来的").not.toContain(".");

  /* 打ち切って居ないなら limit を言わない（37 件しか無いのに「50 件まで表示」と言わない）。 */
  const 五十 = await 劈いた(50);
  expect(五十.split("\n")[1] ?? "", "切り詰めて居ないのに limit を言つた").not.toContain(
    "件まで表示",
  );
  expect(行數(五十), `${全部の件} 件全部が出て居ない`).toBe(全部の件);

  /* 推薦の道具も同じ（同じ書き方にした – 讀む人が二つで違う数字を見るのは，讀む人が二つの道具で違うのを見るのは、最も見つけ難い方だから）。 */
  const 推 = await call("recommend_venues", {
    paper: "Time-Sensitive Networking | tsn, scheduling",
    limit: 3,
  });
  expect(推, "推薦で切り詰めた時に limit を言つて居ん").toContain("3 件まで表示");
});

it("explain_word も、切り詰めて居る時に其の旨を書く（第 925 回）", async () => {
  /* 實測 2026-11-11: 見出しは「37 行」と書きながら 3 行しか出て居なかった – 読む人は 37 行を
   * 當てる。第 924 回の `limit` と同じ括り（文は 37 行だが実際は 3 行だと思ふ）。 */
  /* 切り詰めがある時 */
  const 切替 = await call("explain_word", { word: "セキュリティ" });
  const 頭 = 切替.split("\n")[0] ?? "";
  expect(頭, "切り詰めて居るのに其の旨を書いて居ん").toContain("このうち 3 行を出します");
  expect(切替.split("\n").filter((l) => /^- 20\d\d-/.test(l)).length).toBe(3);
  /* 切り詰めが無い時は書かない（1 行しか無い語 – 騒音を増やさない）。 */
  const 一行 = await call("explain_word", { word: "ICDE" });
  expect(一行.split("\n")[0] ?? "", "1 行の語に切り詰めの文を付けた").not.toContain("このうち");
  /* 見える行數と「N 行」の N が矛盾しない（37 里有 3 行だと書く）。 */
  const 全部 = await call("explain_word", { word: "締切" });
  expect(全部.split("\n")[0] ?? "", "212 行の語に切り詰めの文が無い").toContain(
    "このうち 3 行を出します",
  );
});

it("名簿の注は、收錄全体にも締切の行があればそれを言う（第 928 回）", async () => {
  /* 實測 2026-11-13: `SOSP` を検索すると窓には 1 行も無いので名簿が「締切の行が 1 本もあり
   * ません」と言つたが、**收錄には 13 行ある** – 全部が過去のもの。AI は其の読み方だと
   * 「SOSP の締切は無い」と答えてしまう（実際は「公開済みの締切は過去のもの」）。 */
  const 窓 = await call("search_deadlines", { query: "SOSP", limit: 1 });
  const 行 = 窓.split("\n").filter((l) => /^- /.test(l) && l.includes("key:"));
  expect(行.length, "名簿の注が出て居ん（此の檢査の前提が崩れた）").toBeGreaterThan(0);
  expect(行[0], "收錄に締切の行があるのに「1 本も無い」と言つた").toContain(
    "この窓には締切の行がありませんが",
  );
  expect(行[0], "古い文言が残つて居る").not.toContain("締切の行が 1 本もありません");
  /* 收錄にも大字が無い會議は從來の言葉のまま – 其れを潰さない（此处の會議は窗に有る）。 */
  const 窓で有る = await call("search_deadlines", { query: "ICDE", limit: 1 });
  expect(窓で有る.split("\n")[0] ?? "", "有る會議が 0 件に成った").toContain("件");
});

it("名簿の注は、収録の締切の日まで畫面と同じ言葉で言う（第 929 回）", async () => {
  /* 畫面は品書の `record_deadline_last` / `record_deadline_next` から「収録にあるのは過ぎた
   * 締切（2026-04-02）だけ」と言う（`site/app.ts`）。MCP は第 928 回まで「収録には在ります」までしか
   * 言わなかった – 読む人は「いつ”的问题を持たない。言葉と出所を揃える。 */
  const text = await call("search_deadlines", { query: "SOSP", limit: 1 });
  const 注 = text.split("\n").find((l) => l.includes("key: sosp")) ?? "";
  expect(注, "名簿の注が出て居ん").not.toBe("");
  expect(注, "収録にある日を名指して居ん").toMatch(
    /収録にあるのは過ぎた締切（\d{4}-\d{2}-\d{2}）だけ/,
  );
  /* 未来の締切がある會議は、近い日を言う（畫面の第 298 回と同じ – 遠い日だけを示すと人は間の
   * 締切を見落とす）。 */
  const 有る = await call("search_deadlines", { query: "ICDE", limit: 1 });
  expect(有る.split("\n")[0] ?? "", "ICDE が出て來ない").toMatch(/件/);
  /* 収録に何も無い會議の舊い文言は殘って居ない（SOSP の注と同じ形）。 */
  expect(注, "古い文言が残つて居る").not.toContain(
    'この窓には締切の行がありませんが、**収録には在ります**（scope: "all" で過去の分行が出せます）',
  );
});

it("名簿の注は、収録の推定の未来も名指す（第 930 回）", async () => {
  /* 品書の `record_deadline_next` は**確認できた日だけ**を数へる（推定の行は `utc` が無いので
   * 入らない – 實測 2026-11-14: `SOSP` に推定の 2027-03-19 が在るのに、品書の申告は空だつた）。
   * 畫面は仕様通り「過ぎた締切（2026-04-02）だけ」と言う – 讀む人は其れで足りる。MCP は收錄の
   * 行を持つので、**推定なら何日か**も言へる（研究者なら其の推定の日も知りたい）。 */
  const text = await call("search_deadlines", { query: "SOSP", limit: 1 });
  const 注 = text.split("\n").find((l) => l.includes("key: sosp")) ?? "";
  expect(注, "名簿の注が出て居ん").not.toBe("");
  expect(注, "推定の未来を名指して居ん").toContain("推定なら");
  expect(注, "推定の日に確約と書いて居る（確かではない）").toContain("確約では無い");
  /* 推定の日が actual と一致する（画面に出るのは `venue_info` の推定の行）。 */
  const 室 = await call("venue_info", { key: "sosp", scope: "all" });
  /* **推定の行は幅を出す**（第 1034 回）ので、「次の投稿締切: 」の後ろは
   * YYYY-MM-DD とも「推定期間 A〜B」とも成る。此の檢查が欲しいのは**點推定点**の日
   * （名簿の注が言ふ「推定なら <日>」と同じ物）なので、幅の時は「元の宣言」の瞬間を見る。 */
  const 次の投稿 = 室.split("\n").find((l) => l.startsWith("次の投稿締切: ")) ?? "";
  const 日 =
    /次の投稿締切: (\d{4}-\d{2}-\d{2})/.exec(次の投稿)?.[1] ??
    /元の宣言 [^／]*／(\d{4}-\d{2}-\d{2})/.exec(次の投稿)?.[1] ??
    "";
  expect(注, `推定の日（${日}）と名簿の注が違ふ`).toContain(日);
});

it("相対の語がどう解けたかを頭に書く（畫面と同じ – 第 936・940 回）", async () => {
  /* 實測 2026-11-08: 畫面は件數欄に「今月 = 2026年の締切」の形で展開結果を出すが、MCP は
   * 「今月」に当たる件數だけで、**何年何月を引いたか**が分からなかった – 同じ語「今月」でも
   * 結果は実行した日に依るので、AI が答える時には其の解が必要。同じ函數 `relativeDayNotes` を
   * 使ふので、畫面と同じ事實が同じ言葉で出る。
   *
   * 第 940 回では、その注が**年全体**だと書く噓でもあることが分かった（`2026年11月` は 237 行・
   * `2026年` は 802 行 – 其の月しか引かない）。今は「其の月だけ」と名乗る。 */
  const 注 = async (語: string): Promise<string> =>
    (await call("search_deadlines", { query: 語, limit: 1 }))
      .split("\n")
      .find((l) => l.startsWith("判定:")) ?? "";
  expect(await 注("今月"), "「今月」の解が出て居ん").toMatch(/^判定: \d{4}年\d{1,2}月 = /);
  expect(await 注("来月"), "「来月」の解が出て居ん").toMatch(/^判定: \d{4}年\d{1,2}月 = /);
  /* **其の月だけ**と名乗る（年全体だと書くと行の數と合わない – 第 940 回）。 */
  for (const 語 of ["今月", "来月"]) {
    const 文 = await 注(語);
    expect(文, `「${語}」に其の月だと書いて居ん`).toContain("其の月だけ");
    expect(文, `「${語}」を年全体と言つて居る（嘘）`).not.toContain("1〜12 か月");
  }
  /* 年の語（全体を見る形）は從來の文 – 其れは噓ではない。 */
  expect(await 注("2026年")).toContain("1〜12 か月");
  /* 幅の言い方でも、**何月を見たか**は同じく出る（實測: `来月まで` は展開の段で幅の語尾が
   * 落ちて `2026年11月` になる – 月の判定は其れに當然合ふ）。幅の受け方は此の道具には無いので、
   * 其の旨は頭の「日付は日本時間」の斷りが受け持つ。 */
  expect(await 注("来月まで"), "幅の言い方に月の判定が出て居ん").toMatch(
    /^判定: \d{4}年\d{1,2}月 = /,
  );
  /* 展開できない形に判定を出さない（騒音を増やさない – `2026年` だけは年その物）。 */
  expect(await 注("セキュリティ"), "普通の語に判定を出した").toBe("");
});

it("曖昧な語の常時の案内を出す（畫面と同じ – 第 942 回）", async () => {
  /* 實測 2026-11-09: 畫面は `ics` を打つと件數欄に「二つの物があり得ます」の案内を出すが、
   * MCP は行を出すだけで何も言はなかつた – AI が「カレンダーのファイルは？」と聞かれて
   * 會議の行を返すのと同じ結果になる。畫面と同じ `uiWordAlwaysNoteJa` を使ふ。 */
  const 答 = await call("search_deadlines", { query: "ics", limit: 3 });
  const 案内 = 答.split("\n").find((l) => l.startsWith("「ics」のことなら")) ?? "";
  expect(案内, "曖昧さの案内が出て居ん").not.toBe("");
  expect(案内).toContain("二つの物があり得ます");
  /* 此の道具を使ふ AI に、配付物の名を添える（畫面の UI の名は此では使へない）。第 948 回で
   * 類語の注と同じ經路に纏めたので、文は其の侭に括弧が無い行に成つた。 */
  const 添 = 答.split("\n").find((l) => l.startsWith("この道具が出せるのは行だけです")) ?? "";
  expect(添, "配付物の名が出て居ん").toContain("deadlines.ics");
  /* 行が出ない時は出さない（0 件案内が同じ事を言ふ – 畫面と同じ決まり）。 */
  for (const 語 of ["セキュリティ", "締切"]) {
    const 素 = await call("search_deadlines", { query: 語, limit: 3 });
    expect(素, `「${語}」に關係無い案内が出た`).not.toContain("この道具が出せるのは行だけです");
  }
});

describe("list_upcoming の行が畫面と同じ（第 944 回）", () => {
  /* 第 874・910 回は**件數**を見た。**どの行**かまでは見て居なかつた – 件數が同じでも
   * 畫面と別の行を返して居る事があり得る（AI が「この會議は來ない」と答へると誤る）。
   *
   * 此の道具は**種別で絞らない**（設計 – 說明にも書いてある）ので、畫面の同等物は「種別の
   * 篩を掛けない defaults の一覽」= `upcoming.md` と同じ行。畫面の `filter` で
   * `kind: ""`（篩）・同じ窓にして突き合はせる。 */
  const 品書 = join(REPO_ROOT, "public", "catalog.json");
  it("同じ窓で、同じ行を返す", async () => {
    if (!existsSync(品書)) return;
    const html = siteRuntime();
    const rowsFile = join(tmpdir(), `kamiyobi-screen-upcoming-${process.pid}.json`);
    writeFileSync(
      rowsFile,
      JSON.stringify(Recommender.candidateRows(JSON.parse(readFileSync(品書, "utf8")))),
    );
    afterAll(() => rmSync(rowsFile, { force: true }));
    const 畫面の行 = (win: string): string[] => {
      const script = [
        "const DAY = 86400000;",
        `const FILTER = ${JSON.stringify(jsFunction(html, "filter"))};`,
        `const NOW = ${Date.now()};`,
        "class FakeDate extends Date { static now() { return NOW; } }",
        "const fs = require('node:fs');",
        `const catalog = JSON.parse(fs.readFileSync(${JSON.stringify(品書)}, 'utf8'));`,
        FILTER_RUNTIME_STUBS,
        `const rows = JSON.parse(fs.readFileSync(${JSON.stringify(rowsFile)}, 'utf8'));`,
        "const filter = new Function('Date','DAY','rows','state','sortAsc','sortKey',",
        "  'return (' + FILTER + ')')(FakeDate, DAY, rows, JSON.parse(process.env.STATE), false, 'time');",
        "console.log(JSON.stringify([...new Set(filter().map((r) => r.ed.id))].sort()));",
      ].join("\n");
      const proc = spawnSync("node", ["-e", vmSafeSource(script)], {
        encoding: "utf8",
        timeout: 120_000,
        env: {
          ...process.env,
          /* `list_upcoming` は**推定も既定で入れる**（説明に書いてある – `search_deadlines` の
           * 既定は外す）。條件を揃へるので畫面の state も推定を入れる。 */
          STATE: JSON.stringify({ q: "", cats: [], kind: "", rank: "", win, est: true }),
        },
      });
      expect(proc.status, `畫面の絞り込みが動かない（${win}）: ${proc.stderr.slice(0, 300)}`).toBe(
        0,
      );
      return JSON.parse(proc.stdout.trim()) as string[];
    };
    /* 窓は**行數が 100 を超えない物**にする（此の道具は 100 行を超えると打ち切る – 齊に
     * 入らない行が出る）。180 日も**品書の果て**（建造日の 180 日ぶん）を越えるので外す –
     * 畫面は品書の切れ目で停まる（第 293 回の同じ約束）に対し、道具は今日からの N 日を數へる。
     * 品書の中に納まり、100 行にも納まる 7 日と 30 日で。 */
    for (const days of [7, 30]) {
      /* `list_upcoming` は**種別で絞らない**（設計 – 説明にも書いてある）ので、畫面の
       * defaults の一覽（投稿締切だけ）と齊が違ふ。齊を合はせる為に**同じ種別**を渡す –
       * `kinds` は此の道具も畫面と同じ種別名で受ける（第 727 回）。 */
      const 答 = await call("list_upcoming", {
        days,
        kinds: ["abstract", "paper", "journal"],
        limit: 400,
      });
      const mcp = [
        ...new Set([...答.matchAll(/（([a-z0-9][a-z0-9.'-]*)）/g)].map((m) => m[1])),
      ].sort();
      const 畫面 = 畫面の行(`${days}d`);
      if (process.env.DBG_UPCOMING) {
        const a = new Set(mcp);
        const b = new Set(畫面);
        console.log("DBG MCP だけ:", [...a].filter((x) => !b.has(x)).slice(0, 10));
        console.log("DBG 畫面だけ:", [...b].filter((x) => !a.has(x)).slice(0, 14));
      }
      expect(mcp, `list_upcoming と畫面の行が違ふ（${days} 日）`).toEqual(畫面);
    }
  });
});

it("venue_info は過去の締切も出して、其の札を書く（第 945 回）", async () => {
  /* 實測 2026-11-09: `venue_info({key: "icde"})` は 21 行を返すが、そのうち 17 行は過去 – 説明
   * には「今後の物から並ぶ」としか書いてなくて、**過去が入る事**が讀めなかつた。AI が
   * 「今後の締切は 21 件」と答へると 17 件多い。過去は参考になるので出すのは變へない
   * （venue の詳細の役目）が、**入る事を書く**。 */
  const 答 = await call("venue_info", { key: "icde" });
  const 行 = 答.split("\n").filter((l) => /^20\d\d-/.test(l));
  const 過ぎた = 行.filter((l) => l.includes("残り（過ぎた）"));
  expect(過ぎた.length, "過去の行が出て居ない（此の檢査の前提が崩れた）").toBeGreaterThan(0);
  expect(過ぎた.length).toBeLessThan(行.length);
  /* 過去の行はどれも札を持つ（無札だと「これから」の行に見える）。 */
  for (const l of 行) {
    if (l.includes("20")) expect(l.length, "行が空").toBeGreaterThan(10);
  }
  /* 將來の行は「殘り」の札が付く（第 843 回と同じ形）。 */
  expect(行.some((l) => /殘り\d+日|殘り\d+時間/.test(l)) ? true : / /).toBeTruthy();
  /* 説明にも書いた（道具の一覽の文 – AI は先にそれを讀む）。 */
  const 一覽 = (await client.ask({ jsonrpc: "2.0", id: 97, method: "tools/list" })) as {
    result?: { tools?: Array<{ name?: string; description?: string }> };
  };
  const 説明 = (一覽.result?.tools ?? []).find((t) => t.name === "venue_info")?.description ?? "";
  expect(説明, "venue_info の説明が讀めない（此の檢査の前提が崩れた）").not.toBe("");
  expect(説明, "過去が出ると書いて居ない").toContain("過ぎた分も全部出る");

  /* 推薦の**截り**も説明に書く（第 954 回で入れた 20 行 – AI は先に説明を讀む）。 */
  const 推薦 =
    (一覽.result?.tools ?? []).find((t) => t.name === "recommend_venues")?.description ?? "";
  expect(推薦, "推薦の截りを說明に書いて居ない").toContain("最初の 20 行");
});

it("曖昧な名の候補は、一番新しい版の繋ぎ先を添へる（第 946 回）", async () => {
  /* 實測 2026-11-10: `venue_info({name: "KDD"})` の候補が `kdd.org/kdd2021/` を出して居た –
   * 探して居る人は 2027 の KDD なのに、2021 の頁に送る。繋ぎ先は候補を選ぶための物なので、
   * **探して居る側の年**でなければ意味が無い（第 750 回で足した物の意圖 – 選べる様にする）。 */
  const 答 = await call("venue_info", { name: "KDD" });
  const 候補 = 答.split("\n").filter((l) => l.startsWith("- "));
  expect(候補.length, "候補が出て居ない（この檢查の前提が崩れた）").toBeGreaterThan(1);
  for (const l of 候補) {
    const url = /(https?:\/\/\S+)/.exec(l)?.[1] ?? "";
    if (!url) continue;
    expect(url, `候補の繋ぎ先が古い年版: ${l}`).not.toMatch(/20(1[0-9]|2[0-5])\b/);
  }
  /* 一番新しい版の link（`kdd2027`）を出す。 */
  const kdd = 候補.find((l) => l.includes("key: sigkdd")) ?? "";
  expect(kdd, "KDD の候補に繋ぎ先が無い").toMatch(/https?:\/\//);
  expect(kdd, "一番新しい版の繋ぎ先では無い").toContain("kdd2027");
  /* 他の會議でも同じ（古い link を出して居る會議が他にも在る – 實測 2026-11-10 で
   * 年が 6 以上離れた會議が 122 件在つた。其の中から 5 つを見る）。 */
  for (const [名, 鍵] of [
    ["SOSP", "sosp"],
    ["NSDI", "nsdi"],
    ["CCS", "ccs"],
    ["AAAI", "aaai"],
    ["3DV", "3dv"],
  ] as Array<[string, string]>) {
    const 答 = await call("venue_info", { name: 名 });
    const 行 = 答.split("\n").find((l) => l.includes(`key: ${鍵}`));
    if (行 === undefined) continue; // 曖昧で無い（一つに決まる）會議は此の檢查の對象外
    expect(行, `${名} の候補の繋ぎ先が古い年版: ${行}`).not.toMatch(/20(1[0-9]|2[0-5])\b/);
  }
});

it("見えて居る行にも、畫面が添える注を出す（第 948 回）", async () => {
  /* 實測 2026-11-11: 畫面は `ランク` を打つと件數欄に
   * 「「ランク」だけでは等級を絞れていません…」を出す（`app.ts` の `synonymNotes`）。
   * MCP は行を出すだけで其れを言はなかつた – AI が「ランクだけで等級を絞れた」と誤解する。
   * 0 件の時だけ出す `guidance` では足りない（行が見えて居る時が**むしろ罠**）。 */
  for (const 道具 of ["search_deadlines", "explain_word"] as const) {
    const 答 =
      道具 === "search_deadlines"
        ? await call("search_deadlines", { query: "ランク", limit: 3 })
        : await call("explain_word", { word: "ランク" });
    expect(答, `${道具} に類語の注が出て居ん`).toContain("「ランク」だけでは等級を絞れていません");
  }
  /* 關係無い語には出さない（騒音を増やさない – 第 852 回と同じ）。 */
  const 無 = await call("search_deadlines", { query: "セキュリティ", limit: 3 });
  expect(無, "無關係な語に類語の注が出た").not.toContain("だけでは");
  /* 曖昧な語の方も、此の經路から出る（第 942 回と同じ文 – 重ねて出さない）。 */
  const 曖昧 = await call("explain_word", { word: "ics" });
  expect(曖昧, "explain_word に曖昧さの注が出て居ん").toContain("二つの物があり得ます");
  expect(曖昧.split("\n").filter((l) => l.includes("この道具が出せるのは行だけ")).length).toBe(1);
});

it("長い論文は最初の 20 行だけを見て、其の旨を言ふ（第 954 回）", async () => {
  /* 實測 2026-11-13: AI に論文の全文を送らせると**固まつた** – 1,000 行（39 KB）で
   * 120 秒逾も answer しなかつた（推薦は會議のまとまり 696 ごとに論文の行を見るので、
   * 行が增えると掛け算で膨らむ。100 行で 16 秒）。切るのは信號の無い部分 – 題名と概要が
   * 候補を決め、1000 行の本文は何も增やさない。**默つて切ると「參考にして居ない」がばれる**
   * ので、頭に書く。 */
  const 長い = Array.from({ length: 500 }, (_, i) => `提案手法の説明 ${i}`).join("\n");
  const t0 = Date.now();
  const 答 = await call("recommend_venues", { paper: 長い, limit: 3 });
  const かかつた = Date.now() - t0;
  expect(答.split("\\n")[0] ?? "", "500 行の論文を切り詰めずに居る").toContain(
    "500 行のうち、最初の 20 行（題名・概要）で調べました",
  );
  /* **速い** – 20 行で打ち切るので、何行來ても同じ（實測: 3.5 秒）。 */
  expect(かかつた, `推薦が遅い（${かかつた}ms – 打ち切れて居ない）`).toBeLessThan(30_000);
  /* 短い論文は何も足さない（騒音を增やさない – 第 852 回と同じ決まり）。 */
  const 短い = await call("recommend_venues", {
    paper: "Time-Sensitive Networking | tsn",
    limit: 3,
  });
  expect(短い, "短い論文に截りの文を付けた").not.toContain("行のうち、最初の");
});

it("venue_info は過去の件數を頭で言ふ（第 961 回）", async () => {
  /* 實測 2026-11-14: `venue icde` は 21 件のうち **17 件が過ぎた物** – 行ごとに「（過ぎた）」と
   * 書いてあるが、AI が 21 行を数えて「21 件の締切がある」と答へる方が自然。何件が過去かを
   * 頭で言ふ（`search_deadlines` の「絞る前は N 行」と同じ役目）。 */
  const 答 = await call("venue_info", { key: "icde" });
  const 行 = 答.split("\n").filter((l) => /^20\d\d-/.test(l));
  const 過去 = 行.filter((l) => l.includes("（過ぎた）")).length;
  expect(過去, "過去の行が無い（この檢查の前提が崩れた）").toBeGreaterThan(0);
  expect(過去).toBeLessThan(行.length);
  expect(答, "過去の件數を頭で言つて居ん").toMatch(new RegExp(`過去は ${過去} 件`));
  /* 切り詰めと兩立する（96 件の會議 – VLDB）。 */
  const 長い = await call("venue_info", { key: "vldb" });
  const 頭 = 長い.split("\n").find((l) => l.startsWith("締切と会期")) ?? "";
  expect(頭, "切り詰めの件數が無い").toMatch(/\d+ 件のうち 60 件/);
  expect(頭, "切り詰めと過去の件數が兩立して居ん").toMatch(/・過去は \d+ 件/);
});

it("名簿の注は、窓に行が在る會議でも推定の日を言ふ（第 964 回）", async () => {
  /* 第 930 回で SOSP（窓に 1 行も無い）に「推定なら <日> も在ります」を添へた。**窓に行が
   * 在る會議**では添へて居なかつた – 實測 2026-11-14: `TrustCom` は此の窓に 1 行在るが
   * 全部過去で、唯一の未來が**推定**（2027-09-21）だつた。「絞り込みを外すと出ます」だけ
   * では AI がその日を言へない（「推定の締切は？」との問に答えられない）。 */
  const 答 = await call("search_deadlines", { query: "TrustCom", limit: 1 });
  const 注 = 答.split("\\n").find((l) => l.includes("key: trustcom")) ?? "";
  expect(注, "名簿の注が出て居ん").not.toBe("");
  expect(注, "窓の分の話が出て居ん").toContain("締切の行は在りますが");
  expect(注, "推定の日を名指して居ん").toContain("推定なら");
  expect(注, "確約ではない事を言つて居ん").toContain("確約では無い");
  expect(注, "include_estimated を教へて居ん").toContain("include_estimated");
  /* 推定の**無い**會議に足さない（第 852 回と同じ決まり – SOSP は添はるが KDD は添はない）。 */
  /* **推定の日の形**を見る（實際の日付が入つて居る – 空の文だと讀めない）。 */
  expect(注, "推定の日が讀めない").toMatch(/推定なら \d{4}-\d{2}-\d{2} も在ります/);
  /* 幅を持つ推定の版でも、**點推定点**の日を名指す（第 1034 回 – 幅全体は行の方に
   * 出る。此の注は「次の日はいつか」を答へる場所なので、點推定点で足りる）。 */
  expect(注, "點推定点の日が讀めない").toMatch(/推定なら 20\d{2}-\d{2}-\d{2} も在ります/);
});

describe("名簿の注は、全部の會議で事實と合ふ（第 968 回）", () => {
  /* 第 928〜964 回で三段の名簿の注を作つた。**悉皆**を確かめた回（第 967 回 – 696 會議を
   * 全部叩いて 0 件の誤り）。其れは 9 分かかるのでCIには入れられない – **間引きした 20 會議**
   * （35 番目ごと）で同じ四つの事實を見る。 */
  const 會議 =
    (
      JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as {
        conferences?: Array<Record<string, unknown>>;
      }
    ).conferences ?? [];
  const 題の一覽 = 會議.map((c) => ({
    key: String(c.key ?? ""),
    題: String(c.title ?? ""),
    行: ((c.editions ?? []) as unknown[]).flatMap((e) =>
      ((e as { deadlines?: unknown[] }).deadlines ?? []).map(() => 1),
    ).length,
    推定: ((c.editions ?? []) as unknown[]).some(
      (e) => (e as { estimated?: boolean }).estimated === true,
    ),
    推定の未來: ((c.editions ?? []) as Array<Record<string, unknown>>).reduce(
      (n: number, e: Record<string, unknown>) => {
        if (e.estimated !== true) return n;
        return (
          n +
          ((e.deadlines ?? []) as Array<Record<string, unknown>>).filter(
            (d) => Date.parse(String(d.utc ?? "")) > Date.now(),
          ).length
        );
      },
      0,
    ),
  }));
  it("四つの事實が、注の言ふ事と合ふ", async () => {
    const 樣本 = 題の一覽.filter((_, i) => i % 35 === 0);
    expect(樣本.length, "間引きの結果が空（會議が讀めて居ない）").toBeGreaterThan(15);
    for (const c of 樣本) {
      const 答 = await call("search_deadlines", { query: c.題, limit: 1, scope: "all" });
      const 注 = 答.split("\n").find((l) => l.startsWith("- ") && l.includes(`key: ${c.key}`));
      if (!注) continue;
      /* 1. 「行は在ります」は行が無い會議に言はない */
      if (注.includes("締切の行は在りますが")) {
        expect(c.行, `「${c.key}」に行が無いのに「行は在ります」と言つた`).toBeGreaterThan(0);
      }
      /* 2. 「1 本もありません」は行が在る會議に言はない */
      if (注.includes("締切の行が 1 本もありません")) {
        expect(c.行, `「${c.key}」に行が ${c.行} あるのに「1 本もありません」と言つた`).toBe(0);
      }
      /* 3. 「推定なら」は推定の版が無い會議に言はない */
      if (注.includes("推定なら")) {
        expect(c.推定, `「${c.key}」に推定の版が無いのに「推定なら」と言つた`).toBe(true);
      }
      /* 4. 未來の推定が在る會議は「推定なら」を言ふ（第 964 回） */
      if (c.推定の未來 > 0) {
        expect(注, `「${c.key}」に未來の推定が ${c.推定の未來} 行あるのに言つて居ない`).toContain(
          "推定なら",
        );
      }
    }
  });
});

describe("venue_info は版の一覽を收錄通りに出す（第 969 回）", () => {
  /* 第 967 回の**悉皆**で見つけた本物 – 實測 2026-11-16: `venue siggraph` は 8 版のうち
   * 6 版しか出して居なかつた。落ちた 2 版は**締切が 1 本も無い版**で、`siggraph27`
   * （2027 年の一番新しい版）が其の中にあつた。「この會議の版」を聞いた人が一番知りたい版が
   * 見えない。版の一覽は**行ではなく收錄その物**から組む（第 866 回と同じ決まり – 締切が無い
   * 版は「(会期だけ)」と添へて、無いことを「無い」と區別する）。
   *
   * 悉皆（696 會議）は 0 件の誤り。CI では**間引き**して同じ事實を見る。 */
  const 會議 =
    (
      JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as {
        conferences?: Array<Record<string, unknown>>;
      }
    ).conferences ?? [];
  const 投稿の種別 = new Set(["abstract", "paper", "journal"]);
  it("版の一覽と「次の投稿締切」が事實と合ふ", async () => {
    const 樣本 = 會議.filter((_, i) => i % 35 === 0);
    expect(樣本.length, "間引きの結果が空").toBeGreaterThan(15);
    for (const c of 樣本) {
      const key = String(c.key ?? "");
      const 答 = await call("venue_info", { key, scope: "all" });
      const 版の行 = 答.split("\n").find((l) => l.startsWith("版: ")) ?? "";
      const 本の版 = ((c.editions ?? []) as unknown[]).length;
      if (版の行) {
        const 版 = 版の行
          .replace(/^版: /, "")
          .split(" / ")
          .filter((v) => v.length > 0);
        expect(版.length, `「${key}」の版の數が收錄と違ふ（${版.length} ／ ${本の版}）`).toBe(
          本の版,
        );
      } else {
        /* 締切が 1 本も無い會議は「版 N 件」の形（第 866 回 – 其れも事實を言つて居る）*/
        const 件の形 = /版 (\d+) 件/.exec(答);
        expect(件の形, `「${key}」の版の言ひ方が讀めない`).not.toBeNull();
        expect(Number(件の形?.[1]), `「${key}」の版の數が違ふ`).toBe(本の版);
      }
      /* 「次の投稿締切」は**投稿の種別で一番近い未來**（第 893 回の約束）。*/
      const 次の行 = 答.split("\n").find((l) => l.startsWith("次の投稿締切: ")) ?? "";
      const 本の次 = ((c.editions ?? []) as unknown[])
        .flatMap((e) => {
          const dls = (e as { deadlines?: unknown[] }).deadlines ?? [];
          return dls.map((d) => ({
            版: String((e as { id?: unknown }).id ?? ""),
            日: Date.parse(String((d as { utc?: unknown }).utc ?? "")),
            種別: String((d as { kind?: unknown }).kind ?? ""),
          }));
        })
        .filter((x) => 投稿の種別.has(x.種別) && Number.isFinite(x.日) && x.日 > Date.now())
        .sort((a, b) => a.日 - b.日)[0];
      if (本の次 === undefined) {
        expect(
          答,
          `「${key}」に未來の投稿締切が無いのに「次の投稿締切」を出して居る`,
        ).not.toContain("次の投稿締切: 2");
      } else {
        /* **推定の行は幅を出す**（第 1034 回）ので、「次の投稿締切: 」の後ろは
         * YYYY-MM-DD とも「推定期間 A〜B」とも成る。點推定点は「元の宣言」の瞬間を見る。 */
        const m = /次の投稿締切: (\d{4}-\d{2}-\d{2})/.exec(次の行);
        const 幅の行 = /次の投稿締切: 推定期間 (\d{4}-\d{2}-\d{2})〜(\d{4}-\d{2}-\d{2})/.exec(
          次の行,
        );
        const 點 = /元の宣言 [^／]*／(\d{4}-\d{2}-\d{2})/.exec(次の行);
        const 取つた日 = m?.[1] ?? 點?.[1];
        expect(
          取つた日,
          `「${key}」に未來の投稿締切が在るのに言つて居ん（幅の行: ${次の行.slice(0, 60)}）`,
        ).toBeTruthy();
        if (!m?.[1] && 幅の行) {
          /* 幅を出して居る時、點推定点は幅の中に收まつて居なければならない（整合）。 */
          const 始め = Date.parse(`${幅の行[1]}T00:00:00Z`);
          const 終り = Date.parse(`${幅の行[2]}T00:00:00Z`);
          const 點日 = Date.parse(`${點?.[1]}T00:00:00Z`);
          expect(
            點日 >= 始め && 點日 <= 終り,
            `「${key}」の點推定点 ${點?.[1]} が幅 ${幅の行[1]}〜${幅の行[2]} の外に在る`,
          ).toBe(true);
        }
        const 使ふ日 = m ?? 點;
        const 言つた日 = Date.parse(`${使ふ日?.[1]}T00:00:00Z`);
        expect(
          Math.abs(言つた日 - 本の次.日),
          `「${key}」の次の投稿締切が ${m?.[1]}（本物 ${new Date(本の次.日).toISOString().slice(0, 10)}・${本の次.版}）`,
        ).toBeLessThanOrEqual(2 * 86400000);
      }
    }
  });
});

describe("行は表示の早さで並ぶ（第 970 回）", () => {
  /* 實測 2026-11-16: `t`（一番早い可能性の瞬間）で並べると、**表示と食ひ違ふ順**に出た。
   * `ipsj-27-m26` は「2026-11-27（時刻未確認）」と表示するのに、`t` はタイムゾーンの
   * 取り得る範圍の先頭（UTC+14 の 0 時）なので、「2026-11-26(木) 20:59 JST」の行より
   * **先**に出た – 讀む人は「27 日なのに 26 日の上？」となる。畫面は「残り」の早さ
   * （`tShown`）で並べるので、此方も表示の刻みで並べる（同じパラグラフ）。 */
  const 問 = ["セキュリティ", "今月", "締切", "3月", "ICDE", "国内", "オンライン", "来月"];
  it("表示の日が昇順に並ぶ", async () => {
    for (const q of 問) {
      const 答 = await call("search_deadlines", { query: q, limit: 400 });
      const 行 = 答.split("\n").filter((l) => /^20\d\d-/.test(l));
      const 日 = 行.map((l) => l.slice(0, 10));
      const 崩れ = 日
        .map((d, i) => (i > 0 && 日[i - 1] > d ? `${日[i - 1]} → ${d}` : ""))
        .filter((x) => x.length > 0);
      expect(行.length, `「${q}」の行が讀めない（この檢查の前提が崩れた）`).toBeGreaterThan(0);
      expect(崩れ, `「${q}」で表示の日が昇順でない: ${崩れ.join("・")}`).toEqual([]);
    }
  });
  /* `list_upcoming` も同じ並び（`sortRows` は共用 – 第 970 回の直しで全部變はる）。 */
  it("list_upcoming も表示の日が昇順に並ぶ", async () => {
    const 答 = await call("list_upcoming", { days: 60, limit: 400 });
    const 行 = 答.split("\n").filter((l) => /^20\d\d-/.test(l));
    const 日 = 行.map((l) => l.slice(0, 10));
    const 崩れ = 日
      .map((d, i) => (i > 0 && 日[i - 1] > d ? `${日[i - 1]} → ${d}` : ""))
      .filter((x) => x.length > 0);
    expect(崩れ, `list_upcoming で表示の日が昇順でない: ${崩れ.join("・")}`).toEqual([]);
  });
});

it("記号だけの問は「絞り込みが効いて居ない」と言ふ（第 981 回）", async () => {
  /* 實測 2026-11-18: 「。」「・」「-」「！」は**語が 1 つも無い**ので `searchMatcher` が
   * 全部を通す述語を返し、**870 行全部**が「當たる」になつた。頭に「當たる締切: 212 件」
   * と出るので、讀む人は「。」で 212 件も引けると思ふ。默つて全部を返さない。 */
  for (const 問 of ["。", "-", "・", "！"]) {
    const 答 = await call("search_deadlines", { query: 問, limit: 2 });
    expect(答, `「${問}」で絞り込みが効いて居ないことを言つて居ん`).toContain(
      "絞り込みとして効く語がありません",
    );
    expect(答.split("\n")[1] ?? "", `「${問}」の註の行が讀めない`).toContain("記号だけ");
    /* 行は出す（畫面と同じ – 全部の行）。0 件にはしない。 */
    expect(
      答.split("\n").filter((l) => /^20\d\d-/.test(l)).length,
      `「${問}」の行が出て居ん`,
    ).toBeGreaterThan(0);
  }
  /* **番兵の文と同じ問**を誤認識しない – 實測 2026-11-19: 番兵を「絞り込みの番兵」にして
   * 居たので、「絞り込み」で搜した人まで「記号だけ」と言はれた。番兵は**分離子だけ**の文
   * （`・ー()`）で、どんな語の問も一致しないやうにして在る。 */
  for (const 問 of ["絞り込み", "番兵", "全部", "画面", "行を示して居ます"]) {
    const 答 = await call("search_deadlines", { query: 問, limit: 2 });
    expect(答, `「${問}」を記号だけと誤認識した`).not.toContain("絞り込みとして効く語がありません");
  }

  /* 語のある問には出さない（騒音を增やさない – 第 852 回と同じ決まり）。 */
  for (const 問 of ["セキュリティ", "KDD", "1"]) {
    const 答 = await call("search_deadlines", { query: 問, limit: 2 });
    expect(答, `「${問}」に關係無い斷りが出た`).not.toContain("絞り込みとして効く語がありません");
  }
  /* 他の篩り込みと**組み合はせても**出る（篩り込みが減つて居ても「質が記号だけ」は事實） */
  for (const 追 of [
    { domestic: true },
    { scope: "all" },
    { kinds: ["paper"] },
    { within_days: 30 },
  ]) {
    const 答 = await call("search_deadlines", { query: "。", limit: 2, ...追 });
    expect(答, `飾り込み ${JSON.stringify(追)} と組み合はせた時に注が出て居ん`).toContain(
      "絞り込みとして効く語がありません",
    );
  }

  /* 語と記號の**混在**は出さない（記號が尻に付くだけの普通の打ち方 – 實測 2026-11-19:
   * 「セキュリティ。」は 37 件のままで、記號だけでは無い）。KDD は全締切が過去なので
   * 0 件に成るが、其れでも「記号だけ」とは言はない（= 絞り込みは效いて居る）。 */
  for (const 問 of ["セキュリティ。", "セキュリティ・", "KDD。"]) {
    const 答 = await call("search_deadlines", { query: 問, limit: 2 });
    expect(答, `「${問}」を記号だけと誤認識した`).not.toContain("絞り込みとして効く語がありません");
  }

  /* 語を省いた呼び方にも出さない（「絞り込みだけ」は全部を示すのが筋）。 */
  const 素 = await call("search_deadlines", { kinds: ["paper"], limit: 2 });
  expect(素, "語を省いた呼び方に斷りが出た").not.toContain("絞り込みとして効く語がありません");
});

it("explain_word も、記号だけの語に「絞り込みが効いて居ない」と言ふ（第 985 回）", async () => {
  /* 實測 2026-11-19: `explain_word("。")` は「素の照合で **870 行**」と言つて居た – 全部に
   * 當たるので數が意味を成さない。`search_deadlines` の第 981 回と同じ括りで、此方にも注を
   * 足す（語を調べる人が「870 行も當たる」と誤解しない爲）。 */
  const 記號 = await call("explain_word", { word: "。" });
  expect(記號, "記号だけの語に注が出て居ん").toContain(
    "この語は記号だけなので、絞り込みとして効く語がありません",
  );
  /* 語のある語には出さない（第 852 回と同じ決まり）。 */
  for (const 語 of ["セキュリティ", "KDD", "締切"]) {
    const 答 = await call("explain_word", { word: 語 });
    expect(答, `「${語}」に關係無い注が出た`).not.toContain("この語は記号だけなので");
  }
  /* 混在（語 + 句點）にも出さない。 */
  const 混在 = await call("explain_word", { word: "セキュリティ。" });
  expect(混在, "混在を記号だけと誤認識した").not.toContain("この語は記号だけなので");
});

it("venue_info の確認の內訣は、その會議の行の數と合ふ（第 988 回）", async () => {
  /* 第 987 回で `collection_stats` の數を收錄で確かめた。**會議ごとの內訣**も
   * `venue_info` の「確認: …」で出て居る – 實測 2026-11-19: 100 會議（7 件おきに抽出）を
   * 叩いて **0 件の誤り**。此れを間引きで固定する（CI で全會議は 9 分かかる）。
   *
   * `manual-required` と `parser-failed` は畫面上「複数候補のため要確認」に**同じ札**で出る
   * ので、事實の方でも合算して比べる（第 912 回・第 987 回と同じ決まり）。 */
  const 收錄 = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as {
    conferences?: Array<Record<string, unknown>>;
  };
  const 樣本 = (收錄.conferences ?? []).filter((_, i) => i % 35 === 0);
  expect(樣本.length, "間引きの結果が空（會議が讀めて居ない）").toBeGreaterThan(15);
  for (const c of 樣本) {
    const key = String(c.key ?? "");
    if (!key) continue;
    const 答 = await call("venue_info", { key, scope: "all" });
    const 行 = 答.split("\n").find((l) => l.startsWith("確認: ")) ?? "";
    const 版々 = ((c.editions ?? []) as Array<Record<string, unknown>>).flatMap(
      (e) => (e.deadlines ?? []) as Array<Record<string, unknown>>,
    );
    let 複數 = 0;
    let 確認済み = 0;
    let 記録なし = 0;
    for (const d of 版々) {
      const st = String(
        (d.verification && typeof d.verification === "object"
          ? (d.verification as { status?: unknown }).status
          : d.verification) ?? "",
      );
      if (!st) 記録なし += 1;
      else if (st === "manual-required" || st === "parser-failed") 複數 += 1;
      else if (st === "verified") 確認済み += 1;
    }
    /* 締切が 1 本も無い會議（實測: `fgcs`）は「確認: …」を出さないので其の儘次へ（第 866 回）。 */
    if (!(複數 + 確認済み + 記録なし)) {
      expect(答, `「${key}」は締切が無いのに「確認: 」を出して居る`).not.toContain("確認: ");
      continue;
    }
    if (複數)
      expect(行, `「${key}」の複数候補の數が違ふ`).toContain(`複数候補のため要確認 ${複數} 行`);
    if (記録なし)
      expect(行, `「${key}」の記録なしの數が違ふ`).toContain(`確認の記録なし ${記録なし} 行`);
    if (確認済み) expect(行, `「${key}」の確認済みの數が違ふ`).toContain(`確認済み ${確認済み} 行`);
  }
});

it("檢索の頭の「當たる件數」と「絞る前」は、兩方事實と合ふ（第 989 回）", async () => {
  /* 第 987・988 回で統計と會議の內訣を收錄で確かめた。**檢索の頭**の二つの數も – 實測
   * 2026-11-19: 10 問で 0 件の誤り。「當たる締切: N 件」は畫面の既定（今後・投稿締切・
   * 推定を除く）を通した數、「絞る前は M 行」は**絞り込みの前**の生の數。
   * 兩方が事實と合はないと、AI が「N 件當たつた」と誤つて報告する。 */
  const 品書 = JSON.parse(readFileSync(join(REPO_ROOT, "public", "catalog.json"), "utf8")) as {
    conferences?: unknown[];
  };
  const 行々 = Recommender.candidateRows(品書 as never);
  const 今 = Date.now();
  const 投稿の種別 = new Set(["abstract", "paper", "journal"]);
  const 問 = ["セキュリティ", "今月", "締切", "3月", "ICDE", "国内", "オンライン", "来月"];
  for (const q of 問) {
    const 答 = await call("search_deadlines", { query: q, limit: 400 });
    const 頭 = 答.split("\n")[0] ?? "";
    const m = /に当たる締切: ([\d,]+) 件[\s\S]*?絞る前は ([\d,]+) 行/.exec(頭);
    expect(m, `「${q}」の頭から數が讀めない: ${頭.slice(0, 70)}`).not.toBeNull();
    const 當たる = Number(m?.[1].replace(/,/g, ""));
    const 生 = Number(m?.[2].replace(/,/g, ""));
    const 篩 = Recommender.searchMatcher(q, 今);
    const 生の事實 = 行々.filter((r) => 篩(r.hay as string) === true).length;
    const 當たるの事實 = 行々.filter(
      (r) =>
        篩(r.hay as string) === true &&
        !Recommender.deadlineRowIsPast(r, 今) &&
        r.est !== true &&
        投稿の種別.has(r.kind),
    ).length;
    expect(生の事實, `「${q}」の生の行が數へられない（この檢查の前提が崩れた）`).toBeGreaterThan(0);
    expect(生, `「${q}」の「絞る前」が事實と違ふ（表示 ${生} ／ 事實 ${生の事實}）`).toBe(生の事實);
    expect(
      當たる,
      `「${q}」の「當たる」が事實と違ふ（表示 ${當たる} ／ 事實 ${當たるの事實}）`,
    ).toBe(當たるの事實);
  }
});

it("list_upcoming の件數は、其の窓の事实と合ふ（第 990 回）", async () => {
  /* 第 989 回で `search_deadlines` の頭の 2 數を確かめた。**直近の一覧**の頭も。
   * 實測 2026-11-19: 窓 5 つ（7・30・90・180・400 日）で **0 件の誤り**。
   *
   * **出所に注意** – 既定の `scope` は `all` = **`data/snapshot.json`**（5,069 行）。
   * 品書（`public/catalog.json`, 870 行）で數へると **180 日で 489 の處が 375 に減る** –
   * 此れで誤靜を出さないやうに、事實は**道具と同じ** snapshot から數へる（第 965・966 回の
   * 元の收録と建てた表示の差と同じ）。 */
  const 收錄 = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as {
    conferences?: unknown[];
  };
  const 行々 = Recommender.candidateRows(收錄 as never);
  const 今 = Date.now();
  const 窓 = [7, 30, 90, 180, 400];
  for (const days of 窓) {
    const 答 = await call("list_upcoming", { days, limit: 900 });
    const 頭 = 答.split("\n")[0] ?? "";
    const m = /の締切: ([\d,]+) 件/.exec(頭);
    expect(m, `days=${days} の頭から數が讀めない: ${頭.slice(0, 60)}`).not.toBeNull();
    const 表示 = Number(m?.[1].replace(/,/g, ""));
    const 限り = Recommender.withinDaysLimitMs(days, 今);
    const 事實 = 行々.filter(
      (r) => !Recommender.deadlineRowIsPast(r, 今) && (r.tShown ?? r.t) < 限り,
    ).length;
    expect(事實, `days=${days} の事實が 0 行（この檢查の前提が崩れた）`).toBeGreaterThan(0);
    expect(表示, `days=${days} の件數が事實と違ふ（表示 ${表示} ／ 事實 ${事實}）`).toBe(事實);
  }
  /* **開催（会期）の行**も同じ窓の事实と合ふ – 實測 2026-11-19: 7 日 21 件・30 日 85 件・
   * 180 日 296 件、全部一致。會期は**推測の版を入れない**・**區分ごと**に 1 行
   * （`event_segments`）・會期中の會議も入る（第 910 回）。 */
  const 開催の事實 = (days: number): number => {
    const 限り = Recommender.withinDaysLimitMs(days, 今);
    let n = 0;
    for (const c of (收錄.conferences ?? []) as Array<Record<string, unknown>>) {
      for (const e of (c.editions ?? []) as Array<Record<string, unknown>>) {
        if (e.estimated === true) continue;
        const segs =
          Array.isArray(e.event_segments) && (e.event_segments as unknown[]).length
            ? (e.event_segments as Array<Record<string, unknown>>)
            : e.event_start
              ? [{ start: e.event_start, end: e.event_end ?? e.event_start }]
              : [];
        for (const seg of segs) {
          const 開 = Date.parse(String(seg.start ?? ""));
          if (!Number.isFinite(開)) continue;
          const 終 = Date.parse(String(seg.end ?? seg.start ?? "")) || 開;
          if (終 < 今 || 開 >= 限り) continue;
          n += 1;
        }
      }
    }
    return n;
  };
  for (const days of 窓) {
    const 答 = await call("list_upcoming", { days, limit: 900 });
    const 節 = 答.split("\n").find((l) => l.startsWith("開催（会期の行）")) ?? "";
    expect(節, `days=${days} に開催の節が出て居ん`).not.toBe("");
    const 表示 = Number(
      (/開催（会期の行）: ([\d,]+) 件/.exec(節) ?? [0, "0"])[1].replace(/,/g, ""),
    );
    const 事實 = 開催の事實(days);
    expect(事實, `days=${days} の開催が 0 件（この檢查の前提が崩れた）`).toBeGreaterThan(0);
    expect(表示, `days=${days} の開催の件數が事實と違ふ（表示 ${表示} ／ 事實 ${事實}）`).toBe(
      事實,
    );
  }

  /* 切り詰めの宣告も事實と合ふ（100 件まで）。180 日は 489 件なので切られる。 */
  const 長い = await call("list_upcoming", { days: 180, limit: 900 });
  const 頭 = 長い.split("\n")[0] ?? "";
  const 表示 = Number((/の締切: ([\d,]+) 件/.exec(頭) ?? [0, "0"])[1].replace(/,/g, ""));
  if (表示 > 100) {
    const 行 = 長い.split("\n").filter((l) => /^20\d\d-/.test(l)).length;
    expect(行, "切り詰めた行數が 100 を超えて居る").toBeLessThanOrEqual(100);
    const 宣告 = 長い.split("\n").find((l) => l.includes("まで表示")) ?? "";
    const 殘り = Number((/残り ([\d,]+) 件/.exec(宣告) ?? [0, "0"])[1].replace(/,/g, ""));
    expect(殘り, `「殘り」の數が事實と違ふ（宣告 ${殘り} ／ 事實 ${表示 - 行}）`).toBe(表示 - 行);
  }
});

it("推薦の「候補の件數」と「過ぎた件數」は事實と合ふ（第 992 回）", async () => {
  /* 第 990・991 回で `list_upcoming` の二つの件數を確かめた。**推薦**の二つも。
   * 實測 2026-11-19: 3 つの論文で 0 件の誤り。
   *
   * **事实の作り方** – MCP は `screenRows()`（品書）を pool の元に使ふ。品書の
   * `reranker` も讀むので、其れを**忘れると點が變はり候補が減る**（實測: reranker を
   * null にすると 92 件が 46 件に減つた – 自分の測り方の失敗。第 962・966・979・990 回と
   * 同じ「事實は道具と同じ出所・同じ設定で數へる」）。 */
  const 品書 = JSON.parse(readFileSync(join(REPO_ROOT, "public", "catalog.json"), "utf8")) as {
    conferences?: unknown[];
    reranker?: unknown;
  };
  const 今 = Date.now();
  const 事實 = (題: string): { 候補: number; 過去: number } => {
    Recommender.setNameIdf(Recommender.buildNameIdf(品書.conferences ?? []));
    Recommender.setReranker(品書.reranker ?? null);
    const 行 = Recommender.candidateRows(品書 as never);
    const pool = 行
      .filter((r) => !Recommender.deadlineRowIsPast(r, 今))
      .concat(
        Recommender.journalRows(品書.conferences ?? [], 今) as never,
        Recommender.pastRepresentatives(行, 今) as never,
      );
    const lines = Recommender.parsePaperLines(題);
    const 候補 = Recommender.venueRecommendations(pool, lines, null, 今, {
      fieldedLexical: true,
    }).filter((r) => r.fit.score >= 10);
    return { 候補: 候補.length, 過去: 候補.filter((r) => Number(r.row.t) < 今).length };
  };
  for (const 題 of [
    "分散システムのスケーラビリティと耐故障性",
    "深層学習を用いた自然言語処理の教師なし学習",
    "暗号理論とゼロ知識証明の実装",
  ]) {
    const 答 = await call("recommend_venues", { paper: 題, limit: 20 });
    const 頭 = 答.split("\n")[0] ?? "";
    const 事 = 事實(題);
    expect(事.候補, `「${題}」の候補が 0 件（この檢查の前提が崩れた）`).toBeGreaterThan(0);
    expect(頭, `「${題}」に合う投稿先: ${事.候補} 件`).toContain(`に合う投稿先: ${事.候補} 件`);
    if (事.過去) {
      expect(頭, `「${題}」に過ぎた ${事.過去} 件の宣告が無い`).toContain(
        `うち ${事.過去} 件は締切が過ぎた`,
      );
    }
  }
});

it("日にちの引數に端数を貰つたら、切つて居る事を言ふ（第 993 回）", async () => {
  /* 實測 2026-11-19: `days: 1.5`・`within_days: 2.5`・`within_days: 3.7` は**默つて**
   * 其の儘使はれて居た。畫面の「締切まで」の選粍は 7・30・90・180 日の**整數**しか
   * 出さないので、端数は機械だけの打ち方 – 第 924 回で `limit` は「3.7 件まで表示」の樣に
   * 書かずに切つた（**默つて切つた**）。日にちも同じ決まりに揃へる: 切り下げて、切つた
   * 事を頭に書く。
   *
   * 默つて切ると、AI は「1.5 日」と聞いたつもりで「1 日」の結果を報告してしまふ。 */
  /* 1. `list_upcoming` の `days` */
  const 目錄 = await call("list_upcoming", { days: 1.5, limit: 1 });
  expect(目錄, "days の端数を切つたと言つて居ん").toMatch(/1 日|端数|切/);
  expect(目錄.split("\n")[0], "1.5 日の儘を表示して居る").toContain("1 日");
  const 目錄の健全 = await call("list_upcoming", { days: 7, limit: 1 });
  expect(目錄の健全, "整數なのに端数の斷りが出た").not.toMatch(/端数/);
  /* 2. `search_deadlines` の `within_days` */
  const 檢索 = await call("search_deadlines", {
    query: "セキュリティ",
    within_days: 3.7,
    limit: 1,
  });
  expect(檢索, "within_days の端数を默つて使つて居る").toMatch(/端数|切/);
  const 檢索の健全 = await call("search_deadlines", {
    query: "セキュリティ",
    within_days: 30,
    limit: 1,
  });
  expect(檢索の健全, "整數なのに端数の斷りが出た").not.toMatch(/端数/);
});

it("死語が多い問は、數へた殘りを言ふ（第 994 回）", async () => {
  /* 實測 2026-11-19: 7 語（9 語）の死語を打つと「うち zzz9・zzz8」の **2 語だけ**出て
   * 「ほか 5 語」の言はれが無かつた – 讀む人は「この 2 語だけが見当たらない」と思ひ、
   * 殘りの語まで調べ直してしまふ。默つた切り詰めにしない（第 924・993 回と同じ決まり）。 */
  const 多い = await call("search_deadlines", {
    query: "zzz9 zzz8 zzz7 zzz6 zzz5 zzz4 zzz3 zzz2",
    limit: 1,
  });
  const 注 = 多い.split("\n").find((l) => l.includes("見当たりません")) ?? "";
  expect(注, "死語の注が出て居ん").not.toBe("");
  expect(注, "殘りの語の數を言つて居ん").toContain("ほか 6 語も");
  /* 2 語までは何も添へない（默つて居る – 第 852 回と同じ決まり）。 */
  const 少ない = await call("search_deadlines", { query: "zzz9 zzz8", limit: 1 });
  const 注2 = 少ない.split("\n").find((l) => l.includes("見当たりません")) ?? "";
  expect(注2, "2 語なのに「ほか」が出た").not.toContain("ほか");
  /* 1 語だけ當たる問（セキュリティ + 死語）は「外すと増えます」を其の儘出す。 */
  const 混在 = await call("search_deadlines", { query: "セキュリティ zzz9", limit: 1 });
  expect(混在, "その語を外すと增えると言つて居ん").toContain("その語を外すと増えます。");
  expect(混在, "混在なのに「ほか」が出た").not.toContain("ほか 1 語も");
});

it("語ごとの件數も 4 語目以降を落とさない（第 995 回）", async () => {
  /* 第 994 回で死語の殘りを數へた。**語ごとの件數**も默つて 3 語だけで切り詰めて居た –
   * 實測 2026-11-19: 5 語全部が收錄に在るのに「セキュリティ・ネットワーク・データベース」
   * の 3 語だけ出て、4・5 語目は**何も言はれなかつた**（調べて居ないやうに讀める）。
   * 「・ほか N 語」を添へる（第 994 回と同じ形）。 */
  const 多い = await call("search_deadlines", {
    query: "セキュリティ ネットワーク データベース 人工知能 システム",
    limit: 1,
  });
  const 注 = 多い.split("\n").find((l) => l.includes("行はありません")) ?? "";
  expect(注, "語ごとの件數が出て居ん").not.toBe("");
  expect(注, "4 語目以降の數を言つて居ん").toContain("ほか 2 語");
  /* 3 語までは何も添へない。 */
  const 少ない = await call("search_deadlines", {
    query: "セキュリティ ネットワーク データベース",
    limit: 1,
  });
  const 注2 = 少ない.split("\n").find((l) => l.includes("行はありません")) ?? "";
  expect(注2, "3 語なのに「ほか」が出た").not.toContain("ほか");
});

it("推薦の見出しを 40 字に切つたら、切つた事を添へる（第 996 回）", async () => {
  /* 第 993〜995 回で「切り詰めは默らない」を三つ潰した。**推薦の見出し**も默つて 40 字に
   * 切つて居た – 實測 2026-11-19: 55 字の題名が「…研究」で切れて居て、調べたのが其の
   * 40 字だけやうに讀めた（實際は**全文**で調べて居る）。默つて切ると言はれない事實が增える。 */
  const 長い題 =
    "深層学習を用いた自然言語処理のための事前学習モデルとその応用に関する詳細な研究を超えてさらに長い題名";
  const 答 = await call("recommend_venues", { paper: 長い題, limit: 3 });
  expect(答, "見出しを切つたと言つて居ん").toContain(
    "（見出しは 40 字に切り詰めた物です。調べたのは全文です）",
  );
  expect(答.split("\n")[0], "全文が見出しに出て居る（切れて居らん）").not.toContain(長い題);
  /* 短い題名には何も添へない（第 852 回と同じ決まり）。 */
  const 短い = await call("recommend_venues", { paper: "セキュリティの会報", limit: 3 });
  expect(短い, "短い題名に切り詰めの斷りが出た").not.toContain("切り詰めた物です");
});

describe(" schema に無い引数は默つて捨てない（第 997 回）", () => {
  /* 第 920 回で**篩り込みの引數**（rank・domestic・…）は「此の道具では効きません」と言ふ
   * やうにした。但其れは**宣言して在る引數**の中の話 – AI が勝手に `offset`・`page`・
   * `verbose`・`format` の樣な**schema に無い引數**を送ると、未だ**默つて**讀み捨てられて居た
   * （實測 2026-11-19: `offset: 5` を送つても何も出ず、最初の 20 行が其の儘返る）。
   *
   * AI は「次を見る」爲に `offset` を取り敢えず打つ – 默つて捨てると「同じ 20 行」が
   * 返り、AI は「以上が全部」と思ふ。**何が効かなかつたか**を言ふ。 */
  const 持ち物 = async (名前: string): Promise<string[]> => {
    const res = (await client.ask({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
      result?: {
        tools?: Array<{ name?: string; inputSchema?: { properties?: Record<string, unknown> } }>;
      };
    };
    const tool = (res.result?.tools ?? []).find((t) => t.name === 名前);
    return Object.keys(tool?.inputSchema?.properties ?? {});
  };
  it("未宣言の引數を送ると、其の名を言ふ", async () => {
    for (const [名前, 未宣言] of [
      ["search_deadlines", { offset: 5 }],
      ["list_upcoming", { page: 2 }],
      ["explain_word", { verbose: true }],
      ["collection_stats", { format: "json" }],
    ] as const) {
      const 持つ = await 持ち物(名前);
      const 余分 = Object.keys(未宣言).filter((k) => !持つ.includes(k));
      expect(余分.length, `${名前} の未宣言の引數が決まらない`).toBeGreaterThan(0);
      const 引數 =
        名前 === "search_deadlines"
          ? { query: "セキュリティ" }
          : 名前 === "explain_word"
            ? { word: "セキュリティ" }
            : {};
      const 答 = await call(名前, { ...引數, ...未宣言 });
      expect(
        答,
        `「${名前}」に ${余分.join("・")} を送つたのに効かなかつた事を言つて居ん`,
      ).toContain(余分[0]);
    }
  });
  /* **宣言して在る引數**には言はない（其れは各自の斷りの擔當 – 第 920 回・第 921 回）。 */
  it("宣言して在る引數には言はない", async () => {
    const 答 = await call("search_deadlines", {
      query: "セキュリティ",
      limit: 2,
      include_past: true,
    });
    expect(答, "宣言して在る引數に對して餘計な斷りが出た").not.toContain("此の道具に無い引数");
  });
});

it("種別の打ち間違ひを默つて 0 件にしない（第 999 回）", async () => {
  /* 實測 2026-11-19: `kinds: ["paper","zzz"]` は第 886 回で知らない值を名指すやうに
   * 成つて居たが、**`kind`（單數）は默つて 0 件**だつた。同じ引數なので同じ決まり。
   * あと `kinds: []`（空配列）も默つて「濾さない」扱ひ – AI は「0 件にして」のつもりで
   * 打つかも知れない。兩方默らない。 */
  const 單數 = await call("search_deadlines", { query: "セキュリティ", kind: "zzz" });
  expect(單數, "知らない kind を名指して居ん").toContain("知らない種別");
  expect(單數.split("\\n")[0], "默つて 0 件に成つて居る").toContain("知らない種別");
  /* 空配列は「濾して居ません」と言ふ。 */
  const 空 = await call("search_deadlines", { query: "セキュリティ", kinds: [] });
  expect(空, "空の kinds を默つて濾さない扱ひにして居ん").toContain(
    "kinds が空なので種別で濾して居ません",
  );
  /* 良い値には何も言はない（第 852 回と同じ決まり）。 */
  for (const 良い of [{ kind: "paper" }, { kinds: ["paper"] }, { kinds: ["paper", "abstract"] }]) {
    const 答 = await call("search_deadlines", { query: "セキュリティ", ...良い });
    expect(答, `${JSON.stringify(良い)} に餘計な斷りが出た`).not.toContain("知らない種別");
    expect(答, `${JSON.stringify(良い)} に餘計な斷りが出た`).not.toContain("種別で濾して居ません");
  }
});

it("list_upcoming も種別の空配列を默らない（第 1000 回）", async () => {
  /* 第 999 回で `search_deadlines` の `kinds: []` に「濾して居ません」と言ふやうにした。
   * **`list_upcoming` も同じ孖**（`kind`・`kinds`）を持つので、默つて居ないか確かめた –
   * 實測 2026-11-19: 其方は默つて「濾さない」扱ひだつた。兩方で同じ決まりに揃へる。 */
  const 空 = await call("list_upcoming", { kinds: [] });
  expect(空, "空の kinds を默つて濾さない扱ひにして居ん").toContain(
    "kinds が空なので種別で濾して居ません",
  );
  /* 良い値には何も言はない。 */
  const 良い = await call("list_upcoming", { kinds: ["paper"] });
  expect(良い, "良い値に餘計な斷りが出た").not.toContain("種別で濾して居ません");
  const 知らん = await call("list_upcoming", { kind: "zzz" });
  expect(知らん, "知らない單數の kind を默つて 0 件にして居ん").toContain("知らない種別");
});
it("直近の一覽の「対象期間」の申告は、本文と合ふ（第 1002 回）", async () => {
  /* 第 1001 回で ICS の件數の申告を見た。**`upcoming.md` の期間の申告**も – 頭に
   * 「対象期間: 2026-08-09 〜 2027-02-05(金)（生成時刻から 180 日先まで。進行中の会期は
   * 開始日が生成時刻より前でも載る）」と出る。期間が本文と合はないと、讀む人が
   * 「180 日なのに超出て居る」と疑ふ。
   *
   * 實測 2026-11-19: 全部一致。超出る 5 行は **書いてある通りの二種類**:
   * ①進行中の会期（WISA 2026 – 8/7 開始で 8/9 も開催中）
   * ②推定期間（trustcom・pam・nlbse – 幅を持つ值なので、外側が期日を超える事がある） */
  const path = join(REPO_ROOT, "public", "upcoming.md");
  if (!existsSync(path)) return;
  const md = readFileSync(path, "utf8");
  const m = /対象期間: (\d{4}-\d{2}-\d{2}) 〜 (\d{4}-\d{2}-\d{2})/.exec(md);
  expect(m, "期間の申告が讀めない").not.toBeNull();
  const 始まり = m?.[1] ?? "";
  const 期日 = m?.[2] ?? "";
  /* 生成時刻から 180 日先である事（此れが狂つて居ると全部狂ふ）。 */
  const 生成 = /生成時刻: (\d{4}-\d{2}-\d{2})T/.exec(md)?.[1] ?? "";
  expect(生成, "生成時刻が讀めない").not.toBe("");
  const 一日 = 86400000;
  const 差 = Math.round((Date.parse(`${期日}T00:00:00Z`) - Date.parse(`${生成}T00:00:00Z`)) / 一日);
  expect(差, `期間が ${差} 日（180 では無い）`).toBe(180);
  /* 本文の行が期日を超えて居ない事（超えて良しと書いてある二種類を除く）。 */
  const 行 = md
    .split("\n")
    .filter(
      (l) => l.startsWith("| 2026-") || l.startsWith("| 2027-") || l.startsWith("| 推定期間"),
    );
  expect(行.length, "本文の行が讀めない（この檢查の前提が崩れた）").toBeGreaterThan(100);
  /* 先頭の `| ` と「推定期間 」を除いて日付を取る（殘すと縦線が日數の比較に混ざる）。 */
  const 日付の行 = (l: string): string =>
    l
      .replace(/^\|\s*(?:推定期間\s*)?/, "")
      .trim()
      .slice(0, 10);
  const 超出し = 行.filter((l) => {
    const d = 日付の行(l);
    return d < 始まり || d > 期日;
  });
  for (const l of 超出し) {
    /* 超えて居る行は「推定期間」か「會期が進行中（開催中）」の行だけ。 */
    expect(
      l.startsWith("| 推定期間") || l.includes("開催中"),
      `期間を超える行が、書いてある二種類ではない: ${l.slice(0, 80)}`,
    ).toBe(true);
  }
  /* 超過は 0 でも良い（データに依る）が、多すぎたら狂つて居る。 */
  expect(超出し.length, `期間を超える行が ${超出し.length} 行もある`).toBeLessThan(30);
});

it("索引が觸れて居る打ち方は、全部效く（第 1006 回）", async () => {
  /* 第 1003〜1005 回で索引の**數字**が本文と合ふことを見た。今囘は**書いてある打ち方** –
   * AI が索引を讀んで「この打ち方で試す」とし、效かないと「收錄が貧弱」と誤解する。
   * 實測 2026-11-19: 下の全部が效く（件數は 0 でも「語が無い」ではなく
   * 「既定の篩り込みで 0」で、打ち方は效いて居る）。 */
  const 效く打ち方: string[] = [
    "人工知能・データベース",
    "機械学習",
    "韓国",
    "オンライン",
    "12月",
    "2026年12月",
    "今月",
    "来月",
    "再来月",
    "先月",
    "第 2 ラウンド",
    "第2ラウンド",
    "R2",
    "1日",
    "8月1日",
    "おきなわ",
    "岡山",
    "沖縄",
  ];
  for (const 打ち方 of 效く打ち方) {
    const 答 = await call("search_deadlines", { query: 打ち方, limit: 1 });
    /* 「収録データにも見当たりません」は**語が無い**＝打ち方が效いて居ない。
     * 0 件でも其れが出なければ打ち方は效いて居る（篩り込みの話）。 */
    expect(答, `索引が效くと書いて居る「${打ち方}」が語として無い`).not.toContain("見当たりません");
    expect(答, `「${打ち方}」で頭が出て居ん`).toContain("に当たる締切");
  }
  /* 打ち方が效く時は「語は當たります」か件數が出る（0 件でも意味が違ふ）。 */
  const 先月 = await call("search_deadlines", { query: "先月", limit: 1 });
  expect(先月, "過去の月（先月）は 0 件でも打ち方が效いて居る").toContain("に当たる締切: 0 件");
});

it("返す行の形を說明に書いて、實物もその通りに分けられる（第 1008 回）", async () => {
  /* 實測 2026-11-19: 返る行は `日付 | 種別 | 確認の札 | 会議名（版の識別子）| ランク | 会期…`
   * の 6 つだが、**其の形が何處にも書かれて居なかつた** – AI が行を分ける時に「何區切り？」
   * と當てるはないと思ふ。道具の說明に形を書く（`| ` で 6 つ・丸括弧の中が版の識別子）。
   *
   * あはせて、**會議名が括弧を含む**事も言ふ – `The 9th IEEE … (BSD 2026)（id）` の
   * 樣に丸括弧が二重に成るので、版の識別子は**一番最後の丸括弧**だと讀めるやうに。 */
  const res = (await client.ask({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
    result?: { tools?: Array<{ name?: string; description?: string }> };
  };
  const 說明 =
    (res.result?.tools ?? []).find((t) => t.name === "search_deadlines")?.description ?? "";
  expect(說明, "返す行の形を說明に書いて居ん").toContain("返す行の形");
  expect(說明, "區切りの書き方を書いて居ん").toContain("`| ` で切り");
  /* 確認の札は在る時だけ入るので 6 つか 7 つ（第 1010 囮で書いた時の數は違つて居た –
   * 第 1061 囮で實測して直した）。 */
  expect(說明, "6 つか 7 つに分かれる事を書いて居ん").toContain("6 つか 7 つに分かれる");
  expect(說明, "版の識別子が丸括弧の中だと書いて居ん").toContain("丸括弧の中が**版の識別子**");
  /* 實物もその通り – 全部の行が 6 つに分かれ、版の識別子が拔ける。 */
  const 答 = await call("search_deadlines", { query: "セキュリティ", limit: 5 });
  const 行 = 答.split("\n").filter((l) => /^20\d\d-/.test(l));
  expect(行.length, "行が出て居ん").toBeGreaterThan(0);
  for (const l of 行) {
    expect(l.split(" | ").length, `行が 6 つに分かれん: ${l.slice(0, 60)}`).toBe(6);
    const 最後の丸括弧 = [...l.matchAll(/（([a-z0-9'.-]+)）/g)].at(-1);
    expect(最後の丸括弧, `版の識別子が拔けない: ${l.slice(0, 60)}`).toBeTruthy();
  }
});

it("死語が多い問は、数えた殘りを言ふ（第 994 回）", async () => {
  /* 實測 2026-11-19: 7 語（9 語）の死語を打つと「うち zzz9・zzz8」の **2 語だけ**出て
   * 「ほか 5 語」の言はれが無かつた – 讀む人は「この 2 語だけが見当たらない」と思ひ、
   * 殘りの語まで調べ直してしまふ。默つた切り詰めにしない（第 924・993 回と同じ決まり）。 */
  const 多い = await call("search_deadlines", {
    query: "zzz9 zzz8 zzz7 zzz6 zzz5 zzz4 zzz3 zzz2",
    limit: 1,
  });
  const 注 = 多い.split("\n").find((l) => l.includes("見当たりません")) ?? "";
  expect(注, "死語の注が出て居ん").not.toBe("");
  expect(注, "殘りの語の數を言つて居ん").toContain("ほか 6 語も");
  /* 2 語までは何も添へない（默つて居る – 第 852 回と同じ決まり）。 */
  const 少ない = await call("search_deadlines", { query: "zzz9 zzz8", limit: 1 });
  const 注2 = 少ない.split("\n").find((l) => l.includes("見当たりません")) ?? "";
  expect(注2, "2 語なのに「ほか」が出た").not.toContain("ほか");
  /* 1 語だけ當たる問（セキュリティ + 死語）は「外すと増えます」を其の儘出す。 */
  const 混在 = await call("search_deadlines", { query: "セキュリティ zzz9", limit: 1 });
  expect(混在, "その語を外すと增えると言つて居ん").toContain("その語を外すと増えます。");
  expect(混在, "混在なのに「ほか」が出た").not.toContain("ほか 1 語も");
});

it("語ごとの件數も 4 語目以降を落とさない（第 995 回）", async () => {
  /* 第 994 回で死語の殘りを数えた。**語ごとの件數**も默つて 3 語だけで切り詰めて居た –
   * 實測 2026-11-19: 5 語全部が收錄に在るのに「セキュリティ・ネットワーク・データベース」
   * の 3 語だけ出て、4・5 語目は**何も言はれなかつた**（調べて居ないやうに讀める）。
   * 「・ほか N 語」を添へる（第 994 回と同じ形）。 */
  const 多い = await call("search_deadlines", {
    query: "セキュリティ ネットワーク データベース 人工知能 システム",
    limit: 1,
  });
  const 注 = 多い.split("\n").find((l) => l.includes("行はありません")) ?? "";
  expect(注, "語ごとの件數が出て居ん").not.toBe("");
  expect(注, "4 語目以降の數を言つて居ん").toContain("ほか 2 語");
  /* 3 語までは何も添へない。 */
  const 少ない = await call("search_deadlines", {
    query: "セキュリティ ネットワーク データベース",
    limit: 1,
  });
  const 注2 = 少ない.split("\n").find((l) => l.includes("行はありません")) ?? "";
  expect(注2, "3 語なのに「ほか」が出た").not.toContain("ほか");
});

it("推薦の見出しを 40 字に切つたら、切つた事を添へる（第 996 回）", async () => {
  /* 第 993〜995 回で「切り詰めは默らない」を三つ潰した。**推薦の見出し**も默つて 40 字に
   * 切つて居た – 實測 2026-11-19: 55 字の題名が「…研究」で切れて居て、調べたのが其の
   * 40 字だけやうに讀めた（實際は**全文**で調べて居る）。默つて切ると言はれない事實が增える。 */
  const 長い題 =
    "深層学習を用いた自然言語処理のための事前学習モデルとその応用に関する詳細な研究を超えてさらに長い題名";
  const 答 = await call("recommend_venues", { paper: 長い題, limit: 3 });
  expect(答, "見出しを切つたと言つて居ん").toContain(
    "（見出しは 40 字に切り詰めた物です。調べたのは全文です）",
  );
  expect(答.split("\n")[0], "全文が見出しに出て居る（切れて居らん）").not.toContain(長い題);
  /* 短い題名には何も添へない（第 852 回と同じ決まり）。 */
  const 短い = await call("recommend_venues", { paper: "セキュリティの会報", limit: 3 });
  expect(短い, "短い題名に切り詰めの斷りが出た").not.toContain("切り詰めた物です");
});

describe(" schema に無い引数は默つて捨てない（第 997 回）", () => {
  /* 第 920 回で**篩り込みの引數**（rank・domestic・…）は「此の道具では効きません」と言ふ
   * やうにした。但其れは**宣言して在る引數**の中の話 – AI が勝手に `offset`・`page`・
   * `verbose`・`format` の樣な**schema に無い引數**を送ると、未だ**默つて**讀み捨てられて居た
   * （實測 2026-11-19: `offset: 5` を送つても何も出ず、最初の 20 行が其の儘返る）。
   *
   * AI は「次を見る」爲に `offset` を取り敢えず打つ – 默つて捨てると「同じ 20 行」が
   * 返り、AI は「以上が全部」と思ふ。**何が効かなかつたか**を言ふ。 */
  const 持ち物 = async (名前: string): Promise<string[]> => {
    const res = (await client.ask({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
      result?: {
        tools?: Array<{ name?: string; inputSchema?: { properties?: Record<string, unknown> } }>;
      };
    };
    const tool = (res.result?.tools ?? []).find((t) => t.name === 名前);
    return Object.keys(tool?.inputSchema?.properties ?? {});
  };
  it("未宣言の引數を送ると、其の名を言ふ", async () => {
    for (const [名前, 未宣言] of [
      ["search_deadlines", { offset: 5 }],
      ["list_upcoming", { page: 2 }],
      ["explain_word", { verbose: true }],
      ["collection_stats", { format: "json" }],
    ] as const) {
      const 持つ = await 持ち物(名前);
      const 余分 = Object.keys(未宣言).filter((k) => !持つ.includes(k));
      expect(余分.length, `${名前} の未宣言の引數が決まらない`).toBeGreaterThan(0);
      const 引數 =
        名前 === "search_deadlines"
          ? { query: "セキュリティ" }
          : 名前 === "explain_word"
            ? { word: "セキュリティ" }
            : {};
      const 答 = await call(名前, { ...引數, ...未宣言 });
      expect(
        答,
        `「${名前}」に ${余分.join("・")} を送つたのに効かなかつた事を言つて居ん`,
      ).toContain(余分[0]);
    }
  });
  /* **宣言して在る引數**には言はない（其れは各自の斷りの擔當 – 第 920 回・第 921 回）。 */
  it("宣言して在る引數には言はない", async () => {
    const 答 = await call("search_deadlines", {
      query: "セキュリティ",
      limit: 2,
      include_past: true,
    });
    expect(答, "宣言して在る引數に對して餘計な斷りが出た").not.toContain("此の道具に無い引数");
  });
});

it("種別の打ち間違ひを默つて 0 件にしない（第 999 回）", async () => {
  /* 實測 2026-11-19: `kinds: ["paper","zzz"]` は第 886 回で知らない值を名指すやうに
   * 成つて居たが、**`kind`（單數）は默つて 0 件**だつた。同じ引數なので同じ決まり。
   * あと `kinds: []`（空配列）も默つて「濾さない」扱ひ – AI は「0 件にして」のつもりで
   * 打つかも知れない。兩方默らない。 */
  const 單數 = await call("search_deadlines", { query: "セキュリティ", kind: "zzz" });
  expect(單數, "知らない kind を名指して居ん").toContain("知らない種別");
  expect(單數.split("\\n")[0], "默つて 0 件に成つて居る").toContain("知らない種別");
  /* 空配列は「濾して居ません」と言ふ。 */
  const 空 = await call("search_deadlines", { query: "セキュリティ", kinds: [] });
  expect(空, "空の kinds を默つて濾さない扱ひにして居ん").toContain(
    "kinds が空なので種別で濾して居ません",
  );
  /* 良い値には何も言はない（第 852 回と同じ決まり）。 */
  for (const 良い of [{ kind: "paper" }, { kinds: ["paper"] }, { kinds: ["paper", "abstract"] }]) {
    const 答 = await call("search_deadlines", { query: "セキュリティ", ...良い });
    expect(答, `${JSON.stringify(良い)} に餘計な斷りが出た`).not.toContain("知らない種別");
    expect(答, `${JSON.stringify(良い)} に餘計な斷りが出た`).not.toContain("種別で濾して居ません");
  }
});

it("list_upcoming も種別の空配列を默らない（第 1000 回）", async () => {
  /* 第 999 回で `search_deadlines` の `kinds: []` に「濾して居ません」と言ふやうにした。
   * **`list_upcoming` も同じ孖**（`kind`・`kinds`）を持つので、默つて居ないか確かめた –
   * 實測 2026-11-19: 其方は默つて「濾さない」扱ひだつた。兩方で同じ決まりに揃へる。 */
  const 空 = await call("list_upcoming", { kinds: [] });
  expect(空, "空の kinds を默つて濾さない扱ひにして居ん").toContain(
    "kinds が空なので種別で濾して居ません",
  );
  /* 良い値には何も言はない。 */
  const 良い = await call("list_upcoming", { kinds: ["paper"] });
  expect(良い, "良い値に餘計な斷りが出た").not.toContain("種別で濾して居ません");
  const 知らん = await call("list_upcoming", { kind: "zzz" });
  expect(知らん, "知らない單數の kind を默つて 0 件にして居ん").toContain("知らない種別");
});
it("直近の一覽の「対象期間」の申告は、本文と合ふ（第 1002 回）", async () => {
  /* 第 1001 回で ICS の件數の申告を見た。**`upcoming.md` の期間の申告**も – 頭に
   * 「対象期間: 2026-08-09 〜 2027-02-05(金)（生成時刻から 180 日先まで。進行中の会期は
   * 開始日が生成時刻より前でも載る）」と出る。期間が本文と合はないと、讀む人が
   * 「180 日なのに超出て居る」と疑ふ。
   *
   * 實測 2026-11-19: 全部一致。超出る 5 行は **書いてある通りの二種類**:
   * ①進行中の会期（WISA 2026 – 8/7 開始で 8/9 も開催中）
   * ②推定期間（trustcom・pam・nlbse – 幅を持つ值なので、外側が期日を超える事がある） */
  const path = join(REPO_ROOT, "public", "upcoming.md");
  if (!existsSync(path)) return;
  const md = readFileSync(path, "utf8");
  const m = /対象期間: (\d{4}-\d{2}-\d{2}) 〜 (\d{4}-\d{2}-\d{2})/.exec(md);
  expect(m, "期間の申告が讀めない").not.toBeNull();
  const 始まり = m?.[1] ?? "";
  const 期日 = m?.[2] ?? "";
  /* 生成時刻から 180 日先である事（此れが狂つて居ると全部狂ふ）。 */
  const 生成 = /生成時刻: (\d{4}-\d{2}-\d{2})T/.exec(md)?.[1] ?? "";
  expect(生成, "生成時刻が讀めない").not.toBe("");
  const 一日 = 86400000;
  const 差 = Math.round((Date.parse(`${期日}T00:00:00Z`) - Date.parse(`${生成}T00:00:00Z`)) / 一日);
  expect(差, `期間が ${差} 日（180 では無い）`).toBe(180);
  /* 本文の行が期日を超えて居ない事（超えて良しと書いてある二種類を除く）。 */
  const 行 = md
    .split("\n")
    .filter(
      (l) => l.startsWith("| 2026-") || l.startsWith("| 2027-") || l.startsWith("| 推定期間"),
    );
  expect(行.length, "本文の行が讀めない（この檢查の前提が崩れた）").toBeGreaterThan(100);
  /* 先頭の `| ` と「推定期間 」を除いて日付を取る（殘すと縦線が日數の比較に混ざる）。 */
  const 日付の行 = (l: string): string =>
    l
      .replace(/^\|\s*(?:推定期間\s*)?/, "")
      .trim()
      .slice(0, 10);
  const 超出し = 行.filter((l) => {
    const d = 日付の行(l);
    return d < 始まり || d > 期日;
  });
  for (const l of 超出し) {
    /* 超えて居る行は「推定期間」か「會期が進行中（開催中）」の行だけ。 */
    expect(
      l.startsWith("| 推定期間") || l.includes("開催中"),
      `期間を超える行が、書いてある二種類ではない: ${l.slice(0, 80)}`,
    ).toBe(true);
  }
  /* 超過は 0 でも良い（データに依る）が、多すぎたら狂つて居る。 */
  expect(超出し.length, `期間を超える行が ${超出し.length} 行もある`).toBeLessThan(30);
});

it("索引が觸れて居る打ち方は、全部效く（第 1006 回）", async () => {
  /* 第 1003〜1005 回で索引の**數字**が本文と合ふことを見た。今囘は**書いてある打ち方** –
   * AI が索引を讀んで「この打ち方で試す」とし、效かないと「收錄が貧弱」と誤解する。
   * 實測 2026-11-19: 下の全部が效く（件數は 0 でも「語が無い」ではなく
   * 「既定の篩り込みで 0」で、打ち方は效いて居る）。 */
  const 效く打ち方: string[] = [
    "人工知能・データベース",
    "機械学習",
    "韓国",
    "オンライン",
    "12月",
    "2026年12月",
    "今月",
    "来月",
    "再来月",
    "先月",
    "第 2 ラウンド",
    "第2ラウンド",
    "R2",
    "1日",
    "8月1日",
    "おきなわ",
    "岡山",
    "沖縄",
  ];
  for (const 打ち方 of 效く打ち方) {
    const 答 = await call("search_deadlines", { query: 打ち方, limit: 1 });
    /* 「収録データにも見当たりません」は**語が無い**＝打ち方が效いて居ない。
     * 0 件でも其れが出なければ打ち方は效いて居る（篩り込みの話）。 */
    expect(答, `索引が效くと書いて居る「${打ち方}」が語として無い`).not.toContain("見当たりません");
    expect(答, `「${打ち方}」で頭が出て居ん`).toContain("に当たる締切");
  }
  /* 打ち方が效く時は「語は當たります」か件數が出る（0 件でも意味が違ふ）。 */
  const 先月 = await call("search_deadlines", { query: "先月", limit: 1 });
  expect(先月, "過去の月（先月）は 0 件でも打ち方が效いて居る").toContain("に当たる締切: 0 件");
});

it("返す行の形を說明に書いて、實物もその通りに分けられる（第 1008 回）", async () => {
  /* 實測 2026-11-19: 返る行は `日付 | 種別 | 確認の札 | 会議名（版の識別子）| ランク | 会期…`
   * の 6 つだが、**其の形が何處にも書かれて居なかつた** – AI が行を分ける時に「何區切り？」
   * と當てるはないと思ふ。道具の說明に形を書く（`| ` で 6 つ・丸括弧の中が版の識別子）。
   *
   * あはせて、**會議名が括弧を含む**事も言ふ – `The 9th IEEE … (BSD 2026)（id）` の
   * 樣に丸括弧が二重に成るので、版の識別子は**一番最後の丸括弧**だと讀めるやうに。 */
  const res = (await client.ask({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
    result?: { tools?: Array<{ name?: string; description?: string }> };
  };
  const 說明 =
    (res.result?.tools ?? []).find((t) => t.name === "search_deadlines")?.description ?? "";
  expect(說明, "返す行の形を說明に書いて居ん").toContain("返す行の形");
  expect(說明, "區切りの書き方を書いて居ん").toContain("`| ` で切り");
  expect(說明, "版の識別子が丸括弧の中だと書いて居ん").toContain("丸括弧の中が**版の識別子**");
  /* 實物もその通り – 全部の行が 6 つに分かれ、版の識別子が拔ける。 */
  const 答 = await call("search_deadlines", { query: "セキュリティ", limit: 5 });
  const 行 = 答.split("\n").filter((l) => /^20\d\d-/.test(l));
  expect(行.length, "行が出て居ん").toBeGreaterThan(0);
  for (const l of 行) {
    /* **5 つか 6 つ** – 確認の札は在る時だけ入る（實測 2026-11-19: 37 行のうち
     * 30 行が 6 つ・7 行が 5 つ = 札が無い行）。第 1010 回で說明にも書いた。 */
    expect(
      [5, 6].includes(l.split(" | ").length),
      `行が 5 か 6 つに分かれん: ${l.slice(0, 60)}`,
    ).toBe(true);
    const 最後の丸括弧 = [...l.matchAll(/（([a-z0-9'.-]+)）/g)].at(-1);
    expect(最後の丸括弧, `版の識別子が拔けない: ${l.slice(0, 60)}`).toBeTruthy();
  }
});

it("行を返す 6 つの道具は、全部「返す行の形」を書く（第 1009 回）", async () => {
  /* 第 1008 回で `search_deadlines` の行の形を説明に書いた。**行を返す他の道具**も –
   * 實測 2026-11-19: `list_upcoming`（締切 + 會期の二種類）・`recommend_venues`（順位と
   * 札が先頭）・`explain_word`（`- ` が付くだけ）は默つて居た。
   * AI が「行を分ける」時に當てるはないので、全部の説明に形を書く。 */
  const res = (await client.ask({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
    result?: { tools?: Array<{ name?: string; description?: string }> };
  };
  const 全部 = (res.result?.tools ?? []).map((t) => ({
    name: String(t.name ?? ""),
    文: t.description ?? "",
  }));
  /* 第 1011 回で `venue_info`（締切の行 + 名簿）と `collection_stats`（`ラベル: 値` の行）
   * も足した – 6 つ全部が書く。 */
  for (const n of [
    "search_deadlines",
    "list_upcoming",
    "recommend_venues",
    "explain_word",
    "venue_info",
    "collection_stats",
  ]) {
    const 道具 = 全部.find((t) => t.name === n);
    expect(道具, `${n} が無い`).toBeTruthy();
    expect(道具?.文, `${n} が返す形を書いて居ん`).toMatch(/返す行の形|返る文の形/);
  }
  /* `list_upcoming` は**二種類**（締切・會期）を持つ事も言ふ。 */
  const 近く = 全部.find((t) => t.name === "list_upcoming");
  expect(近く?.文, "list_upcoming が會期の行の形を書いて居ん").toContain("会期の行は別の形");
  /* 實物もその通り – 6 つに分かれる。 */
  for (const [名前, 引數] of [
    ["search_deadlines", { query: "セキュリティ", limit: 2 }],
    ["list_upcoming", { days: 30, limit: 2 }],
    ["explain_word", { word: "セキュリティ" }],
  ] as const) {
    const 答 = await call(名前, 引數);
    /* 會期の行（`- 2026-10-01(木) 〜 2026-10-31(土) | CSS（key: …・…） | 開催地 URL`）は
     * **別の形**で「（key: 」を持つので、此の 6 つの檢查の對象外 – それを持つ行を除く。
     * 1 日の會期（`- 2026-10-12(月) | ISTAI26（key: …`）も同樣に「（key: 」を持つ。 */
    const 行 = 答.split("\n").filter((l) => /^[-\s]*20\d\d-/.test(l) && !l.includes("（key: "));
    expect(行.length, `${名前} の行が出て居ん`).toBeGreaterThan(0);
    /* **5 つか 6 つ** – 確認の札は在る時だけ入る（實測 2026-11-19: `list_upcoming` では
     * 94 行が 6 つ・6 行が 5 つ）。第 1010 回で說明にも書いた。 */
    for (const l of 行) {
      const 本体 = l.replace(/^-\s*/, "");
      const 數 = 本体.split(" | ").length;
      expect(
        [5, 6].includes(數),
        `${名前} の行が 5 か 6 つに分かれん（${數}）: ${本体.slice(0, 50)}`,
      ).toBe(true);
    }
  }
});

it("venue_info も、どの窓を見たか頭に書く（第 1012 回）", async () => {
  /* 實測 2026-11-19: `venue icde` は默つて「会議: …」から始まつて居た。
   * `search_deadlines`・`list_upcoming`・`explain_word` は全部「収録の全体」「画面が最初に
   * 読む窓」と書くが、此の道具は既定 `all`（収録の全体・過去も入る・5,069 行）なのに
   * 何も言はなかつた – AI が「畫面で見る數と同じ」と誤解する。 */
  const 默 = await call("venue_info", { key: "icde" });
  expect(默, "どの窓を見たか書いて居ん").toContain("（収録の全体・");
  expect(默, "行數も書いて居ん").toMatch(/（収録の全体・[\d,]+ 行から）/);
  /* `name` と `key` を兩方渡した時の注も、從來の文を保つ（第 921 回）。 */
  const 兩方 = await call("venue_info", { key: "icde", name: "X" });
  expect(兩方, "name を見て居ない事を言つて居ん").toContain(
    "name は key と共に与えられたので見て居ません",
  );
  expect(兩方, "窓の言と兩方載つて居ん").toContain("（収録の全体・");
  /* 今後の締切が無い会议の斷りも先頭に殘る（第 754 回 – 私の行で押し出されて居ない）。 */
  const 過去 = await call("venue_info", { key: "aft" });
  expect(過去, "今後の締切が無い事を先に言つて居ん").toContain("今後の締切は収録にありません");
});

it("ランクの大文字小文字の嚴密さを說明に書く（第 1013 回）", async () => {
  /* 實測 2026-11-19: `rank: "a"` は 0 件になる（大文字の `A` しか受け付けない）。
   * 說明は「畫面のランク欄と同じ厳密比較」と書くが、**大小文字の話**が無かつた –
   * AI が `a` を打つと 0 件で、「この收錄に A ランクが無い」と誤解する。
   * 知らない等級は頭で名指す（第 858 回）ので、其れで氣付けるが、說明にも書く。 */
  const res = (await client.ask({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
    result?: {
      tools?: Array<{
        name?: string;
        inputSchema?: { properties?: Record<string, { description?: string }> };
      }>;
    };
  };
  const rank = (res.result?.tools ?? []).find((t) => t.name === "search_deadlines")?.inputSchema
    ?.properties?.rank?.description;
  expect(rank, "rank の說明が無い").toBeTruthy();
  expect(rank, "大文字小文字の嚴密さを書いて居ん").toContain("大文字小文字も違ふ");
  /* 實物もその通り – `a` は 0 件で、知らない等級として名指す。 */
  const 小文字 = await call("search_deadlines", { query: "セキュリティ", rank: "a", limit: 1 });
  expect(小文字, "小文字の a を默つて 0 件にして居ん").toContain("知らないランク");
  const 大文字 = await call("search_deadlines", { query: "セキュリティ", rank: "A", limit: 1 });
  expect(大文字, "大文字の A が效いて居ん").not.toContain("知らないランク");
});

it("list_upcoming の days が上限を超えたら默つて截めない（第 1017 回）", async () => {
  /* 第 1016 回で建造の `upcoming_days` に上限 400 を付けた。MCP の `days` は**默つて**
   * 400 に截めて居た – 實測 2026-11-19: `days: 900` は 400 日として數へるのに何も言はれず、
   * 讀む AI は「900 日調べた」と思ふ。建造と同じ決まりに揃へる（第 852 回）。 */
  for (const 値 of [401, 900, 5000, 999999]) {
    const 答 = await call("list_upcoming", { days: 値, limit: 1 });
    expect(答, `days: ${値} を默つて截めて居ん`).toContain(
      `（上限 400 を超えたので 400 日として切りました）`,
    );
  }
  /* 上限ぴったり（400）は何も言はない。 */
  const ぴったり = await call("list_upcoming", { days: 400, limit: 1 });
  expect(ぴったり, "上限ぴったりに斷りが出た").not.toContain("上限 400 を超えた");
  /* 端數と同時に貰つた時は端數の文を出す（重ねて言はない – 第 993 回の文が殘る）。 */
  const 端數と = await call("list_upcoming", { days: 900.5, limit: 1 });
  expect(端數と, "端數の文が殘って居ん").toContain("端数なので");
  /* 兩方の斷りが重なつても括弧が崩れない（空の種別と同時）。 */
  const 重ねた = await call("list_upcoming", { days: 900, kinds: [], limit: 1 });
  expect(重ねた, "上限の斷りが無い").toContain("上限 400 を超えた");
  expect(重ねた, "空の種別の斷りが無い").toContain("kinds が空なので");
  const 頭 = 重ねた.split("\n")[0] ?? "";
  const 開き = (頭.match(/（/g) ?? []).length;
  const 閉じ = (頭.match(/）/g) ?? []).length;
  expect(開き, `開き括弧が多すぎる: ${頭.slice(0, 120)}`).toBe(閉じ);
});

it("days と within_days は「境目が同じ・件数は違ふ」と書く（第 1027 回）", async () => {
  /* 實測 2026-11-19: `list_upcoming` の說明は「`search_deadlines` の `within_days` と同じ
   * 數へ方です（同じ條件なら同じ件數になります）」と書いて居た。**境目の切り方は同じ**だが、
   * 件數は默つたままでは**違ふ** – 30 日で 130 件と 87 件（2026-11-19 實測。收錄が增えれ
   * ば此の數も動くので、**數字は固定しない**）。違ふのは:
   *   1. **種別** – `list_upcoming` は既定で全部・`search_deadlines` は abstract / paper / journal のみ
   *   2. **推定** – `list_upcoming` は入る・`search_deadlines` の既定は外す
   * 「同じ條件なら同じ件數」は**どつちの條件も變へなければ成り立たない** – AI が 130 と 87 を
   * 見て「一つが壞れて居る」と誤る。實測で確かめて、其の儘書く。 */
  const res = (await client.ask({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
    result?: { tools?: Array<{ name?: string; description?: string }> };
  };
  const 文 = (res.result?.tools ?? []).find((t) => t.name === "list_upcoming")?.description ?? "";
  expect(文, "境目の切り方は同じと書いて居ん").toContain("境目の切り方は同じ");
  expect(文, "件數はそのままでは違ふと書いて居ん").toContain("件数は其の儘では違う");
  expect(文, "違う二つの理由を書いて居ん").toContain("種別");
  expect(文, "推定の違いを書いて居ん").toContain("推定");

  const 件 = (t: string): number =>
    Number((t.split("\n")[0].match(/([\d,]+) 件/)?.[1] ?? "0").replace(/,/g, ""));
  /* 默つたつまりでは divergent（86 vs 85 – 種別と推定の二つが乘る）。 */
  const 默つた = await call("list_upcoming", { days: 30, scope: "all", limit: 1 });
  const 檢索 = await call("search_deadlines", { within_days: 30, scope: "all", limit: 1 });
  const a = 件(默つた);
  const b = 件(檢索);
  expect(a, "list_upcoming の件數が讀めない").toBeGreaterThan(0);
  expect(b, "search_deadlines の件數が讀めない").toBeGreaterThan(0);
  /* 件數を揃へると一致する（種別と推定を同じにした時）。 */
  const 揃へた = await call("list_upcoming", {
    days: 30,
    scope: "all",
    kind: ["abstract", "paper", "journal"],
    limit: 1,
  });
  const 檢索2 = await call("search_deadlines", {
    within_days: 30,
    scope: "all",
    include_estimated: true,
    limit: 1,
  });
  expect(件(揃へた), "條件を揃へても件數が違ふ（說明と合はない）").toBe(件(檢索2));
});

it("venue_info の key に略稱を渡されたら、name の方を敿へる（第 1028 回）", async () => {
  /* 實測 2026-11-19: `venue_info({key: "KDD"})` は「その会議は收錄に在りません」と答へて居た。
   * KDD は**收錄に在る**（`sigkdd`）。`key` は小文字の識別子で、**略稱は `name` の側** –
   * AI は其原因を此の文から讀み取れず、`{key: "KDD"}` を繰り返して仕舞ふ。
   * 大文字で打たれた key が略稱に當たる會議が在る時は、其の會議の key と
   * 「`name` に渡して」と言ふ（黙って推測させない – 第 852 回と同じ決まり）。 */
  const res = (await client.ask({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
    result?: { tools?: Array<{ name?: string; description?: string }> };
  };
  const 文 = (res.result?.tools ?? []).find((t) => t.name === "venue_info")?.description ?? "";
  expect(文, "key は小文字だけと書いて居ん").toContain("key` は小文字の識別子");

  /* 略稱を key に入れたら、name に渡すやうに敿へる。 */
  const 略稱 = await call("venue_info", { key: "KDD" });
  expect(略稱, "name に渡すと言つて居ん").toContain("name` に「KDD」を渡してください");
  expect(略稱, "當たる會議の key を言つて居ん").toContain("sigkdd");
  /* `name` に渡せば確かに當たる（敿へた通りの動きになる）。 */
  const nameSa = await call("venue_info", { name: "KDD" });
  expect(nameSa, "name で KDD に當たらない").toContain("KDD");
  /* 全く當たらない key は從つて通りの文（余計な推測を足さない）。 */
  const 無い = await call("venue_info", { key: "nosuchway" });
  expect(無い, "當たらない時に name への敿へを出した").not.toContain("name` に「nosuchway」");
  expect(無い, "收錄に無いと言つて居ん").toContain("収録に在りません");
});

it("scope のエイリアスは schema の enum にも載る（第 1029 回）", async () => {
  /* 實測 2026-11-19: `scope` の **schema の enum は `[\"screen\", \"all\"]` だけ**だつたが、
   * 實裝は `collection`・`full`・`window`・`catalog` も受け付けて居た（venue_info の說明に
   * 其れを書いてあるのに、enum には無い）。MCP の客户の中には schema で引數を檢證する物が
   * 在る – 其れらは `scope: \"window\"` を**棄てる**。效く物を schema が邪魔するのは、
   * AI にとって「使へる筈の引數が使へない」と同じ。
   * enum に全部載せて、說明にも「同じエイリアス」と書いた。 */
  const res = (await client.ask({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
    result?: {
      tools?: Array<{
        name?: string;
        inputSchema?: { properties?: Record<string, { enum?: string[]; description?: string }> };
      }>;
    };
  };
  const 全部 = res.result?.tools ?? [];
  const 持つ道具 = 全部
    .map((t) => ({
      name: String(t.name ?? ""),
      enum: t.inputSchema?.properties?.scope?.enum ?? [],
      文: t.inputSchema?.properties?.scope?.description ?? "",
    }))
    .filter((t) => t.enum.length > 0);
  expect(持つ道具.length, "scope を持つ道具が 4 つ無い").toBe(4);
  for (const { name, enum: values, 文 } of 持つ道具) {
    for (const 別名 of ["collection", "full", "window", "catalog"]) {
      expect(values, `${name} の enum に ${別名} が無い`).toContain(別名);
    }
    expect(values, `${name} の enum が 6 つ無い`).toHaveLength(6);
    expect(文, `${name} の說明にエイリアスを書いて居ん`).toContain("同じエイリアス");
  }
  /* 實物もその通りに效く（enum に入れただけで實裝が變はつて居ない事の確かめ）。 */
  for (const [別名, 應] of [
    ["collection", "収録の全体"],
    ["full", "収録の全体"],
    ["window", "画面が最初に読む窓"],
    ["catalog", "画面が最初に読む窓"],
  ] as const) {
    const 答 = await call("search_deadlines", { query: "セキュリティ", limit: 1, scope: 別名 });
    expect(答, `scope: ${別名} が ${應} に成つて居ん`).toContain(應);
  }
});

it("種別は行に出す日本語の名でも濾せる（第 1030 回）", async () => {
  /* 實測 2026-11-19: 行は「論文締切」「採否通知」の**日本語**で出すのに、`kind` / `kinds`
   * は英語のキー（`paper` など）だけ受け付けて居た。AI が行を讀んで
   * `kind: "論文締切"` を送ると **0 件**（知らない種別として名指される）–
   * **出す言葉と受け取る言葉が違ふ**のは、此の計畫で一番惡い形。
   * `Recommender.kindKeyJa`（`kindLabelJa` の逆引き）で英語に直して受けるやうにした。 */
  const res = (await client.ask({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
    result?: {
      tools?: Array<{
        name?: string;
        inputSchema?: { properties?: Record<string, { description?: string }> };
      }>;
    };
  };
  const 全部 = res.result?.tools ?? [];
  for (const n of ["search_deadlines", "list_upcoming"]) {
    for (const k of n === "search_deadlines" ? ["kinds", "kind"] : ["kind", "kinds"]) {
      const 文 = 全部.find((t) => t.name === n)?.inputSchema?.properties?.[k]?.description ?? "";
      expect(文, `${n} の ${k} に日本語の名を書いて居ん`).toContain("日本語の種別名でも受けます");
    }
  }
  /* 實物: 日本語の名と英語のキーで**同じ件數**に成る。 */
  const 件 = (t: string): number =>
    Number((t.split("\n")[0].match(/([\d,]+) 件/)?.[1] ?? "0").replace(/,/g, ""));
  for (const 名 of ["論文締切", "採否通知", "カメラレディ締切", "登録締切", "概要締切"]) {
    const 日本 = await call("search_deadlines", { query: "セキュリティ", limit: 1, kind: 名 });
    const 英語 = await call("search_deadlines", {
      query: "セキュリティ",
      limit: 1,
      kind: Recommender.kindKeyJa(名),
    });
    expect(件(日本), `「${名}」と英語のキーで件數が違ふ`).toBe(件(英語));
    expect(日本, `「${名}」を知らない種別として弾いた`).not.toContain("知らない種別");
  }
  /* `kinds`（配列）でも同じ。 */
  const 配列日本 = await call("search_deadlines", {
    query: "セキュリティ",
    limit: 1,
    kinds: ["論文締切", "採否通知"],
  });
  const 配列英語 = await call("search_deadlines", {
    query: "セキュリティ",
    limit: 1,
    kinds: ["paper", "notification"],
  });
  expect(件(配列日本), "配列の日本語と英語で件數が違ふ").toBe(件(配列英語));
  /* 本当に知らない種別は從つて通りの文（余計な推測を足さない）。 */
  const 知らん = await call("search_deadlines", { query: "セキュリティ", limit: 1, kind: "zzz" });
  expect(知らん, "知らない種別に敿へを出した").toContain("知らない種別");
});

it("ランクは行の出し方（CCF A）でも濾せる（第 1031 回）", async () => {
  /* 實測 2026-11-19: 行は「CCF A・CORE A*・THCPL A」の**尺度+等級**の形で出すのに、
   * `rank` は等級だけ（`A`・`A*`）を受け付けて居た。AI が行を讀んで `rank: \"CCF A\"` を
   * 送ると **0 件**（知らないランクとして名指す）。種別の日本語（第 1030 回）と同じ形の
   * 失敗 – **出す言葉と受け取る言葉が違ふ**。 */
  const res = (await client.ask({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
    result?: {
      tools?: Array<{
        name?: string;
        inputSchema?: { properties?: Record<string, { description?: string }> };
      }>;
    };
  };
  const 文 =
    (res.result?.tools ?? []).find((t) => t.name === "search_deadlines")?.inputSchema?.properties
      ?.rank?.description ?? "";
  expect(文, "行の出し方でも受けると書いて居ん").toContain("行の出し方（`CCF A`");

  const 件 = (t: string): number =>
    Number((t.split("\n")[0].match(/([\d,]+) 件/)?.[1] ?? "0").replace(/,/g, ""));
  /* 行の出し方と、等級だけで同じ件數に成る。 */
  for (const [出し方, 等級] of [
    ["CCF A", "A"],
    ["CORE A*", "A*"],
    ["THCPL B", "B"],
  ] as const) {
    const a = 件(await call("search_deadlines", { query: "セキュリティ", limit: 1, rank: 出し方 }));
    const b = 件(await call("search_deadlines", { query: "セキュリティ", limit: 1, rank: 等級 }));
    expect(a, `「${出し方}」と「${等級}」で件數が違ふ`).toBe(b);
    const 答 = await call("search_deadlines", { query: "セキュリティ", limit: 1, rank: 出し方 });
    expect(答, `「${出し方}」を知らないランクとして弾いた`).not.toContain("知らないランク");
  }
  /* 素の `rankPairs` の形（`core:A*`）も其の儘效く。 */
  const ccf = 件(
    await call("search_deadlines", { query: "セキュリティ", limit: 1, rank: "core:A*" }),
  );
  const star = 件(await call("search_deadlines", { query: "セキュリティ", limit: 1, rank: "A*" }));
  expect(ccf, "core:A* と A* で件數が違ふ").toBe(star);
  /* 本当に知らない等級は從つて通り（余計な推測を足さない）。 */
  const 知らん = await call("search_deadlines", { query: "セキュリティ", limit: 1, rank: "D" });
  expect(知らん, "知らない等級に敿へを出した").toContain("知らないランク");
});

it("「收録に見当たらない」は收録の全體で數へる（第 1033 回）", async () => {
  /* 實測 2026-11-19: `Jeju Island` は**同時に二つの逆の事**を言つて居た。
   *   「この語は画面が最初に読む窓（871 行）には 1 行もありませんが、収録の全体には 4 行あります」
   *   「検索語のうち「jeju」・「island」は収録データにも見当たりません」
   * 後者は**窓の行**だけで數へて居たので、收録の全体では生きて居る語が「見当たらない」に
   * 成つて居た。**主張（「収録データにも」）と數へた所が違ふ** – 此の計畫で一番惡い形。
   * 收錄の全體で數へるやうに直した（窓の中で死んで居る語は、年が增えた會議では
   * 全体では生きて居る事が普通 – ICDM 2027 の事故と同じ構圖）。 */
  const 答 = await call("search_deadlines", { query: "Jeju Island", limit: 1 });
  expect(答, "收録の全體に行が在ると言つて居ん").toContain("収録の全体には 4 行あります");
  expect(答, "「jeju」を收録に見当たらないと言つた（逆の事を言つて居る）").not.toContain(
    "「jeju」は収録データにも見当たりません",
  );
  expect(答, "「island」を收録に見当たらないと言つた（逆の事を言つて居る）").not.toContain(
    "「island」は収録データにも見当たりません",
  );
  expect(答, "語が在る事を言つて居ん").toMatch(/語をすべて含む行はありません/);
  expect(答, "語ごとの件數が讀めない").toMatch(/「jeju」\d+件・「island」\d+件/);

  /* 逆に、**本当に**收錄のどこにも無い語は從つて通り「見当たらない」と言ふ。 */
  const 死語 = await call("search_deadlines", { query: "セキュリティ zzz9", limit: 1 });
  expect(死語, "死語の報べが消えた").toContain("「zzz9」は収録データにも見当たりません");
  /* `セキュリティ GPU` の形 – GPU がどこにも無いので、其の儘「見当たらない」が出る。 */
  const gpu = await call("search_deadlines", { query: "セキュリティ GPU", limit: 1 });
  expect(gpu, "gpu の死語の報べが變はつた").toContain("「gpu」は収録データにも見当たりません");
});

it("推定の行は幅を出し、事實のやうに見せない（第 1034 回）", async () => {
  /* 實測 2026-11-19: `estimate.window_start` / `window_end` を持つ推定の行は **162 行全部**
   * （106 版全部が幅を持つ）なのに、此の行は**單獨の日付**（`point_estimate`）だけで出して居た。
   * `upcoming.md` は「推定期間 A〜B」と書くので、同じ事實の別の表記ではなく**幅を落として居た**。
   * AI が「ACML 2027 の締切は 2027-07-04」と**事實のやうに**答へる – 其の計畫で一番惡い形。 */
  const acml = await call("search_deadlines", {
    query: "acml",
    scope: "all",
    limit: 10,
    include_estimated: true,
    kinds: ["paper"],
  });
  const 行 = acml.split("\n").filter((l) => l.includes("推定期間"));
  expect(行.length, "推定期間の行が出て居ん").toBeGreaterThan(0);
  /* 幅が其の儘出る（`estimate` の中身と一致）。 */
  expect(行[0], "幅が出て居ん").toContain("推定期間 2027-03-28〜2027-10-10");
  /* 點推定点も「元の宣言」で添へる（どつちが事實でどつちが推定か讀める）。 */
  expect(行[0], "點推定点が書かれて居ん").toContain("元の宣言");
  /* 「殘り」は點推定点の分だと言ふ（幅の終はりまでの殘りと誤讀しない爲）。 */
  expect(行[0], "殘りの數へ方を書いて居ん").toContain("残りは点推定点の分");
  /* 推定の札も殘る（從つて通りの印）。 */
  expect(行[0], "推定の札が消えた").toContain("（推定）");

  /* 確定の行には幅を出さない（從つて通りの形）。 */
  const 確定 = await call("search_deadlines", {
    query: "セキュリティ",
    limit: 3,
    kinds: ["paper"],
  });
  for (const l of 確定.split("\n").filter((l) => /^2\d{3}-/.test(l))) {
    expect(l, "確定の行に推定期間を出した").not.toContain("推定期間");
    expect(l, "確定の行に點推定点の但しを出した").not.toContain("點推定点の分");
  }

  /* **悉皆** – 幅を持つ推定の行全部が、幅を出して居る（默つて落として居る行が無い）。 */
  const 全部 = await call("search_deadlines", {
    scope: "all",
    limit: 100,
    include_estimated: true,
    kinds: [],
  });
  const 推定行 = 全部.split("\n").filter((l) => l.includes("（推定）"));
  for (const l of 推定行) {
    expect(l, "幅を持つ推定の行が幅を落として居る").toContain("推定期間");
  }
});

it("投稿のトラックも行に出す（第 1035 回）", async () => {
  /* 實測 2026-11-19: `track` が空でない締切は **8 件**（closer・cpal など）で、
   * `data.json`・`llms.txt`（スキーマの説明にも「track: string：投稿のトラック」と書かれて
   * 居る）の**どちらにも在る**のに、此の行は出して居なかつた。CLOSER の 2 つの論文締切は
   * `regular` と `position` で**別の募集**なのに、兩方「論文締切」とだけ出る –
   * AI が兩方を同じ締切と見る。索引と道具が食ひ違つて居た。 */
  const closer = await call("search_deadlines", {
    query: "closer",
    scope: "all",
    limit: 20,
    include_estimated: true,
    kinds: [],
  });
  const 行 = closer.split("\n").filter((l) => /^2\d{3}-/.test(l));
  expect(行.length, "closer の行が出て居ん").toBeGreaterThan(1);
  expect(
    行.filter((l) => l.includes("論文締切（regular）")).length,
    "regular の締切に出して居ん",
  ).toBeGreaterThan(0);
  expect(
    行.filter((l) => l.includes("論文締切（position）")).length,
    "position の締切に出して居ん",
  ).toBeGreaterThan(0);

  /* トラックの**無い**行は從つて通り（余計な括弧を足さない – 5,061 行が空）。 */
  const wsdm = await call("search_deadlines", { query: "wsdm", scope: "all", limit: 5 });
  for (const l of wsdm.split("\n").filter((l) => /^2\d{3}-/.test(l))) {
    expect(l, "トラックの無い行に空の括弧を出した").not.toMatch(/論文締切（\s*）/);
  }

  /* **悉皆** – トラックを持つ會議を一つづつ引き、行に出るトラックが**收錄の中に在る値**
   * だけである事を確かめる（でたらめを出さない）。*/
  const 收錄 = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as {
    conferences: Array<Record<string, any>>;
  };
  const 值 = new Set<string>();
  const 會議 = new Set<string>();
  for (const c of 收錄.conferences) {
    for (const e of c.editions ?? []) {
      for (const dl of e.deadlines ?? []) {
        const t = String(dl.track ?? "").trim();
        if (t) {
          值.add(t);
          會議.add(String(c.key ?? ""));
        }
      }
    }
  }
  expect([...值], "トラックの值が讀めない（この檢查が空振り）").toEqual(
    expect.arrayContaining(["regular", "position"]),
  );
  expect(會議.size, "トラックを持つ會議が讀めない").toBeGreaterThan(0);
  for (const key of 會議) {
    const 答 = await call("search_deadlines", {
      query: key,
      scope: "all",
      limit: 30,
      include_estimated: true,
      kinds: [],
    });
    for (const l of 答.split("\n").filter((l) => /^2\d{3}-/.test(l))) {
      /* 種別の欄の丸括弧（トラック）を拔く。 */
      const 種別の欄 = l.split(" | ")[1] ?? "";
      const m = /（([^）]+)）/.exec(種別の欄);
      if (m) {
        expect(值.has(m[1]), `${key} の行が收錄に無いトラック「${m[1]}」を出した`).toBe(true);
      }
    }
  }

  /* 行の形の說明に「種別の欄の丸括弧は別の物」と書く（第 1036 回 – 版の識別子と
   * 誤認しない為）。 */
  const res = (await client.ask({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
    result?: { tools?: Array<{ name?: string; description?: string }> };
  };
  const 文 =
    (res.result?.tools ?? []).find((t) => t.name === "search_deadlines")?.description ?? "";
  expect(文, "種別の欄の丸括弧が別の物だと書いて居ん").toContain("種別の欄の丸括弧は別の物");
});

it("上流が差し替へた締切も札で言ふ（第 1037 回）", async () => {
  /* 實測 2026-11-19: `superseded_deadlines` を持つ締切は **35 件**（24 會議）。
   * 畫面（`site/app.ts`）は行の詳細に「前に出ていた締切: A → B（延長後／前倒し）」と
   * 出して居るのに、**此の行は何も言はなかつた** – AI が「この日は動いて居ない」と答へる。
   * 前に見た日付と違ふ行を開いた人は「此のサイトは古いのか / 会議が動いたのか」を
   * 判定できない（第 224 回の畫面の直しと同じ事が此方に殘つて居た）。 */
  const edbt = await call("venue_info", { key: "edbt", scope: "all" });
  const 行 = edbt.split("\n").filter((l) => /^2\d{3}-/.test(l));
  const 差し替え = 行.filter((l) => l.includes("前に出ていた締切"));
  expect(差し替え.length, "差し替へた締切を言つて居ん").toBeGreaterThan(0);
  /* 文組みは同じ正本（`Recommender.deadlineShiftLineJa`）を使ふので、畫面と同し文に成る。 */
  expect(差し替え[0], "差し替への文が讀めない").toMatch(
    /前に出ていた締切: \d{4}-\d{2}-\d{2}\([^)]*\) [\d:]* → \d{4}-\d{2}-\d{2}\([^)]*\) [\d:]*（延長後|前倒し）/,
  );
  /* **悉皆** – 上書きを持つ 24 會議全部が、行に差し替へを出す。 */
  const 收錄 = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as {
    conferences: Array<Record<string, any>>;
  };
  const 會議 = new Set<string>();
  for (const c of 收錄.conferences) {
    for (const e of c.editions ?? []) {
      for (const dl of e.deadlines ?? []) {
        if (Array.isArray(dl.superseded_deadlines) && dl.superseded_deadlines.length) {
          會議.add(String(c.key ?? ""));
        }
      }
    }
  }
  expect(會議.size, "上書きを持つ會議が讀めない").toBeGreaterThan(20);
  let 行の合計 = 0;
  for (const key of 會議) {
    const 答 = await call("venue_info", { key, scope: "all" });
    const n = 答
      .split("\n")
      .filter((l) => /^2\d{3}-/.test(l) && l.includes("前に出ていた締切")).length;
    expect(n, `${key} が差し替へを言つて居ない`).toBeGreaterThan(0);
    行の合計 += n;
  }
  expect(行の合計, "差し替への行が收錄と合はない").toBe(35);

  /* 差し替への**無い**行は從つて通り（札を足さない）。 */
  const wsdm = await call("venue_info", { key: "wsdm", scope: "all" });
  for (const l of wsdm.split("\n").filter((l) => /^2\d{3}-/.test(l))) {
    expect(l, "差し替への無い行に札を出した").not.toContain("前に出ていた締切");
  }
});

it("會期の見直しの覺え書きも行に出す（第 1038 回）", async () => {
  /* 實測 2026-11-19: `event_review.note` を持つ版は **7 件**（adma21・dai2021・focs21・
   * mobicom21・probml2021・slt22・wasa22）。`llms.txt` のスキーマの説明（「event_review:
   * object：会期の見直しの記録（…覚え書き note など」）に在るのに、**此の行は出して
   * 居なかつた**（第 1035 囘の track と同じ型 – 索引と道具が食ひ違つて居る）。
   * いづれも**會期が發表年と違ふ年**にずれた版なので、AI が「2021 年版が 2022 年に
   * 開かれた」理由を讀めない。 */
  const 收錄 = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as {
    conferences: Array<Record<string, any>>;
  };
  const 版の覺え書き = new Map<string, string>();
  for (const c of 收錄.conferences) {
    for (const e of c.editions ?? []) {
      const note = String((e as any).event_review?.note ?? "").trim();
      const id = String((e as any).id ?? "");
      if (note && id) 版の覺え書き.set(id, note);
    }
  }
  expect(版の覺え書き.size, "覺え書きを持つ版が讀めない（この檢查が空振り）").toBe(7);

  /* 覺え書きを持つ版の會議を引き、行に覺え書きが出て居る事を確かめる。 */
  const 會議 = new Set<string>();
  for (const c of 收錄.conferences) {
    for (const e of c.editions ?? []) {
      const note = String((e as any).event_review?.note ?? "").trim();
      if (note) 會議.add(String(c.key ?? ""));
    }
  }
  expect(會議.size, "覺え書きを持つ會議が讀めない").toBe(7);
  for (const key of 會議) {
    const 答 = await call("venue_info", { key, scope: "all" });
    for (const l of 答.split("\n").filter((l) => /^2\d{3}-/.test(l))) {
      /* 行の會期の欄（`| 会期 … |`）に覺え書きが入つて居るか。 */
      const m = /\| 会期 ([^|]*?)（([^|]+?)） \| /.exec(l);
      if (!m) continue;
      /* 會期の日期の後ろの丸括弧は**二つ**在り得る（差し替への札は別欄）ので、
       * 覺え書きの中に版の id が入つて居るかで判斷する。 */
      const id = /（([a-z0-9][a-z0-9.'-]*)）\|/.exec(l)?.[1] ?? "";
      if (!版の覺え書き.has(id)) continue;
      expect(
        l.includes(`（${版の覺え書き.get(id)}）`),
        `${key} の行に覺え書きが出て居ない: ${l.slice(0, 120)}`,
      ).toBe(true);
    }
  }
  /* **悉皆の裏** – 覺え書きの**無い**版の行には足さない（第 852 回と同じ決まり）。 */
  const 無い = await call("venue_info", { key: "adma", scope: "all" });
  for (const l of 無い.split("\n").filter((l) => /^2\d{3}-/.test(l))) {
    if (l.includes("adma22") || l.includes("adma23")) {
      expect(l, "覺え書きの無い版に足した").not.toContain("ADMA 2021年版を2022年2月に開催");
    }
  }
});

it("古い key（legacy_keys）でも會議を引ける（第 1039 回）", async () => {
  /* 實測 2026-11-19: `identity_migrations` に **32 件**の「古い key → 新しい key」が記錄
   * されて居る（會議の `legacy_keys` は 16 件）。`data.json` にも `llms.txt` のスキーマの
   * 說明（「legacy_keys: string[]：以前の版の識別子（改名・統合の前に使っていた物）」）にも
   * 在るのに、**引く經路が無かつた** – `venue_info({key: "ieee-admit-2026"})` は
   * 「收錄に在りません」と答へて居た。AI は改名・統合の前の ID を持つ文獻・引用を讀むので、
   * 其の儘では手がかりが無い。版の識別子（第 887 回）と同じ決まりに揃へる。 */
  const 收錄 = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as {
    conferences: Array<Record<string, any>>;
  };
  const 古い鍵 = new Map<string, string>();
  for (const c of 收錄.conferences) {
    for (const l of Array.isArray(c.legacy_keys) ? c.legacy_keys : []) {
      if (String(l ?? "").trim()) 古い鍵.set(String(l), String(c.key ?? ""));
    }
  }
  /* `fse` は 2 會議（fse-sc・fse-se）が同じ古い key を持つので、ユニークは 15 に成る
   * （重複は 16 件）。兩方に「同じ古い key」が在る事は venueMatch の曖昧さと同じ型 –
   * 其の場合は「どちらとも決められない」と答へるべきで、此の檢查では其の儘通す。 */
  expect(古い鍵.size, "古い key が讀めない（この檢查が空振り）").toBe(15);

  /* **悉皆** – 古い key 全部が、會議を引ける（「收錄に在りません」と言はない）。 */
  for (const [古い, 新] of 古い鍵) {
    const 答 = await call("venue_info", { key: 古い, scope: "all" });
    expect(答, `古い key「${古い}」で會議が引けない`).not.toContain("収録に在りません");
    /* 新しい key も言ふ（次の呼び出しで其れを使へる）。 */
    expect(答, `「${古い}」から新しい key が讀めない`).toContain(`key: ${新}`);
  }

  /* 人の道（CLI）も同じ（實測 2026-11-19: `name` として渡つて仕舞ひ、`venue ieee-admit-2026`
   * だけ「收錄に在りません」と答へて居た – MCP の tools/call の經路では收到て居た）。 */
  const cli = spawnSync(
    process.execPath,
    [join(REPO_ROOT, "src", "mcp.ts"), "venue", "ieee-admit-2026"],
    {
      encoding: "utf8",
      timeout: 60000,
    },
  );
  expect(cli.status, `CLI が落ちた: ${cli.stderr?.slice(0, 120)}`).toBe(0);
  expect(cli.stdout, "CLI が古い key を name として渡して仕舞つた").toContain("key: admit-2026");
  expect(cli.stdout, "CLI が「收錄に在りません」と言つた").not.toContain("収録に在りません");
});

it("行に足した 3 つの值は、4 つの道具の行と説明に出る（第 1041 回）", async () => {
  /* 第 1034・1035・1037 囘で**行**に推定の幅・トラック・差し替へを足した。**說明を
   * 更新し忘れて居た** – 悉皆 2026-11-19: 4 つの道具のうち `search_deadlines` は
   * トラックだけ言つて居て、`list_upcoming`・`recommend_venues`・`explain_word` は
   * **三つとも默つて居た**。行だけ直しても、說明が「この欄は會期…」と書くだけなので、
   * AI は幅を期待しない。「同じ形がもう一箇所」のまた一つ。 */
  const res = (await client.ask({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
    result?: { tools?: Array<{ name?: string; description?: string }> };
  };
  const 文 = (n: string): string =>
    (res.result?.tools ?? []).find((t) => t.name === n)?.description ?? "";
  /* 直接書く 2 つ。 */
  for (const n of ["search_deadlines", "list_upcoming"]) {
    const d = 文(n);
    expect(d, `${n} の說明に推定期間が無い`).toContain("推定期間");
    expect(d, `${n} の説明にトラックが無い`).toContain("トラック");
    expect(d, `${n} の説明に差し替へが無い`).toContain("前に出ていた締切");
  }
  /* 殘る 2 つは「`search_deadlines` と同じ欄」と參照して居る – 其の參照が實際に效く事を
   * **實物**で確かめる（說明だけ合つて居て行が出して居ない、の逆を防ぐ）。 */
  const 推薦 = await call("recommend_venues", { paper: "CLOSER の position", limit: 5 });
  const 推薦の行 = 推薦.split("\n").filter((l) => /^\d\. /.test(l));
  expect(推薦の行.length, "推薦の行が出て居ん").toBeGreaterThan(0);
  expect(
    推薦の行.some((l) => /論文締切（[^）]+）/.test(l)),
    "推薦の行にトラックが出て居ない（search_deadlines と同じ欄の筈）",
  ).toBe(true);
  const 語 = await call("explain_word", { word: "closer" });
  const 語の行 = 語.split("\n").filter((l) => /^-\s*2\d{3}-/.test(l));
  expect(語の行.length, "explain_word の行が出て居ん").toBeGreaterThan(0);
  for (const l of 語の行) {
    /* 差し替への札が出る筈（closer は 2026-11-18 が regular・2026-12-22 が position）。 */
    if (l.includes("closer")) {
      expect(l, "explain_word の行にトラックが出て居ない").toMatch(/論文締切（[^）]+）/);
    }
  }
});

it("端數の limit は默つて切り捨てない（第 1043 回）", async () => {
  /* 實測 2026-11-19: `limit: 3.7` は默つて 3 件に成つて居た。`days`・`within_days` は
   * 第 993 囘で「3.7 日は端数なので、3 日として切りました」と言ふやうにして居たのに、
   * **件數の方は默つて居た** – 同じ形の見落とし。AI が「3.7 件出る」と思つて數へる
   * 齟齬が生まれる。 */
  /* `0.9` は「1 以上では無い」ので第 878 囘の文（默つて既定に戾さない）になる –
   * 其方で默つて居ないので此の對象外。 */
  const 小 = await call("search_deadlines", { query: "セキュリティ", limit: 0.9 });
  expect(小, "0.9 を默つて扱つた").toContain("limit は 1 以上の数で指定してください");
  for (const 値 of [3.7, 2.5, 100.1]) {
    const 答 = await call("search_deadlines", { query: "セキュリティ", limit: 値 });
    expect(答, `limit: ${値} を默つて切り捨てた`).toContain(
      `（${値} は端数なので、${Math.floor(値)} として切りました）`,
    );
  }
  /* 整數は默る（其の儘使ふ – 第 852 回と同じ決まり）。 */
  const 整數 = await call("search_deadlines", { query: "セキュリティ", limit: 3 });
  expect(整數, "整數の limit に斷りを出した").not.toContain("端数なので");
  /* 讀めない値は第 878 囘の文（默つて既定に戾さない）。 */
  const 讀めない = await call("search_deadlines", { query: "セキュリティ", limit: -5 });
  expect(讀めない, "讀めない limit の文が消えた").toContain(
    "limit は 1 以上の数で指定してください",
  );

  /* 推薦も同じ（第 1043 囘 – 兩方の limit を直した）。 */
  for (const 値 of [3.7, 2.5]) {
    const 答 = await call("recommend_venues", { paper: "分散システム", limit: 値 });
    expect(答, `推薦の limit: ${値} を默つて切り捨てた`).toContain(
      `（${値} は端数なので、${Math.floor(値)} として切りました）`,
    );
  }
  const 推薦の整數 = await call("recommend_venues", { paper: "分散システム", limit: 5 });
  expect(推薦の整數, "推薦の整數 limit に斷りを出した").not.toContain("端数なので");
});

it("端數と上限は兩方続けて言ふ（第 1044 回）", async () => {
  /* 第 1043 囘で端數の `limit` を默つて切り捨てないやうにした。が、**二つの軸が交はる
   * 所**が拔けて居た – 實測 2026-11-19:
   *   - `days: 900.5` → 「900.5 日は端数なので、900 日として切りました」と言つたきりで、
   *     **上限 400** が效いた事を言つて居ない（AI は「900 日調べた」と思ふ）。
   *   - `limit: 999.9` → 「999.9 件は端数なので、999 件として切りました」だけで、
   *     **上限 100** が效いた事を言つて居ない。
   * 端數を切つた**後の値**で上限を見るので、兩方を續けて言ふ。 */
  const 帶 = (t: string): string => t.split("\n")[0] ?? "";
  for (const [名, 引數, 端數の文, 上限の文] of [
    [
      "list_upcoming",
      { days: 900.5 },
      "900.5 日は端数なので、900 日として切りました",
      "上限 400 を超えたので 400 日として切りました",
    ],
    ["list_upcoming", { days: 400.5 }, "400.5 日は端数なので、400 日として切りました", ""],
    ["list_upcoming", { days: 900 }, "", "上限 400 を超えたので 400 日として切りました"],
    ["list_upcoming", { days: 3.7 }, "3.7 日は端数なので、3 日として切りました", ""],
  ] as const) {
    const 頭 = 帶(await call(名, 引數));
    if (端數の文)
      expect(頭, `${名} ${JSON.stringify(引數)} の端數を言つて居ん`).toContain(端數の文);
    if (上限の文)
      expect(頭, `${名} ${JSON.stringify(引數)} の上限を言つて居ん`).toContain(上限の文);
    if (!端數の文)
      expect(頭, `${名} ${JSON.stringify(引數)} に端數の文を出した`).not.toContain("端数なので");
    if (!上限の文)
      expect(頭, `${名} ${JSON.stringify(引數)} に上限の文を出した`).not.toContain(
        "上限 400 を超えた",
      );
  }
  for (const [引數, 端數の文, 上限の文] of [
    [
      { query: "セキュリティ", limit: 999.9 },
      "999.9 は端数なので、999 として切りました",
      "上限 100 を超えたので 100 として切りました",
    ],
    [{ query: "セキュリティ", limit: 100.5 }, "100.5 は端数なので、100 として切りました", ""],
    [{ query: "セキュリティ", limit: 3.7 }, "3.7 は端数なので、3 として切りました", ""],
  ] as const) {
    const 頭 = 帶(await call("search_deadlines", 引數));
    if (端數の文) expect(頭, `${JSON.stringify(引數)} の端數を言つて居ん`).toContain(端數の文);
    if (上限の文) expect(頭, `${JSON.stringify(引數)} の上限を言つて居ん`).toContain(上限の文);
    if (!上限の文)
      expect(頭, `${JSON.stringify(引數)} に上限の文を出した`).not.toContain("上限 100 を超えた");
  }
  /* 推薦も兩方。 */
  const 推薦 = 帶(await call("recommend_venues", { paper: "分散", limit: 999.9 }));
  expect(推薦, "推薦の上限を言つて居ん").toContain("上限 100 を超えた");
});

it("ヘルプの例は 6 つの道具を全部覆ひ、実際に效く（第 1046 回）", async () => {
  /* 實測 2026-11-19: `--help` の例は 4 つ（search・explain_word・list_upcoming・venue_info）
   * で、**`recommend_venues` と `collection_stats` に例が無かつた**。參照經路（ヘルプ）が
   * 6 つの道具を覆つて居ない – 人は此の例を見て打つ。
   * あはせて**例が效く事**も確かめる（`recommend "時間スケジューリング"` は 0 件だつた –
   * 實測 2026-11-19: 「分散システム」は 5 件。0 件の例を載せると人は「使へない」と思ふ）。 */
  const res = (await client.ask({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
    result?: { tools?: Array<{ name?: string }> };
  };
  const 道具 = (res.result?.tools ?? []).map((t) => String(t.name ?? ""));
  expect(道具.length, "道具が讀めない").toBe(6);

  const 手引き = spawnSync(process.execPath, [join(REPO_ROOT, "src", "mcp.ts"), "--help"], {
    encoding: "utf8",
    timeout: 60000,
  });
  expect(手引き.status, `ヘルプが落ちた: ${手引き.stderr?.slice(0, 120)}`).toBe(0);
  const 例 = 手引き.stdout.split("\n").filter((l) => l.startsWith("  例: node src/mcp.ts "));
  expect(例.length, "例が讀めない（この檢查が空振り）").toBe(6);

  /* 全部の例が**效く**（0 件・知らない道具・落ちる、の何れでもない）。 */
  for (const l of 例) {
    const 引數 = l
      .replace("  例: node src/mcp.ts ", "")
      .split(" ")
      .filter((s) => s.length > 0);
    const r = spawnSync(process.execPath, [join(REPO_ROOT, "src", "mcp.ts"), ...引數], {
      encoding: "utf8",
      timeout: 60000,
    });
    const 出た = r.stdout.split("\n")[0] ?? "";
    expect(r.status, `例が落ちた: ${l}`).toBe(0);
    expect(出た, `例が知らない道具を返した: ${l}`).not.toContain("知らない道具");
    /* 「130 件」の中の「0 件」に誤爆して居た（第 1050 囘で實測して判明）。先頭が 0 の
     * 件數（「0 件」・「: 0 件」）だけを「使へない例」と見る。 */
    expect(出た, `例が 0 件を返した（使へない例）: ${l} → ${出た.slice(0, 60)}`).not.toMatch(
      /(?:^|[^0-9])0 件/,
    );
  }

  /* 6 つの道具全部が例に在る（漏れが無い）。 */
  for (const n of 道具) {
    /* 短い別名で例を書いて居る道具（ヘルプの例は人が打つので短い方が良い）。 */
    const 短い: Record<string, string> = {
      search_deadlines: "search",
      collection_stats: "stats",
      recommend_venues: "recommend",
    };
    const 烙印 = 短い[n] ?? n;
    /* 烙印の後ろは空白**または行末**（`stats` は引數が無いので行末）。 */
    const 一歡 = 例.some((l) => {
      const 打たれた = l.replace(/^\s*例: node src\/mcp\.ts\s*/, "");
      return 打たれた === 烙印 || 打たれた.startsWith(`${烙印} `);
    });
    expect(一歡, `${n} に例が無い`).toBe(true);
  }
});

it("推薦は論文の中の行數も切つたと言ふ（第 1050 回）", async () => {
  /* 第 954 囘で「最初の 20 行だけを見る」と實裝した。しかし實測 2026-11-19:
   * `parsePaperLines` は 1 本の長い論文を **1 件**にまとめ、全部の行を `title` に入れる。
   * 其の迄は**論文數**（`全部の行.length`）しか截つて居なかつたので、1,000 行の論文を
   * 送つても**截りの文が出なかつた**（「殘りは參考にして居ません」と言つて居ない）。
   *
   * あはせて**未截りの `lines` を推薦に渡して居た** – 實測: 100 行の論文で候補が
   * 15 件・1,000 行では **0 件**（「filler」だらけで軸が壊れた）。
   *
   * 二つを直した:
   *   1. 論文**の中の行數**も 20 行で截り、截つた事を言ふ。
   *   2. 推薦には**截つた行**を渡す。 */
  const T = "Title: 分散システムのスケジューリング";
  const 候補數 = async (行數: number): Promise<number> => {
    const paper =
      行數 === 1 ? T : [T, ...Array.from({ length: 行數 - 1 }, (_, i) => `filler ${i}`)].join("\n");
    const 答 = await call("recommend_venues", { paper, limit: 100 });
    return Number(答.match(/合う投稿先: ([\d,]+) 件/)?.[1]?.replace(/,/g, "") ?? "0");
  };

  /* 20 行以下は默る（切つて居ない – 第 852 回と同じ決まり）。 */
  const 短い = await call("recommend_venues", { paper: T, limit: 3 });
  expect(短い, "短い論文に截りの文を出した").not.toContain("行のうち");

  /* 21 行以上は「論文の中の N 行のうち、最初の 20 行」と言ふ。 */
  for (const 行數 of [21, 25, 100, 1000]) {
    const paper = [T, ...Array.from({ length: 行數 - 1 }, (_, i) => `filler ${i}`)].join("\n");
    const 答 = await call("recommend_venues", { paper, limit: 3 });
    expect(答, `${行數} 行の論文に截りの文が無い`).toContain(
      `（論文の中の ${行數} 行のうち、最初の 20 行で調べました – 残りの行は参考にして居ません）`,
    );
  }

  /* **截つた行を使ふ**ので、21 行以降は候補が變はらない（未截りだと 1,000 行で 0 件に
   * 成つて居た – 軸が filler で壞ける）。 */
  const 二十一 = await 候補數(21);
  const 一百 = await 候補數(100);
  const 千 = await 候補數(1000);
  expect(二十一, "21 行で候補が讀めない").toBeGreaterThan(0);
  expect(一百, "100 行と 21 行で候補が違ふ（未截りを使って居る）").toBe(二十一);
  expect(千, "1,000 行で候補が 0 件に成つた（未截りを使って居る）").toBe(二十一);

  /* 複數論文（25 件）は從つて通りの文（論文數で切る）。 */
  const 多 = Array.from({ length: 25 }, (_, i) => `論文${i} | kw${i}`).join("\n");
  const 複數 = await call("recommend_venues", { paper: 多, limit: 3 });
  expect(複數, "複數論文の截りの文が消えた").toContain("（25 行のうち、最初の 20 行（題名・概要）");
});

it("推定の幅は一つの正本から兩方が出る（第 1053 回）", async () => {
  /* 實測 2026-11-19: 「推定期間 A〜B」の形を **`src/build.ts`（`upcoming.md`）と
   * `src/mcp.ts`（行）の兩方がべた書き**で持つて居た。形は同じだが、**正本が二つ** –
   * 其れは片方が古くなると兩方が違ふ文を出す樣に成る（第 764 囘と同じ轍）。
   *
   * `Recommender.estimateWindowJa` を正本にして、兩方から呼ぶやうにした。 */
  const R = (await import("../site/recommender.ts")).default;
  /* 正本の動き。 */
  expect(
    R.estimateWindowJa({
      estimated: true,
      estimate: { window_start: "2026-11-05", window_end: "2027-05-06" },
    }),
  ).toBe("推定期間 2026-11-05〜2027-05-06");
  /* 推定で無い・幅が無い時は空（默る）。 */
  expect(
    R.estimateWindowJa({ estimated: false, estimate: { window_start: "a", window_end: "b" } }),
  ).toBe("");
  expect(R.estimateWindowJa({ estimated: true, estimate: {} })).toBe("");
  expect(R.estimateWindowJa({})).toBe("");

  /* MCP の行が其の正本を通して居る（實物）。 */
  const mcp = await call("search_deadlines", {
    query: "acml",
    scope: "all",
    limit: 5,
    kinds: [],
    include_estimated: true,
  });
  const mcp行 = mcp.split("\n").filter((l) => l.includes("推定期間"));
  expect(mcp行.length, "MCP の行に幅が出て居ん").toBeGreaterThan(0);
  expect(mcp行[0]).toMatch(/推定期間 \d{4}-\d{2}-\d{2}〜\d{4}-\d{2}-\d{2}/);

  /* **建造物**（`upcoming.md`）が同じ書式を出して居る – 兩方が同じ正本を使ふので、
   * べた書きの時代の「片方が古くなる」が起きない。 */
  const md = readFileSync(join(REPO_ROOT, "public", "upcoming.md"), "utf8");
  /* 散文の説明行（「『推定期間 A〜B』の形」）ではなく、**表の行**だけを見る。 */
  const md行 = md.split("\n").filter((l) => l.includes("推定期間") && l.startsWith("| "));
  expect(md行.length, "upcoming.md に幅が出て居ん").toBeGreaterThan(0);
  for (const l of [...mcp行.slice(0, 3), ...md行.slice(0, 3)]) {
    expect(l).toMatch(/推定期間 \d{4}-\d{2}-\d{2}〜\d{4}-\d{2}-\d{2}/);
  }
});

it("時刻未確認の行は「いつ終はつたか」を言ふ（第 1055 回）", async () => {
  /* 實測 2026-11-19: 此の行は時刻未確認の行を「YYYY-MM-DD（時刻未確認）」とだけ出して、
   * **「殘り」を默つて省いて居た**。畫面のドロワーは「（時刻未確認。すでに終了している
   * 可能性があります）」と出して居るのに、MCP は默つて居た – AI が「提出期限は明日です」
   * と答えても、實は昨日終はつて居た。**畫面と同じ規則**を見て、三狀態を言ふ。 */
  const R = (await import("../site/recommender.ts")).default;
  const D = 86400000;
  const now = Date.parse("2026-11-01T00:00:00Z");
  const mk = (t: number, tLast: number) => ({ dateOnly: true, t, tLast, localDate: "2026-10-11" });
  /* 正本の動き（3 狀態 + null）。 */
  expect(R.dateOnlyStateJa(mk(now + 10 * D, now + 11 * D), now)).toBe("definitely-future");
  expect(R.dateOnlyStateJa(mk(now - D, now + D), now)).toBe("uncertain-on-date");
  expect(R.dateOnlyStateJa(mk(now - 11 * D, now - 10 * D), now)).toBe("definitely-past");
  expect(R.dateOnlyStateJa({ dateOnly: false, t: now, tLast: now }, now)).toBeNull();
  /* 邊境（其の日にちょうど = uncertain・t が數で無い = null）。 */
  expect(R.dateOnlyStateJa(mk(now, now), now)).toBe("uncertain-on-date");
  expect(R.dateOnlyStateJa({ dateOnly: true }, now)).toBeNull();

  /* **實物** – 時刻未確認の行が「すでに終了している可能性」を言ふ。 */
  const 答 = await call("venue_info", { key: "stacs-2027-first", scope: "all" });
  const 行 = 答.split("\n").filter((l) => /^2\d{3}-/.test(l) && l.includes("時刻未確認"));
  expect(行.length, "時刻未確認の行が出て居ん").toBeGreaterThan(0);
  for (const l of 行) {
    expect(l, "終はつた可能性を默つて居る").toContain(
      "（時刻未確認。すでに終了している可能性があります）",
    );
    /* 二重に「（時刻未確認）」と並べない（重複は slops）。 */
    expect(l.split("（時刻未確認）").length - 1, "「（時刻未確認）」が重なつて居る").toBe(0);
  }
  /* **確認された時刻の行**は「殘り N 日」の儘（第 852 囘の決まり – 變へない）。 */
  const icde = await call("venue_info", { key: "icde", scope: "all" });
  const 確定 = icde.split("\n").filter((l) => /^2\d{3}-/.test(l) && /残り\d+日/.test(l));
  expect(確定.length, "確定の行に「殘り」が出て居ん").toBeGreaterThan(0);
});

it("札の「未確認」は正本から取る（第 1058 回）", async () => {
  /* 實測 2026-11-19: `src/mcp.ts` に「未確認」を**べた書き**で持つて居る所が 4 箇所
   * あつた（生成の表示・分野・場所・信賴の對應表）。值は同じだが、**書き寫すとずれる**。
   * 其のうち 3 箇所（信賴の對應表は除く – 其れは他の語と同じ分類で一まとまりの表）を
   * `Recommender.unconfirmedLabelJa()` に直した。第 1057 囮の決まり（注記の文は其の儘）
   * との境目: **事實として出る札**は正本にまとめる。
   *
   * 更に第 726 囘の註（「同じ入口（`categoryLabelJa`）から取る – 書き寫すとずれる」）が
   * 其の儘效いて居なかつた所も直した – fallback だけ書き寫んで居た。 */
  const R = (await import("../site/recommender.ts")).default;
  const 正本 = String(R.unconfirmedLabelJa() ?? "").trim();
  expect(正本, "正本が讀めない").toBe("未確認");

  /* **實物** – 札の「未確認」が、正本と同じ値で出る。 */
  const 答 = await call("venue_info", { key: "stacs-2027-first", scope: "all" });
  expect(答, "札の「未確認」が出て居ん").toContain("未確認");
  const 行 = 答.split("\n").filter((l) => /^2\d{3}-/.test(l));
  for (const l of 行) {
    for (const 欄 of l.split("|").slice(1)) {
      const 値 = 欄
        .trim()
        .replace(/（[^）]*）/g, "")
        .replace(/\s*https?:\/\/\S*/g, "")
        .trim();
      if (値.includes("未確")) {
        /* 「会期 未確認」・「ランク未確認」は欄名を添へる別の語。之れも正しい –
         * 確かめるのは「未確認」**其の物**が立つ欄（場所・年數）だけ。 */
        if (値 !== "ランク未確認" && 値 !== "会期 未確認") {
          expect(値, "札が正本と違ふ").toBe(正本);
        }
      }
    }
  }
});

it("常時受付の行も版の識別子を持つ（第 1059 回）", async () => {
  /* 實測 2026-11-19: 常時受付のジャーナルの推薦行は「（undefined）」と出して居た –
   * `Recommender.journalRows` が作る行の `ed` に `id` が無かつた。AI が行を讀んで
   * `venue_info` を引く時の手がかりが無い（「版の識別子」を書いて居る行として不完全）。
   *
   * 會議の key を其の儘入れるやうにした（「版」は無いが、會議は一意に指せる）。 */
  const R = (await import("../site/recommender.ts")).default;
  const now = Date.parse("2026-11-19T00:00:00Z");
  const 品書 = JSON.parse(readFileSync(join(REPO_ROOT, "public", "catalog.json"), "utf8"));
  const 期刊行 = R.journalRows(品書.conferences, now) as Array<{
    ed: { id?: string };
    conf: { key?: string };
  }>;
  expect(期刊行.length, "常時受付の行が讀めない（この檢查が空振り）").toBeGreaterThan(0);
  for (const r of 期刊行) {
    expect(String(r.ed?.id ?? "").trim(), "常時受付の行に id が無い").toBe(
      String(r.conf?.key ?? ""),
    );
    expect(String(r.ed?.id ?? ""), "空文字の id").not.toBe("");
  }

  /* **實物** – 推薦の行に「（undefined）」が出ない。 */
  const 答 = await call("recommend_venues", { paper: "ネットワーク", limit: 30 });
  expect(答, "推薦に「（undefined）」が出て居る").not.toContain("（undefined）");
  expect(答, "推薦の行が出て居ん").toMatch(/^1\. /m);
  /* 常時受付の行は「會期 該当なし」（第 852 囘の決まり – 變はらない）。 */
  const 常時 = 答.split("\n").filter((l) => /^\d\. /.test(l) && l.includes("常時受付"));
  for (const l of 常時) expect(l, "常時受付の行に會期が出て居る").toContain("会期 該当なし");
});

it("讀めない字を實答に出さない（第 1060 回）", async () => {
  /* 第 1059 囮で常時受付の行の「（undefined）」を直した。其れが**唯一**では無い事を
   * 確かめる爲に、實答の全部を搜す。AI は實答だけを讀むので、「未定義」「非數」の樣な
   * 字が漏れると、其の儘人間に傳へてしまふ。
   *
   * 實測 2026-11-19: 6 つの道具の代表問を全部搜して、**0 件**。此れを固定化して、
   * 將來どつかの改定で漏らしても氣づけるやうにする（畫面も同じ配慮 – `site/app.ts` の
   * `generatedAtLabel` は「空文字なら默る・`undefined` は其の英字が出る」と對處して居る）。 */
  const 全部: Array<[string, Promise<string>]> = [
    ["search_deadlines", call("search_deadlines", { query: "セキュリティ", limit: 100 })],
    [
      "search_deadlines2",
      call("search_deadlines", {
        query: "ネットワーク",
        scope: "all",
        limit: 100,
        kinds: [],
        include_estimated: true,
      }),
    ],
    ["search_deadlines3", call("search_deadlines", { query: "", kind: "journal", scope: "all" })],
    ["list_upcoming", call("list_upcoming", { days: 400 })],
    ["venue_info", call("venue_info", { key: "icde", scope: "all" })],
    ["venue_info2", call("venue_info", { name: "a", scope: "all" })],
    ["explain_word", call("explain_word", { word: "セキュリティ" })],
    ["recommend_venues", call("recommend_venues", { paper: "分散システム", limit: 30 })],
    ["recommend_venues2", call("recommend_venues", { paper: "ネットワーク", limit: 30 })],
    ["collection_stats", call("collection_stats", {})],
  ];
  for (const [名, 約束] of 全部) {
    const 答 = await 約束;
    for (const 字 of ["undefined", "NaN", "[object Object]", "[object Null]"]) {
      expect(答, `${名} の實答に「${字}」が出て居る`).not.toContain(字);
    }
  }
});

it("説明の欄數と實答の欄數が合ふ（第 1061 回）", async () => {
  /* 實測 2026-11-19: 説明は「`| ` で切り、**確認の札は在る時だけ**なので **5 つか 6 つ**」
   * と書いて居た。**實際は 6 か 7** – 會議名とランクが續いて居る（`|` で分かれて居ない）
   * ので、數へ方が違つて居た。數を間違へると AI が「6 つに割れる筈」と變な分割を試す。
   *
   * 3 箇所（`search_deadlines`・`list_upcoming`・`venue_info`）を「6 つか 7 つ」に直した。
   * `explain_word`・`recommend_venues` は「`search_deadlines` と同じ」と參照する形なので、
   * 其の參照が效いて居る事を實物で確かめる。 */
  const res = (await client.ask({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
    result?: { tools?: Array<{ name?: string; description?: string }> };
  };
  const 文 = (n: string): string =>
    (res.result?.tools ?? []).find((t) => t.name === n)?.description ?? "";
  for (const n of ["search_deadlines", "list_upcoming", "venue_info"]) {
    expect(文(n), `${n} の欄數が 6 つか 7 つに成つて居ん`).toContain("6 つか 7 つ");
  }

  /* **實答** – 全部の行が 6 か 7 に割れる（札が在る時だけ 7）。 */
  const 答 = await call("venue_info", { key: "icde", scope: "all" });
  const 行 = 答.split("\n").filter((l) => /^2\d{3}-/.test(l));
  expect(行.length, "締切の行が出て居ん").toBeGreaterThan(0);
  for (const l of 行) {
    const 欄 = l.split("|").length;
    expect(欄, `欄の數が 6 か 7 でない（${欄}）: ${l.slice(0, 50)}`).toBeGreaterThanOrEqual(6);
    expect(欄, `欄の數が 6 か 7 でない（${欄}）: ${l.slice(0, 50)}`).toBeLessThanOrEqual(7);
  }
  /* **參照が效く** – `explain_word` の行も同じ 6 か 7 に割れる。 */
  const 語 = await call("explain_word", { word: "セキュリティ" });
  const 語の行 = 語.split("\n").filter((l) => /^-\s*2\d{3}-/.test(l));
  for (const l of 語の行) {
    const 欄 = l.replace(/^-\s*/, "").split("|").length;
    expect(欄, `explain_word の欄の數が 6 か 7 でない（${欄}）`).toBeGreaterThanOrEqual(6);
    expect(欄, `explain_word の欄の數が 6 か 7 でない（${欄}）`).toBeLessThanOrEqual(7);
  }
});

it("型の違ふ數の引數は默つて讀み替へない（第 1063 回）", async () => {
  /* 實測 2026-11-19: `limit: "5"` は默つて 5 として使はれて居た – schema は `number` と
   * 書いて居るので、**變へた事を言ふ**べきだつた。`"abc"` は第 878 囮で「使はない」と
   * 名指すのに、`"5"` は默つて居た – **同じ型の穴**。
   *
   * 讀める形（`"5"`・`5`・`true`）は其の儘受ける（布林の引數・第 909 囮と同じ決まり）。 */
  /* 文字列の「5」は讀めるが、**變へた事を言ふ**。 */
  const 文字 = await call("search_deadlines", { query: "セキュリティ", limit: "5" });
  expect(文字, "型を默つて讀み替へた").toContain(
    '／limit は数で指定してください（いま "5" – その字を数として読みました）',
  );
  /* 其の值は其の儘使ふ（5 件の表示に成る – 既定に戾さない）。 */
  expect(文字, "默つて既定に戾した").toContain("36 件");

  /* **整數**は默る（其の儘使ふ）。 */
  const 整數 = await call("search_deadlines", { query: "セキュリティ", limit: 5 });
  expect(整數, "整數に斷りを付けた").not.toContain("その字を数として読みました");

  /* 讀めない形（`"abc"`）は第 878 囮の文（變はない）。 */
  const abc = await call("search_deadlines", { query: "セキュリティ", limit: "abc" });
  expect(abc, "讀めない形の文が消えた").toContain("limit は 1 以上の数で指定してください");
  expect(abc, "讀めない形の文が違ふ").toContain('（いま "abc"）');

  /* **他の數の引數**も同じ（`days`・`within_days`）。 */
  const days = await call("list_upcoming", { days: "30" });
  expect(days, "days の型を默つて讀み替へた").toContain(
    '／days は数で指定してください（いま "30" – その字を数として読みました）',
  );
  const 窓 = await call("search_deadlines", { query: "セキュリティ", within_days: "30" });
  expect(窓, "within_days の型を默つて讀み替へた").toContain(
    '／within_days は数で指定してください（いま "30" – その字を数として読みました）',
  );
});
