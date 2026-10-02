/**
 * 欧文の語を一字違ひに打つ人へ、収録の綴りを一つ見当として出す表（第 680 回）。
 *
 * 實測（2026-08-09 生成の実ビルド・品書 3,250 行）– `camera-redy` `registraton` `workshp`
 * `embeded` `netwrok` `sumposium` `hybird` は搜 0 行で、語の切れ端の見当（`shorterHitWordsJa` の
 * 短くする・割る形）も當たず、畫面は「別の語で試す」の受皿に落ちた。近い綴りの語は同じ品書に
 * 147 件・66 件・174 件と出て居るのに、その一言が無かつた。
 *
 * 此處で出すのは**打ち手の見当だけ** – 搜し自体は廣げん（默つて廣げるのは第 246 回で禁じた）。
 * 一文字の插し・落・置換と、隣り合う二文字の轉位だけを通す（二文字離れると誤爆 – 實測で
 * `specifical`・`shorch`・`deadlines` との間は一文字では縮まらんので彈いて居る）。
 */

/** 骨（小文字に畳み、英数字以外を落とした綴り）から、その骨を書く語と件數。 */
export type LatinVocabularyJa = Map<string, { word: string; count: number }>;

const 字種Ja = /^[a-z][a-z0-9]*$/;

/** 綴りの骨 – 空格・ハイフン・點の打ち分けは同じ骨に落ちる（`camera-redy` ⇔ `camera ready`）。 */
export function latinSkeletonJa(文: unknown): string {
  return String(文 ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * 畳んだ行の文本（`kanaFold` 済み）から語彙を作る。二語続き（`camera ready`）も入れる –
 * ハイフンを打つ人は語を跨いだ綴りを違へる事がある為（第 680 回の実測の例が其れ）。
 */
export function latinVocabularyJa(folded: readonly string[]): LatinVocabularyJa {
  const 語彙: LatinVocabularyJa = new Map();
  const 足す = (raw: string): void => {
    const 骨 = latinSkeletonJa(raw);
    if (!字種Ja.test(骨)) return;
    /* 三文字以下は略語（`ai` `hpc` `gpu` `ccf`）で、子音だけでも收錄の語なので數へる
     * （實測 – 彈くと `HPCセミナー` の打ち手が「切れ端」と間違へられて落ちる – 第 680 回）。
     * 四文字以上で子音だけ（`xmlx`? 等）は寄せ先が曖昧なので彈く。*/
    if (骨.length < 4 ? !/^[a-z]{2,3}$/.test(骨) : !/[aeiou]/.test(骨)) return;
    const 前 = 語彙.get(骨);
    if (前) 前.count += 1;
    else 語彙.set(骨, { word: raw, count: 1 });
  };
  for (const 文 of folded) {
    const 片 = String(文)
      .split(/[^a-z0-9]+/)
      // 略語（`ai` `os`）も收錄の語なので二字から數へる（三字にすると `AIセミナー` の打ち手が
      // 收錄語で無い事になつて落ちる – 第 680 回の実測）。
      .filter((x) => x.length >= 2);
    for (let i = 0; i < 片.length; i++) {
      足す(片[i]);
      if (i + 1 < 片.length) 足す(`${片[i]} ${片[i + 1]}`);
    }
  }
  return 語彙;
}

/** 收錄の実在する語（語彙に骨が並ぶ語）か – 打ち手の見當に出して良い語の門（第 680 回）。 */
export function latinAttestedJa(語彙: LatinVocabularyJa, 語: string): boolean {
  return 語彙.has(latinSkeletonJa(語));
}

/**
 * 打たれた綴りの骨から、一文字違いの収録語を頻度の多い順に返す（見當の数だけ – 既定は二語）。
 * 同じ骨（打ち方が違ふだけ）は返さん（搜しは既に同じ行へ屆いて居る）。
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
  /* 頻度の同じ時は、打たれた語の形に残るほうを先に出す（實測 – `camera redy` には
   * 『camera ready』（147 件）を『ready』（147 件）より先に讓る – 落とした一文字を足す打ち手
   * の方が、語を一つ減らす打ち手より探して居る物から遠ざからん）。*/
  return [...見付.values()]
    .sort(
      (a, b) =>
        b.count - a.count ||
        Math.abs(latinSkeletonJa(a.word).length - 型.length) -
          Math.abs(latinSkeletonJa(b.word).length - 型.length),
    )
    .slice(0, limit > 0 ? limit : 1);
}
