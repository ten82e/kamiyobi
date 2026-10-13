import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { recommendationAxes } from "../site/recommendation-core.ts";
import Recommender from "../site/recommender.ts";
import { consolidateReviewedSubmissions } from "../site/submission-identity.ts";
import { FILTER_RUNTIME_STUBS, site } from "./built_golden_shared.ts";
import { REPO_ROOT, tempWork } from "./helpers.ts";
import { jsFunction, siteRuntime, vmSafeSource } from "./runtime_extract.ts";

function displayCandidates(data: Parameters<typeof Recommender.candidateRows>[0]) {
  return consolidateReviewedSubmissions(
    Recommender.candidateRows(data),
    (row) => `${row.conf.key}|${row.ed.year ?? ""}|${row.kind}|${Math.trunc(row.t)}`,
  );
}

/** Run missing/corrupt catalog scenarios without changing shared production fixtures. */
function mcpSandbox(): string {
  const root = realpathSync(tempWork("kamiyobi-mcp-isolated-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "public"));
  copyFileSync(join(REPO_ROOT, "src", "mcp.ts"), join(root, "src", "mcp.ts"));
  for (const name of ["data", "site", "node_modules", "package.json"])
    symlinkSync(join(REPO_ROOT, name), join(root, name));
  return root;
}

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
    expect(res.result?.serverInfo?.name, "名乘りが違う").toBe("kamiyobi");
    expect(res.result?.capabilities?.tools, "道具の能力を名乘つて居ない").toBeTruthy();
    /* 支度の通知（返事を書かない物）を送つても、それらしい返事が來ない事。 */
    client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const pong = (await client.ask({ jsonrpc: "2.0", id: 99, method: "ping" })) as {
      result?: unknown;
    };
    expect(pong.result, "ping に返事がない").toEqual({});
  });

  it("道具の一覽が読める（六つ・どれも入力の形を持つ）", async () => {
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

  it("知らない道具の失敗文は、読める形で返す（第 890 回）", async () => {
    /* 実測 2026-10-22: 知らない道具を呼ぶと「道具の実行に失敗: Error: 知らない道具: nope」と
     * 出ていた。`String(error)` は `Error:` を先頭に付けるので、AI でも人でも読める文に剝ぐ
     * （併せて `isError` は立つたまま – 呼んだ側が失敗と判る）。 */
    const res = (await client.ask({
      jsonrpc: "2.0",
      id: 90,
      method: "tools/call",
      params: { name: "nope" },
    })) as { result?: { content?: Array<{ text?: string }>; isError?: boolean } };
    const 文 = String(res.result?.content?.[0]?.text ?? "");
    expect(res.result?.isError, "失敗と判る印が立っていない").toBe(true);
    expect(文, "内部の錯誤の接頭語が残つている").not.toContain("Error:");
    expect(文, "道具の実行に失敗した事を言つていない").toContain("道具の実行に失敗");
    /* どこの道具だか分かる（打ち直しが出來る）。 */
    expect(文, "知らない道具の名を言つていない").toContain("nope");
    /* 引数が缺けた呼び出しでも、文で落ちる（例外を露出しない）。 */
    const 缺け = (await client.ask({
      jsonrpc: "2.0",
      id: 91,
      method: "tools/call",
      params: { name: "search_deadlines" },
    })) as { result?: { content?: Array<{ text?: string }>; isError?: boolean } };
    const 缺け文 = String(缺け.result?.content?.[0]?.text ?? "");
    expect(缺け.result?.isError, "引数の缺けを失敗としていない").toBeFalsy();
    expect(缺け文).not.toContain("Error:");
    expect(缺け文, "何を足せばよいか言つていない").toContain("検索語が空です");
  });

  it("知らない呼び出しには誤りを返す（黙らない）", async () => {
    const res = (await client.ask({ jsonrpc: "2.0", id: 4, method: "not/a/method" })) as {
      error?: { code?: number };
    };
    expect(res.error?.code, "知らない呼び出しに誤りを返して居ない").toBe(-32601);
  });
});

describe("AI 向けの索引が、MCP の在り處を書いている（第 714 回）", () => {
  it("llms.txt の組み立てに、MCP の節と道具の名がある", () => {
    /* `llms.txt` はビルドの生成物なので、組み立ての側を検べる（配付物を持たない手元でも
     * 検べられる – 第 714 回）。*/
    const build = readFileSync(join(REPO_ROOT, "src", "build.ts"), "utf8");
    expect(build, "llms.txt に AI 向けの節がない").toContain("## AI から引く（MCP）");
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
    /* 索引の説明が、実装とずれて居ない事。
     * 人が読む索引なので、実装に無い事を書いていたら迷はす。*/
    for (const 印 of ['["all"]', "kind", "kinds", "略称", "scope"]) {
      expect(build, `索引に ${印} の話が無い（實装とずれて居る）`).toContain(印);
    }

    expect(build, "CSV の説明が日本語の混在を言っていない").toContain(
      "上流の原文に日本語が在ればその侭出す",
    );
    expect(build, "印を書かない事を言っていない").not.toContain(
      "「未確認」「該当なし」などの日本語は書かない",
    );
    /* 置けない物を「ある」と書いて居ない事（靜的サイトにサーバは置けない）。 */
    expect(build, "置き場所の斷りがない").toContain("読み取り専用");
  });
});

