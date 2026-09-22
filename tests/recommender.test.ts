/**
 * Recommender (site/recommender.ts) の回帰テスト。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";
import { restoreRecommendationBundle } from "../scripts/restore-recommendation-bundle.ts";
import {
  deriveConfidenceThresholds,
  hardNegativeMix,
  trainingFeatureHash,
  trainRerankerMain,
} from "../scripts/train-reranker.ts";
import recommender, { isValidRerankerModel } from "../site/recommender.ts";
import {
  main as benchMain,
  benchV2RequiredRegressionReasons,
  buildRealPaperResult,
  contentWords,
  norm,
  parseBenchArgs,
  REAL_PAPER_REGRESSION_FLOORS,
  readFeatureStore,
  realPaperBenchmarkContentId,
  realPaperMetrics,
  realPaperRegressionReasons,
  runBenchmarkV2,
  topicWords,
  validateRealPaperFixtures,
} from "../src/bench-recommender.ts";
import { compileSiteRuntime, writePublishManifest } from "../src/build.ts";
import {
  EMBEDDING_MODEL,
  EMBEDDING_MULTI_MODEL,
  EMBEDDING_MULTI_REVISION,
  EMBEDDING_REVISION,
  embeddingManifest,
  main as embeddingsMain,
  venuePapersHash,
} from "../src/embeddings.ts";
import { computeSemanticContentId } from "../src/semantic-content.ts";
import { REPO_ROOT } from "./helpers.ts";

const R = recommender as any;
let emittedApp: string | null = null;
const appRuntime = () => (emittedApp ??= compileSiteRuntime()["app.js"]);
const DATA_JSON = join(REPO_ROOT, "public", "data.json");
const EMB_JSON = join(REPO_ROOT, "public", "embeddings.json");
const hasData = (() => {
  try {
    return readFileSync(DATA_JSON, "utf8").length > 0;
  } catch {
    return false;
  }
})();

function loadRows(): any[] {
  const data = JSON.parse(readFileSync(DATA_JSON, "utf8"));
  return data.conferences.map((conf: any) => ({
    conf: {
      key: conf.key ?? "",
      title: conf.title ?? "",
      full_name: conf.full_name ?? "",
      tags: conf.tags ?? [],
    },
    cats: conf.categories ?? [],
  }));
}

// ---- 純粋関数テスト ----

describe("parsePaperLines", () => {
  it("handles pipe and tab separators", () => {
    const lines = R.parsePaperLines(
      "Title A | kw1, kw2 | RTSS\n" + "Title B | kw3\n" + "Title C\tkw4\tFAST\n" + "\n" + "Title D",
    );
    expect(lines[0]).toEqual({ title: "Title A", keywords: "kw1, kw2", venue: "RTSS" });
    expect(lines[1]).toEqual({ title: "Title B", keywords: "kw3", venue: "" });
    expect(lines[2]).toEqual({ title: "Title C", keywords: "kw4", venue: "FAST" });
    expect(lines[3]).toEqual({ title: "Title D", keywords: "", venue: "" });
    expect(lines.length).toBe(4);
  });

  it("handles empty input", () => {
    expect(R.parsePaperLines("  \n\n ")).toEqual([]);
  });

  it("accepts structured JSON records and includes abstract text in scoring", () => {
    const rows = R.parsePaperLines(
      JSON.stringify({
        title: "A paper",
        abstract: "GPU scheduling for parallel systems",
        keywords: ["latency", "kernel"],
        venue: "SC",
      }),
    );
    expect(rows).toEqual([
      {
        title: "A paper",
        abstract: "GPU scheduling for parallel systems",
        keywords: "latency, kernel",
        venue: "SC",
      },
    ]);
    expect(R.autoDetectCats(rows)).toContain("hpc");
  });

  it("accepts JSON arrays and labeled metadata, but malformed JSON falls back safely", () => {
    expect(R.parsePaperLines('[{"title":"A"},{"title":"B","venue":"RTSS"}]')).toHaveLength(2);
    expect(
      R.parsePaperLines(
        "Title: A paper\nAbstract: GPU scheduling\nKeywords: hpc, kernel\nVenue: SC",
      ),
    ).toEqual([
      { title: "A paper", abstract: "GPU scheduling", keywords: "hpc, kernel", venue: "SC" },
    ]);
    expect(R.parsePaperLines('{"title":')).toEqual([
      { title: '{"title":', keywords: "", venue: "" },
    ]);
  });
});

describe("paper roles and confidence", () => {
  const topicRow = {
    conf: { key: "gpu", title: "GPU Systems", full_name: "", tags: [] },
    cats: ["hpc"],
  };

  it("makes the first paper primary and caps unique reference weight", () => {
    const lines = R.parsePaperLines(
      "GPU scheduling | gpu\nReference A | parallel\nReference B | kernel\nReference B | kernel",
    );
    expect(R.paperWeights(lines)).toEqual([
      { role: "primary", weight: 1 },
      { role: "reference", weight: 0.2 },
      { role: "reference", weight: 0.2 },
      { role: "reference", weight: 0 },
    ]);
    expect(R.scorePapers(topicRow, R.parsePaperLines("GPU scheduling | gpu"))).toBeGreaterThan(
      R.scorePapers(topicRow, R.parsePaperLines("Unrelated | text\nGPU scheduling | gpu")),
    );
    expect(
      R.scorePapers(
        topicRow,
        R.parsePaperLines("GPU scheduling | gpu\nGPU scheduling | gpu\nGPU scheduling | gpu"),
      ),
    ).toBe(R.scorePapers(topicRow, R.parsePaperLines("GPU scheduling | gpu")));
  });

  it("keeps prior-venue evidence out of topic strength and applies it once", () => {
    const row = {
      conf: { key: "rtss", title: "RTSS", full_name: "Real-Time Systems Symposium", tags: [] },
      cats: [],
    };
    const result = R.breakdown(row, R.parsePaperLines("Unrelated paper | unrelated | RTSS"));
    expect(result.score).toBe(40);
    expect(result.topicScore).toBe(0);
    expect(result.venueScore).toBe(40);
    expect(result.agg.venue).toBe(40);
    expect(result.signalEvidence).toContainEqual({ type: "prior-venue", contribution: 40 });
  });

  it("classifies weak, close, and strong absolute evidence deterministically", () => {
    expect(R.confidenceState(39, 100)).toBe("insufficient");
    expect(R.confidenceState(40, 9)).toBe("ambiguous");
    expect(R.confidenceState(55, 10)).toBe("sufficient");
    expect(R.confidenceState(70, 9)).toBe("ambiguous");
  });
});

describe("bounded PDF paper extraction", () => {
  const item = (str: string, size: number, y: number, x = 0) => ({
    str,
    transform: [size, 0, 0, size, x, y],
  });

  it("prefers metadata title and stops sections before references", () => {
    const pages = [
      [
        item("Large visual title", 24, 800),
        item("Abstract", 12, 740),
        item("We study scheduling systems.", 10, 720),
        item("Keywords: scheduling, systems", 10, 680),
        item("1 Introduction", 12, 640),
        item("References", 12, 100),
      ],
    ];
    expect(R.pdfPaperRecord({ info: { Title: "Metadata title" } }, pages, "filename.pdf")).toEqual({
      title: "Metadata title",
      abstract: "We study scheduling systems.",
      keywords: "scheduling, systems",
      venue: "",
    });
  });

  it("uses font-aware title fallback and preserves x reading order", () => {
    const pages = [
      [item("right", 10, 700, 100), item("Title", 20, 800, 100), item("left", 10, 700, 0)],
    ];
    expect(R.pdfTextLines(pages)).toEqual(["Title", "left right"]);
    expect(R.pdfPaperRecord({}, pages, "fallback.pdf").title).toBe("Title");
  });

  it("bounds an empty or malformed extraction to a filename fallback", () => {
    expect(R.pdfPaperRecord({}, [[]], "fallback.pdf").title).toBe("fallback.pdf");
    expect(R.pdfPaperRecord({}, null, "").title).toBe("");
  });
});

describe("TXT paper extraction", () => {
  it("keeps labeled fields separate", () => {
    expect(
      R.textPaperRecord(
        "Title: A paper\nAbstract: GPU scheduling\nKeywords: hpc, kernel\nVenue: SC",
        "paper.txt",
      ),
    ).toEqual({
      title: "A paper",
      abstract: "GPU scheduling",
      keywords: "hpc, kernel",
      venue: "SC",
    });
  });

  it("uses the existing JSON record normalization", () => {
    expect(
      R.textPaperRecord(
        '{"title":"A paper","abstract":"GPU scheduling","venue":"SC"}',
        "paper.txt",
      ),
    ).toEqual({
      title: "A paper",
      abstract: "GPU scheduling",
      keywords: "",
      venue: "SC",
    });
  });

  it("uses only the first non-empty line as an unlabeled title", () => {
    expect(R.textPaperRecord("A paper title\nAbstract\nGPU scheduling", "paper.txt")).toEqual({
      title: "A paper title",
      abstract: "Abstract GPU scheduling",
      keywords: "",
      venue: "",
    });
  });

  it("falls back to the filename and preserves reference fields", () => {
    const records = [
      R.textPaperRecord("", "primary.txt"),
      R.textPaperRecord("Reference title\nReference abstract", "reference.txt"),
    ];
    expect(records[0].title).toBe("primary.txt");
    expect(records[1]).toMatchObject({ title: "Reference title", abstract: "Reference abstract" });
    expect(appRuntime()).toContain("return Recommender.textPaperRecord(text, name);");
  });
});

describe("safeExternalUrl", () => {
  it.each(["http://example.com/cfp", "https://example.com/cfp", "/cfp", "//example.com/cfp"])(
    "accepts %s",
    (value) => {
      expect(R.safeExternalUrl(value)).toBe(value);
    },
  );

  it.each(["javascript:alert(1)", "data:text/html,<script>", "vbscript:msgbox(1)", "https://"])(
    "rejects %s",
    (value) => {
      expect(R.safeExternalUrl(value)).toBe("");
    },
  );
});

describe("autoDetectCats", () => {
  it("detects LLM inference as an HPC workload", () => {
    expect(
      R.autoDetectCats(R.parsePaperLines("Decode-phase scheduling for LLM inference")),
    ).toContain("hpc");
  });

  it("detects networking", () => {
    const cats = R.autoDetectCats(
      R.parsePaperLines(
        "Credit-Based Shaping for Deterministic Latency in TSN | TSN, CBS, network, protocol, wireless, routing",
      ),
    );
    expect(cats[0]).toBe("networking");
  });

  it("TSN includes systems", () => {
    // TSN は networking と systems（real-time）の両方に判定される
    const cats = R.autoDetectCats(
      R.parsePaperLines(
        "Credit-Based Shaping for Deterministic Latency in TSN | TSN, CBS, real-time, embedded, network",
      ),
    );
    expect(cats).toContain("networking");
    expect(cats).toContain("systems");
  });

  it("empty input yields no categories", () => {
    expect(R.autoDetectCats([])).toEqual([]);
  });
});

it("breaks equal semantic scores with the strongest detected category", () => {
  const rows = [
    {
      conf: { key: "alpha", title: "Alpha", full_name: "Unrelated", categories: ["ai"] },
      cats: ["ai"],
    },
    {
      conf: { key: "zeta", title: "Zeta", full_name: "Unrelated", categories: ["hpc"] },
      cats: ["hpc"],
    },
  ];
  const ranked = R.venueRecommendations(
    rows,
    R.parsePaperLines("LLM inference"),
    { alpha: 10, zeta: 10 },
    Date.UTC(2026, 0, 1),
    { fieldedLexical: true, venueCats: ["hpc", "ai"] },
  );
  expect(ranked.find((item: any) => item.venueKey === "zeta")?.fit.semanticRank).toBe(1);
  expect(ranked.find((item: any) => item.venueKey === "alpha")?.fit.semanticRank).toBe(2);
});

describe("domain and topic signal boundaries", () => {
  it.each([
    ["training failure availability maintain", "ai", false],
    ["AI-assisted scheduling", "ai", true],
    ["machine-learning scheduler", "machine learning", true],
    ["real time systems", "real-time", true],
    ["eBPF packet processing", "ebpf", true],
    ["networking systems", "network", false],
  ])("matches %s against %s -> %s", (text, signal, expected) => {
    expect(R.signalInText(text, signal)).toBe(expected);
  });

  it("uses the same boundary matcher for auto detection and domain scoring", () => {
    const aiRow = {
      conf: { key: "ai-test", title: "AI Test", full_name: "", tags: [] },
      cats: ["ai"],
    };
    expect(
      R.autoDetectCats(R.parsePaperLines("Training failure and availability | storage")),
    ).not.toContain("ai");
    expect(R.autoDetectCats(R.parsePaperLines("AI-assisted scheduling"))).toContain("ai");
    expect(
      R.breakdown(aiRow, R.parsePaperLines("Training failure detection in storage")).agg.domain,
    ).toBe(0);
    expect(
      R.breakdown(aiRow, R.parsePaperLines("AI-assisted scheduling")).agg.domain,
    ).toBeGreaterThan(0);
  });

  it("normalizes hyphenated topic tags", () => {
    const row = {
      conf: { key: "ml-test", title: "ML Test", full_name: "", tags: ["machine-learning"] },
      cats: [],
    };
    expect(R.breakdown(row, R.parsePaperLines("A machine learning scheduler")).agg.tags).toBe(10);
    expect(readFileSync(join(REPO_ROOT, "site/template.html"), "utf8")).not.toContain(
      "var DOMAIN_SIGNAL",
    );
  });
});

describe("name matching stopwords", () => {
  it("generic words like processing do not match conference names", () => {
    // Signal Processing 等の会議名に含まれる一般語が内容語として加点されない
    const rows = [
      {
        conf: {
          key: "icassp",
          title: "ICASSP",
          full_name: "IEEE International Conference on Acoustics, Speech, and Signal Processing",
        },
        cats: [],
      },
    ];
    const lines = R.parsePaperLines(
      "Kubernetes Service Mesh with eBPF-based Packet Processing | kubernetes, ebpf, network, packet",
    );
    const b = R.breakdown(rows[0], lines);
    expect(b.agg.name).toBe(0);
    expect(b.score).toBe(0); // 分野なし・会議名一致なし → 推薦されない
  });
});

describe("venue hit", () => {
  const rows = [
    {
      conf: {
        key: "rtss",
        title: "RTSS",
        full_name: "IEEE Real-Time Systems Symposium",
        tags: ["real-time"],
      },
      cats: ["networking"],
    },
    {
      conf: { key: "sigcomm", title: "SIGCOMM", full_name: "ACM SIGCOMM", tags: [] },
      cats: ["networking"],
    },
    {
      conf: { key: "fast", title: "FAST", full_name: "USENIX FAST", tags: ["storage"] },
      cats: ["systems"],
    },
  ];
  const run = (papers: string): any[] => {
    const lines = R.parsePaperLines(papers);
    return rows
      .map((r) => ({
        key: r.conf.key,
        score: R.scorePapers(r, lines),
        hit: R.breakdown(r, lines).venueHit,
      }))
      .filter((x) => x.score >= 10)
      .sort((a, b) => b.score - a.score);
  };

  it("boosts exact conference to the top", () => {
    // 掲載先タグ一致でその会議が top に来る（投票が効いている）
    const top = run("Paper on TSN scheduling | network, protocol, real-time | RTSS");
    expect(top[0].key).toBe("rtss");
    expect(top[0].hit).toBe(true);
  });

  it("no venue tag no hit", () => {
    const top = run("Paper on TSN scheduling | network, protocol, real-time");
    expect(top[0].hit).toBe(false);
  });
});

// ---- pickRepresentative / comparePapers（論文モードの並び・集約） ----

const NOW = Date.parse("2026-08-10T00:00:00Z");

describe("sig weights: サブシグナルの重み", () => {
  const jpRow = {
    conf: {
      key: "ipsj-sigdps",
      title: "情報処理学会 DPS 研究会",
      full_name: "情報処理学会 マルチメディア通信と分散処理研究会 (SIGDPS)",
      tags: [],
    },
    cats: ["networking"],
  };

  it("jp signal defaults to 30", () => {
    const b = R.breakdown(
      jpRow,
      R.parsePaperLines("モバイルエッジ向け分散処理ミドルウェア | 分散処理, モバイル, エッジ"),
    );
    expect(b.agg.jp).toBe(30);
  });

  it("generic metadata tags (journal/workshop/niche) are excluded from tag matching", () => {
    const row = {
      conf: {
        key: "jip",
        title: "JIP",
        full_name: "Journal of Information Processing",
        tags: ["journal", "niche", "domestic-jp"],
      },
      cats: [],
    };
    // 本文に "journal" が含まれても汎用タグでは加点されない
    const b = R.breakdown(
      row,
      R.parsePaperLines("A survey of the journal publication process | survey, journal"),
    );
    expect(b.agg.tags).toBe(0);
  });

  it("topical tags still match after generic exclusion", () => {
    const row = {
      conf: {
        key: "icml",
        title: "ICML",
        full_name: "International Conference on Machine Learning",
        tags: ["machine-learning"],
      },
      cats: [],
    };
    const b = R.breakdown(
      row,
      R.parsePaperLines("Transformer scaling laws | machine learning, scaling"),
    );
    expect(b.agg.tags).toBe(10);
  });

  it("setSigWeights can override (benchmark sweep hook)", () => {
    R.setSigWeights({ jp: 15 });
    try {
      const b = R.breakdown(
        jpRow,
        R.parsePaperLines("モバイルエッジ向け分散処理ミドルウェア | 分散処理, モバイル, エッジ"),
      );
      expect(b.agg.jp).toBe(15);
    } finally {
      R.setSigWeights({ jp: 30 });
    }
    const back = R.breakdown(
      jpRow,
      R.parsePaperLines("モバイルエッジ向け分散処理ミドルウェア | 分散処理, モバイル, エッジ"),
    );
    expect(back.agg.jp).toBe(30);
  });

  it("setSigWeights nameOnce: boolean フラグを適用し先頭 1 語の固定加点になる (#265)", () => {
    R.setNameIdf(null);
    const row = {
      conf: {
        key: "t-conf",
        title: "Data Management Systems",
        full_name: "",
        tags: [],
        papers: [],
      },
      cats: [],
    };
    const lines = R.parsePaperLines("efficient data management systems for analytics");
    try {
      // 既定（nameOnce=false）: 語数比例 15 × 2 語 = 30
      R.setSigWeights({ nameOnce: false });
      expect(R.breakdown(row, lines).agg.name).toBe(30);
      // nameOnce=true: 先頭 1 語のみ固定加点 15。
      R.setSigWeights({ nameOnce: true });
      expect(R.breakdown(row, lines).agg.name).toBe(15);
    } finally {
      R.setSigWeights({ nameOnce: false });
    }
  });
});

describe("representative-paper vocabulary", () => {
  const row = (papers: string[]) => ({
    conf: {
      key: "icml",
      title: "ICML",
      full_name: "International Conference on Machine Learning",
      tags: [],
      papers,
    },
    cats: [],
  });

  it("English query matches representative-paper vocabulary (bandits -> ICML)", () => {
    const b = R.breakdown(
      row(["Thresholded Lasso Bandit"]),
      R.parsePaperLines("Batched Dueling Bandits | bandits"),
    );
    expect(b.agg.name).toBeGreaterThan(0); // 会議名語彙でなくても papers 語彙で加点
  });

  it("duplicate paper words count once (8 titles with memory -> not 8x)", () => {
    const many = ["A memory system", "B memory allocator", "C memory pool"];
    const b = R.breakdown(row(many), R.parsePaperLines("Memory management | memory"));
    // memory は 3 回現れるが重複排除はしない（IDF で減衰する設計）。
    // ここでは「語彙一致が機能している」ことだけを検証
    expect(b.agg.name).toBeGreaterThanOrEqual(15);
  });

  it("Japanese query does NOT use English representative-paper vocabulary", () => {
    // 日本語タイトルに英語キーワード（bandits）が混ざる実ケース: papers 語彙に bandits が
    // あっても日本語クエリでは一致させない（s-p が icml に奪われる誤爆の再現防止）
    const b = R.breakdown(
      {
        conf: {
          key: "icml",
          title: "ICML",
          full_name: "International Conference on Machine Learning",
          tags: [],
          papers: ["Thresholded Lasso Bandit"],
        },
        cats: [],
      },
      R.parsePaperLines("帯域付きバンディットの効率的学習 | バンディット, 機械学習, bandits"),
    );
    expect(b.agg.name).toBe(0);
  });
});

describe("buildNameIdf: 会議名と代表論文語彙の 2 マップ IDF", () => {
  it("name map: rare words weigh more than generic words", () => {
    const confs = [
      {
        key: "a",
        title: "A",
        full_name: "Conference on Bandit Learning",
        papers: ["Optimization"],
      },
      {
        key: "b",
        title: "B",
        full_name: "Workshop on Machine Learning",
        papers: ["Bandits and Optimization"],
      },
      {
        key: "c",
        title: "C",
        full_name: "Symposium on Storage Systems",
        papers: ["Distributed Bandits"],
      },
    ];
    const m = R.buildNameIdf(confs);
    // name 側: 希少語（bandit/storage/machine は df=1）> 汎用語（learning は df=2）
    expect(m.name.learning).toBeLessThan(m.name.bandit);
    expect(m.name.bandit).toBe(m.name.storage);
    // papers 側: 希少語（distributed df=1）> 汎用語（bandits/optimization df=2）
    expect(m.paper.bandits).toBeLessThan(m.paper.distributed);
    // machine は名前にしか出ない → paper マップには無い
    expect(m.paper.machine).toBeUndefined();
  });

  it("setNameIdf consumes {name, paper} maps (score scales with rarity)", () => {
    R.setNameIdf({ name: { bandits: 1.0, machine: 0.1 }, paper: { bandits: 1.0, machine: 0.1 } });
    try {
      const b = R.breakdown(
        {
          conf: {
            key: "icml",
            title: "ICML",
            full_name: "Machine Learning Conference",
            tags: [],
            papers: ["Bandits and Optimization"],
          },
          cats: [],
        },
        R.parsePaperLines("Bandits | bandits, machine"),
      );
      // name: machine 15×0.1=2、paper: bandits 15×1.0=15 → 合計 17
      expect(b.agg.name).toBe(17);
    } finally {
      R.setNameIdf(null);
    }
  });

  it("paperCap caps representative-paper hits per line", () => {
    R.setSigWeights({ paperCap: 2 });
    try {
      const conf = {
        key: "rtss",
        title: "RTSS",
        full_name: "The IEEE Real-Time Systems Symposium",
        tags: [],
        papers: [
          "Real-Time Vision Model Serving",
          "Memory Analysis for Multicore Systems",
          "Resource Control in Distributed Networks",
        ],
      };
      // クエリは papers 語に 3 語一致するが paperCap=2 で 2 語ぶんだけ加点される
      const b = R.breakdown(
        { conf, cats: [] },
        R.parsePaperLines("vision memory resource | vision, memory, resource"),
      );
      const uncapped = R.breakdown(
        { conf, cats: [] },
        R.parsePaperLines("vision memory resource | vision, memory, resource"),
      );
      // paperCap なし（999）との差分 = 3 語目（約 paper 重み 15）が落ちる
      R.setSigWeights({ paperCap: 999 });
      const full = R.breakdown(
        { conf, cats: [] },
        R.parsePaperLines("vision memory resource | vision, memory, resource"),
      );
      expect(b.agg.name).toBe(uncapped.agg.name);
      expect(full.agg.name).toBeGreaterThan(b.agg.name);
    } finally {
      R.setSigWeights({ paperCap: 4 });
    }
  });
});

describe("pickRepresentative", () => {
  it("prefers future deadline over past", () => {
    // 同一会議に過去締切と未来締切があるとき未来を代表にする
    const picked = R.pickRepresentative(
      [
        {
          conf: { key: "rtss" },
          kind: "paper",
          t: Date.parse("2026-05-22T23:59:59Z"),
          tLast: Date.parse("2026-05-22T23:59:59Z"),
        },
        {
          conf: { key: "rtss" },
          kind: "paper",
          t: Date.parse("2027-05-20T23:59:59Z"),
          tLast: Date.parse("2027-05-20T23:59:59Z"),
        },
      ],
      NOW,
    );
    expect(picked.map((p: any) => p.t)).toEqual([Date.parse("2027-05-20T23:59:59Z")]);
  });

  it("prefers deadline over event", () => {
    const picked = R.pickRepresentative(
      [
        {
          conf: { key: "foo" },
          kind: "event",
          t: Date.parse("2026-08-15T00:00:00Z"),
          tLast: Date.parse("2026-08-17T00:00:00Z"),
        },
        {
          conf: { key: "foo" },
          kind: "paper",
          t: Date.parse("2026-09-01T23:59:59Z"),
          tLast: Date.parse("2026-09-01T23:59:59Z"),
        },
      ],
      NOW,
    );
    expect(picked.map((p: any) => p.kind)).toEqual(["paper"]);
  });

  it("keeps distinct venues", () => {
    const picked = R.pickRepresentative(
      [
        { conf: { key: "a" }, kind: "paper", t: NOW + 1 },
        { conf: { key: "b" }, kind: "paper", t: NOW + 2 },
      ],
      NOW,
    );
    expect(picked.map((p: any) => p.conf.key).sort()).toEqual(["a", "b"]);
  });
});

describe("rankMatches", () => {
  it("matches the exact grade across schemes", () => {
    expect(R.rankMatches(["ccf:A", "core:A*", "thcpl:A"], "A")).toBe(true);
    expect(R.rankMatches(["ccf:B", "core:A*"], "B")).toBe(true);
    expect(R.rankMatches(["core:A*"], "A*")).toBe(true);
    expect(R.rankMatches(["ccf:N"], "N")).toBe(true);
  });

  it("A* is not A (regression: substring indexOf matched core:A*)", () => {
    expect(R.rankMatches(["ccf:B", "core:A*"], "A")).toBe(false);
    expect(R.rankMatches(["ccf:N", "core:A*", "thcpl:N"], "A")).toBe(false);
  });

  it("no pairs never match", () => {
    expect(R.rankMatches([], "A")).toBe(false);
    expect(R.rankMatches(undefined, "A")).toBe(false);
  });
});

describe("journalRows", () => {
  it("creates rows only for always-open journals", () => {
    const confs = [
      {
        key: "j1",
        title: "Journal A",
        full_name: "Full Name of Journal A",
        tags: ["journal"],
        rank: { ccf: "A", core: "A*" },
        editions: [],
      },
      {
        key: "si",
        title: "Special Issue",
        tags: ["special-issue"],
        editions: [{ deadlines: [{ utc: "2026-09-01T00:00:00Z" }] }],
      },
      { key: "c1", title: "Conf A", tags: [], editions: [] },
    ];
    const rows = R.journalRows(confs, NOW);
    expect(rows.map((r: any) => r.conf.key)).toEqual(["j1"]);
    expect(rows[0].kind).toBe("journal");
    expect(rows[0].t).toBe(NOW);
    expect(rows[0].dl.label).toBe("");
    expect(rows[0].rankPairs).toEqual(["ccf:A", "core:A*"]);
    expect(rows[0].hay).toContain("journal a");
    expect(rows[0].hay).toContain("full name of journal a");
    expect(rows[0].hay).toContain("j1");
    expect(rows[0].hay).toContain("常時受付");
  });

  it("hay supports keyword search without throwing", () => {
    const confs = [
      {
        key: "tocs",
        title: "TOCS",
        full_name: "ACM Transactions on Computer Systems",
        tags: ["journal"],
        rank: { ccf: "A" },
        editions: [],
      },
    ];
    const rows = R.journalRows(confs, NOW);
    expect(rows[0].hay.indexOf("tocs") >= 0).toBe(true);
    expect(rows[0].hay.indexOf("transactions") >= 0).toBe(true);
    expect(rows[0].hay.indexOf("nonexistent") >= 0).toBe(false);
    expect(R.rankMatches(rows[0].rankPairs, "A")).toBe(true);
    expect(R.rankMatches(rows[0].rankPairs, "A*")).toBe(false);
  });

  it("journal with deadlines stays a deadline row", () => {
    const confs = [
      {
        key: "j2",
        title: "Journal B",
        tags: ["journal"],
        editions: [{ deadlines: [{ utc: "2026-12-01T00:00:00Z" }] }],
      },
    ];
    expect(R.journalRows(confs, NOW)).toEqual([]);
  });
});

describe("分野の日本語表示名と検索語 (SPEC §7)", () => {
  it("categoryLabelJa は日本語名を返し、未知のキーはそのまま返す", () => {
    expect(R.categoryLabelJa("networking")).toBe("ネットワーク");
    expect(R.categoryLabelJa("hpc")).toBe("高性能計算");
    expect(R.categoryLabelJa("security")).toBe("セキュリティ");
    expect(R.categoryLabelJa("unknown-field")).toBe("unknown-field");
    expect(R.categoryLabelJa(undefined)).toBe("");
  });

  it("config.yaml の categories 分野はすべて日本語名を持つ", () => {
    const config = loadYaml(readFileSync(join(REPO_ROOT, "config.yaml"), "utf8")) as {
      categories: Record<string, string>;
    };
    const keys = Object.keys(config.categories);
    expect(keys.length).toBeGreaterThanOrEqual(9);
    const missing = keys.filter((k) => R.categoryLabelJa(k) === k);
    expect(missing, `分野 ${missing.join(", ")} の日本語名が未定義`).toEqual([]);
  });

  it("検索語に分野の日本語名と国内を含める（チップ使わず検索だけで絞り込める）", () => {
    const confs = [
      {
        key: "sigops-atc",
        title: "SIGOPS ATC",
        categories: ["systems", "hpc"],
        tags: [],
        editions: [
          {
            year: 2026,
            deadlines: [{ kind: "paper", utc: "2026-09-01T23:59:00Z" }],
          },
        ],
      },
      {
        key: "ieice-cq",
        title: "電子情報通信学会 CQ研究会",
        categories: ["networking"],
        tags: ["domestic-jp"],
        editions: [
          {
            year: 2026,
            deadlines: [{ kind: "paper", utc: "2026-09-10T04:00:00Z" }],
          },
        ],
      },
    ];
    const rows = R.candidateRows(confs);
    const atc = rows.find((r: any) => r.conf.key === "sigops-atc");
    const cq = rows.find((r: any) => r.conf.key === "ieice-cq");
    expect(atc.hay).toContain("システム");
    expect(atc.hay).toContain("高性能計算");
    expect(atc.hay).not.toContain("国内");
    expect(cq.hay).toContain("ネットワーク");
    expect(cq.hay).toContain("国内");
    expect(cq.hay).toContain("domestic");
  });

  it("常時受付ジャーナル行にも分野の日本語名を入れる", () => {
    const confs = [
      {
        key: "j-sec",
        title: "Journal of Security",
        categories: ["security"],
        tags: ["journal"],
        editions: [],
      },
    ];
    const rows = R.journalRows(confs, NOW);
    expect(rows[0].hay).toContain("セキュリティ");
  });

  it("officialZone は公式表記を JST / UTC / AoE に寄せ、未知は原文のまま", () => {
    // JST 宣言の国内締切に AoE を併記しない判定の正本。
    expect(R.officialZone({ tz_raw: "AoE" })).toBe("AoE");
    expect(R.officialZone({ tz_raw: "JST" })).toBe("JST");
    expect(R.officialZone({ tz_raw: "UTC+9" })).toBe("JST");
    expect(R.officialZone({ tz_raw: "Asia/Tokyo" })).toBe("JST");
    expect(R.officialZone({ tz_raw: "UTC" })).toBe("UTC");
    expect(R.officialZone({ tz_raw: " PT " })).toBe("PT");
    expect(R.officialZone({ tz_raw: null })).toBe("");
    expect(R.officialZone({})).toBe("");
    expect(R.officialZone(null)).toBe("");
  });

  describe("検索の表記ゆれ吸収（NFKC と複数語 AND）", () => {
    it("全角英数・全角記号・全角スペースを半角に寄せる", () => {
      expect(R.searchNormalize("ＮＳＤＩ")).toBe("nsdi");
      expect(R.searchNormalize("ＮＳＤＩ　２０２７")).toBe("nsdi 2027");
      expect(R.searchNormalize("  NSDI   Symposium ")).toBe("nsdi symposium");
      expect(R.searchNormalize("ﾄｳｷｮｳ")).toBe("トウキョウ");
      expect(R.searchNormalize(null)).toBe("");
      expect(R.searchNormalize(undefined)).toBe("");
    });

    it("検索語は空白で語に割って重複を除く", () => {
      expect(R.queryTokens("ネットワーク　システム")).toEqual(["ネットワーク", "システム"]);
      expect(R.queryTokens("NSDI nsdi")).toEqual(["nsdi"]);
      expect(R.queryTokens("   ")).toEqual([]);
      expect(R.queryTokens(null)).toEqual([]);
    });

    it("hayMatches は全語が含まれるときだけ真（語順と間隔は問わない）", () => {
      const hay = "usenix symposium on networked systems design and implementation nsdi";
      expect(R.hayMatches(hay, "networked systems")).toBe(true);
      expect(R.hayMatches(hay, "systems networked")).toBe(true);
      // 連結文字列探しのままでは "systems networked" は当たらない（AND 判定へ変えた根拠）。
      expect(hay.indexOf("systems networked")).toBeLessThan(0);
      expect(R.hayMatches(hay, "networked security")).toBe(false);
      // 全角入力も同じ結果にする。
      expect(R.hayMatches(hay, "ＮＳＤＩ")).toBe(true);
      expect(R.hayMatches(hay, "")).toBe(true);
      expect(R.hayMatches(undefined, "nsdi")).toBe(false);
    });

    it("行の検索語（hay）は正規化した形で保持される", () => {
      const confs = [
        {
          key: "demo",
          title: "Demo Symposium on Networks",
          full_name: "Demo Symposium on Networks (DEMO)",
          categories: ["networking"],
          tags: [],
          editions: [
            {
              year: 2026,
              place: "Tokyo, Japan",
              deadlines: [{ kind: "paper", utc: "2026-09-01T23:59:00Z" }],
            },
          ],
        },
      ];
      const row = R.candidateRows(confs)[0];
      expect(row.hay).toBe(R.searchNormalize(row.hay));
      // 英語会議名・分野の日本語名・開催地の日本語名を混ぜて打っても同時に引ける。
      expect(R.hayMatches(row.hay, "ネットワーク tokyo")).toBe(true);
      expect(R.hayMatches(row.hay, "日本 symposium")).toBe(true);
      expect(R.hayMatches(row.hay, "ネットワーク 存在しない語")).toBe(false);
    });
  });

  describe("相対月での検索（expandRelativeMonths）", () => {
    const now = Date.parse("2026-09-22T09:00:00+09:00"); // JST 2026-09-22

    it("今月・来月・再来月・先月を JST の暦月へ解決する", () => {
      expect(R.expandRelativeMonths("今月", now)).toBe("2026年9月");
      expect(R.expandRelativeMonths("来月", now)).toBe("2026年10月");
      expect(R.expandRelativeMonths("再来月", now)).toBe("2026年11月");
      expect(R.expandRelativeMonths("先月", now)).toBe("2026年8月");
      expect(R.expandRelativeMonths("先々月", now)).toBe("2026年7月");
    });

    it("年をまたいでも月だけ進める", () => {
      // 12 月の来月は翌年 1 月。日付を足して月を計算すると 3 月に飛ぶ。
      expect(R.expandRelativeMonths("来月", Date.parse("2026-12-15T00:00:00+09:00"))).toBe(
        "2027年1月",
      );
      expect(R.expandRelativeMonths("来月", Date.parse("2026-01-05T00:00:00+09:00"))).toBe(
        "2026年2月",
      );
      // JST の境界（UTC 9/30 16:00 = JST 10/1）では 10 月が今月。
      expect(R.expandRelativeMonths("今月", Date.parse("2026-09-30T16:00:00Z"))).toBe("2026年10月");
    });

    it("相対月以外の語はそのまま、語のかけ算も壊さない", () => {
      expect(R.expandRelativeMonths("再来月 国内", now)).toBe("2026年11月 国内");
      expect(R.expandRelativeMonths("機械学習", now)).toBe("機械学習");
      // 全角は半角・小文字へ畳まれる（検索の正規化と同じ規則）。
      expect(R.expandRelativeMonths("ＮＳＤＩ", now)).toBe("nsdi");
      expect(R.expandRelativeMonths("", now)).toBe("");
      // 展開先は月語の検索インデックス（monthTermsJa）と同じ形なので当たり方が揃う。
      const hay = `電子情報通信学会 NS 研究会 ${R.monthTermsJa("2026-10-07")}`;
      expect(R.hayMatches(hay, R.expandRelativeMonths("来月", now))).toBe(true);
    });
  });

  describe("会場表記から都道府県で引く（placePrefectureJa / placeWithPrefectureJa）", () => {
    it("都道府県が書かれていない会場名にも土地の語を足す", () => {
      // 収録済みの国内会議の会場表記で実際に起きている例のみ。
      expect(R.placePrefectureJa("倉敷市芸文館")).toBe("岡山 岡山県");
      expect(R.placePrefectureJa("名古屋大学 基盤センター２F演習室")).toBe("愛知 愛知県");
      expect(R.placePrefectureJa("北九州市（FIT2026）")).toBe("福岡 福岡県");
      expect(R.placePrefectureJa("能登方面の予定（ハイブリッド）")).toBe("石川 石川県");
    });

    it("都道府県が既に分かる表記では二重に補わない", () => {
      expect(R.placeWithPrefectureJa("倉敷市芸文館")).toBe("倉敷市芸文館 岡山県");
      expect(R.placeWithPrefectureJa("島根県立産業交流会館 くにびきメッセ（島根県松江市）")).toBe(
        "島根県立産業交流会館 くにびきメッセ（島根県松江市）",
      );
      expect(R.placeWithPrefectureJa("高知工科大学 香美キャンパス（高知県香美市）")).toBe(
        "高知工科大学 香美キャンパス（高知県香美市）",
      );
      expect(R.placeWithPrefectureJa("花びしホテル（北海道 函館）")).toBe(
        "花びしホテル（北海道 函館）",
      );
    });

    it("土地と読めない値は補わない", () => {
      expect(R.placePrefectureJa("未定")).toBe("");
      expect(R.placePrefectureJa("Japan")).toBe("");
      expect(R.placeWithPrefectureJa("")).toBe("");
      expect(R.placeWithPrefectureJa(null)).toBe("");
    });

    it("県名・かなのどちらで打っても引ける", () => {
      const terms = R.placePrefectureJa("倉敷市芸文館");
      expect(R.hayMatches(`倉敷市芸文館 ${terms}`, "岡山")).toBe(true);
      expect(R.hayMatches(`倉敷市芸文館 ${terms}`, "岡山県")).toBe(true);
      expect(R.hayMatches(`倉敷市芸文館 ${terms}`, "おかやま")).toBe(true);
      // 別の県では当たらない（都市名の語を勝手に広げない）。
      expect(R.hayMatches(`倉敷市芸文館 ${terms}`, "広島")).toBe(false);
    });
  });

  describe("月での検索（monthTermsJa）", () => {
    it("締切は JST の暦日から月語を作る", () => {
      // 2026-09-30 16:00 UTC = JST 2026-10-01 01:00。一覧の日時列と同じ暦日で読む。
      expect(R.monthTermsJa(Date.parse("2026-09-30T16:00:00Z"))).toBe("2026年10月 10月");
      expect(R.monthTermsJa(Date.parse("2026-12-25T15:00:00Z"))).toBe("2026年12月 12月");
      expect(R.monthTermsJa(Date.parse("2026-12-25T14:00:00Z"))).toBe("2026年12月 12月");
    });

    it("日付だけの値は閲覧者のタイムゾーンに依存しない", () => {
      expect(R.monthTermsJa("2027-01-21")).toBe("2027年1月 1月");
      expect(R.monthTermsJa("2026-12-01")).toBe("2026年12月 12月");
    });

    it("暦日として読めない値には月語を付けない", () => {
      expect(R.monthTermsJa("2026-13-01")).toBe("");
      expect(R.monthTermsJa("June 7-11, 2027")).toBe("");
      expect(R.monthTermsJa(null)).toBe("");
      expect(R.monthTermsJa(Number.NaN)).toBe("");
      // 存在しない月語は作らないので、`13月` では何もヒットしない。
      expect(R.monthTermsJa("2026-02-30")).toBe("");
    });
  });

  describe("かな表記と土地名での検索（kanaFold / queryTokenGroups）", () => {
    it("カタカナ・長音符・小文字の揺れを吸収する", () => {
      expect(R.hayMatches("情報ネットワークと分散処理", "ねっとわーく")).toBe(true);
      expect(R.hayMatches("情報ネットワークと分散処理", "ネットワーク")).toBe(true);
      expect(R.hayMatches("情報ネットワークと分散処理", "ネツトワーク")).toBe(true);
      expect(R.kanaFold("ネットワーク")).toBe(R.kanaFold("ねっとわーく"));
      // 畳むのはかなの表記差だけ（漢字の読みは都道府県の一覧表で扱う）。
      expect(R.kanaFold("オタル")).toBe("おたる");
      // 畳んだあとも拉丁語の照合は変わらない。
      expect(R.hayMatches("NSDI 2027", "nsdi")).toBe(true);
    });

    it("ひらがな・カタカナの土地名を都道府県へ展開する", () => {
      expect(R.hayMatches("沖縄産業支援センター（沖縄県）", "おきなわ")).toBe(true);
      expect(R.hayMatches("国立京都国際会館", "キョウト")).toBe(true);
      expect(R.hayMatches("東北大学 電気通信研究所（宮城県）", "みやぎ")).toBe(true);
      expect(R.hayMatches("函館サーモン・まるなまアリーナ（北海道）", "ほっかいどう")).toBe(true);
      // 土地名になっていない語は展開しない（誤爆を防ぐ）。
      expect(R.queryTokenGroups("ネットワーク")).toEqual([["ネットワーク"]]);
    });

    it("地方名は構成する都道府県のいずれかにhitsする", () => {
      expect(R.hayMatches("高知工科大学 香美キャンパス（高知県香美市）", "しこく")).toBe(true);
      expect(R.hayMatches("米子コンベンションセンター（鳥取県）", "ちゅうごくちほう")).toBe(true);
      expect(R.hayMatches("飛騨・世界生活文化センター（岐阜県）", "かんとう")).toBe(false);
      /* 「中国」は国名と衝突するから素では展開しない、という扱いだった時期があるが、
       * 国名の行は語そのもので既に当たるので、展開しなくても混ざり方は同じだった
       * （違うのは地方の行が出るかどうかだけ）。2026-09-23 に広げ方針へ変え、
       * どちらを探しているかは件数欄に出す。地方だけに絞りたい人の入口は
       * `中国地方` のままなので、その人が損をすることはない。 */
      const china = R.queryTokenGroups("中国")[0].map(String);
      for (const pref of ["鳥取", "島根", "岡山", "広島", "山口"]) {
        expect(china, pref).toContain(pref);
      }
      expect(china).toContain("中国");
      // 地方だけの入口は地方だけ（国名側へは展開しない）。
      const chugoku = R.queryTokenGroups("中国地方")[0].map(String);
      expect(chugoku).toContain("鳥取");
      expect(chugoku.filter((w: string) => w.startsWith("よーろっぱ"))).toEqual([]);
    });

    it("語ごとの AND は保ったまま候補を増やす", () => {
      // かな見出しは漢字見出しが持つ英文字表記の寄せも受け取る（`おきなわ` → `okinawa`）。
      // 開催地は公式表記のまま残るので、これがないと漢字で出る行がかなで出なかった。
      expect(R.queryTokenGroups("おきなわ オンライン")).toEqual([
        ["おきなわ", "沖縄", "okinawa"],
        ["オンライン"],
      ]);
      expect(R.hayMatches("沖縄産業支援センター（沖縄県）", "おきなわ 研究会")).toBe(false);
      expect(
        R.hayMatches("沖縄産業支援センター（沖縄県）／オンライン", "おきなわ オンライン"),
      ).toBe(true);
      // 展開が既存のヒットを消さない（候補は OR で増やすだけ）。
      expect(R.hayMatches("Networking, 東京", "とうきょう")).toBe(true);
    });
  });

  describe("分野の言い方を書く（英文字表記の収録にも届く。第 2 群）", () => {
    /* 口の利かれる分野の語なのに、収録側の表記が英文字だというだけの理由で 0 件になる
     * 群があった（2026-09-23 実測: 「リアルタイム」「プログラミング言語」「脆弱性」などは
     * いずれも 0 件で、同じ意味の英文字表記は数件〜数十件当たっていた）。
     * 「収録に無い」と「打ち方が通じない」を区別できないと、そこで検索をやめてしまう。 */
    it("かな・漢字の分野語が英文字表記と同じ組になる", () => {
      const groups = (q: string) => R.queryTokenGroups(q)[0];
      expect(groups("リアルタイム")).toContain("real-time");
      // 「実時間」は学会の書き方なので、こちらからも引けるようにする。
      expect(groups("実時間")).toContain("real-time");
      expect(groups("プログラミング言語")).toContain("programming language");
      expect(groups("計算機アーキテクチャ")).toContain("computer architecture");
      expect(groups("侵入検知")).toContain("intrusion detection");
      expect(groups("脆弱性")).toContain("vulnerability");
      expect(groups("バイオインフォマティクス")).toContain("bioinformatics");
      expect(groups("エッジコンピューティング")).toContain("edge computing");
    });

    it("長音の書き方が違っても同じ結果になる", () => {
      // 展開語の一覧には相手の表記も入るので「同じ組」にはならない。確かめるのは
      // 展開の語ではなく**同じ行に出会う**こと。
      const hays = [
        "acm conference on human factors in computing systems user interface technology",
        "hci letters on user interface design",
        "ネットワークの会議",
      ];
      const hits = (q: string) => hays.filter((h) => R.hayMatches(h, q));
      expect(hits("ユーザインタフェース")).toEqual(hits("ユーザインターフェース"));
      expect(hits("ユーザインタフェース").length).toBeGreaterThan(0);
      expect(R.queryTokenGroups("ユーザインタフェース")[0]).toContain("user interface");
    });

    it("収録に無い語順の寄せは作らない（死んだ寄せを置かない）", () => {
      /* `画像認識` は英文字側が `image recognition` の語順で収録に現れないので入れていない
       * （当たった 3 行は `graphics, patterns and images` + 別箇所の `recognition`）。
       * 別表記は「打てば行が増える」ためだけに置く、という表の約束を守る。 */
      const group = R.queryTokenGroups("画像認識")[0];
      expect(group).not.toContain("image recognition");
      // 代わりに使える語は生きている（`画像` は英文字の `image` に、
      // `パターン認識` は英文字の `pattern recognition` に寄せてある）。
      expect(
        R.hayMatches("ieee international conference on pattern recognition", "パターン認識"),
      ).toBe(true);
      expect(R.queryTokenGroups("画像")[0]).toContain("image");
    });
  });

  describe("開催市の日本語の言い方（アクセント付きの表記にも届く）", () => {
    /* 海外の出張先はカタカナで覚えるのが普通。収録側は `Cancún` `Malmö` `Kraków` のように
     * アクセント付きで書くが、検索はアクセントを捨てるので、アクセント記号を除いたつづりに寄せる。
     * （2026-09-23 実測: `カンクン` で引く人が 0 件に当たっていた。収録 23 行あるのに）。 */
    it("カタカナの都市名がアクセント付きの収録表記に届く", () => {
      const group = (q: string) => R.queryTokenGroups(q)[0];
      expect(group("カンクン")).toContain("cancun");
      expect(group("マルメ")).toContain("malmo");
      expect(group("テュービンゲン")).toContain("tubingen");
      expect(group("クラクフ")).toContain("krakow");
      expect(group("ロングビーチ")).toContain("long beach");
      // 開き直しの許す寄せは上で既に定義済み（ここでの再掲はしない）。
      expect(group("ワシントン")).toContain("washington");
    });

    it("表記が迷う語を推測で足さない", () => {
      // `アンタルヤ` / `シャニア` は日本語表記が定着していないので寄せていない。
      expect(R.queryTokenGroups("アンタルヤ")).toEqual([["アンタルヤ"]]);
      expect(R.queryTokenGroups("シャニア")).toEqual([["シャニア"]]);
    });
  });

  describe("略称と年を離して打つ（`NSDI 27`）", () => {
    /* 貼り付けて打つ形は既に通っていたが、実務ではスペースで切る入力がふつう多い
     * （2026-09-23 実測: `NSDI 27` `ICDE 27` はいずれも 0 件で、`NSDI 2027` は出ていた）。 */
    const groupsOf = (q: string) => R.queryTokenGroups(q);

    it("同じ入力に略称があるときだけ、裸の 2 桁を年としても見る", () => {
      const [abbr, year] = groupsOf("NSDI 27");
      expect(abbr[0]).toBe("nsdi");
      expect(year).toContain("27");
      expect(year).toContain("2027");
      // 裸の 2 桁は暦日（27日）のままとする。年として広げない。
      expect(groupsOf("27")[0]).not.toContain("2027");
      // 月日を打っている入力も年として扱わない（`8月 27` は 8/27 の話）。
      groupsOf("8月 27").forEach((group: string[]) => {
        expect(group).not.toContain("2027");
      });
    });

    it("離して打った入力が、年に 4 桁を打ったときと同じ行を出す", () => {
      const hay = "usenix conference on networked systems design and implementation nsdi 2027";
      expect(R.hayMatches(hay, "NSDI 27")).toBe(true);
      expect(R.hayMatches(hay, "NSDI 2027")).toBe(true);
      expect(R.hayMatches(hay, "NSDI 26")).toBe(false);
    });
  });

  describe("分野の言い方を書く（第 3 群: 英語表記しか収録に無い語）", () => {
    /* 同じ型の調べものを続けた群（2026-09-23 実測: `プライバシー` は日本語 0 件で
     * `privacy` は 116 行、`データマイニング` は 162/183 行、`プロトコル` は 0/22 行）。 */
    it("漢字・カタカナの分野語が英文字表記と同じ組になる", () => {
      const group = (q: string) => R.queryTokenGroups(q)[0];
      expect(group("プライバシー")).toContain("privacy");
      expect(group("医療")).toContain("medical");
      // 「医用」と「医療」は同じ英文字表記に寄せる（学会の書き方の差）。
      expect(group("医用")).toContain("medical");
      expect(group("データマイニング")).toContain("data mining");
      expect(group("推論")).toContain("reasoning");
      expect(group("プロトコル")).toContain("protocol");
      expect(group("知識グラフ")).toContain("knowledge graph");
    });

    it("収録の英文字より狭い日本語は置かない（`自動運転` の代わりに `自律`）", () => {
      // 収録側の英文字は `autonomous` で、自律システムまで含む。`自動運転` に寄せると
      // 当たらない語を約束することになるので、日本語の対応が広い側の語を置いた。
      expect(R.queryTokenGroups("自動運転")).toEqual([["自動運転"]]);
      expect(R.queryTokenGroups("自律")[0]).toContain("autonomous");
    });
  });

  describe("日本開催の行を漢字で引く", () => {
    /* 国内の行はローマ字をそのまま打つ人が少ない。収録の日本開催で行われた
     * `Aizuwakamatsu` の 2 行だけが、どの日本語の言い方でも届いていなかった
     * （2026-09-23 実測）。 */
    const group = (q: string) => R.queryTokenGroups(q)[0];

    it("市区郡と会場名の漢字が、収録のローマ字表記に届く", () => {
      expect(group("会津若松")).toContain("aizuwakamatsu");
      expect(group("会津")).toContain("aizuwakamatsu");
      // 会場名で行を書いている回（表には `Hitotsubashi Hall, 東京, 日本` と出る）。
      expect(group("一橋講堂")).toContain("hitotsubashi hall");
      expect(group("日本科学未来館")).toContain("miraikan");
      expect(group("未来館")).toContain("miraikan");
    });

    it("寄せ済みは公式の表記どおりで、行の無い地名は置かない", () => {
      // `Miyakojima`（FC の回）は既に寄せてある。公式の表記は "Miyakojima, Japan"
      // （fc25.ifca.ai）なので、日本語は `宮古島` が対応する。
      expect(group("宮古島")).toContain("miyakojima");
      // `宮島`（広島の厳島）に当たる行は収録に無いので置いていない。
      expect(R.queryTokenGroups("宮島")).toEqual([["宮島"]]);
    });
  });

  describe("ラウンドの語が画面の書き方で引ける", () => {
    /* 表の種別セルと行の詳細は「第 2 ラウンド」と書く。CSV は `R1` `R2`。
     * どちらも検索用の文字列に入れていなかったので、画面の語を写すと当たらなかった
     * （2026-09-23 実測: 2 ラウンドの行は 387 件あるのに「R2」3 件、「第2」5 件）。 */
    it("画面の書き方と CSV の表記の両方を含む", () => {
      expect(R.roundSearchTerms(2)).toEqual(["第2ラウンド", "第 2 ラウンド", "r2"]);
      expect(R.roundSearchTerms(1)).toContain("r1");
      // ラウンドの無い入力は語を増やさない。
      expect(R.roundSearchTerms(undefined)).toEqual([]);
      expect(R.roundSearchTerms(0)).toEqual([]);
    });

    it("画面どおりにスペースを入れて写すと 1 まとめの語に寄せる", () => {
      // そのまま割ると 「第」 AND「2」 AND「ラウンド」 になり、全件に化ける。
      expect(R.queryTokenGroups("第 2 ラウンド")).toEqual([["第2ラウンド"]]);
      expect(R.queryTokenGroups("第2ラウンド")).toEqual([["第2ラウンド"]]);
      // 他の語は従来どおり別グループ（AND は保つ）。
      const groups = R.queryTokenGroups("第 2 ラウンド スパコン");
      expect(groups.length).toBe(2);
      expect(groups[0]).toEqual(["第2ラウンド"]);
      // 別の年の入力を巻き込まない（2026-09-23 の略称+年の扱いとの取り違え防止）。
      expect(R.queryTokenGroups("nsdi 27").length).toBe(2);
    });
  });

  describe("中黒で並んだ語をそのまま写す（件数欄・CSV・行の詳細の分野列）", () => {
    /* 件数欄・CSV・行の詳細は分野を `人工知能・データベース` のように・で並べて書く。
     * そのまま写すと 1 語になって 0 件に当たっていた（2026-09-23 実測: ・付きの分野列を
     * 持つ行は収録 397 行あったのに、写した語は全部 0 件）。 */
    it("・ で区切った語は別グループ（両方持つ行を探す）", () => {
      const groups = R.queryTokenGroups("人工知能・データベース");
      expect(groups.length).toBe(2);
      // それぞれは単独で打ったときと同じexpandedを持つ（英語表記にも届く）。
      expect(groups[0]).toEqual(R.queryTokenGroups("人工知能")[0]);
      expect(groups[1]).toEqual(R.queryTokenGroups("データベース")[0]);
      // AND なので、どちらか一方だけの行は出ない。
      expect(R.hayMatches("artificial intelligence ai 人工知能", "人工知能・データベース")).toBe(
        false,
      );
      expect(
        R.hayMatches(
          "artificial intelligence 人工知能 database データベース",
          "人工知能・データベース",
        ),
      ).toBe(true);
      // ・ だけの入力は語を作らない（全件に化けない）。
      expect(R.queryTokenGroups("・")).toEqual([]);
    });

    it("他の並べ語と句読点でも切る（画面の古い書き方・表計算からの貼付）", () => {
      // 行の詳細は以前、分野を全角コンマで並べていた（`人工知能，データベース`）。
      // 写した語が 1 語扱いで 0 件に当たっていた（2026-09-23 実測）。
      for (const q of ["人工知能，データベース", "人工知能、データベース"]) {
        const groups = R.queryTokenGroups(q);
        expect(groups.length, q).toBe(2);
        expect(groups[0]).toEqual(R.queryTokenGroups("人工知能")[0]);
        expect(groups[1]).toEqual(R.queryTokenGroups("データベース")[0]);
      }
      // `AI/ML` のように自分で区切って打つ入力も 2 語として扱う。
      // （変更前は `ai/ml` が 1 語になり 0 件だった。）
      expect(R.queryTokenGroups("ai/ml").length).toBe(2);
      // カンマは表計算からの貼付でも入る。
      expect(R.queryTokenGroups("ai, security").length).toBe(2);
    });

    it("並べ語だけの入力は語を作らない", () => {
      // `，` だけの入力は「カンマを含む行」全件（3,014 件）に化けていた。
      // 句読点だけでは絞り込まない（空入力と同じく語を作らない）。
      expect(R.queryTokenGroups("，")).toEqual([]);
      expect(R.queryTokenGroups("、")).toEqual([]);
      expect(R.queryTokenGroups("/")).toEqual([]);
      expect(R.queryTokenGroups("／")).toEqual([]);
    });

    it("ラウンドの語と組み合わせても壊れない", () => {
      // `スパコン・第 2 ラウンド` のように、サイトの語を続けて書いても各語が立つ。
      const groups = R.queryTokenGroups("スパコン・第 2 ラウンド");
      expect(groups.some((g: string[]) => g.indexOf("第2ラウンド") >= 0)).toBe(true);
      expect(groups.length).toBe(R.queryTokenGroups("スパコン 第 2 ラウンド").length);
    });
  });

  describe("同じ書き方の場所が複数ある語を件数欄でおしらせする", () => {
    /* 「バリ」はイタリアの bari とインドネシアの bali の両方に当たる（違う場所を足して
     * いる）。行の開催地は公式の英文字表記のまま残るので、おしらせがないと
     * 「なぜこの行が出たか」が画面のどこにも出なかった（2026-09-23 実測: 空）。
     * 1 とおりの寄せ（`クラクフ` → `krakow`）は精密に引けているので付けない
     * ——地域まとめの検査が「精密に引ける語には付けない」と見ているのと同じ規則。 */
    it("複数の英文字表記に寄るときだけおしらせを出す", () => {
      const note = R.querySynonymNotes("バリ").join("");
      expect(note).toContain("bari");
      expect(note).toContain("bali");
      // 1 とおりの寄せには付けない（既存の規則）。
      expect(R.querySynonymNotes("クラクフ")).toEqual([]);
      expect(R.querySynonymNotes("会津若松")).toEqual([]);
      // 表示側で日本語に寄せる語（国名など）も書かない（画面に既に日本語で出る）。
      expect(R.querySynonymNotes("日本").join("")).not.toContain("開催地");
    });

    it("長音の書き方が違う条目が同じ寄せ先くるとき、同じ語を並べない", () => {
      // 変更前は「英語で書かれた会議名（user interface / user interface など）」だった。
      const note = R.querySynonymNotes("ユーザインタフェース").join("");
      expect(note.match(/user interface/g)?.length).toBe(1);
      expect(note).toContain("user interface");
    });

    it("分野の寄せ説明と重なって二重にならない", () => {
      const notes = R.querySynonymNotes("スパコン");
      expect(notes.length).toBe(1);
      expect(notes[0]).toContain("分野");
    });
  });

  describe("月と日で引いたとき、隣の月日が混ざらない", () => {
    /* `12月` で絞ったのに 11 月の締切が混ざっていた（2026-09-23 実測: 「1月」の当たり
     * 892 件のうち 526 件が 1 月と無関係、「2月」も 394 件、「1日」は 287 件）。
     * 照合が部分一致なので `1月` が `11月` に当たっていた。先頭を空白で締める手は
     * `searchNormalize` が trim して素の語に戻った（実測で無効）。なので **hay に
     * 出ている和暦付きの形**（月の語は `2026年12月`、日の語は `8月10日`）へ展開する。 */
    it("月語は和暦付きの形に展開する", () => {
      const group = R.queryTokenGroups("1月")[0];
      expect(group).toContain("2026年1月");
      // 素の語を残すと隣の月に当たるので使わない。
      expect(group).not.toContain("1月");
      expect(group.every((t: string) => /^[0-9]{4}年1月$/.test(t))).toBe(true);
      // 当たり方の確認。11 月の行は引かない、1 月の行は引く。
      expect(R.hayMatches("icde 2026年11月 11月 2026年11月20日", "1月")).toBe(false);
      expect(R.hayMatches("icde 2026年1月 1月 2026年1月20日", "1月")).toBe(true);
      expect(R.hayMatches("sc 2025年12月 12月", "2月")).toBe(false);
      expect(R.hayMatches("sc 2025年2月 2月", "2月")).toBe(true);
    });

    it("日の語は月付きの形に展開する", () => {
      const group = R.queryTokenGroups("7日")[0];
      expect(group).toContain("8月7日");
      expect(group).not.toContain("7日");
      expect(group.every((t: string) => /^[0-9]{1,2}月7日$/.test(t))).toBe(true);
      // 11 日・21 日・31 日の行は 1 日では引かない。
      expect(R.hayMatches("sc 2026年8月11日 8月11日", "1日")).toBe(false);
      expect(R.hayMatches("sc 2026年8月1日 8月1日", "1日")).toBe(true);
      // 月と日の両方が立つ（11 月 1 日の行は「11月」と「1日」の両方で引ける）。
      expect(R.hayMatches("sc 2026年11月 11月 2026年11月1日 11月1日", "11日")).toBe(false);
      expect(R.hayMatches("sc 2026年11月 11月 2026年11月1日 11月1日", "11月1日")).toBe(true);
    });

    it("和暦込みで打った入力は展開しない（もともと隣の月を含まない）", () => {
      expect(R.queryTokenGroups("2026年1月")).toEqual([["2026年1月"]]);
      expect(R.queryTokenGroups("2026年12月")).toEqual([["2026年12月"]]);
      expect(R.queryTokenGroups("8月10日")).toEqual([["8月10日"]]);
      // ありえない月は展開しない（全件に化けない）。
      expect(R.queryTokenGroups("13月")[0]).toEqual(["13月"]);
      expect(R.queryTokenGroups("0日")[0]).toEqual(["0日"]);
    });

    it("他の絞り込みと組み合わせても壊れない", () => {
      // 月語を並べ語で書いても、他の語との AND はそのまま。
      expect(R.queryTokenGroups("スパコン・12月").length).toBe(2);
      expect(R.queryTokenGroups("明日").length).toBe(1);
      expect(R.queryTokenGroups("今週").length).toBe(1);
    });
  });

  describe("deadlinesToCsv（絞り込み結果を表計算へ持ち出す）", () => {
    const now = Date.parse("2026-09-22T00:00:00+09:00");
    const rowOf = (over: Record<string, unknown>) => ({
      kind: "paper",
      conf: {
        key: "demo",
        title: "Demo Symposium",
        rank: { ccf: "A", core: "A*" },
        link: "https://example.org/",
      },
      ed: {
        year: 2027,
        place: "Alicante, Spain / Online",
        date_text: "June 7-11, 2027",
        event_start: "2027-06-07",
        event_end: "2027-06-11",
        link: "https://example.org/cfp",
      },
      cats: ["ai", "hpc"],
      dl: { round: 1, kind: "paper", tz_raw: "AoE" },
      t: Date.parse("2026-10-05T14:59:00Z"),
      tLast: Date.parse("2026-10-05T14:59:00Z"),
      dateOnly: false,
      localDate: "",
      ...over,
    });

    it("ランクの番兵 `N` を表計算へ渡さず、画面と同じ「評価なし」と書く", () => {
      /* 上流の `N` は「ランクが付いていない」ことを表す番兵で等級ではない（SPEC §2）。
       * 画面と行の詳細は同じ所を「評価なし」と出しているのに、CSV だけが `N` を
       * そのまま出していた（2026-09-23 実測: 将来締切 917 行のうち 271 マス）。 */
      const split = (line: string) => {
        const cells: string[] = [];
        let cur = "";
        let quoted = false;
        for (let i = 0; i < line.length; i += 1) {
          const c = line[i];
          if (quoted) {
            if (c === '"') {
              if (line[i + 1] === '"') {
                cur += '"';
                i += 1;
              } else quoted = false;
            } else cur += c;
          } else if (c === '"') quoted = true;
          else if (c === ",") {
            cells.push(cur);
            cur = "";
          } else cur += c;
        }
        cells.push(cur);
        return cells;
      };
      const csv = R.deadlinesToCsv(
        [
          rowOf({
            conf: { key: "a", title: "Unrated Conf", rank: { ccf: "N", core: "None" }, link: "" },
          }),
          rowOf({ conf: { key: "b", title: "Tracked Conf", rank: { ccf: "B" }, link: "" } }),
        ],
        now,
      );
      const cells: string[][] = csv.split("\r\n").slice(1).map(split);
      expect(cells[0][7]).toBe("評価なし");
      expect(cells[0][8]).toBe("評価なし");
      // 体系その物が無い欄は空のまま（「評価なし」と「その体系を未追跡」を混ぜない）。
      expect(cells[1][7]).toBe("B");
      expect(cells[1][8]).toBe("");
      expect(cells[1][9]).toBe("");
      // 表計算で「N」という等級で絞り込めてしまう形に戻していないこと。
      expect(cells.some((c) => c.includes("N"))).toBe(false);
    });

    it("日本語ヘッダーで 1 行 1 締切写出す", () => {
      const csv = R.deadlinesToCsv([rowOf({})], now);
      const [header, first] = csv.split("\r\n");
      expect(header).toBe(
        "締切,公式表記,残り日数,会議,分野,種別,ラウンド,CCF,CORE,THCPL,会期,開催地,状態,URL",
      );
      const cells = first.split(",");
      // JST 主表記 + 曜日（2026-10-05 14:59 UTC = JST 23:59）。
      expect(cells[0]).toBe("2026-10-05 23:59 JST(月)");
      // AoE は UTC-12 の壁時計（2026-10-05 14:59 UTC = AoE 02:59）。
      expect(cells[1]).toBe("2026-10-05 02:59 AoE");
      // 残りは数値（表計算で並べ替えられる形）。画面の「あと N 日」とは書き方が違う。
      expect(cells[2]).toBe("13");
      // 分野は画面（分野チップ・行の詳細）と同じ日本語の語を書く。絞り込みで使った
      // 次元が表計算に無いと、分野ごとに並べ替えられない。
      expect(cells[4]).toBe("人工知能・高性能計算");
      expect(cells[5]).toBe("論文締切");
      expect(cells[6]).toBe("R1");
      expect(cells[7]).toBe("A");
      expect(cells[8]).toBe("A*");
      // 画面に出す評価一覧は CSV にも載せる（見えている情報を落とさない）。
      expect(cells[9]).toBe("");
      // 会期は一覧と同じ ISO + 暦日、開催地は日本語に寄せた表記。
      expect(csv).toContain("2027-06-07(月) 〜 2027-06-11(金)");
      expect(csv).toContain("Alicante, スペイン / オンライン");
      expect(csv.endsWith("\r\n")).toBe(true);
    });

    it("時刻未確認・推定・経過を区別する", () => {
      const dateOnly = R.deadlinesToCsv(
        [
          rowOf({
            dateOnly: true,
            localDate: "2026-09-30",
            t: Date.parse("2026-09-29T10:00:00Z"),
            dl: { kind: "abstract", precision: "date-only", local_date: "2026-09-30" },
          }),
        ],
        now,
      );
      // 時刻の未確認は「公式表記」列が伝える。残りは数値のままにする（順を変えられる形で）。
      expect(dateOnly).toContain("2026-09-30(水),時刻未確認,7");

      // 過ぎた締切は「経過」ではなく負の数。表計算で「残り 7 日以内」をフィルタできる形にする。
      const past = R.deadlinesToCsv([rowOf({ t: now - 5 * 86400000, tLast: now })], now);
      expect(past).toContain(",-5,");
      expect(past).not.toContain("経過");

      const estimated = R.deadlinesToCsv(
        [rowOf({ ed: { ...rowOf({}).ed, estimated: true } })],
        now,
      );
      expect(estimated).toContain(",推定,");
    });

    it("カンマと引用符を含む値を RFC4180 でエスケープする", () => {
      const csv = R.deadlinesToCsv(
        [
          rowOf({
            conf: { key: "d", title: 'Workshop, "Edge" Cases', rank: {}, link: "https://x/" },
          }),
        ],
        now,
      );
      expect(csv).toContain('"Workshop, ""Edge"" Cases"');
    });

    it("常時受付ジャーナルと空入力を壊さない", () => {
      const journal = R.deadlinesToCsv([rowOf({ kind: "journal", t: Number.NaN })], now);
      // 日時セルの語は種別ラベルと同じ `常時受付`（行の中で 2 つの名前を見せない）。
      expect(journal).toContain("常時受付,");
      expect(R.deadlinesToCsv([], now)).toBe(
        "締切,公式表記,残り日数,会議,分野,種別,ラウンド,CCF,CORE,THCPL,会期,開催地,状態,URL\r\n",
      );
      expect(R.deadlinesToCsv(null, now)).toBe(
        "締切,公式表記,残り日数,会議,分野,種別,ラウンド,CCF,CORE,THCPL,会期,開催地,状態,URL\r\n",
      );
    });

    it("残り日数は数値で、経過は負の数になる", () => {
      const day = 86400000;
      const at = (days: number) => rowOf({ t: now + days * day, tLast: now + days * day });
      const col = (csv: string) =>
        csv
          .split("\r\n")
          .slice(1)
          .filter((line) => line.length > 0)
          .map((line) => line.split(",")[2]);
      const values = col(R.deadlinesToCsv([at(30), at(2), at(0), at(-5), at(120)], now));
      expect(values).toEqual(["30", "2", "0", "-5", "120"]);
      // 文字列（`残り13日`）だと "120" が "2" より前に並び、締切の近い順にできない。
      expect(values.slice().sort()).toEqual(["-5", "0", "120", "2", "30"]);
      expect(values.slice().sort((a, b) => Number(a) - Number(b))).toEqual([
        "-5",
        "0",
        "2",
        "30",
        "120",
      ]);
    });

    it("常時受付は空欄で、THCPL も写出す", () => {
      const journalCells = R.deadlinesToCsv([rowOf({ kind: "journal" })], now)
        .split("\r\n")[1]
        .split(",");
      expect(journalCells[2]).toBe("");
      const thcplCells = R.deadlinesToCsv(
        [rowOf({ conf: { key: "demo", title: "Demo", rank: { thcpl: "B" }, link: "" } })],
        now,
      )
        .split("\r\n")[1]
        .split(",");
      // 分野列（5 列目）のぶん、評価一覧の列は 1 つ後ろにずれている。
      expect(thcplCells[9]).toBe("B");
      expect(thcplCells[7]).toBe("");
    });
  });

  describe("weekdayJaFromDate（暦日だけの値に曜日を添える）", () => {
    it("YYYY-MM-DD を UTC の暦日として読む", () => {
      expect(R.weekdayJaFromDate("2026-12-17")).toBe("木");
      expect(R.weekdayJaFromDate("2026-12-18")).toBe("金");
      expect(R.weekdayJaFromDate("2026-09-30")).toBe("水");
    });

    it("閲覧者のタイムゾーンに依存しない", () => {
      // TZ は親プロセスで差し替えた実行（tests/build_golden.test.ts の TZ スイープ）でも
      // 同じ値になることを、瞬間を作らない実装で保証する。
      expect(R.weekdayJaFromDate("2027-03-01")).toBe("月");
    });

    it("暦日として読めない値には曜日を付けない", () => {
      // Date.UTC の繰り越し（2026-13-45 -> 2027-02-14）に曜日を付けない。
      expect(R.weekdayJaFromDate("2026-13-45")).toBe("");
      expect(R.weekdayJaFromDate("2026-02-30")).toBe("");
      expect(R.weekdayJaFromDate("2026-1-7")).toBe("");
      expect(R.weekdayJaFromDate("2026年1月7日")).toBe("");
      expect(R.weekdayJaFromDate("")).toBe("");
      expect(R.weekdayJaFromDate(null)).toBe("");
      expect(R.weekdayJaFromDate(undefined)).toBe("");
      expect(R.weekdayJaFromDate(20260107)).toBe("");
    });
  });

  describe("主題タグの日本語化と検索（tags）", () => {
    it("実データに現れるタグを日本語で返す", () => {
      expect(R.tagLabelJa("machine-learning")).toBe("機械学習");
      // 半角スペース表記のタグも同じ語として引ける。
      expect(R.tagLabelJa("machine learning")).toBe("機械学習");
      expect(R.tagLabelJa("computer vision")).toBe("コンピュータビジョン");
      expect(R.tagLabelJa("niche")).toBe("穴場");
      expect(R.tagLabelJa("storage")).toBe("ストレージ");
      // 対応表に無い語は作らない。
      expect(R.tagLabelJa("sensys")).toBe("");
      expect(R.tagLabelJa(null)).toBe("");
    });

    it("topicTagsJa は構造タグを除いて並べる", () => {
      expect(R.topicTagsJa(["machine-learning", "domestic-jp", "niche", "journal"])).toEqual([
        "機械学習",
        "穴場",
      ]);
      expect(R.topicTagsJa([])).toEqual([]);
      expect(R.topicTagsJa(null)).toEqual([]);
    });

    it("タグは検索語に入り、日本語でも 2 語でも当たる", () => {
      const confs = [
        {
          key: "ml-demo",
          title: "Demo Conference on Systems",
          categories: ["systems"],
          tags: ["machine-learning", "storage"],
          editions: [
            {
              year: 2026,
              place: "Kyoto, Japan",
              deadlines: [{ kind: "paper", utc: "2026-09-01T23:59:00Z" }],
            },
          ],
        },
      ];
      const row = R.candidateRows(confs)[0];
      expect(R.hayMatches(row.hay, "機械学習")).toBe(true);
      expect(R.hayMatches(row.hay, "ストレージ")).toBe(true);
      expect(R.hayMatches(row.hay, "machine learning")).toBe(true);
      expect(R.hayMatches(row.hay, "machine-learning")).toBe(true);
    });
  });

  describe("placeJa（開催地の国名・開催形式だけを日本語に寄せる）", () => {
    it("末尾カンマ句の国名と開催形式を変換する", () => {
      expect(R.placeJa("Barcelona, Spain")).toBe("Barcelona, スペイン");
      expect(R.placeJa("Alicante, Spain / Online")).toBe("Alicante, スペイン / オンライン");
      expect(R.placeJa("Chicago, IL, USA")).toBe("Chicago, IL, アメリカ");
      expect(R.placeJa("Royal Holloway, Egham, UK")).toBe("Royal Holloway, Egham, イギリス");
      expect(R.placeJa("Tokyo, Japan")).toBe("Tokyo, 日本");
      expect(R.placeJa("Seoul, South Korea")).toBe("Seoul, 韓国");
      expect(R.placeJa("Costa Rica (hybrid)")).toBe("コスタリカ (ハイブリッド)");
      expect(R.placeJa("Online Only")).toBe("オンラインのみ");
      expect(R.placeJa("UK and hybrid")).toBe("イギリス・ハイブリッド");
      expect(R.placeJa("Vienna, Austria & Virtual")).toBe("Vienna, オーストリア・オンライン");
      expect(R.placeJa("TBD")).toBe("未定");
      // 上流の誤記も同じ国として寄せる（原文訂正は overrides の役割）。
      expect(R.placeJa("Phoenix, Arizona, United State")).toBe("Phoenix, Arizona, アメリカ");
    });

    it("都市名・会場名は壊さない", () => {
      // 先頭側を置換すると "Panama City" が「パナマ City」に化けて場所を特定できない。
      expect(R.placeJa("Panama City, Panama")).toBe("Panama City, パナマ");
      expect(R.placeJa("Salt Lake City, Utah, USA")).toBe("Salt Lake City, Utah, アメリカ");
      expect(
        R.placeJa("Virginia Tech Academic Building One, Alexandria, Virginia, United States"),
      ).toBe("Virginia Tech Academic Building One, Alexandria, Virginia, アメリカ");
      // すでに日本語の開催地はそのまま。
      expect(R.placeJa("飛騨・世界生活文化センター（岐阜県高山市）／オンライン")).toBe(
        "飛騨・世界生活文化センター（岐阜県高山市）／オンライン",
      );
    });

    it("未知の語は推測せず原文を残し、入力が文字店でなければ空文字", () => {
      expect(R.placeJa("Atlantis, Nowhere")).toBe("Atlantis, Nowhere");
      expect(R.placeJa(null)).toBe("");
      expect(R.placeJa(undefined)).toBe("");
      expect(R.placeJa(42)).toBe("");
    });

    it("行の検索語に開催地の日本語表記を含める", () => {
      const confs = [
        {
          key: "demo",
          title: "Demo Conf",
          categories: ["hpc"],
          tags: [],
          editions: [
            {
              year: 2026,
              place: "Seoul, South Korea",
              deadlines: [{ kind: "paper", utc: "2026-09-01T23:59:00Z" }],
            },
          ],
        },
      ];
      const rows = R.candidateRows(confs);
      expect(rows[0].hay).toContain("韓国");
      expect(rows[0].hay).toContain("seoul, south korea");
    });
  });
});

