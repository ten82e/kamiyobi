/** 骨（小文字に畳み、英数字以外を落とした綴り）から、その骨を書く語と件数。 */
export type LatinVocabularyJa = Map<string, { word: string; count: number }>;

const 字種Ja = /^[a-z][a-z0-9]*$/;

/** 綴りの骨 – 空格・ハイフン・点の打ち分けは同じ骨に落ちる（`camera-redy` ⇔ `camera ready`）。 */
export function latinSkeletonJa(文: unknown): string {
  return String(文 ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export function latinVocabularyJa(folded: readonly string[]): LatinVocabularyJa {
  const 語彙: LatinVocabularyJa = new Map();
  const 足す = (raw: string): void => {
    const 骨 = latinSkeletonJa(raw);
    if (!字種Ja.test(骨)) return;

    if (骨.length < 4 ? !/^[a-z]{2,3}$/.test(骨) : !/[aeiou]/.test(骨)) return;
    const 前 = 語彙.get(骨);
    if (前) 前.count += 1;
    else 語彙.set(骨, { word: raw, count: 1 });
  };
  for (const 文 of folded) {
    const 片 = String(文)
      .split(/[^a-z0-9]+/)
      // 略語（`ai` `os`）も収録の語なので二字から数へる（三字にすると `AIセミナー` の打ち手が
      // 収録語で無い事になつて落ちる – 第 680 回の実測）。
      .filter((x) => x.length >= 2);
    for (let i = 0; i < 片.length; i++) {
      足す(片[i]);
      if (i + 1 < 片.length) 足す(`${片[i]} ${片[i + 1]}`);
    }
  }
  return 語彙;
}

/** 収録の実在する語（語彙に骨が並ぶ語）か – 打ち手の見当に出して良い語の門。 */
export function latinAttestedJa(語彙: LatinVocabularyJa, 語: string): boolean {
  return 語彙.has(latinSkeletonJa(語));
}

/**
 * 打たれた綴りの骨から、一文字違いの収録語を頻度の多い順に返す（見当の数だけ – 既定は二語）。
 * 同じ骨（打ち方が違ふだけ）は返さん（検索しは既に同じ行へ屆いている）。
 */
export function latinNearestJa(
  語彙: LatinVocabularyJa,
  型: string,
  limit = 2,
): Array<{ word: string; count: number }> {
  if (!型 || 型.length < 4) return [];
  const 文字 = "abcdefghijklmnopqrstuvwxyz0123456789";
  const 見付: LatinVocabularyJa = new Map();
  const 見る = (骨: string): void => {
    if (骨 === 型 || 骨.length < 4) return;
    const 當 = 語彙.get(骨);
    if (當 && !見付.has(骨)) 見付.set(骨, 當);
  };
  const 字 = Array.from(型);
  for (let i = 0; i < 字.length; i++) {
    for (const c of 文字) if (c !== 字[i]) 見る(型.slice(0, i) + c + 型.slice(i + 1)); // 置換
    見る(型.slice(0, i) + 型.slice(i + 1)); // 落
    if (i + 1 < 字.length && 字[i] !== 字[i + 1])
      見る(型.slice(0, i) + 字[i + 1] + 字[i] + 型.slice(i + 2)); // 轉位
  }
  for (let i = 0; i <= 型.length; i++) {
    for (const c of 文字) 見る(型.slice(0, i) + c + 型.slice(i)); // 插
  }
  /* 頻度の同じ時は、打たれた語の形に残るほうを先に出す（実測 – `camera redy` には
   * 『camera ready』（147 件）を『ready』（147 件）より先に讓る – 落とした一文字を足す打ち手
   * の方が、語を一つ減らす打ち手より探している物から遠ざからん）。*/
  return [...見付.values()]
    .sort(
      (a, b) =>
        b.count - a.count ||
        Math.abs(latinSkeletonJa(a.word).length - 型.length) -
          Math.abs(latinSkeletonJa(b.word).length - 型.length),
    )
    .slice(0, limit > 0 ? limit : 1);
}