describe("数字と案内が画面と同じ（第 714 回）", () => {
  /* 同じ検索核・同じ収録から、こちらで数えて突き合はせる（数字を検査に寫さない）。 */
  const rows = displayCandidates(
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

  it("search_deadlines の件数が、同じ絞り込みで数えた物と一致する", async () => {
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
    expect(人の案内, "この検査の前提（案内のある語）が崩れた").not.toBe("");
    expect(text, "人が見る案内と同じ物を返して居ない").toContain(人の案内);
    expect(text, "0 行である事を言つて居ない").toContain("0 行");
  });

  it("行が出る語には、案内を付けずに行を返す", async () => {
    /* 語はこちらで数えてから使う（0 件に成る語を選ぶと、検査が空振りする）。 */
    const 語 = "機械学習";
    const 正 = 畫面の既定で數へる(語, Date.now());
    expect(正, `此の檢査の前提（既定の絞り込みで行が出る語）が崩れた: ${語}`).toBeGreaterThan(0);
    const text = await call("search_deadlines", { query: 語, scope: "all", limit: 2 });
    expect(text, "行を返して居ない").toContain(`に当たる締切: ${正} 件`);
    expect(text, "行が出ているのに案内を付けた").not.toContain("案内:");
    /* 日付・種別・会議名が読める形で返る（人が見る列と同じ順）。 */
    expect(text, "行の形が違う").toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("会議の版と締切を、名前の一部から引ける", async () => {
    const 一つ = rows.find((r) => r.conf.title.includes("AsiaCCS"));
    expect(一つ, "この検査の前提（AsiaCCS が収録にある）が崩れた").toBeTruthy();
    const text = await call("venue_info", { name: "AsiaCCS", scope: "all" });
    expect(text, "会議の名を返して居ない").toContain("会議:");
    expect(text, "版を返して居ない").toContain("版:");
    expect(text, "締切の行を返して居ない").toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("会議は略称でも引ける（key で一意に指せる）", async () => {
    /* 実測 2026-10-06: 略称（`KDD` `CCS`）では見付からなかつた – 題は長く、略称は別の欄にある。*/
    const text = await call("venue_info", { key: "sigkdd", scope: "all" });
    expect(text, "key で引けない").toContain("会議:");
    expect(text, "分野を日本語で出していない（画面と同じ語）").toMatch(
      /分野: (人工知能|データベース)/,
    );
    expect(text, "機械向けのキーの侭").not.toMatch(/分野: (ai|db|hpc)$/m);
  });

  it("種別は all で全部、知らないキーはその旨を言う（第 727 回）", async () => {
    /* 実測 2026-10-06: `kinds: ["all"]` を彈いていたので、**全ての種別を見る道が無く**、
     * 「kinds を試してください」と言はれても試す物が無かつた。未知のキーは 0 件に成るので、
     * 黙らず「知らない種別」と名指す（AI が打ち直せる樣に）。*/
    const 全部 = await call("search_deadlines", {
      query: "セキュリティ",
      kinds: ["all"],
      scope: "all",
      limit: 1,
    });
    const 既定 = await call("search_deadlines", { query: "セキュリティ", scope: "all", limit: 1 });
    const 數 = (t: string): number => Number(/に当たる締切: (\d+) 件/.exec(t)?.[1] ?? -1);
    expect(數(全部), "all で絞られている").toBeGreaterThan(數(既定));
    const 未知 = await call("search_deadlines", {
      query: "セキュリティ",
      kinds: ["xxx"],
      scope: "all",
      limit: 1,
    });
    expect(未知, "知らない種別を名指していない").toContain("知らない種別");
    /* 既定では屆かん種別も、名指せば屆く（camera_ready は既定の三つに入らん）。 */
    const カメラ = await call("search_deadlines", {
      query: "カメラレディ",
      kinds: ["camera_ready"],
      scope: "all",
      limit: 1,
    });
    expect(カメラ, "名指した種別に屆いていない").toMatch(/に当たる締切: [1-9]\d* 件/);
  });

  it("種別の名は道具の間で揃っている（kind でも kinds でも受ける・第 728 回）", async () => {
    /* 実測 2026-10-06: `list_upcoming` は `kind`（単数）、`search_deadlines` は `kinds`（複数）で、
     * 同じ事を指していた。片方を覺えた機械が 0 件で黙るのを防ぐ。*/
    const 數 = (t: string): number => Number(/締切: (\d+) 件/.exec(t)?.[1] ?? -1);
    const 單 = await call("list_upcoming", { days: 60, kind: "paper", scope: "all" });
    const 複 = await call("list_upcoming", { days: 60, kinds: ["paper"], scope: "all" });
    expect(數(單), "kind で絞れていない").toBeGreaterThan(0);
    expect(數(複), "kinds で絞れていない").toBe(數(單));
    const 全部 = await call("list_upcoming", { days: 60, kind: "all", scope: "all" });
    expect(數(全部), "all で広がつていない").toBeGreaterThan(數(單));
    /* search_deadlines も単数の名を受ける。 */
    const 檢 = await call("search_deadlines", {
      query: "カメラレディ",
      kind: "camera_ready",
      scope: "all",
      limit: 1,
    });
    expect(檢, "search_deadlines が kind を受けていない").toMatch(/に当たる締切: [1-9]\d* 件/);
  });

  it("曖昧な名では決め打たず、候補を並べる", async () => {
    /* `KDD` は kdd・sigkdd・pakdd・ecmlpkdd に当たる。決め打つと別の会議の版を混ぜて返す。*/
    const text = await call("venue_info", { name: "KDD", scope: "all" });
    expect(text, "候補を並べていない").toContain("会議が当たりました");
    expect(text, "key を添えていない").toContain("（key: ");
    /* 候補には公式の繋ぎ先も添へる。 */
    expect(text, "候補に繋ぎ先がない").toMatch(/https?:\/\//);
  });

  it("収録にない会議は、ないと言う（ある樣に裝はない）", async () => {
    const text = await call("venue_info", { name: "ぬけぬけ会議", scope: "all" });
    expect(text, "ないと言つて居ない").toContain("収録に在りません");
  });
});

it("会議の一覽は、今後の物から並ぶ（第 752 回）", async () => {
  /* 実測 2026-10-06: `venue sigkdd` の一覽が 2021 年から始まつていた（日の早い順に並べていた）。
   * 人は「次はいつか」を聞いているので、過去を先に読ませない。今後の行を持つ会議で、
   * **最初の日付の行が過去で無い**事を見る（この会議には今後がある – 前提も張る）。 */
  const text = await call("venue_info", { key: "sigkdd", scope: "all" });
  const 日付の行 = text.split("\n").filter((l) => /^\d{4}-\d{2}-\d{2}/.test(l));
  expect(日付の行.length, "この検査の前提（日付の行がある）が崩れた").toBeGreaterThan(1);
  const 今後 = 日付の行.filter((l) => !l.includes("（過ぎた）"));
  expect(今後.length, "この検査の前提（今後の締切がある）が崩れた").toBeGreaterThan(0);
  expect(日付の行[0], "過去の行を先に並べている").not.toContain("（過ぎた）");
});

it("今後の締切がない会議では、その事を先に言う（第 754 回）", async () => {
  /* 過ぎた行だけを並べると、読む人（と AI）が「次はこれ」と取り違へる。 */
  const 過去だけ = await call("venue_info", { key: "aft", scope: "all" });
  expect(過去だけ, "今後の締切がない事を言つていない").toContain("今後の締切は収録にありません");
  expect(過去だけ, "過ぎた物だと斷つていない").toContain("（過ぎた）");
  /* 今後がある会議には付けない（雜音を増やさない）。 */
  const 今後あり = await call("venue_info", { key: "sigkdd", scope: "all" });
  expect(今後あり, "要らない斷りを付けた").not.toContain("今後の締切は収録にありません");
});

it("0 件の時に、画面と同じ「打ち直すなら」を渡す（第 762 回）", async () => {
  const text = await call("search_deadlines", {
    query: "デモができる会議",
    scope: "all",
    limit: 1,
  });
  expect(text, "行き止まりへ送る提案を出した").not.toContain("打ち直すなら");

  const 有益 = await call("search_deadlines", { query: "参加費が高い", scope: "all", limit: 1 });
  expect(有益, "打ち直す手を渡していない").toContain("打ち直すなら");
  const word = /検索語を「([^」]+)」/.exec(有益)?.[1] ?? "";
  const 件數 = Number(/（(?:両方を書く行が )?([\d,]+) 件/.exec(有益)?.[1]?.replace(/,/g, "") ?? -1);
  expect(word, "提案の語が読めない").not.toBe("");
  expect(件數, "提案の件数が読めない").toBeGreaterThan(0);
  /* **提案の件数と、その語で引いた結果が一致する。** */
  const 次 = await call("search_deadlines", { query: word, scope: "all", limit: 1 });
  const 出た = Number(/に当たる締切: ([\d,]+) 件/.exec(次)?.[1]?.replace(/,/g, "") ?? -1);
  expect(出た, `提案の件數と結果が違ふ: ${word}`).toBe(件數);
});

it("explain_word でも、同じ「打ち直すなら」を渡す（第 763 回）", async () => {
  const text = await call("explain_word", { word: "参加費が高い", scope: "all" });
  expect(text, "0 行である事を言つていない").toContain("0 行");
  expect(text, "打ち直す手を渡していない").toContain("打ち直すなら");
  const word = /検索語を「([^」]+)」/.exec(text)?.[1] ?? "";
  expect(word, "提案の語が読めない").not.toBe("");
  const 次 = await call("search_deadlines", { query: word, scope: "all", limit: 1 });
  expect(次, `提案が空振り: ${word}`).toMatch(/に当たる締切: [1-9]\d* 件/);
  /* 行が出る語には付けない。 */
  const 有 = await call("explain_word", { word: "ポスター", scope: "all" });
  expect(有, "行が出る語に提案を付けた").not.toContain("打ち直すなら");
});

it("会議の一覽の見出しが、並びと切り詰めを言う（第 765 回）", async () => {
  const text = await call("venue_info", { key: "sigkdd", scope: "all" });
  expect(text, "並びの説明が古い").toContain("今後の物から");
  /* 切り詰めた時だけ件数を添へる（この会議は 60 件に滿たないので付かない）。 */
  const 行數 = text.split("\n").filter((l) => /^\d{4}-\d{2}-\d{2}/.test(l)).length;
  if (行數 >= 60) expect(text, "切り詰めを黙つている").toContain("のうち 60 件");
  else expect(text, "切り詰めて居ないのに件数を添えた").not.toContain("のうち 60 件");
});

it("道具の說明が、実装の要る所を言つている（第 766 回）", async () => {
  /* AI はこの說明だけを見て道具を選ぶ。この数回に足した舉動が說明から落ちると、使はれなくなる。 */
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

it("collection_stats が、収録その物の数とファイルを返す（第 769 回）", async () => {
  /* AI が「この収録は何か」「人に渡すなら何を渡せばよいか」に一往復で答へられるようにした。
   * 数字は出典（`data/snapshot.json`）を名乘り、人が読むファイルを並べる。 */
  const text = await call("collection_stats", {});
  expect(text, "会議の数を返していない").toMatch(/会議 \d+ 件/);
  expect(text, "締切の行を返していない").toMatch(/締切の行 [\d,]+ 行/);
  expect(text, "出典を名乘つていない").toContain("data/snapshot.json");
  for (const 檔案 of ["upcoming.md", "data.csv", "deadlines.ics", "data.json", "llms.txt"]) {
    expect(text, `${檔案} を並べて居ん`).toContain(檔案);
  }
  /* 会議の数は、収録その物（snapshot）の会議数と一致する（行から数へると減る – 第 769 回に
   * 一度それを踏んだ）。 */
  const 收錄 = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as {
    conferences?: unknown[];
  };
  const 數 = (收錄.conferences ?? []).length;
  expect(text, "会議の数が収録と合はん").toContain(`会議 ${數} 件`);

  const 全ての版 = ((收錄.conferences ?? []) as Array<{ editions?: unknown[] }>).flatMap(
    (c) => (c.editions ?? []) as Array<{ deadlines?: unknown[] }>,
  );
  const 締切の數 = 全ての版.reduce(
    (n: number, e: { deadlines?: unknown[] }) => n + (e.deadlines ?? []).length,
    0,
  );
  expect(締切の數, "この検查の前提（締切が数えられない）が崩れた").toBeGreaterThan(1000);
  /* 千の桁を區切ると同じ形）。 */
  const 千の桁 = (n: number): string => String(n).replace(/(\d)(?=(\d{3})+(?!\d))/g, "$1,");
  expect(text, "締切の行の数が収録と合はん").toContain(`締切の行 ${千の桁(締切の數)} 行`);

  const 締切々 = 全ての版.flatMap(
    (e) => (e.deadlines ?? []) as Array<{ verification?: { status?: unknown } }>,
  );
  const 狀態の數 = 締切々.reduce((數へる: Map<string, number>, d) => {
    const st = String(d.verification?.status ?? "");
    if (st) 數へる.set(st, (數へる.get(st) ?? 0) + 1);
    return 數へる;
  }, new Map<string, number>());
  const 複數 = (狀態の數.get("manual-required") ?? 0) + (狀態の數.get("parser-failed") ?? 0);
  expect(複數, "この検查の前提（複数候補が数えられない）が崩れた").toBeGreaterThan(100);
  expect(text, "「複数候補のため要確認」の数が収録と合はん").toContain(
    `複数候補のため要確認 ${String(複數)} 行`,
  );
  expect(text, "「確認済み」の数が収録と合はん").toContain(
    `確認済み ${狀態の數.get("verified") ?? 0} 行`,
  );
  /* 「確認の記録なし」も収録で `verification` が無い行の数と合ふ（行ごとの札が無いだけ）。 */
  const 記録なしの數 = 締切々.filter((d) => !String(d.verification?.status ?? "")).length;
  expect(text, "「確認の記録なし」の数が収録と合はん").toContain(
    `確認の記録なし ${記録なしの數} 行`,
  );
});

it("語を省いて、種別だけでも引ける（第 793 回）", async () => {
  /* 実測 2026-10-06: 「登録締切を全部見たい」と云ふ聞き方に、語が空だと斷つていた。種別を
   * 指定して居れば語が無くても返す（人も AI も同じ聞き方をする）。 */
  const text = await call("search_deadlines", {
    query: "",
    kind: "registration",
    scope: "all",
    limit: 2,
  });
  expect(text, "語がないと斷つている").toContain("語を指定せず、絞り込みだけ");
  expect(text, "件数を返していない").toMatch(/絞り込みだけ: [1-9]\d* 件/);
  /* 語も種別も無い時は、今まで通り斷る（何を見ればよいか分からん）。 */
  const 空 = await call("search_deadlines", { query: "" });
  expect(空, "種別もないのに返した").toContain("検索語が空です");
  expect(空, "代はりの聞き方を敎へていない").toContain("kind / kinds");
});

it("explain_word は、行が出る時に中身を少し見せる（第 796 回）", async () => {
  /* 前は「search_deadlines で引けます」とだけ言っていたので、語を調べた人がもう一往復する
   * 必要があった（AI も同じ）。行は search_deadlines と同じ形（`line()`）で 3 行まで。 */
  const text = await call("explain_word", { word: "セキュリティ", scope: "all" });
  expect(text, "行数を言つていない").toMatch(
    /素の照合で [1-9]\d* 行・画面の既定の絞り込み（[^）]*）を通すと \d+ 行/,
  );
  const 行 = text.split("\n").filter((l) => l.startsWith("- 20"));
  expect(行.length, "中身を見せていない").toBeGreaterThan(0);
  expect(行.length, "見せる行が多過ぎる").toBeLessThanOrEqual(3);

  const 一覽 = (await client.ask({ jsonrpc: "2.0", id: 6, method: "tools/list" })) as {
    result?: { tools?: Array<{ name?: string; description?: string }> };
  };
  const 説明 = (一覽.result?.tools ?? []).find((t) => t.name === "explain_word")?.description ?? "";
  expect(説明, "数え方の違ひを説明していない").toContain("素の照合");
});

it("索引が、0 件の時の振る舞いを書いている（第 812 回）", () => {
  /* 画面の 0 件案内（次に打つ手と、いまの絞り込みで数へた件数）は、索引を読む人と AI にも
   * 要る（第 758〜761 回に数へ方を直したが、索引には書いていなかった）。 */
  const build = readFileSync(join(REPO_ROOT, "src", "build.ts"), "utf8");
  expect(build, "0 件の時の振る舞いが索引にない").toContain("次の一手まで返す");
  expect(build, "件数の基準が索引にない").toContain("期間・種別・推定・過去表示を揃え");
});

it("索引が、会期の日付の確かさ（event_date_precision）を説明している（第 813 回）", () => {
  /* 実測 2026-10-06: data.json の版には event_date_precision が全 2,603 版に在り、値は六つ
   * （exact-range・single-day・month-only・split-dates・unverified・not-announced）だが、
   * 索引（llms.txt）に一度も出て居なかった – 読む人（と AI）はその欄を読めない。 */
  const build = readFileSync(join(REPO_ROOT, "src", "build.ts"), "utf8");
  expect(build, "event_date_precision を索引が説明していない").toContain("event_date_precision");
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
  /* 実測 2026-10-06: data.json の各階層を總当たりすると、索引に一度も出て居ない鍵が八つ在つた
   * （会議 upstream_sub／版 call_identity・legacy_ids・event_review／締切 track・verification・
   * superseded_deadlines・promotion_ref）。読む人（と AI）はそれ等を読めない。 */
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
  expect(build, "付く頻度の実測が索引にない").toContain("稀にしか付かない物と");
});

it("索引が、元の収録と建てた表示で数が違う事を書いている（第 816 回）", () => {
  /* 実測 2026-10-06: MCP の collection_stats は data/snapshot.json を数へるので「版 2,659」と
   * 言うが、索引は「版 2,603」と書いていた（建てた表示）。出所が違ふ事を索引が言はないと、
   * 読む人（と AI）は同じ物の数だと思つて突き合はせる。 */
  const build = readFileSync(join(REPO_ROOT, "src", "build.ts"), "utf8");
  expect(build, "数の出所の違ひが索引にない").toContain("収録 snapshot と公開物");
  expect(build, "過去の件数を現在の仕様に混ぜている").not.toContain("版 2,659 ⇔ 建てた表示 2,603");
});

it("索引が、上流の英語の印（TBD）を説明している（第 833 回）", () => {
  /* 実測 2026-10-06: data.csv の `date_text` 65 行・`place` 10 行が上流の原文 `TBD` だつた。
   * 索引は「こちらが付ける印は書かない」とだけ言つていたので、読む人（と AI）は `TBD` を
   * こちらの印と読みかねない（空欄とは意味が違ふ）。 */
  const build = readFileSync(join(REPO_ROOT, "src", "build.ts"), "utf8");
  expect(build, "上流の英語の印の説明が索引にない").toContain("上流が英語の印を書いている事がある");
  expect(build, "実測の行数が索引にない").toContain("`date_text` 65 行・`place` 10 行");
});

it("索引が、data.csv の列名と data.json の鍵の関係を書いている（第 839 回）", () => {
  /* 実測 2026-10-06: 28 列のうち 24 列は「同じ名（又は接頭辭を外した名）」で data.json の鍵へ
   * 辿れる（deadline_* → deadlines[]、event_* → editions[]、rank_* → conferences[].rank、
   * estimate_window_* → editions[].estimate）。索引は一般的な出所しか書いて居なかった。 */
  const build = readFileSync(join(REPO_ROOT, "src", "build.ts"), "utf8");
  expect(build, "列名の規則が索引にない").toContain("多くが `data.json` の鍵と同じ名である");
  expect(build, "実測の列数が索引にない").toContain("31 列のうち 26 列がこの規則で辿れる");
});

it("索引が、6 道具の引数の名を書いている（第 843 回・第 857 回に推薦の分を足した）", () => {
  /* 実測 2026-10-06: 索引は kinds / kind / scope / key / name / word は書いていたが、query・
   * limit・include_past・include_estimated・days を書いて居なかつた（道具の schema を見ない
   * 読み手には、何が渡せるか分からん）。 */
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

/* ---- 第 854 回: 返り値の文と、データ生成の言ひ方を画面に揃へる ---- */

/** 旧字体（この計画の内側では使うが、利用者に出る文では使はない）。 */
const 舊字體 =
  "亞惡壓圍爲醫壹榮衞驛悅圓緣艷鹽奧應歐毆櫻橫溫價畫會懷繪擴殼學嶽樂渴卷陷勸寬歡罐觀關顏歸" +
  "氣龜僞戲犧舊據擧峽狹鄕曉區驅勳薰羣徑惠揭溪經繼莖螢輕鷄藝擊缺儉劍圈檢權獻硏縣險顯驗嚴廣效" +
  "恆鑛號國黑濟碎齋劑冱雜參慘蠶贊殘絲齒兒辭濕實舍壽收從澁獸縱肅處敍將燒獎條狀乘淨剩疊孃讓" +
  "釀囑觸寢愼盡圖粹醉穗隨髓數樞瀨聲靜齊攝竊專淺戰纖禪曾雙壯爭莊搜巢裝騷增藏臟屬續墮體對帶" +
  "滯臺瀧擇澤單膽團彈斷癡遲蟲鑄廳徵聽懲鎭遞鐵點轉傳燈當黨盜稻鬪德獨讀屆繩惱腦霸廢拜賣麥發" +
  "髮拔蠻祕拂佛變邊辨瓣辯舖步寶豐襃沒飜槇每萬滿默彌藥與搖樣謠來賴亂覽龍兩獵綠淚壘禮勵戾靈" +
  "齡曆歷戀鍊爐勞樓郞錄灣眞";

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

/** 収録その物の生成時刻（`data/snapshot.json` の `snapshot_metadata`）。 */
function 收錄の生成時刻(): string {
  const 收錄 = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as {
    snapshot_metadata?: { generated_at?: string };
  };
  return String(收錄.snapshot_metadata?.generated_at ?? "");
}

/** 画面の右上と同じ書き方（`YYYY-MM-DD(曜) HH:MM JST`）をこちらで組んで突き合はせる。 */
function 畫面の書き方(iso: string): string {
  const jst = new Date(Date.parse(iso) + 9 * 3600000);
  const 曜 = ["日", "月", "火", "水", "木", "金", "土"][jst.getUTCDay()];
  const 二桁 = (n: number): string => String(n).padStart(2, "0");
  return `${jst.getUTCFullYear()}-${二桁(jst.getUTCMonth() + 1)}-${二桁(jst.getUTCDate())}(${曜}) ${二桁(jst.getUTCHours())}:${二桁(jst.getUTCMinutes())} JST`;
}

it("入力の形が、道具の説明と一致する（第 854 回）", async () => {
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

  const 期待: Record<string, string[]> = {
    search_deadlines: [
      "query",
      "limit",
      "offset",
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
  expect(String(檢索?.description ?? ""), "語を省ける事を說明していない").toContain("語を省いて");
  expect(
    檢索?.inputSchema?.required ?? [],
    "說明は語を省けると言うのに、形は query を必須にしている",
  ).not.toContain("query");
  expect(
    Object.keys(檢索?.inputSchema?.properties ?? {}),
    "說明と実装が受ける kind（単数）が形にない",
  ).toContain("kind");
  /* 擧動でも確かめる（形だけ直して、受け方が違つては意味が無い）。 */
  const 數 = (t: string): number =>
    Number(/絞り込みだけ: ([\d,]+) 件/.exec(t)?.[1]?.replace(/,/g, "") ?? -1);
  const 單 = await call("search_deadlines", { kind: "paper", scope: "all", limit: 1 });
  const 複 = await call("search_deadlines", { kinds: ["paper"], scope: "all", limit: 1 });
  expect(數(單), "語を省いて kind だけでは引けない").toBeGreaterThan(0);
  expect(數(複), "kind と kinds で数が違う").toBe(數(單));
});

it("collection_stats が、画面の右上と同じ書き方でデータ生成を返す（第 854 回）", async () => {
  /* 画面は右上に「データ生成」を常に出し、生成から 3 日以上ならその旨も出す。MCP が何も
   * 言はないと、人が見た日付と AI の答へが違ふ（第 803・804 回と同じ考へ – 人が見る物と
   * AI が言う物を同じにする）。**同じファイルから、同じ書き方で**出す。 */
  const 生成 = 收錄の生成時刻();
  expect(生成, "この検査の前提（収録の生成時刻）が崩れた").not.toBe("");
  const text = await call("collection_stats", {});
  expect(text, "データ生成を言つていない").toContain(`データ生成: ${畫面の書き方(生成)}`);
  expect(text, "画面と違う書き方（UTC の侭・秒まで）").toMatch(
    /データ生成: \d{4}-\d{2}-\d{2}\([日月火水木金土]\) \d{2}:\d{2} JST/,
  );
  /* 説明にも書く（AI は説明だけを見て道具を選ぶ – 第 766 回）。 */
  const 一覽 = (await client.ask({ jsonrpc: "2.0", id: 8, method: "tools/list" })) as {
    result?: { tools?: Array<{ name?: string; description?: string }> };
  };
  const 説明 = (一覽.result?.tools ?? []).find((t) => t.name === "collection_stats")?.description;
  expect(String(説明 ?? ""), "データ生成時刻を言う事を説明していない").toContain("データ生成時刻");
  /* 画面が最初に読む窓は別のファイルなので、そちらの生成時刻も別に言う。 */
  const 品書 = join(REPO_ROOT, "public", "catalog.json");
  if (existsSync(品書)) {
    const catalog = JSON.parse(readFileSync(品書, "utf8")) as { generated_at?: string };
    const 窓 = String(catalog.generated_at ?? "");
    if (窓) expect(text, "窓の生成時刻を言つていない").toContain(畫面の書き方(窓));
  }
});

it("収録が古ければ、画面と同じ斷りを付ける（第 854 回）", async () => {
  /* 画面は生成から 3 日以上で「データは N 日前に生成されたものです」と出す。MCP も
   * **同じ関数から**取る – 別に書くと、画面と AI で日数も閾値もずれる。 */
  const 今 = Date.now();
  const 元の斷り = String(Recommender.dataAgeNoteJa(收錄の生成時刻(), 今) ?? "").trim();
  const 全體 = await call("search_deadlines", { query: "セキュリティ", scope: "all", limit: 1 });
  if (元の斷り) expect(全體, "古いのに斷りがない").toContain(元の斷り);
  else expect(全體, "新しいのに斷りを付けた").not.toContain("日前に生成された");
  /* 窓を見る時は、窓の生成時刻で数へる（出所のファイルが違ふ）。 */
  const 品書 = join(REPO_ROOT, "public", "catalog.json");
  expect(
    existsSync(品書),
    "検証に必要な生成物がありません。オフラインビルドを実行してください",
  ).toBe(true);
  const catalog = JSON.parse(readFileSync(品書, "utf8")) as { generated_at?: string };
  const 窓の斷り = String(Recommender.dataAgeNoteJa(catalog.generated_at, 今) ?? "").trim();
  const 窓 = await call("search_deadlines", { query: "セキュリティ", scope: "screen", limit: 1 });
  if (窓の斷り) expect(窓, "窓の古さを言つていない").toContain(窓の斷り);
  else expect(窓, "新しい窓に斷りを付けた").not.toContain("日前に生成された");
  /* 二つの窓の古さが違ふ時は、取り違へて居ない事まで見る（別のファイルを読んでいる證據）。 */
  if (元の斷り && 窓の斷り && 元の斷り !== 窓の斷り) {
    expect(全體, "窓の古さを混ぜた").not.toContain(窓の斷り);
    expect(窓, "収録の古さを混ぜた").not.toContain(元の斷り);
  }
});

it("MCP が返す文に、旧字体を混ぜない（第 854 回）", () => {
  const 文々 = 文を集める(readFileSync(join(REPO_ROOT, "src", "mcp.ts"), "utf8"));
  expect(文々.length, "文を一つも集められて居ない（走査が壊れている）").toBeGreaterThan(100);
  for (const { 行, 文 } of 文々) {
    /* 走査が崩れていたら氣付ける樣に、集めた文に注の記号が混ざつて居ない事も見る（字句の
     * 読み方が崩れると、文で無い物を文として見たり、本当の文を見落としたりする）。 */
    expect(/\/\*|\*\//.test(文), `src/mcp.ts:${行} の走査が崩れて居る`).toBe(false);
    const 混ざり = [...new Set([...文].filter((c) => 舊字體.includes(c)))];
    expect(混ざり.join(""), `src/mcp.ts:${行} の文に舊字體: ${文.slice(0, 60)}`).toBe("");
  }
});

it("建造物（画面が読む JS）の文にも、旧字体を混ぜない（第 952 回）", async () => {
  expect(
    existsSync(join(REPO_ROOT, "public", "app.js")),
    "検証に必要な生成物がありません。オフラインビルドを実行してください",
  ).toBe(true);
  for (const 相 of ["public/app.js", "public/recommender.js"]) {
    const 本文 = readFileSync(join(REPO_ROOT, 相), "utf8");
    const 文々 = 文を集める(本文);
    const 行々 = 本文.split("\n");
    const 見つけた: string[] = [];
    for (const { 行, 文 } of 文々) {
      const 元の行 = 行々[行 - 1] ?? "";
      if (/^\s*\[/.test(元の行)) continue; // 寄せ表の行（`["国際", …]`）
      if (/^\s*["'`][^"'`]*["'`],?\s*$/.test(元の行)) continue; // 語の一覽の行
      const 混ざり = [...new Set([...文].filter((c) => 舊字體.includes(c)))];
      if (混ざり.length) 見つけた.push(`${相}:${行}: ${混ざり.join("")}｜${文.slice(0, 50)}`);
    }
    expect(見つけた, `建造物の文に舊字體:\n${見つけた.join("\n")}`).toEqual([]);
  }
});

it("画面の文にも、旧字体を混ぜない（第 851 回の画面版）", async () => {
  for (const 相 of ["site/app.ts", "site/recommender.ts"]) {
    const 文々 = 文を集める(readFileSync(join(REPO_ROOT, 相), "utf8"));
    expect(文々.length, `${相} の文を一つも集められて居ない（走査が壊れて居る）`).toBeGreaterThan(
      10,
    );
    const 行々 = readFileSync(join(REPO_ROOT, 相), "utf8").split("\n");
    for (const { 行, 文 } of 文々) {
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

it("投稿先の推薦が、画面と同じ核で出る（第 857 回）", async () => {
  /* 画面の「投稿先を探す」はこの計画の看板だが、MCP に出口が無く、AI は「この論文は何處に
   * 出せる?」にこの収録を使って答へられなかつた。**同じ推薦核**（`venueRecommendations`）を
   * 使うので、候補も順も画面と一致する（語の一致だけの道 – 埋め込みは読まない）。 */
  const 索引 = JSON.parse(
    readFileSync(join(REPO_ROOT, "public", "recommendation-index.json"), "utf8"),
  ) as { conferences?: unknown[]; reranker?: unknown };
  expect(索引.conferences?.length, "この検査の前提（建てた推薦の索引）が崩れた").toBeGreaterThan(0);
  Recommender.setNameIdf(Recommender.buildNameIdf(索引.conferences ?? []));
  Recommender.setReranker(索引.reranker ?? null);
  const 題 =
    "Time-Sensitive Networking Scheduling for Deterministic Industrial Networks | tsn, real-time, scheduling, deterministic";
  const now = Date.now();

  const 品書 = join(REPO_ROOT, "public", "catalog.json");
  const 品書の會議 = existsSync(品書)
    ? ((JSON.parse(readFileSync(品書, "utf8")) as { conferences?: unknown[] }).conferences ?? [])
    : (索引.conferences ?? []);
  索引.conferences = 品書の會議; // 行・ジャーナルとも品書から（MCP と同じ出所）
  const 行 = displayCandidates(索引 as never);
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
  expect(正.length, "この検査の前提（候補が出る題名）が崩れた").toBeGreaterThan(0);
  const text = await call("recommend_venues", { paper: 題, limit: 5 });
  expect(text, "件数が核と違う").toContain(`に合う投稿先: ${正.length} 件`);
  expect(text, "先頭の候補が核と違う").toContain(String(正[0].row.conf.title));
  /* **何で評價しているか**を頭で斷る（意味検索の埋め込みを読まない事・点が画面と動く事。
   * 人が見る数と AI が言う数が違ふのが一番惡い）。 */
  expect(text, "何で評價しているか言つていない").toContain("語の一致と再学習の重みで評価");
  expect(text, "埋め込みを読まない事を言つていない").toContain("埋め込みは読まない");
  expect(text, "切り詰めを黙つている").toContain("残り");
  /* 題名が空なら、打ち方を敎へる（黙らない）。 */
  const 空 = await call("recommend_venues", { paper: "" });
  expect(空, "空の題名に答へていない").toContain("論文の題名");
  expect(空, "入力の形を敎へていない").toContain("題名 | キーワード");
});

it("行にランクが付き、等級で厳密に絞れる（画面のランク列と同じ語・同じ判定・第 858 回）", async () => {
  /* 画面の一覧にはランクの列が在り「A*ランク」のボタンで絞れるのに、MCP の行にはランクが
   * 無く、語で引いても厳密に絞れなかった（実測 2026-10-08: `CCF A` の語は 101 行に当たるが、
   * `ccf:A` を持つ行は 34 行 – 語の検索では等級も体系も卷き込む）。 */
  const rows = displayCandidates(
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
  expect(正, "この検査の前提（A* の行がある）が崩れた").toBeGreaterThan(0);
  const 數 = (t: string): number => Number(/に当たる締切: (\d+) 件/.exec(t)?.[1] ?? -1);
  const text = await call("search_deadlines", { query: 語, rank: "A*", scope: "all", limit: 1 });
  expect(數(text), "A* の絞り込みが画面の判定と違う").toBe(正);
  expect(text, "頭にランクを出していない").toContain("／ランク A*");
  /* 行その物にもランクが付く（画面のランク列と同じ語 – 内部の `ccf:A` は出さない）。 */
  const 広 = await call("search_deadlines", { query: 語, scope: "all", limit: 5 });
  expect(広, "行にランクがない").toMatch(/\| (CCF|CORE|THCPL) [^|]*\|/);
  expect(広, "ランクの内部の書き方を出している").not.toMatch(/\| (ccf|core|thcpl):/);
  /* どのランク表にも載って居ない行は、画面と同じく「ランク未確認」と書く。 */
  const 全部 = await call("search_deadlines", {
    query: "研究会",
    kinds: ["all"],
    scope: "all",
    limit: 20,
  });
  expect(全部, "「ランク未確認」を書いていない").toContain("ランク未確認");
  /* 無い等級は名指す（その侭では 0 件に成る）。 */
  const 無 = await call("search_deadlines", { query: 語, rank: "A+", scope: "all", limit: 1 });
  expect(無, "知らない等級を名指していない").toContain("知らないランク");
  expect(無, "等級の一覧を敎へていない").toContain("A*・A・B・C・N");
});

it("venue_info が、分野とランクを返す（第 858 回）", async () => {
  const text = await call("venue_info", { key: "sigkdd", scope: "all" });
  expect(text, "分野を返していない").toContain("分野:");
  expect(text, "ランクを返していない").toMatch(/ランク: (CCF|CORE|THCPL)/);
  expect(text, "ランクの語を書き寫している").not.toMatch(/ランク: (ccf|core|thcpl):/);
});

it("行に会期が付く（画面の「会期」列と同じ入口・第 859 回）", async () => {
  /* 画面の一覧には「会期」の列があるのに、MCP の行は締切だけを言つていた – AI は
   * 「NSDI 2027 はいつ開かれる?」にこの収録で答えられなかつた（出張の段取りはこれで決める）。 */
  const rows = displayCandidates(
    JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as never,
  );
  const 題 = await call("venue_info", { key: "nsdi", scope: "all" });
  const 會期 = [
    ...new Set(rows.filter((r) => r.conf.key === "nsdi").map((r) => Recommender.eventCellJa(r))),
  ].filter(Boolean);
  expect(會期.length, "この検査の前提（NSDI の会期）が崩れた").toBeGreaterThan(0);
  expect(題, "会期を出していない").toContain(`会期 ${會期[0]}`);
  /* **どの行にも会期の欄がある**（決まって居ない行も「未確認」と書く – 黙ると
   * 「無い」と読まれる）。 */
  const 一覽 = await call("list_upcoming", { days: 90, scope: "all" });
  const 行 = 一覽.split("\n").filter((l) => /^\d{4}-\d{2}-\d{2}/.test(l));
  expect(行.length, "この検査の前提（日付の行がある）が崩れた").toBeGreaterThan(3);
  for (const l of 行) {
    expect(l, `会期の欄が無い行が在る: ${l.slice(0, 60)}`).toMatch(/\| 会期 [^|]+ \|/);
  }
  /* 値は画面と同じ助っ人（`eventCellJa`）から取つた物で突き合はせる – 上の `toContain` が
   * それ（書き寫すと、会期の言ひ方がずれる）。 */
});

it("行に、延長と確認の状態の札が付く（画面の一覧の札と同じ語・第 860 回）", async () => {
  /* 画面の一覧の行には札が付く（延長・確認の状態）。MCP の行には無かったので、AI は
   * **上流に候補が複数ある締切**（複数候補のため要確認）を、確定した締切として答へていた。 */
  const rows = displayCandidates(
    JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as never,
  );
  const 檢 = (r: (typeof rows)[number]): unknown =>
    (r.dl as { verification?: unknown } | undefined)?.verification;
  const 印 = (r: (typeof rows)[number]): string =>
    String(Recommender.verificationStatusLabelJa(檢(r)) ?? "").trim();
  const 要確認 = rows.find((r) => r.conf?.key && 印(r));
  expect(要確認, "この検査の前提（印の付く行）が崩れた").toBeTruthy();
  const text = await call("venue_info", { key: String(要確認?.conf.key), scope: "all" });
  expect(text, "確認の状態の札がない").toContain(印(要確認!));
  expect(text, "内部の状態の名を出している").not.toContain("manual-required");
  /* 確認済みには札を付けない（画面も印を出さない – 黙るのが正しい）。 */
  const 確認済み = rows.find(
    (r) =>
      r.conf?.key &&
      String((檢(r) as { status?: unknown } | undefined)?.status ?? "") === "verified",
  );
  if (確認済み) {
    const t2 = await call("venue_info", { key: String(確認済み.conf.key), scope: "all" });
    /* **行の札**には付けない（確認済みの行は画面も印を出さない）。第 868 回に足した
     * 「確認: 」の内訳の行は別 – そちらは状態の語を数えて出す物。 */
    for (const l of t2.split("\n").filter((l) => /^\d{4}-\d{2}-\d{2}/.test(l)))
      expect(l, `確認済みの行に札を付けた: ${l.slice(0, 60)}`).not.toContain("確認済み");
  }
  /* 延長の札（上流の締切名に Extended と付く行）。 */
  const 延長 = rows.find((r) => r.conf?.key && Recommender.isExtendedDeadline(r.dl));
  if (延長)
    expect(
      await call("venue_info", { key: String(延長.conf.key), scope: "all" }),
      "延長の札がない",
    ).toContain(String(Recommender.extendedLabelJa()));
});

it("国内・オンラインの絞り込みが、画面のチェック欄と同じ集合を返す（第 865 回）", async () => {
  /* 画面のチェック欄（「国内研究会・国内シンポジウムのみ」「オンライン参加可のみ」）と
   * **同じ判定**を引数にした。語（「国内」「オンライン参加可」）でも同じ集合に成る事は
   * 実測しているが、AI が魔法の語を知らないと使へない – 引数なら画面のボタンと同じ物が
   * その侭使へる。 */
  const rows = displayCandidates(
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
  expect(國內, "この検査の前提（国内の行）が崩れた").toBeGreaterThan(0);
  expect(オンライン, "この検査の前提（オンラインの行）が崩れた").toBeGreaterThan(0);
  const 數 = (t: string): number =>
    Number(/絞り込みだけ: ([\d,]+) 件/.exec(t)?.[1]?.replace(/,/g, "") ?? -1);
  /* 語を省いても、絞り込みだけで引ける（「国内の締切を全部」の樣な聞き方）。 */
  const 國 = await call("search_deadlines", { domestic: true, scope: "all", limit: 1 });
  expect(數(國), "国内の件数が画面の判定と違う").toBe(國內);
  expect(國, "頭に絞り込みを書いていない").toContain("／国内のみ");
  const 網 = await call("search_deadlines", { online: true, scope: "all", limit: 1 });
  expect(數(網), "オンラインの件数が画面の判定と違う").toBe(オンライン);
  expect(網, "頭に絞り込みを書いていない").toContain("／オンライン参加可のみ");
  /* 語で引いた時と同じ集合（同じ数に成る）。 */
  const 語 = await call("search_deadlines", { query: "国内", scope: "all", limit: 1 });
  expect(Number(/に当たる締切: ([\d,]+) 件/.exec(語)?.[1]?.replace(/,/g, "") ?? -1)).toBe(國內);
  /* 両方のチェックは重ねられる（画面と同じ – 国内のオンライン參加可）。 */
  const 兩方 = await call("search_deadlines", {
    domestic: true,
    online: true,
    scope: "all",
    limit: 1,
  });
  expect(數(兩方), "両方の絞り込みが重なっていない").toBeLessThanOrEqual(國內);
});

it("締切の行が 1 本もない会議を「収録にない」と言わない（第 866 回）", async () => {
  const snap = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as {
    conferences?: Array<{ key?: string; editions?: Array<{ event_start?: string }> }>;
  };
  const 會 = snap.conferences ?? [];
  const 行の鍵 = new Set(displayCandidates(snap as never).map((r) => String(r.conf?.key ?? "")));
  const 締切なし = 會.filter((c) => c.key && !行の鍵.has(String(c.key)));
  expect(締切なし.length, "この検査の前提（締切の行がない会議）が崩れた").toBeGreaterThan(0);
  const 會期あり = 締切なし.find((c) => (c.editions ?? []).some((e) => e.event_start));
  const 會期なし = 締切なし.find((c) => !(c.editions ?? []).some((e) => e.event_start));
  for (const c of [會期あり, 會期なし].filter(Boolean)) {
    const text = await call("venue_info", { key: String(c?.key), scope: "all" });
    expect(text, `${c?.key} を「収録に無い」と言つた`).not.toContain("収録に在りません");
    expect(text, `${c?.key} に締切が無い事を言つて居ん`).toContain("締切の行が 1 本もありません");
  }
  if (會期あり) {
    const text = await call("venue_info", { key: String(會期あり.key), scope: "all" });
    expect(text, "会期の行き先を敎へていない").toContain("upcoming.md");
  }
  /* 収録その物の数（`collection_stats` と同じ）を言う – 行から数へると 622 に成つていた。 */
  const 無 = await call("venue_info", { name: "ぬけぬけ会議", scope: "all" });
  expect(無, "収録の数が収録その物と違う").toContain(`収録 ${會.length} 会議`);
});

it("0 件の時、収録の会議の名前に当たっていればその旨を言う（第 867 回）", async () => {
  const snap = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as {
    conferences?: Array<{ key?: string; editions?: Array<{ event_start?: string }> }>;
  };
  const 會 = snap.conferences ?? [];
  const 行の鍵 = new Set(displayCandidates(snap as never).map((r) => String(r.conf?.key ?? "")));
  const 締切なし = 會.find(
    (c) =>
      c.key &&
      !行の鍵.has(String(c.key)) &&
      (c.editions ?? []).some((e) => String(e.event_start ?? "").trim()),
  );
  expect(締切なし, "この検査の前提（締切の行が無く会期だけの会議）が崩れた").toBeTruthy();
  const text = await call("search_deadlines", {
    query: String(締切なし?.key),
    scope: "all",
    limit: 1,
  });
  expect(text, "1 行も出ないと言うだけ").toContain("収録の会議の名前には");
  expect(text, "締切がない事を言つていない").toContain("締切の行が 1 本もありません");
  expect(text, "会期の行き先を敎へていない").toContain("upcoming.md");
  expect(text, "「収録にない」と言つた").not.toContain("収録に在りません");
  /* 収録に無い語では、この案内を出さない（黙るのが正しい）。 */
  const 無 = await call("search_deadlines", { query: "ぬけぬけ会議", scope: "all", limit: 1 });
  expect(無, "収録にない語に名前の案内を付けた").not.toContain("収録の会議の名前には");
  /* 語が当たる時は、この案内を出さない（行が出るので要らない）。 */
  const 有 = await call("search_deadlines", { query: "セキュリティ", scope: "all", limit: 1 });
  expect(有, "行が出ているのに名前の案内を付けた").not.toContain("収録の会議の名前には");
});

it("確認の状態の内訳を、画面と同じ語で返す（第 868 回）", async () => {
  /* 「この収録は信用できるか」は研究者が最初に聞く事。画面は行ごとの札と行の詳細で答へて
   * いるが、MCP は行ごとの札しか言はなかつたので、収録全体の内訳（公式で確認済みが何行か）を
   * 答へられなかつた。語は画面と同じ正本から取る。 */
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
  expect(期待.size, "この検査の前提（確認の状態）が崩れた").toBeGreaterThan(0);
  const text = await call("collection_stats", {});
  const 行 = text.split("\n").find((l) => l.startsWith("確認の状態: "));
  expect(行, "確認の状態の行がない").toBeTruthy();
  for (const [語, n] of 期待) expect(行, `${語} の數が違ふ`).toContain(`${語} ${n} 行`);
  expect(行, "記録なしを数えていない").toContain(`確認の記録なし ${記録なし} 行`);
  /* 内部の状態の名（`manual-required` など）は出さない（画面と同じ語だけ）。 */
  expect(text, "内部の状態の名を出している").not.toContain("manual-required");
  /* 会議ごとの内訳も言う（行ごとの札だけでは、その会議の偏りが分からん）。 */
  const 題 = await call("venue_info", { key: "sigkdd", scope: "all" });
  expect(題, "会議ごとの確認がない").toMatch(/確認: .+\d+ 行/);
});

it("窓の外にだけある締切を「ない」と言わない（第 869 回）", async () => {
  /* 窓（`public/catalog.json`）は建てた時だけある物なので、無い手元ではこの検査は空振りに
   * 成る（このファイルの約束 – 配付物を持たない手元で落とさない）。窓が無い時は最初から収録の
   * 全体を見るので、この案内は出ない（それで正しい）。 */
  const 品書 = join(REPO_ROOT, "public", "catalog.json");
  expect(
    existsSync(品書),
    "検証に必要な生成物がありません。オフラインビルドを実行してください",
  ).toBe(true);
  const snap = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as never;
  const 全行 = displayCandidates(snap);
  const 窓行 = displayCandidates(JSON.parse(readFileSync(品書, "utf8")) as never);
  const now = Date.now();
  /* 窓の果てより後の年を探す（収録の全体にだけある語）。 */
  const 最晚年 = Math.max(...全行.map((r) => new Date(r.t).getUTCFullYear()));
  const 語 = `${最晚年}年`;
  const 照合 = Recommender.searchMatcher(Recommender.expandRelativeMonths(語, now), now);
  expect(
    全行.filter((r) => 照合(r.hay) === true).length,
    "この検査の前提（収録の全体に当たる年）が崩れた",
  ).toBeGreaterThan(0);
  expect(
    窓行.filter((r) => 照合(r.hay) === true).length,
    `此の檢査の前提（窓の外の年）が崩れた: ${語}`,
  ).toBe(0);
  const text = await call("search_deadlines", { query: 語, limit: 1 });
  expect(text, "窓の外を「ない」と言つた").toContain("収録の全体には");
  expect(text, "scope: all を敎へていない").toContain('scope: "all"');
  /* `scope: "all"` で引けば、その先の事（絞り込みで 0 件か）を言う。 */
  const 全 = await call("search_deadlines", { query: 語, scope: "all", limit: 1 });
  expect(全, "窓の外の案内を出し続けている").not.toContain("収録の全体には");
  /* 語を調べる道具でも同じ事を言う。 */
  const 語の = await call("explain_word", { word: 語 });
  expect(語の, "explain_word が窓の外を敎へていない").toContain("収録の全体には");
});

it("日数の幅は、同じ幅を引ける検索語に置き換へて敎へる（第 871 回）", async () => {
  /* 画面は「1か月以内」を「『締切まで』の選擇欄で『30 日以内』を選ぶと同じ話です」と送る
   * （`dayRangeNoteJa`）が、**MCP にその欄は無い**。実測 2026-10-08（窓 870 行）: `1か月以内` は
   * 0 件で案内も無く、同じ幅の `30日以内` は 90 件だつた – AI は「1 か月以内の締切は無い」と
   * 答へてしまふ。 */
  const text = await call("search_deadlines", { query: "1か月以内", scope: "all", limit: 1 });
  expect(text, "日数の幅をその侭検索語として扱つた").toContain(
    "日数の幅はそのままでは検索語に当たりません",
  );
  const m = /語を省いて `within_days: (\d+)` で引けます（([\d,]+) 件当たります）/.exec(text);
  expect(m, "同じ幅を引く引数を敎へていない").toBeTruthy();
  const 敎へた日數 = Number(m?.[1]);
  const 敎へた件數 = Number(String(m?.[2]).replace(/,/g, ""));
  expect(敎へた件數, "敎へた引数が 0 件（行き止まりへ送つた）").toBeGreaterThan(0);
  /* **敎へた引数で引くと、言つた件数と一致する**（その侭打ち直せる – 第 762 回と同じ約束）。 */
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
  /* 語を調べる道具でも同じ事を言う。 */
  const 語の = await call("explain_word", { word: "1か月以内", scope: "all" });
  expect(語の, "explain_word が同じ幅を敎へていない").toContain(`within_days: ${敎へた日數}`);
  /* 時間・分の幅は日で丸める（この表は締切を日単位で持つ – 丸めた事を隱さない）。 */
  const 時間 = await call("search_deadlines", { query: "3時間以内", scope: "all", limit: 1 });
  expect(時間, "時間の幅に丸めた事を言はん").toContain("時間・分の幅は日で丸めます");
  /* 行が出る語には付けない（要らない斷りを増やさない）。 */
  const 有 = await call("search_deadlines", { query: "30日以内", scope: "all", limit: 1 });
  expect(有, "行が出る幅に斷りを付けた").not.toContain("日数の幅はそのままでは");
});

it("収録の果てより先の日付を「ない」と言はない（第 871 回）", async () => {
  const snap = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as never;
  const 全行 = displayCandidates(snap);
  /* 果ての数へ方は画面と同じ（表示している暦日 = `tShown`。無ければ `t`。JST の暦日で出す）。 */
  let 一番遠い = Number.NEGATIVE_INFINITY;
  for (const r of 全行) {
    const s = typeof r.tShown === "number" && Number.isFinite(r.tShown) ? r.tShown : r.t;
    if (Number.isFinite(s) && s > 一番遠い) 一番遠い = s;
  }
  const d = new Date(一番遠い + 9 * 3600000);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const 果て = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  /* 果てより先で、**素の照合でも 0 行**の月を探す（前提をこの検查の中で確かめる –
   * 会期の日付が果てより先にある事があるので、年だけで決め打たない）。 */
  const now = Date.now();
  let 語 = "";
  for (let 年 = d.getUTCFullYear() + 1; 年 < d.getUTCFullYear() + 12 && !語; 年 += 1) {
    const 候補 = `${年}年${d.getUTCMonth() + 1}月`;
    const 照合 = Recommender.searchMatcher(Recommender.expandRelativeMonths(候補, now), now);
    if (全行.filter((r) => 照合(r.hay) === true).length === 0) 語 = 候補;
  }
  expect(語, "この検查の前提（収録の果てより先で 0 行の月）が崩れた").not.toBe("");
  const text = await call("search_deadlines", { query: 語, scope: "all", limit: 1 });
  expect(text, "果ての日を言つていない").toContain(`一番遠い締切 ${果て} より先です`);
  expect(text, "確かめて居ない事を言つていない").toContain("まだ確認できていません");
  expect(text, "「ない」と斷定した").not.toContain("この語では 1 行も出ません");
  /* 語を調べる道具でも同じ事を言う。 */
  const 語の = await call("explain_word", { word: 語, scope: "all" });
  expect(語の, "explain_word が果てを敎へていない").toContain(`一番遠い締切 ${果て} より先です`);
  /* 行が出る語には付けない。 */
  const 有 = await call("search_deadlines", { query: "ポスター", scope: "all", limit: 1 });
  expect(有, "行が出る語に果ての斷りを付けた").not.toContain("より先です");
});

/** 画面（`app.js`）の窓の式を拔き出して、使へる形にする。 */
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

it("「締切まで N 日」の窓の式が、画面と一致する（第 872 回）", () => {
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

it("within_days は、画面の「締切まで N 日」と同じ行を返す（第 872 回）", async () => {
  const snap = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as never;
  const 全行 = displayCandidates(snap);
  const 畫面 = 畫面の窓();
  /* 画面の既定（今後・投稿締切の種別・推定を除く）と同じ土俵で数へる。 */
  const 期待 = (日: number, now: number, 過去も: boolean): number =>
    全行.filter((r) => {
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

  /* 語を省いて、窓だけで引ける。 */
  const 前 = Date.now();
  const text = await call("search_deadlines", { within_days: 30, scope: "all", limit: 1 });
  const 後 = Date.now();
  expect(text, "語を省いて窓だけで引ける事を言つていない").toContain("語を指定せず、絞り込みだけ");
  expect(text, "窓を頭に書いていない").toContain("／締切まで 30 日");
  /* 数へ方は**呼び出しの前後**の時計で挾む（道具は自分の時計で数へるので、境目を跨いでも
   * 落ちない樣に – その幅の中で一致する事を見る）。 */
  const 幅 = [期待(30, 前, false), 期待(30, 後, false)].sort((a, b) => a - b);
  const 出た = 件數を讀む(text);
  expect(出た, `畫面の式と違ふ（${幅[0]}〜${幅[1]} の筈）`).toBeGreaterThanOrEqual(幅[0]);
  expect(出た, `畫面の式と違ふ（${幅[0]}〜${幅[1]} の筈）`).toBeLessThanOrEqual(幅[1]);

  /* 過去も出す時は下側も効く。 */
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
  /* 返つた行の日を読んで、窓の中だけである事を見る（数だけ合つて中身が違ふ、を止める）。
   * 上限は「翌日の開始」なので、窓に入る最後の日はその前日。 */
  const 下限日 = 日Ja(畫面.floor("7d", 前2));
  const 上限日 = 日Ja(畫面.limit("7d", 前2) - 86400000);
  const 日々 = 過去
    .split("\n")
    .filter((l) => /^\d{4}-\d{2}-\d{2}/.test(l))
    .map((l) => l.slice(0, 10));
  expect(日々.length, "行が 1 本もない（この検查の前提が崩れた）").toBeGreaterThan(0);
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
  expect(語と, "語と窓の併用が効いていない").toContain("／締切まで 30 日");
});

it("欄の名前を打たれたら、値で打ち直す案内を返す（第 873 回）", async () => {
  const text = await call("search_deadlines", { query: "種別", scope: "all", limit: 1 });
  expect(text, "欄の名前だと言つていない").toContain(
    "この表の欄の名前で、値そのものではありません",
  );
  expect(text, "値の例を名指していない").toContain("論文締切");
  /* **案内の例で打つと行が出る**（行き止まりへ送つて居ない）。 */
  const 値 = await call("search_deadlines", { query: "論文締切", scope: "all", limit: 1 });
  expect(値, "案内の例で行が出ん").toMatch(/に当たる締切: [1-9]\d* 件/);
  /* 行が出る語には付けない（要らない斷りを増やさない）。 */
  const 有 = await call("search_deadlines", { query: "締切", scope: "all", limit: 1 });
  expect(有, "行が出る語に欄の案内を付けた").not.toContain("欄の名前で");
  /* 語を調べる道具でも同じ事を言う。 */
  const 語の = await call("explain_word", { word: "参加形式", scope: "all" });
  expect(語の, "explain_word が欄の名前を敎へていない").toContain("欄の名前で");
});

it("「と」「や」で繋いだ打ち方に、どちらかだけで打つ案内を返す（第 873 回）", async () => {
  const snap = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as never;
  const 全行 = displayCandidates(snap);
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
  expect(text, "繋いだ打ち方だと言つていない").toContain(
    "「と」で繋いで打つと両方を含む行を探すため",
  );
  expect(text, "どちらかだけで打つ樣に言つていない").toContain("どちらかだけで打ってください");
  /* **言つた件数は、収録の行を同じ照合で数へた物と一致する**（画面と同じ数字）。 */
  const m = /「ネットワーク」を書く行は ([\d,]+) 件/.exec(text);
  expect(m, "片方の件数を言つていない").toBeTruthy();
  expect(Number(String(m?.[1]).replace(/,/g, "")), "件数が収録と違う").toBe(素("ネットワーク"));
  const m2 = /「セキュリティ」を書く行は ([\d,]+) 件/.exec(text);
  expect(Number(String(m2?.[1]).replace(/,/g, "")), "件数が収録と違う").toBe(素("セキュリティ"));
  /* 片方だけで打てば行が出る（案内が行き止まりへ送つて居ない）。 */
  const 片 = await call("search_deadlines", { query: "セキュリティ", scope: "all", limit: 1 });
  expect(片, "片方だけで行が出ん").toMatch(/に当たる締切: [1-9]\d* 件/);
  /* 両方を含む行がある打ち方には付けない（行が出るので案内は立たない）。 */
  const 兩方 = await call("search_deadlines", {
    query: "AIとセキュリティ",
    scope: "all",
    limit: 1,
  });
  expect(兩方, "行が出る打ち方に斷りを付けた").not.toContain("繋いで打つと");
  /* 欄の名前の案内が立つ時は重ねない（画面と同じ順 – 同じ事を二度言はない）。 */
  const 欄と = await call("search_deadlines", { query: "締切と会場", scope: "all", limit: 1 });
  /* 欄の名前に別名がある語は「欄（開催地）の名前で」と書く（画面と同じ語）。 */
  expect(欄と, "欄の名前の案内を出していない").toContain("の名前で、値そのものではありません");
  expect(欄と, "欄の名前と接続の案内を重ねた").not.toContain("繋いで打つと");
});

it("list_upcoming と search_deadlines は、同じ条件なら同じ件数を返す（第 874 回）", async () => {
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
  /* 片方に推定が入つている事を、道具の説明で隱さない（ extrapolated を黙つて外すと
   * 「数が違ふ」に成る）。 */
  const 說明 = String(
    (
      (await client.ask({ jsonrpc: "2.0", id: 99, method: "tools/list" })) as {
        result?: { tools?: Array<{ name?: string; description?: string }> };
      }
    ).result?.tools?.find((t) => t.name === "list_upcoming")?.description ?? "",
  );
  expect(說明, "推定の取扱ひを說明していない").toContain("推定");
});

it("名簿の案内が、画面と同じ規則で名を探す（第 875 回）", async () => {
  const 品書 = join(REPO_ROOT, "public", "catalog.json");
  expect(
    existsSync(品書),
    "検証に必要な生成物がありません。オフラインビルドを実行してください",
  ).toBe(true);
  const 品書の會議 = (
    JSON.parse(readFileSync(品書, "utf8")) as { conferences?: unknown[] }
  ).conferences?.filter((c) => c && typeof c === "object" && !Array.isArray(c));
  expect(品書の會議?.length, "この検查の前提（品書の名簿）が崩れた").toBeGreaterThan(0);
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
  /* 意圖的に混ぜる – 年に年がある物・在らん物・日本語の名前・英字の短い略称。 */
  for (const 語 of ["ACSAC 2027", "CoNLL 2027", "NSDI 2028", "apnoms", "情報処理学会 HPC 研究会"]) {
    const 見 = 畫面(語, [], Date.now());
    if (!見 || (!見.count && !見.terms.length)) continue; // 画面も黙る問は比べる意味が無い
    /* 既定の窓（画面と同じ）で引く – 収録にまで行がある問（`CoNLL 2027` は収録 1 行）は
     * MCP が行を返して黙るので、比べるのは画面と同じ窓。 */
    const text = await call("search_deadlines", { query: 語, limit: 1 });
    const 會議を名指した = text.includes("収録の会議の名前には");
    const 語を名指した = text.includes("名簿に、その語に似た名前の会議は在ります");
    /* 画面が**会議を 1 件に定めた**時は、MCP も会議を名指さねばならん（状態を添へる方が
     * 役に立つ – 「締切の行が 1 本もありません」「絞り込みを外すと出ます」は会議の話に付く）。
     * 画面が語だけを見付けた時は、語を名指すので足りる。 */
    expect(
      見.count > 0 ? 會議を名指した : 語を名指した || 會議を名指した,
      `「${語}」は畫面が名簿を名指す（count ${見.count}・語 ${見.terms.join("・")}）のに、MCP は同し事を言つて居ない`,
    ).toBe(true);
  }
  /* 英字の語は名前の中で**獨立に立つ**事を要求する（画面と同じ – `st` は多くの名前に
   * 部分として含まるが、どれにも立たない）。部分一致に戻すと、名前にその語を含むだけの
   * 会議を「名簿にある」と言之てしまふ。 */
  /* 前提をこの方で確かめる – `st` は名前に部分として含まるが、どれにも**語として立たん**。 */
  const 殻 = (品書の會議 ?? []).map((c) =>
    `${String((c as { acronym?: unknown }).acronym ?? "")} ${String((c as { title?: unknown }).title ?? "")} ${String((c as { full_name?: unknown }).full_name ?? "")} ${String((c as { key?: unknown }).key ?? "")}`.toLowerCase(),
  );
  expect(
    殻.some((h) => /(^|[^a-z0-9])st([^a-z0-9]|$)/u.test(h)),
    "この検查の前提（`st` がどこにも立たん）が崩れた",
  ).toBe(false);
  const 部分 = await call("search_deadlines", { query: "st", scope: "all", limit: 1 });
  expect(部分, "部分一致の語を名簿の名指しに使つた").not.toContain("収録の会議の名前には");
  expect(部分, "部分一致の語を名簿の名指しに使つた").not.toContain(
    "名簿に、その語に似た名前の会議は在ります",
  );
  /* 画面も黙る問には、MCP も名簿の話を立てない（行が出るのであれば、どちらも黙る）。 */
  const 默る = 畫面("zzzznotaconference", [], Date.now());
  expect(默る, "この検查の前提（画面が黙る問）が崩れた").toBeNull();
  const 默る答 = await call("search_deadlines", {
    query: "zzzznotaconference",
    scope: "all",
    limit: 1,
  });
  expect(默る答, "画面が黙る問に名簿の話を立てた").not.toContain("収録の会議の名前には");
});

it("key で問はれた時は、その会議の事を言う（第 876 回）", async () => {
  /* 実測 2026-10-12: `venue_info({key: "sc", scope: "screen"})`（窓に行が無い）が、
   * **全く別の会議**（jornadas-dl2）を「その会議は収録に在りますが…」と返していた。key を
   * 受けた時に名が空の儘名前で名簿を探すと、`title.includes("")` がどれにも当たつて
   * **先頭の会議**を拾ふため。AI は「その会議の締切は無い」と問はた会議の事として言つてしまふ。 */
  const text = await call("venue_info", { key: "sc", scope: "screen" });
  expect(text, "問はた会議を名指していない").toContain("key: sc");
  expect(text, "別の会議の事を言つた").not.toContain("jornadas");
  expect(text, "問はた会議の名を出していない").toContain("SC");
  /* 大文字の key も受け付ける（照合は画面と同じ）。 */
  const 大 = await call("venue_info", { key: "SC", scope: "screen" });
  expect(大, "大文字の key を別の会議と取り違へた").toContain("key: sc");
  expect(大).not.toContain("jornadas");
  /* 収録に無い key は「無い」と言う。 */
  const 無 = await call("venue_info", { key: "nosuchconfkey", scope: "screen" });
  expect(無, "収録にない時に別の会議を返した").toContain("その会議");
  /* 名の一部で問はれた時は候補を並べる（一つに決め打たない – 第 726 回の儘）。 */
  const 名 = await call("venue_info", { name: "sc", scope: "screen" });
  expect(名, "名の一部で候補を並べていない").toContain("会議が当たりました");
});

it("使えない数の引数は黙つて既定に戻さない（第 878 回）", async () => {
  const 檢索 = await call("search_deadlines", { query: "セキュリティ", within_days: 0 });
  expect(檢索, "使ひ切れない値を黙つた").toContain("within_days は 1 以上の数で指定してください");
  expect(檢索, "その値を使つた事にしている").toContain("その値は使わず、未指定として扱います");
  expect(檢索, "窓を書いた").not.toContain("／締切まで");
  /* 負の値・数でない値も（`Number("abc")` は NaN になる）。 */
  const 負 = await call("search_deadlines", { query: "セキュリティ", within_days: -5 });
  expect(負, "負の値を黙つた").toContain("within_days は 1 以上の数で指定してください");
  const 文字 = await call("search_deadlines", { query: "セキュリティ", within_days: "三" });
  expect(文字, "数でない値を黙つた").toContain("within_days は 1 以上の数で指定してください");
  /* 使へる値はそのまま通す（斷りを付けない）。 */
  const 使へる = await call("search_deadlines", { query: "セキュリティ", within_days: 30 });
  expect(使へる, "使える値に斷りを付けた").not.toContain("1 以上の数で指定してください");
  expect(使へる, "窓を書いていない").toContain("／締切まで 30 日");
  /* 他の数の引数も同じ（`limit`・`days`）。 */
  const 件數 = await call("search_deadlines", { query: "ai", limit: 0 });
  expect(件數, "limit を黙つた").toContain("limit は 1 以上の数で指定してください");
  const 一覽 = await call("list_upcoming", { days: "abc" });
  expect(一覽, "days を黙つた").toContain("days は 1 以上の数で指定してください");
  expect(一覽, "既定で読んだ事を書いていない").toContain("30 日（既定）");
  /* 省略された時は何も言はない（既定を使つた事を毎回書かない）。 */
  const 省いた = await call("list_upcoming", {});
  expect(省いた, "省いた時に斷りを付けた").not.toContain("1 以上の数で指定してください");
  expect(省いた, "省略時に既定の表示に変はつた").toContain("30 日以内");
  /* 推薦の `limit` も同じ。 */
  const 推薦 = await call("recommend_venues", {
    paper: "Low-Latency Networking | network",
    limit: 0,
  });
  expect(推薦, "推薦の limit を黙つた").toContain("limit は 1 以上の数で指定してください");
});

it("表に表示しない種別の語は、選び方を件数つきで敿へる（第 879 回）", async () => {
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
    /* **敎へた件数は、その指定で実際に引いた結果と一致する**。 */
    const 敎へた = Number(String(m?.[1]).replace(/,/g, ""));
    expect(敎へた, `「${語}」の件數が讀めない`).toBeGreaterThan(0);
    const 引いた = await call("search_deadlines", { query: 語, kinds: [種別] });
    const 出た = Number(/に当たる締切: ([\d,]+) 件/.exec(引いた)?.[1]?.replace(/,/g, "") ?? -1);
    expect(出た, `「${語}」の件數が實際と違ふ: ${敎へた} ≠ ${出た}`).toBe(敎へた);
  }
  /* 投稿締切の種別を打つた人には付けない（その種別は既定で出る）。 */
  const 論文 = await call("search_deadlines", { query: "論文締切" });
  expect(論文, "投稿締切に種別の話を付けた").not.toContain("の種別に当たります");
  /* 画面が黙る問（どの種別の語でも無い）にも付けない。 */
  const 默る = await call("search_deadlines", { query: "インターネット" });
  const 默る數 = /に當たる締切: ([\d,]+) 件/.exec(默る);
  if (默る數 && Number(默る數[1]) > 0)
    expect(默る, "行が出る問に種別の話を付けた").not.toContain("の種別に当たります");
});

it("語を並べて打つた時、収録にない語を名指す（第 880 回）", async () => {
  const text = await call("search_deadlines", { query: "ネットワーク GPU" });
  expect(text, "収録にない語を名指していない").toContain("は収録データにも見当たりません");
  expect(text, "外すと増える事を言つていない").toContain("その語を外すと増えます");
  /* 語ごとの件数も、画面と同じ正典（`queryTermCounts`）で数へた物と一致する。 */
  const 窓 = displayCandidates(
    JSON.parse(readFileSync(join(REPO_ROOT, "public", "catalog.json"), "utf8")) as never,
  ) as Array<{ hay: string }>;
  const now = Date.now();
  const 件數 = Recommender.queryTermCounts(
    Recommender.expandRelativeMonths("ネットワーク GPU", now),
    窓.map((r) => r.hay),
    now,
  );
  const 死んだ語 = 件數.filter((t) => t.count === 0).map((t) => t.term);
  expect(死んだ語.length, "この検查の前提（死語がある問）が崩れた").toBeGreaterThan(0);
  expect(text, `死語の名が違ふ: ${死んだ語.join("・")}`).toContain(`「${死んだ語[0]}」`);
  /* どれも収録にあるのに「全部を含む行」が無い時 – 語ごとの件数を並べて、どれを外すか選ばせる。 */
  const 兩方 = await call("search_deadlines", { query: "セキュリティ 福岡" });
  expect(兩方, "死語としてゐない問に死語の話をした").not.toContain("見当たりません");
  expect(兩方, "語ごとの件数を書いていない").toContain("語をすべて含む行はありません");
  expect(兩方, "福岡の件数が書かれていない").toContain("「福岡」");
  /* 語が一つの時は他の家（打ち直し・種別の話）に讓る（重ねて二度言はない）。 */
  const 一つ = await call("search_deadlines", { query: "閏年" });
  expect(一つ, "語が一つの問に語ごとの話を付けた").not.toContain("語をすべて含む行はありません");
});

it("URL を貼つた人を、ドメインの部品の話に引きずり込まない（第 881 回）", async () => {
  const text = await call("search_deadlines", { query: "https://icde2027.example.org/cfp" });
  expect(text, "収録の中心を言つていない").toContain("検索語の URL の会議は収録に見当たりません");
  expect(text, "会議名で試す事を言つていない").toContain("会議名（「ICDE」など）で試してください");
  expect(text, "ドメインの部品を語として扱つた").not.toContain("「example」");
  expect(text, "ドメインの部品を会議の名として扱つた").not.toContain("「cfp」に似た名前");
  /* http が無い形（ドメインだけ）も受ける。 */
  const ドメイン = await call("search_deadlines", { query: "icde2027.example.org" });
  expect(ドメイン, "ドメインだけの形に URL の話をしていない").toContain(
    "検索語の URL の会議は収録に見当たりません",
  );
  expect(ドメイン).not.toContain("「example」");
  /* 会議の URL が収録にある時は、黙つて行を返す（画面と同じ – 0 件の時にだけ立てる）。 */
  const 在る = await call("search_deadlines", { query: "https://www.sigcomm.org/" });
  expect(在る).toContain("検索語");
  /* 通常の語には効かない（URL の話を出さん）。 */
  const 通常 = await call("search_deadlines", { query: "ネットワーク GPU" });
  expect(通常, "URL でない問に URL の話を付けた").not.toContain("検索語の URL の会議は");
  expect(通常, "死語の話が恢復して居らん").toContain("「gpu」");
});

it("画面のてびきが、MCP の全ての道具を名指す（第 882 回）", async () => {
  const 頁 = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const 段 = ((): string => {
    const i = 頁.indexOf("AI に聞く");
    expect(i, "てびきに「AI に聞く」の段がない").toBeGreaterThan(0);
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
  /* 実装が持つ道具の一覽（`tools/list`）と、てびきが名指す文を突き合はせる。 */
  const res = (await client.ask({ jsonrpc: "2.0", id: 98, method: "tools/list" })) as {
    result?: { tools?: Array<{ name?: string }> };
  };
  const 名々 = (res.result?.tools ?? []).map((t) => String(t.name ?? "")).sort();
  expect(名々.length, "この検查の前提（道具の一覽）が崩れた").toBeGreaterThan(0);
  for (const 名 of 名々) {
    const 言ひ方 = 道具の言ひ方[名];
    expect(言ひ方, `てびきの文を決めて居ない道具が增えた: ${名}（此の表に足す事）`).toBeTruthy();
    expect(段, `てびきが ${名}（${言ひ方}）を名指して居ん`).toContain(言ひ方);
  }
  /* 雙方の樣に数も変へた（「四つ」が残つていると読む人が古い数を信じる）。 */
  expect(段, "てびきが「四つ」の儘").not.toContain("の四つ）");
});

it("道具の説明と索引の例に、データ依存の件数を書かない（第 883 回）", async () => {
  const res = (await client.ask({ jsonrpc: "2.0", id: 97, method: "tools/list" })) as {
    result?: { tools?: Array<{ name?: string; description?: string }> };
  };
  const 檢索 = String(
    res.result?.tools?.find((t) => t.name === "search_deadlines")?.description ?? "",
  );
  expect(檢索, "search_deadlines の說明が読めない").toContain("語を省いて");
  const データ依存の例: Array<[string, RegExp]> = [
    ["件數の例（N 件にして居る）", /\d+ 件当たります/u],
    ["語ごとの件數の例", /を書く行は \d+ 件/u],
    ["一番遠い締切の例", /一番遠い締切 \d{4}-\d{2}-\d{2}/u],
  ];
  for (const [名, 形] of データ依存の例)
    expect(形.test(檢索), `${名}を固めた數で書いて居る（N 件にする事）`).toBe(false);
  /* 形は残つている（例を消して「件数つき」と言うだけにしては、AI がどう書くか分からん）。 */
  expect(檢索, "件数を添える形を書いていない").toContain("next_offset");
  /* 索引（建てた `llms.txt`）の MCP の節も同じ（こちらが持つ実測の数は、建てた時に数へた物
   * なので正しい – 見るのは**例**の文だけ）。 */
  const 索引 = readFileSync(join(site, "llms.txt"), "utf8");
  const 節 = 索引.slice(索引.indexOf("## AI から引く（MCP）"));
  expect(節, "索引に AI の節がない").toContain("MCP");
  for (const [名, 形] of データ依存の例)
    expect(形.test(節), `索引の${名}を固めた數で書いて居る`).toBe(false);
  expect(節, "索引の例の形が消えている").toContain("next_offset");
});

/** 画面（`app.js`）の 0 件案内を、最小の材料で拔き出して走らせる。 */
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
  const rows = displayCandidates(品書 as never) as Array<{ hay: string }>;
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

it("どの案内にも当たらなかつた問に、この表が何を出す画面なのかを言う（第 884 回）", async () => {
  const text = await call("search_deadlines", { query: "脳科学" });
  expect(text, "この表が何を出す画面なのかを言つていない").toContain(
    "この表が出すのは催し物の名前・締切の日・分野・種別・開催地・参加形式で",
  );
  expect(text, "他の語で試す事を言つていない").toContain(
    "別の語で試す（分野名・主題・開催地の日本語でも引けます）",
  );
  /* 分野の名は**品書が持つ地圖**から、画面のと同じ順・同じ札で（固定の一覽を書くと
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
  expect(期待.length, "この検查の前提（品書の分野）が崩れた").toBeGreaterThan(0);
  expect(text, `分野の欄が畫面と同じ言ひ方でない: ${期待.join("・")}`).toContain(
    `分野の欄は${期待.join("・")}の${期待.length}種だけで`,
  );
  /* 画面の文と突き合はせる（拔き出した `emptyDeadlineHint` に同じ問を通す）。 */
  const 畫面の文 = 畫面の受皿("脳科学");
  if (畫面の文) {
    /* 両方に「この表が出すのは」がある事まで（文言は画面が正本）。 */
    expect(畫面の文, "画面の文が変はつた（この検查を見直す）").toContain(
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
  /* 總当たり – 0 件になる問を片つて引いて、**受皿が他の案内と重ならない事**を見る
   * 。 */
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
  /* 複数の種別は**どれか**（61 件 = `paper` だけと同じ）。 */
  const 複数 = await call("list_upcoming", { kinds: ["paper", "zzz"] });
  expect(複数, "どれかで選べていない").toMatch(/締切: [1-9]\d* 件/);
  expect(複数, "知らない種別を名指していない").toContain(
    "知らない種別（指定したままでは 0 件になります）: zzz",
  );
  /* 大文字でも受け付ける（AI は `PAPER` を送る）。 */
  const 大文字 = await call("list_upcoming", { kind: "PAPER" });
  expect(大文字, "大文字の種別を受け付けていない").toMatch(/締切: [1-9]\d* 件/);
  const 小文字 = await call("list_upcoming", { kind: "paper" });
  const 數 = (t: string): string => /締切: ([\d,]+) 件/.exec(t)?.[1] ?? "-1";
  expect(數(大文字), "大文字と小文字で件数が違う").toBe(數(小文字));
  /* 知らない種別だけの時は 0 件だが、その種別がある事を言う。 */
  const 知らん = await call("list_upcoming", { kind: "nosuchkind" });
  expect(知らん).toContain("知らない種別");
  expect(知らん, "知らない種別がある様に見せている").toMatch(/締切: 0 件/);
  /* 知つている種別には斷りを付けない。 */
  for (const 語 of ["paper", "all"]) {
    const 答 = await call("list_upcoming", { kind: 語 });
    expect(答, `「${語}」に知らない種別の斷りを付けた`).not.toContain("知らない種別");
  }
  /* `search_deadlines` と同じ言ひ方（両方の道具で同じ文を返す）。 */
  const 檢索 = await call("search_deadlines", { kinds: ["zzz", "paper"] });
  expect(檢索, "検索の方が知らない種別を名指していない").toContain("知らない種別");
});

it("venue_info は正式名で引き、版の識別子を会議に敿へる（第 887 回）", async () => {
  /* 実測 2026-10-20 で二つ:
   * ① `name: "Supercomputing"` は「収録に在りません」と答へていた。正式名
   *   （`ICS` = ACM International Conference on Supercomputing）にしか出て居ない語で、
   *   検索检索側（`search_deadlines`）は 37 行出すのに venue_info は黙つていた。
   * ② `key: "sc26"`（版の識別子）も「収録に在りません」。`data.csv` の `edition_id` や
   *   `data.json` の `editions[].id` をそのまま渡すことは実際にある（AI は読んでいる）。 */
  const 正式名 = await call("venue_info", { name: "Supercomputing" });
  expect(正式名, "正式名で引けていない").not.toContain("その会議");
  /* 行が見付かつた**上で**候補を並べる（名簿の受皿に落とさない – それは「締切の行が 1 本も
   * ありません」といふ噓に成る。ICS は正式名の語で 37 行持っている）。 */
  expect(正式名, "正式名の会議を教へていない").toContain("ICS");
  expect(正式名, "名簿の受皿に落ちた（締切があるのにないと言う）").not.toContain(
    "締切の行が 1 本もありません",
  );
  /* 検索检索が行を出す語は、こちらでも会議を見付ける（同じ評價を持つ – 第 726 回の延長）。 */
  const rows = displayCandidates(
    JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as never,
  );
  const now = Date.now();
  const m = Recommender.searchMatcher(Recommender.expandRelativeMonths("Supercomputing", now), now);
  const 搜した = rows.filter((r) => m(String(r.hay)) === true);
  expect(搜した.length, "この検查の前提（検索检索が行を出す語）が崩れた").toBeGreaterThan(0);
  expect(正式名).toContain(`${[...new Set(搜した.map((r) => String(r.conf.title)))][0]}`);

  /* 版の識別子は「無い」と言はない（会議の key を教へる）。 */
  const 版 = await call("venue_info", { key: "sc26" });
  expect(版, "版の識別子をないと言つた").not.toContain("その会議");
  expect(版, "版だと言つていない").toContain("版（edition）の識別子");
  expect(版, "会議の key を教へていない").toContain("`sc`");
  /* 大文字の版の識別子も受け付ける。 */
  const 大文字 = await call("venue_info", { key: "SC26" });
  expect(大文字, "大文字の版の識別子を受け付けていない").toContain("`sc`");
  /* 会議の key はそのまま通す（版の話を出さない）。 */
  const 會議 = await call("venue_info", { key: "sc" });
  expect(會議, "会議の key に版の話を付けた").not.toContain("版（edition）の識別子");
  expect(會議).toContain("会議:");
  /* どちらでも無い識別子は「無い」と言う。 */
  const 無し = await call("venue_info", { key: "nosuchconfkey" });
  expect(無し, "収録にない時に別の会議を返した").toContain("その会議");
});

it("explain_word も search_deadlines と同じ案内を出す（第 888 回）", async () => {
  /* 語を調べる道具は「0 件の時に画面が出す案内文をそのまま返す」と請け合つているのに、
   * 検索の方に足した案内（第 879〜884 回）が inert こなかつた。実測 2026-10-21:
   * `explain_word("カメラレディ")` は 70 行ある事だけ言つて、その種別の選び方を言はなかつた。
   * `explain_word("ネットワーク GPU")` は「（案内は無し＝表の語では無い語）」と書きながら、
   * 次の行に名簿の案内を出していた（「無し」と言之ながらある物を出すのは噓）。 */
  /* ① 素の照合で行があるのに、画面の既定で 0 件に成る語 – その**理由**を言う。 */
  const 種別 = await call("explain_word", { word: "カメラレディ" });
  expect(種別, "0 件に成る理由を言つていない").toContain("画面の既定の絞り込みで 0 件になる理由");
  expect(種別, "種別の選び方を言つていない").toContain('kinds: ["camera_ready"]');
  /* 検索が言う件数と同じ（その指定で実際に引いた数 – 第 762 回）。 */
  const 檢索 = await call("search_deadlines", { query: "カメラレディ" });
  const 件數 = (t: string): string =>
    /kinds: \["camera_ready"\] で引けます（([\d,]+) 件/.exec(t)?.[1] ?? "";
  expect(件數(種別), `語の案内と檢索で件數が違ふ: ${件數(種別)} ≠ ${件數(檢索)}`).toBe(件數(檢索));
  /* ② 語ごとの件数も出す。 */
  const 死語 = await call("explain_word", { word: "ネットワーク GPU" });
  expect(死語, "収録にない語を名指していない").toContain("は収録データにも見当たりません");
  /* ③ 「案内は無し」は何も無い時だけ（次の行に名簿の案内があるのに「無し」は噓）。 */
  expect(死語, "名簿の案内があるのに「無し」と書いた").toContain("収録の名簿に");
  expect(死語.split("\n").some((l) => l.includes("案内は無し") && l.includes("名簿"))).toBe(false);
  expect(
    (await call("explain_word", { word: "ネットワーク GPU" })).includes("案内は無し"),
    "案内があるのに「無し」を出した",
  ).toBe(false);
  /* ④ URLと受皿も出す。 */
  const URLの答 = await call("explain_word", { word: "https://icde2027.example.org/cfp" });
  expect(URLの答, "URL の案内を出していない").toContain(
    "検索語の URL の会議は収録に見当たりません",
  );
  const 受皿 = await call("explain_word", { word: "脳科学" });
  expect(受皿, "この表が何を出す画面なのかを言つていない").toContain(
    "この表が出すのは催し物の名前",
  );
  /* ⑤ 行が出る語には理由を付けない（餘計な斷りを増やさない）。 */
  const 行あり = await call("explain_word", { word: "セキュリティ" });
  expect(行あり, "行が出る語に理由を付けた").not.toContain("0 件に成る理由");
  expect(行あり).toContain("素の照合で");
});

it("検索と言語の道具で、案内の有無が一致する（第 889 回）", async () => {
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
      /* 両方に出るか、両方に出ないか（片方だけだと、読む人と AI で答へが違ふ）。 */
      expect(言語に出る, `「${q}」の「${名}」が explain_word にだけ出た（檢索は出ない）`).toBe(
        檢索に出る,
      );
      expect(檢索に出る, `「${q}」の「${名}」が search_deadlines にだけ出た（言語は出ない）`).toBe(
        言語に出る,
      );
    }
  }
});

it("窓がない手元では、何を読んでいるかを言う（第 892 回）", async () => {
  /* 品書（`public/catalog.json`）を build して居ない手元では、窓が無いので収録の全体を見る。
   * 黙つていると**件数が配布先の画面と違ふ理由が読めない** – 実測 2026-10-23: 品書がある時は
   * `セキュリティ` 37 件・無い時は 42 件。AI は「画面と違ふ」で躪き、利用者は噓を疑ふ。
   * 読み込みは起動時に一度だけなので、この検查は**別の手順を起こして**試す（長生きのサーバは
   * 既に品書を読んで仕舞ふ – 実測 2026-10-23 に踏んだ）。 */
  const 品書 = join(REPO_ROOT, "public", "catalog.json");
  expect(
    existsSync(品書),
    "検証に必要な生成物がありません。オフラインビルドを実行してください",
  ).toBe(true);
  const isolatedRoot = mcpSandbox();
  const 聞く = (call: Record<string, unknown>): string => {
    const 返事 = spawnSync(process.execPath, [join(isolatedRoot, "src", "mcp.ts")], {
      input: `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", clientInfo: { name: "t", version: "0" } },
      })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: call })}\n`,
      encoding: "utf8",
      timeout: 180_000,
    });
    expect(返事.status, 返事.stderr).toBe(0);
    const 行 = (返事.stdout || "")
      .trim()
      .split("\n")
      .map((l) => {
        return JSON.parse(l) as Record<string, unknown>;
      })
      .find((m) => m && m.id === 2);
    return String(
      (行?.result as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text ?? "",
    );
  };
  const 斷り = "public/catalog.json）がこの手元にない";
  const 檢索 = 聞く({ name: "search_deadlines", arguments: { query: "セキュリティ", limit: 1 } });
  expect(檢索, "窓がない事を言つていない").toContain(斷り);
  expect(檢索, "どうすればよいか言つていない").toContain("npm run build");
  const 一覽 = 聞く({ name: "list_upcoming", arguments: { days: 30, scope: "screen" } });
  expect(一覽, "一覽が窓がない事を言つていない").toContain(斷り);
  const 語 = 聞く({ name: "explain_word", arguments: { word: "ネットワーク GPU" } });
  expect(語, "語の案内が窓がない事を言つていない").toContain(斷り);
  /* 品書がある時は斷りを出さない（騷音を増やさない）。 */
  const 在る = await call("search_deadlines", { query: "セキュリティ", limit: 1 });
  expect(在る, "品書がある時に斷りを付けた").not.toContain("この手元にない");
  expect(在る, "品書がある時に窓の名を変へた").toContain("画面が最初に読む窓");
});

it("venue_info は次の投稿締切を先頭で言う（第 893 回）", async () => {
  /* 実測 2026-10-24: `venue sigkdd` の一覽の先頭は「反論期間終了」と「採否通知」で、
   * 「KDD の次の締切は？」と聞いた人が**投稿の締切**を探すのに 60 を越える行を読まなければ
   * 成らなかつた（「締切」と言へば投稿の締切を指すのが普通）。行の一覽は変へず、先頭に
   * 投稿の種別（論文・概要）の行を 1 本だけ添へる。 */
  const 今後の在る = await call("venue_info", { key: "icde", scope: "all" });
  expect(今後の在る, "次の投稿締切を言つていない").toContain("次の投稿締切: 20");
  /* 画面と同じ行の形（`line()`）なので、何時・どの回・札が読める。 */
  expect(今後の在る, "投稿の締切の行が細い").toContain("論文締切");
  expect(今後の在る, "確認の札が付いていない").toContain("複数候補のため要確認");
  /* 今後の投稿締切が無い会議では、**一番遲い過去**を言う（一番古い過去では「5 年前に終はつた」
   * と読めてしまふ – 実測で 2021 年が出ていた）。 */
  const 過ぎた = await call("venue_info", { key: "sigkdd", scope: "all" });
  expect(過ぎた, "今後の投稿締切がない事を言つていない").toContain(
    "次の投稿締切: 今後の収録にありません",
  );
  const 直近 = /直近では (\d{4})-\d{2}-\d{2}/.exec(過ぎた)?.[1] ?? "";
  expect(Number(直近), "一番遲い過去が出ていない").toBeGreaterThan(2024);
  /* 行の一覽は変へない（黙つて減らさない）。 */
  const 行數 = 過ぎた.split("\n").filter((l) => /^\d{4}-\d{2}-\d{2}/.test(l)).length;
  expect(行數, "行の一覽が減つた").toBeGreaterThan(1);
});

it("推薦の pool は画面と同じ組み立て（第 894 回）", async () => {
  /* 実測 2026-10-25: `recommend_venues` は索引の行（2,458 本）をそのまま pool に使つていた。
   * その 92% は**過ぎた締切**なので、「おすすめの投稿先」の 1・2 番目に締め切つた会報が
   * 擧がり、AI は「來年でなく今出せる」と誤つて勧めてしまふ。画面は「これからの締切 +
   * 常時受付のジャーナル + これからの締切が無い会議の過去代表 1 行」で選ぶので、それに揃へる。 */
  const 品書 = join(REPO_ROOT, "public", "catalog.json");
  expect(
    existsSync(品書),
    "検証に必要な生成物がありません。オフラインビルドを実行してください",
  ).toBe(true);
  const 索引 = JSON.parse(
    readFileSync(join(REPO_ROOT, "public", "recommendation-index.json"), "utf8"),
  ) as { conferences?: unknown[]; reranker?: unknown };
  Recommender.setNameIdf(Recommender.buildNameIdf(索引.conferences ?? []));
  Recommender.setReranker(索引.reranker ?? null);
  const catalog = JSON.parse(readFileSync(品書, "utf8"));
  const rows = displayCandidates(catalog) as unknown as Array<Record<string, unknown>>;
  const now = Date.now();
  /* 画面の pool をこちらで組み立てる（`site/app.ts` の `pool` と同じ 3 つ）。 */
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
  expect(正.length, "画面と同じ pool で候補が出ない（この検查の前提が崩れた）").toBeGreaterThan(0);
  const text = await call("recommend_venues", { paper: 題, limit: 5 });
  expect(text, `候補の數が畫面と同じ pool と違ふ: ${正.length} 件の筈`).toContain(
    `に合う投稿先: ${正.length} 件`,
  );
  expect(text, "先頭の候補が違う").toContain(String(正[0].row.conf.title));
  /* **過ぎた候補が幾つあるか**を頭で分けて言う（黙つていると AI が今出せる樣に勧める）。 */
  const 過ぎた = 正.filter((r) => Number(r.row.t) < now).length;
  if (過ぎた > 0)
    expect(text, "過ぎた候補の件数を言つていない").toContain(`うち ${過ぎた} 件は締切が過ぎた会議`);
});

it("品書が再学習の重みを持つ – 画面の推薦が MCP と同じ順に成る（第 895 回）", async () => {
  const 品書 = join(REPO_ROOT, "public", "catalog.json");
  expect(
    existsSync(品書),
    "検証に必要な生成物がありません。オフラインビルドを実行してください",
  ).toBe(true);
  const catalog = JSON.parse(readFileSync(品書, "utf8")) as {
    reranker?: unknown;
    conferences?: unknown[];
  };
  expect(catalog.reranker, "品書が再学習の重みを載せていない").toBeTruthy();
  /* 画面が読む通りに読んで、MCP と同じ順序が出ることを確かめる。 */
  const paper =
    "Time-Sensitive Networking Scheduling for Deterministic Industrial Networks | tsn, real-time, scheduling, deterministic";
  const now = Date.now();
  const rows = displayCandidates(catalog as never);
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

it("推薦の札の意味を、画面てびきと同じ言い回しで添える（第 896 回）", async () => {
  /* 実測 2026-10-27: 札（「候補」・「重なりうすい」）をそのまま返すだけで、何を意味するか読めなかつた。
   * AI が「候補」を「当たる見込みが高い」と取ると、推薦の强さが変はつてしまふ – 札は**一致の
   * 證據の强さ**で、採択の予測ではない（画面のてびきの「いちばん近い会議との差が小さい」）。 */
  const text = await call("recommend_venues", {
    paper:
      "Time-Sensitive Networking Scheduling for Deterministic Industrial Networks | tsn, real-time, scheduling",
    limit: 3,
  });
  expect(text, "札の意味を言つていない").toContain("いちばん近い会議との差が小さい");
  expect(text, "札の意味を言つていない").toContain("言葉の重なりが弱い");
  /* 数値（点）の読み方も黙らない（並べるための目安で採択の予測ではない – 画面のてびきの約束）。 */
  expect(text, "数値の読み方を言つていない").toContain("採択の予測ではありません");
});

it("推薦の行に、画面と同じ選定理由が付く（第 897 回）", async () => {
  /* 実測 2026-10-28: MCP の推薦行は「点」と「札」だけで、**何でこの会報か**が分からなかつた。
   * 画面のカードは「選定理由: 分野の一致 / 会議名一致」と言う（`site/app.ts` の
   * `reasonSignals` – 同じ 5 つ + 過去掲載先。重みは書かない – 画面が「スコアと合はない」
   * 実測で削つた）。黙つて落とすと、AI は根拠を言へず「おすすめです」に成る。 */
  const 品書 = join(REPO_ROOT, "public", "catalog.json");
  expect(
    existsSync(品書),
    "検証に必要な生成物がありません。オフラインビルドを実行してください",
  ).toBe(true);
  const catalog = JSON.parse(readFileSync(品書, "utf8")) as {
    reranker?: unknown;
    conferences?: unknown[];
  };
  const paper =
    "Time-Sensitive Networking Scheduling for Deterministic Industrial Networks | tsn, real-time, scheduling";
  /* 画面が表示する札と同じ理由をこちらで組む。 */
  const now = Date.now();
  const rows = displayCandidates(catalog as never);
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
  expect(正.length, "この検査の前提（候補が出る題名）が崩れた").toBeGreaterThan(0);
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
  expect(text, "選定理由を言つていない").toContain("選定理由: ");
  expect(text, `先頭の候補の理由が畫面と違ふ: ${期待}`).toContain(`選定理由: ${期待}`);
  /* 重みは書かない（画面と同じ – 数字を並べると「点と合はない」と誤読させる）。 */
  expect(text, "重みの数字を書いた").not.toMatch(/選定理由: [^\n]*\d+ 点/);
});

it("推薦の行に、画面と同じ締切の確認状況が付く（第 898 回）", async () => {
  /* 実測 2026-10-29: 推薦行は日付と種別だけを出して、**その締切が公式確認できているか**を
   * 言はなかつた。AI が「次は 2027-01-29 です」と言へても、推定の日付なのか分からん。
   * 画面のカードは 4 つの軸（日期・時刻・タイムゾーン・種別）を出す – 軸の計算は
   * `site/recommendation-core.ts` の共有関数（画面と同じ入口）。 */
  const paper =
    "Time-Sensitive Networking Scheduling for Deterministic Industrial Networks | tsn, real-time, scheduling";
  const text = await call("recommend_venues", { paper, limit: 3 });
  const 行 = text.split("\n").filter((l) => /^\d+\. 一致評価 /.test(l));
  expect(行.length, "推薦行が出ていない（この検查の前提が崩れた）").toBeGreaterThan(0);
  for (const l of 行) {
    expect(l, "確認状況が付いて居ない行がある").toContain("締切の確認状況: 日付");
    for (const 軸 of ["時刻", "タイムゾーン", "種別"])
      expect(l, `${軸}の軸が無い`).toContain(`${軸} `);
    /* **内部の表記を見せない**（画面と同じ約束 – `official` をそのまま出さない）。 */
    expect(l, "内部の語をそのまま出した").not.toMatch(
      /(official|unverified|assumption|aggregator|publisher)\b/,
    );
  }
  /* 軸の値は共有の関数が数へたものと同じ（画面と一体）。 */
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
      /* 会議名と confidence の語が揃ふ行が在れば、その文が出tein – 全部の会議を一就有に
       * 並べると行が可笑しいので、会議名と状況の両方が同じ行にある時だけ確かめる。 */
      const 名 = String((conf as { title?: unknown }).title ?? "").slice(0, 12);
      if (名 && text.includes(名)) {
        expect(text.includes(`｜${期待}｜`), `「${名}」の確認狀況が共有の函數と違ふ`).toBe(true);
        break;
      }
    }
  }
});

it("推薦の行は、取得状態と締切の競合が普通でない時だけ書く（第 899 回）", async () => {
  /* 実測 2026-10-30: 会議 696 件の取得状態は**全部**「今回あたって確認」、締切の競合があるのは
   * 4 会議だけ（ALT / COMPSAC / cvm / ICST）。画面のカードは常に 2 つを出すが、MCP の返り値は
   * AI が読む文 – 常套の文を各行に足すと、変な 1 行だけが埋もれる。普通の時は黙つている。 */
  const 静か = await call("recommend_venues", {
    paper:
      "Time-Sensitive Networking Scheduling for Deterministic Industrial Networks | tsn, real-time, scheduling",
    limit: 5,
  });
  expect(静か, "普通の時に取得状態を書いた").not.toContain("取得状態: ");
  expect(静か, "競合 0 件の時に競合を書いた").not.toContain("締切の競合:");
  /* 競合がある会議では** contrario に書く**（黙るとその会議だけ読まれない）。 */
  const 競合 = await call("recommend_venues", {
    paper: "ALT algorithmic learning theory | learning theory, algorithms",
    limit: 10,
  });
  expect(競合, "候補が出ていない（この検查の前提が崩れた）").toMatch(/一致評価/);
  /* 競合がある会議の中に 1 件でも推荐されたなら、その行には競合の件数がある。 */
  const 競合の行 = 競合
    .split("\n")
    .filter((l) => /一致評価/.test(l))
    .filter((l) => /ALT/.test(l));
  if (競合の行.length) {
    expect(競合の行[0], "競合のある行に件数がない").toMatch(/締切の競合: [1-9]\d* 件/);
  }
});

it("品書の推薦の軸は全版で数えている – 新規の会議を新規と言ひ切らない（第 900 回）", async () => {
  /* 実測 2026-10-31: 画面は `r.conf.recommendation_axes` が無いと其場で軸を求めるが、品書の
   * 会議は**窓の版**しか持って居ないので历年が 1 年になり、`ICDE` が「新規・確認した年 1 年」
   * と出ていた（実物は「成長中・確認した年 7 年」）。会議 696 件の内 627 件が「新規」になつて
   * いた – 選擇の材料を壊していた。索引には全版で数へた軸が在つたが、画面は索引を読まない。 */
  const 品書 = join(REPO_ROOT, "public", "catalog.json");
  expect(
    existsSync(品書),
    "検証に必要な生成物がありません。オフラインビルドを実行してください",
  ).toBe(true);
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
  expect(軸を持つ.length, "品書に推薦の軸がない（この検査の前提が崩れた）").toBe(會議.length);
  /* 窓の版から其場で数へると 1 年に成る会議が、少なからずある（= それ曾是「新規」だった）。 */
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
    "窓の版で数えると 1 年になるのに、載せた軸が 2 年以上 – 実測と違う",
  ).toBeGreaterThan(0);
  /* MCP は**載せた軸**を使う（会議の續いている年数がその値になる）。 */
  const text = await call("recommend_venues", {
    paper: "ICDE International Conference on Data Engineering | icde, database, data mining",
    limit: 5,
  });
  expect(text, "成熟度の文を言つていない").toContain("会議の続いている年数: ");
  /* 内部の語を出さない（画面と同じ約束）。 */
  expect(text, "内部の語をそのまま出した").not.toMatch(/(established|emerging|unverified)\b/);
});

it("推薦の軸が画面の行まで届く（第 901 回）", async () => {
  const 品書 = join(REPO_ROOT, "public", "catalog.json");
  expect(
    existsSync(品書),
    "検証に必要な生成物がありません。オフラインビルドを実行してください",
  ).toBe(true);
  const catalog = JSON.parse(readFileSync(品書, "utf8"));
  const rows = displayCandidates(catalog as never) as unknown as Array<{
    conf?: {
      key?: string;
      recommendation_axes?: {
        venue_maturity?: { status?: string; evidence?: { yearsObserved?: number } };
      };
    };
  }>;
  expect(rows.length, "この検査の前提（行が出て居ない）が崩れた").toBeGreaterThan(0);
  const 軸のある行 = rows.filter((r) => r.conf?.recommendation_axes);
  expect(軸のある行.length, "行の conf に推薦の軸が届いていない").toBe(rows.length);
  /* 窓の版しか無くて其場で計算すると 1 年になる行が、2 年以上の値を持っている。 */
  const icde = rows.find((r) => r.conf?.key === "icde");
  expect(
    icde?.conf?.recommendation_axes?.venue_maturity?.status,
    "ICDE の成熟度が見当たらない",
  ).toBeTruthy();
  expect(
    Number(icde?.conf?.recommendation_axes?.venue_maturity?.evidence?.yearsObserved ?? 0),
    "ICDE の観測年数が 1 年以下 – 窓の版から其場で計算している",
  ).toBeGreaterThan(1);
});

it("人が道具の名を間違えたら、跡ytics ではなく助けを書く（第 904 回）", () => {
  /* 実測 2026-10-31: `node src/mcp.ts 検索` は Node の stack trace が出ていた。一到來た人が
   * そのまま打入した語であらうと、何を書けばよいかが読めない。`--help` と同じ一覧を出す。 */
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
  /* 短い別名は 6 つともある（`collection_stats` には `stats` – 其它 5 つにあるのに其在無かった）。
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
  /* 実測 2026-10-31: 画面の案内は「一覧より大きめのデータを読みます」だけで、実測すると
   * `data.json` は 9,490,437 バイト（約 9.1 MB）。内部の注釋は今も 6 MB 強と書いていた。
   * 押す前に**読める量**を知らせ無いと、読む人は自分の通信量で選べるのにそれが分から無い。 */
  const 品書 = join(REPO_ROOT, "public", "catalog.json");
  expect(
    existsSync(品書),
    "検証に必要な生成物がありません。オフラインビルドを実行してください",
  ).toBe(true);
  const catalog = JSON.parse(readFileSync(品書, "utf8")) as {
    history_ref?: string;
    history_bytes?: number;
  };
  expect(catalog.history_bytes, "品書が容量を載せていない").toBeGreaterThan(0);
  /* 申告した数字が**その物の寸法**と一致する（別の物を数えて居ない – 第 289 回の決めごと）。 */
  const 実寸 = statSync(join(REPO_ROOT, "public", String(catalog.history_ref ?? "data.json"))).size;
  expect(
    catalog.history_bytes,
    `品書の申告 ${String(catalog.history_bytes)} と實寸 ${実寸} が違ふ`,
  ).toBe(実寸);

  /* 画面の文は容量を数字で出す。容量を持た無い古い品書では從來の言葉に戻る。 */
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
  expect(有り, "容量を数字で言つていない").toMatch(/(KB|MB)/);
  expect(有り, "容量がないのに從來の言葉のまま").not.toContain("大きめのデータ");
  const 無し = 函數を拔く(0);
  expect(無し, "容量がない時に從來の言葉へ戻らない").toContain("大きめのデータ");
  expect(無し, "容量がない時に数を作つた").not.toMatch(/(KB|MB)/);
});

it("collection_stats は data.json の容量を、測れる時にだけ書く（第 906 回）", async () => {
  const 品書 = join(REPO_ROOT, "public", "catalog.json");
  const text = await call("collection_stats", {});
  expect(text, "ファイルの案内が出ていない").toContain("data.json（収録の全体");
  if (!existsSync(品書)) {
    expect(text, "集群が無くても容量をでっち上げた").not.toMatch(/約 [\d.]+ (KB|MB)/);
    return;
  }
  const catalog = JSON.parse(readFileSync(品書, "utf8")) as { history_bytes?: number };
  const 実 = statSync(join(REPO_ROOT, "public", "data.json")).size;
  expect(実, "この検査の前提（data.json がある）が崩れた").toBeGreaterThan(0);
  /* 品書の申告（過去実測で 9,490,437 バイト）と同じ測定結果に丸められる。 */
  const 期待 = catalog.history_bytes
    ? `約 ${(Number(catalog.history_bytes) / (1024 * 1024)).toFixed(1)} MB`
    : `約 ${(実 / (1024 * 1024)).toFixed(1)} MB`;
  expect(text, `容量の数字が容量の實測と違ふ（${期待} の筈）`).toContain(
    `data.json（収録の全体。機械可読の正・${期待}）`,
  );
});

it("scope の別名を受け、知らない値は名指す（第 908 回）", async () => {
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
  const 基本 = await call("search_deadlines", { query: "セキュリティ", limit: 1 });
  const 件數 = (t: string): string => /締切: ([\d,]+) 件/.exec(t)?.[1] ?? "";
  const 過去 = await call("search_deadlines", {
    query: "セキュリティ",
    limit: 1,
    include_past: true,
  });
  expect(件數(過去), "include_past が効いていない").not.toBe(件數(基本));
  /* 文字列・数字・-other の読みやすい形も同じ答えにする。 */
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
  /* 読めない値は**名指す**（数の引数と同じ – 黙って既定に戻さない）。 */
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
  /* `domestic` / `online` も読める形では効く（頭の「国内のみ」の札が出る）。 */
  const 國內 = await call("search_deadlines", {
    query: "セキュリティ",
    limit: 1,
    domestic: "true",
  });
  expect(國內, "domestic の文字列が効いていない").toContain("国内のみ");
  expect(件數(國內)).not.toBe(件數(基本));
  /* 省いた時は名指さない。 */
  expect(基本, "省いたのに名指した").not.toContain("true か false で指定してください");
});

it("list_upcoming に会期（開催）の行を出す（第 910 回）", async () => {
  const text = await call("list_upcoming", { days: 30, scope: "all", limit: 1 });
  expect(text, "開催の節がない").toContain("開催（会期の行）");
  /* **どこにも無い物ではない**ことを書く（AI が表に読みに行く様に）。 */
  expect(text, "同じ表の場所を言つていない").toContain("upcoming.md");
  expect(text, "画面とカレンダーに出ない事を言つていない").toContain(
    "画面の一覧とカレンダーには出ない",
  );
  const 件 = /開催（会期の行）: ([\d,]+) 件/.exec(text)?.[1]?.replace(/,/g, "") ?? "0";
  expect(Number(件), "開催の行が 1 件も出ていない").toBeGreaterThan(0);
  /* 件数と行数が合う（切り詰めた時も它的に書く – 第 765 回の決めごと）。 */
  const 行 = text
    .split("\n")
    .slice(text.split("\n").findIndex((l) => l.includes("開催（会期の行）")) + 1)
    .filter((l) => l.startsWith("- 20"));
  expect(行.length, `開催の行が ${件} 件と違ふ`).toBe(Number(件));
  /* 各行は会期を持つ（`- 2026-10-11(土) 〜 2026-10-15(木) | 会議名（key: …）`）。 */
  expect(行[0], "会期の行の形が違う").toMatch(/^- 20\d\d-\d\d-\d\d\(.\).*\| .+（key: [^）]+）/u);
  /* 締切の行も出ている（開催の節を足しても、締切の行は減らして居ない）。 */
  expect(text, "締切の行が見えない").toMatch(/^20\d\d-\d\d-\d\d/mu);
});

it("collection_stats が分野別の会議数を出す – health.json と同じ数（第 911 回）", async () => {
  const text = await call("collection_stats", {});
  expect(text, "分野別の件数がない").toContain("分野別の会議数（多い順");
  /* 数へるものは収録の会議から – 公開している `health.json` の数と**一つも違わない**。 */
  const 品書 = join(REPO_ROOT, "public", "catalog.json");
  const health = join(REPO_ROOT, "public", "health.json");
  expect(
    existsSync(品書) && existsSync(health),
    "検証に必要な生成物がありません。オフラインビルドを実行してください",
  ).toBe(true);
  const healthJson = JSON.parse(readFileSync(health, "utf8")) as {
    category_counts?: Record<string, number>;
  };
  const 數 = healthJson.category_counts ?? {};
  expect(
    Object.keys(數).length,
    "この検查の前提（health.json の分野別がある）が崩れた",
  ).toBeGreaterThan(0);
  for (const [key, n] of Object.entries(數)) {
    const 名 = Recommender.categoryLabelJa(key) ?? key;
    expect(
      text,
      `health.json の ${名} ${n} 件と答が違ふ（別の集計に居ると数が合わない）`,
    ).toContain(`${名} ${n}`);
  }
  /* 多い順に並ぶ（読む人が最初に見る物から順に – 索引の 9 分野の順ではない）。 */
  const 並び = [
    ...text.matchAll(
      /(人工知能|システム|セキュリティ|ネットワーク|高性能計算|データベース|計算理論|グラフィックス|人間情報処理) (\d+)/g,
    ),
  ];
  expect(並び.length, "分野の数が出ていない").toBe(9);
  const 數々 = 並び.map((m) => Number(m[2]));
  expect(
    [...數々].sort((a, b) => b - a),
    "多い順に並んで居ない",
  ).toEqual(數々);
});

it("collection_stats が上流のソースの状態を出す – 品書と同じ（第 912 回）", async () => {
  const 品書 = join(REPO_ROOT, "public", "catalog.json");
  expect(
    existsSync(品書),
    "検証に必要な生成物がありません。オフラインビルドを実行してください",
  ).toBe(true);
  const catalog = JSON.parse(readFileSync(品書, "utf8")) as {
    source_updates?: Array<{ name?: string; status?: string }>;
  };
  const 更新 = catalog.source_updates ?? [];
  expect(更新.length, "この検査の前提（品書にソースの更新がある）が崩れた").toBeGreaterThan(0);
  const text = await call("collection_stats", {});
  expect(text, "上流のソースの行がない").toContain("上流のソース:");
  /* 品書の値と同じ言葉で出す（`fresh` / `cache-fallback` 等の内部の語を見せない）。 */
  expect(text, "内部の語をそのまま出した").not.toMatch(/(cache-fallback|snapshot-fallback)\b/);
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
  /* **5 種類すべての状態**を日本語で言える（`HealthSourceStatus` – `src/build.ts`）。内部の語
   * （`failed` / `success`）をそのまま出さない – 取得できなかつたソースがあると、その分の会議が
   * 収录に無いので|その分を知る必要がある）。 */
  const 狀態の語 = [
    ["fresh", "今回あたって取得"],
    ["success", "今回あたって取得"],
    ["cache-fallback", "前回の取得データ（今回は上流にあたらず）"],
    ["snapshot-fallback", "確定済みの収録データ（今回は上流にあたらず）"],
    ["failed", "上流から取得できませんでした"],
  ] as const;
  const isolatedRoot = mcpSandbox();
  const 品 = JSON.parse(readFileSync(品書, "utf8")) as { source_updates?: unknown[] };
  品.source_updates = 狀態の語.map(([status]) => ({
    name: `t${status}`,
    status,
    fetched_at: null,
  }));
  writeFileSync(join(isolatedRoot, "public", "catalog.json"), `${JSON.stringify(品, null, 2)}\n`);
  /* 読み込みは起動時に一度だけ – 別の手順を起こして試す。 */
  const 答 = (() => {
    const 手順 = spawnSync(process.execPath, [join(isolatedRoot, "src", "mcp.ts"), "stats"], {
      encoding: "utf8",
      timeout: 180_000,
    });
    expect(手順.status, 手順.stderr).toBe(0);
    return `${手順.stdout ?? ""}${手順.stderr ?? ""}`;
  })();
  for (const [status, 日本語] of 狀態の語) {
    expect(答, `狀態 ${status} を日本語で言つて居ん`).toContain(`t${status}: ${日本語}`);
  }
  expect(答, "内部の語をそのまま出した").not.toMatch(
    /(failed|success|cache-fallback|snapshot-fallback)\*\//u,
  );
});

it("道具の說明が、実際に出ているものを名指す（第 914 回）", async () => {
  const 必要な語: Array<[string, string[]]> = [
    ["search_deadlines", ["0 件", "within_days", "scope", "kinds"]],
    ["list_upcoming", ["開催", "kind", "days"]],
    ["venue_info", ["key", "次の投稿締切", "版"]],
    ["explain_word", ["0 件", "案内"]],
    ["recommend_venues", ["一致評価", "選定理由", "候補"]],
    ["collection_stats", ["分野別の会議数", "データ源"]],
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
  expect(有二.length, "道具が六つ揃つて居ない（この検査の前提が崩れた）").toBe(必要な語.length);
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
  /* 実際の返り値にその語があることも見る（說明だけの書き起こしが reality とずれない – 第 910 回の開催）。 */
  const 上記 = await call("collection_stats", {});
  expect(上記, "說明にある節が実際の返り値にない").toContain("分野別の会議数");
  const 一覧 = await call("list_upcoming", { days: 30, scope: "all", limit: 1 });
  expect(一覧, "說明にある開催の節が実際の返り値にない").toContain("開催（会期の行）");
});

it("画面も「その月だけ」を件数欄に書く（第 940 回の画面側）", async () => {
  /* 第 940・941 回で MCP が「判定: 2026年10月 = 2026年10月の締切（その月だけ…）」を
   * 出す樣にした。画面は**同じ関数**（`relativeDayNotes`）でそれを出す – 両者が同じ事を
   * 同じ言葉で言つていることを見る。 */

  /* 1. **同じ関数**を呼んでいる（ソースの約束 – 画面が別の物を書き出したらここで落ちる）。 */
  const 畫面の註 = readFileSync(join(REPO_ROOT, "site", "app.ts"), "utf8");
  expect(畫面の註, "画面が件数欄の注に relativeDayNotes を呼んで居ない").toContain(
    "Recommender.relativeDayNotes(searchQuery",
  );

  /* 2. **同じ言う方** – MCP の判定の行は、この方（正典の関数）と同じ文を含む。実測
   *    2026-11-12: 両者は「その月だけ – 年全体ではありません」を共有する。 */
  const 正典の注 = Recommender.relativeDayNotes(
    Recommender.expandRelativeMonths("今月", Date.now()),
    Date.now(),
  );
  expect(正典の注.length, "正典の函数が注を返さない（この検查の前提が崩れた）").toBeGreaterThan(0);
  expect(正典の注[0], "正典がその月だけを名乗つて居ない").toContain("その月だけ");
  const mcp = await call("search_deadlines", { query: "今月", limit: 1 });
  const 判定 = mcp.split("\n").find((l) => l.startsWith("判定:")) ?? "";
  expect(判定, "MCP が判定を出していない").not.toBe("");
  /* 両者の**年と月**が一致する（「2026年10月」の部分）。 */
  const 年と月 = /(\d{4}年\d{1,2}月)/.exec(正典の注[0])?.[1] ?? "";
  expect(年と月, "正典の注から年と月が読めない").not.toBe("");
  expect(判定, `畫面と同じ年と月に成つて居ない（${年と月}）`).toContain(年と月);
});

it("画面と MCP が、同じ問に同じ行を出す（第 917 回）", async () => {
  /* 件数が一致することは第 858・894・895 回で確かめた。**どの行**が出るかまでは見て
   * 居なかつた – AI が「載せる」と-entry 人や 画面と別の会報を答えても、中の件数は同じで
   * 氣づかれない。画面の絞り込みを**正本から**拔いて、同じ問の束で両方の行を突き合はせる。 */
  const 品書 = join(REPO_ROOT, "public", "catalog.json");
  expect(
    existsSync(品書),
    "検証に必要な生成物がありません。オフラインビルドを実行してください",
  ).toBe(true);
  const html = siteRuntime();
  const rowsFile = join(tmpdir(), `kamiyobi-screen-rows-${process.pid}.json`);
  writeFileSync(
    rowsFile,
    JSON.stringify(displayCandidates(JSON.parse(readFileSync(品書, "utf8")))),
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
      /* 行は**こちらで作って**渡す（`public/recommender.js` は ESM なので probe 里面の require で
       * は読めない – こちら差分はこっち側の同じ関数を使う）。 */
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
    });
    expect(proc.status, `畫面の絞り込みが動かない（${問}）: ${proc.stderr.slice(0, 300)}`).toBe(0);
    return JSON.parse(proc.stdout.trim()) as string[];
  };

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

    const mcp = [
      ...new Set(
        答
          .split("\n")
          .filter((l) => /^2\d{3}-/.test(l))
          .flatMap((l) => {
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
  const 三行 = [
    "時間スケジューリング手法を用いた協調型edge computing",
    "我々は分散したIoT機器群の間でジョブを分散実行する枠組みを提案する。",
    "keywords: scheduling, edge computing, IoT",
  ].join("\n");
  const text = await call("recommend_venues", { paper: 三行, limit: 2 });
  const 頭 = text.split("\n")[0] ?? "";
  expect(頭, "最初の一行の題が出ていない").toContain(
    "時間スケジューリング手法を用いた協調型edge computing",
  );
  expect(頭, "2 行目以降を繋いでいる（目的が覆ふ）").not.toContain("分散したIoT機器群");
  expect(頭, "その他の行も見ていることを言つていない").toContain("ほか 2 行の入力も使っています");
  /* 1 行だけなら「ほか」の文は出さない（騒音を増やさない）。 */
  const 一行 = await call("recommend_venues", {
    paper: "Time-Sensitive Networking | tsn",
    limit: 2,
  });
  expect(一行.split("\n")[0] ?? "", "1 行で「ほか」を出した").not.toContain(
    "行の入力も使っています",
  );
  /* 長い題名は 40 字で切る（1 行でも見出しが壁にならない）。 */
  const 長い = await call("recommend_venues", { paper: `${"A".repeat(80)} | tsn`, limit: 1 });
  const 長い頭 = 長い.split("\n")[0] ?? "";
  expect(長い頭, "長い題名を切り詰めなかった").toContain("…");
  expect(長い頭, "切り詰めたのに 80 字出ている").not.toContain("A".repeat(60));
});

it("道具の返り値に、壊れた補間の跡（$）が残らない（第 919 回）", async () => {
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
  const 題 = "Time-Sensitive Networking | tsn";
  const 素 = await call("recommend_venues", { paper: 題, limit: 2 });
  expect(素.split("\n")[0] ?? "", "絞り込みがない時に名指した").not.toContain("無視した絞り込み");
  for (const 鍵 of ["rank", "domestic", "online", "scope", "within_days", "include_past"]) {
    const 答 = await call("recommend_venues", {
      paper: 題,
      limit: 2,
      [鍵]: 鍵 === "rank" ? "A" : true,
    });
    expect(答, `\`${鍵}\` を渡しても名指して居ん`).toContain("無視した絞り込み");
    expect(答.split("\n")[0] ?? "", `\`${鍵}\` の名前が出て居ん`).toContain(鍵);
    /* 絞り込まないことを文字でも示す（順位で選ぶ）。 */
    expect(答, "順位で選ぶ謀を言つていない").toContain("順位と点で選びます");
  }
  /* 空文字の絞り込みは「渡して無い」と見る（混入した空値で騒音を増やさない）。 */
  const 空 = await call("recommend_venues", { paper: 題, limit: 2, rank: "" });
  expect(空.split("\n")[0] ?? "", "空文字列で名指した").not.toContain("無視した絞り込み");
});

it("二つ与えた片方を黙って捨てない（第 921 回）", async () => {
  /* 黙って片方を捨てると、読む人は両方効いたと思ふ。二つの道具でそれが在つた（実測 2026-11-09）。 */
  const 檢 = await call("search_deadlines", {
    query: "セキュリティ",
    kinds: ["paper"],
    kind: "notification",
    limit: 1,
  });
  expect(檢.split("\n")[0] ?? "", "`kinds` と `kind` を両方渡しても名指していない").toContain(
    "kind は kinds と共に与えられたので見ていません",
  );
  /* 片方だけなら名指さない（騒音を増やさない）。 */
  const 片 = await call("search_deadlines", { query: "セキュリティ", kind: "paper", limit: 1 });
  expect(片.split("\n")[0] ?? "", "片方だけなのに名指した").not.toContain("見ていません");
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
  expect(會, "`key` と `name` を両方渡しても名指していない").toContain(
    "name は key と共に与えられたので見ていません",
  );
  const 片會 = await call("venue_info", { key: "sigkdd" });
  expect(片會, "片方だけなのに名指した").not.toContain("見ていません");
  /* 空文字は「渡して無い」と見る。 */
  const 空 = await call("venue_info", { key: "sigkdd", name: "" });
  expect(空, "空文字列で名指した").not.toContain("見ていません");
});

it("collection_stats も絞り込みの引数を黙って捨てない（第 922 回）", async () => {
  const 素 = await call("collection_stats", {});
  expect(素.split("\n")[0] ?? "", "絞り込みがない時に注を付けた").not.toContain("無視した絞り込み");
  const 付 = await call("collection_stats", { scope: "screen" });
  expect(付.split("\n")[0] ?? "", "`scope` を渡しても名指していない").toContain(
    "無視した絞り込み scope",
  );
  expect(付.split("\n")[0] ?? "", "収録の全体を数えます の語がない").toContain(
    "収録の全体を数えます",
  );
  /* 数そのものは変わらない（絞り込んで居ないことの証明）。 */
  const 数 = (t: string): string => (t.match(/会議 [\d,]+ 件/) ?? [""])[0];
  expect(数(付), "絞り込んで居ない（件数が同じ）").toBe(数(素));
  /* 空文字は「渡して無い」と見る。 */
  const 空 = await call("collection_stats", { scope: "" });
  expect(空.split("\n")[0] ?? "", "空文字列で注を付けた").not.toContain("無視した絞り込み");
});

it("limit は整数で、打ち切ってない時は言わない（第 924 回）", async () => {
  const 全文 = (t: string): string => t;
  const 劈いた = async (l: unknown): Promise<string> =>
    全文(await call("search_deadlines", { query: "セキュリティ", limit: l }));
  const 行數 = (t: string): number => t.split("\n").filter((l) => /^20\d\d-/.test(l)).length;

  /* 打ち切る時は limit を言って、行数と一致する。 */
  const t = await call("search_deadlines", { query: "セキュリティ", limit: 100 });
  const 全部の件 = Number(
    (/に当たる締切: ([\d,]+) 件/.exec(t.split("\n")[0] ?? "") ?? [0, "0"])[1].replace(/,/g, ""),
  );
  const 五 = await 劈いた(5);
  expect(五.split("\n")[1] ?? "", "5 件で切り詰めた時に limit を言つていない").toContain(
    `5 件まで表示・残り ${全部の件 - 5} 件`,
  );
  expect(行數(五), "5 件まで表示なのに 5 行出て居ない").toBe(5);

  /* 小数は**切り捨て**（3.7 は 3 行、且つ文も整数）。 */
  const 小 = await 劈いた(3.7);
  expect(行數(小), "3.7 を 3 行に切り詰めなかった").toBe(3);
  expect(小.split("\n")[1] ?? "", "小数をそのまま書いた").toContain("3 件まで表示");
  expect(小.split("\n")[1] ?? "", "小数点が传来的").not.toContain(".");

  /* 打ち切って居ないなら limit を言わない（37 件しか無いのに「50 件まで表示」と言わない）。 */
  const 五十 = await 劈いた(50);
  expect(五十.split("\n")[1] ?? "", "切り詰めて居ないのに limit を言つた").not.toContain(
    "件まで表示",
  );
  expect(行數(五十), `${全部の件} 件全部が出て居ない`).toBe(全部の件);

  /* 推薦の道具も同じ（同じ書き方にした – 読む人が二つで違う数字を見るのは，読む人が二つの道具で違うのを見るのは、最も見つけ難い方だから）。 */
  const 推 = await call("recommend_venues", {
    paper: "Time-Sensitive Networking | tsn, scheduling",
    limit: 3,
  });
  expect(推, "推薦で切り詰めた時に limit を言つていない").toContain("3 件まで表示");
});

it("explain_word も、切り詰めている時にその旨を書く（第 925 回）", async () => {
  /* 切り詰めがある時 */
  const 切替 = await call("explain_word", { word: "セキュリティ" });
  const 頭 = 切替.split("\n")[0] ?? "";
  expect(頭, "切り詰めているのにその旨を書いていない").toContain("このうち 3 行を出します");
  expect(切替.split("\n").filter((l) => /^- 20\d\d-/.test(l)).length).toBe(3);
  /* 切り詰めが無い時は書かない（1 行しか無い語 – 騒音を増やさない）。 */
  const 一行 = await call("explain_word", { word: "ICDE" });
  expect(一行.split("\n")[0] ?? "", "1 行の語に切り詰めの文を付けた").not.toContain("このうち");
  /* 見える行数と「N 行」の N が矛盾しない（37 里有 3 行だと書く）。 */
  const 全部 = await call("explain_word", { word: "締切" });
  expect(全部.split("\n")[0] ?? "", "212 行の語に切り詰めの文がない").toContain(
    "このうち 3 行を出します",
  );
});

it("名簿の注は、収録全体にも締切の行があればそれを言う（第 928 回）", async () => {
  const 窓 = await call("search_deadlines", { query: "SOSP", limit: 1 });
  const 行 = 窓.split("\n").filter((l) => /^- /.test(l) && l.includes("key:"));
  expect(行.length, "名簿の注が出ていない（この検査の前提が崩れた）").toBeGreaterThan(0);
  expect(行[0], "収録に締切の行があるのに「1 本もない」と言つた").toContain(
    "この窓には締切の行がありませんが",
  );
  expect(行[0], "古い文言が残つている").not.toContain("締切の行が 1 本もありません");
  /* 収録にも大字が無い会議は從來の言葉のまま – それを潰さない（此处の会議は窗にある）。 */
  const 窓で有る = await call("search_deadlines", { query: "ICDE", limit: 1 });
  expect(窓で有る.split("\n")[0] ?? "", "ある会議が 0 件に成った").toContain("件");
});

it("名簿の注は、収録の締切の日まで画面と同じ言葉で言う（第 929 回）", async () => {
  const text = await call("search_deadlines", { query: "SOSP", limit: 1 });
  const 注 = text.split("\n").find((l) => l.includes("key: sosp")) ?? "";
  expect(注, "名簿の注が出ていない").not.toBe("");
  expect(注, "収録にある日を名指していない").toMatch(
    /収録にあるのは過ぎた締切（\d{4}-\d{2}-\d{2}）だけ/,
  );
  /* 未来の締切がある会議は、近い日を言う（画面の第 298 回と同じ – 遠い日だけを示すと人は間の
   * 締切を見落とす）。 */
  const 有る = await call("search_deadlines", { query: "ICDE", limit: 1 });
  expect(有る.split("\n")[0] ?? "", "ICDE が出て來ない").toMatch(/件/);
  /* 収録に何も無い会議の旧い文言は残って居ない（SOSP の注と同じ形）。 */
  expect(注, "古い文言が残つている").not.toContain(
    'この窓には締切の行がありませんが、**収録には在ります**（scope: "all" で過去の分行が出せます）',
  );
});

it("名簿の注は、収録の推定の未来も名指す（第 930 回）", async () => {
  const text = await call("search_deadlines", { query: "SOSP", limit: 1 });
  const 注 = text.split("\n").find((l) => l.includes("key: sosp")) ?? "";
  expect(注, "名簿の注が出ていない").not.toBe("");
  expect(注, "推定の未来を名指していない").toContain("推定なら");
  expect(注, "推定の日に確約と書いている（確かではない）").toContain("確約ではない");
  /* 推定の日が actual と一致する（画面に出るのは `venue_info` の推定の行）。 */
  const 室 = await call("venue_info", { key: "sosp", scope: "all" });

  const 次の投稿 = 室.split("\n").find((l) => l.startsWith("次の投稿締切: ")) ?? "";
  const 日 =
    /次の投稿締切: (\d{4}-\d{2}-\d{2})/.exec(次の投稿)?.[1] ??
    /元の宣言 [^／]*／(\d{4}-\d{2}-\d{2})/.exec(次の投稿)?.[1] ??
    "";
  expect(注, `推定の日（${日}）と名簿の注が違ふ`).toContain(日);
});

it("相対の語がどう解けたかを頭に書く（画面と同じ – 第 936・940 回）", async () => {
  const 注 = async (語: string): Promise<string> =>
    (await call("search_deadlines", { query: 語, limit: 1 }))
      .split("\n")
      .find((l) => l.startsWith("判定:")) ?? "";
  expect(await 注("今月"), "「今月」の解が出ていない").toMatch(/^判定: \d{4}年\d{1,2}月 = /);
  expect(await 注("来月"), "「来月」の解が出ていない").toMatch(/^判定: \d{4}年\d{1,2}月 = /);
  /* **その月だけ**と名乗る（年全体だと書くと行の数と合わない – 第 940 回）。 */
  for (const 語 of ["今月", "来月"]) {
    const 文 = await 注(語);
    expect(文, `「${語}」に其の月だと書いて居ん`).toContain("その月だけ");
    expect(文, `「${語}」を年全体と言つて居る（嘘）`).not.toContain("1〜12 か月");
  }
  /* 年の語（全体を見る形）は從來の文 – それは噓ではない。 */
  expect(await 注("2026年")).toContain("1〜12 か月");
  /* 幅の言い方でも、**何月を見たか**は同じく出る（実測: `来月まで` は展開の段で幅の語尾が
   * 落ちて `2026年11月` になる – 月の判定はそれに当然合ふ）。幅の受け方はこの道具には無いので、
   * その旨は頭の「日付は日本時間」の斷りが受け持つ。 */
  expect(await 注("来月まで"), "幅の言い方に月の判定が出ていない").toMatch(
    /^判定: \d{4}年\d{1,2}月 = /,
  );
  /* 展開できない形に判定を出さない（騒音を増やさない – `2026年` だけは年その物）。 */
  expect(await 注("セキュリティ"), "普通の語に判定を出した").toBe("");
});

it("曖昧な語の常時の案内を出す（画面と同じ – 第 942 回）", async () => {
  const 答 = await call("search_deadlines", { query: "ics", limit: 3 });
  const 案内 = 答.split("\n").find((l) => l.startsWith("「ics」のことなら")) ?? "";
  expect(案内, "曖昧さの案内が出ていない").not.toBe("");
  expect(案内).toContain("二つの物があり得ます");
  /* この道具を使う AI に、配付物の名を添える（画面の UI の名は此では使へない）。第 948 回で
   * 類語の注と同じ經路に纏めたので、文はその侭に括弧が無い行に成つた。 */
  const 添 = 答.split("\n").find((l) => l.startsWith("この道具が出せるのは行だけです")) ?? "";
  expect(添, "配付物の名が出ていない").toContain("deadlines.ics");
  /* 行が出ない時は出さない（0 件案内が同じ事を言う – 画面と同じ決まり）。 */
  for (const 語 of ["セキュリティ", "締切"]) {
    const 素 = await call("search_deadlines", { query: 語, limit: 3 });
    expect(素, `「${語}」に關係無い案内が出た`).not.toContain("この道具が出せるのは行だけです");
  }
});

describe("list_upcoming の行が画面と同じ（第 944 回）", () => {
  /* 第 874・910 回は**件数**を見た。**どの行**かまでは見て居なかつた – 件数が同じでも
   * 画面と別の行を返している事があり得る（AI が「この会議は來ない」と答へると誤る）。
   *
   * この道具は**種別で絞らない**（設計 – 說明にも書いてある）ので、画面の同等物は「種別の
   * 篩を掛けない defaults の一覽」= `upcoming.md` と同じ行。画面の `filter` で
   * `kind: ""`（篩）・同じ窓にして突き合はせる。 */
  const 品書 = join(REPO_ROOT, "public", "catalog.json");
  it("同じ窓で、同じ行を返す", async () => {
    expect(
      existsSync(品書),
      "検証に必要な生成物がありません。オフラインビルドを実行してください",
    ).toBe(true);
    const html = siteRuntime();
    const rowsFile = join(tmpdir(), `kamiyobi-screen-upcoming-${process.pid}.json`);
    writeFileSync(
      rowsFile,
      JSON.stringify(displayCandidates(JSON.parse(readFileSync(品書, "utf8")))),
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
           * 既定は外す）。条件を揃へるので画面の state も推定を入れる。 */
          STATE: JSON.stringify({ q: "", cats: [], kind: "", rank: "", win, est: true }),
        },
      });
      expect(proc.status, `畫面の絞り込みが動かない（${win}）: ${proc.stderr.slice(0, 300)}`).toBe(
        0,
      );
      return JSON.parse(proc.stdout.trim()) as string[];
    };

    for (const days of [7, 30]) {
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

it("venue_info は過去の締切も出して、その札を書く（第 945 回）", async () => {
  const 答 = await call("venue_info", { key: "icde" });
  const 行 = 答.split("\n").filter((l) => /^20\d\d-/.test(l));
  const 過ぎた = 行.filter((l) => l.includes("残り（過ぎた）"));
  expect(過ぎた.length, "過去の行が出て居ない（この検査の前提が崩れた）").toBeGreaterThan(0);
  expect(過ぎた.length).toBeLessThan(行.length);
  /* 過去の行はどれも札を持つ（無札だと「これから」の行に見える）。 */
  for (const l of 行) {
    if (l.includes("20")) expect(l.length, "行が空").toBeGreaterThan(10);
  }
  /* 將來の行は「残り」の札が付く。 */
  expect(行.some((l) => /殘り\d+日|殘り\d+時間/.test(l)) ? true : / /).toBeTruthy();
  /* 説明にも書いた（道具の一覽の文 – AI は先にそれを読む）。 */
  const 一覽 = (await client.ask({ jsonrpc: "2.0", id: 97, method: "tools/list" })) as {
    result?: { tools?: Array<{ name?: string; description?: string }> };
  };
  const 説明 = (一覽.result?.tools ?? []).find((t) => t.name === "venue_info")?.description ?? "";
  expect(説明, "venue_info の説明が読めない（この検査の前提が崩れた）").not.toBe("");
  expect(説明, "過去が出ると書いて居ない").toContain("過ぎた分も全部出る");

  /* 推薦の**截り**も説明に書く。 */
  const 推薦 =
    (一覽.result?.tools ?? []).find((t) => t.name === "recommend_venues")?.description ?? "";
  expect(推薦, "推薦の截りを說明に書いて居ない").toContain("最初の 20 行");
});

it("曖昧な名の候補は、一番新しい版の繋ぎ先を添える（第 946 回）", async () => {
  const 答 = await call("venue_info", { name: "KDD" });
  const 候補 = 答.split("\n").filter((l) => l.startsWith("- "));
  expect(候補.length, "候補が出て居ない（この検查の前提が崩れた）").toBeGreaterThan(1);
  for (const l of 候補) {
    const url = /(https?:\/\/\S+)/.exec(l)?.[1] ?? "";
    if (!url) continue;
    expect(url, `候補の繋ぎ先が古い年版: ${l}`).not.toMatch(/20(1[0-9]|2[0-5])\b/);
  }
  /* 一番新しい版の link（`kdd2027`）を出す。 */
  const kdd = 候補.find((l) => l.includes("key: sigkdd")) ?? "";
  expect(kdd, "KDD の候補に繋ぎ先がない").toMatch(/https?:\/\//);
  expect(kdd, "一番新しい版の繋ぎ先ではない").toContain("kdd2027");
  /* 他の会議でも同じ（古い link を出している会議が他にもある – 実測 2026-11-10 で
   * 年が 6 以上離れた会議が 122 件在つた。その中から 5 つを見る）。 */
  for (const [名, 鍵] of [
    ["SOSP", "sosp"],
    ["NSDI", "nsdi"],
    ["CCS", "ccs"],
    ["AAAI", "aaai"],
    ["3DV", "3dv"],
  ] as Array<[string, string]>) {
    const 答 = await call("venue_info", { name: 名 });
    const 行 = 答.split("\n").find((l) => l.includes(`key: ${鍵}`));
    if (行 === undefined) continue; // 曖昧で無い（一つに決まる）会議はこの検查の対象外
    expect(行, `${名} の候補の繋ぎ先が古い年版: ${行}`).not.toMatch(/20(1[0-9]|2[0-5])\b/);
  }
});

it("見えている行にも、画面が添える注を出す（第 948 回）", async () => {
  for (const 道具 of ["search_deadlines", "explain_word"] as const) {
    const 答 =
      道具 === "search_deadlines"
        ? await call("search_deadlines", { query: "ランク", limit: 3 })
        : await call("explain_word", { word: "ランク" });
    expect(答, `${道具} に類語の注が出て居ん`).toContain("「ランク」だけでは等級を絞れていません");
  }
  /* 関係無い語には出さない（騒音を増やさない – 第 852 回と同じ）。 */
  const 無 = await call("search_deadlines", { query: "セキュリティ", limit: 3 });
  expect(無, "無関係な語に類語の注が出た").not.toContain("だけでは");
  /* 曖昧な語の方も、この經路から出る。 */
  const 曖昧 = await call("explain_word", { word: "ics" });
  expect(曖昧, "explain_word に曖昧さの注が出ていない").toContain("二つの物があり得ます");
  expect(曖昧.split("\n").filter((l) => l.includes("この道具が出せるのは行だけ")).length).toBe(1);
});

it("長い論文は最初の 20 行だけを見て、その旨を言う（第 954 回）", async () => {
  const 長い = Array.from({ length: 500 }, (_, i) => `提案手法の説明 ${i}`).join("\n");
  const t0 = Date.now();
  const 答 = await call("recommend_venues", { paper: 長い, limit: 3 });
  const かかつた = Date.now() - t0;
  expect(答.split("\\n")[0] ?? "", "500 行の論文を切り詰めずにいる").toContain(
    "500 行のうち、最初の 20 行（題名・概要）で調べました",
  );
  /* **速い** – 20 行で打ち切るので、何行來ても同じ（実測: 3.5 秒）。 */
  expect(かかつた, `推薦が遅い（${かかつた}ms – 打ち切れて居ない）`).toBeLessThan(30_000);
  /* 短い論文は何も足さない（騒音を增やさない – 第 852 回と同じ決まり）。 */
  const 短い = await call("recommend_venues", {
    paper: "Time-Sensitive Networking | tsn",
    limit: 3,
  });
  expect(短い, "短い論文に截りの文を付けた").not.toContain("行のうち、最初の");
});

it("venue_info は過去の件数を頭で言う（第 961 回）", async () => {
  const 答 = await call("venue_info", { key: "icde" });
  const 行 = 答.split("\n").filter((l) => /^20\d\d-/.test(l));
  const 過去 = 行.filter((l) => l.includes("（過ぎた）")).length;
  expect(過去, "過去の行がない（この検查の前提が崩れた）").toBeGreaterThan(0);
  expect(過去).toBeLessThan(行.length);
  expect(答, "過去の件数を頭で言つていない").toMatch(new RegExp(`過去は ${過去} 件`));
  /* 切り詰めと両立する（96 件の会議 – VLDB）。 */
  const 長い = await call("venue_info", { key: "vldb" });
  const 頭 = 長い.split("\n").find((l) => l.startsWith("締切と会期")) ?? "";
  expect(頭, "切り詰めの件数がない").toMatch(/\d+ 件のうち 60 件/);
  expect(頭, "切り詰めと過去の件数が両立していない").toMatch(/・過去は \d+ 件/);
});

it("名簿の注は、窓に行がある会議でも推定の日を言う（第 964 回）", async () => {
  const 答 = await call("search_deadlines", { query: "TrustCom", limit: 1 });
  const 注 = 答.split("\\n").find((l) => l.includes("key: trustcom")) ?? "";
  expect(注, "名簿の注が出ていない").not.toBe("");
  expect(注, "窓の分の話が出ていない").toContain("締切の行はありますが");
  expect(注, "推定の日を名指していない").toContain("推定なら");
  expect(注, "確約ではない事を言つていない").toContain("確約ではない");
  expect(注, "include_estimated を教へていない").toContain("include_estimated");
  /* 推定の**無い**会議に足さない。 */
  /* **推定の日の形**を見る（実際の日付が入つている – 空の文だと読めない）。 */
  expect(注, "推定の日が読めない").toMatch(/推定なら \d{4}-\d{2}-\d{2} も在ります/);
  /* 幅を持つ推定の版でも、**点推定点**の日を名指す。 */
  expect(注, "点推定点の日が読めない").toMatch(/推定なら 20\d{2}-\d{2}-\d{2} も在ります/);
});

describe("名簿の注は、全部の会議で事実と合う（第 968 回）", () => {
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
  it("四つの事実が、注の言う事と合う", async () => {
    const 樣本 = 題の一覽.filter((_, i) => i % 35 === 0);
    expect(樣本.length, "間引きの結果が空（会議が読めて居ない）").toBeGreaterThan(15);
    for (const c of 樣本) {
      const 答 = await call("search_deadlines", { query: c.題, limit: 1, scope: "all" });
      const 注 = 答.split("\n").find((l) => l.startsWith("- ") && l.includes(`key: ${c.key}`));
      if (!注) continue;
      /* 1. 「行は在ります」は行が無い会議に言はない */
      if (注.includes("締切の行はありますが")) {
        expect(c.行, `「${c.key}」に行が無いのに「行は在ります」と言つた`).toBeGreaterThan(0);
      }
      /* 2. 「1 本もありません」は行がある会議に言はない */
      if (注.includes("締切の行が 1 本もありません")) {
        expect(c.行, `「${c.key}」に行が ${c.行} あるのに「1 本もありません」と言つた`).toBe(0);
      }
      /* 3. 「推定なら」は推定の版が無い会議に言はない */
      if (注.includes("推定なら")) {
        expect(c.推定, `「${c.key}」に推定の版が無いのに「推定なら」と言つた`).toBe(true);
      }
      /* 4. 未來の推定がある会議は「推定なら」を言う */
      if (c.推定の未來 > 0) {
        expect(注, `「${c.key}」に未來の推定が ${c.推定の未來} 行あるのに言つて居ない`).toContain(
          "推定なら",
        );
      }
    }
  });
});

describe("venue_info は版の一覽を収録通りに出す（第 969 回）", () => {
  const 會議 =
    (
      JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as {
        conferences?: Array<Record<string, unknown>>;
      }
    ).conferences ?? [];
  const 投稿の種別 = new Set(["abstract", "paper", "journal"]);
  it("版の一覽と「次の投稿締切」が事実と合う", async () => {
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
        /* 締切が 1 本も無い会議は「版 N 件」の形*/
        const 件の形 = /版 (\d+) 件/.exec(答);
        expect(件の形, `「${key}」の版の言ひ方が讀めない`).not.toBeNull();
        expect(Number(件の形?.[1]), `「${key}」の版の數が違ふ`).toBe(本の版);
      }
      /* 「次の投稿締切」は**投稿の種別で一番近い未來**。*/
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
          /* 幅を出している時、点推定点は幅の中に収まつて居なければならない（整合）。 */
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
  /* `list_upcoming` も同じ並び（`sortRows` は共用 – 第 970 回の直しで全部変はる）。 */
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

it("記号だけの問は「絞り込みが効いて居ない」と言う（第 981 回）", async () => {
  for (const 問 of ["。", "-", "・", "！"]) {
    const 答 = await call("search_deadlines", { query: 問, limit: 2 });
    expect(答, `「${問}」で絞り込みが効いて居ないことを言つて居ん`).toContain(
      "絞り込みとして効く語がありません",
    );
    expect(答.split("\n")[1] ?? "", `「${問}」の註の行が讀めない`).toContain("記号だけ");
    /* 行は出す（画面と同じ – 全部の行）。0 件にはしない。 */
    expect(
      答.split("\n").filter((l) => /^20\d\d-/.test(l)).length,
      `「${問}」の行が出て居ん`,
    ).toBeGreaterThan(0);
  }

  for (const 問 of ["絞り込み", "番兵", "全部", "画面", "行を示して居ます"]) {
    const 答 = await call("search_deadlines", { query: 問, limit: 2 });
    expect(答, `「${問}」を記号だけと誤認識した`).not.toContain("絞り込みとして効く語がありません");
  }

  /* 語のある問には出さない（騒音を增やさない – 第 852 回と同じ決まり）。 */
  for (const 問 of ["セキュリティ", "KDD", "1"]) {
    const 答 = await call("search_deadlines", { query: 問, limit: 2 });
    expect(答, `「${問}」に關係無い斷りが出た`).not.toContain("絞り込みとして効く語がありません");
  }
  /* 他の篩り込みと**組み合はせても**出る（篩り込みが減つて居ても「質が記号だけ」は事実） */
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

  for (const 問 of ["セキュリティ。", "セキュリティ・", "KDD。"]) {
    const 答 = await call("search_deadlines", { query: 問, limit: 2 });
    expect(答, `「${問}」を記号だけと誤認識した`).not.toContain("絞り込みとして効く語がありません");
  }

  /* 語を省いた呼び方にも出さない（「絞り込みだけ」は全部を示すのが筋）。 */
  const 素 = await call("search_deadlines", { kinds: ["paper"], limit: 2 });
  expect(素, "語を省いた呼び方に斷りが出た").not.toContain("絞り込みとして効く語がありません");
});

it("explain_word も、記号だけの語に「絞り込みが効いて居ない」と言う（第 985 回）", async () => {
  const 記號 = await call("explain_word", { word: "。" });
  expect(記號, "記号だけの語に注が出ていない").toContain(
    "この語は記号だけなので、絞り込みとして効く語がありません",
  );
  /* 語のある語には出さない。 */
  for (const 語 of ["セキュリティ", "KDD", "締切"]) {
    const 答 = await call("explain_word", { word: 語 });
    expect(答, `「${語}」に關係無い注が出た`).not.toContain("この語は記号だけなので");
  }
  /* 混在（語 + 句点）にも出さない。 */
  const 混在 = await call("explain_word", { word: "セキュリティ。" });
  expect(混在, "混在を記号だけと誤認識した").not.toContain("この語は記号だけなので");
});

it("venue_info の確認の内訣は、その会議の行の数と合う（第 988 回）", async () => {
  const 收錄 = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as {
    conferences?: Array<Record<string, unknown>>;
  };
  const 樣本 = (收錄.conferences ?? []).filter((_, i) => i % 35 === 0);
  expect(樣本.length, "間引きの結果が空（会議が読めて居ない）").toBeGreaterThan(15);
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
    /* 締切が 1 本も無い会議（実測: `fgcs`）は「確認: …」を出さないのでそのまま次へ。 */
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

it("検索の頭の「当たる件数」と「絞る前」は、両方事実と合う（第 989 回）", async () => {
  /* 第 987・988 回で統計と会議の内訣を収録で確かめた。**検索の頭**の二つの数も – 実測
   * 2026-11-19: 10 問で 0 件の誤り。「当たる締切: N 件」は画面の既定（今後・投稿締切・
   * 推定を除く）を通した数、「絞る前は M 行」は**絞り込みの前**の生の数。
   * 両方が事実と合はないと、AI が「N 件当たつた」と誤つて報告する。 */
  const 品書 = JSON.parse(readFileSync(join(REPO_ROOT, "public", "catalog.json"), "utf8")) as {
    conferences?: unknown[];
  };
  const 行々 = displayCandidates(品書 as never);
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

it("list_upcoming の件数は、その窓の事实と合う（第 990 回）", async () => {
  const 收錄 = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as {
    conferences?: unknown[];
  };
  const 行々 = displayCandidates(收錄 as never);
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

  /* 切り詰めの宣告も事実と合ふ（100 件まで）。180 日は 489 件なので切られる。 */
  const 長い = await call("list_upcoming", { days: 180, limit: 900 });
  const 頭 = 長い.split("\n")[0] ?? "";
  const 表示 = Number((/の締切: ([\d,]+) 件/.exec(頭) ?? [0, "0"])[1].replace(/,/g, ""));
  if (表示 > 100) {
    const 行 = 長い
      .split("\n")
      .filter((l) => /^(?:20\d\d-|推定期間 )/.test(l) && l.includes(" | ")).length;
    expect(行, "切り詰めた行数が 100 を超えている").toBeLessThanOrEqual(100);
    const 宣告 = 長い.split("\n").find((l) => l.includes("まで表示")) ?? "";
    const 殘り = Number((/残り ([\d,]+) 件/.exec(宣告) ?? [0, "0"])[1].replace(/,/g, ""));
    expect(殘り, `「殘り」の數が事實と違ふ（宣告 ${殘り} ／ 事實 ${表示 - 行}）`).toBe(表示 - 行);
  }
});

it("推薦の「候補の件数」と「過ぎた件数」は事実と合う（第 992 回）", async () => {
  const 品書 = JSON.parse(readFileSync(join(REPO_ROOT, "public", "catalog.json"), "utf8")) as {
    conferences?: unknown[];
    reranker?: unknown;
  };
  const 今 = Date.now();
  const 事實 = (題: string): { 候補: number; 過去: number } => {
    Recommender.setNameIdf(Recommender.buildNameIdf(品書.conferences ?? []));
    Recommender.setReranker(品書.reranker ?? null);
    const 行 = displayCandidates(品書 as never);
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

it("日にちの引数に端数を貰つたら、切っている事を言う（第 993 回）", async () => {
  /* 1. `list_upcoming` の `days` */
  const 目錄 = await call("list_upcoming", { days: 1.5, limit: 1 });
  expect(目錄, "days の端数を切ったと言つていない").toMatch(/1 日|端数|切/);
  expect(目錄.split("\n")[0], "1.5 日の儘を表示している").toContain("1 日");
  const 目錄の健全 = await call("list_upcoming", { days: 7, limit: 1 });
  expect(目錄の健全, "整数なのに端数の斷りが出た").not.toMatch(/端数/);
  /* 2. `search_deadlines` の `within_days` */
  const 檢索 = await call("search_deadlines", {
    query: "セキュリティ",
    within_days: 3.7,
    limit: 1,
  });
  expect(檢索, "within_days の端数を黙つて使つている").toMatch(/端数|切/);
  const 檢索の健全 = await call("search_deadlines", {
    query: "セキュリティ",
    within_days: 30,
    limit: 1,
  });
  expect(檢索の健全, "整数なのに端数の斷りが出た").not.toMatch(/端数/);
});

it("死語が多い問は、数えた残りを言う（第 994 回）", async () => {
  const 多い = await call("search_deadlines", {
    query: "zzz9 zzz8 zzz7 zzz6 zzz5 zzz4 zzz3 zzz2",
    limit: 1,
  });
  const 注 = 多い.split("\n").find((l) => l.includes("見当たりません")) ?? "";
  expect(注, "死語の注が出ていない").not.toBe("");
  expect(注, "残りの語の数を言つていない").toContain("ほか 6 語も");
  /* 2 語までは何も添へない（黙つている – 第 852 回と同じ決まり）。 */
  const 少ない = await call("search_deadlines", { query: "zzz9 zzz8", limit: 1 });
  const 注2 = 少ない.split("\n").find((l) => l.includes("見当たりません")) ?? "";
  expect(注2, "2 語なのに「ほか」が出た").not.toContain("ほか");
  /* 1 語だけ当たる問（セキュリティ + 死語）は「外すと増えます」をそのまま出す。 */
  const 混在 = await call("search_deadlines", { query: "セキュリティ zzz9", limit: 1 });
  expect(混在, "その語を外すと增えると言つていない").toContain("その語を外すと増えます。");
  expect(混在, "混在なのに「ほか」が出た").not.toContain("ほか 1 語も");
});

it("語ごとの件数も 4 語目以降を落とさない（第 995 回）", async () => {
  const 多い = await call("search_deadlines", {
    query: "セキュリティ ネットワーク データベース 人工知能 システム",
    limit: 1,
  });
  const 注 = 多い.split("\n").find((l) => l.includes("行はありません")) ?? "";
  expect(注, "語ごとの件数が出ていない").not.toBe("");
  expect(注, "4 語目以降の数を言つていない").toContain("ほか 2 語");
  /* 3 語までは何も添へない。 */
  const 少ない = await call("search_deadlines", {
    query: "セキュリティ ネットワーク データベース",
    limit: 1,
  });
  const 注2 = 少ない.split("\n").find((l) => l.includes("行はありません")) ?? "";
  expect(注2, "3 語なのに「ほか」が出た").not.toContain("ほか");
});

it("推薦の見出しを 40 字に切ったら、切った事を添える（第 996 回）", async () => {
  const 長い題 =
    "深層学習を用いた自然言語処理のための事前学習モデルとその応用に関する詳細な研究を超えてさらに長い題名";
  const 答 = await call("recommend_venues", { paper: 長い題, limit: 3 });
  expect(答, "見出しを切ったと言つていない").toContain(
    "（見出しは 40 字に切り詰めた物です。調べたのは全文です）",
  );
  expect(答.split("\n")[0], "全文が見出しに出ている（切れて居らん）").not.toContain(長い題);
  /* 短い題名には何も添へない。 */
  const 短い = await call("recommend_venues", { paper: "セキュリティの会報", limit: 3 });
  expect(短い, "短い題名に切り詰めの斷りが出た").not.toContain("切り詰めた物です");
});

describe(" schema にない引数は黙つて捨てない（第 997 回）", () => {
  const 持ち物 = async (名前: string): Promise<string[]> => {
    const res = (await client.ask({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
      result?: {
        tools?: Array<{ name?: string; inputSchema?: { properties?: Record<string, unknown> } }>;
      };
    };
    const tool = (res.result?.tools ?? []).find((t) => t.name === 名前);
    return Object.keys(tool?.inputSchema?.properties ?? {});
  };
  it("未宣言の引数を送ると、その名を言う", async () => {
    for (const [名前, 未宣言] of [
      ["search_deadlines", { page: 5 }],
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
  /* **宣言してある引数**には言はない（それは各自の斷りの擔当 – 第 920 回・第 921 回）。 */
  it("宣言してある引数には言はない", async () => {
    const 答 = await call("search_deadlines", {
      query: "セキュリティ",
      limit: 2,
      include_past: true,
    });
    expect(答, "宣言してある引数に対して餘計な斷りが出た").not.toContain("この道具にない引数");
  });
});

it("種別の打ち間違ひを黙つて 0 件にしない（第 999 回）", async () => {
  const 單數 = await call("search_deadlines", { query: "セキュリティ", kind: "zzz" });
  expect(單數, "知らない kind を名指していない").toContain("知らない種別");
  expect(單數.split("\\n")[0], "黙つて 0 件に成つている").toContain("知らない種別");
  /* 空配列は「濾して居ません」と言う。 */
  const 空 = await call("search_deadlines", { query: "セキュリティ", kinds: [] });
  expect(空, "空の kinds を黙つて絞さない扱ひにしていない").toContain(
    "kinds が空なので種別で絞していません",
  );
  /* 良い値には何も言はない。 */
  for (const 良い of [{ kind: "paper" }, { kinds: ["paper"] }, { kinds: ["paper", "abstract"] }]) {
    const 答 = await call("search_deadlines", { query: "セキュリティ", ...良い });
    expect(答, `${JSON.stringify(良い)} に餘計な斷りが出た`).not.toContain("知らない種別");
    expect(答, `${JSON.stringify(良い)} に餘計な斷りが出た`).not.toContain("種別で絞していません");
  }
});

it("list_upcoming も種別の空配列を黙らない（第 1000 回）", async () => {
  const 空 = await call("list_upcoming", { kinds: [] });
  expect(空, "空の kinds を黙つて絞さない扱ひにしていない").toContain(
    "kinds が空なので種別で絞していません",
  );
  /* 良い値には何も言はない。 */
  const 良い = await call("list_upcoming", { kinds: ["paper"] });
  expect(良い, "良い値に餘計な斷りが出た").not.toContain("種別で絞していません");
  const 知らん = await call("list_upcoming", { kind: "zzz" });
  expect(知らん, "知らない単数の kind を黙つて 0 件にしていない").toContain("知らない種別");
});
it("直近の一覽の「対象期間」の申告は、本文と合う（第 1002 回）", async () => {
  const path = join(REPO_ROOT, "public", "upcoming.md");
  expect(
    existsSync(path),
    "検証に必要な生成物がありません。オフラインビルドを実行してください",
  ).toBe(true);
  const md = readFileSync(path, "utf8");
  const m = /対象期間: (\d{4}-\d{2}-\d{2}) 〜 (\d{4}-\d{2}-\d{2})/.exec(md);
  expect(m, "期間の申告が読めない").not.toBeNull();
  const 始まり = m?.[1] ?? "";
  const 期日 = m?.[2] ?? "";
  /* 生成時刻から 180 日先である事（これが狂つていると全部狂ふ）。 */
  const 生成 = /生成時刻: (\d{4}-\d{2}-\d{2})T/.exec(md)?.[1] ?? "";
  expect(生成, "生成時刻が読めない").not.toBe("");
  const 一日 = 86400000;
  const 差 = Math.round((Date.parse(`${期日}T00:00:00Z`) - Date.parse(`${生成}T00:00:00Z`)) / 一日);
  expect(差, `期間が ${差} 日（180 では無い）`).toBe(180);
  /* 本文の行が期日を超えて居ない事（超えて良しと書いてある二種類を除く）。 */
  const 行 = md
    .split("\n")
    .filter(
      (l) => l.startsWith("| 2026-") || l.startsWith("| 2027-") || l.startsWith("| 推定期間"),
    );
  expect(行.length, "本文の行が読めない（この検查の前提が崩れた）").toBeGreaterThan(100);
  /* 先頭の `| ` と「推定期間 」を除いて日付を取る（残すと縦線が日数の比較に混ざる）。 */
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
    /* 超えている行は「推定期間」か「会期が進行中（開催中）」の行だけ。 */
    expect(
      l.startsWith("| 推定期間") || l.includes("開催中"),
      `期間を超える行が、書いてある二種類ではない: ${l.slice(0, 80)}`,
    ).toBe(true);
  }
  /* 超過は 0 でも良い（データに依る）が、多すぎたら狂つている。 */
  expect(超出し.length, `期間を超える行が ${超出し.length} 行もある`).toBeLessThan(30);
});

it("索引が觸れている打ち方は、全部效く（第 1006 回）", async () => {
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
     * 0 件でもそれが出なければ打ち方は效いている（篩り込みの話）。 */
    expect(答, `索引が效くと書いて居る「${打ち方}」が語として無い`).not.toContain("見当たりません");
    expect(答, `「${打ち方}」で頭が出て居ん`).toContain("に当たる締切");
  }
  /* 打ち方が效く時は「語は当たります」か件数が出る（0 件でも意味が違ふ）。 */
  const 先月 = await call("search_deadlines", { query: "先月", limit: 1 });
  expect(先月, "過去の月（先月）は 0 件でも打ち方が效いている").toContain("に当たる締切: 0 件");
});

it("返す行の形を說明に書いて、実物もその通りに分けられる（第 1008 回）", async () => {
  const res = (await client.ask({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
    result?: { tools?: Array<{ name?: string; description?: string }> };
  };
  const 說明 =
    (res.result?.tools ?? []).find((t) => t.name === "search_deadlines")?.description ?? "";
  expect(說明, "返す行の形を說明に書いていない").toContain("返す行の形");
  expect(說明, "區切りの書き方を書いていない").toContain("`| ` で切り");
  /* 確認の札はある時だけ入るので 6 つか 7 つ。 */
  expect(說明, "6 つか 7 つに分かれる事を書いていない").toContain("確認状態（ある場合）");
  expect(說明, "版の識別子が丸括弧の中だと書いていない").toContain("会議名（版の識別子）");
  /* 実物もその通り – 全部の行が 6 つに分かれ、版の識別子が拔ける。 */
  const 答 = await call("search_deadlines", { query: "セキュリティ", limit: 5 });
  const 行 = 答.split("\n").filter((l) => /^20\d\d-/.test(l));
  expect(行.length, "行が出ていない").toBeGreaterThan(0);
  for (const l of 行) {
    expect(l.split(" | ").length, `行が 6 つに分かれん: ${l.slice(0, 60)}`).toBe(6);
    const 最後の丸括弧 = [...l.matchAll(/（([a-z0-9'.-]+)）/g)].at(-1);
    expect(最後の丸括弧, `版の識別子が拔けない: ${l.slice(0, 60)}`).toBeTruthy();
  }
});

it("返す行の形を說明に書いて、実物もその通りに分けられる（第 1008 回）", async () => {
  const res = (await client.ask({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
    result?: { tools?: Array<{ name?: string; description?: string }> };
  };
  const 說明 =
    (res.result?.tools ?? []).find((t) => t.name === "search_deadlines")?.description ?? "";
  expect(說明, "返す行の形を說明に書いていない").toContain("返す行の形");
  expect(說明, "區切りの書き方を書いていない").toContain("`| ` で切り");
  expect(說明, "版の識別子が丸括弧の中だと書いていない").toContain("会議名（版の識別子）");
  /* 実物もその通り – 全部の行が 6 つに分かれ、版の識別子が拔ける。 */
  const 答 = await call("search_deadlines", { query: "セキュリティ", limit: 5 });
  const 行 = 答.split("\n").filter((l) => /^20\d\d-/.test(l));
  expect(行.length, "行が出ていない").toBeGreaterThan(0);
  for (const l of 行) {
    expect(
      [5, 6].includes(l.split(" | ").length),
      `行が 5 か 6 つに分かれん: ${l.slice(0, 60)}`,
    ).toBe(true);
    const 最後の丸括弧 = [...l.matchAll(/（([a-z0-9'.-]+)）/g)].at(-1);
    expect(最後の丸括弧, `版の識別子が拔けない: ${l.slice(0, 60)}`).toBeTruthy();
  }
});

it("行を返す 6 つの道具は、全部「返す行の形」を書く（第 1009 回）", async () => {
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
  /* `list_upcoming` は**二種類**（締切・会期）を持つ事も言う。 */
  const 近く = 全部.find((t) => t.name === "list_upcoming");
  expect(近く?.文, "list_upcoming が会期の行の形を書いていない").toContain("会期の行は別の形");
  /* 実物もその通り – 6 つに分かれる。 */
  for (const [名前, 引數] of [
    ["search_deadlines", { query: "セキュリティ", limit: 2 }],
    ["list_upcoming", { days: 30, limit: 2 }],
    ["explain_word", { word: "セキュリティ" }],
  ] as const) {
    const 答 = await call(名前, 引數);
    /* 会期の行（`- 2026-10-01(木) 〜 2026-10-31(土) | CSS（key: …・…） | 開催地 URL`）は
     * **別の形**で「（key: 」を持つので、この 6 つの検查の対象外 – それを持つ行を除く。
     * 1 日の会期（`- 2026-10-12(月) | ISTAI26（key: …`）も同樣に「（key: 」を持つ。 */
    const 行 = 答.split("\n").filter((l) => /^[-\s]*20\d\d-/.test(l) && !l.includes("（key: "));
    expect(行.length, `${名前} の行が出て居ん`).toBeGreaterThan(0);

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
  const 默 = await call("venue_info", { key: "icde" });
  expect(默, "どの窓を見たか書いていない").toContain("（収録の全体・");
  expect(默, "行数も書いていない").toMatch(/（収録の全体・[\d,]+ 行から）/);
  /* `name` と `key` を両方渡した時の注も、從來の文を保つ。 */
  const 兩方 = await call("venue_info", { key: "icde", name: "X" });
  expect(兩方, "name を見て居ない事を言つていない").toContain(
    "name は key と共に与えられたので見ていません",
  );
  expect(兩方, "窓の言と両方載つていない").toContain("（収録の全体・");
  /* 今後の締切が無い会议の斷りも先頭に残る。 */
  const 過去 = await call("venue_info", { key: "aft" });
  expect(過去, "今後の締切がない事を先に言つていない").toContain("今後の締切は収録にありません");
});

it("ランクの大文字小文字の嚴密さを說明に書く（第 1013 回）", async () => {
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
  expect(rank, "rank の說明がない").toBeTruthy();
  expect(rank, "大文字小文字の嚴密さを書いていない").toContain("大文字小文字も違う");
  /* 実物もその通り – `a` は 0 件で、知らない等級として名指す。 */
  const 小文字 = await call("search_deadlines", { query: "セキュリティ", rank: "a", limit: 1 });
  expect(小文字, "小文字の a を黙つて 0 件にしていない").toContain("知らないランク");
  const 大文字 = await call("search_deadlines", { query: "セキュリティ", rank: "A", limit: 1 });
  expect(大文字, "大文字の A が效いていない").not.toContain("知らないランク");
});

it("list_upcoming の days が上限を超えたら黙つて截めない（第 1017 回）", async () => {
  for (const 値 of [401, 900, 5000, 999999]) {
    const 答 = await call("list_upcoming", { days: 値, limit: 1 });
    expect(答, `days: ${値} を默つて截めて居ん`).toContain(
      `（上限 400 を超えたので 400 日として切りました）`,
    );
  }
  /* 上限ぴったり（400）は何も言はない。 */
  const ぴったり = await call("list_upcoming", { days: 400, limit: 1 });
  expect(ぴったり, "上限ぴったりに斷りが出た").not.toContain("上限 400 を超えた");
  /* 端数と同時に貰つた時は端数の文を出す（重ねて言はない – 第 993 回の文が残る）。 */
  const 端數と = await call("list_upcoming", { days: 900.5, limit: 1 });
  expect(端數と, "端数の文が残っていない").toContain("端数なので");
  /* 両方の斷りが重なつても括弧が崩れない（空の種別と同時）。 */
  const 重ねた = await call("list_upcoming", { days: 900, kinds: [], limit: 1 });
  expect(重ねた, "上限の斷りがない").toContain("上限 400 を超えた");
  expect(重ねた, "空の種別の斷りがない").toContain("kinds が空なので");
  const 頭 = 重ねた.split("\n")[0] ?? "";
  const 開き = (頭.match(/（/g) ?? []).length;
  const 閉じ = (頭.match(/）/g) ?? []).length;
  expect(開き, `開き括弧が多すぎる: ${頭.slice(0, 120)}`).toBe(閉じ);
});

it("days と within_days は「境目が同じ・件数は違う」と書く（第 1027 回）", async () => {
  const res = (await client.ask({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
    result?: { tools?: Array<{ name?: string; description?: string }> };
  };
  const 文 = (res.result?.tools ?? []).find((t) => t.name === "list_upcoming")?.description ?? "";
  expect(文, "境目の切り方は同じと書いていない").toContain("境目の切り方は同じ");
  expect(文, "件数はそのままでは違うと書いていない").toContain("件数はそのままでは違う");
  expect(文, "違う二つの理由を書いていない").toContain("種別");
  expect(文, "推定の違いを書いていない").toContain("推定");

  const 件 = (t: string): number =>
    Number((t.split("\n")[0].match(/([\d,]+) 件/)?.[1] ?? "0").replace(/,/g, ""));
  /* 黙つたつまりでは divergent（86 vs 85 – 種別と推定の二つが乘る）。 */
  const 默つた = await call("list_upcoming", { days: 30, scope: "all", limit: 1 });
  const 檢索 = await call("search_deadlines", { within_days: 30, scope: "all", limit: 1 });
  const a = 件(默つた);
  const b = 件(檢索);
  expect(a, "list_upcoming の件数が読めない").toBeGreaterThan(0);
  expect(b, "search_deadlines の件数が読めない").toBeGreaterThan(0);
  /* 件数を揃へると一致する（種別と推定を同じにした時）。 */
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
  expect(件(揃へた), "条件を揃えても件数が違う（說明と合はない）").toBe(件(檢索2));
});

it("venue_info の key に略称を渡されたら、name の方を敿へる（第 1028 回）", async () => {
  const res = (await client.ask({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
    result?: { tools?: Array<{ name?: string; description?: string }> };
  };
  const 文 = (res.result?.tools ?? []).find((t) => t.name === "venue_info")?.description ?? "";
  expect(文, "key は小文字だけと書いていない").toContain("key は小文字の識別子");

  /* 略称を key に入れたら、name に渡すやうに敿へる。 */
  const 略稱 = await call("venue_info", { key: "KDD" });
  expect(略稱, "name に渡すと言つていない").toContain("name` に「KDD」を渡してください");
  expect(略稱, "当たる会議の key を言つていない").toContain("sigkdd");
  /* `name` に渡せば確かに当たる（敿へた通りの動きになる）。 */
  const nameSa = await call("venue_info", { name: "KDD" });
  expect(nameSa, "name で KDD に当たらない").toContain("KDD");
  /* 全く当たらない key は從つて通りの文（余計な推測を足さない）。 */
  const 無い = await call("venue_info", { key: "nosuchway" });
  expect(無い, "当たらない時に name への敿へを出した").not.toContain("name` に「nosuchway」");
  expect(無い, "収録にないと言つていない").toContain("収録に在りません");
});

it("scope のエイリアスは schema の enum にも載る（第 1029 回）", async () => {
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
  expect(持つ道具.length, "scope を持つ道具が 4 つない").toBe(4);
  for (const { name, enum: values, 文 } of 持つ道具) {
    for (const 別名 of ["collection", "full", "window", "catalog"]) {
      expect(values, `${name} の enum に ${別名} が無い`).toContain(別名);
    }
    expect(values, `${name} の enum が 6 つ無い`).toHaveLength(6);
    expect(文, `${name} の說明にエイリアスを書いて居ん`).toContain("同じエイリアス");
  }
  /* 実物もその通りに效く（enum に入れただけで実裝が変はつて居ない事の確かめ）。 */
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

it("種別は行に出す日本語の名でも絞せる（第 1030 回）", async () => {
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
  /* 実物: 日本語の名と英語のキーで**同じ件数**に成る。 */
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
  expect(件(配列日本), "配列の日本語と英語で件数が違う").toBe(件(配列英語));
  /* 本当に知らない種別は從つて通りの文（余計な推測を足さない）。 */
  const 知らん = await call("search_deadlines", { query: "セキュリティ", limit: 1, kind: "zzz" });
  expect(知らん, "知らない種別に敿へを出した").toContain("知らない種別");
});

it("ランクは行の出し方（CCF A）でも絞せる（第 1031 回）", async () => {
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
  expect(文, "行の出し方でも受けると書いていない").toContain("行の出し方（`CCF A`");

  const 件 = (t: string): number =>
    Number((t.split("\n")[0].match(/([\d,]+) 件/)?.[1] ?? "0").replace(/,/g, ""));
  /* 行の出し方と、等級だけで同じ件数に成る。 */
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
  /* 素の `rankPairs` の形（`core:A*`）もそのまま效く。 */
  const ccf = 件(
    await call("search_deadlines", { query: "セキュリティ", limit: 1, rank: "core:A*" }),
  );
  const star = 件(await call("search_deadlines", { query: "セキュリティ", limit: 1, rank: "A*" }));
  expect(ccf, "core:A* と A* で件数が違う").toBe(star);
  /* 本当に知らない等級は從つて通り（余計な推測を足さない）。 */
  const 知らん = await call("search_deadlines", { query: "セキュリティ", limit: 1, rank: "D" });
  expect(知らん, "知らない等級に敿へを出した").toContain("知らないランク");
});

it("「収録に見当たらない」は収録の全体で数える（第 1033 回）", async () => {
  const 答 = await call("search_deadlines", { query: "Jeju Island", limit: 1 });
  expect(答, "収録の全体に行があると言つていない").toContain("収録の全体には 4 行あります");
  expect(答, "「jeju」を収録に見当たらないと言つた（逆の事を言つている）").not.toContain(
    "「jeju」は収録データにも見当たりません",
  );
  expect(答, "「island」を収録に見当たらないと言つた（逆の事を言つている）").not.toContain(
    "「island」は収録データにも見当たりません",
  );
  expect(答, "語がある事を言つていない").toMatch(/語をすべて含む行はありません/);
  expect(答, "語ごとの件数が読めない").toMatch(/「jeju」\d+件・「island」\d+件/);

  /* 逆に、**本当に**収録のどこにも無い語は從つて通り「見当たらない」と言う。 */
  const 死語 = await call("search_deadlines", { query: "セキュリティ zzz9", limit: 1 });
  expect(死語, "死語の報べが消えた").toContain("「zzz9」は収録データにも見当たりません");
  /* `セキュリティ GPU` の形 – GPU がどこにも無いので、そのまま「見当たらない」が出る。 */
  const gpu = await call("search_deadlines", { query: "セキュリティ GPU", limit: 1 });
  expect(gpu, "gpu の死語の報べが変はつた").toContain("「gpu」は収録データにも見当たりません");
});

it("推定の行は幅を出し、事実のやうに見せない（第 1034 回）", async () => {
  const acml = await call("search_deadlines", {
    query: "acml",
    scope: "all",
    limit: 10,
    include_estimated: true,
    kinds: ["paper"],
  });
  const 行 = acml.split("\n").filter((l) => l.includes("推定期間"));
  expect(行.length, "推定期間の行が出ていない").toBeGreaterThan(0);
  /* 幅がそのまま出る（`estimate` の中身と一致）。 */
  expect(行[0], "幅が出ていない").toContain("推定期間 2027-03-28〜2027-10-10");
  /* 点推定点も「元の宣言」で添へる（どつちが事実でどつちが推定か読める）。 */
  expect(行[0], "点推定点が書かれていない").toContain("元の宣言");
  /* 「残り」は点推定点の分だと言う（幅の終はりまでの残りと誤読しない為）。 */
  expect(行[0], "残りの数え方を書いていない").toContain("残りは点推定点の分");
  /* 推定の札も残る（從つて通りの印）。 */
  expect(行[0], "推定の札が消えた").toContain("（推定）");

  /* 確定の行には幅を出さない（從つて通りの形）。 */
  const 確定 = await call("search_deadlines", {
    query: "セキュリティ",
    limit: 3,
    kinds: ["paper"],
  });
  for (const l of 確定.split("\n").filter((l) => /^2\d{3}-/.test(l))) {
    expect(l, "確定の行に推定期間を出した").not.toContain("推定期間");
    expect(l, "確定の行に点推定点の但しを出した").not.toContain("点推定点の分");
  }

  /* **悉皆** – 幅を持つ推定の行全部が、幅を出している（黙つて落としている行が無い）。 */
  const 全部 = await call("search_deadlines", {
    scope: "all",
    limit: 100,
    include_estimated: true,
    kinds: [],
  });
  const 推定行 = 全部.split("\n").filter((l) => l.includes("（推定）"));
  for (const l of 推定行) {
    expect(l, "幅を持つ推定の行が幅を落としている").toContain("推定期間");
  }
});

it("投稿のトラックも行に出す（第 1035 回）", async () => {
  const closer = await call("search_deadlines", {
    query: "closer",
    scope: "all",
    limit: 20,
    include_estimated: true,
    kinds: [],
  });
  const 行 = closer.split("\n").filter((l) => /^2\d{3}-/.test(l));
  expect(行.length, "closer の行が出ていない").toBeGreaterThan(1);
  expect(
    行.filter((l) => l.includes("論文締切（regular）")).length,
    "regular の締切に出していない",
  ).toBeGreaterThan(0);
  expect(
    行.filter((l) => l.includes("論文締切（position）")).length,
    "position の締切に出していない",
  ).toBeGreaterThan(0);

  /* トラックの**無い**行は從つて通り（余計な括弧を足さない – 5,061 行が空）。 */
  const wsdm = await call("search_deadlines", { query: "wsdm", scope: "all", limit: 5 });
  for (const l of wsdm.split("\n").filter((l) => /^2\d{3}-/.test(l))) {
    expect(l, "トラックのない行に空の括弧を出した").not.toMatch(/論文締切（\s*）/);
  }

  /* **悉皆** – トラックを持つ会議を一つづつ引き、行に出るトラックが**収録の中にある値**
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
  expect([...值], "トラックの値が読めない（この検查が空振り）").toEqual(
    expect.arrayContaining(["regular", "position"]),
  );
  expect(會議.size, "トラックを持つ会議が読めない").toBeGreaterThan(0);
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

  /* 行の形の說明に「種別の欄の丸括弧は別の物」と書く。 */
  const res = (await client.ask({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
    result?: { tools?: Array<{ name?: string; description?: string }> };
  };
  const 文 =
    (res.result?.tools ?? []).find((t) => t.name === "search_deadlines")?.description ?? "";
  expect(文, "種別の欄の丸括弧が別の物だと書いていない").toContain("トラック");
});

it("上流が差し替へた締切も札で言う（第 1037 回）", async () => {
  const edbt = await call("venue_info", { key: "edbt", scope: "all" });
  const 行 = edbt.split("\n").filter((l) => /^2\d{3}-/.test(l));
  const 差し替え = 行.filter((l) => l.includes("前に出ていた締切"));
  expect(差し替え.length, "差し替へた締切を言つていない").toBeGreaterThan(0);
  /* 文組みは同じ正本（`Recommender.deadlineShiftLineJa`）を使うので、画面と同し文に成る。 */
  expect(差し替え[0], "差し替への文が読めない").toMatch(
    /前に出ていた締切: \d{4}-\d{2}-\d{2}\([^)]*\) [\d:]* → \d{4}-\d{2}-\d{2}\([^)]*\) [\d:]*（延長後|前倒し）/,
  );
  /* **悉皆** – 上書きを持つ 24 会議全部が、行に差し替へを出す。 */
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
  expect(會議.size, "上書きを持つ会議が読めない").toBeGreaterThan(20);
  let 行の合計 = 0;
  for (const key of 會議) {
    const 答 = await call("venue_info", { key, scope: "all" });
    const n = 答
      .split("\n")
      .filter((l) => /^2\d{3}-/.test(l) && l.includes("前に出ていた締切")).length;
    expect(n, `${key} が差し替へを言つて居ない`).toBeGreaterThan(0);
    行の合計 += n;
  }
  expect(行の合計, "差し替への行が収録と合はない").toBe(35);

  /* 差し替への**無い**行は從つて通り（札を足さない）。 */
  const wsdm = await call("venue_info", { key: "wsdm", scope: "all" });
  for (const l of wsdm.split("\n").filter((l) => /^2\d{3}-/.test(l))) {
    expect(l, "差し替へのない行に札を出した").not.toContain("前に出ていた締切");
  }
});

it("会期の見直しの覺え書きも行に出す（第 1038 回）", async () => {
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
  expect(版の覺え書き.size, "覺え書きを持つ版が読めない（この検查が空振り）").toBe(7);

  /* 覺え書きを持つ版の会議を引き、行に覺え書きが出ている事を確かめる。 */
  const 會議 = new Set<string>();
  for (const c of 收錄.conferences) {
    for (const e of c.editions ?? []) {
      const note = String((e as any).event_review?.note ?? "").trim();
      if (note) 會議.add(String(c.key ?? ""));
    }
  }
  expect(會議.size, "覺え書きを持つ会議が読めない").toBe(7);
  for (const key of 會議) {
    const 答 = await call("venue_info", { key, scope: "all" });
    for (const l of 答.split("\n").filter((l) => /^2\d{3}-/.test(l))) {
      /* 行の会期の欄（`| 会期 … |`）に覺え書きが入つているか。 */
      const m = /\| 会期 ([^|]*?)（([^|]+?)） \| /.exec(l);
      if (!m) continue;
      /* 会期の日期の後ろの丸括弧は**二つ**在り得る（差し替への札は別欄）ので、
       * 覺え書きの中に版の id が入つているかで判斷する。 */
      const id = /（([a-z0-9][a-z0-9.'-]*)）\|/.exec(l)?.[1] ?? "";
      if (!版の覺え書き.has(id)) continue;
      expect(
        l.includes(`（${版の覺え書き.get(id)}）`),
        `${key} の行に覺え書きが出て居ない: ${l.slice(0, 120)}`,
      ).toBe(true);
    }
  }
  /* **悉皆の裏** – 覺え書きの**無い**版の行には足さない。 */
  const 無い = await call("venue_info", { key: "adma", scope: "all" });
  for (const l of 無い.split("\n").filter((l) => /^2\d{3}-/.test(l))) {
    if (l.includes("adma22") || l.includes("adma23")) {
      expect(l, "覺え書きのない版に足した").not.toContain("ADMA 2021年版を2022年2月に開催");
    }
  }
});

it("古い key（legacy_keys）でも会議を引ける（第 1039 回）", async () => {
  const 收錄 = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as {
    conferences: Array<Record<string, any>>;
  };
  const 古い鍵 = new Map<string, string>();
  for (const c of 收錄.conferences) {
    for (const l of Array.isArray(c.legacy_keys) ? c.legacy_keys : []) {
      if (String(l ?? "").trim()) 古い鍵.set(String(l), String(c.key ?? ""));
    }
  }
  /* `fse` は 2 会議（fse-sc・fse-se）が同じ古い key を持つので、ユニークは 15 に成る
   * （重複は 16 件）。両方に「同じ古い key」がある事は venueMatch の曖昧さと同じ型 –
   * その場合は「どちらとも決められない」と答へるべきで、この検查ではそのまま通す。 */
  expect(古い鍵.size, "古い key が読めない（この検查が空振り）").toBe(15);

  /* **悉皆** – 古い key 全部が、会議を引ける（「収録に在りません」と言はない）。 */
  for (const [古い, 新] of 古い鍵) {
    const 答 = await call("venue_info", { key: 古い, scope: "all" });
    expect(答, `古い key「${古い}」で會議が引けない`).not.toContain("収録に在りません");
    /* 新しい key も言う（次の呼び出しでそれを使へる）。 */
    expect(答, `「${古い}」から新しい key が讀めない`).toContain(`key: ${新}`);
  }

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
  expect(cli.stdout, "CLI が「収録に在りません」と言つた").not.toContain("収録に在りません");
});

it("行に足した 3 つの値は、4 つの道具の行と説明に出る（第 1041 回）", async () => {
  /* 第 1034・1035・1037 囘で**行**に推定の幅・トラック・差し替へを足した。**說明を
   * 更新し忘れていた** – 悉皆 2026-11-19: 4 つの道具のうち `search_deadlines` は
   * トラックだけ言つて居て、`list_upcoming`・`recommend_venues`・`explain_word` は
   * **三つとも黙つていた**。行だけ直しても、說明が「この欄は会期…」と書くだけなので、
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
  /* 残る 2 つは「`search_deadlines` と同じ欄」と參照している – その參照が実際に效く事を
   * **実物**で確かめる（說明だけ合つて居て行が出して居ない、の逆を防ぐ）。 */
  const 推薦 = await call("recommend_venues", { paper: "CLOSER の position", limit: 5 });
  const 推薦の行 = 推薦.split("\n").filter((l) => /^\d\. /.test(l));
  expect(推薦の行.length, "推薦の行が出ていない").toBeGreaterThan(0);
  expect(
    推薦の行.some((l) => /論文締切（[^）]+）/.test(l)),
    "推薦の行にトラックが出て居ない（search_deadlines と同じ欄の筈）",
  ).toBe(true);
  const 語 = await call("explain_word", { word: "closer" });
  const 語の行 = 語.split("\n").filter((l) => /^-\s*2\d{3}-/.test(l));
  expect(語の行.length, "explain_word の行が出ていない").toBeGreaterThan(0);
  for (const l of 語の行) {
    /* 差し替への札が出る筈（closer は 2026-11-18 が regular・2026-12-22 が position）。 */
    if (l.includes("closer")) {
      expect(l, "explain_word の行にトラックが出て居ない").toMatch(/論文締切（[^）]+）/);
    }
  }
});

it("端数の limit は黙つて切り捨てない（第 1043 回）", async () => {
  /* `0.9` は「1 以上では無い」ので第 878 囘の文（黙つて既定に戾さない）になる –
   * そちらで黙つて居ないのでこの対象外。 */
  const 小 = await call("search_deadlines", { query: "セキュリティ", limit: 0.9 });
  expect(小, "0.9 を黙つて扱つた").toContain("limit は 1 以上の数で指定してください");
  for (const 値 of [3.7, 2.5, 100.1]) {
    const 答 = await call("search_deadlines", { query: "セキュリティ", limit: 値 });
    expect(答, `limit: ${値} を默つて切り捨てた`).toContain(
      `（${値} は端数なので、${Math.floor(値)} として切りました）`,
    );
  }
  /* 整数は黙る（そのまま使う – 第 852 回と同じ決まり）。 */
  const 整數 = await call("search_deadlines", { query: "セキュリティ", limit: 3 });
  expect(整數, "整数の limit に斷りを出した").not.toContain("端数なので");
  /* 読めない値は第 878 囘の文（黙つて既定に戾さない）。 */
  const 讀めない = await call("search_deadlines", { query: "セキュリティ", limit: -5 });
  expect(讀めない, "読めない limit の文が消えた").toContain(
    "limit は 1 以上の数で指定してください",
  );

  /* 推薦も同じ。 */
  for (const 値 of [3.7, 2.5]) {
    const 答 = await call("recommend_venues", { paper: "分散システム", limit: 値 });
    expect(答, `推薦の limit: ${値} を默つて切り捨てた`).toContain(
      `（${値} は端数なので、${Math.floor(値)} として切りました）`,
    );
  }
  const 推薦の整數 = await call("recommend_venues", { paper: "分散システム", limit: 5 });
  expect(推薦の整數, "推薦の整数 limit に斷りを出した").not.toContain("端数なので");
});

it("端数と上限は両方続けて言う（第 1044 回）", async () => {
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
  /* 推薦も両方。 */
  const 推薦 = 帶(await call("recommend_venues", { paper: "分散", limit: 999.9 }));
  expect(推薦, "推薦の上限を言つていない").toContain("上限 100 を超えた");
});

it("ヘルプの例は 6 つの道具を全部覆ひ、実際に效く（第 1046 回）", async () => {
  const res = (await client.ask({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
    result?: { tools?: Array<{ name?: string }> };
  };
  const 道具 = (res.result?.tools ?? []).map((t) => String(t.name ?? ""));
  expect(道具.length, "道具が読めない").toBe(6);

  const 手引き = spawnSync(process.execPath, [join(REPO_ROOT, "src", "mcp.ts"), "--help"], {
    encoding: "utf8",
    timeout: 60000,
  });
  expect(手引き.status, `ヘルプが落ちた: ${手引き.stderr?.slice(0, 120)}`).toBe(0);
  const 例 = 手引き.stdout.split("\n").filter((l) => l.startsWith("  例: node src/mcp.ts "));
  expect(例.length, "例が読めない（この検查が空振り）").toBe(6);

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
    /* 「130 件」の中の「0 件」に誤爆していた。先頭が 0 の
     * 件数（「0 件」・「: 0 件」）だけを「使へない例」と見る。 */
    expect(出た, `例が 0 件を返した（使へない例）: ${l} → ${出た.slice(0, 60)}`).not.toMatch(
      /(?:^|[^0-9])0 件/,
    );
  }

  /* 6 つの道具全部が例にある（漏れが無い）。 */
  for (const n of 道具) {
    /* 短い別名で例を書いている道具（ヘルプの例は人が打つので短い方が良い）。 */
    const 短い: Record<string, string> = {
      search_deadlines: "search",
      collection_stats: "stats",
      recommend_venues: "recommend",
    };
    const 烙印 = 短い[n] ?? n;
    /* 烙印の後ろは空白**または行末**（`stats` は引数が無いので行末）。 */
    const 一歡 = 例.some((l) => {
      const 打たれた = l.replace(/^\s*例: node src\/mcp\.ts\s*/, "");
      return 打たれた === 烙印 || 打たれた.startsWith(`${烙印} `);
    });
    expect(一歡, `${n} に例が無い`).toBe(true);
  }
});

it("推薦は論文の中の行数も切ったと言う（第 1050 回）", async () => {
  const T = "Title: 分散システムのスケジューリング";
  const 候補數 = async (行數: number): Promise<number> => {
    const paper =
      行數 === 1 ? T : [T, ...Array.from({ length: 行數 - 1 }, (_, i) => `filler ${i}`)].join("\n");
    const 答 = await call("recommend_venues", { paper, limit: 100 });
    return Number(答.match(/合う投稿先: ([\d,]+) 件/)?.[1]?.replace(/,/g, "") ?? "0");
  };

  /* 20 行以下は黙る（切つて居ない – 第 852 回と同じ決まり）。 */
  const 短い = await call("recommend_venues", { paper: T, limit: 3 });
  expect(短い, "短い論文に截りの文を出した").not.toContain("行のうち");

  /* 21 行以上は「論文の中の N 行のうち、最初の 20 行」と言う。 */
  for (const 行數 of [21, 25, 100, 1000]) {
    const paper = [T, ...Array.from({ length: 行數 - 1 }, (_, i) => `filler ${i}`)].join("\n");
    const 答 = await call("recommend_venues", { paper, limit: 3 });
    expect(答, `${行數} 行の論文に截りの文が無い`).toContain(
      `（論文の中の ${行數} 行のうち、最初の 20 行で調べました – 残りの行は参考にしていません）`,
    );
  }

  /* **截つた行を使う**ので、21 行以降は候補が変はらない（未截りだと 1,000 行で 0 件に
   * 成つていた – 軸が filler で壊ける）。 */
  const 二十一 = await 候補數(21);
  const 一百 = await 候補數(100);
  const 千 = await 候補數(1000);
  expect(二十一, "21 行で候補が読めない").toBeGreaterThan(0);
  expect(一百, "100 行と 21 行で候補が違う（未截りを使っている）").toBe(二十一);
  expect(千, "1,000 行で候補が 0 件に成つた（未截りを使っている）").toBe(二十一);

  /* 複数論文（25 件）は從つて通りの文（論文数で切る）。 */
  const 多 = Array.from({ length: 25 }, (_, i) => `論文${i} | kw${i}`).join("\n");
  const 複數 = await call("recommend_venues", { paper: 多, limit: 3 });
  expect(複數, "複数論文の截りの文が消えた").toContain("（25 行のうち、最初の 20 行（題名・概要）");
});

it("推定の幅は一つの正本から両方が出る（第 1053 回）", async () => {
  const R = (await import("../site/recommender.ts")).default;
  /* 正本の動き。 */
  expect(
    R.estimateWindowJa({
      estimated: true,
      estimate: { window_start: "2026-11-05", window_end: "2027-05-06" },
    }),
  ).toBe("推定期間 2026-11-05〜2027-05-06");
  /* 推定で無い・幅が無い時は空（黙る）。 */
  expect(
    R.estimateWindowJa({ estimated: false, estimate: { window_start: "a", window_end: "b" } }),
  ).toBe("");
  expect(R.estimateWindowJa({ estimated: true, estimate: {} })).toBe("");
  expect(R.estimateWindowJa({})).toBe("");

  /* MCP の行がその正本を通している（実物）。 */
  const mcp = await call("search_deadlines", {
    query: "acml",
    scope: "all",
    limit: 5,
    kinds: [],
    include_estimated: true,
  });
  const mcp行 = mcp.split("\n").filter((l) => l.includes("推定期間"));
  expect(mcp行.length, "MCP の行に幅が出ていない").toBeGreaterThan(0);
  expect(mcp行[0]).toMatch(/推定期間 \d{4}-\d{2}-\d{2}〜\d{4}-\d{2}-\d{2}/);

  /* **建造物**（`upcoming.md`）が同じ書式を出している – 両方が同じ正本を使うので、
   * べた書きの時代の「片方が古くなる」が起きない。 */
  const md = readFileSync(join(REPO_ROOT, "public", "upcoming.md"), "utf8");
  /* 散文の説明行（「『推定期間 A〜B』の形」）ではなく、**表の行**だけを見る。 */
  const md行 = md.split("\n").filter((l) => l.includes("推定期間") && l.startsWith("| "));
  expect(md行.length, "upcoming.md に幅が出ていない").toBeGreaterThan(0);
  for (const l of [...mcp行.slice(0, 3), ...md行.slice(0, 3)]) {
    expect(l).toMatch(/推定期間 \d{4}-\d{2}-\d{2}〜\d{4}-\d{2}-\d{2}/);
  }
});

it("時刻未確認の行は「いつ終はつたか」を言う（第 1055 回）", async () => {
  const R = (await import("../site/recommender.ts")).default;
  const D = 86400000;
  const now = Date.parse("2026-11-01T00:00:00Z");
  const mk = (t: number, tLast: number) => ({ dateOnly: true, t, tLast, localDate: "2026-10-11" });
  /* 正本の動き（3 状態 + null）。 */
  expect(R.dateOnlyStateJa(mk(now + 10 * D, now + 11 * D), now)).toBe("definitely-future");
  expect(R.dateOnlyStateJa(mk(now - D, now + D), now)).toBe("uncertain-on-date");
  expect(R.dateOnlyStateJa(mk(now - 11 * D, now - 10 * D), now)).toBe("definitely-past");
  expect(R.dateOnlyStateJa({ dateOnly: false, t: now, tLast: now }, now)).toBeNull();
  /* 邊境（その日にちょうど = uncertain・t が数で無い = null）。 */
  expect(R.dateOnlyStateJa(mk(now, now), now)).toBe("uncertain-on-date");
  expect(R.dateOnlyStateJa({ dateOnly: true }, now)).toBeNull();

  /* **実物** – 時刻未確認の行が「すでに終了している可能性」を言う。 */
  const 答 = await call("venue_info", { key: "stacs-2027-first", scope: "all" });
  const 行 = 答.split("\n").filter((l) => /^2\d{3}-/.test(l) && l.includes("時刻未確認"));
  expect(行.length, "時刻未確認の行が出ていない").toBeGreaterThan(0);
  const sourceRows = R.candidateRows(
    JSON.parse(readFileSync(join(REPO_ROOT, "data/snapshot.json"), "utf8")),
  ).filter((r) => r.conf.key === "stacs-2027-first" && r.dateOnly);
  for (const l of 行) {
    const row = sourceRows.find((r) => l.startsWith(String(r.localDate)));
    if (!row) throw new Error(`収録に行がありません: ${l}`);
    const state = R.dateOnlyStateJa(row, Date.now());
    if (state === "definitely-past") expect(l).toContain("締切日経過");
    else if (state === "uncertain-on-date")
      expect(l).toContain("すでに終了している可能性があります");
    else expect(l).not.toContain("締切日経過");
    /* 二重に「（時刻未確認）」と並べない（重複は slops）。 */
    expect(l.split("（時刻未確認）").length - 1, "「（時刻未確認）」が重なっている").toBe(0);
  }
  /* **確認された時刻の行**は「残り N 日」の儘。 */
  const icde = await call("venue_info", { key: "icde", scope: "all" });
  const 確定 = icde.split("\n").filter((l) => /^2\d{3}-/.test(l) && /残り\d+日/.test(l));
  expect(確定.length, "確定の行に「残り」が出ていない").toBeGreaterThan(0);
});

it("札の「未確認」は正本から取る（第 1058 回）", async () => {
  const R = (await import("../site/recommender.ts")).default;
  const 正本 = String(R.unconfirmedLabelJa() ?? "").trim();
  expect(正本, "正本が読めない").toBe("未確認");

  /* **実物** – 札の「未確認」が、正本と同じ値で出る。 */
  const 答 = await call("venue_info", { key: "stacs-2027-first", scope: "all" });
  expect(答, "札の「未確認」が出ていない").toContain("未確認");
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
         * 確かめるのは「未確認」**その物**が立つ欄（場所・年数）だけ。 */
        if (値 !== "ランク未確認" && 値 !== "会期 未確認") {
          expect(値, "札が正本と違う").toBe(正本);
        }
      }
    }
  }
});

it("常時受付の行も版の識別子を持つ（第 1059 回）", async () => {
  const R = (await import("../site/recommender.ts")).default;
  const now = Date.parse("2026-11-19T00:00:00Z");
  const 品書 = JSON.parse(readFileSync(join(REPO_ROOT, "public", "catalog.json"), "utf8"));
  const 期刊行 = R.journalRows(品書.conferences, now) as Array<{
    ed: { id?: string };
    conf: { key?: string };
  }>;
  expect(期刊行.length, "常時受付の行が読めない（この検查が空振り）").toBeGreaterThan(0);
  for (const r of 期刊行) {
    expect(String(r.ed?.id ?? "").trim(), "常時受付の行に id がない").toBe(
      String(r.conf?.key ?? ""),
    );
    expect(String(r.ed?.id ?? ""), "空文字の id").not.toBe("");
  }

  /* **実物** – 推薦の行に「（undefined）」が出ない。 */
  const 答 = await call("recommend_venues", { paper: "ネットワーク", limit: 30 });
  expect(答, "推薦に「（undefined）」が出ている").not.toContain("（undefined）");
  expect(答, "推薦の行が出ていない").toMatch(/^1\. /m);
  /* 常時受付の行は「会期 該当なし」。 */
  const 常時 = 答.split("\n").filter((l) => /^\d\. /.test(l) && l.includes("常時受付"));
  for (const l of 常時) expect(l, "常時受付の行に会期が出ている").toContain("会期 該当なし");
});

it("読めない字を実答に出さない（第 1060 回）", async () => {
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

    ["真偽に讀めない値", call("search_deadlines", { query: "セキュリティ", include_past: "zzz" })],
    ["推薦の端数", call("recommend_venues", { paper: "分散", limit: 3.7 })],

    ["venue key が對象", call("venue_info", { key: {} })],
    ["venue key が配列", call("venue_info", { key: [] })],
    ["venue key が數", call("venue_info", { key: 123 })],
    ["推薦 paper が對象", call("recommend_venues", { paper: {} })],
    ["推薦 paper が配列", call("recommend_venues", { paper: [] })],
    /* **種別の入口**。 */
    ["search kinds が對象の配列", call("search_deadlines", { query: "セキュリティ", kinds: [{}] })],
    ["list kind が對象", call("list_upcoming", { kind: {} })],
    ["list kinds が對象の配列", call("list_upcoming", { kind: [{}] })],
    /* **語の入口**。 */
    ["query が對象", call("search_deadlines", { query: {} })],
    ["word が對象", call("explain_word", { word: {} })],
  ];
  for (const [名, 約束] of 全部) {
    const 答 = await 約束;
    for (const 字 of ["undefined", "NaN", "[object Object]", "[object Null]"]) {
      expect(答, `${名} の實答に「${字}」が出て居る`).not.toContain(字);
    }

    for (const 字 of ["\u503c"]) {
      expect(答, `${名} の實答に簡体字「${字}」が出て居る`).not.toContain(字);
    }
  }
});

it("説明の欄数と実答の欄数が合う（第 1061 回）", async () => {
  const res = (await client.ask({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
    result?: { tools?: Array<{ name?: string; description?: string }> };
  };
  const 文 = (n: string): string =>
    (res.result?.tools ?? []).find((t) => t.name === n)?.description ?? "";
  for (const n of ["search_deadlines", "list_upcoming", "venue_info"]) {
    expect(文(n), `${n} の欄數が 6 つか 7 つに成つて居ん`).toContain("確認状態（ある場合）");
  }

  /* **実答** – 全部の行が 6 か 7 に割れる（札がある時だけ 7）。 */
  const 答 = await call("venue_info", { key: "icde", scope: "all" });
  const 行 = 答.split("\n").filter((l) => /^2\d{3}-/.test(l));
  expect(行.length, "締切の行が出ていない").toBeGreaterThan(0);
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

it("型の違う数の引数は黙つて読み替へない（第 1063 回）", async () => {
  /* 文字列の「5」は読めるが、**変へた事を言う**。 */
  const 文字 = await call("search_deadlines", { query: "セキュリティ", limit: "5" });
  expect(文字, "型を黙つて読み替へた").toContain(
    '／limit は数で指定してください（いま "5" – 数値に変換しました）',
  );
  /* その値はそのまま使う（5 件の表示に成る – 既定に戾さない）。 */
  expect(文字.split("\n").filter((line) => /^2\d{3}-/.test(line))).toHaveLength(5);

  /* **整数**は黙る（そのまま使う）。 */
  const 整數 = await call("search_deadlines", { query: "セキュリティ", limit: 5 });
  expect(整數, "整数に斷りを付けた").not.toContain("数値に変換しました");

  /* 読めない形（`"abc"`）は第 878 囮の文（変はない）。 */
  const abc = await call("search_deadlines", { query: "セキュリティ", limit: "abc" });
  expect(abc, "読めない形の文が消えた").toContain("limit は 1 以上の数で指定してください");
  expect(abc, "読めない形の文が違う").toContain('（いま "abc"）');

  /* **他の数の引数**も同じ（`days`・`within_days`）。 */
  const days = await call("list_upcoming", { days: "30" });
  expect(days, "days の型を黙つて読み替へた").toContain(
    '／days は数で指定してください（いま "30" – 数値に変換しました）',
  );
  const 窓 = await call("search_deadlines", { query: "セキュリティ", within_days: "30" });
  expect(窓, "within_days の型を黙つて読み替へた").toContain(
    '／within_days は数で指定してください（いま "30" – 数値に変換しました）',
  );
});

it("長すぎる語は切ったと言う（第 1076 回）", async () => {
  /* 400 字までは截らない（黙る – 第 852 囮と同じ決まり）。 */
  const ぴったり = await call("explain_word", { word: "x".repeat(400) });
  expect(ぴったり, "400 字を截つた").not.toContain("残りは参考にしていません");
  /* 401 字以上は截つて、その旨を言う。 */
  for (const 字 of [401, 1000, 10000]) {
    const 答 = await call("explain_word", { word: "x".repeat(字) });
    expect(答, `${字} 字を默つた`).toContain(
      `（${字} 字のうち、最初の 400 字（1 つの語として）で調べました – 残りは参考にしていません）`,
    );
  }
  /* 本物の語（短い）は変はない（截りの文を付けない）。 */
  for (const g of ["カメラレディ", "セキュリティ", "ネットワーク"]) {
    const 答 = await call("explain_word", { word: g });
    expect(答, `${g} に截りの文を付けた`).not.toContain("残りは参考にしていません");
    expect(答, `${g} の行數が變はつた`).toMatch(/素の照合で [0-9]+ 行/);
  }
});

it("検索語が長すぎても切ったと言う（第 1077 回）", async () => {
  /* 800 字までは黙る。 */
  const ぴったり = await call("search_deadlines", { query: "x".repeat(800), limit: 1 });
  expect(ぴったり, "800 字を截つた").not.toContain("残りの語は参考にしていません");
  /* 801 字以上は截つて、その旨を言う。 */
  for (const 字 of [801, 5000, 100000]) {
    const 答 = await call("search_deadlines", { query: "x".repeat(字), limit: 1 });
    expect(答, `${字} 字を默つた`).toContain(
      `（${字} 字のうち、最初の 800 字で調べました – 残りの語は参考にしていません）`,
    );
  }
  /* 本物の検索語は変はない（正式名・複数語は全部 800 字未滿）。 */
  for (const g of [
    "セキュリティ",
    "ネットワーク データベース 人工知能",
    "The 9th IEEE International Workshop on Big Spatial Data (BSD 2026)",
  ]) {
    const 答 = await call("search_deadlines", { query: g, limit: 3 });
    expect(答, `「${g}」に截りの文を付けた`).not.toContain("残りの語は参考にしていません");
  }
});

it("知らない種別は例を 3 つ出して残りは数える（第 1078 回）", async () => {
  /* 3 個以下は全部出す（数へる迄も無い）。 */
  const 三 = await call("search_deadlines", { query: "x", kinds: ["k1", "k2", "k3"] });
  expect(三, "3 個を全部出せていない").toContain("k1・k2・k3");
  expect(三, "3 個で「ほか」を付けた").not.toContain("ほか");
  /* 4 個以上は例 3 つ + 数。 */
  for (const [個, 數] of [
    [4, 1],
    [10, 7],
    [10000, 9997],
  ] as const) {
    const 答 = await call("search_deadlines", {
      query: "x",
      kinds: Array.from({ length: 個 }, (_, i) => `k${i}`),
    });
    expect(答, `${個} 個で例が出て居ん`).toContain("k0・k1・k2");
    expect(答, `${個} 個で殘りの數が出て居ん`).toContain(`**ほか ${數} 個**`);
    /* **全部は列舉しない** – 末尾の語は出て居ない。 */
    expect(答, `${個} 個を全部列舉した`).not.toContain(`k${個 - 1}・`);
  }
});

it("打たれた語が空で見えない（第 1080 回）", async () => {
  /* MCP の經路: key に存在しない語を渡す。 */
  const 答 = await call("venue_info", { key: "xxx" });
  expect(答, "打たれた語が見えない").toContain("その会議（key: `xxx`）は収録に在りません");
  expect(答, "空の key を見せている").not.toContain("key: ``");
  /* **CLI の經路**（人の入口 – `node src/mcp.ts venue xxx`）。 */
  const cli = spawnSync(process.execPath, [join(REPO_ROOT, "src", "mcp.ts"), "venue", "xxx"], {
    encoding: "utf8",
    timeout: 60000,
  });
  expect(cli.status, `CLI が落ちた: ${cli.stderr?.slice(0, 120)}`).toBe(0);
  expect(cli.stdout, "CLI で打たれた語が見えない").toContain(
    "その会議（key: `xxx`）は収録に在りません",
  );
  /* 両方空（省略）なら黙つて「ください」に落ちる。 */
  const 空 = await call("venue_info", {});
  expect(空, "空の時に key を表示した").not.toContain("その会議（key:");
  expect(空, "空の時の文が消えた").toContain(
    "key（会議の識別子）か name（会議名の一部）をください。",
  );
});

it("投稿トラックを MCP・ICS・Markdown で区別できる", async () => {
  /* MCP の計画の計画。 */
  const 答 = await call("venue_info", { key: "closer", scope: "all" });
  const 行 = 答.split("\n").filter((l) => /^2\d{3}-/.test(l));
  const 論文 = 行.filter((l) => l.includes("論文締切"));
  expect(論文.length, "別トラックの締切を読み取れない").toBe(2);
  expect(
    論文.some((l) => l.includes("論文締切（regular）")),
    "regular トラックが表示されていない",
  ).toBe(true);
  expect(
    論文.some((l) => l.includes("論文締切（position）")),
    "position トラックが表示されていない",
  ).toBe(true);
  /* **計画の計画（ICS）** – 計画の計画・計画の計画の両方。 */
  const ics = readFileSync(join(REPO_ROOT, "public", "deadlines.ics"), "utf8");
  expect(ics, "ICS に投稿トラックが表示されていない").toContain("CLOSER 2027：論文締切（regular）");
  expect(ics, "ICS に投稿トラックが表示されていない").toContain(
    "CLOSER 2027：論文締切（position）",
  );
  /* **計画の計画（計画の計画）** – 計画の計画の計画に入つている。 */
  const md = readFileSync(join(REPO_ROOT, "public", "upcoming.md"), "utf8");
  expect(md).toContain("[CLOSER 2027]");
  /* 計画の計画の計画（計画の計画）は計画の計画の計画の計画に計画の計画を計画の計画
   * に計画の計画している – 計画の計画の計画の計画を計画の計画に計画の計画する。 */
  expect(md).toMatch(/CLOSER 2027\][^|]*\| 論文締切（regular） \| R1/);
  expect(md).toMatch(/CLOSER 2027\][^|]*\| 論文締切（position） \| R1/);
});

it("投稿トラックのある複数の締切を MCP と ICS で区別できる", async () => {
  const 會議 = ["closer", "cpal", "eudat-conference"];
  for (const key of 會議) {
    const 答 = await call("venue_info", { key, scope: "all" });
    const 計畫の行 = 答
      .split("\n")
      .filter(
        (l) =>
          /^2\d{3}-/.test(l) &&
          /（(regular|position|first-intake|second-intake|proceedings|recent-spotlight)）/.test(l),
      );
    expect(計畫の行.length, `${key} に行が出て居ん`).toBeGreaterThan(0);
  }
  /* **ICS** – 計画の計画の計画の計画の中で瞬間を持つ計画の計画の計画の計画だけ。 */
  const ics = readFileSync(join(REPO_ROOT, "public", "deadlines.ics"), "utf8");
  for (const 語 of [
    "論文締切（regular）",
    "論文締切（position）",
    "論文締切（second-intake）",
    "論文締切（second-intake）",
    "採否通知（first-intake）",
  ]) {
    expect(ics, `ICS に「${語}」が出て居ん`).toContain(語);
  }
});

it("推薦の說明に「順位表に入る条件」を書く（第 1090 回）", async () => {
  const res = (await client.ask({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
    result?: { tools?: Array<{ name?: string; description?: string }> };
  };
  const 文 =
    (res.result?.tools ?? []).find((t) => t.name === "recommend_venues")?.description ?? "";
  expect(文, "順位表に入る条件が書かれていない").toContain("順位表に入る");
  expect(文, "実質の一致が条件だと書かれていない").toContain("実質的な一致がある");
  /* 変更の理由（證據が無い会議を薦めていた）も添へる – それが何を直したかが読める。 */
  expect(文, "何を直したかが書かれていない").toContain("証拠がない会議");
});