describe("pastRepresentatives", () => {
  it("only venues without a future deadline get one past rep", () => {
    const rows = [
      { conf: { key: "a" }, kind: "paper", t: NOW - 1000, est: false },
      { conf: { key: "a" }, kind: "paper", t: NOW - 2000, est: false },
      { conf: { key: "b" }, kind: "paper", t: NOW - 1000, est: false },
      { conf: { key: "b" }, kind: "paper", t: NOW + 1000, est: false },
      { conf: { key: "c" }, kind: "event", t: NOW - 1000, est: false },
      { conf: { key: "d" }, kind: "paper", t: NOW - 1000, est: true },
    ];
    const reps = R.pastRepresentatives(rows, NOW);
    expect(reps.map((r: any) => r.conf.key)).toEqual(["a"]);
    expect(reps[0].t).toBe(NOW - 1000); // 直近の過去 1 行のみ
  });
});

describe("comparePapers", () => {
  it("future first on tie, score first overall", () => {
    const past = {
      _matchScore: 50,
      kind: "paper",
      t: Date.parse("2026-06-01T00:00:00Z"),
      tLast: Date.parse("2026-06-01T00:00:00Z"),
    };
    const future = {
      _matchScore: 50,
      kind: "paper",
      t: Date.parse("2026-12-01T00:00:00Z"),
      tLast: Date.parse("2026-12-01T00:00:00Z"),
    };
    const higher = {
      _matchScore: 60,
      kind: "paper",
      t: Date.parse("2026-06-01T00:00:00Z"),
      tLast: Date.parse("2026-06-01T00:00:00Z"),
    };
    expect(R.comparePapers(past, future, NOW) > 0).toBe(true); // future が先
    expect(R.comparePapers(future, past, NOW) < 0).toBe(true);
    expect(R.comparePapers(higher, future, NOW) < 0).toBe(true); // スコア優先
  });
});

