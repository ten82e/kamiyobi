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

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { REPO_ROOT } from "./helpers.ts";

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
  /* 同じ検索核・同じ收錄から、此方で數へて突き合はせる（數字を檢査に寫さない）。 */
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
        r.t >= now &&
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
    /* 語は此方で數へてから使ふ（0 件に成る語を選ぶと、檢査が空振りする）。 */
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
  /* 今後が在る会議には付けない（雜音を增やさない）。 */
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
  expect(text, "語が無いと斷つて居る").toContain("語を指定せず、種別だけ");
  expect(text, "件數を返して居ん").toMatch(/種別だけ: [1-9]\d* 件/);
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
  expect(build, "實測の列數が索引に無い").toContain("28 列のうち 24 列が此の規則で辿れる");
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
    Number(/種別だけ: ([\d,]+) 件/.exec(t)?.[1]?.replace(/,/g, "") ?? -1);
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
  const 正 = Recommender.venueRecommendations(
    Recommender.candidateRows(索引 as never),
    Recommender.parsePaperLines(題),
    null,
    now,
    { fieldedLexical: true },
  ).filter((r) => r.fit.score >= 10);
  expect(正.length, "此の檢査の前提（候補が出る題名）が崩れた").toBeGreaterThan(0);
  const text = await call("recommend_venues", { paper: 題, limit: 5 });
  expect(text, "件數が核と違ふ").toContain(`に合う投稿先: ${正.length} 件`);
  expect(text, "先頭の候補が核と違ふ").toContain(String(正[0].row.conf.title));
  /* **語の一致だけ**である事を頭で斷る（人が見る數と AI が言ふ數が違ふのが一番惡い）。 */
  expect(text, "語の一致だけである事を言つて居ん").toContain("語の一致だけ");
  expect(text, "切り詰めを默つて居る").toContain("残り");
  /* 題名が空なら、打ち方を敎へる（默らない）。 */
  const 空 = await call("recommend_venues", { paper: "" });
  expect(空, "空の題名に答へて居ん").toContain("論文の題名");
  expect(空, "入力の形を敎へて居ん").toContain("題名 | キーワード");
});
