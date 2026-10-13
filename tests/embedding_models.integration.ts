import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env, type FeatureExtractionPipeline, pipeline } from "@huggingface/transformers";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  buildEmbeddings,
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  EMBEDDING_MULTI_MODEL,
  EMBEDDING_MULTI_REVISION,
  EMBEDDING_REVISION,
} from "../src/embeddings.ts";

// Neutral names and new keys prevent conference-name matches or stored paper profiles.
const englishConferences = [
  {
    key: "fixture-networking",
    title: "Forum A",
    scope: "Computer networks, internet routing, packet transport and reliable communication.",
  },
  {
    key: "fixture-security",
    title: "Forum B",
    scope: "Cryptographic protocols, encryption, privacy and authenticated communication.",
  },
  {
    key: "fixture-databases",
    title: "Forum C",
    scope:
      "Database query processing, relational data management, transaction concurrency and durable storage.",
  },
  {
    key: "fixture-learning",
    title: "Forum D",
    scope: "Neural networks, supervised learning, image recognition and computer vision.",
  },
];

const japaneseConferences = [
  {
    key: "fixture-networking-ja",
    title: "会議 A",
    scope: "計算機ネットワーク、インターネットの経路制御、パケット転送と信頼性の高い通信。",
  },
  {
    key: "fixture-security-ja",
    title: "会議 B",
    scope: "暗号プロトコル、暗号化、プライバシー保護と通信相手の認証。",
  },
  {
    key: "fixture-databases-ja",
    title: "会議 C",
    scope: "データベースの問い合わせ処理、関係データ管理、トランザクションの並行制御と永続化。",
  },
  {
    key: "fixture-learning-ja",
    title: "会議 D",
    scope: "ニューラルネットワーク、教師あり学習、画像認識とコンピュータビジョン。",
  },
];
const conferences = [...englishConferences, ...japaneseConferences];

const cases = [
  {
    key: "fixture-networking",
    en: "Keeping internet paths available when routers fail",
    ja: "ルータが故障しても通信経路を維持する方法",
  },
  {
    key: "fixture-security",
    en: "Keeping private messages unreadable to an eavesdropper",
    ja: "盗聴されてもメッセージの内容を読まれないようにする方法",
  },
  {
    key: "fixture-databases",
    en: "Transactions that stay correct when many clients update shared records",
    ja: "複数の利用者が同時にレコードを更新しても整合性を保つ方法",
  },
  {
    key: "fixture-learning",
    en: "Learning to recognize objects in photographs from labeled examples",
    ja: "正解付きの画像を学習して写真の中の物体を識別する方法",
  },
];

type Bundle = {
  dim: number;
  model: string;
  embeddings: Record<string, number[]>;
  multi: { dim: number; model: string; embeddings: Record<string, number[]> };
  manifest: { models: { en: { revision: string }; multi: { revision: string } } };
};

const work = mkdtempSync(join(tmpdir(), "kamiyobi-real-models-"));
const previousCache = env.cacheDir;
let bundle: Bundle;
let queries: Record<"en" | "ja", number[][]>;
let directProfiles: Record<"en" | "ja", number[][]>;

function cosine(a: number[], b: number[]): number {
  expect(a).toHaveLength(EMBEDDING_DIM);
  expect(b).toHaveLength(EMBEDDING_DIM);
  return a.reduce((sum, v, i) => sum + v * b[i], 0) / (Math.hypot(...a) * Math.hypot(...b));
}