describe("venueCategories", () => {
  it("derives categories from a tag", () => {
    // RTSS タグ → systems カテゴリが推定される
    const lines = R.parsePaperLines("Paper A | kw | RTSS");
    const rows = [
      {
        conf: { key: "rtss", title: "RTSS", full_name: "IEEE Real-Time Systems Symposium" },
        cats: ["systems"],
      },
      {
        conf: { key: "sigcomm", title: "SIGCOMM", full_name: "ACM SIGCOMM" },
        cats: ["networking"],
      },
    ];
    expect(R.venueCategories(lines, rows).sort()).toEqual(["systems"]);
  });

  it("empty without a tag", () => {
    const lines = R.parsePaperLines("Paper A | kw");
    const rows = [
      {
        conf: { key: "rtss", title: "RTSS", full_name: "IEEE Real-Time Systems Symposium" },
        cats: ["systems"],
      },
    ];
    expect(R.venueCategories(lines, rows)).toEqual([]);
  });
});

describe("venue-level evidence fusion", () => {
  const row = {
    conf: { key: "hpc-test", title: "HPC Test", full_name: "", tags: [] },
    cats: ["hpc"],
  };

  it("aggregates multiple positive paper lines with stable ranks", () => {
    const lines = R.parsePaperLines(
      "GPU scheduling | gpu\nParallel kernels | parallel\nUnrelated text",
    );
    const b = R.breakdown(row, lines);
    expect(b.venueScore).toBeGreaterThan(R.breakdown(row, [lines[0]]).venueScore);
    expect(b.evidence).toHaveLength(2);
    expect(b.evidence.map((e: { rank: number }) => e.rank)).toEqual([1, 2]);
  });

  it("is independent of input order after score/key tie-breaking", () => {
    const lines = R.parsePaperLines("GPU scheduling | gpu\nParallel kernels | parallel");
    const forward = R.breakdown(row, lines);
    const reverse = R.breakdown(row, lines.slice().reverse());
    expect(reverse.venueScore).toBe(forward.venueScore);
  });

  it("does not retrieve a venue without positive evidence", () => {
    const b = R.breakdown(row, R.parsePaperLines("Unrelated title | unrelated"));
    expect(b.venueScore).toBe(0);
    expect(b.evidence).toEqual([]);
  });

  it("keeps a venue-tag hit above ordinary lexical evidence", () => {
    const tagged = {
      conf: { key: "rtss", title: "RTSS", full_name: "Real-Time Systems Symposium", tags: [] },
      cats: ["systems"],
    };
    const lexical = {
      conf: { key: "systems-test", title: "Systems Test", full_name: "", tags: [] },
      cats: ["systems"],
    };
    const lines = R.parsePaperLines("A paper | kw | RTSS");
    expect(R.breakdown(tagged, lines).venueScore).toBeGreaterThan(
      R.breakdown(lexical, R.parsePaperLines("real-time systems")).venueScore,
    );
  });
});

describe("score labels and transient UI state", () => {
  it("rejects delayed semantic results from an old generation or text", () => {
    const app = appRuntime();
    const start = app.indexOf("function semanticIsCurrent(");
    const guard = app.match(/function semanticIsCurrent\([\s\S]*?\n\s*}/)?.[0] ?? "";
    expect(start).toBeGreaterThanOrEqual(0);
    expect(guard).toContain("currentPaperText() === text");
    const isCurrent = new Function(
      "semGeneration",
      "currentPaperText",
      `${guard}; return semanticIsCurrent;`,
    )(2, () => "new text") as (generation: number, text: string) => boolean;
    expect(isCurrent(1, "old text")).toBe(false);
    expect(isCurrent(2, "old text")).toBe(false);
    expect(isCurrent(2, "new text")).toBe(true);
    expect(app).toContain("invalidateSemantic();");
    expect(app).toContain('clearSemantic("error");');
    expect(app).toContain("Recommender.setPaperVecs(null)");
    // 失敗理由コードを併記する (#711: 8+通りの失敗が1文言に潰れて原因追跡不能だった)
    expect(app).toContain("意味検索は利用不可（語彙検索のみ・原因: ");
    expect(app).toMatch(
      /意味検索は利用不可（語彙検索のみ・原因: \$\{semanticReason \|\| "unknown"\}）/,
    );
    for (const reason of [
      "embedding set incompatible",
      "model metadata missing",
      "model load failed",
      "probe mismatch",
      "query embedding failed",
      "recommendation data unavailable",
    ]) {
      expect(app).toContain(`semanticReason = "${reason}";`);
    }
    expect(app).toContain("let semanticScores = null;");
  });

  it("keeps ordinal score labels out of percentage language", () => {
    const template = readFileSync(join(REPO_ROOT, "site/template.html"), "utf8") + appRuntime();
    expect(template).toMatch(/一致評価\s*\$\{r\._fitLabel\s*\|\|\s*"評価保留"}/);
    expect(template).not.toContain('"適合度 " + r._matchScore + "%');
    expect(template).not.toContain("strong candidate");
    expect(template).toContain("過去掲載先一致");
    expect(template).toContain("r._boosted = false;");
    // ランクは `rankSortKey`（等級の点数）で比べる（体系名で並ばないようにした）。
    expect(template).toContain("Recommender.rankSortKey(a.rankPairs)");
    expect(template).toContain("Recommender.rankSortKey(b.rankPairs)");
    expect(template).not.toContain("const ar = a.rankPairs[0]");
    // 同じランクの塊の中は締切の近い順（同じ評価の行がデータ源順でバラバラにならない）。
    expect(template).toContain("compareDeadlineRows(a, b, mult)");
    expect(template).toContain('const PDFJS_VERSION = "3.11.174";');
    expect(template).toContain("const PDF_PAGE_LIMIT = 3;");
    expect(template).toContain("const PDF_MAX_BYTES = 20 * 1024 * 1024;");
    expect(template).toContain("new AbortController()");
    expect(template).toContain('id="paperPrimaryTitle"');
    expect(template).toContain('id="paperReferences"');
    expect(template).toContain('if (a.status === "open" && a.timestamp)');
    expect(template).toContain('const isPastOnly = r._availability?.status === "past";');
    expect(template).toContain(
      'titleWithYear(r.conf.title || r.conf.key || "", isPastOnly ? null : r.ed.year)',
    );
    expect(template).toMatch(
      /safeExternalUrl\(isPastOnly \? r\.conf\.link : r\.ed\.link \|\| r\.conf\.link\)/,
    );
  });
});

