import { PAPER_VEC_KEYS } from "./embedding-runtime.ts";

export const SKIP_EMB_KEYS = new Set([...PAPER_VEC_KEYS, "ecrts"]);

/** 日本語会議（情報処理学会・電子情報通信学会の研究会・特集号等）のプロファイルに
 * 付与する日本語の分野キーワード。多言語モデル用のみ（英語モデルには使わない）。
 * 実測比較: これらを付与すると国内研究会のセマンティック検索が
 * top1 8.3%→25.0%・top5 16.7%→50.0% に改善（クエリの日本語語彙が会議に届く）。 */
export const JP_CAT_KW: Record<string, string> = {
  systems:
    "カーネル スケジューリング 仮想化 オペレーティングシステム ミドルウェア ストレージ リアルタイム 組み込み メモリ",
  networking: "ネットワーク 通信 ルーティング 無線 プロトコル トラフィック",
  hpc: "ハイパフォーマンス スーパーコンピュータ 並列 GPU MPI",
  ai: "機械学習 深層学習 ニューラル 生成 推論",
  security: "セキュリティ プライバシー 暗号 認証",
  db: "データベース データマイニング 検索",
  graphics: "グラフィックス 可視化 映像 画像 レンダリング",
  hci: "ヒューマン ユーザインタフェース ユーザビリティ インタラクション",
  theory: "アルゴリズム 計算量 複雑性 グラフ",
};

export const ATTRIBUTE_TAGS = new Set([
  "niche",
  "workshop",
  "domestic-jp",
  "journal",
  "special-issue",
  "niche-jp",
]);

function hasJapanese(text: string): boolean {
  return /[\u3040-\u9fff]/.test(text);
}

import { toStringArray } from "./util.ts";

function extractScopeText(c: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof c.scope === "string" && c.scope.trim()) {
    parts.push(c.scope.trim());
  } else if (Array.isArray(c.scope)) {
    parts.push(...toStringArray(c.scope));
  }
  if (typeof c.official_scope === "string" && c.official_scope.trim()) {
    parts.push(c.official_scope.trim());
  } else if (Array.isArray(c.official_scope)) {
    parts.push(...toStringArray(c.official_scope));
  }
  return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

/** 会議プロファイル文（カテゴリは正式名で展開）。
 * 多言語モデル用（forMulti）は、日本語名の会議にカテゴリの日本語キーワードを付与して
 * 日本語クエリから検索可能にする。英語モデルは日本語キーワードがノイズになるため
 * 付与しない（言語別の埋め込みを実測で分離した設計）。 */
export function profileTexts(
  confs: unknown[] | null | undefined,
  catNames?: Record<string, string> | null,
  forMulti = false,
  venuePapers: Record<string, string[]> = {},
): { keys: string[]; texts: string[] } {
  const keys: string[] = [];
  const texts: string[] = [];
  const safeCats = catNames ?? {};
  for (const raw of confs ?? []) {
    const c = raw as Record<string, unknown>;
    if (!c || typeof c !== "object") continue;
    const key = String(c.key ?? "").trim();
    if (!key) continue;
    // カテゴリは短いキー（systems 等）より正式名（Systems, Architecture and Storage）で
    // 埋め込む方がセマンティック品質が高い（ベンチマークで実測）。
    const cats = toStringArray(c.categories);
    const catText = cats.map((k) => safeCats[k] || k).join(" ");
    const name = `${String(c.title ?? "")} ${String(c.full_name ?? "")}`;
    // 多言語モデル用: 日本語名の会議に日本語の分野語を付与（クエリ側の日本語語彙と一致させる）
    const isJpVenue =
      hasJapanese(name) ||
      toStringArray(c.tags).includes("domestic-jp") ||
      toStringArray(c.tags).includes("niche-jp");
    const jpKw = forMulti && isJpVenue ? cats.map((k) => JP_CAT_KW[k] || "").join(" ") : "";
    // 実採択論文タイトル（あれば）でプロファイルを強化。
    // 英語モデルにのみ付与する。
    // multi にも付けると日本語クエリの sem ランキングを乱すため。
    // 「タイトル個別ベクトルの平均」方式（会議名 + 各タイトルを別々に埋めて
    // 平均）は golden top1 +2 エントリだが top5 -2・EN 合成 -3.6 で総合的に悪化した。
    // 連結 mean pooling が最良（golden top5 73.5% / EN 合成 85.0%）。
    // rtss/ecrts は論文が多様（scheduling/WCET/TSN/AI/FPGA）で平均重心が
    // 汎用化し、無関係クエリ（memory safety 等）を奪う。埋め込みは会議名中心に保ち、
    // papers は語彙一致（scoreLine）でのみ使う。
    // usenix-security も 24 本が極めて多様（crypto/ML/web/ハードウェア/ブロックチェーン）で
    // 重心が汎用化しやすいため vocab-only。
    // icdcs を vocab-only にすると golden top5 65.7→62.9 に悪化するため、埋め込みは維持する。
    const skipEmb = SKIP_EMB_KEYS.has(key);
    const papers = !forMulti && !skipEmb ? (venuePapers[key] ?? []).slice(0, 8).join(" . ") : "";
    const tags = toStringArray(c.tags).filter((tag) => !ATTRIBUTE_TAGS.has(tag));
    const scopeText = extractScopeText(c);
    const parts = [
      String(c.title ?? ""),
      String(c.full_name ?? ""),
      catText,
      scopeText,
      jpKw,
      tags.join(" "),
      papers,
    ];
    const text = parts.filter(Boolean).join(" ").trim();
    keys.push(key);
    texts.push(text || key);
  }
  return { keys, texts };
}

/** Keep venue context with every topic; the multilingual model reads its Japanese field context before the English venue name. */
export function topicProfileTexts(
  confs: unknown[],
  catNames: Record<string, string> = {},
  forMulti = false,
): { keys: string[]; texts: string[] } {
  const keys: string[] = [];
  const texts: string[] = [];
  for (const value of confs) {
    if (!value || typeof value !== "object") continue;
    const conf = value as Record<string, unknown>;
    const key = String(conf.key ?? "").trim();
    if (!key) continue;
    const name = String(conf.full_name || conf.title || key);
    const cats = toStringArray(conf.categories);
    const categoryContext = cats.map((cat) => catNames[cat] ?? cat).join(" ");
    const context = [
      categoryContext,
      forMulti && cats.length <= 2 ? cats.map((cat) => JP_CAT_KW[cat] ?? "").join(" ") : "",
    ]
      .filter(Boolean)
      .join(" ");
    const scopes = [...toStringArray(conf.scope), ...toStringArray(conf.official_scope)];
    const topics = [
      ...new Set(
        scopes
          .flatMap((scope) => scope.split(/[;,。\n]/))
          .map((topic) => topic.replace(/\s+/g, " ").trim())
          .filter((topic) => topic.length >= 4),
      ),
    ];
    for (const topic of topics) {
      keys.push(key);
      texts.push(
        context
          ? forMulti
            ? `${topic}. ${context}. ${name}`
            : `${name}. ${topic}. ${context}`
          : `${name}. ${topic}`,
      );
    }
  }
  return { keys, texts };
}