beforeAll(async () => {
  // Only downloaded model weights are cached; all input data and vectors are newly generated.
  env.cacheDir = join(import.meta.dirname, "..", ".cache", "embedding-models");
  const input = join(work, "input.json");
  const output = join(work, "embeddings.json");
  writeFileSync(input, JSON.stringify({ conferences, categories: {} }));
  await buildEmbeddings(input, output);
  bundle = JSON.parse(readFileSync(output, "utf8")) as Bundle;
  queries = { en: [], ja: [] };
  directProfiles = { en: [], ja: [] };
  for (const [language, model, revision] of [
    ["en", EMBEDDING_MODEL, EMBEDDING_REVISION],
    ["ja", EMBEDDING_MULTI_MODEL, EMBEDDING_MULTI_REVISION],
  ] as const) {
    const extractor = (await pipeline("feature-extraction", model, {
      revision,
      device: "cpu",
      dtype: "fp32",
    })) as FeatureExtractionPipeline;
    try {
      const tensor = await extractor(
        [
          ...cases.map((item) => item[language]),
          // Independent fixture oracle: these profiles have only a title and scope.
          ...conferences.map((conf) => `${conf.title} ${conf.scope}`),
        ],
        {
          pooling: "mean",
          normalize: true,
        },
      );
      expect(tensor.dims).toEqual([cases.length + conferences.length, EMBEDDING_DIM]);
      const vectors = tensor.tolist() as number[][];
      queries[language] = vectors.slice(0, cases.length);
      directProfiles[language] = vectors.slice(cases.length);
    } finally {
      await extractor.dispose();
    }
  }
});

afterAll(() => {
  env.cacheDir = previousCache;
  rmSync(work, { recursive: true, force: true });
});

it("generates finite, distinct unit vectors with the pinned real models", () => {
  expect(bundle.model).toBe(EMBEDDING_MODEL);
  expect(bundle.multi.model).toBe(EMBEDDING_MULTI_MODEL);
  expect(bundle.dim).toBe(EMBEDDING_DIM);
  expect(bundle.multi.dim).toBe(EMBEDDING_DIM);
  expect(bundle.manifest.models.en.revision).toBe(EMBEDDING_REVISION);
  expect(bundle.manifest.models.multi.revision).toBe(EMBEDDING_MULTI_REVISION);
  const keys = conferences.map((conf) => conf.key).sort();
  for (const language of ["en", "ja"] as const) {
    const vectors = language === "en" ? bundle.embeddings : bundle.multi.embeddings;
    expect(Object.keys(vectors).sort()).toEqual(keys);
    for (const key of keys) {
      expect(vectors[key]).toHaveLength(EMBEDDING_DIM);
      expect(vectors[key].every(Number.isFinite)).toBe(true);
      expect(Math.hypot(...vectors[key])).toBeCloseTo(1, 4);
    }
    for (const [index, conf] of conferences.entries()) {
      expect(
        cosine(vectors[conf.key], directProfiles[language][index]),
        `${language}: ${conf.key}`,
      ).toBeGreaterThan(0.99999);
    }
    const catalogs =
      language === "en" ? [englishConferences] : [englishConferences, japaneseConferences];
    for (const catalog of catalogs) {
      const catalogKeys = catalog.map((conf) => conf.key);
      for (const [i, a] of catalogKeys.entries()) {
        for (const b of catalogKeys.slice(i + 1))
          expect(cosine(vectors[a], vectors[b])).toBeLessThan(0.95);
      }
    }
  }
});

for (const { language, label, catalog } of [
  { language: "en", label: "en", catalog: englishConferences },
  { language: "ja", label: "ja-cross", catalog: englishConferences },
  { language: "ja", label: "ja", catalog: japaneseConferences },
] as const) {
  for (const [index, item] of cases.entries()) {
    const expectedKey = label === "ja" ? `${item.key}-ja` : item.key;
    it(`${label}: ranks ${expectedKey} above unrelated fields for a paraphrased query`, () => {
      const vectors = language === "en" ? bundle.embeddings : bundle.multi.embeddings;
      const scores = catalog
        .map(({ key }) => ({ key, score: cosine(queries[language][index], vectors[key]) }))
        .sort((a, b) => b.score - a.score);
      console.info(JSON.stringify({ language, catalog: label, query: item[language], scores }));
      expect(scores[0].key, JSON.stringify(scores)).toBe(expectedKey);
      expect(scores[0].score - scores[1].score, JSON.stringify(scores)).toBeGreaterThan(0.05);
    });
  }
}