describe("venue recommendation fusion", () => {
  const row = (key: string, title: string, t = NOW, cats: string[] = ["hpc"]) => ({
    conf: { key, title, full_name: title, tags: [] },
    cats,
    kind: "paper",
    t,
    tLast: t,
    est: false,
  });

  it("applies the published linear reranker and calibrated probability", () => {
    R.setReranker({
      version: 1,
      algorithm_revision: R.RERANKER_ALGORITHM_REVISION,
      feature_schema: [...R.RERANKER_FEATURE_SCHEMA],
      intercept: -1,
      weights: Object.fromEntries(
        R.RERANKER_FEATURE_SCHEMA.map((name: string) => [name, name === "lexical_score" ? 2 : 0]),
      ),
      blend: 1,
      confidence_thresholds: { sufficient: 0.7, ambiguous: 0.4 },
      confidence_policy: { sufficient_enabled: true },
    });
    try {
      const result = R.venueRecommendations(
        [row("gpu", "GPU Systems")],
        R.parsePaperLines("GPU scheduling | gpu"),
        null,
        NOW,
      )[0];
      expect(result.fit.probability).toBeGreaterThan(0);
      expect(result.fit.score).toBe(Math.round(result.fit.probability * 100));
    } finally {
      R.setReranker(null);
    }
  });

  it("rejects a reranker with a mismatched production feature schema", () => {
    R.setReranker({
      version: 1,
      feature_schema: ["semantic_score"],
      intercept: 10,
      weights: { semantic_score: 10 },
      blend: 1,
      confidence_thresholds: { sufficient: 0, ambiguous: 0 },
    });
    try {
      const result = R.venueRecommendations(
        [row("gpu", "GPU Systems")],
        R.parsePaperLines("GPU scheduling | gpu"),
        { gpu: 100 },
        NOW,
      )[0];
      expect(result.fit.probability).toBe(0.5);
      expect(result.fit.score).toBe(result.fit.baseScore);
    } finally {
      R.setReranker(null);
    }
  });

  it("rejects a reranker from a different algorithm revision", () => {
    R.setReranker({
      version: 1,
      algorithm_revision: "old-reranker",
      feature_schema: [...R.RERANKER_FEATURE_SCHEMA],
      intercept: 10,
      weights: Object.fromEntries(R.RERANKER_FEATURE_SCHEMA.map((name: string) => [name, 10])),
      blend: 1,
      confidence_thresholds: { sufficient: 0, ambiguous: 0 },
    });
    try {
      const result = R.venueRecommendations(
        [row("gpu", "GPU Systems")],
        R.parsePaperLines("GPU scheduling | gpu"),
        { gpu: 100 },
        NOW,
      )[0];
      expect(result.fit.probability).toBe(0.5);
      expect(result.fit.score).toBe(result.fit.baseScore);
    } finally {
      R.setReranker(null);
    }
  });

  it("never reports sufficient confidence without a valid reranker policy", () => {
    R.setReranker(null);
    const result = R.venueRecommendations(
      [row("gpu", "GPU Systems")],
      R.parsePaperLines("GPU scheduling | gpu"),
      { gpu: 100 },
      NOW,
    )[0];
    expect(result.fit.confidence).toBe("ambiguous");
    expect(isValidRerankerModel({})).toBe(false);
  });

  it("rejects unsafe reranker calibration, blend, and confidence thresholds", () => {
    const model = JSON.parse(
      readFileSync(join(REPO_ROOT, "data", "recommender-reranker.json"), "utf8"),
    );
    expect(isValidRerankerModel(model)).toBe(true);
    for (const invalid of [
      { ...model, blend: 2 },
      { ...model, calibration: { method: "platt", slope: "bad", intercept: 0 } },
      { ...model, confidence_thresholds: { sufficient: 0.4, ambiguous: 0.7 } },
      { ...model, confidence_thresholds: { sufficient: 1.1, ambiguous: 0.7 } },
    ]) {
      expect(isValidRerankerModel(invalid)).toBe(false);
    }
  });

  it("keeps every trained reranker weight finite and bounded", () => {
    const model = JSON.parse(
      readFileSync(join(REPO_ROOT, "data", "recommender-reranker.json"), "utf8"),
    );
    expect(model.weights).toBeDefined();
    for (const feature of R.RERANKER_FEATURE_SCHEMA) {
      expect(Number.isFinite(model.weights[feature])).toBe(true);
      expect(Math.abs(model.weights[feature])).toBeLessThanOrEqual(10);
    }
  });

  it("evaluates refined confidence score incorporating entropy, token richness, and agreement", () => {
    const sparseQuery = R.parsePaperLines("GPU");
    const richQuery = R.parsePaperLines(
      "High performance GPU scheduling with low latency kernel execution for distributed machine learning systems | gpu, scheduling, hpc",
    );

    const singleVenue = [row("gpu", "GPU Systems")];
    const multipleVenues = [
      row("gpu1", "GPU Systems 1"),
      row("gpu2", "GPU Systems 2"),
      row("gpu3", "GPU Systems 3"),
      row("gpu4", "GPU Systems 4"),
      row("gpu5", "GPU Systems 5"),
    ];

    const sparseRes = R.venueRecommendations(singleVenue, sparseQuery, { gpu: 50 }, NOW);
    const richRes = R.venueRecommendations(singleVenue, richQuery, { gpu: 50 }, NOW);

    expect(sparseRes[0].fit.confidenceScore).toBeGreaterThanOrEqual(0);
    expect(sparseRes[0].fit.confidenceScore).toBeLessThanOrEqual(1);
    expect(richRes[0].fit.confidenceScore).toBeGreaterThanOrEqual(0);
    expect(richRes[0].fit.confidenceScore).toBeLessThanOrEqual(1);

    expect(richRes[0].fit.queryConfidence.inputTokenCount).toBeGreaterThan(
      sparseRes[0].fit.queryConfidence.inputTokenCount,
    );
    expect(richRes[0].fit.confidenceScore).toBeGreaterThan(sparseRes[0].fit.confidenceScore);

    const flatRes = R.venueRecommendations(
      multipleVenues,
      richQuery,
      { gpu1: 50, gpu2: 50, gpu3: 50, gpu4: 50, gpu5: 50 },
      NOW,
    );
    expect(flatRes[0].fit.queryConfidence.top5Entropy).toBeGreaterThan(0.9);
    expect(richRes[0].fit.queryConfidence.top5Entropy).toBe(0);
  });

  it("pins the reranker development inputs by hash", () => {
    const model = JSON.parse(
      readFileSync(join(REPO_ROOT, "data", "recommender-reranker.json"), "utf8"),
    );
    // 学習は full dev のみ。required-dev（短縮検査用 subset）を学習に使ってはいけない。
    expect(model.selected_on).toBe("real-paper-dev");
    expect(model.cv.assignment).toBe("primary-venue-grouped-round-robin");
    expect(model.cv.folds).toBeGreaterThanOrEqual(5);
    expect(model.confidence_policy.sufficient_enabled).toBe(false);
    expect(model.coefficient_source).toBe("trained");
    expect(model.feature_schema).toContain("semantic_score");
    expect(model.calibration.method).toBe("platt");
    const comparison = JSON.parse(
      readFileSync(join(REPO_ROOT, "data/benchmarks/reranker-comparison.json"), "utf8"),
    );
    const calibrationMetrics = ["top1_brier", "top5_brier", "top1_ece", "top5_ece"];
    expect(comparison.acceptance.calibration_non_degraded).toBe(
      calibrationMetrics.every(
        (metric) => comparison.candidate.heldout[metric] <= comparison.production.heldout[metric],
      ),
    );
    // acceptance boolean はリテラルで固定せず、ファイル内数値から再導出して検証する
    // (リテラル固定は成果物と期待値を同時に書き換える循環検査になる)。
    expect(comparison.acceptance.heldout_mrr_non_degraded).toBe(
      comparison.candidate.heldout.mrr >= comparison.production.heldout.mrr,
    );
    expect(comparison.acceptance.heldout_recall_at_5_non_degraded).toBe(
      comparison.candidate.heldout.recall_at_5 >= comparison.production.heldout.recall_at_5,
    );
    // 昇格ポリシー (#687 で確定): 昇格には heldout MRR で noise floor (0.01) を
    // 超える改善が「必要条件」。dev MRR の bootstrap 95% CI 幅は ~0.17 (n=80) で、
    // それ未満の差は雑音であり、雑音での機械的な昇格フリップを防ぐ。
    // floor 超えは十分条件ではない (recall 劣化等での保守的 keep は常に適法) ため、
    // 検証は一方向のみ: 雑音水準の差での promote を禁止する。
    const PROMOTION_NOISE_FLOOR = 0.01;
    const heldoutGain = comparison.candidate.heldout.mrr - comparison.production.heldout.mrr;
    if (heldoutGain <= PROMOTION_NOISE_FLOOR) expect(comparison.decision).toBe("keep-v3");
    expect(["keep-v3", "promote-v4"]).toContain(comparison.decision);
    expect(comparison).toMatchObject({
      artifact: { algorithm_revision: model.algorithm_revision },
    });
    expect(model).toMatchObject({
      production_trainer_revision: comparison.production.trainer_revision,
      candidate_trainer_revision: comparison.candidate.trainer_revision,
      candidate_rejected_reason: comparison.candidate_rejected_reason,
    });
    const audit = JSON.parse(
      readFileSync(join(REPO_ROOT, "data/benchmarks/retrieval-audit.json"), "utf8"),
    );
    expect(audit.by_split.dev.fused).toMatchObject({
      mrr: comparison.production.dev.mrr,
      recall_at_5: comparison.production.dev.recall_at_5,
    });
    expect(audit.by_split.heldout.fused).toMatchObject({
      mrr: comparison.production.heldout.mrr,
      recall_at_5: comparison.production.heldout.recall_at_5,
    });
    expect(
      Object.values(audit.failure_taxonomy.counts).reduce(
        (sum: number, count) => sum + Number(count),
        0,
      ),
    ).toBe(160);
    const devIds = new Set(
      JSON.parse(
        readFileSync(join(REPO_ROOT, "data/benchmarks/real-paper-dev.json"), "utf8"),
      ).records.map((record: { paper_id: string }) => record.paper_id),
    );
    for (const [path, expected] of Object.entries(model.input_hashes)) {
      if (path.endsWith("#dev-records")) {
        const features = readFeatureStore(join(REPO_ROOT, path.replace(/#dev-records$/, "")));
        expect(
          trainingFeatureHash(features.records.filter((record) => devIds.has(record.paper_id))),
        ).toBe(expected);
        continue;
      }
      expect(
        createHash("sha256")
          .update(readFileSync(join(REPO_ROOT, path)))
          .digest("hex"),
      ).toBe(expected);
    }
  });

  it("runs the full real-paper benchmark by default and keeps synthetic explicit", () => {
    const scripts = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).scripts;
    expect(scripts.bench).toContain("--real-v2-dev data/benchmarks/real-paper-dev.json");
    expect(scripts.bench).toContain("--real-v2-heldout data/benchmarks/real-paper-heldout.json");
    expect(scripts.bench).toContain("--real-v2-negative data/benchmarks/real-paper-negative.json");
    expect(scripts["bench:synthetic"]).toContain("--v2 tests/fixtures/bench-v2.json");
  });

  it("trains from dev rows only and makes dev input changes visible", () => {
    const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reranker-"));
    const dev = join(dir, "dev.json");
    const features = join(dir, "features.json");
    const profiles = join(REPO_ROOT, "data", "venue-profiles.json");
    const first = join(dir, "first.json");
    const second = join(dir, "second.json");
    const candidate = join(dir, "candidate.json");
    writeFileSync(
      dev,
      readFileSync(join(REPO_ROOT, "data/benchmarks/real-paper-required-dev.json")),
    );
    const fixture = readFeatureStore(join(REPO_ROOT, "data/benchmarks/real-paper-features.jsonl"));
    writeFileSync(features, JSON.stringify(fixture));
    trainRerankerMain([
      "--dev",
      dev,
      "--features",
      features,
      "--profiles",
      profiles,
      "--out",
      first,
    ]);
    const baseline = JSON.parse(readFileSync(first, "utf8"));
    trainRerankerMain([
      "--candidate-v4",
      "--dev",
      dev,
      "--features",
      features,
      "--profiles",
      profiles,
      "--out",
      candidate,
    ]);
    expect(JSON.parse(readFileSync(candidate, "utf8"))).toMatchObject({
      algorithm_revision: "l2-pairwise-logistic-reranker-v4-component-greedy-cv",
      cv: { assignment: "acceptable-venue-component-greedy-balanced" },
      negative_sampling: { strategy: "hard-negative-mix", limit_per_paper: 100 },
    });
    const unrelated = fixture.records.find((item: any) => item.paper_id.startsWith("heldout-"))!;
    unrelated.semantic_scores[Object.keys(unrelated.semantic_scores)[0]] += 1;
    writeFileSync(features, JSON.stringify(fixture));
    trainRerankerMain([
      "--dev",
      dev,
      "--features",
      features,
      "--profiles",
      profiles,
      "--out",
      second,
    ]);
    const isolated = JSON.parse(readFileSync(second, "utf8"));
    expect(readFileSync(second, "utf8")).toBe(readFileSync(first, "utf8"));
    expect(isolated.weights).toEqual(baseline.weights);
    expect(isolated.training_data_hash).toBe(baseline.training_data_hash);
    const devFixture = JSON.parse(readFileSync(dev, "utf8"));
    devFixture.records[0].acceptable_venues = ["not-a-real-venue"];
    writeFileSync(dev, JSON.stringify(devFixture));
    trainRerankerMain([
      "--dev",
      dev,
      "--features",
      features,
      "--profiles",
      profiles,
      "--out",
      second,
    ]);
    expect(JSON.parse(readFileSync(second, "utf8")).training_data_hash).not.toBe(
      baseline.training_data_hash,
    );
  });

  it("selects v4 hard negatives by retrieval signals, independent of input order", () => {
    const rows = Array.from({ length: 120 }, (_, index) => ({
      paperId: "paper",
      venue: `venue-${String(index).padStart(3, "0")}`,
      y: 0,
      baseScore: index,
      x: [index / 120, (119 - index) / 120, 0, 0, 0, 0, 0],
    }));
    const selected = hardNegativeMix(rows).map((row) => row.venue);
    const reversed = hardNegativeMix(rows.slice().reverse()).map((row) => row.venue);
    expect(selected).toHaveLength(100);
    expect(selected).toContain("venue-119");
    expect(selected).toContain("venue-000");
    expect(reversed).toEqual(selected);
  });

  it("clamps ambiguous below sufficient when SUFFICIENT_POLICY unlocks at the low end (#725)", () => {
    // 全件 correct の OOF top-1 確率を作ると、confidencePolicy は coverage 最大化により
    // 最も低い確率を chosen_threshold として解禁する。一方 ambiguous は同じ集合の下位
    // 1/3 分位点であり、これは chosen_threshold より高い値になる。クランプが無ければ
    // ambiguous > sufficient の逆転が起きる。
    const top = Array.from({ length: 30 }, (_, index) => ({
      probability: Number((0.06 + index * 0.01).toFixed(8)),
      correct: true,
    }));
    const sortedProbabilities = [...new Set(top.map((item) => item.probability))].sort(
      (a, b) => a - b,
    );
    const rawAmbiguousThreshold =
      sortedProbabilities[Math.floor((sortedProbabilities.length - 1) / 3)];
    const { policy, sufficientThreshold, ambiguousThreshold } = deriveConfidenceThresholds(top);
    expect(policy.sufficient_enabled).toBe(true);
    expect(sufficientThreshold).toBe(sortedProbabilities[0]);
    expect(rawAmbiguousThreshold).toBeGreaterThan(sufficientThreshold);
    expect(ambiguousThreshold).toBeLessThanOrEqual(sufficientThreshold);
    expect(ambiguousThreshold).toBe(sufficientThreshold);
  });

  it("keeps frozen benchmark identity independent of the reader runtime", () => {
    const fixture = (name: string) =>
      JSON.parse(readFileSync(join(REPO_ROOT, "data/benchmarks", name), "utf8"));
    const dev = fixture("real-paper-required-dev.json");
    const heldout = fixture("real-paper-required-heldout.json");
    const negative = fixture("real-paper-negative.json");
    const features = readFeatureStore(join(REPO_ROOT, "data/benchmarks/real-paper-features.jsonl"));
    const baseline = realPaperBenchmarkContentId("required", dev, heldout, negative, features);
    features.provenance!.runtime = "different-node-runtime";
    expect(realPaperBenchmarkContentId("required", dev, heldout, negative, features)).toBe(
      baseline,
    );
  });

  it("rejects duplicate feature rows and altered record hashes", () => {
    const dir = mkdtempSync(join(tmpdir(), "kamiyobi-feature-store-"));
    const path = join(dir, "features.jsonl");
    const record = {
      paper_id: "paper-1",
      feature_schema: 2,
      profile_hash: "profile",
      model_revision: "model",
      semantic_scores: { venue: 0.5 },
      candidates: [],
    };
    const hash = createHash("sha256")
      .update(JSON.stringify([record.paper_id, record.semantic_scores]))
      .digest("hex");
    writeFileSync(
      path,
      `${JSON.stringify({ ...record, record_sha256: hash })}\n${JSON.stringify({ ...record, record_sha256: hash })}\n`,
    );
    expect(() => readFeatureStore(path)).toThrow(/duplicate paper_id/);
    writeFileSync(path, `${JSON.stringify({ ...record, record_sha256: "0".repeat(64) })}\n`);
    expect(() => readFeatureStore(path)).toThrow(/record hash mismatch/);
  });

  it("unions a semantic-only venue with lexical candidates", () => {
    const result = R.venueRecommendations(
      [row("lexical", "GPU Systems"), row("semantic", "Distributed Inference")],
      R.parsePaperLines("GPU scheduling | gpu"),
      { lexical: 0.1, semantic: 0.99 },
      NOW,
      { topN: 1 },
    );
    expect(result.map((item: any) => item.venueKey).sort()).toEqual(["lexical", "semantic"]);
    const semantic = result.find((item: any) => item.venueKey === "semantic");
    expect(semantic.fit.lexicalRank).toBeNull();
    expect(semantic.fit.semanticRank).toBe(1);
    expect(semantic.fit.evidence.some((item: any) => item.type === "semantic")).toBe(true);
  });

  it("pins the RRF fusion weights: symmetric legacy blend, 1.6/0.4 fielded blend", () => {
    const rows = [row("lex", "GPU Systems"), row("sem", "Distributed Inference")];
    const lines = R.parsePaperLines("GPU scheduling | gpu");
    const scores = { sem: 0.99 };
    // 単一シグナルで rank=1 の会場は 100 * weight / (weight和=除数2) に落ちる。
    // 重み和 2 が score 正規化の除数 2 と一致していることも同時に拘束する。
    const legacy = R.venueRecommendations(rows, lines, scores, NOW, { topN: 1 });
    const legacySem = legacy.find((item: any) => item.venueKey === "sem");
    expect(legacySem.fit.lexicalRank).toBeNull();
    expect(legacy.find((item: any) => item.venueKey === "lex").fit.baseScore).toBe(50);
    expect(legacySem.fit.baseScore).toBe(50);
    const fielded = R.venueRecommendations(rows, lines, scores, NOW, {
      topN: 1,
      fieldedLexical: true,
    });
    expect(fielded.find((item: any) => item.venueKey === "lex").fit.baseScore).toBe(80);
    // semantic のみの候補は fielded 経路で 50→20 に圧縮される。site/app.ts の
    // score >= 10 足切りと連動して UI 到達域が変わるため、意図的な値として固定する。
    expect(fielded.find((item: any) => item.venueKey === "sem").fit.baseScore).toBe(20);
  });

  it("looks up semantic scores by the normalized conference key", () => {
    const result = R.venueRecommendations(
      [row("foo-bar", "Unrelated venue")],
      R.parsePaperLines("unrelated topic"),
      { "foo bar": 100 },
      NOW,
    );
    expect(result[0]?.venueKey).toBe("foo-bar");
    expect(result[0]?.fit.semanticScore).toBe(100);
  });

  it("uses the measured 200-item candidate depth by default", () => {
    const rows = Array.from({ length: 205 }, (_, index) => row(`venue${index}`, `Venue ${index}`));
    const semanticScores = Object.fromEntries(
      rows.map((item, index) => [item.conf.key, rows.length - index]),
    );
    const result = R.venueRecommendations(
      rows,
      R.parsePaperLines("unrelated topic"),
      semanticScores,
      NOW,
    );
    expect(result.some((item: any) => item.venueKey === "venue199")).toBe(true);
  });

  it("falls back to lexical fit and keeps one availability row per venue", () => {
    const result = R.venueRecommendations(
      [row("same", "GPU Systems", NOW + 20), row("same", "GPU Systems", NOW + 10)],
      R.parsePaperLines("GPU scheduling | gpu"),
      null,
      NOW,
    );
    expect(result).toHaveLength(1);
    expect(result[0].fit.semanticRank).toBeNull();
    expect(result[0].fit.score).toBe(result[0].fit.lexicalScore);
    expect(result[0].availability).toMatchObject({ kind: "paper", status: "open" });
    expect(result[0].fit).not.toHaveProperty("timestamp");
  });

  it("reports accepted-paper evidence separately from venue-name evidence", () => {
    const result = R.venueRecommendations(
      [
        {
          ...row("icml", "ICML"),
          conf: { key: "icml", title: "ICML", full_name: "", tags: [], papers: ["Bandits"] },
        },
      ],
      R.parsePaperLines("Batched Dueling Bandits | bandits"),
      null,
      NOW,
    );
    const types = result[0].fit.evidence.map((item: any) => item.type);
    expect(types).toContain("accepted-paper");
    expect(types).not.toContain("venue-name");
  });

  it("uses deterministic key ordering for equal lexical ranks", () => {
    const result = R.venueRecommendations(
      [row("zeta", "GPU Systems"), row("alpha", "GPU Systems")],
      R.parsePaperLines("GPU scheduling | gpu"),
      null,
      NOW,
    );
    expect(result.map((item: any) => item.venueKey)).toEqual(["alpha", "zeta"]);
    expect(result.map((item: any) => item.fit.lexicalRank)).toEqual([1, 2]);
  });

  it("fuses and exposes per-field lexical ranks before semantic union", () => {
    const result = R.venueRecommendations(
      [
        {
          ...row("one-field", "One Field"),
          conf: { key: "one-field", title: "One Field", full_name: "quantum banana" },
        },
        {
          ...row("two-fields", "Two Fields"),
          conf: {
            key: "two-fields",
            title: "Two Fields",
            full_name: "quantum",
            tags: ["banana"],
          },
        },
      ],
      R.parsePaperLines("quantum banana"),
      null,
      NOW,
      { fieldedLexical: true },
    );
    expect(result.map((item: any) => item.venueKey)).toEqual(["two-fields", "one-field"]);
    expect(result[0].fit.fieldRanks).toMatchObject({ full_name: 2, tags: 1 });
    expect(result[0].fit.fieldRrf).toBeGreaterThan(result[1].fit.fieldRrf);
    expect(result[0].fit.fieldScores.tags).toBeGreaterThan(0);
  });

  it("weights higher-value fields when fusing equal field ranks", () => {
    const result = R.venueRecommendations(
      [
        {
          ...row("acronym", "Unrelated One", NOW, []),
          conf: {
            key: "acronym",
            title: "Unrelated One",
            full_name: "Unrelated One",
            acronym: "X",
          },
        },
        {
          ...row("category", "Unrelated Two", NOW, ["x"]),
          conf: {
            key: "category",
            title: "Unrelated Two",
            full_name: "Unrelated Two",
            categories: ["x"],
          },
        },
      ],
      R.parsePaperLines("X"),
      null,
      NOW,
      { fieldedLexical: true },
    );
    expect(result.map((item: any) => item.venueKey)).toEqual(["acronym", "category"]);
    expect(result[0].fit.fieldRrf).toBeGreaterThan(result[1].fit.fieldRrf);
  });

  it("matches array scope and official_scope without one hiding the other", () => {
    const result = R.venueRecommendations(
      [
        {
          ...row("scope", "Unrelated", NOW, []),
          conf: {
            key: "scope",
            title: "Unrelated",
            scope: [],
            official_scope: ["Reliable storage"],
          },
        },
      ],
      R.parsePaperLines("Reliable storage"),
      null,
      NOW,
      { fieldedLexical: true },
    );
    expect(result[0].fit.fieldScores.scope).toBe(100);
  });

  it("past-only venue reports status=past, not open (#477)", () => {
    const result = R.venueRecommendations(
      [row("past-only", "RTSS", NOW - 1000, ["systems"])],
      R.parsePaperLines("real-time scheduling | systems"),
      null,
      NOW,
    );
    expect(result).toHaveLength(1);
    expect(result[0].availability).toMatchObject({ status: "past" });
    expect(result[0].availability.timestamp).toBe(NOW - 1000);
  });

  it("future-plus-past venue prefers the future row (#477)", () => {
    const result = R.venueRecommendations(
      [
        row("fut-past", "SIGCOMM", NOW + 1000, ["networking"]),
        row("fut-past", "SIGCOMM", NOW - 1000, ["networking"]),
      ],
      R.parsePaperLines("network protocol | networking"),
      null,
      NOW,
    );
    expect(result).toHaveLength(1);
    expect(result[0].availability).toMatchObject({ kind: "paper", status: "open" });
    expect(result[0].row.t).toBe(NOW + 1000); // future row, not past
  });

  it("keeps a date-only deadline open but uncertain until its latest boundary", () => {
    const uncertain = {
      ...row("date-only", "Date Only", NOW - 1000),
      dateOnly: true,
      localDate: "2026-08-24",
      tLast: NOW + 1000,
    };
    const result = R.venueRecommendations(
      [uncertain],
      R.parsePaperLines("Date Only | hpc"),
      null,
      NOW,
    );
    expect(result[0].availability).toMatchObject({
      status: "uncertain",
      date_state: "uncertain-on-date",
      local_date: "2026-08-24",
      timestamp: null,
    });
  });

  it("estimated future deadline retains estimated flag (#477)", () => {
    const estRow = { ...row("est", "SC", NOW + 2000, ["hpc"]), est: true };
    const result = R.venueRecommendations(
      [estRow],
      R.parsePaperLines("parallel computing | hpc"),
      null,
      NOW,
    );
    expect(result).toHaveLength(1);
    expect(result[0].availability).toMatchObject({ status: "open", estimated: true });
  });

  it("past-only availability shows ongoing for journals (#477)", () => {
    const journalRow = { ...row("j", "TOCS", NOW, ["systems"]), kind: "journal" };
    const result = R.venueRecommendations(
      [journalRow],
      R.parsePaperLines("TOCS | systems"),
      null,
      NOW,
    );
    expect(result).toHaveLength(1);
    expect(result[0].availability).toMatchObject({ status: "ongoing" });
  });

  it("exposes ranking score separately from evidence strength and confidence", () => {
    const result = R.venueRecommendations(
      [row("top", "GPU Systems"), row("close", "GPU Systems")],
      R.parsePaperLines("GPU scheduling | gpu"),
      { top: 60, close: 55 },
      NOW,
    );
    expect(result).toHaveLength(2);
    expect(result[0].fit.rankingScore).toBe(result[0].fit.score);
    expect(result.map((item: any) => item.fit.confidence)).toEqual(["ambiguous", "ambiguous"]);
    expect(result.every((item: any) => item.fit.label !== "strong candidate")).toBe(true);
  });

  it("does not call weak or prior-venue-only evidence sufficient", () => {
    const weak = R.venueRecommendations(
      [row("weak", "Unrelated")],
      R.parsePaperLines("GPU scheduling | gpu"),
      { weak: 10 },
      NOW,
    )[0];
    const prior = R.venueRecommendations(
      [
        {
          ...row("rtss", "RTSS"),
          conf: { key: "rtss", title: "RTSS", full_name: "Real-Time Systems Symposium", tags: [] },
          cats: [],
        },
      ],
      R.parsePaperLines("Unrelated | keywords | RTSS"),
      null,
      NOW,
    )[0];
    expect(weak.fit.confidence).toBe("insufficient");
    expect(prior.fit.confidence).toBe("insufficient");
    expect(prior.fit.lexicalScore).toBe(40);
    expect(prior.fit.evidenceStrength).toBe(0);
  });
});

describe("recommendation bundle restoration", () => {
  it("accepts only the exact source/profile/model/runtime/hash/benchmark binding", () => {
    const root = mkdtempSync(join(tmpdir(), "kamiyobi-bundle-"));
    const out = join(root, "out");
    const bundleDir = join(root, "bundle");
    mkdirSync(out);
    mkdirSync(bundleDir);
    const data = { conferences: [], categories: {} };
    writeFileSync(join(out, "data.json"), JSON.stringify(data));
    writeFileSync(join(out, "base.txt"), "base\n");
    const manifest = embeddingManifest(data);
    const probe = Array(384).fill(0);
    const embeddings = {
      model: "Xenova/all-MiniLM-L6-v2",
      dim: 384,
      venuePapersHash: venuePapersHash(),
      manifest: {
        ...manifest,
        models: {
          en: { ...manifest.models.en, probe: { vector: probe } },
          multi: { ...manifest.models.multi, probe: { vector: probe } },
        },
      },
      embeddings: {},
      multi: { model: "Xenova/paraphrase-multilingual-MiniLM-L12-v2", dim: 384, embeddings: {} },
      paperVecs: {},
    };
    const embeddingPath = join(bundleDir, "embeddings.json");
    writeFileSync(embeddingPath, JSON.stringify(embeddings));
    writePublishManifest(
      out,
      ["data.json", "base.txt"],
      new Date("2026-08-09T00:00:00Z"),
      "lexical-only",
    );
    // restore はリポジトリの本番 reranker artifact から content id を再計算するため、
    // テストも同一入力で期待値を作る。
    const rerankerRaw = readFileSync(join(REPO_ROOT, "data", "recommender-reranker.json"));
    const reranker = JSON.parse(rerankerRaw.toString("utf8")) as Record<string, unknown>;
    const contentId = computeSemanticContentId({
      profileHash: manifest.profile_hash,
      rerankerHash: createHash("sha256").update(rerankerRaw).digest("hex"),
      algorithmRevision: String(reranker.algorithm_revision ?? ""),
      featureSchema: Array.isArray(reranker.feature_schema)
        ? (reranker.feature_schema as string[])
        : [],
      embeddingModel: EMBEDDING_MODEL,
      embeddingRevision: EMBEDDING_REVISION,
      multilingualModel: EMBEDDING_MULTI_MODEL,
      multilingualRevision: EMBEDDING_MULTI_REVISION,
      runtimeVersion: manifest.runtime_version,
    });
    // reuse では公開 commit と bundle 生成元 commit が異なるため source_commit は一致要件ではない。
    const sealed = {
      source_commit: "origin-commit-not-current",
      bundle_origin_commit: "origin-commit-not-current",
      semantic_content_id: contentId,
      profile_hash: manifest.profile_hash,
      model_revision: manifest.models.en.revision,
      runtime_version: manifest.runtime_version,
      embeddings_sha256: createHash("sha256").update(readFileSync(embeddingPath)).digest("hex"),
      required_gate: "passed",
      full_benchmark: "passed",
    };
    const restore = (change: Record<string, unknown> = {}) => {
      writeFileSync(
        join(bundleDir, "recommendation-bundle.json"),
        JSON.stringify({ ...sealed, ...change }),
      );
      return restoreRecommendationBundle(bundleDir, out);
    };
    expect(restore()).toBe(true);
    for (const [field, value] of Object.entries({
      semantic_content_id: "wrong",
      embeddings_sha256: "0".repeat(64),
      required_gate: "failed",
      full_benchmark: "failed",
    })) {
      expect(restore({ [field]: value }), field).toBe(false);
    }
  });
});

// ---- セマンティック（埋め込み） ----

describe("semantic functions", () => {
  it("cosine identical and orthogonal", () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    const c = [2, 0, 0];
    expect(R.cosine(a, c)).toBe(1); // 同じ方向 → 1
    expect(R.cosine(a, b)).toBe(0); // 直交 → 0
    expect(R.cosine([], a)).toBe(0); // 空 → 0
    expect(R.cosine(null, a)).toBe(0); // null → 0
  });

  it("embedding manifest rejects incompatible browser data", () => {
    const probe = { text: "kamiyobi embedding compatibility probe", vector: [1, 0] };
    const manifest = {
      schema: 1,
      profile_hash: "profile",
      keys: ["a"],
      models: {
        en: { model: "en", revision: "main", dim: 2, probe },
        multi: { model: "multi", revision: "main", dim: 2, probe },
      },
    };
    const bundle = {
      manifest,
      model: "en",
      dim: 2,
      embeddings: { a: [1, 0] },
      multi: { model: "multi", dim: 2, embeddings: { a: [1, 0] } },
    };
    expect(R.embeddingSetCompatible(bundle, "en")).toBe(true);
    expect(R.embeddingProbeMatches(manifest.models.en, [1, 0])).toBe(true);
    expect(R.embeddingProbeMatches(manifest.models.en, [0, 1])).toBe(false);
    // q8 量子化差 (fp32 ビルド probe vs ブラウザ q8 再計算、実測 cosine ≈ 0.9895) は
    // 互換とみなす。別モデル (実測 cosine ≈ 0.40) は引き続き拒否する。
    expect(R.embeddingProbeMatches(manifest.models.en, [0.98, Math.sqrt(1 - 0.98 ** 2)])).toBe(
      true,
    );
    expect(R.embeddingProbeMatches(manifest.models.en, [0.9, Math.sqrt(1 - 0.9 ** 2)])).toBe(false);
    expect(R.embeddingSetCompatible({ ...bundle, dim: 3 }, "en")).toBe(false);
    expect(R.embeddingSetCompatible({ ...bundle, manifest: undefined }, "en")).toBe(false);
  });

  it("semantic score scaling", () => {
    // cosine 0.2 以下は 0、1.0 で 100 にスケーリングされる
    const emb = {
      same: [1, 0, 0],
      partial: [0.8, 0.6, 0],
      orth: [0, 1, 0],
    };
    const q = [1, 0, 0];
    expect(R.semanticScore("same", q, emb)).toBe(100); // cosine=1 → 100
    expect(R.semanticScore("orth", q, emb)).toBe(0); // cosine=0 → 0
    expect(R.semanticScore("missing", q, emb)).toBe(0); // キー無し → 0
    expect(R.semanticScore("same", null, emb)).toBe(0); // query 無し → 0
  });

  it("semanticScore は paperVecs の max 類似度を使う", () => {
    const emb = { v: [1, 0, 0] }; // 会議名ベクトル: query と直交
    const paperVecs = {
      v: [
        [0, 1, 0],
        [0, 0.8, 0.6],
      ],
    }; // 論文ベクトル: 2 本目が近い
    const q = [0, 0.8, 0.6];
    // 会議名のみ: cosine=0 → 0
    expect(R.semanticScore("v", q, emb)).toBe(0);
    // paperVecs あり: 2 本目の cosine=1 → 100（max が効く）
    expect(R.semanticScore("v", q, emb, paperVecs)).toBe(100);
    // 引数なしでも setPaperVecs の状態を使う
    R.setPaperVecs(paperVecs);
    expect(R.semanticScore("v", q, emb)).toBe(100);
    R.setPaperVecs(null);
    expect(R.semanticScore("v", q, emb)).toBe(0); // クリア後は従来動作
  });

  it("matchVenueTag finds the tagged venue (PRF 用)", () => {
    const confs = [
      { key: "rtss", title: "RTSS", full_name: "The IEEE Real-Time Systems Symposium", tags: [] },
      { key: "s-p", title: "S&P", full_name: "IEEE Symposium on Security and Privacy", tags: [] },
      {
        key: "sc",
        title: "SC",
        full_name: "International Conference for High Performance Computing",
        tags: [],
      },
      {
        key: "sigmod",
        title: "SIGMOD",
        full_name: "ACM SIGMOD International Conference on Management of Data",
        tags: [],
      },
    ];
    const keys = (v: string): string[] =>
      R.matchVenueTag(v, confs).map((c: { key: string }) => c.key);
    expect(keys("IEEE RTSS")).toEqual(["rtss"]); // 名称部分一致
    expect(keys("RTSS")).toEqual(["rtss"]); // key 一致
    expect(keys("Real-Time Systems")).toEqual(["rtss"]); // full_name 部分一致
    expect(keys("SP")).toEqual(["s-p"]); // 2 文字 + エイリアス
    expect(keys("SC")).toEqual(["sc"]); // 2 文字は key 完全一致のみ
    expect(R.matchVenueTag("NoSuchVenue", confs)).toEqual([]);
    expect(R.matchVenueTag("x", confs)).toEqual([]); // 短すぎ
  });

  it("matchVenueTag handles Japanese tags and short-tag false positives", () => {
    const confs = [
      {
        key: "ipsj-sigdps",
        title: "情報処理学会 DPS 研究会",
        full_name: "情報処理学会 マルチメディア通信と分散処理研究会 (SIGDPS)",
        tags: [],
      },
      {
        key: "ipdps",
        title: "IPDPS",
        full_name: "IEEE International Parallel and Distributed Processing Symposium",
        tags: [],
      },
      { key: "isc", title: "ISC", full_name: "Information Security Conference", tags: [] },
      {
        key: "isca",
        title: "ISCA",
        full_name: "International Symposium on Computer Architecture",
        tags: [],
      },
    ];
    const keys = (v: string): string[] =>
      R.matchVenueTag(v, confs).map((c: { key: string }) => c.key);
    // 日本語タグ: 原文照合で DPS 研究会に一致し、IPDPS（"ipdps" に "dps" を含む）には誤爆しない
    expect(keys("情報処理学会 DPS 研究会")).toEqual(["ipsj-sigdps"]);
    // 短い正規化タグは完全一致のみ（"isc" が "isca" に部分一致しない）
    expect(keys("ISC")).toEqual(["isc"]);
  });

  it("venueHit: Japanese tag boosts only the matching venue", () => {
    const r = {
      conf: {
        key: "ipsj-sigdps",
        title: "情報処理学会 DPS 研究会",
        full_name: "情報処理学会 マルチメディア通信と分散処理研究会 (SIGDPS)",
        tags: [],
      },
      cats: ["systems"],
    };
    const line = {
      title: "分散システムにおける複製管理",
      keywords: "分散処理, レプリケーション",
      venue: "情報処理学会 DPS 研究会",
    };
    expect(R.breakdown(r, [line]).venueHit).toBe(true);
    // IPDPS 側では同じタグで venueHit が立たない
    const ipdps = {
      conf: {
        key: "ipdps",
        title: "IPDPS",
        full_name: "IEEE International Parallel and Distributed Processing Symposium",
        tags: [],
      },
      cats: ["hpc"],
    };
    expect(R.breakdown(ipdps, [line]).venueHit).toBe(false);
  });

  it("blendVectors mixes paper + venue and normalizes", () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    const out: number[] = R.blendVectors(a, b, 0.7);
    expect(out.length).toBe(3);
    const norm = Math.sqrt(out.reduce((s: number, x: number) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5); // L2 正規化
    expect(R.cosine(out, a)).toBeGreaterThan(R.cosine(out, b)); // 論文寄り
    expect(R.blendVectors(a, b, 1)).toEqual([1, 0, 0]); // w=1 → 論文のみ
    expect(R.blendVectors(a, null)).toEqual(a); // b 無し → そのまま
    expect(R.blendVectors([1], [1, 2])).toEqual([1]); // 長さ不一致 → そのまま
  });

  it("query text emphasizes the primary (first) line", () => {
    // 先頭行（自分の投稿予定論文）は 2 回含めて強調し、参考論文のノイズに埋没させない
    const lines = R.parsePaperLines("Paper A | kw1, kw2 | RTSS\nPaper B | kw3");
    expect(R.queryText(lines)).toBe("Paper A kw1, kw2 Paper A kw1, kw2 Paper B kw3");
  });

  it("query text single line repeats once (no semantic change)", () => {
    const lines = R.parsePaperLines("Paper A | kw1");
    expect(R.queryText(lines)).toBe("Paper A kw1 Paper A kw1");
  });

  it("query text bounds long inputs within 1800 chars while preserving title and keyword emphasis", () => {
    const longAbstract = "distributed system evaluation and fault tolerance ".repeat(50); // > 2500 chars
    const lines = R.parsePaperLines(`Ultra Scale Consensus | raft, paxos | OSDI\n${longAbstract}`);
    const q = R.queryText(lines);
    expect(q.length).toBeLessThanOrEqual(1800);
    expect(q.startsWith("Ultra Scale Consensus raft, paxos")).toBe(true);
    expect(q).toContain("distributed system evaluation");
  });

  it("query text handles empty lines gracefully", () => {
    expect(R.queryText([])).toBe("");
  });
});

describe("blendScore", () => {
  it("mid/long English queries blend at 0.4/0.6", () => {
    expect(R.blendScore(40, 60)).toBe(52); // 既定 len=undefined → 0.4: round(40×0.4+60×0.6) = 52
    expect(R.blendScore(40, 60, { len: 8 })).toBe(52);
    expect(R.blendScore(40, 60, { len: 5 })).toBe(52);
  });

  it("short English queries blend semantic-heavy at 0.25/0.75", () => {
    expect(R.blendScore(40, 60, { len: 2 })).toBe(55); // round(40×0.25+60×0.75) = 55
    expect(R.blendScore(0, 80, { len: 3 })).toBe(60);
  });

  it("falls back to vocab score when semantic is unavailable", () => {
    expect(R.blendScore(40, 0)).toBe(40);
    expect(R.blendScore(40, null)).toBe(40);
    expect(R.blendScore(52, undefined)).toBe(52);
  });

  it("0.6/0.4 blend for Japanese papers (vocab is the stronger signal)", () => {
    expect(R.blendScore(40, 60, { jp: true })).toBe(48); // round(40×0.6+60×0.4) = 48
    expect(R.blendScore(0, 80, { jp: true })).toBe(32);
    expect(R.blendScore(50, 50, { jp: true })).toBe(50);
  });

  it("explicit jpw override wins (benchmark sweep support)", () => {
    expect(R.blendScore(40, 60, { jp: true, jpw: 0.7 })).toBe(46); // round(40×0.7+60×0.3) = 46
    expect(R.blendScore(40, 60, { jpw: 0.3 })).toBe(54);
  });
});

describe("contentWordCount", () => {
  it("counts distinct content words, ignoring stopwords and short words", () => {
    expect(
      R.contentWordCount(
        "Time-Sensitive Networking Scheduling for Deterministic Industrial Networks",
      ),
    ).toBe(5);
    expect(R.contentWordCount("the a and of for")).toBe(0);
    expect(R.contentWordCount("")).toBe(0);
    expect(R.contentWordCount(null)).toBe(0);
  });

  it("does not count Japanese (english-only counter)", () => {
    expect(R.contentWordCount("分散システムにおける低遅延ミドルウェア")).toBe(0);
  });
});

describe("expandJp (表示用の日本語→英語展開)", () => {
  it("expands Japanese domain words to English", () => {
    const out = R.expandJp("低遅延リアルタイムシステム");
    expect(out).toContain("latency");
    expect(out).toContain("real-time");
  });

  it("expands modern systems and AI domain terms (eBPF, CXL, confidential computing, LLM inference, RAG, tensor parallelism, RDMA)", () => {
    expect(R.expandJp("カーネル拡張とトレーシング")).toContain("ebpf kernel tracing");
    expect(R.expandJp("メモリアーキテクチャの評価")).toContain(
      "cxl compute express link interconnect",
    );
    expect(R.expandJp("機密計算と信頼実行環境の評価")).toContain(
      "confidential computing tee secure enclave",
    );
    expect(R.expandJp("LLM推論の高速化と大規模言語モデル")).toContain(
      "large language model llm inference kv cache",
    );
    expect(R.expandJp("検索拡張生成システム")).toContain("retrieval augmented generation rag");
    expect(R.expandJp("テンソル並列と分散学習")).toContain(
      "tensor parallelism pipeline distributed training",
    );
    expect(R.expandJp("高速通信による最適化")).toContain(
      "rdma remote direct memory access infiniband",
    );
  });

  it("returns empty for English or empty text without domain keywords", () => {
    expect(R.expandJp("Kubernetes with eBPF")).toBe("");
    expect(R.expandJp("Kubernetes on Container Engine")).toBe("");
    expect(R.expandJp("")).toBe("");
  });

  it("can be disabled (benchmark A/B hook)", () => {
    R.setExpandEnabled(false);
    expect(R.expandJp("低遅延")).toBe("");
    R.setExpandEnabled(true);
    expect(R.expandJp("低遅延")).toContain("latency");
  });
});

describe("hasJapanese", () => {
  it("detects hiragana/katakana/kanji", () => {
    expect(R.hasJapanese("分散システムにおける低遅延ミドルウェア")).toBe(true);
    expect(R.hasJapanese("コンピュータ ネットワーク")).toBe(true);
    expect(R.hasJapanese("Kubernetes Service Mesh with eBPF")).toBe(false);
    expect(R.hasJapanese("")).toBe(false);
    expect(R.hasJapanese(null)).toBe(false);
  });
});

describe("wordInText (形態素・複数形・語境界照合 #282)", () => {
  it.each([
    ["bandit", "bandits", true],
    ["bandits", "bandit", true],
    ["system", "systems", true],
    ["systems", "system", true],
    ["process", "automated processes", true],
    ["processes", "storage process", true],
    ["access", "memory accesses in cxl", true],
    ["accesses", "direct access storage", true],
    ["wireless", "wireless communications", true],
    ["wireless", "wirelesses network", true],
    ["memory", "non-volatile memories", true],
    ["memories", "memory hierarchy", true],
    ["technology", "emerging technologies", true],
    ["technologies", "semiconductor technology", true],
    ["search", "efficient searches in databases", true],
    ["searches", "heuristic search algorithm", true],
    ["approach", "novel approaches", true],
    ["approaches", "scalable approach", true],
    ["index", "spatial indexes", true],
    ["indexes", "b-tree index", true],
    ["wireles", "wireless communication", false],
    ["trans", "transcompiling c++", false],
    ["syst", "distributed systems", false],
  ])("matches %s in '%s' -> %s", (word, hay, expected) => {
    expect(R.wordInText(hay, word)).toBe(expected);
  });

  it("handles null/undefined/empty gracefully", () => {
    expect(R.wordInText(null, "system")).toBe(false);
    expect(R.wordInText("system", null)).toBe(false);
    expect(R.wordInText("", "")).toBe(false);
  });
});

describe("venue normalization robustness", () => {
  const rows = [
    {
      conf: {
        key: "s-p",
        title: "S&P",
        full_name: "IEEE Symposium on Security and Privacy",
      },
      cats: ["security"],
    },
    {
      conf: {
        key: "sigcomm",
        title: "SIGCOMM",
        full_name: "ACM Special Interest Group on Data Communication",
      },
      cats: ["networking"],
    },
  ];
  const hit = (paper: string, key: string): boolean => {
    const row = rows.find((r) => r.conf.key === key)!;
    return R.breakdown(row, R.parsePaperLines(paper)).venueHit;
  };

  it("SP short alias matches IEEE S&P", () => {
    expect(hit("Paper on side channels | security | SP", "s-p")).toBe(true);
  });

  it("& vs and spelling variant matches", () => {
    expect(
      hit("Paper on side channels | security | IEEE Symposium on Security & Privacy", "s-p"),
    ).toBe(true);
  });

  it("proceedings-style venue string with filler words matches", () => {
    expect(
      hit(
        "Paper on side channels | security | Proceedings of the IEEE Symposium on Security and Privacy",
        "s-p",
      ),
    ).toBe(true);
  });

  it("S&P spelling does not leak to other conferences", () => {
    expect(hit("Paper on side channels | security | SP", "sigcomm")).toBe(false);
  });
});

// ---- 実データ統合テスト（public/data.json があるときのみ） ----

describe.skipIf(!hasData)("real data integration", () => {
  const makeScript = (papers: string, topN = 10): { cats: string[]; top: any[]; n: number } => {
    const rows = loadRows();
    const lines = R.parsePaperLines(papers);
    const cats = R.autoDetectCats(lines);
    // venueRecommendations と同じ経路で breakdown().venueScore を使って順位付けする。
    // scorePapers はタグ付き行を reference 重みで希釈するため、会議数が増えると
    // 同点タイが崩れて venueHit 会議が圏外に沈む（#514）。
    const scored = rows
      .map((r) => {
        const b = R.breakdown(r, lines);
        return { key: r.conf.key, score: b.venueScore, hit: b.venueHit };
      })
      .filter((x) => x.score >= 10)
      .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
    return { cats, top: scored.slice(0, topN), n: scored.length };
  };

  it("venuePapersHash は決定的で内容変化を反映する", () => {
    const h1 = venuePapersHash();
    const h2 = venuePapersHash();
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
  });

  it("embeddings.json covers all conferences", () => {
    if (!existsSync(EMB_JSON)) return;
    const emb = JSON.parse(readFileSync(EMB_JSON, "utf8"));
    const data = JSON.parse(readFileSync(DATA_JSON, "utf8"));
    const keys = new Set<string>(data.conferences.map((c: any) => c.key));
    const embKeys = new Set(Object.keys(emb.embeddings ?? {}));
    expect([...keys].every((k) => embKeys.has(k))).toBe(true);
    const dims = new Set(Object.values(emb.embeddings).map((v: any) => v.length));
    expect(dims).toEqual(new Set([emb.dim]));
  });

  it("TSN paper finds real-time venues", () => {
    const { cats, top } = makeScript(
      "投稿予定: Credit-Based Shaping for Deterministic Latency in Time-Sensitive Networking | " +
        "TSN, CBS, latency, scheduling, Ethernet, real-time\n" +
        "似た論文: Design and Analysis of Credit-Based Shapers in TSN | TSN, CBS, QoS | RTSS\n" +
        "似た論文: Low-Latency Scheduling for Time-Sensitive Networks | scheduling, latency | IWQoS",
      8,
    );
    expect(cats).toContain("networking");
    const keys = top.map((t) => t.key);
    expect(keys.some((k) => k.includes("rtss"))).toBe(true); // RTSS（掲載先タグ）が top 圏内
    expect(top.some((t) => t.hit)).toBe(true);
  });

  it("storage paper lands systems", () => {
    const { cats, top } = makeScript(
      "A Scalable Log-Structured Storage Engine for Multitenant Cloud Servers | " +
        "storage, log-structured, cloud, multitenant, scalability\n" +
        "The Design of a Log-Structured File System | log-structured, filesystem, storage | FAST",
      8,
    );
    expect(cats).toContain("systems");
    const keys = top.map((t) => t.key);
    expect(keys.some((k) => k.includes("fast"))).toBe(true);
  });

  it("no papers no match", () => {
    const { cats, top, n } = makeScript("", 5);
    expect(cats).toEqual([]);
    expect(top).toEqual([]);
    expect(n).toBe(0);
  });

  it("security paper lands top tier", () => {
    const { cats, top } = makeScript(
      "Post-Quantum Key Exchange for Encrypted Network Traffic | security, crypto, encryption, privacy, attack\n" +
        "SoK: Hardware-Enforced Memory Isolation | security, enclave, sgx, memory | IEEE Symposium on Security & Privacy",
      10,
    );
    expect(cats).toContain("security");
    const keys = top.map((t) => t.key).join(" ");
    // IEEE S&P / USENIX Security / CCS のいずれかが上位に来る（タグ投票で S&P が必ず入る）
    expect(
      ["ieee-symposium-on-security", "usenix-security", "ccs"].some((x) => keys.includes(x)),
    ).toBe(true);
  });

  it("ML paper lands NeurIPS/ICML", () => {
    const { cats, top } = makeScript(
      "Scaling Laws for Transformer Language Models | transformer, llm, deep learning, neural, machine learning\n" +
        "Diffusion Models for Generative Image Synthesis | diffusion, generative, image | NeurIPS",
      10,
    );
    expect(cats).toContain("ai");
    const keys = top.map((t) => t.key);
    expect(keys.some((k) => k.includes("neurips"))).toBe(true);
  });

  it("venue tag beats generic category noise", () => {
    // タグ付き掲載先（RTSS）は、カテゴリ一致だけの無関係会議（ASAP 等）より明確に上位
    const { top } = makeScript(
      "投稿予定: Credit-Based Shaping for Deterministic Latency in TSN | TSN, CBS, latency, scheduling, Ethernet, real-time\n" +
        "似た論文: Design and Analysis of Credit-Based Shapers in TSN | TSN, CBS, QoS | RTSS",
      12,
    );
    const scores = Object.fromEntries(top.map((t) => [t.key, t.score]));
    expect(scores.rtss ?? 0).toBeGreaterThan(scores.asap ?? 0);
    expect(scores.rtss ?? 0).toBeGreaterThan(scores.ase ?? 0);
    const rtss = top.find((t) => t.key === "rtss");
    expect(rtss?.hit).toBe(true);
  });

  it("short venue tag SC matches by key", () => {
    // 2 文字タグ（SC）は key 完全一致で掲載先として効く
    const { top } = makeScript(
      "Scheduling Large-Scale MPI Jobs on Heterogeneous Supercomputers | HPC, MPI, scheduling, cluster, GPU\n" +
        "Supercomputing Interconnect for Exascale Systems | interconnect, HPC, network | SC",
      12,
    );
    const sc = top.find((t) => t.key === "sc");
    expect(sc).toBeTruthy();
    expect(sc.hit).toBe(true);
    const cluster = top.find((t) => t.key === "cluster");
    if (cluster) expect(sc.score).toBeGreaterThan(cluster.score);
  });

  it("Japanese paper finds Japanese venues", () => {
    const { top } = makeScript(
      "分散システムにおける低遅延ミドルウェア | 分散, ミドルウェア, 低遅延, システム",
      12,
    );
    const scores = Object.fromEntries(top.map((t) => [t.key, t.score]));
    const jpHits = top.filter((t) => t.score >= 20).map((t) => t.key);
    expect(jpHits.length).toBeGreaterThanOrEqual(1); // 日本語会議名（comsys/ipsj-sigarc 等）が拾われる
    expect(Math.max(...jpHits.map((k) => scores[k] ?? 0))).toBeGreaterThan(scores.asap ?? 0);
  });

  it("Japanese paper without keywords matches Japanese venues on title alone", () => {
    const { top } = makeScript("分散システムにおける低遅延ミドルウェア", 12);
    const scores = Object.fromEntries(top.map((t) => [t.key, t.score]));
    const dps = top.find((t) => t.key === "ipsj-sigdps");
    expect(dps).toBeTruthy();
    expect(scores["ipsj-sigdps"]).toBeGreaterThanOrEqual(30);
  });

  it("scoreLine recognizes 3-letter conference acronyms in nameWords", () => {
    const rows = loadRows();
    const cgo = rows.find((r) => r.conf.key === "ieee-acm-cgo");
    expect(cgo).toBeTruthy();
    const lines = R.parsePaperLines(
      "CGO 2026: Code Generation and Optimization for Heterogeneous Accelerators",
    );
    const b = R.breakdown(cgo, lines);
    expect(b.perLine[0]?.details.name).toBeGreaterThan(0);
  });

  it("recommends xSIG and SCIS for Japanese system and security papers", () => {
    const xsigRow = {
      conf: {
        key: "xsig",
        title: "xSIG",
        full_name:
          "計算機システム・基盤・プログラミングに関する分野横断的ワークショップ (xSIG / cross-disciplinary Workshop on Computing Systems, Infrastructures, and Programming)",
        acronym: "xSIG",
        tags: ["domestic-jp", "workshop"],
      },
      cats: ["systems", "hpc"],
      tags: ["domestic-jp", "workshop"],
    };
    const lines = R.parsePaperLines(
      "計算機システムにおける省電力スケジューリングとプロセッサアーキテクチャ",
    );
    const b = R.breakdown(xsigRow, lines);
    expect(b.score).toBeGreaterThanOrEqual(40);
    expect(b.agg.jp).toBe(30);

    const scisRow = {
      conf: {
        key: "ieice-scis",
        title: "SCIS",
        full_name: "暗号と情報セキュリティシンポジウム (SCIS)",
        acronym: "SCIS",
        tags: ["domestic-jp", "symposium"],
      },
      cats: ["security"],
      tags: ["domestic-jp", "symposium"],
    };
    const scisLines = R.parsePaperLines("共通鍵暗号の安全性評価と代数攻撃に関する考察");
    const bScis = R.breakdown(scisRow, scisLines);
    expect(bScis.score).toBeGreaterThanOrEqual(40);
    expect(bScis.agg.jp).toBe(30);
  });

  it("recommends SCAsia and HPCAsia for regional supercomputing queries", () => {
    const scaRow = {
      conf: {
        key: "sc-asia",
        title: "SCAsia",
        full_name: "SupercomputingAsia",
        acronym: "SCA",
        tags: [],
      },
      cats: ["hpc"],
      tags: [],
    };
    const lines = R.parsePaperLines("SupercomputingAsia: High Performance Computing Architectures");
    const b = R.breakdown(scaRow, lines);
    expect(b.score).toBeGreaterThanOrEqual(30);
    expect(b.agg.name).toBeGreaterThan(0);
  });

  it("paper mode pipeline: dedupes, past reps and journals included", () => {
    // 論文モード: 未来締切 + 未来の無い会議の過去代表 + 常時受付ジャーナルを網羅し、
    // 会議単位に集約してスコア降順で並ぶ（網羅性を優先する設計）
    const data = JSON.parse(readFileSync(DATA_JSON, "utf8"));
    const rows: any[] = [];
    for (const c of data.conferences) {
      for (const ed of c.editions ?? []) {
        for (const dl of ed.deadlines ?? []) {
          rows.push({
            conf: c,
            ed,
            cats: c.categories ?? [],
            key: c.key,
            kind: dl.kind ?? "deadline",
            t: Date.parse(dl.utc),
            tLast: Date.parse(dl.utc),
            est: !!(dl.estimated || ed.estimated),
            rankPairs: [],
            name: c.title,
            year: ed.year,
          });
        }
      }
    }
    const pLines = R.parsePaperLines(
      "Credit-Based Shaping for Deterministic Latency in TSN | TSN, CBS, latency, real-time\n" +
        "Similar Paper on TSN Scheduling | scheduling, TSN | RTSS",
    );
    const venueCats = R.venueCategories(pLines, rows);
    const pool = rows.concat(
      R.journalRows(data.conferences, NOW),
      R.pastRepresentatives(rows, NOW),
    );
    let out = pool
      .filter((r) => r.kind === "abstract" || r.kind === "paper" || r.kind === "journal")
      .filter((r) => !(r.est && r.t < NOW))
      .map((r) => {
        const m = R.breakdown(r, pLines);
        let score = m.score;
        if (!m.venueHit && venueCats.length) {
          const shared = (r.cats ?? []).some((k: string) => venueCats.includes(k));
          if (shared) score = Math.min(100, score + 10);
        }
        r._matchScore = score;
        return r;
      })
      .filter((r) => r._matchScore >= 10);
    out.sort((a, b) => R.comparePapers(a, b, NOW));
    out = R.pickRepresentative(out, NOW);

    const keys = out.map((r) => r.conf.key);
    const unique = new Set(keys).size === keys.length;
    const sorted = out.every((r, i) => i === 0 || out[i - 1]._matchScore >= r._matchScore);
    const rtasIdx = keys.indexOf("rtas");
    const rtssIdx = keys.indexOf("rtss");
    const hasJournal = out.some((r) => r.kind === "journal");

    expect(unique).toBe(true); // 会議単位に集約
    expect(sorted).toBe(true); // スコア降順
    expect(rtasIdx >= 0 && rtasIdx < 3).toBe(true); // RTAS が上位
    expect(rtssIdx).toBe(0); // 掲載先タグ付き過去行 (RTSS) が最上位
    expect(hasJournal).toBe(true); // 常時受付ジャーナルが含まれる
  });
});

describe("regression-known と VENUE_PAPERS の分離", () => {
  it("regression-known のタイトルは強化用 VENUE_PAPERS と重複しない", () => {
    // regression-known（実採択論文）と embeddings の VENUE_PAPERS（会議プロファイル強化）は
    // 完全分離が契約（テストに正解を学習させない）。タイトルを正規化して照合する。
    const norm = (s: string): string =>
      String(s ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
    const regressionFixture = JSON.parse(
      readFileSync(join(REPO_ROOT, "data", "benchmarks", "regression-known.json"), "utf8"),
    ) as { records: Array<{ title: string; key: string }> };
    const profileArtifact = JSON.parse(
      readFileSync(join(REPO_ROOT, "data", "venue-profiles.json"), "utf8"),
    ) as {
      profiles: Record<string, { papers: Array<{ title: string }> }>;
    };
    const goldenTitles = regressionFixture.records.map((record) => norm(record.title));
    const paperTitles = Object.values(profileArtifact.profiles)
      .flatMap((profile) => profile.papers.map((paper) => paper.title))
      .map(norm);
    expect(goldenTitles.length).toBe(92); // 旧 GOLDEN_EN の全件を既知回帰へ移管
    const overlap = goldenTitles.filter((t) => t.length > 10 && paperTitles.includes(t));
    expect(overlap).toEqual([]); // 完全分離
  });

  it("GENERIC_PAPER_WORDS: papers 語彙の汎用語（self/general/framework 等）は加点されない", () => {
    // rtss の papers 語彙（self/general/framework/vision/language）が data2vec
    // クエリに 5 ヒットして 49 点を稼ぎ、sem が効く icml を blendScore の減衰で下回って
    // top1 を奪った。self/general/framework は論文タイトルに頻出するが会議の識別に
    // 寄与しない汎用語 — papers 語彙マッチから除外する（名前語マッチには影響しない）。
    R.setNameIdf(null);
    try {
      const b = R.breakdown(
        {
          conf: {
            key: "t-conf",
            title: "Test Conference",
            full_name: "",
            tags: [],
            papers: ["A General Framework for Self-Supervised Vision Learning"],
          },
          cats: [],
        },
        R.parsePaperLines(
          "data2vec: A General Framework for Self-supervised Learning in Speech, Vision and Language",
        ),
      );
      // GENERIC 除外後: paper 語彙で残るのは supervised + vision（+30）。
      // self/general/framework/learning は除外（supervised は self-supervised の専門語として残す）。
      expect(b.agg.name).toBe(30);
    } finally {
      R.setNameIdf(null);
    }
  });

  it("wordInText: 略語 trans は Transcompiling に部分マッチしない", () => {
    R.setNameIdf(null);
    try {
      // ieice の略語 trans/syst が QiMeng の Transcompiling/Systems に部分一致して
      // 語境界一致で 0 になるはず。
      const b = R.breakdown(
        {
          conf: {
            key: "ieice-special",
            title: "IEICE Trans. Inf. & Syst. 特集号",
            full_name:
              "Special Section on Log Data Usage Technology and Office Information Systems",
            tags: [],
            papers: [],
          },
          cats: [],
        },
        R.parsePaperLines(
          "QiMeng-Xpiler: Transcompiling Tensor Programs for Deep Learning Systems with a Neural-Symbolic Approach",
        ),
      );
      expect(b.agg.name).toBe(0);
    } finally {
      R.setNameIdf(null);
    }
  });

  it("wordInText: 単複形（bandit→bandits）はマッチを維持する", () => {
    R.setNameIdf(null);
    try {
      // 純粋な語境界だと bandit ⊂ Bandits が消え、Batched Dueling Bandits が icml を
      // 末尾 s は許容する。
      const b = R.breakdown(
        {
          conf: {
            key: "t-conf",
            title: "Test Conference",
            full_name: "",
            tags: [],
            papers: ["Thresholded Lasso Bandit"],
          },
          cats: [],
        },
        R.parsePaperLines("Batched Dueling Bandits"),
      );
      expect(b.agg.name).toBeGreaterThanOrEqual(15);
    } finally {
      R.setNameIdf(null);
    }
  });

  it("GENERIC_PAPER_WORDS は名前語マッチに影響しない", () => {
    R.setNameIdf(null);
    try {
      // "learning" は GENERIC_PAPER_WORDS にあるが、名前語としては識別力があるので加点される
      const b = R.breakdown(
        {
          conf: {
            key: "t-conf",
            title: "Test Conference",
            full_name: "International Conference on Machine Learning",
            tags: [],
            papers: [],
          },
          cats: [],
        },
        R.parsePaperLines("self-supervised learning for speech"),
      );
      expect(b.agg.name).toBeGreaterThanOrEqual(15);
    } finally {
      R.setNameIdf(null);
    }
  });

  it("paperVecs は skipEmb 会議にのみ付与される", () => {
    const embSrc = readFileSync(join(REPO_ROOT, "src", "embeddings.ts"), "utf8");
    // usenix-security, rtss に paperVecs を付与
    expect(embSrc).toContain("for (const key of PAPER_VEC_KEYS)");
    // ecrts も paperVecs は持たないが埋め込み本文からは除外
    expect(embSrc).toContain('const SKIP_EMB_KEYS = new Set([...PAPER_VEC_KEYS, "ecrts"]);');
  });
});

describe("bench-recommender argument parsing and helper utilities", () => {
  it("parseBenchArgs accepts the versioned benchmark fixture and defaults json to false", () => {
    expect(parseBenchArgs([]).json).toBe(false);
    expect(parseBenchArgs(["--samples", "0"]).json).toBe(false);
    expect(parseBenchArgs(["--json"]).json).toBe(true);
    expect(parseBenchArgs(["--json=true"]).json).toBe(true);
    expect(parseBenchArgs(["--json=false"]).json).toBe(false);
    expect(parseBenchArgs(["--v2", "tests/fixtures/bench-v2.json"]).v2).toBe(
      "tests/fixtures/bench-v2.json",
    );
    expect(
      parseBenchArgs([
        "--real-v2-dev",
        "data/benchmarks/real-paper-dev.json",
        "--real-v2-heldout",
        "data/benchmarks/real-paper-heldout.json",
      ]),
    ).toEqual(
      expect.objectContaining({
        realV2Dev: "data/benchmarks/real-paper-dev.json",
        realV2Heldout: "data/benchmarks/real-paper-heldout.json",
      }),
    );
  });

  it("runBenchmarkV2 reports deterministic venue-level ranking metrics", () => {
    const fixture = JSON.parse(
      readFileSync(join(REPO_ROOT, "tests", "fixtures", "bench-v2.json"), "utf8"),
    );
    const result = runBenchmarkV2(fixture);
    expect(result.version).toBe(2);
    for (const split of ["synthetic", "dev", "heldout"] as const) {
      expect(result.splits[split].queries).toBeGreaterThan(0);
      for (const mode of ["lexical", "semantic", "fused"] as const) {
        expect(result.splits[split].modes[mode]).toEqual(
          expect.objectContaining({
            mrr: expect.any(Number),
            top1Accuracy: expect.any(Number),
            coverage: expect.any(Number),
            "recall@1": expect.any(Number),
            "recall@5": expect.any(Number),
            "recall@10": expect.any(Number),
            "ndcg@5": expect.any(Number),
            "ndcg@10": expect.any(Number),
          }),
        );
      }
    }
    expect(result.splits.heldout.queries).toBe(2);
    expect(result.splits.heldout.modes.fused.coverage).toBeGreaterThan(0);
    expect(result.splits.heldout.candidate_retrieval.union_recall_at_50).toBe(1);
    expect(result.splits.heldout.fused_mrr_lcb).toBe(1);
    expect(result.splits.heldout.calibration.brier_score).toBeTypeOf("number");
    expect(benchV2RequiredRegressionReasons(result)).toEqual([]);
    expect(result).toEqual(runBenchmarkV2(JSON.parse(JSON.stringify(fixture))));
  });

  it("fails the fixed semantic-score gate when heldout retrieval is mutated", () => {
    const fixture = JSON.parse(
      readFileSync(join(REPO_ROOT, "tests", "fixtures", "bench-v2.json"), "utf8"),
    );
    for (const query of fixture.queries.filter(
      (item: { split: string }) => item.split === "heldout",
    )) {
      for (const key of Object.keys(query.semantic)) query.semantic[key] = 0;
    }
    expect(benchV2RequiredRegressionReasons(runBenchmarkV2(fixture))).not.toEqual([]);
  });

  it("runBenchmarkV2 rejects duplicate query titles as leakage", () => {
    const fixture = JSON.parse(
      readFileSync(join(REPO_ROOT, "tests", "fixtures", "bench-v2.json"), "utf8"),
    );
    fixture.queries[1].title = fixture.queries[0].title;
    expect(() => runBenchmarkV2(fixture)).toThrow(/leak|duplicate|split/);
  });

  it("validates real-paper dev/heldout fixtures and rejects leakage", () => {
    const dev = JSON.parse(
      readFileSync(join(REPO_ROOT, "data", "benchmarks", "real-paper-dev.json"), "utf8"),
    );
    const heldout = JSON.parse(
      readFileSync(join(REPO_ROOT, "data", "benchmarks", "real-paper-heldout.json"), "utf8"),
    );
    const negative = JSON.parse(
      readFileSync(join(REPO_ROOT, "data", "benchmarks", "real-paper-negative.json"), "utf8"),
    );
    const venues = new Set(
      [...dev.records, ...heldout.records].flatMap(
        (record: { acceptable_venues: string[] }) => record.acceptable_venues,
      ),
    );
    validateRealPaperFixtures(dev, heldout, venues, {});
    validateRealPaperFixtures(dev, heldout, venues, {}, undefined, negative);
    expect({
      dev: dev.records.length,
      heldout: heldout.records.length,
      negative: negative.records.length,
    }).toEqual({
      dev: 80,
      heldout: 80,
      negative: 41,
    });
    expect(new Set(negative.records.map((record: any) => record.language))).toEqual(
      new Set(["en", "ja"]),
    );
    expect(new Set(negative.records.map((record: any) => record.input_mode))).toEqual(
      new Set(["title-only", "title+abstract"]),
    );
    expect(new Set(negative.records.map((record: any) => record.negative_reason))).toEqual(
      new Set(["venue-not-in-catalog", "insufficient-content", "ambiguous-scope", "near-boundary"]),
    );
    expect(dev.records.every((record: Record<string, unknown>) => !("semantic" in record))).toBe(
      true,
    );
    for (const fixture of [dev, heldout]) {
      expect(new Set(fixture.records.flatMap((record: any) => record.domains))).toEqual(
        new Set([
          "hpc",
          "systems",
          "networking",
          "ai",
          "security",
          "db",
          "graphics",
          "hci",
          "theory",
        ]),
      );
      expect(new Set(fixture.records.map((record: any) => record.language))).toEqual(
        new Set(["en", "ja"]),
      );
      expect(new Set(fixture.records.map((record: any) => record.venue_scope))).toEqual(
        new Set(["international", "domestic"]),
      );
      expect(new Set(fixture.records.map((record: any) => record.venue_kind))).toEqual(
        new Set(["conference", "workshop", "journal", "special-issue"]),
      );
      expect(new Set(fixture.records.map((record: any) => record.input_mode))).toEqual(
        new Set(["title-only", "title+abstract", "pdf-extract"]),
      );
      expect(
        fixture.records.every((record: any) =>
          record.annotation_evidence.every(
            (evidence: any) =>
              evidence.reason !== "curated acceptable alternate venue for the benchmark label",
          ),
        ),
      ).toBe(true);
      expect(
        fixture.provenance.sources.every(
          (source: any) =>
            /^https:\/\//.test(source.url) &&
            source.revision.length > 0 &&
            /^[a-f0-9]{64}$/.test(source.sha256),
        ),
      ).toBe(true);
    }
    const heldoutVenueCounts = Object.values(
      Object.groupBy(heldout.records, (record: any) => record.primary_venue),
    ).map((records) => records!.length);
    expect(Math.max(...heldoutVenueCounts) / heldout.records.length).toBeLessThanOrEqual(0.25);
    expect(
      heldout.records.filter((record: any) => record.acceptable_venues.length === 1).length /
        heldout.records.length,
    ).toBeLessThanOrEqual(0.25);
    const requiredDev = JSON.parse(
      readFileSync(join(REPO_ROOT, "data", "benchmarks", "real-paper-required-dev.json"), "utf8"),
    );
    const requiredHeldout = JSON.parse(
      readFileSync(
        join(REPO_ROOT, "data", "benchmarks", "real-paper-required-heldout.json"),
        "utf8",
      ),
    );
    validateRealPaperFixtures(
      requiredDev,
      requiredHeldout,
      venues,
      {},
      undefined,
      undefined,
      "required",
    );
    for (const fixture of [requiredDev, requiredHeldout]) {
      expect(new Set(fixture.records.map((record: any) => record.language))).toEqual(
        new Set(["en", "ja"]),
      );
      expect(
        new Set(fixture.records.flatMap((record: any) => record.domains)).size,
      ).toBeGreaterThan(2);
    }

    const mutate = (fixture: any, change: (copy: any) => void, message: RegExp) => {
      const copy = JSON.parse(JSON.stringify(fixture));
      change(copy);
      expect(() => validateRealPaperFixtures(dev, copy, venues, {})).toThrow(message);
    };
    mutate(
      heldout,
      (copy) =>
        copy.records.forEach((record: any) => {
          record.language = "en";
        }),
      /language coverage/,
    );
    mutate(
      heldout,
      (copy) =>
        copy.records.forEach((record: any) => {
          record.venue_scope = "international";
        }),
      /venue scope coverage/,
    );
    mutate(
      heldout,
      (copy) =>
        copy.records.forEach((record: any) => {
          record.venue_kind = "conference";
        }),
      /venue kind coverage/,
    );
    mutate(
      heldout,
      (copy) =>
        copy.records.forEach((record: any) => {
          delete record.abstract;
          delete record.pdf_text;
          delete record.pdf_sha256;
          record.input_mode = "title-only";
        }),
      /input mode coverage/,
    );
    mutate(
      heldout,
      (copy) =>
        copy.records.forEach((record: any) => {
          record.domains = ["systems"];
        }),
      /category coverage/,
    );
    mutate(
      heldout,
      (copy) =>
        copy.records.slice(0, 21).forEach((record: any) => {
          record.primary_venue = "nsdi";
          record.acceptable_venues = ["nsdi"];
        }),
      /25%/,
    );
    mutate(
      heldout,
      (copy) => {
        copy.records[0].acceptable_venues.push("sigcomm");
        copy.records[0].annotation_evidence.push({
          venue: "sigcomm",
          reason: "curated acceptable alternate venue for the benchmark label",
          source: copy.records[0].source,
        });
      },
      /independent record-level evidence/,
    );
    mutate(heldout, (copy) => (copy.provenance.sources[0].sha256 = "bad"), /source provenance/);
    mutate(
      heldout,
      (copy) => {
        const original = copy.provenance.sources[0].url;
        copy.provenance.sources[0].url = "https://example.com/paper";
        copy.records
          .filter((record: any) => record.source === original)
          .forEach((record: any) => {
            record.source = "https://example.com/paper";
          });
      },
      /approved https source/,
    );
    mutate(heldout, (copy) => (copy.records[0].paper_id = dev.records[0].paper_id), /duplicate id/);
    mutate(heldout, (copy) => (copy.records[0].title = ""), /missing title/);

    const leaked = JSON.parse(JSON.stringify(heldout));
    leaked.records[0].title = dev.records[0].title;
    expect(() => validateRealPaperFixtures(dev, leaked, venues, {})).toThrow(
      /exact-title|duplicate/,
    );

    const negativeLeaked = JSON.parse(JSON.stringify(negative));
    negativeLeaked.records[0].title = dev.records[0].title;
    expect(() =>
      validateRealPaperFixtures(dev, heldout, venues, {}, undefined, negativeLeaked),
    ).toThrow(/exact-title|duplicate/);

    const negativeMissingJapanese = JSON.parse(JSON.stringify(negative));
    negativeMissingJapanese.records.forEach((record: any) => {
      record.language = "en";
    });
    expect(() =>
      validateRealPaperFixtures(dev, heldout, venues, {}, undefined, negativeMissingJapanese),
    ).toThrow(/negative real paper lacks language coverage/);

    const negativeMissingAbstract = JSON.parse(JSON.stringify(negative));
    negativeMissingAbstract.records.forEach((record: any) => {
      delete record.abstract;
      record.input_mode = "title-only";
    });
    expect(() =>
      validateRealPaperFixtures(dev, heldout, venues, {}, undefined, negativeMissingAbstract),
    ).toThrow(/negative real paper lacks input mode coverage/);

    const negativeMissingBoundary = JSON.parse(JSON.stringify(negative));
    negativeMissingBoundary.records.forEach((record: any) => {
      record.negative_reason = "venue-not-in-catalog";
    });
    expect(() =>
      validateRealPaperFixtures(dev, heldout, venues, {}, undefined, negativeMissingBoundary),
    ).toThrow(/negative real paper lacks reason coverage/);

    const timeLeaked = JSON.parse(JSON.stringify(heldout));
    timeLeaked.records[0].year = 2024;
    timeLeaked.profile_year_max = 2023;
    expect(() => validateRealPaperFixtures(dev, timeLeaked, venues, {})).toThrow(
      /strictly ordered/,
    );

    const known = JSON.parse(
      readFileSync(join(REPO_ROOT, "data", "benchmarks", "regression-known.json"), "utf8"),
    );
    const knownLeaked = JSON.parse(JSON.stringify(heldout));
    knownLeaked.records[0].title = known.records[0].title;
    expect(() => validateRealPaperFixtures(dev, knownLeaked, venues, {})).toThrow(
      /regression-known/,
    );

    const nearKnownLeaked = JSON.parse(JSON.stringify(heldout));
    nearKnownLeaked.records[0].title = known.records[0].title.replace("PRED:", "PREDX:");
    expect(() => validateRealPaperFixtures(dev, nearKnownLeaked, venues, {})).toThrow(
      /near-duplicate regression-known/,
    );

    const benchSource = readFileSync(join(REPO_ROOT, "src", "bench-recommender.ts"), "utf8");
    const runStart = benchSource.indexOf("export async function runRealPaperBenchmark");
    const runEnd = benchSource.indexOf("export function norm", runStart);
    const runSource = benchSource.slice(runStart, runEnd);
    expect(runSource).toContain("realPaperEmbeddingBundles");
    expect(runSource).not.toMatch(/\bemb\./);
  });

  it("computes required real-paper ranking metrics and stable strata", () => {
    const dev = JSON.parse(
      readFileSync(join(REPO_ROOT, "data", "benchmarks", "real-paper-dev.json"), "utf8"),
    );
    const heldout = JSON.parse(
      readFileSync(join(REPO_ROOT, "data", "benchmarks", "real-paper-heldout.json"), "utf8"),
    );
    const records = dev.records.slice(0, 2);
    const rankings = Object.fromEntries(
      records.map((record: { paper_id: string }, index: number) => [
        record.paper_id,
        { lexical: index === 0 ? 1 : null, semantic: 2, fused: index === 0 ? 1 : null },
      ]),
    );
    expect(realPaperMetrics(records, rankings).fused).toEqual(
      expect.objectContaining({
        queries: 2,
        mrr: 0.5,
        coverage: 0.5,
        "recall@1": 0.5,
        "recall@5": 0.5,
        "recall@10": 0.5,
        "ndcg@5": 0.5,
        "ndcg@10": 0.5,
      }),
    );
    const evaluation = {
      dev: {
        rankings,
        confidence: Object.fromEntries(
          records.map((record: { paper_id: string }) => [record.paper_id, "sufficient"]),
        ),
      },
      heldout: {
        rankings: Object.fromEntries(
          heldout.records.map((record: { paper_id: string }) => [
            record.paper_id,
            { lexical: 1, semantic: 1, fused: 1 },
          ]),
        ),
        confidence: Object.fromEntries(
          heldout.records.map((record: { paper_id: string }) => [record.paper_id, "insufficient"]),
        ),
      },
    };
    const devSubset = { ...dev, records };
    const first = buildRealPaperResult(devSubset, heldout, evaluation);
    const second = buildRealPaperResult(devSubset, heldout, evaluation);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.splits.dev.strata.language.en.fused.mrr).toBe(0.5);
    expect(first.splits.dev.strata.language.en.lexical.queries).toBe(2);
    expect(first.splits.dev.strata.domain.security.fused.queries).toBe(2);
    expect(first.splits.dev.strata.category.security.fused.queries).toBe(2);
    expect(first.splits.dev.strata.inputMode[records[0]!.input_mode].fused.queries).toBe(2);
    expect(first.splits.dev.modes.fused.confidence_interval).toMatchObject({
      method: "bootstrap",
      confidence_level: 0.95,
      seed: 0x5eed2026,
    });
    expect(first.splits.dev.mode_deltas.lexical_to_fused.mrr).toBe(0);
    expect(first.splits.heldout.abstention).toEqual(
      expect.objectContaining({
        total: heldout.records.length,
        abstained: heldout.records.length,
        coverage: 0,
      }),
    );
    expect(first.timing).toEqual({ firstLoadMs: null, repeatRecommendationMs: null });
  });

  it("emits coverage-specific regression floors and hard-fails floor misses", () => {
    const dev = JSON.parse(
      readFileSync(join(REPO_ROOT, "data", "benchmarks", "real-paper-dev.json"), "utf8"),
    );
    const heldout = JSON.parse(
      readFileSync(join(REPO_ROOT, "data", "benchmarks", "real-paper-heldout.json"), "utf8"),
    );
    const rankings = Object.fromEntries(
      [...dev.records, ...heldout.records].map((record: { paper_id: string }) => [
        record.paper_id,
        { lexical: 1, semantic: 1, fused: 1 },
      ]),
    );
    const confidence = Object.fromEntries(
      [...dev.records, ...heldout.records].map((record: { paper_id: string }) => [
        record.paper_id,
        "sufficient",
      ]),
    );
    const result = buildRealPaperResult(
      dev,
      heldout,
      { dev: { rankings, confidence }, heldout: { rankings, confidence } },
      undefined,
      undefined,
      "required",
    );
    result.splits.negative = {
      queries: 41,
      expected_abstention_rate: 1,
      non_abstain_rate: 0,
      non_abstain_precision: null,
    };
    for (const [split, queries] of [
      [result.splits.dev, 9],
      [result.splits.heldout, 10],
    ] as const) {
      split.queries = queries;
      for (const mode of Object.values(split.modes)) mode.queries = queries;
      split.abstention.total = queries;
      split.abstention.abstained = Math.min(split.abstention.abstained, queries);
      for (const dimension of Object.keys(split.strata) as Array<keyof typeof split.strata>)
        split.strata[dimension] = {};
    }
    expect(result.regression_floor).toEqual(REAL_PAPER_REGRESSION_FLOORS.required);
    expect(result.coverage).toBe("required");
    expect(REAL_PAPER_REGRESSION_FLOORS.required).not.toEqual(REAL_PAPER_REGRESSION_FLOORS.full);
    expect(realPaperRegressionReasons(result, "required")).toEqual([]);

    const heldoutMutation = structuredClone(result);
    const lowRecall = REAL_PAPER_REGRESSION_FLOORS.required.heldout["fusedRecall@5"] - 0.000001;
    heldoutMutation.splits.heldout.modes.fused.top1Accuracy = lowRecall;
    for (const metric of ["recall@1", "recall@5", "recall@10"] as const) {
      heldoutMutation.splits.heldout.modes.fused[metric] = lowRecall;
      heldoutMutation.splits.heldout.modes.fused.confidence_interval.metrics[metric] = {
        lower: lowRecall,
        upper: lowRecall,
      };
      heldoutMutation.splits.heldout.mode_deltas.lexical_to_fused[metric] = Number(
        (lowRecall - 1).toFixed(6),
      );
      heldoutMutation.splits.heldout.mode_deltas.semantic_to_fused[metric] = Number(
        (lowRecall - 1).toFixed(6),
      );
    }
    expect(realPaperRegressionReasons(heldoutMutation, "required")).toEqual(
      expect.arrayContaining([expect.stringMatching(/heldout fused Recall@5/)]),
    );

    const negativeMutation = structuredClone(result);
    negativeMutation.splits.negative!.expected_abstention_rate =
      REAL_PAPER_REGRESSION_FLOORS.required.negative.expected_abstention_rate - 0.000001;
    negativeMutation.splits.negative!.non_abstain_rate = 0.000001;
    negativeMutation.splits.negative!.non_abstain_precision = 0;
    expect(realPaperRegressionReasons(negativeMutation, "required")).toEqual(
      expect.arrayContaining([expect.stringMatching(/negative abstention/)]),
    );

    const malformedMutation = structuredClone(result);
    (malformedMutation.splits.dev.modes.fused as { "recall@5": unknown })["recall@5"] = "1";
    expect(realPaperRegressionReasons(malformedMutation as never, "required")).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/dev fused Recall@5 must be a finite number from 0 to 1/),
      ]),
    );

    const outOfRangeMutation = structuredClone(result);
    outOfRangeMutation.splits.dev.modes.fused["recall@5"] = 2;
    expect(realPaperRegressionReasons(outOfRangeMutation, "required")).toEqual(
      expect.arrayContaining([expect.stringMatching(/dev fused Recall@5.*from 0 to 1/)]),
    );

    const incompleteMutation = structuredClone(result) as any;
    delete incompleteMutation.models;
    delete incompleteMutation.timing;
    incompleteMutation.splits.dev.modes.lexical["recall@1"] = 2;
    expect(realPaperRegressionReasons(incompleteMutation, "required")).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/models must match/),
        expect.stringMatching(/timing must contain/),
        expect.stringMatching(/dev lexical recall@1.*from 0 to 1/),
      ]),
    );

    const strataMutation = structuredClone(result);
    strataMutation.splits.dev.strata.language.en = structuredClone(strataMutation.splits.dev.modes);
    const stratum = strataMutation.splits.dev.strata.language.en;
    stratum.fused.mrr = 0;
    expect(realPaperRegressionReasons(strataMutation, "required")).toEqual(
      expect.arrayContaining([expect.stringMatching(/strata language.*interval excludes/)]),
    );

    const strataModeMutation = structuredClone(result);
    strataModeMutation.splits.dev.strata.language.en = structuredClone(
      strataModeMutation.splits.dev.modes,
    );
    const mode = strataModeMutation.splits.dev.strata.language.en.fused;
    mode.top1Accuracy = 0;
    mode["recall@5"] = 0;
    mode["ndcg@5"] = 1;
    mode["ndcg@10"] = 0;
    expect(realPaperRegressionReasons(strataModeMutation, "required")).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/strata language.*top1 accuracy is inconsistent/),
        expect.stringMatching(/strata language.*recall must be monotonic/),
        expect.stringMatching(/strata language.*NDCG must be monotonic/),
      ]),
    );
  });

  it("parseBenchArgs parses flags and equal-joined options", () => {
    const args = parseBenchArgs([
      "--data=public/custom_data.json",
      "--emb=public/custom_emb.json",
      "--samples=20",
      "--failures=3",
      "--topk=10",
      "--lang=jp",
      "--jpw=0.4",
      "--by-len",
      "--adaptive",
      "--penalty",
      "--prf",
      "--no-idf",
      "--golden-en",
      "--no-paper-max",
      "--sw=name=30,venue=70",
    ]);
    expect(args.data).toBe("public/custom_data.json");
    expect(args.emb).toBe("public/custom_emb.json");
    expect(args.samples).toBe(20);
    expect(args.failures).toBe(3);
    expect(args.topK).toBe(10);
    expect(args.lang).toBe("jp");
    expect(args.jpw).toBe(0.4);
    expect(args.wGiven).toBe(true);
    expect(args.byLen).toBe(true);
    expect(args.adaptive).toBe(true);
    expect(args.penalty).toBe(true);
    expect(args.prf).toBe(true);
    expect(args.idf).toBe(false);
    expect(args.goldenEn).toBe(true);
    expect(args.paperMax).toBe(false);
    expect(args.realV2Small).toBe(false);
    expect(args.sw).toBe("name=30,venue=70");
  });

  it("parseBenchArgs parses short options", () => {
    const args = parseBenchArgs([
      "-d",
      "data.json",
      "-e",
      "emb.json",
      "-s",
      "50",
      "-f",
      "5",
      "-k",
      "3",
      "-l",
      "en",
      "--w",
      "0.6",
    ]);
    expect(args.data).toBe("data.json");
    expect(args.emb).toBe("emb.json");
    expect(args.samples).toBe(50);
    expect(args.failures).toBe(5);
    expect(args.topK).toBe(3);
    expect(args.lang).toBe("en");
    expect(args.jpw).toBe(0.6);

    const argsEq = parseBenchArgs([
      "-d=custom_data.json",
      "-e=custom_emb.json",
      "-s=100",
      "-f=10",
      "-k=10",
      "-l=jp",
    ]);
    expect(argsEq.data).toBe("custom_data.json");
    expect(argsEq.emb).toBe("custom_emb.json");
    expect(argsEq.samples).toBe(100);
    expect(argsEq.failures).toBe(10);
    expect(argsEq.topK).toBe(10);
    expect(argsEq.lang).toBe("jp");
  });

  it("--jpw 0 keeps zero as a valid sweep endpoint instead of coercing to 0.5", () => {
    const a = parseBenchArgs(["--jpw", "0"]);
    expect(a.jpw).toBe(0);
    expect(a.wGiven).toBe(true);

    const b = parseBenchArgs(["--w", "0"]);
    expect(b.jpw).toBe(0);
    expect(b.wGiven).toBe(true);

    // 非数値・欠落は従来どおり既定値 0.5 へフォールバックする。
    const c = parseBenchArgs(["--jpw", "abc"]);
    expect(c.jpw).toBe(0.5);
    const d = parseBenchArgs(["--jpw"]);
    expect(d.jpw).toBe(0.5);
  });

  it("norm and contentWords handle null, undefined, empty, and stopwords", () => {
    expect(norm(null)).toBe("");
    expect(norm(undefined)).toBe("");
    expect(norm("  High-Performance Computing!  ")).toBe("high performance computing");

    expect(contentWords(null)).toEqual([]);
    expect(contentWords(undefined)).toEqual([]);
    expect(contentWords("the of and for distributed")).toEqual(["distributed"]);
  });

  it("topicWords filters generic tags and aggregates categories and titles", () => {
    expect(topicWords(null, {})).toEqual([]);
    expect(topicWords(undefined, {})).toEqual([]);

    const conf = {
      key: "sc",
      title: "SC",
      full_name:
        "International Conference for High Performance Computing, Networking, Storage and Analysis",
      categories: ["hpc", "networking"],
      tags: ["hpc", "supercomputing", "niche", "workshop"],
    };
    const catFull = {
      hpc: "High Performance Computing",
      networking: "Networking",
    };
    const words = topicWords(conf, catFull);
    expect(words).toContain("supercomputing");
    expect(words).toContain("performance");
    expect(words).not.toContain("niche");
    expect(words).not.toContain("workshop");
  });

  it("wordInText safely handles special characters, null, and plurals", () => {
    expect(R.wordInText(null, "test")).toBe(false);
    expect(R.wordInText("test text", null)).toBe(false);
    expect(R.wordInText(undefined, undefined)).toBe(false);
    expect(R.wordInText("", "")).toBe(false);

    // Regular matching with plural s?
    expect(R.wordInText("system architecture", "system")).toBe(true);
    expect(R.wordInText("systems architecture", "system")).toBe(true);
    expect(R.wordInText("systems architecture", "systems")).toBe(true);

    // 複数形の会議名語（communications 等）は単数形クエリにも一致する（双方向の単複形吸収）
    expect(R.wordInText("wireless communication system", "communications")).toBe(true);
    expect(R.wordInText("distributed database design", "databases")).toBe(true);
    expect(R.wordInText("scalable architecture for edge computing", "architectures")).toBe(true);

    // Regex special characters do not throw or cause syntax errors
    expect(R.wordInText("os/2 operating system", "os/2")).toBe(true);
    expect(R.wordInText("c++ programming language", "c++")).toBe(false); // word boundary around non-word +
    expect(R.wordInText("network (tsn) protocol", "(tsn)")).toBe(false); // word boundary around non-word (
  });

  it("scorePapers and breakdown defensively handle null/undefined inputs", () => {
    expect(R.scorePapers(null, [{ title: "Test", keywords: "kw" }])).toBe(0);
    expect(R.scorePapers({ conf: { key: "test" } }, null)).toBe(0);
    expect(R.scorePapers(null, null)).toBe(0);

    const b = R.breakdown(null, [{ title: "Test", keywords: "kw" }]);
    expect(b.score).toBe(0);
    expect(b.venueHit).toBe(false);
    expect(b.perLine).toEqual([]);
    expect(b.agg).toEqual({ domain: 0, name: 0, paper: 0, jp: 0, tags: 0, venue: 0 });
  });

  it("autoDetectCats and breakdown do not inject 'undefined' into matching when properties are omitted (#304)", () => {
    // 1. autoDetectCats with missing keywords property
    const cats = R.autoDetectCats([{ title: "Deep Neural Network for Graph Theory" }]);
    expect(cats).toContain("ai");
    expect(cats).toContain("theory");

    // 2. breakdown does not match "Undefined" in conference name when paper has no keywords
    const rowWithUndefinedConf = {
      cats: [],
      conf: {
        key: "wub",
        title: "WUB",
        full_name: "International Workshop on Undefined Behavior",
        tags: [],
        papers: [],
      },
    };
    const b = R.breakdown(rowWithUndefinedConf, [{ title: "Completely Unrelated Title" }]);
    expect(b.score).toBe(0);
    expect(b.perLine[0].details.name).toBe(0);

    // 3. handles null and undefined elements in paper line safely
    const bNull = R.breakdown(rowWithUndefinedConf, [null as any, undefined as any]);
    expect(bNull.score).toBe(0);
  });
});

describe("parseBenchArgs 不正数値のフォールバック (#302 続編)", () => {
  it("イコール構文の負・非整数・非数値を既定値へ (topk/samples/failures)", () => {
    // --topk=-3 等が下流 `rank > args.topK` で全会議を失敗扱いにするのを防ぐ。
    expect(parseBenchArgs(["--topk=-3"]).topK).toBe(5);
    expect(parseBenchArgs(["-s=-1"]).samples).toBe(0);
    expect(parseBenchArgs(["--failures=-5"]).failures).toBe(0);
    expect(parseBenchArgs(["--topk=abc"]).topK).toBe(5);
    expect(parseBenchArgs(["--topk=1.5"]).topK).toBe(5);
    // 正整数・ゼロ既定の正当入力・既定値は従来どおり
    expect(parseBenchArgs(["--topk=10"]).topK).toBe(10);
    expect(parseBenchArgs([]).topK).toBe(5);
  });

  it("handles null, undefined, raw flag arrays, and boolean equals syntax (#338)", () => {
    expect(parseBenchArgs(null).topK).toBe(5);
    expect(parseBenchArgs(undefined).topK).toBe(5);

    // direct flag array without node / script prefix
    const direct1 = parseBenchArgs(["--samples", "10", "--failures", "3"]);
    expect(direct1.samples).toBe(10);
    expect(direct1.failures).toBe(3);

    // boolean equals syntax
    const boolArgs = parseBenchArgs([
      "--by-len=true",
      "--adaptive=false",
      "--penalty=1",
      "--prf=0",
      "--idf=false",
      "--golden-en=true",
      "--paper-max=false",
    ]);
    expect(boolArgs.byLen).toBe(true);
    expect(boolArgs.adaptive).toBe(false);
    expect(boolArgs.penalty).toBe(true);
    expect(boolArgs.prf).toBe(false);
    expect(boolArgs.idf).toBe(false);
    expect(boolArgs.goldenEn).toBe(true);
    expect(boolArgs.paperMax).toBe(false);
  });
});

describe("embeddingsMain 引数パース (#322)", () => {
  it("イコール構文 --force=true / -f=true を認識し非存在ファイルで 1 を返す", async () => {
    const code1 = await embeddingsMain([
      "--force=true",
      "/tmp/nonexistent-data-999.json",
      "/tmp/out-999.json",
    ]);
    expect(code1).toBe(1); // data not found (not usage error 2)

    const code2 = await embeddingsMain([
      "-f=true",
      "/tmp/nonexistent-data-999.json",
      "/tmp/out-999.json",
    ]);
    expect(code2).toBe(1); // data not found (not usage error 2)

    const code3 = await embeddingsMain(["--help"]);
    expect(code3).toBe(0);
  });

  it("scorePapers, breakdown, and matchVenueTag handle direct conf objects, bare rows, and nulls (#342)", () => {
    const directConf = {
      key: "sc",
      title: "SC",
      full_name: "Supercomputing",
      tags: ["hpc"],
      categories: ["hpc"],
    };

    // scorePapers directly on conference object
    const s1 = R.scorePapers(directConf, [{ title: "Parallel computing", venue: "SC" }]);
    expect(s1).toBeGreaterThan(0);

    // breakdown on direct conference object
    const b1 = R.breakdown(directConf, [{ title: "Parallel computing", venue: "SC" }]);
    expect(b1.score).toBeGreaterThan(0);
    expect(b1.venueHit).toBe(true);

    // scorePapers on bare row lacking conf
    const s2 = R.scorePapers({ cats: ["hpc"] }, [{ title: "Parallel computing", venue: "SC" }]);
    expect(s2).toBeGreaterThan(0);

    // matchVenueTag with null, direct conf, and wrapped row
    const matches = R.matchVenueTag("SC", [null, undefined, directConf, { conf: directConf }]);
    expect(matches).toHaveLength(2);
  });

  it("buildNameIdf and journalRows handle null items and string tags/papers safely (#360)", () => {
    const idfNull = R.buildNameIdf(null);
    expect(idfNull).toEqual({ name: {}, paper: {} });

    const idfMixed = R.buildNameIdf([
      null,
      undefined,
      {
        title: "Test Conf",
        full_name: "International Test Conference",
        papers: "Single Paper String Title",
      },
    ]);
    expect(idfMixed.name).toBeDefined();
    expect(idfMixed.paper).toBeDefined();

    const jRows = R.journalRows(
      [
        null,
        undefined,
        {
          title: "Test Journal",
          key: "test-journal",
          tags: "journal",
          categories: "systems",
          rank: { ccf: "A" },
        },
      ],
      1000,
    );
    expect(jRows).toHaveLength(1);
    expect(jRows[0].kind).toBe("journal");
    expect(jRows[0].tags).toEqual(["journal"]);
    expect(jRows[0].cats).toEqual(["systems"]);
    expect(jRows[0].rankPairs).toEqual(["ccf:A"]);
  });

  it("topicWords and benchMain handle non-array tags/categories, null catFull, and argv offset safely (#362)", async () => {
    const tw = topicWords(
      {
        key: "test",
        title: "Test Conference",
        full_name: "International Test Conference on Distributed Systems",
        tags: "storage" as any,
        categories: "storage" as any,
      },
      null,
    );
    expect(Array.isArray(tw)).toBe(true);
    expect(tw).toContain("storage");

    const helpCode = await benchMain(["--help"]);
    expect(helpCode).toBe(0);

    const nodeHelp = await benchMain(["node", "src/bench-recommender.ts", "-h"]);
    expect(nodeHelp).toBe(0);

    const nonExistCode = await benchMain(["--data", "/tmp/nonexistent-bench-999.json"]);
    expect(nonExistCode).toBe(1);
  });
});

describe("会期だけ確定している回（締切未定）の一覧", () => {
  const catalog = {
    conferences: [
      {
        key: "ipsj-al",
        title: "情報処理学会 AL 研究会",
        full_name: "情報処理学会 アルゴリズム研究会 (AL)",
        categories: ["theory"],
        tags: ["domestic-jp"],
        link: "https://ken.ieice.org/ken/program/?tgid=IPSJ-AL",
        editions: [
          {
            id: "ipsj-al-2026-11",
            date_text: "2026年11月12日-13日",
            event_start: "2026-11-12",
            event_end: "2026-11-13",
            place: "松江テルサ（島根県）",
            link: "https://ken.ieice.org/ken/program/?tgid=IPSJ-AL",
            deadlines: [],
          },
          {
            id: "ipsj-al-2026-09",
            event_start: "2026-09-04",
            event_end: "2026-09-05",
            place: "オンライン",
            deadlines: [{ kind: "abstract", precision: "date-only", local_date: "2026-08-01" }],
          },
        ],
      },
    ],
  };
  const editions = recommender.scheduleOnlyEditions(catalog);

  it("締切の無い回だけを返す", () => {
    expect(editions.map((e) => e.eventStart)).toEqual(["2026-11-12"]);
    expect(editions[0].name).toBe("情報処理学会 AL 研究会");
    expect(editions[0].cats).toEqual(["theory"]);
    expect(editions[0].tags).toContain("domestic-jp");
  });

  it("研究会名・開催地・県・月で引っかかる（表に出ない回を検索できる）", () => {
    for (const query of ["アルゴリズム", "松江", "しまね", "島根", "11月", "研究会"]) {
      const hit = editions.filter((e) => recommender.hayMatches(e.hay, query));
      expect(hit.length, `「${query}」で会期だけの回が見つからない`).toBe(1);
    }
  });
});

describe("表示している語で検索できる", () => {
  const catalog = {
    conferences: [
      {
        key: "demo-kyushu",
        title: "Demo Kyushu WS",
        categories: ["systems"],
        editions: [
          {
            place: "別府国際コンベンションセンター/ビーコンプラザ（大分県）／オンライン",
            event_start: "2026-11-05",
            event_end: "2026-11-06",
            deadlines: [{ kind: "paper", precision: "exact", utc: "2026-10-01T12:00:00Z" }],
          },
        ],
      },
      {
        key: "demo-reg",
        title: "Demo Reg WS",
        categories: ["networking"],
        editions: [
          {
            place: "京都",
            event_start: "2026-12-01",
            deadlines: [{ kind: "registration", precision: "exact", utc: "2026-11-01T12:00:00Z" }],
          },
        ],
      },
    ],
  };
  const rows = recommender.candidateRows(catalog);

  it("種別の日本語表記が一覧・md と同じ正典から来る", () => {
    const table = recommender.kindLabelTable();
    expect(table.paper).toBe("論文締切");
    expect(table.abstract).toBe("概要締切");
    expect(table.registration).toBe("登録締切");
    // 未知の種別はそのまま返す（発明しない）。
    expect(recommender.kindLabelJa("made_up_kind")).toBe("made_up_kind");
  });

  it("表示されている種別語でそのまま検索できる", () => {
    for (const [label, key] of [
      ["論文締切", "demo-kyushu"],
      ["登録締切", "demo-reg"],
    ] as const) {
      const hit = rows.filter((r) => recommender.hayMatches(r.hay, label));
      expect(
        hit.map((r) => r.conf.key),
        `「${label}」で見つからない`,
      ).toEqual([key]);
    }
    // 関係のない種別語で混ざらないこと。
    expect(rows.filter((r) => recommender.hayMatches(r.hay, "概要締切")).length).toBe(0);
  });

  it("地方名の漢字で会場の都道府県が引ける", () => {
    // 「九州」自体は会場文字列に書かれないので、漢字見出しでも都道府県へ展開する。
    expect(recommender.queryTokenGroups("九州")[0]).toContain("大分");
    const hit = rows.filter((r) => recommender.hayMatches(r.hay, "九州"));
    expect(hit.map((r) => r.conf.key)).toEqual(["demo-kyushu"]);
    // 市名と同じ扱い（漢字見出しを展開しない）になっていることは、市名側では効かないことで見える。
    expect(recommender.queryTokenGroups("別府")[0]).toEqual(["別府"]);
  });
});

describe("検索語の両端の句読点", () => {
  const hay = recommender.searchNormalize(
    "Tutorial Proposal Deadline 締切 demo 2026年12月 12月 別府（大分県）",
  );

  it("表をそのまま貼った語でも当たる", () => {
    // `upcoming.md` の種別列は「種別: ラベル」の形なので、そのまま貼ることがある。
    expect(recommender.hayMatches(hay, "締切: Tutorial Proposal Deadline")).toBe(true);
    expect(recommender.hayMatches(hay, "（大分県）")).toBe(true);
    expect(recommender.hayMatches(hay, "12月。")).toBe(true);
  });

  it("語の一部の記号は落とさない", () => {
    // `C++` を `C` に縮めると、1 文字で何でも当たってしまう。
    expect(recommender.queryTokens("C++")).toEqual(["c++"]);
    expect(recommender.hayMatches(recommender.searchNormalize("Conf on C Systems"), "C++")).toBe(
      false,
    );
  });
});

describe("長い和語を二語が並ぶ行にも当てる", () => {
  const catalog = {
    conferences: [
      {
        key: "demo-netsoc",
        title: "Symposium on Networking and Security",
        categories: ["networking", "security"],
        editions: [
          {
            place: "京都",
            event_start: "2026-12-01",
            deadlines: [{ kind: "paper", precision: "exact", utc: "2026-10-01T12:00:00Z" }],
          },
        ],
      },
      {
        key: "demo-os",
        title: "情報処理学会 OS 研究会",
        full_name: "システムソフトウェアとオペレーティング・システム研究会 (OS)",
        categories: ["systems"],
        editions: [
          {
            place: "福岡",
            event_start: "2026-12-08",
            deadlines: [{ kind: "paper", precision: "exact", utc: "2026-10-08T12:00:00Z" }],
          },
        ],
      },
      {
        key: "demo-words",
        // 「データ」と「ベース」は別々に含まれるが「データベース」は含まない行。
        title: "Data Base? Base Data Workshop on Data Base",
        categories: ["networking"],
        tags: ["niche"],
        editions: [
          {
            place: "Base",
            event_start: "2026-12-10",
            deadlines: [{ kind: "paper", precision: "exact", utc: "2026-10-10T12:00:00Z" }],
          },
        ],
      },
    ],
  };
  const rows = recommender.candidateRows(catalog);
  const hit = (query: string) => rows.filter((r) => recommender.hayMatches(r.hay, query));

  it("主題語が別々に書かれた行に当たる", () => {
    expect(hit("ネットワークセキュリティ").map((r) => r.conf.key)).toContain("demo-netsoc");
  });

  it("中黒で割れた表記にも当たる", () => {
    expect(hit("オペレーティングシステム").map((r) => r.conf.key)).toEqual(["demo-os"]);
  });

  it("短い語は分割しない", () => {
    // 「データベース」を 2 語の取り合わせで当てると、無関係な行まで拾ってしまう。
    expect(hit("データベース").map((r) => r.conf.key)).not.toContain("demo-words");
  });

  it("日本語以外の長い語は分割しない", () => {
    // 英語は語間が空いた表記が普通なので、分割しない（しないことを決めておく）。
    expect(recommender.hayMatches("Machine Learning Systems Base", "machinelearningsystems")).toBe(
      false,
    );
  });
});

describe("会場表記からオンライン参加かを見る", () => {
  it("日本語・英語の記述を見る", () => {
    for (const place of [
      "沖縄産業支援センター（沖縄県）／オンライン",
      "北海道大学 情報基盤センター南館2階（ハイブリッド）",
      "Alicante, Spain / Online",
      "Toronto, Canada & Virtual",
      "Canterbury, Great Britain(online)",
      "Online Only",
    ]) {
      expect(recommender.placeOffersOnline(place), `${place} が online でない`).toBe(true);
    }
  });

  it("記述の無い行を対面と判定しない（＝書かれた語だけを見る）", () => {
    for (const place of [
      "京都大学 楽友会館（京都府）",
      "未定",
      "",
      "名古屋大学 基盤センター２F演習室",
      "Vienna, Austria",
    ]) {
      expect(recommender.placeOffersOnline(place), `${place} が online になる`).toBe(false);
    }
  });

  it("会場名の一部として語が入っている例は除外する", () => {
    // 実データ: 会場名に Virtual を含む。オンライン開催ではない。
    expect(
      recommender.placeOffersOnline(
        "San Francisco Bay, USA and KSIR Virtual Conference Center, USA",
      ),
    ).toBe(false);
    // 同じ行にもう一つの会場がある表記は online のまま（語が実際に使われている）。
    expect(recommender.placeOffersOnline("Online / Co-located")).toBe(true);
  });
});

describe("表に出す「未確認」で検索できる", () => {
  // ランクは会議単位（`conf.rank`）なので、欠落行と充足行を同じ会議に作れない。
  const catalog = {
    conferences: [
      {
        key: "demo-gap",
        title: "Demo Gap WS",
        categories: ["systems"],
        editions: [
          {
            id: "demo-gap-2026",
            // 開催地も会期も無い回（表では両方「未確認」になる）。
            deadlines: [{ kind: "paper", precision: "exact", utc: "2026-10-01T12:00:00Z" }],
          },
        ],
      },
      {
        key: "demo-full",
        title: "Demo Full WS",
        categories: ["systems"],
        rank: { ccf: "B" },
        editions: [
          {
            id: "demo-full-2026",
            place: "Kyoto, Japan",
            event_start: "2026-11-05",
            deadlines: [{ kind: "paper", precision: "exact", utc: "2026-10-02T12:00:00Z" }],
          },
        ],
      },
    ],
  } as never;
  const rows = recommender.candidateRows(catalog);

  it("語は recommender が持つ（画面と検索で言い方が割れない）", () => {
    expect(recommender.unconfirmedLabelJa()).toBe("未確認");
  });

  it("空の項目だけ当てる", () => {
    const gap = rows.find((r) => r.conf.key === "demo-gap");
    const full = rows.find((r) => r.conf.key === "demo-full");
    expect(gap && full, "fixture が行を作っていない").toBeTruthy();
    expect(recommender.hayMatches(gap?.hay, "未確認")).toBe(true);
    expect(recommender.hayMatches(gap?.hay, "開催地未確認")).toBe(true);
    expect(recommender.hayMatches(gap?.hay, "会期未確認")).toBe(true);
    expect(recommender.hayMatches(gap?.hay, "ランク未確認")).toBe(true);
    // 値がある行を「未確認」でヒットさせない。
    expect(recommender.hayMatches(full?.hay, "未確認")).toBe(false);
    expect(recommender.hayMatches(full?.hay, "開催地未確認")).toBe(false);
    // 会期がある行に開催地の欠落だけを混ぜない（項目を絞れた意味を持たせる）。
    const placeOnly = recommender.candidateRows({
      conferences: [
        {
          key: "demo-place-gap",
          title: "Demo Place Gap WS",
          categories: ["systems"],
          rank: { ccf: "C" },
          editions: [
            {
              id: "demo-place-gap-2026",
              event_start: "2026-12-01",
              deadlines: [{ kind: "paper", precision: "exact", utc: "2026-10-03T12:00:00Z" }],
            },
          ],
        },
      ],
    } as never);
    const hay = placeOnly[0]?.hay;
    expect(recommender.hayMatches(hay, "開催地未確認")).toBe(true);
    expect(recommender.hayMatches(hay, "会期未確認")).toBe(false);
    expect(recommender.hayMatches(hay, "ランク未確認")).toBe(false);
  });
});

describe("ランクの表示語と検索語", () => {
  it("内部トークン `N` を読める語に直す", () => {
    expect(recommender.rankPairLabelJa("ccf:B")).toBe("CCF B");
    expect(recommender.rankPairLabelJa("core:A*")).toBe("CORE A*");
    expect(recommender.rankPairLabelJa("thcpl:N")).toBe("THCPL 評価なし");
    expect(recommender.rankPairLabelJa("ccf:N")).toBe("CCF 評価なし");
    // 空の grade も「評価が付いていない」と同じ扱い（SPEC §2 の `N` と揃える）。
    expect(recommender.rankPairLabelJa("ccf:")).toBe("CCF 評価なし");
    // 知らない一覧名は潰さず大文字で返す（収録一覧が増えても読める）。
    expect(recommender.rankPairLabelJa("schc:A")).toBe("SCHC A");
    expect(recommender.rankUnratedLabelJa()).toBe("評価なし");
  });

  it("表示する語がそのままで引ける", () => {
    const terms = recommender.rankSearchTerms(["ccf:B", "thcpl:N"]);
    expect(terms).toContain("ccf b");
    expect(terms).toContain("評価なし");
    expect(terms).toContain("thcpl評価なし");
    expect(recommender.rankSearchTerms(null)).toBe("");
  });

  it("1 文字の英字は語の境界で当てる", () => {
    // `N` をそのまま部分一致で明けるとほぼ全行に当たった（実測 3234 行中 3219 行）。
    expect(recommender.hayMatches(" conference ccf b core a* ", "b")).toBe(true);
    expect(recommender.hayMatches("ccf b", "B")).toBe(true);
    expect(recommender.hayMatches("abbey", "b")).toBe(false);
    expect(recommender.hayMatches("b05 hall", "b")).toBe(false);
    expect(recommender.hayMatches("usenix annual technical conference", "n")).toBe(false);
    // 日本語の会場表記に含まれる B（例: 122号館B）は語の境界として扱う。
    expect(recommender.hayMatches("電気通信大学 122号館b", "b")).toBe(true);
    // 2 文字以上は従来どおり部分一致（`nsdi` が `usenix nsdi` に当たる等）。
    expect(recommender.hayMatches("usenix nsdi 2027", "nsdi")).toBe(true);
  });
});

describe("開催地の日本語表記（表と upcoming.md が同じ語で読める）", () => {
  const ja = (p: string) => R.placeJa(p);

  it("国名を書かない表記でも、末尾の州・地域が日本語で読める", () => {
    // 末尾の `, USA` が無い行（"Boulder, Colorado"）が英語のまま残っていた。
    expect(ja("Boulder, Colorado")).toBe("Boulder, コロラド州");
    expect(ja("Portland, Oregon")).toBe("Portland, オレゴン州");
    expect(ja("Memorial Auditorium, Stanford, Palo Alto, CA")).toBe(
      "Memorial Auditorium, Stanford, Palo Alto, カリフォルニア州",
    );
    expect(ja("Lucca, Tuscany")).toBe("Lucca, トスカーナ州");
    expect(ja("Taipei, Taiwan")).toBe("Taipei, 台湾");
    expect(ja("Tallinn, Estonia")).toBe("Tallinn, エストニア");
    expect(ja("Kigali, Rwanda")).toBe("Kigali, ルワンダ");
    expect(ja("New York City, US")).toBe("New York City, アメリカ");
    expect(ja("Denver, U.S.A.")).toBe("Denver, アメリカ");
    // 都市だけを書く行も、読み手を置いていかない。
    expect(ja("Paris")).toBe("パリ");
    expect(ja("Montreal")).toBe("モントリオール");
    expect(ja("Donostia / San Sebastian, Spain")).toBe("ドノスティア / San Sebastian, スペイン");
  });

  it("上流の誤記も同じ国・都市に寄せる（原文の訂正は overrides 側）", () => {
    expect(ja("London, United Kindom")).toBe("London, イギリス");
    expect(ja("Chania, Greec")).toBe("Chania, ギリシャ");
    expect(ja("Amsterdam, Netherland.")).toBe("Amsterdam, オランダ.");
    // 正しい綴りが壊れていないこと（置換が語として当たっている）。
    expect(ja("Amsterdam, Netherlands")).toBe("Amsterdam, オランダ");
    expect(ja("Seattle, United States")).toBe("Seattle, アメリカ");
  });

  it("歧う語と会場名は置換しない（推測で土地を書かない）", () => {
    /* 二字の国コードは州コードと歧うので原則そのまま残す。ただし米国の州コードに
     * 無い語は歧う余地がないので寄せる（`BE` = ベルギー。収録で末尾の句に単独で
     * 現れる国コードはこれだけで、変更前は表示が英語のまま「ベルギー」でも
     * 引けなかった。2026-09-23 実測: 2 行）。州コードになりうるものは触らない。 */
    expect(ja("Antwerp, BE")).toBe("Antwerp, ベルギー");
    expect(ja("Philadelphia, PA")).toBe("Philadelphia, PA");
    expect(ja("Seattle, WA")).toBe("Seattle, WA");
    // 会場名の中に国名が含まれる行は、置換が会場名を壊す。
    expect(ja("Radisson Grenada Beach Resort Grenada")).toBe(
      "Radisson Grenada Beach Resort Grenada",
    );
    // 語の途中に当たさない（"USC" を「アメリカC」にしない）。
    expect(ja("Los Angeles, USC")).toBe("Los Angeles, USC");
  });
});

describe("開催地の引き方（日本語の都市名・ローマ字のアクセント）", () => {
  const NOW = Date.parse("2026-08-09T00:00:00Z");
  const rows = [
    {
      conf: { key: "xiv", title: "XIV", editions: [] },
      ed: { place: "Seattle, USA", deadlines: [], date_text: "" },
      dl: { kind: "paper", label: "" },
      kind: "paper",
      t: NOW + 86_400_000,
      tLast: NOW + 86_400_000,
      hay: "xiv seattle usa seattle, america seattle, アメリカ",
    },
    {
      conf: { key: "www", title: "WWW", editions: [] },
      ed: { place: "Montréal, Canada", deadlines: [], date_text: "" },
      dl: { kind: "paper", label: "" },
      kind: "paper",
      t: NOW + 86_400_000,
      tLast: NOW + 86_400_000,
      hay: "www montreal canada montréal, canada",
    },
    {
      conf: { key: "ipa", title: "IPA", editions: [] },
      ed: { place: "Kraków, Poland", deadlines: [], date_text: "" },
      dl: { kind: "paper", label: "" },
      kind: "paper",
      t: NOW + 86_400_000,
      tLast: NOW + 86_400_000,
      hay: "ipa krakow poland kraków, poland",
    },
  ];
  const hits = (q: string) => {
    const m = R.searchMatcher(q, NOW);
    return rows.filter((r) => m(r.hay)).map((r) => String(r.conf.key));
  };

  it("日本語で打った都市名が、英文字の開催地に届く", () => {
    expect(hits("シアトル")).toEqual(["xiv"]);
    expect(hits("seattle")).toEqual(["xiv"]);
    // どちらも同じ行に出会う（片方だけ広くも狭くもならない）。
    expect(hits("シアトル").length).toBe(hits("seattle").length);
  });

  it("ローマ字のアクセント記号を落とす（画面に見える地名を ASCII で引ける）", () => {
    expect(hits("montreal")).toEqual(["www"]);
    expect(hits("Montréal")).toEqual(["www"]);
    expect(hits("krakow")).toEqual(["ipa"]);
    // 折いた語は `krakw` のように壊れない（ł も同じ字に寄せる）。
    expect(hits("krakw")).toEqual([]);
  });

  it("国の別表記を同じ場所として扱う", () => {
    expect(hits("米国")).toEqual(["xiv"]);
    expect(hits("usa")).toEqual(["xiv"]);
    expect(hits("アメリカ")).toEqual(["xiv"]);
  });

  it("正規化は日本語の濁点・半濁点を壊さない（件数欄に打った語をそのまま出す）", () => {
    // `searchNormalize` に NFD を日本語へ掛ける実装にすると、`パ` が `ハ` + 半濁点に
    // 分解され、見た目がおなじなのに違う文字列になる。寄せ説明は打たれた語を出す。
    expect(R.querySynonymNotes("スパコン")).toEqual([
      "「スパコン」は分野「高性能計算」で探しています",
    ]);
    expect(R.querySynonymNotes("スパコン")[0]).toContain("パ");
  });
});

describe("分野の言い方（スパコンなどで引ける）", () => {
  const hit = (q: string, hay: string) => R.searchMatcher(q)(hay);

  it("口にする語が、表に出る分野名に寄せる", () => {
    // 「スパコン」で 0 件になり、分野チップの「高性能計算」に辿り着けない状態を防ぐ。
    expect(hit("スパコン", "SC26 高性能計算 hpc")).toBe(true);
    expect(hit("スーパーコンピューター", "高性能計算")).toBe(true);
    expect(hit("並列処理", "高性能計算")).toBe(true);
    expect(hit("可視化", "グラフィックス")).toBe(true);
    expect(hit("ヒューマンインタフェース", "人間情報処理")).toBe(true);
    expect(hit("深層学習", "主題: ディープラーニング")).toBe(true);
    // 寄せた先も引ける（表示語 = 検索語の不変条件）。
    expect(hit("高性能計算", "SC26 高性能計算")).toBe(true);
  });

  it("寄せたことを件数欄のことばで伝える", () => {
    expect(R.querySynonymNotes("スパコン")).toEqual([
      "「スパコン」は分野「高性能計算」で探しています",
    ]);
    // 同じ語が二度出ない。
    expect(R.querySynonymNotes("スパコン スパコン")).toHaveLength(1);
    // 展開していない語は説明を出さない（理由のない説明は誤読のもと）。
    expect(R.querySynonymNotes("nsdi")).toEqual([]);
    expect(R.querySynonymNotes("")).toEqual([]);
  });

  it("精密に引ける語は寄せない（行の壁にしない）", () => {
    // `機械学習` は主題として当たる。分野全体に寄せると 2 桁多く出て精密さを失う。
    expect(R.querySynonymNotes("機械学習")).toEqual([]);
    expect(R.querySynonymNotes("スパコン 国内")).toEqual([
      "「スパコン」は分野「高性能計算」で探しています",
    ]);
  });
});

describe("締切種別の言い方と、表に出さない種別の案内", () => {
  it("抄録・要旨が「概要締切」に当たる", () => {
    // 学会側は「抄録締切」と書くが、表は「概要締切」を出す。
    expect(R.searchMatcher("抄録")("SC26 概要締切 abstract")).toBe(true);
    expect(R.searchMatcher("要旨")("概要締切")).toBe(true);
    expect(R.searchMatcher("アブストラクト")("概要締切")).toBe(true);
    expect(R.searchMatcher("全文")("論文締切 paper")).toBe(true);
    expect(R.searchMatcher("本論文")("論文締切")).toBe(true);
    expect(R.querySynonymNotes("抄録")).toEqual(["「抄録」は種別「概要締切」で探しています"]);
    // 誤った寄せ方をしていないこと（抄録を論文に寄せない）。
    expect(R.searchMatcher("抄録")("論文締切")).toBe(false);
  });

  it("表に出さない種別に当たった検索語を、案内が名前で言える", () => {
    const table = R.kindLabelTable();
    const hidden = ["notification", "camera_ready", "review_release", "registration"].map((kind) =>
      String(table[kind] || ""),
    );
    expect(R.queryHiddenKindMatches("採否", hidden)).toEqual(["採否通知"]);
    expect(R.queryHiddenKindMatches("通知", hidden)).toEqual(["採否通知"]);
    // 部分一致が及ばない言い方は別名で受ける。
    expect(R.queryHiddenKindMatches("合否", hidden)).toEqual(["採否通知"]);
    expect(R.queryHiddenKindMatches("camera ready", hidden)).toEqual(["カメラレディ締切"]);
    expect(R.queryHiddenKindMatches("査読", hidden)).toEqual(["査読結果公開"]);
    // 表に出す種別や、無関係な語で誤爆させない。
    expect(R.queryHiddenKindMatches("cs", hidden)).toEqual([]);
    expect(R.queryHiddenKindMatches("", hidden)).toEqual([]);
    expect(R.queryHiddenKindMatches("論文", hidden)).toEqual([]);
  });
});

describe("略称と年の合わせ打ち（`nsdi27`）・英字 1〜2 文字の語", () => {
  it("略称に年を貼り付けた入力が当たる（`ICDE2027`・`nsdi27`）", () => {
    // 表では `NSDI 2027` と別々の語に割れて書かれる。打たれるのは `nsdi27`。
    expect(R.searchMatcher("nsdi27")("nsdi 2027 twentieth symposium")).toBe(true);
    expect(R.searchMatcher("nsdi2027")("nsdi 2027 twentieth symposium")).toBe(true);
    expect(R.searchMatcher("icde2027")("icde 2027 ieee")).toBe(true);
    // 年が違う行を合わせない（`nsdi27` が 2026 年版を出さない）。
    expect(R.searchMatcher("nsdi27")("nsdi 2026 symposium")).toBe(false);
    // 語が割れていない表記（`SC26`）は今までどおり当たる（割った条件で落とさない）。
    expect(R.searchMatcher("sc26")("sc26 the international conference")).toBe(true);
    // 略称 1 文字の取り合わせでは割らない（何でも当たるため）。
    expect(R.searchMatcher("a3")("alpha 3 workshop")).toBe(false);
    // 説明を出す（理由の見えない行の壁にしない）。
    expect(R.querySynonymNotes("nsdi27")).toEqual([
      "「nsdi27」は「nsdi」と「2027」に分けて探しています",
    ]);
    expect(R.querySynonymNotes("nsdi")).toEqual([]);
  });

  it("英字 1〜2 文字は語の境界でしか当たらない（`sc` が science を拾わない）", () => {
    expect(R.searchMatcher("sc")("sc 26 supercomputing")).toBe(true);
    expect(R.searchMatcher("sc")("science and technology")).toBe(false);
    expect(R.searchMatcher("sc")("ai4scisci 2026 workshop")).toBe(false);
    // 句読点は境界（`ACM/SC`・`SC '26` は当たる）。
    expect(R.searchMatcher("sc")("acm/sc conference")).toBe(true);
    // 1 文字の既存の振る舞いは変えない（ランクの A・B・C・N）。
    expect(R.searchMatcher("n")("rank n unrated")).toBe(true);
    expect(R.searchMatcher("n")("journal of networks")).toBe(false);
    // 3 文字以上は従来どおり部分一致でよい（表の表記揺れ `ICDE27` の直書きを
    // 取りこぼさないため、略長を切りすぎない）。
    expect(R.searchMatcher("icde")("icde27 industrial conference")).toBe(true);
  });
});

describe("相対日・相対週（明日・今週・来週）", () => {
  // 検証時計は 2026-08-09（JST では日曜）。月曜始まりで 今週 = 8/3〜8/9、来週 = 8/10〜8/16。
  const NOW = Date.parse("2026-08-09T00:00:00Z");

  it("週は月曜始まりの 7 暦日になる", () => {
    expect(R.weekDayTermsJa("来週", NOW)).toEqual([
      "2026年8月10日",
      "2026年8月11日",
      "2026年8月12日",
      "2026年8月13日",
      "2026年8月14日",
      "2026年8月15日",
      "2026年8月16日",
    ]);
    // 日曜に「今週」を打った日は、その週の日曜までを含む。
    const thisWeek = R.weekDayTermsJa("今週", NOW);
    expect(thisWeek[0]).toBe("2026年8月3日");
    expect(thisWeek[6]).toBe("2026年8月9日");
    // 年をまたぐ週（2026-12-31 は木曜 → 月曜は 12/28、日曜は翌年 1/3）。
    const yearEnd = R.weekDayTermsJa("今週", Date.parse("2026-12-31T00:00:00Z"));
    expect(yearEnd[0]).toBe("2026年12月28日");
    expect(yearEnd[6]).toBe("2027年1月3日");
    // 週の語でないと分かったものは空。
    expect(R.weekDayTermsJa("来月", NOW)).toEqual([]);
  });

  it("暦日の語が hay に入り、その日で引ける", () => {
    // 瞬間は JST の暦日で読む（UTC 8/9 15:30 = JST 8/10）。
    expect(R.dayTermsJa(Date.parse("2026-08-09T15:30:00Z"))).toBe("2026年8月10日 8月10日");
    // `YYYY-MM-DD` は閲覧者のタイムゾーンに依存せず暦日として読む。
    expect(R.dayTermsJa("2026-08-10")).toBe("2026年8月10日 8月10日");
    // 暦月繰り越しは語を作らない（`monthTermsJa` と同じ検査）。
    expect(R.dayTermsJa("2026-02-30")).toBe("");
    expect(R.dayTermsJa("")).toBe("");
    const match = R.searchMatcher("8月10日");
    expect(match("nsdi 2026年8月10日 8月10日 论文")).toBe(true);
    expect(match("nsdi 2026年8月11日 8月11日")).toBe(false);
  });

  it("相対日・相対週は表の暦日に当たる（`明日` `来週` が 0 件でなくなる）", () => {
    const tomorrow = R.searchMatcher("明日", NOW);
    expect(tomorrow("sc 2026年8月10日 8月10日 論文締切")).toBe(true);
    expect(tomorrow("sc 2026年8月11日 8月11日 論文締切")).toBe(false);
    const nextWeek = R.searchMatcher("来週", NOW);
    expect(nextWeek("sc 2026年8月10日 8月10日")).toBe(true);
    expect(nextWeek("sc 2026年8月16日 8月16日")).toBe(true);
    // 週の外（前週の日曜・翌週の月曜）を出さない。
    expect(nextWeek("sc 2026年8月9日 8月9日")).toBe(false);
    expect(nextWeek("sc 2026年8月17日 8月17日")).toBe(false);
    // 他の語とは AND で交わる（「来週 国内」）。
    const both = R.searchMatcher("来週 国内", NOW);
    expect(both("国内 2026年8月11日 8月11日 研究会")).toBe(true);
    expect(both("2026年8月11日 8月11日 研究会")).toBe(false);
    // 相対月（既存）は壊さない。
    expect(R.expandRelativeMonths("来月", NOW)).toBe("2026年9月");
  });

  it("解決結果を件数欄でおしらせする（黙って条件を変えない）", () => {
    expect(R.relativeDayNotes("明日", NOW)).toEqual(["明日 = 2026年8月10日(月)"]);
    expect(R.relativeDayNotes("来週", NOW)).toEqual(["来週 = 2026年8月10日(月)〜8月16日(日)"]);
    // 今週は年をまたぐと両側に年を書く。
    expect(R.relativeDayNotes("今週", Date.parse("2026-12-31T00:00:00Z"))).toEqual([
      "今週 = 2026年12月28日(月)〜2027年1月3日(日)",
    ]);
    // 相対日でなければ何も言わない。
    expect(R.relativeDayNotes("nsdi", NOW)).toEqual([]);
  });
});

describe("開催地の地域まとめ（ヨーロッパ・アジアなどで引ける）", () => {
  const NOW = Date.parse("2026-08-09T00:00:00Z");
  // hay は実データと同じ形にする: 公式表記（英文字）+ 画面に出る日本語の国名（`placeJa`）。
  const mk = (key: string, place: string, extra: string) => ({
    conf: { key, title: key.toUpperCase(), editions: [] },
    ed: { place, deadlines: [], date_text: "" },
    dl: { kind: "paper", label: "" },
    kind: "paper",
    t: NOW + 86_400_000,
    tLast: NOW + 86_400_000,
    hay: `${key} ${extra}`,
  });
  const rows = [
    mk("euro1", "Milan, Italy", "euro1 milan italy milan, イタリア"),
    mk("euro2", "London, UK", "euro2 london uk london, イギリス"),
    mk("asia", "Seoul, South Korea", "asia seoul south korea ソウル, 韓国"),
    mk("jp", "京都大学 楽友会館（京都府）", "jp きょうとどうだいがく 京都 国内研究会"),
    mk("canada", "Toronto, Canada", "canada toronto canada トロント, カナダ"),
    mk("usstate", "San Diego, CA", "usstate san diego ca san diego, カリフォルニア州"),
    mk("oceania", "Sydney, Australia", "oceania sydney australia シドニー, オーストラリア"),
    mk(
      "africa",
      "Cape Town, South Africa",
      "africa cape town south africa ケープタウン, 南アフリカ",
    ),
    mk("mideast", "Istanbul, Turkey", "mideast istanbul turkey イスタンブール, トルコ"),
    mk("latam", "Santiago, Chile", "latam santiago chile サンティアゴ, チリ"),
  ];
  const hits = (q: string) => {
    const m = R.searchMatcher(q, NOW);
    return rows.filter((r) => m(r.hay)).map((r) => String(r.conf.key));
  };

  it("地域のことばで、その地域の行に届く", () => {
    expect(hits("ヨーロッパ").sort()).toEqual(["euro1", "euro2"]);
    // 表記ゆれ（欧州・ヨーロッパ圏）は同じ結果にする。
    expect(hits("欧州").sort()).toEqual(hits("ヨーロッパ").sort());
    expect(hits("ヨーロッパ圏").sort()).toEqual(hits("ヨーロッパ").sort());
    expect(hits("アジア")).toEqual(["asia"]);
    expect(hits("北米").sort()).toEqual(["canada", "usstate"]);
    expect(hits("オセアニア")).toEqual(["oceania"]);
    expect(hits("アフリカ")).toEqual(["africa"]);
    expect(hits("中東")).toEqual(["mideast"]);
    expect(hits("中南米")).toEqual(["latam"]);
    // 欧米は欧州＋北米（オーストラリアは入らない）。
    expect(hits("欧米").sort()).toEqual(["canada", "euro1", "euro2", "usstate"]);
  });

  it("「アジア」に国内研究会を混ぜない", () => {
    // 日本人の利用で「アジア」に国内の研究会が混ざると誤解になる。国内は `国内`・`日本` で引く。
    expect(hits("アジア")).not.toContain("jp");
    // 国内は `国内` で引ける（こちらは tags ではなく開催地・主催の表記に現れる）。
    expect(hits("国内")).toEqual(["jp"]);
  });

  it("国名で引いた人の当たり方を地域で広くしない", () => {
    // 展開は一方向だけ。`イタリア` → 欧州全体 に広がると精密さが失われる。
    expect(hits("イタリア")).toEqual(["euro1"]);
    expect(R.queryTokenGroups("イタリア", NOW)).toEqual([["イタリア"]]);
    expect(hits("カナダ")).toEqual(["canada"]);
  });

  it("州表記だけの開催地も「アメリカ」「米国」で出る", () => {
    // 上流は国名を書かず州だけ書くことがある（`San Diego, CA`）。
    expect(hits("アメリカ")).toEqual(["usstate"]);
    expect(hits("米国")).toEqual(["usstate"]);
  });

  it("地域まとめを広げたことは件数欄に書き、国名では書かない", () => {
    const notes = R.querySynonymNotes("ヨーロッパ");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("地域まとめ");
    expect(notes[0]).toContain("イタリア");
    expect(notes[0]).toContain("か所");
    expect(R.querySynonymNotes("イタリア")).toEqual([]);
    expect(R.querySynonymNotes("欧州")[0]).toContain("地域まとめ");
  });
});

describe("英字の語は語境界で当てる（語の途中での誤爆を防ぐ）", () => {
  const NOW = Date.parse("2026-08-09T00:00:00Z");
  const hit = (query: string, hay: string) => R.searchMatcher(query, NOW)(hay);

  it("開催地の語は、語として書かれた行だけに当たる", () => {
    // `usa` を語の途中に含むつづりで引けてしまっていた（2026-09-23 実測で `米国` に
    // 収録 18 行の誤り: ドイツ 1 行・パナマ 3 行・`usage` を含む IEICE 特集号 など）。
    expect(hit("米国", "evomusart 2027 mainz, german")).toBe(false);
    expect(hit("米国", "special section on log data usage techniques")).toBe(false);
    expect(hit("米国", "lascas ieee latin american symposium panama city, panama")).toBe(false);
    // 語として書かれていれば当たる（略称・正式表記・画面の日本語表記）。
    expect(hit("米国", "sigcomm 2027 alexandria, va, usa")).toBe(true);
    // 画面には `Detroite, アメリカ` のように日本語の国名が出る（`placeJa`）ので、その形でも当たる。
    expect(hit("米国", "icde detroit, united states デトロイト, アメリカ")).toBe(true);
    expect(hit("米国", "ieee sdr conferência chicago, アメリカ")).toBe(true);
    // 州表記だけの開催地も同じ場所として拾う（上流は国名を書かないことがある）。
    expect(hit("米国", "asplos san diego, カリフォルニア州")).toBe(true);
    expect(hit("アメリカ", "hotchips san diego, カリフォルニア州")).toBe(true);
  });

  it("主題の語は語頭が繋がっていなければ当たり、語頭が繋がっていなければ外れる", () => {
    // 語頭だけを見るので、語幹→派生語（複数形や -graphy）は今までどおり当たる。
    expect(hit("暗号", "applied cryptography and network security acns athens, ギリシャ")).toBe(
      true,
    );
    expect(hit("暗号", "crypto 2028 santa clara, usa")).toBe(true);
    expect(hit("ロボット", "ieee international conference on robotics and automation icra")).toBe(
      true,
    );
    // 語の途中の一致は使わない（`division` を `vision` と同じ場所にしない。
    // 2026-09-23 の時点で収録 258 行に当たっていた誤り）。
    expect(hit("視覚", "ieee conference on computer division and supervision")).toBe(false);
    expect(hit("視覚", "ieee conference on machine vision")).toBe(true);
    // `視覚` 自体は会議名の語として英語で書かれている行に届く（2026-09-23 実測: 収録 3→248 行）。
    expect(hit("視覚", "ieee conference on computer vision and pattern recognition cvpr")).toBe(
      true,
    );
  });

  it("1〜2 文字の語は前後とも境界が必要（従来どおり）", () => {
    expect(hit("sc", "special interest group on computer science and engineering sigsc")).toBe(
      false,
    );
    expect(hit("sc", "supercomputing sc 26 st. louis, usa")).toBe(true);
  });
});

describe("日付を数字で打つ（12/25・2026-12-25・2026-12）", () => {
  const NOW = Date.parse("2026-08-09T00:00:00Z");
  // hay は実データと同じ形。暦日は日本語形が年あり・年なしの両方で入っている。
  const rows = [
    {
      conf: { key: "sc26", title: "SC", editions: [] },
      hay: "sc supercomputing 2026年8月 8月 2026年8月22日 8月22日",
    },
    {
      conf: { key: "sc25", title: "SC", editions: [] },
      hay: "sc supercomputing 2025年8月 8月 2025年8月22日 8月22日",
    },
    {
      conf: { key: "icde", title: "ICDE", editions: [] },
      hay: "icde 2026年12月 12月 2026年12月25日 12月25日",
    },
  ];
  const hits = (q: string) => {
    const m = R.searchMatcher(q, NOW);
    return rows.filter((r) => m(r.hay)).map((r) => String(r.conf.key));
  };

  it("月日の入力は暦日の日本語形と同じ行に届く", () => {
    expect(hits("8/22")).toEqual(["sc26", "sc25"]);
    expect(hits("8月22日")).toEqual(["sc26", "sc25"]);
    expect(hits("8-22")).toEqual(hits("8月22日"));
    expect(hits("8.22")).toEqual(hits("8月22日"));
    expect(hits("12/25")).toEqual(["icde"]);
    expect(hits("12月25日")).toEqual(["icde"]);
  });

  it("年を打った人はその年限定（別年の同じ暦日を混ぜない）", () => {
    expect(hits("2026-8-22")).toEqual(["sc26"]);
    expect(hits("2026年8月22日")).toEqual(["sc26"]);
    expect(hits("2026/08/22")).toEqual(["sc26"]);
    expect(hits("2026-12")).toEqual(["icde"]);
    expect(hits("2026年12月")).toEqual(["icde"]);
  });

  it("暦日としてありえない数字は日付として扱わない", () => {
    // 会議名や号数の数字の取り合わせを別物に解釈しない（そのままの部分一致に残す）。
    expect(R.queryTokenGroups("13/45", NOW)).toEqual([["13/45"]]);
    expect(R.queryTokenGroups("2026-13", NOW)).toEqual([["2026-13"]]);
    expect(R.queryTokenGroups("0/12", NOW)).toEqual([["0/12"]]);
    expect(hits("13/45")).toEqual([]);
  });

  it("入力そのものも組に残る（hay に数字表記で書かれる行を落とさない）", () => {
    const glued = [
      { conf: { key: "x", title: "X", editions: [] }, hay: "workshop 2026-03-04 submission" },
    ];
    const m = R.searchMatcher("2026-03-04", NOW);
    expect(glued.filter((r) => m(r.hay)).map((r) => r.conf.key)).toEqual(["x"]);
  });
});

describe("地方で引く（関東・関西で、開催市だけ書かれた国内行も出る）", () => {
  const NOW = Date.parse("2026-08-09T00:00:00Z");
  // 国内の国際会議は上流どおりの英字表記で `Tokyo, 日本` のように国名だけ日本語になる。
  // 研究会の行は「（埼玉）」のように都道府県が書かれる。両方に地方名で届くこと。
  const rows = [
    {
      conf: { key: "ieee-tokyo", title: "IEEE", editions: [] },
      hay: "ieee conference tokyo, 日本 東京",
    },
    {
      conf: { key: "ieice-saitama", title: "研究会", editions: [] },
      hay: "ieice 研究会 さいたま市（埼玉）",
    },
    { conf: { key: "ieee-kyoto", title: "IEEE", editions: [] }, hay: "ieee workshop kyoto, 日本" },
    {
      conf: { key: "ieee-fukuoka", title: "IEEE", editions: [] },
      hay: "ieee symposium fukuoka, 日本",
    },
    {
      conf: { key: "ieee-kanazawa", title: "IEEE", editions: [] },
      hay: "ieee siggraph asia kanazawa, 日本",
    },
    {
      conf: { key: "ieee-osaka", title: "IEEE", editions: [] },
      hay: "ieee conference osaka, 日本",
    },
  ];
  const hits = (q: string) => {
    const m = R.searchMatcher(q, NOW);
    return rows.filter((r) => m(r.hay)).map((r) => String(r.conf.key));
  };

  it("開催市だけの行も地方名で当たる", () => {
    expect(hits("関東").sort()).toEqual(["ieee-tokyo", "ieice-saitama"]);
    expect(hits("関西").sort()).toEqual(["ieee-kyoto", "ieee-osaka"]);
    expect(hits("九州")).toEqual(["ieee-fukuoka"]);
  });

  it("収録にある都市は、日本語の表記で引ける", () => {
    expect(hits("金沢")).toEqual(["ieee-kanazawa"]);
    expect(hits("かなざわ")).toEqual([]);
  });

  it("展開は一方向だけ（都市名を打った人の当たり方を地方全体に広げない）", () => {
    const group = R.queryTokenGroups("東京", NOW)[0].map(String);
    expect(group.some((term: string) => /神奈川|埼玉|千葉/.test(term))).toBe(false);
    expect(hits("東京")).toEqual(["ieee-tokyo"]);
  });

  it("広げた先を件数欄のおしらせに出す", () => {
    expect(R.querySynonymNotes("関東")).toEqual([
      "「関東」は地方の都道府県と開催市（茨城・栃木 など 12 か所の表記）で探しています",
    ]);
    // 精密に引ける語には付けない。
    expect(R.querySynonymNotes("東京")).toEqual([]);
  });
});

describe("参加形式の語（オンライン参加可・ハイブリッド）で引ける", () => {
  const NOW = Date.parse("2026-08-09T00:00:00Z");
  // `オンライン参加可` は行が持つ参加形式の語（チェックボックスと同じ判定で hay に入る）。
  // ここでは実データと同じ形に手で置いて、照合の側だけを見る
  // （語が本当に入っているかは `tests/build_golden.test.ts` の収録カタログ検査で見る）。
  const rows = [
    {
      conf: { key: "online-ws", title: "WS", editions: [] },
      hay: "workshop オンライン参加可 osaka, 日本 ／オンライン",
    },
    {
      conf: { key: "hybrid-conf", title: "CONF", editions: [] },
      hay: "conference オンライン参加可 kyoto, 日本 ／オンライン／対面",
    },
    {
      conf: { key: "onsite-only", title: "SYM", editions: [] },
      hay: "symposium kyoto, 日本 京都大学 百周年記念会館",
    },
  ];
  const hits = (q: string) => {
    const m = R.searchMatcher(q, NOW);
    return rows.filter((r) => m(r.hay)).map((r) => String(r.conf.key));
  };

  it("チェックボックスの語は検索の語にもなっている", () => {
    expect(hits("オンライン参加可").sort()).toEqual(["hybrid-conf", "online-ws"]);
    // 部分一致で言いかけでも当たる。
    expect(hits("オンライン参加").sort()).toEqual(["hybrid-conf", "online-ws"]);
    expect(hits("参加可").sort()).toEqual(["hybrid-conf", "online-ws"]);
    // 対面だけの行は出ない（`京都` は `kyoto` に寄せる表があるので語のかけ算で使う）。
    expect(hits("オンライン参加可 百周年")).toEqual([]);
    expect(hits("京都")).toEqual(["hybrid-conf", "onsite-only"]);
  });

  it("「ハイブリッド」はオンライン参加の記載に寄せる（0 件で止まらない）", () => {
    // `ハイブリッド` のまま当たる行は収録カタログでいずれも過去で、既定の一覧では 0 件だった。
    expect(hits("ハイブリッド").sort()).toEqual(["hybrid-conf", "online-ws"]);
    expect(R.querySynonymNotes("ハイブリッド")).toEqual([
      "「ハイブリッド」は参加形式「オンライン参加可」で探しています",
    ]);
    // 語のかけ算は壊れない。
    expect(hits("ハイブリッド 対面")).toEqual(["hybrid-conf"]);
  });
});

describe("チェックボックスと選択肢の語を、複合語のまま引ける", () => {
  const NOW = Date.parse("2026-08-09T00:00:00Z");
  // `国内研究会` はチェックボックスの語。行の名前には「研究会」としか書かれず、「国内」は
  // タグ側の情報なので、複合語は行の検索用文字列に入れる（実データと同じ形に置いて、
  // ここは照合の側だけを見る。語が本当に入っているかは
  // `tests/build_golden.test.ts` の収録カタログ検査で確認する）。
  const rows = [
    {
      conf: {
        key: "ieice-nolta",
        title: "情報処理学会 NL研究協会",
        editions: [],
        tags: ["domestic-jp"],
      },
      hay: "情報処理学会 nl研究協会 国内 domestic 研究会 国内研究会",
    },
    {
      conf: {
        key: "ieice-sig-symp",
        title: "研究会・シンポジウム",
        editions: [],
        tags: ["domestic-jp"],
      },
      hay: "研究会・シンポジウム 国内 domestic 国内研究会 国内シンポジウム",
    },
    {
      conf: { key: "atswoim", title: "ATSWOIM", editions: [], tags: ["domestic-jp"] },
      hay: "atswoim 国内 domestic okinawa, 日本",
    },
    {
      conf: { key: "sc", title: "SC", editions: [], tags: [] },
      hay: "sc international conference for high performance computing networking storage and analysis",
    },
  ];
  const hits = (q: string) => {
    const m = R.searchMatcher(q, NOW);
    return rows.filter((r) => m(r.hay)).map((r) => String(r.conf.key));
  };

  it("「国内研究会」で、国内の研究会行だけが出る", () => {
    expect(hits("国内研究会").sort()).toEqual(["ieice-nolta", "ieice-sig-symp"]);
    // 国内だが研究会ではない行、研究会でも国内ではない行は出ない。
    expect(hits("国内研究会").includes("atswoim")).toBe(false);
    expect(hits("国内研究会").includes("sc")).toBe(false);
  });

  it("名前に応じた語だけが入る（シンポジウムとワークショップは別々の語）", () => {
    expect(hits("国内シンポジウム")).toEqual(["ieice-sig-symp"]);
    expect(hits("国内ワークショップ")).toEqual([]);
  });

  it("締切種別は「〜締切」を付けた言い方で同じ行に届く", () => {
    const groups = R.queryTokenGroups("アブストラクト締切", NOW);
    expect(groups.length).toBe(1);
    expect(groups[0].map(String)).toContain("概要締切");
    expect(R.querySynonymNotes("アブストラクト締切")).toEqual([
      "「アブストラクト締切」は種別「概要締切」で探しています",
    ]);
    expect(R.queryTokenGroups("全文締切", NOW)[0].map(String)).toContain("論文締切");
    expect(R.queryTokenGroups("抄録締切", NOW)[0].map(String)).toContain("概要締切");
    expect(R.queryTokenGroups("要旨締切", NOW)[0].map(String)).toContain("概要締切");
  });

  it("「随時受付」と打っても表の語「常時受付」で行を引く", () => {
    const journal = [
      { conf: { key: "j", title: "Journal", editions: [] }, hay: "journal 常時受付" },
    ];
    const m = R.searchMatcher("随時受付", NOW);
    expect(journal.filter((r) => m(r.hay)).map((r) => r.conf.key)).toEqual(["j"]);
    expect(R.querySynonymNotes("随時受付")).toEqual([
      "「随時受付」は種別「常時受付」で探しています",
    ]);
  });
});

describe("海外の開催都市をカタカナで打つ", () => {
  const NOW = Date.parse("2026-08-09T00:00:00Z");
  // 行の検索用文字列には開催地の公式表記が入る（翻訳して変えない）。だからカタカナ入力は
  // 表記表で英文字のつづりに寄せて届ける。ここは照合の側だけを見、表が実データに
  // 追いついているかは `tests/build_golden.test.ts` の収録カタログ検査で見る。
  const rows = [
    {
      conf: { key: "pam", title: "PAM", editions: [] },
      hay: "pam passive and active measurement lille, france",
    },
    {
      conf: { key: "prdc", title: "PRDC", editions: [] },
      hay: "prdc parallel and distributed computing busan, 韓国",
    },
    {
      conf: { key: "icalt", title: "ICALT", editions: [] },
      hay: "icalt heraklion, crete, greece",
    },
    { conf: { key: "bali-conf", title: "ICMB", editions: [] }, hay: "icmb bali, インドネシア" },
    {
      conf: { key: "sigir-anno", title: "SIGIR ANN", editions: [] },
      hay: "sigir ann baritbari bari, イタリア",
    },
  ];
  const hits = (q: string) => {
    const m = R.searchMatcher(q, NOW);
    return rows.filter((r) => m(r.hay)).map((r) => String(r.conf.key));
  };

  it("カタカナの都市名が、公式表記のつづりで書かれた行に届く", () => {
    expect(hits("リール")).toEqual(["pam"]);
    expect(hits("プサン")).toEqual(["prdc"]);
    expect(hits("ブサン")).toEqual(["prdc"]);
    expect(hits("クレタ")).toEqual(["icalt"]);
    expect(hits("クレタ島")).toEqual(["icalt"]);
  });

  it("日本語で同じ書き方になる別都市は、両方に寄せる（国が併記で分かる）", () => {
    // Bali（インドネシア）と Bari（イタリア）は、どちらも「バリ」と書く人が多い。
    expect(hits("バリ").sort()).toEqual(["bali-conf", "sigir-anno"]);
  });

  it("寄せない語は行を増やさない（都市語を打っていない行は出ない）", () => {
    // 都市語と別の語を同時に打てば AND になる（都市語だけを足して増えることはない）。
    expect(hits("リール measurement")).toEqual(["pam"]);
    expect(hits("リール 並列")).toEqual([]);
  });
});

describe("早め絞り込みのボタンは、自分の条件だけを出し入れする", () => {
  const EMPTY = { win: "all", rank: "", cats: [], domestic: false, online: false };
  const json = (v: unknown) => JSON.stringify(v);

  it("押した条件が入り、他の条件はそのまま残る", () => {
    const typed = { ...EMPTY, win: "30d", rank: "A" };
    const next = R.presetNextSelection("domestic", typed);
    expect(next.domestic).toBe(true);
    expect(next.win).toBe("30d");
    expect(next.rank).toBe("A");
    // 検索語・締切種別・推定・過去表示はここで扱わない（型に無い＝消しようがない）。
    expect(Object.keys(next).sort()).toEqual(["cats", "domestic", "online", "rank", "win"]);
  });

  it("もう一度押すと外れる（押した意味を取り消せる）", () => {
    for (const preset of ["7d", "a_star", "hpc_sys", "domestic", "online"]) {
      const once = R.presetNextSelection(preset, EMPTY);
      expect(json(once), preset).not.toBe(json(EMPTY));
      expect(json(R.presetNextSelection(preset, once)), preset).toBe(json(EMPTY));
    }
  });

  it("別のボタンを重ねられる（前の条件が消えない）", () => {
    const both = R.presetNextSelection("online", R.presetNextSelection("domestic", EMPTY));
    expect(both.domestic).toBe(true);
    expect(both.online).toBe(true);
    // 片方だけ外すこともできる。
    const onlyDomestic = R.presetNextSelection("online", both);
    expect(onlyDomestic).toEqual({ ...EMPTY, domestic: true });
  });

  it("分野のボタンは、その分野が入っている間だけ点く", () => {
    const hpc = R.presetNextSelection("hpc_sys", EMPTY);
    expect(hpc.cats).toEqual(["hpc", "systems"]);
    expect(R.presetIsActive("hpc_sys", hpc)).toBe(true);
    // 並び順を変えて持ってきても点灯は崩れない。
    expect(R.presetIsActive("hpc_sys", { ...hpc, cats: ["systems", "hpc"] })).toBe(true);
    expect(R.presetIsActive("hpc_sys", { ...hpc, cats: ["hpc"] })).toBe(false);
    expect(R.presetIsActive("hpc_sys", { ...hpc, cats: ["security"] })).toBe(false);
  });

  it("他の条件を足した画面でも、押しているボタンは点いたまま", () => {
    // 変更前は他の条件が空のときだけ点いていたので、検索語を打つと押したことが
    // 画面から読めなかった。
    const busy = { win: "7d", rank: "A*", cats: ["hpc", "systems"], domestic: true, online: true };
    for (const preset of ["7d", "a_star", "hpc_sys", "domestic", "online"]) {
      expect(R.presetIsActive(preset, busy), preset).toBe(true);
    }
    expect(R.presetIsActive("online", { ...busy, online: false })).toBe(false);
  });

  it("未知のボタン名は状態を壊さず、点きもしない", () => {
    const busy = { ...EMPTY, domestic: true };
    expect(json(R.presetNextSelection("nope", busy))).toBe(json(busy));
    expect(R.presetIsActive("nope", busy)).toBe(false);
    expect(json(R.presetNextSelection(null, null))).toBe(json(EMPTY));
  });
});

describe("かなで打った地名が、漢字で打ったときと同じ行に届く", () => {
  const NOW = Date.parse("2026-08-09T00:00:00Z");
  // 漢字見出しは英文字表記の寄せ（`東京` ↔ `tokyo`）を持つが、かな見出し（`とうきょう`）は
  // 漢字見出しへ寄せるだけで、その寄せを受け継いでいなかった。開催地の公式表記は
  // 英文字なので、漢字で引ける行数とかなで引ける行数がズレていた（2026-09-23 実測:
  // 東京 28 件 / `とうきょう` 1 件）。実データの検証は `tests/build_golden.test.ts`。
  const rows = [
    {
      conf: { key: "nsdi", title: "NSDI", editions: [] },
      hay: "nsdi networked systems design implementation tokyo, 日本",
    },
    {
      conf: { key: "ieice", title: "IEICE", editions: [] },
      hay: "ieice 情報処理学会 研究会 東京, 日本",
    },
    {
      conf: { key: "sigcomm", title: "SIGCOMM", editions: [] },
      hay: "sigcomm copenhagen, denmark",
    },
  ];
  const hits = (q: string) => {
    const m = R.searchMatcher(q, NOW);
    return rows
      .filter((r) => m(r.hay))
      .map((r) => String(r.conf.key))
      .sort();
  };

  it("ひらがなの都市名が、英文字表記だけの行にも当たる", () => {
    expect(hits("とうきょう")).toEqual(hits("東京"));
    expect(hits("とうきょう").includes("nsdi")).toBe(true);
  });

  it("展開は漢字見出しが持つ寄せを1ホップ受け取る", () => {
    const group = R.queryTokenGroups("とうきょう", NOW);
    expect(group.length).toBe(1);
    const members = group[0].map(String);
    expect(members).toContain("東京");
    expect(members).toContain("tokyo");
  });

  it("寄せた先が違う語へ漏れない（無関係の行は出ない）", () => {
    expect(hits("とうきょう")).toEqual(["ieice", "nsdi"]);
    expect(hits("とうきょう 通信")).toEqual([]);
  });
});

describe("地域の語で引く（南米・中米・北米）", () => {
  const NOW = Date.parse("2026-08-09T00:00:00Z");
  const members = (q: string) => {
    const groups = R.queryTokenGroups(q, NOW);
    return groups.length === 1 ? groups[0].map(String) : [];
  };

  it("「南米」は南米の国名を探し、他の大陸の国名を含まない", () => {
    const group = members("南米");
    expect(group.length).toBeGreaterThan(1);
    for (const country of ["ブラジル", "アルゼンチン", "チリ", "コロンビア"]) {
      expect(group, country).toContain(country);
    }
    expect(group).not.toContain("フランス");
    expect(group).not.toContain("日本");
  });

  it("「中米」は中米の国名を探す", () => {
    const group = members("中米");
    for (const country of ["メキシコ", "コスタリカ", "パナマ"]) {
      expect(group, country).toContain(country);
    }
    expect(group).not.toContain("ブラジル");
  });

  it("「中南米」は南米と中米の両方を含む", () => {
    const broad = members("中南米");
    // グループには打った語自身も入るので、寄せ先の国名だけ比べてください。
    const countries = [...members("南米"), ...members("中米")].filter(
      (word) => word !== "南米" && word !== "中米",
    );
    expect(countries.length).toBeGreaterThan(4);
    for (const word of countries) {
      expect(broad, word).toContain(word);
    }
  });

  it("メキシコは北米として「北米」に入る（「アメリカ」と打った人には出さない）", () => {
    expect(members("北米")).toContain("メキシコ");
    expect(members("アメリカ")).not.toContain("メキシコ");
  });

  it("一方向のまま（国名を打っても地域の語には展開しない）", () => {
    // 展開語を行側に足していないので、`ブラジル` と打った人に他の国の行は混ざらない。
    const rows = [
      { conf: { key: "br", title: "SBIA", editions: [] }, hay: "sbia brazil ブラジル" },
      { conf: { key: "cl", title: "CLAPIoT", editions: [] }, hay: "clapion chile チリ" },
    ];
    const m = R.searchMatcher("ブラジル", NOW);
    expect(rows.filter((r) => m(r.hay)).map((r) => r.conf.key)).toEqual(["br"]);
  });
});

describe("地域語の広げすぎを防ぐ（中国・首都圏・東海）", () => {
  const NOW = Date.parse("2026-08-09T00:00:00Z");
  const members = (q: string) => {
    const groups = R.queryTokenGroups(q, NOW);
    return groups.length === 1 ? groups[0].map(String) : [];
  };

  it("「中国」は国名に加えて中国地方の都道府県も探す", () => {
    const group = members("中国");
    for (const pref of ["鳥取", "島根", "岡山", "広島", "山口"]) {
      expect(group, pref).toContain(pref);
    }
  });

  it("「中国地方」は地方だけを出す（国名を足さない）", () => {
    const group = members("中国地方");
    expect(group).toContain("広島");
    // 国名側への展開はしない（`中国` 自身を語として持たせない）。
    expect(group).not.toContain("ヨーロッパ");
  });

  it("広げた先を件数欄に書く（国名と地方の両方だと分かる言い方）", () => {
    const notes = R.querySynonymNotes("中国");
    expect(notes.length).toBe(1);
    expect(notes[0]).toContain("国名と中国地方の両方");
  });

  it("構成員が 1 つの地方語では「など 1 か所」と書かない", () => {
    const notes = R.querySynonymNotes("首都圏");
    expect(notes.length).toBe(1);
    expect(notes[0]).not.toContain("など 1 か所");
    expect(notes[0]).toContain("東京");
  });

  it("日常語の地方名も引ける（首都圏・東海）", () => {
    expect(members("首都圏")).toContain("東京");
    expect(members("東海")).toContain("愛知");
    expect(members("東海地方")).toContain("岐阜");
  });

  it("大陸の語から日本の都道府県へは広がらない（アジアに国内の行が混ざらない）", () => {
    // `中国` が地方見出しになったので、hop をそのまま連鎖させると
    // `アジア` → `中国` → 広島の行、となって「アジアに国内研究会は入らない」が壊れる。
    const asia = members("アジア");
    for (const pref of ["広島", "岡山", "鳥取", "島根", "山口"]) {
      expect(asia, pref).not.toContain(pref);
    }
    expect(asia).toContain("中国");
  });
});

describe("ランク順は体系名ではなく等級で並ぶ", () => {
  const key = (pairs: string[]) => R.rankSortKey(pairs);
  const byKey = (rows: string[][]) =>
    rows
      .slice()
      .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
      .map((r) => r.join("+"));

  it("等級の高い順（降順）に並べると A* が先頭に来る", () => {
    const rows = [["ccf:N"], ["ccf:C"], ["core:A"], ["ccf:B"], ["core:A*"], []];
    expect(byKey(rows).reverse()).toEqual(["core:A*", "core:A", "ccf:B", "ccf:C", "ccf:N", ""]);
  });

  it("体系名が違うと同じ等級でも並びが崩れない（ccf:C が core:A* より前に来ない）", () => {
    expect(key(["core:A*"]) > key(["ccf:C"])).toBe(true);
    expect(key(["core:A"]) > key(["ccf:B"])).toBe(true);
    expect(key(["ccf:A"]) > key(["core:B"])).toBe(true);
    expect(key(["ccf:A"]) === key(["core:A"])).toBe(true);
  });

  it("評価の無い行は最も低い扱い（昇順で先頭、降順で末尾）", () => {
    expect(key([]) < key(["ccf:N"])).toBe(true);
    expect(key(null as unknown as string[]) < key(["ccf:N"])).toBe(true);
    expect(key(undefined as unknown as string[]) < key(["core:C"])).toBe(true);
  });

  it("複数の評価を持つ行は、最良の等級→次の等級の順で比べる", () => {
    const best = [["ccf:C"], ["ccf:C"]];
    best[1] = ["ccf:C", "core:A*"];
    expect(key(best[1]) > key(best[0])).toBe(true);
    // 2 つ目の等級も同じ並び規則で、同じ等級の塊の中でも読める順にする。
    expect(key(["ccf:B", "core:A"]) > key(["ccf:B", "core:C"])).toBe(true);
  });

  it("未知の等級は評価あり側として、N の下・評価なしの上に置く", () => {
    expect(key(["core:S"]) < key(["ccf:N"])).toBe(true);
    expect(key(["core:S"]) > key([])).toBe(true);
  });

  it("等級の順は選択欄と並び順で同じ正本を使う", () => {
    expect(R.rankGradeOrderJa()).toEqual(["A*", "A", "B", "C", "N"]);
    // 正本から写した配列を書き換えても、次に取り出したときの値は変わらない。
    const taken = R.rankGradeOrderJa();
    taken.push("S");
    expect(R.rankGradeOrderJa()).toEqual(["A*", "A", "B", "C", "N"]);
  });
});

describe("開催地の翻訳が複合地名を壊さない", () => {
  it("New Mexico はアメリカの州で、メキシコに寄せない（表示と検索の両方）", () => {
    // `mexico` の置換で「New メキシコ」になり、「メキシコ」で引いた人に
    // アメリカの会議を渡していた（2026-09-23 実測: `New Mexico` 2 行）。
    expect(R.placeJa("Las Cruces, New Mexico")).toBe("Las Cruces, New Mexico");
    expect(R.placeJa("Santa Fe, New Mexico, USA")).toBe("Santa Fe, New Mexico, アメリカ");
    const rows = [
      { conf: { key: "nm", title: "PPoPP", editions: [] }, hay: "ppopp las cruces new mexico" },
      { conf: { key: "mx", title: "CLeaR", editions: [] }, hay: "clear méxico mérida" },
    ];
    const mexico = R.searchMatcher("メキシコ", Date.parse("2026-08-09T00:00:00Z"));
    const hayOf = (r: { hay: string }) => `${r.hay} ${R.placeJa(r.hay.toUpperCase())}`;
    expect(rows.filter((r) => mexico(hayOf(r))).map((r) => r.conf.key)).toEqual(["mx"]);
    expect(R.placeJa("New Mexico")).toBe("New Mexico");
  });

  it("別表記で書かれた国も日本語に寄せる（México・Curaçao・BE）", () => {
    expect(R.placeJa("Mérida, México")).toBe("Mérida, メキシコ");
    expect(R.placeJa("Willemstad, Curaçao")).toBe("Willemstad, キュラソー");
    expect(R.placeJa("Antwerp, BE")).toBe("Antwerp, ベルギー");
  });

  it("国コードは末尾の句に単独で出るときだけ寄せる（会場名を壊さない）", () => {
    // 末尾句の語として現れない "BE" は置換しない（都市名・会場名の途中に食いちぎらない）。
    expect(R.placeJa("Bet Block Metro, Belfast")).toBe("Bet Block Metro, Belfast");
    expect(R.placeJa("Beppu, Japan")).toBe("Beppu, 日本");
  });

  it("都市名を国名に化けさせる旧来的な誤りは起きない", () => {
    expect(R.placeJa("Panama City, Panama")).toBe("Panama City, パナマ");
    expect(R.placeJa("New York, USA")).toBe("New York, アメリカ");
    expect(R.placeJa("Kansas City, Missouri, USA")).toBe("Kansas City, Missouri, アメリカ");
  });

  it("守った地名はカタカナでも引ける", () => {
    const groups = R.queryTokenGroups("ニューメキシコ").map((g: string[]) => g.map(String));
    expect(groups[0]).toContain("new mexico");
  });
});
