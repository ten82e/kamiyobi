/** 細目の主題と募集対象を打つ人の斷りの檢査（SPEC §7・第 535 回）。 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const AT = Date.parse("2026-08-09T00:00:00Z");
type Row = { hay: string };
function 品書(): Row[] {
  return Recommender.candidateRows(
    JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")),
  ) as Row[];
}
function 件(rows: Row[], 文: string): number {
  const m = Recommender.searchMatcher(文, AT);
  return rows.filter((r) => m(r.hay) === true).length;
}

/** 細目の主題の群に立てた打ち方（實測で 0 件・無言だつた語 – 數字は SPEC §8）。 */
const 細目 = [
  "GPU",
  "CUDA",
  "Kubernetes",
  "OpenMP",
  "PGAS",
  "サーバーレス",
  "連合学習",
  "分散台帳",
  "暗号通貨",
  "省電力",
  "サステナビリティ",
  "ウェブ技術",
  "オントロジー",
  "産学セッション",
  "学生向け",
  "博士課程",
  "federated",
  "フェデレーテッド",
  "性能評価",
  "ソフトウェアインジニアリング",
];
/** 群に混ぜん語（名簿の語・他の檢査が引き取る語 – 第 294 回・第 534 回の実測）。 */
const 彈いた = ["MPI", "ACL", "CTF", "推薦システム", "ハッキングコンテスト"];

describe("細目の主題と募集対象の斷り", () => {
  it("默らずに、この表が持つ物を敎うる", () => {
    細目.forEach((語) => {
      const 案内 = Recommender.uiWordNoteJa(語);
      expect(案内.length, `"${語}" が無言に逆戻りした`).toBeGreaterThan(0);
      /* 噓の案内を立たん – 分野・種別・開催地・参加形式は実際にこの表の欄の名前。 */
      ["分野", "種別", "開催地", "参加形式"].forEach((欄) => {
        expect(
          案内.includes(欄) || 案内.includes("公式ページ"),
          `"${語}" の案内に欄の名前が無い`,
        ).toBe(true);
      });
    });
  });

  it("寄せはして居らん（0 件の侭 – 正直な 0 件）", () => {
    const rows = 品書();
    /* `federated` 等も同じ – 細目の羣は案内を出すだけで行を増やさん（第 642 回）。
     * `ハッキング`・`CTF` を此の羣に載せん理由（競技形式の名は行を出す搜しで直す – 第 534 回）を
     * 上の `彈いた` 定數が張つて居る。*/
    ["GPU", "CUDA", "Kubernetes", "OpenMP", "連合学習", "federated", "性能評価"].forEach((語) => {
      expect(件(rows, 語), `"${語}" が行を持つやうに廣がつた`).toBe(0);
    });
  });

  it("語が頭に續く打ち方（`科研費の申請` `証明書の発行`）も斷りを受け取る（第 538 回）", () => {
    /* 印（`anyTail`）を付けた群は、語の後ろに何が續いても受ける。其の方で行が出る打ち方には
     * 畫面上には立たないので噓にはならん（第 337 回）。實測で 0 件だつた打ち方を並べる。 */
    const rows = 品書();
    [
      ["領収書 が欲しい", "領収書"],
      ["特許 の出願", "特許"],
      ["科研費の申請", "科研費"],
      ["証明書の発行", "証明書"],
      ["学生向け の枠", "学生向け"],
      ["産学連携の会議", "産学連携"],
      ["出展要項", "出展"],
    ].forEach(([文, 名指し]) => {
      expect(件(rows, 文), `"${文}" は其の方で行が出る（斷つたら噓）`).toBe(0);
      const 案内 = Recommender.uiWordNoteJa(文);
      expect(案内.includes(`「${名指し}」`), `"${文}" が "${名指し}" を名指さん`).toBe(true);
    });
  });

  it("弾いた語と空白を含む語を、群の一覽に混ぜん", () => {
    const b = readFileSync("site/recommender.ts", "utf8");
    const i = b.indexOf('        "GPU",');
    expect(i).toBeGreaterThan(0);
    const 群 = b.slice(i, b.indexOf('note: "はこの表の行に書かれて居らん', i));
    彈いた.forEach((語) => {
      expect(群.includes(`"${語}"`), `"${語}" を群に混ぜた（彈いた理由が崩れる）`).toBe(false);
    });
    /* 空白を含む語は網址の中に當たる（第 534 回の実測）。 */
    [...群.matchAll(/"([^"\n]+)"/g)].forEach((m) => {
      expect(/\s/.test(m[1]), `空白を含む語 "${m[1]}" を入れた`).toBe(false);
    });
  });

  it("運営・手続きと学会の出版物を訪ねる人も、默らずに受け取る（第 536 回）", () => {
    const rows = 品書();
    [
      "特集セッション",
      "企業展示",
      "出展",
      "ポスターサイズ",
      "遅延申請",
      "録画配信",
      "領収書",
      "謝金",
      "当日参加",
      "直前",
      "キャンセル",
      "学会誌",
      "速報誌",
      "紀要",
      // 第 539 回 – 運営と手續きの別の言い方（實測で 0 件・無言だつた語）。
      "懇親会",
      "昼食",
      "ランチ",
      "送迎",
      "論文集",
      "討論",
      "パネル",
      "受付",
      "名札",
      "参加証",
      "振込",
      "入金",
      "返金",
      "支払",
      "学生割",
      "ビザレター",
      "就査証",
      "入国",
      "消費税",
      "銀行",
      "納品書",
      "出張届",
      "依頼書",
      "依頼状",
      "内諾",
      "査読料",
      "論文掲載料",
      "出版費",
      "発表論文集",
      "休憩",
      "校正刷",
      // 第 537 回 – 運営・手續きと細目の別の言い方（實測で 0 件・無言だつた語）。
      "科研費",
      "出願",
      "特許",
      "客員研究員",
      "単位互換",
      "滞在費",
      "発表料",
      "原稿料",
      "論文費",
      "ページチャージ",
      "印刷費",
      "遅延登録",
      "延長登録",
      "再登録",
      "証明書",
      "参加証明",
      "出席証明",
      "発表証明",
      "最終告知",
      "校了",
      "組版",
      "産学連携",
      "共同研究",
      "技術移転",
      "研究発表",
      "成果発表",
    ].forEach((語) => {
      const 案内 = Recommender.uiWordNoteJa(語);
      expect(案内.length, `"${語}" が無言に逆戻りした`).toBeGreaterThan(0);
      /* 斷りは実際に 0 件の語にだけ立つ – 行を持つ語に「出て居ません」と言わん（第 337 回）。 */
      expect(件(rows, 語), `"${語}" は行を持つので彈くべき語だつた`).toBe(0);
    });
  });

  it("行を持つ語を学会誌の群に混ぜん（實測で行を持つ語 – 5 件・1 件・6 件・5 件・2 件・1 件）", () => {
    const b = readFileSync("site/recommender.ts", "utf8");
    const 語の位置 = b.indexOf('\n        "学会誌",');
    const i = b.lastIndexOf("words: [", 語の位置);
    expect(語の位置).toBeGreaterThan(0);
    expect(i).toBeGreaterThan(0);
    const 群 = b.slice(i, b.indexOf("live:", i));
    [
      "論文誌",
      "ジャーナル",
      "ポスターセッション",
      "チュートリアル",
      "プロシーディングス",
      "学生セッション",
    ].forEach((語) => {
      expect(群.includes(`"${語}"`), `"${語}" を混ぜた（行を持つ – 噓の斷りになる）`).toBe(false);
    });
  });

  it("日時の聞き方で打つ人も默らず、當たる形へ導かれる（第 540 回）", () => {
    const rows = 品書();
    [
      "何時",
      "何日",
      "何曜日",
      "何時から",
      "何時迄",
      "何月",
      "いつから",
      "日程表",
      "会期表",
    ].forEach((語) => {
      const 案内 = Recommender.uiWordNoteJa(語);
      expect(案内.length, `"${語}" が無言に逆戻りした`).toBeGreaterThan(0);
      expect(件(rows, 語), `"${語}" は行を持つので彈くべき語だつた`).toBe(0);
    });
    /* 導いた形は實際に行が出る（噓の例を示さん – 第 337 回）。 */
    ["2026年", "8月", "今月"].forEach((形) => {
      expect(件(rows, 形), `例に示した "${形}" に行が在ん`).toBeGreaterThan(0);
    });
    /* `いつまで` は曖昧な幅の群が持つ語なので、この群に混ぜん（實測 – 三本の檢査が守つて居た）。 */
    const b = readFileSync("site/recommender.ts", "utf8");
    const i = b.indexOf('note: "という聞き方では絞り込めません');
    const a = b.lastIndexOf("words: [", i);
    expect(b.slice(a, b.indexOf("      ],", a)).includes('"いつまで"')).toBe(false);
  });

  it("原稿と投稿の手続きを訪ねる人も、默らずに公式ページへ導かれる（第 541 回）", () => {
    const rows = 品書();
    [
      "投稿規定",
      "投稿要領",
      "投稿フォーマット",
      "原稿書式",
      "テンプレート",
      "二段組",
      "ページ数",
      "最大ページ数",
      "ページ制限",
      "英語原稿",
      "和文原稿",
      "図表",
      "参考文献形式",
      "引用形式",
      "再投稿",
      "著者情報",
      "所属機関",
      "肩書",
      "連絡先",
      "執筆料金",
    ].forEach((語) => {
      const 案内 = Recommender.uiWordNoteJa(語);
      expect(案内.length, `"${語}" が無言に逆戻りした`).toBeGreaterThan(0);
      expect(案内).toContain("公式ページ");
      expect(件(rows, 語), `"${語}" は行を持つので彈くべき語だつた`).toBe(0);
    });
    /* `カメラレディ` は實測 70 件 – 行が出る語を「持つ欄の名前では無い」と斷たんとる（第 337 回）。 */
    expect(件(rows, "カメラレディ")).toBeGreaterThan(0);
    const b = readFileSync("site/recommender.ts", "utf8");
    const i = b.indexOf(
      'note: "はこの表が持つ欄の名前ではありません。この表は催し物の名前・締切の日・分野・種別・開催地・参加形式を出しています。原稿',
    );
    const a = b.lastIndexOf("words: [", i);
    const 群 = b.slice(a, b.indexOf("      ],", a));
    ["カメラレディ", "提出方法", "提出先"].forEach((語) => {
      expect(群.includes(`"${語}"`), `"${語}" を混ぜた（行が出るか他の案内が引き取る語）`).toBe(
        false,
      );
    });
  });

  it("協賛と催し物の形と役員を尋ねる語も、默らずに受け取る（第 542 回）", () => {
    const rows = 品書();
    const 語 = [
      "広告",
      "展示",
      "実行委員長",
      "プログラム委員長",
      "実行委員",
      "運営委員",
      "組織委員",
      "受賞者",
      "学会賞",
      "学生優秀賞",
      "研究会誌",
      "ハッカソン",
      "アイディアソン",
      "サマースクール",
      "夏季学校",
      "冬季学校",
    ];
    語.forEach((w) => {
      const 案内 = Recommender.uiWordNoteJa(w);
      expect(案内.length, `"${w}" が無言に逆戻りした`).toBeGreaterThan(0);
      expect(件(rows, w), `"${w}" は行を持つので彈くべき語だつた`).toBe(0);
    });
    /* 弾いた語 – 其の方で行が出る語と、打ち方が曖昧な語を群に混ぜん。 */
    expect(件(rows, "チュートリアル")).toBeGreaterThan(0);
    const b = readFileSync("site/recommender.ts", "utf8");
    const i = b.indexOf(
      'note: "はこの表が載せる種別（会議・シンポジウム・ワークショップ）に入らん催し物の形です',
    );
    const a = b.lastIndexOf("words: [", i);
    const 形 = b.slice(a, b.indexOf("      ],", a));
    ["チュートリアル", "学校", "ジョイント"].forEach((w) => {
      expect(
        形.includes(`"${w}"`),
        `"${w}" を催し物の形の群に混ぜた（行が出る／打ち方が曖昧）`,
      ).toBe(false);
    });
  });

  it("参加する人・当日の進行・會場まわりを尋ねる語も受け取る（第 543 回）", () => {
    const rows = 品書();
    [
      "傍聴",
      "見学者",
      "同伴者",
      "家族",
      "一般参加",
      "学部生",
      "大学生",
      "高校生",
      "教員",
      "企業人",
      "開演",
      "開会",
      "閉会",
      "進行",
      "登壇順",
      "発言時間",
      "昼休み",
      "最寄り",
      "駐車場",
      "地図",
      "会場地図",
      "会場案内",
    ].forEach((w) => {
      expect(Recommender.uiWordNoteJa(w).length, `"${w}" が無言に逆戻りした`).toBeGreaterThan(0);
      expect(件(rows, w), `"${w}" は行を持つので彈くべき語だつた`).toBe(0);
    });
    /* `聴講` は彈いた – `聴講料` を費用の案内へ導く檢査（第 516 回）が其の語を引き受けて居る。 */
    expect(Recommender.uiWordNoteJa("聴講料")).toContain("費用");
    const b = readFileSync("site/recommender.ts", "utf8");
    const i = b.indexOf('note: "はこの表が持つ開催地（街の名前）とは別の案内です');
    const a = b.lastIndexOf("words: [", i);
    const 群 = b.slice(a, b.indexOf("      ],", a));
    ["聴講", "ホテル", "駅"].forEach((w) => {
      expect(群.includes(`"${w}"`), `"${w}" を會場まわりの群に混ぜた`).toBe(false);
    });
  });

  it("發表の形と採否の手続きの語も通じる（第 545 回）", () => {
    const rows = 品書();
    ["特別講演", "招待講演者", "登壇者", "投稿番号", "採択通知メール", "掲載確定"].forEach((w) => {
      expect(Recommender.uiWordNoteJa(w).length, `"${w}" が無言に逆戻りした`).toBeGreaterThan(0);
      expect(件(rows, w), `"${w}" は行を持つので彈くべき語だつた`).toBe(0);
    });
  });

  it("他の群が持つ語と『開催地』に実在する語を、運営の群に混ぜん（第 539 回）", () => {
    const b = readFileSync("site/recommender.ts", "utf8");
    const i = b.indexOf('note: "はこの表が持つ欄の名前ではありません');
    const a = b.lastIndexOf("words: [", i);
    const 群 = b.slice(a, b.indexOf("      ],", a));
    ["ホテル", "招聘状", "招待状", "日程表"].forEach((語) => {
      expect(
        群.includes(`"${語}"`),
        `"${語}" を運営の群に混ぜた（費用の群の語・『開催地』の実在・此の方で持つ物）`,
      ).toBe(false);
    });
  });

  it("案内は「持って居らん」と言う所を數へて居る（無い欄の名前を在るかやうに書かん）", () => {
    expect(Recommender.uiWordNoteJa("学生向け")).toContain("公式ページ");
    /* この表に費用の欄は無い – 旅費を訪ねる人を在る欄に誤導せん。 */
    expect(Recommender.uiWordNoteJa("学生向け")).not.toContain("参加費の欄");
  });
  it("賞の語は賞の群が受け取る（運營の群に混ぜんと實測で定まつた置き場所を張る）", () => {
    const rows = 品書();
    ["学生ポスター賞", "口頭賞", "最優秀論文賞", "優秀論文賞"].forEach((w) => {
      expect(Recommender.uiWordNoteJa(w).length, `"${w}" が無言に逆戻りした`).toBeGreaterThan(0);
      expect(件(rows, w), `"${w}" は行を持つので彈くべき語だつた`).toBe(0);
    });
    const b = readFileSync("site/recommender.ts", "utf8");
    expect(b).toContain('"学生ポスター賞"');
  });
  it("登録と可否を尋ねる語も默らん（第 551 回）", () => {
    const rows = 品書();
    ["当日登録", "所属の変更", "著者順", "発表の可否", "発表可否", "参加可否"].forEach((w) => {
      expect(Recommender.uiWordNoteJa(w).length, `"${w}" が無言に逆戻りした`).toBeGreaterThan(0);
      expect(件(rows, w), `"${w}" は行を持つので彈くべき語だつた`).toBe(0);
    });
  });
  it("取消と出張の手續きも默らん", () => {
    const rows = 品書();
    ["出張報告", "発表取消", "参加取消"].forEach((w) => {
      expect(Recommender.uiWordNoteJa(w).length).toBeGreaterThan(0);
      expect(件(rows, w)).toBe(0);
    });
  });
  it("提出物と代理出席の手續きも默らん", () => {
    const rows = 品書();
    [
      "事前確認",
      "原稿の言語",
      "口頭の言語",
      "質問の受付",
      "連絡方法",
      "資料配布",
      "資料ダウンロード",
      "スライド提出",
      "動画提出",
      "当日欠席",
      "代理出席",
      "代理発表",
    ].forEach((w) => {
      expect(Recommender.uiWordNoteJa(w).length).toBeGreaterThan(0);
      expect(件(rows, w)).toBe(0);
    });
  });
  it("變更と延期の告知も默らん（第 556 回）", () => {
    const rows = 品書();
    [
      "アナウンス",
      "更新情報",
      "変更点",
      "締切の変更",
      "締切短縮",
      "日時の変更",
      "会場変更",
      "会場の変更",
      "振替",
      "延期",
      "中止",
      "終了告知",
    ].forEach((w) => {
      expect(Recommender.uiWordNoteJa(w).length).toBeGreaterThan(0);
      expect(件(rows, w)).toBe(0);
    });
  });
  it("登錄の種別と會場での身の回りの語も默らん（第 557 回）", () => {
    const rows = 品書();
    [
      "当日券",
      "正規登録",
      "グループ割",
      "無料参加",
      "聴講無料",
      "服装",
      "持ち物",
      "荷物",
      "手荷物",
      "両替",
    ].forEach((w) => {
      expect(Recommender.uiWordNoteJa(w).length).toBeGreaterThan(0);
      expect(件(rows, w)).toBe(0);
    });
  });
  it("機材とリハの語も默らん（第 558 回）", () => {
    const rows = 品書();
    [
      "プロジェクター",
      "電源",
      "有線LAN",
      "機材",
      "椅子",
      "配布物",
      "会場レイアウト",
      "搬入",
      "搬出",
      "設営",
      "解体",
      "登壇リハ",
      "事前リハ",
    ].forEach((w) => {
      expect(Recommender.uiWordNoteJa(w).length).toBeGreaterThan(0);
      expect(件(rows, w)).toBe(0);
    });
  });
  it("交流と採用關連の語も默らん（第 559 回）", () => {
    const rows = 品書();
    [
      "名刺交換",
      "ネットワーキング",
      "情報交換",
      "採用",
      "求人",
      "リクルート",
      "企業説明",
      "産学交流",
      "連携提案",
    ].forEach((w) => {
      expect(Recommender.uiWordNoteJa(w).length).toBeGreaterThan(0);
      expect(件(rows, w)).toBe(0);
    });
  });
  it("發表の順と時間の語も默らん（第 561 回）", () => {
    const rows = 品書();
    ["発表順", "セッション順", "登壇時間"].forEach((w) => {
      expect(Recommender.uiWordNoteJa(w).length).toBeGreaterThan(0);
      expect(件(rows, w)).toBe(0);
    });
  });
  it("採否の照會と登錄の變更、金の明細の語も默らん（第 564 回）", () => {
    const rows = 品書();
    [
      "採否の照会",
      "採択証明",
      "掲載証明",
      "登録内容の変更",
      "口座情報",
      "名義変更",
      "明細書",
    ].forEach((w) => {
      expect(Recommender.uiWordNoteJa(w).length).toBeGreaterThan(0);
      expect(件(rows, w)).toBe(0);
    });
  });
  it("會員に關する語も默らん（第 565 回）", () => {
    const rows = 品書();
    [
      "個人会員",
      "法人会員",
      "会員費",
      "入会手続",
      "退会",
      "会員番号",
      "会員証",
      "二重会員",
      "会員種別の変更",
      "非会員参加",
      "会員以外",
    ].forEach((w) => {
      expect(Recommender.uiWordNoteJa(w).length).toBeGreaterThan(0);
      expect(件(rows, w)).toBe(0);
    });
  });
  it("集録の類と配信の語も默らん（第 567 回）", () => {
    const rows = 品書();
    [
      "予稿集",
      "プログラム集",
      "講演集録",
      "抄録集",
      "プロシーディングス購読",
      "生配信",
      "アーカイブ配信",
      "見逃し配信",
      "後日視聴",
    ].forEach((w) => {
      expect(Recommender.uiWordNoteJa(w).length).toBeGreaterThan(0);
      expect(件(rows, w)).toBe(0);
    });
  });
  it("證明と郵送の語も默らん（第 568 回）", () => {
    const rows = 品書();
    [
      "在學証明",
      "在籍証明",
      "指導教員",
      "業績",
      "研究実績",
      "発表実績",
      "簡易書留",
      "書留",
      "消印",
    ].forEach((w) => {
      expect(Recommender.uiWordNoteJa(w).length).toBeGreaterThan(0);
      expect(件(rows, w)).toBe(0);
    });
  });
  it("日帰りと宿の打ち方も默らん（第 569 回）", () => {
    const rows = 品書();
    ["宿泊無し", "日帰り", "近場"].forEach((w) => {
      expect(Recommender.uiWordNoteJa(w).length).toBeGreaterThan(0);
      expect(件(rows, w)).toBe(0);
    });
  });
  it("參加の形の語は同じ導きを受ける（第 570 回）", () => {
    const rows = 品書();
    ["部分参加", "対面参加", "オフライン参加"].forEach((w) => {
      const 案内 = Recommender.uiWordNoteJa(w);
      expect(案内.length, `"${w}" が無言に逆戻りした`).toBeGreaterThan(0);
      expect(案内).toContain("オンライン参加可");
      expect(件(rows, w), `"${w}" は行を持つので彈くべき語だつた`).toBe(0);
    });
  });
  it("學會の會務の語も默らん（第 571 回）", () => {
    const rows = 品書();
    [
      "総会",
      "理事会",
      "支部",
      "地域支部",
      "幹事",
      "役員の選出",
      "投票",
      "電子投票",
      "委任状",
      "議事録",
    ].forEach((w) => {
      expect(Recommender.uiWordNoteJa(w).length).toBeGreaterThan(0);
      expect(件(rows, w)).toBe(0);
    });
  });
  it("出版倫理と別刷りの語も默らん（第 573 回）", () => {
    const rows = 品書();
    [
      "リジェクト",
      "別投稿",
      "転載",
      "二重投稿",
      "自己援用",
      "プレプリント",
      "arXiv投稿",
      "出版倫理",
      "利益相反",
    ].forEach((w) => {
      expect(Recommender.uiWordNoteJa(w).length).toBeGreaterThan(0);
      expect(件(rows, w)).toBe(0);
    });
  });
  it("旅と送金の語も默らん（第 574 回）", () => {
    const rows = 品書();
    ["査証", "パスポート", "在外参加", "時差", "送金", "外貨", "源泉徴収", "個人番号"].forEach(
      (w) => {
        expect(Recommender.uiWordNoteJa(w).length).toBeGreaterThan(0);
        expect(件(rows, w)).toBe(0);
      },
    );
  });
  it("撮りと會場の裏方の語も默らん（第 575 回）", () => {
    const rows = 品書();
    [
      "撮影",
      "写真撮影",
      "報道",
      "取材",
      "記者",
      "プレス",
      "USBメモリ",
      "前日入り",
      "後片付け",
    ].forEach((w) => {
      expect(Recommender.uiWordNoteJa(w).length).toBeGreaterThan(0);
      expect(件(rows, w)).toBe(0);
    });
  });
  it("緊急の session の打ち方も默らん（第 576 回）", () => {
    const rows = 品書();
    ["緊急セッション"].forEach((w) => {
      expect(Recommender.uiWordNoteJa(w).length).toBeGreaterThan(0);
      expect(件(rows, w)).toBe(0);
    });
  });
  it("二つ目の日本語の分野名と集録の出版も默らん（第 577 回）", () => {
    const rows = 品書();
    ["機械翻訳", "意味解析", "プロシーディングス出版"].forEach((w) => {
      expect(Recommender.uiWordNoteJa(w).length).toBeGreaterThan(0);
      expect(件(rows, w)).toBe(0);
    });
  });
  it("參加重金の減免と助成の語も默らん（第 578 回）", () => {
    const rows = 品書();
    ["減免", "免除", "助成", "出張支援", "若手支援"].forEach((w) => {
      expect(Recommender.uiWordNoteJa(w).length).toBeGreaterThan(0);
      expect(件(rows, w)).toBe(0);
    });
  });
  it("發表の言語に關する語も默らん（第 579 回）", () => {
    const rows = 品書();
    ["日本語発表", "英語必須", "発音", "翻訳サービス", "英語支援", "筆談"].forEach((w) => {
      expect(Recommender.uiWordNoteJa(w).length).toBeGreaterThan(0);
      expect(件(rows, w)).toBe(0);
    });
  });
  it("事後の手続きと禮儀の語も默らん（第 580 回）", () => {
    const rows = 品書();
    ["精算", "決算", "報告書", "お礼状", "謝辞"].forEach((w) => {
      expect(Recommender.uiWordNoteJa(w).length).toBeGreaterThan(0);
      expect(件(rows, w)).toBe(0);
    });
  });
  it("引率と介添の語も默らん（第 581 回）", () => {
    const rows = 品書();
    [
      ["引率", "募集対象"],
      ["同行者", "募集対象"],
      ["介添", "会場の中と外"],
    ].forEach(([w, 語]) => {
      const 案内 = Recommender.uiWordNoteJa(w);
      expect(案内.length).toBeGreaterThan(0);
      expect(案内).toContain(語);
      expect(件(rows, w)).toBe(0);
    });
  });
  it("立場の名前の語も默らん（第 582 回）", () => {
    const rows = 品書();
    ["聴講生", "研究生", "科目等履修生", "ポスドク", "技術職員", "研究員"].forEach((w) => {
      const 案内 = Recommender.uiWordNoteJa(w);
      expect(案内.length).toBeGreaterThan(0);
      expect(案内).toContain("募集対象");
      expect(件(rows, w)).toBe(0);
    });
    const 教務案 = Recommender.uiWordNoteJa("教務");
    expect(教務案).toContain("欄の名前ではありません");
    expect(件(rows, "教務")).toBe(0);
  });
  it("登壇の形と記錄の配信の語も默らん（第 584 回）", () => {
    const rows = 品書();
    ["パネリスト登壇", "後日配信", "記錄視聴", "ポスター発表時間"].forEach((w) => {
      const 案内 = Recommender.uiWordNoteJa(w);
      expect(案内.length).toBeGreaterThan(0);
      expect(案内).toContain("欄の名前ではありません");
      expect(件(rows, w)).toBe(0);
    });
  });
  it("募集と投稿の期間の語も默らん（第 585 回）", () => {
    const rows = 品書();
    ["募集期間", "投稿期間"].forEach((w) => {
      const 案内 = Recommender.uiWordNoteJa(w);
      expect(案内.length).toBeGreaterThan(0);
      expect(案内).toContain("欄の名前ではありません");
      expect(件(rows, w)).toBe(0);
    });
  });
  it("交歓と懇親の群が出來た（第 586 回）", () => {
    const rows = 品書();
    ["二次会", "ツアー", "交歓", "親睦", "レセプション", "観光地"].forEach((w) => {
      const 案内 = Recommender.uiWordNoteJa(w);
      expect(案内.length).toBeGreaterThan(0);
      expect(案内).toContain("交歓の段取り");
      expect(案内.includes("社會")).toBe(false);
      expect(件(rows, w)).toBe(0);
    });
    /* 別の群が受け居る語を奪つて居らん事（第 543 回の接頭奪ひ）。 */
    expect(Recommender.uiWordNoteJa("懇親会")).toContain("欄の名前ではありません");
  });
  it("所屬先で決まる話と會場の機材の語が出來た（第 587 回）", () => {
    const rows = 品書();
    ["単位認定", "修了要件", "博士号の要件", "出席扱い", "学務", "進級"].forEach((w) => {
      const 案内 = Recommender.uiWordNoteJa(w);
      expect(案内.length).toBeGreaterThan(0);
      expect(案内).toContain("所属の大学・研究科の事務");
      expect(件(rows, w)).toBe(0);
    });
    ["Wi-Fi", "無線LAN"].forEach((w) => {
      const 案内 = Recommender.uiWordNoteJa(w);
      expect(案内).toContain("会場の中と外");
      expect(件(rows, w)).toBe(0);
    });
    /* 隣りの語の案内を奪つて居らん事（第 543 回）。 */
    expect(Recommender.uiWordNoteJa("単位互換")).toContain("欄の名前ではありません");
    expect(Recommender.uiWordNoteJa("出張届")).toContain("欄の名前ではありません");
  });
  it("公式ページの繋ぎ先を尋ねる打ち方を行が持つと書く（第 588 回）", () => {
    const rows = 品書();
    ["公式ページ", "公式サイト", "URL", "url", "ホームページ"].forEach((w) => {
      const 案内 = Recommender.uiWordNoteJa(w);
      expect(案内.length).toBeGreaterThan(0);
      expect(案内).toContain("公式サイトを開く");
      /* 噓にならんと「持って居らん」と書かんで在る（持つつて實測 – 第 505 回・第 519 回）。 */
      expect(案内.includes("持って居らん")).toBe(false);
      expect(件(rows, w)).toBe(0);
    });
    expect(Recommender.uiWordNoteJa("リンク")).not.toContain("公式サイトを開く");
  });
  it("和文・英文の別で絞り込めんと書く（第 590 回）", () => {
    const rows = 品書();
    ["和文論文誌", "和文", "英文論文誌", "研究報告"].forEach((w) => {
      const 案内 = Recommender.uiWordNoteJa(w);
      expect(案内.length).toBeGreaterThan(0);
      expect(案内).toContain("和文・英文の別");
      expect(件(rows, w)).toBe(0);
    });
    /* 語を並べた打ち方も受ける（multiword）。 */
    expect(Recommender.uiWordNoteJa("英文論文誌 関西")).toContain("和文・英文の別");
    /* 別の群が受け居る語を奪つて居らん事（第 543 回）。 */
    expect(Recommender.uiWordNoteJa("紀要")).not.toContain("和文・英文の別");
    expect(Recommender.uiWordNoteJa("レター")).not.toContain("和文・英文の別");
    /* 打ち直しの例は實測で行が出る（噓の例を書かん – 第 519 回）。 */
    expect(件(rows, "論文誌")).toBeGreaterThan(0);
    expect(件(rows, "特集号")).toBeGreaterThan(0);
  });
});

describe("稿種・審查の方式・費用の内譯・會場の手配の打ち方（第 598 回）", () => {
  const rows = 品書();
  /** 群の斷りが其の筋に屆いて居るかの目印（實測で 0 件・無言だつた打ち方 – SPEC §8）。 */
  const 見附 = [
    ["原著論文", "種別"],
    ["短報", "種別"],
    ["投稿論文", "種別"],
    ["査読付き", "審査の方式"],
    ["査読なし", "審査の方式"],
    ["匿名化", "審査の方式"],
    ["修正稿", "この表が持って"],
    ["所属", "著者"],
    ["ホテル手配", "会場の中と外"],
    ["宿泊手配", "会場の中と外"],
    ["学生参加費", "費用の欄"],
    ["非会員", "費用の欄"],
    ["非会員価格", "費用の欄"],
    ["会員価格", "費用の欄"],
    ["採点", "数の統計"],
    ["発表形式", "この表が持って"],
    ["口頭", "この表が持って"],
    ["口頭発表", "この表が持って"],
    ["執筆ガイドライン", "原稿の書式"],
  ] as const;

  it("打ち方を名前で呼び、其の筋の斷りに屆く", () => {
    for (const [語, 目印] of 見附) {
      const 群の注 = Recommender.uiWordNoteJa(語);
      expect(群の注.length, 語).toBeGreaterThan(0);
      expect(群の注, 語).toContain(語);
      expect(群の注, `${語} の宛先`).toContain(目印);
    }
  });

  it("行を持つ語を敎へて居らん事（第 337 回）", () => {
    for (const 語 of ["ポスター", "特集号", "論文誌", "研究会", "journal"]) {
      expect(件(rows, 語), 語).toBeGreaterThan(0);
      expect(Recommender.uiWordNoteJa(語), `${語} に行が立つのに斷つて居る`).toBe("");
    }
  });

  it("隣の語の宛先を奪つて居らん事（第 581 回）", () => {
    /* 費用・著者・刊行物・書式の群は元からの斷りの文を持つ – 語を增やしても其のまま。 */
    expect(Recommender.uiWordNoteJa("参加費")).toContain("費用の欄はありません");
    expect(Recommender.uiWordNoteJa("筆頭著者")).toContain("著者");
    expect(Recommender.uiWordNoteJa("学会誌")).toContain("種別");
    expect(Recommender.uiWordNoteJa("ページ数")).toContain("原稿の書式");
    expect(Recommender.uiWordNoteJa("ダブルブラインド")).toContain("審査の方式");
    expect(件(rows, "所属")).toBe(0);
    expect(件(rows, "採点")).toBe(0);
  });
});

describe("採否の結果・審查の物差し・提出の添付・證明の打ち方（第 599 回）", () => {
  const rows = 品書();
  const 見附 = [
    ["不採択", "数の統計"],
    ["落選", "数の統計"],
    ["レビューコメント", "審査の方式"],
    ["評価基準", "審査の方式"],
    ["ルーブリック", "審査の方式"],
    ["追加資料", "原稿の書式"],
    ["動画", "原稿の書式"],
    ["デモ動画", "原稿の書式"],
    ["コード公開", "原稿の書式"],
    ["連絡著者", "著者や発表者の役"],
    ["corresponding", "著者や発表者の役"],
    ["発表者登録", "運営と手続き"],
    ["特殊セッション", "運営と手続き"],
    ["トラック", "運営と手続き"],
    ["終了時刻", "絞り込めません"],
    ["受講証明", "あなたの所属で決まる話"],
    ["継続教育", "あなたの所属で決まる話"],
  ] as const;

  it("打ち方を名前で呼び、其の筋の斷りに屆く", () => {
    for (const [語, 目印] of 見附) {
      const 群の注 = Recommender.uiWordNoteJa(語);
      expect(群の注.length, 語).toBeGreaterThan(0);
      expect(群の注, 語).toContain(語);
      expect(群の注, `${語} の宛先`).toContain(目印);
      expect(件(rows, 語), `${語} は行を持つのに敎へて居らん事（第 337 回）`).toBe(0);
    }
  });

  it("行が出る兄弟語を敎へて居らん事（第 337 回）", () => {
    /* 檢査の品書（tests/built_site.ts は fixture ビルド）で行が出る物だけを選んで張る –
     * 實測の品書（public/）で數へた語を寫すと fixture では空振りになる（第 599 回）。 */
    const 当たる = ["特集号", "論文誌", "研究会"].filter((語) => 件(rows, 語) > 0);
    expect(当たる.length, "fixture の品書に行が出る兄弟語が無かつた").toBeGreaterThan(0);
    for (const 語 of 当たる) {
      expect(Recommender.uiWordNoteJa(語), `${語} に行が立つのに斷つて居る`).toBe("");
    }
    /* 斷りが出る語の方 – 彈いた語を增やしても他の群の斷りは其侪屆く（第 581 回）。
     * 「採択通知」は行が出る語なので斷りを持たん（第 337 回） – ここに載せん。 */
    for (const 語 of ["特集セッション", "座長"]) {
      expect(Recommender.uiWordNoteJa(語).length, 語).toBeGreaterThan(0);
    }
  });

  it("增やした語は導きの群に一度ずつ並ぶ（第 543 回 – 二つの群に載せず）", () => {
    const 源 = readFileSync("site/recommender.ts", "utf8");
    const i = 源.indexOf("const UI_WORD_GROUPS_JA");
    const 表 = 源.slice(i, 源.indexOf("\n  ];\n", i));
    for (const [語] of 見附) {
      const 數 = 表.split('"@R@"'.replace("@R@", 語)).length - 1;
      expect(數, `${語} が群に ${數} 回並んで居る`).toBe(1);
    }
  });
});

describe("公開料・目録の番号・採録・共催の後援・見方の打ち方（第 600 回）", () => {
  const rows = 品書();
  const 見附 = [
    ["OA料金", "費用の欄"],
    ["ISBN", "種別"],
    ["DOI", "種別"],
    ["採録", "数の統計"],
    ["共催申請", "主催・共催・後援・協賛"],
    ["後援申請", "主催・共催・後援・協賛"],
    ["協賛申請", "主催・共催・後援・協賛"],
    ["オンデマンド", "当日の様子"],
    ["閲覧期限", "当日の様子"],
  ] as const;

  it("打ち方を名前で呼び、其の筋の斷りに屆く", () => {
    for (const [語, 目印] of 見附) {
      const 群の注 = Recommender.uiWordNoteJa(語);
      expect(群の注.length, 語).toBeGreaterThan(0);
      expect(群の注, 語).toContain(語);
      expect(群の注, `${語} の宛先`).toContain(目印);
      expect(件(rows, 語), `${語} は行を持つのに敎へて居らん事（第 337 回）`).toBe(0);
    }
  });

  it("增やした語は導きの群に一度ずつ並び、隣の語の宛先を奪はん（第 543 回・第 581 回）", () => {
    const 源 = readFileSync("site/recommender.ts", "utf8");
    const i = 源.indexOf("const UI_WORD_GROUPS_JA");
    const 表 = 源.slice(i, 源.indexOf("\n  ];\n", i));
    for (const [語] of 見附) {
      const 數 = 表.split('"' + 語 + '"').length - 1;
      expect(數, `${語} が導きの群に ${數} 回並んで居る`).toBe(1);
    }
    /* multiword の群は語の続きの打ち方では默つた事（第 585 回）が、此處では其の方を受け取つた。
     * 元の短い語の斷りは其侪屆く事。 */
    expect(Recommender.uiWordNoteJa("共催")).toContain("主催・共催・後援・協賛");
    expect(Recommender.uiWordNoteJa("アーカイブ")).toContain("当日の様子");
    expect(Recommender.uiWordNoteJa("参加費")).toContain("費用の欄はありません");
    expect(Recommender.uiWordNoteJa("採択率")).toContain("数の統計");
  });
});

describe("窓口の打ち方と、性別・休暇・書誌の數の内譯（第 601 回）", () => {
  const rows = 品書();
  const 見附 = [
    ["問い合わせ", "問い合わせ先、相談の窓口"],
    ["問い合わせ先", "問い合わせ先、相談の窓口"],
    ["相談", "問い合わせ先、相談の窓口"],
    ["相談窓口", "問い合わせ先、相談の窓口"],
    ["窓口", "問い合わせ先、相談の窓口"],
    ["事務局", "問い合わせ先、相談の窓口"],
    ["ハラスメント相談", "問い合わせ先、相談の窓口"],
    ["女性", "募集対象"],
    ["男性", "募集対象"],
    ["ジェンダー", "募集対象"],
    ["女性限定", "募集対象"],
    ["男性限定", "募集対象"],
    ["学生限定", "募集対象"],
    ["若手限定", "募集対象"],
    ["産休", "あなたの所属で決まる話"],
    ["育休", "あなたの所属で決まる話"],
    ["育児", "あなたの所属で決まる話"],
    ["介護休", "あなたの所属で決まる話"],
    ["インパクトファクター", "数の統計"],
    ["影響度", "数の統計"],
    ["引用数", "数の統計"],
    ["被引用数", "数の統計"],
    ["掲載誌", "種別"],
    ["募集要項", "原稿の書式"],
    ["プロポーザル", "運営と手続き"],
  ] as const;

  it("打ち方を名前で呼び、其の筋の斷りに屆く", () => {
    for (const [語, 目印] of 見附) {
      const 群の注 = Recommender.uiWordNoteJa(語);
      expect(群の注.length, 語).toBeGreaterThan(0);
      expect(群の注, 語).toContain(語);
      expect(群の注, `${語} の宛先`).toContain(目印);
      expect(件(rows, 語), `${語} は行を持つのに敎へて居らん事（第 337 回）`).toBe(0);
    }
  });

  it("增やした語は導きの群に一度ずつ並び、元の短い語の宛先は其侪屆く（第 543 回・第 581 回）", () => {
    const 源 = readFileSync("site/recommender.ts", "utf8");
    const i = 源.indexOf("const UI_WORD_GROUPS_JA");
    const 表 = 源.slice(i, 源.indexOf("\n  ];\n", i));
    for (const [語] of 見附) {
      const 數 = 表.split('"' + 語 + '"').length - 1;
      expect(數, `${語} が導きの群に ${數} 回並んで居る`).toBe(1);
    }
    expect(Recommender.uiWordNoteJa("傍聴")).toContain("募集対象");
    expect(Recommender.uiWordNoteJa("単位認定")).toContain("あなたの所属で決まる話");
    expect(Recommender.uiWordNoteJa("採択率")).toContain("数の統計");
    expect(Recommender.uiWordNoteJa("学会誌")).toContain("種別");
    expect(Recommender.uiWordNoteJa("投稿規定")).toContain("原稿の書式");
    expect(Recommender.uiWordNoteJa("特集セッション")).toContain("運営と手続き");
  });

  it("窓口の斷りは行の詳細の公式ページへ導く（噓を書かん – 第 588 回）", () => {
    const 注 = Recommender.uiWordNoteJa("相談窓口");
    expect(注).toContain("公式ページ");
    /* 全行が繋ぎ先を持つ事實に立つ案内なので、其の事實を檢査でも見る（第 588 回 – 700/700）。 */
    const 品 = JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")) as unknown as {
      conferences: Array<{ link?: string }>;
    };
    const 行々 = 品.conferences;
    const 持つ = 行々.filter((行) => (行.link ?? "").trim().length > 0).length;
    expect(持つ).toBe(行々.length);
    expect(行々.length).toBeGreaterThan(0);
  });
});

describe("言い回しの後に名詞を続ける打ち方（第 602 回）", () => {
  const rows = 品書();

  it("言い回しの後に催し物・支援の名を続けても斷りが屆く", () => {
    for (const [語, 目印] of [
      ["旅費が出る支援", "旅費"],
      ["共催してもらえるか", "共催"],
      ["発表者一人何本まで", "発表者"],
      ["スライドは英語？", "録画"],
      ["次回いつ開かれる", "日付で絞る"],
      ["締切が延びた", "延長"],
    ] as const) {
      const 注 = Recommender.uiWordNoteJa(語);
      expect(注.length, 語).toBeGreaterThan(0);
      expect(注, `${語} の宛先`).toContain(目印);
    }
  });

  it("物の名で無く内容語を續ける打ち方は寄せない（第 362 回 – 靜かに廣げん）", () => {
    /* `参加費が高い会議` `旅費の出る学会で無い物` のやうに、助詞と形容詞で續ける打ち方は
     * 其の名前單體での絞り込みを信じる人なので、斷りを被せん（實測 – 品書 155 問のうち
     * 行の出方 126 問の內譯は不變）。 */
    expect(Recommender.uiWordNoteJa("参加費が高い")).toBe("");
    expect(Recommender.uiWordNoteJa("費用が安い会議")).toBe("");
  });

  it("表が實は持つ値と、他の表が持つ条目を導きに據へん（第 588 回・第 484 回）", () => {
    /* `オンライン` は參加形式の印『オンライン参加可』として實測 24 行が出る – 斷りを立てれば噓。 */
    expect(Recommender.uiWordNoteJa("オンライン")).toBe("");
    expect(rows.length).toBeGreaterThan(0);
    /* `来年度末` は其の方で 13 行絞れる – 「絞り込めません」を並べん（第 484 回の決まり）。 */
    expect(Recommender.uiWordNoteJa("来年度末")).toBe("");
    /* `いつ開催` は會期への寄せ先が既に持つ – 導きの語尾に二度據へん（第 602 回で彈かれた）。 */
    expect(Recommender.uiWordNoteJa("いつ開催")).toBe("");
  });
});

describe("締切が近い言い方と並びの打ち方の續き（第 604 回）", () => {
  const rows = 品書();
  const 見附 = [
    ["締切が迫っている", "では絞りません"],
    ["締切が迫る", "では絞りません"],
    ["最近締切", "では絞りません"],
    ["締切が近い会議", "では絞りません"],
    ["締切が近づいている", "では絞りません"],
    ["並びかえ", "列の見出し"],
    ["並びかえる", "列の見出し"],
    ["近い順に", "列の見出し"],
    ["早い順に", "列の見出し"],
    ["遅い順に", "列の見出し"],
    ["新しい順に", "列の見出し"],
    ["古い順に", "列の見出し"],
    ["順に表示", "列の見出し"],
  ] as const;

  it("續きの打ち方も同じ筋の斷りに屆く", () => {
    for (const [語, 目印] of 見附) {
      const 注 = Recommender.uiWordNoteJa(語);
      expect(注.length, 語).toBeGreaterThan(0);
      expect(注, 語).toContain(語);
      expect(注, `${語} の宛先`).toContain(目印);
    }
  });

  it("幅を言つた打ち方は斷らん（第 484 回）・曖昧な言い方だけ斷つ", () => {
    /* 畫面のボタンと通る語は在る – 「今週の締切」「来週の締切」は其の方で絞れるので斷らんで居る。 */
    for (const 語 of ["今週の締切", "来週の締切", "明日の締切"]) {
      expect(Recommender.uiWordNoteJa(語), 語).toBe("");
    }
    /* 斷りの文は通る打ち方を名指す – 噓の道を書かん為に見出しの語をそのまま載せる。 */
    const 注 = Recommender.uiWordNoteJa("最近締切");
    expect(注).toContain("今週");
    expect(注).toContain("来週");
  });

  it("增やした語は導きの群に一度ずつ並ぶ（第 543 回）", () => {
    const 源 = readFileSync("site/recommender.ts", "utf8");
    const i = 源.indexOf("const UI_WORD_GROUPS_JA");
    const 表 = 源.slice(i, 源.indexOf("\n    },\n  ];\n", i));
    for (const [語] of 見附) {
      const 數 = 表.split('"' + 語 + '"').length - 1;
      expect(數, `${語} が導きの群に ${數} 回並んで居る`).toBe(1);
    }
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe("前もって・いつまでの幅と審査の期間の續き（第 606 回）", () => {
  const rows = 品書();
  const 見附 = [
    ["前もって", "曖昧な幅"],
    ["前もってどれくらい", "曖昧な幅"],
    ["前もって何日", "曖昧な幅"],
    ["締切はいつまで", "曖昧な幅"],
    ["審査期間は何日", "期間の欄"],
    ["査読はいつからいつまで", "期間の欄"],
    ["投稿はいつからいつまで", "期間の欄"],
  ] as const;

  it("續きの打ち方も同じ筋の斷りに屆く", () => {
    for (const [語, 目印] of 見附) {
      const 注 = Recommender.uiWordNoteJa(語);
      expect(注.length, 語).toBeGreaterThan(0);
      expect(注, 語).toContain(語);
      expect(注, `${語} の宛先`).toContain(目印);
      expect(件(rows, 語), `"${語}" は行が出る打ち方を斷つた`).toBe(0);
    }
  });

  it("斷りは通る道を名指す（噓の道を書かん – 第 337 回）", () => {
    /* 曖昧な幅を斷る文は、畫面に在る『締切まで』の欄と四つの幅を名指して居る（實在のボタン）。 */
    const 幅 = Recommender.uiWordNoteJa("前もって");
    for (const 道 of ["7 日以内", "30 日以内", "90 日以内", "180 日以内"]) {
      expect(幅, `幅の斷りが ${道} を名指して居らん`).toContain(道);
    }
    /* 期間の欄を斷る文は、持つて居る段階の締切（審査の段の語）を行數添へて示す。 */
    const 期 = Recommender.uiWordNoteJa("査読はいつからいつまで");
    expect(期).toContain("締切");
  });

  it("增やした語は導きの群に一度ずつ並ぶ（第 552 回・第 543 回）", () => {
    const 源 = readFileSync("site/recommender.ts", "utf8");
    const i = 源.indexOf("const UI_WORD_GROUPS_JA");
    const 表 = 源.slice(i, 源.indexOf("\n    },\n  ];\n", i));
    for (const [語] of 見附) {
      expect(表.split('"' + 語 + '"').length - 1, `${語} が導きの群に二度並んで居る`).toBe(1);
    }
    /* 他の打ち方を壞して居らん事 – 其の方の語の寄せと行の出は不變（第 581 回・第 587 回）。 */
    expect(Recommender.queryTokenGroups("締切はいつまで", AT).length).toBeGreaterThan(0);
    expect(rows.length).toBeGreaterThan(0);
  });
});

/* 第 607 回 – 案内の語に**訪ねの語尾**を續けた形と、欄の名前その物で問はれた形。
 * 導きの群は既に其の方の語（`スポンサー` `介助者` `託児` `通訳` `ダブルブラインド` `座長`
 * `持ち時間` `名簿`）を持つて居たのに、語尾の白一覧（第 505 回・第 602 回）が「其の名前
 * その物 + 既知の語尾」しか見ん為、`スポンサーの募集` `介助者の参加` `通訳は有りますか` のやうに
 * 訪ね方だけが通らず默つて居た（實測 – 七十一文の打ち方の表で無言 27 文）。增やした語は
 * 品書の文本に一度も出ん物だけ（この檢査が張る – 第 337 回・第 588 回）。 */
describe("訪ねの語尾を續けた形（第 607 回）", () => {
  const rows = 品書();
  const 見附 = [
    ["スポンサーの募集", "スポンサー", "持っていません"],
    ["介助者の参加", "介助者", "持っていま"],
    ["子連れの参加", "子連れ", "持っていま"],
    ["託児のサービス", "託児", "持っていま"],
    ["座長への依頼", "座長", "持っていま"],
    ["名簿の公開", "名簿", "欄の名前"],
    ["インボイス対応", "インボイス", "費用の欄"],
    ["審査基準を教えて", "審査基準", "持っていません"],
    ["採点項目", "採点項目", "持っていません"],
    ["ダブルブラインドか", "ダブルブラインド", "持っていません"],
    ["自己引用の制限", "自己引用", "投稿の手続き"],
    ["再現性チェック", "再現性", "欄の名前"],
    ["研究倫理の記入", "研究倫理", "欄の名前"],
    ["データ公開の要求", "データ公開", "欄の名前"],
  ] as const;

  it("續きの訪ね方が、其の方の群の斷りに屆く", () => {
    for (const [文, 頭, 目印] of 見附) {
      const 注 = Recommender.uiWordNoteJa(文);
      expect(注.length, 文).toBeGreaterThan(0);
      expect(注, `${文} が打ち頭に在る語を名指して居らん（第 388 回）`).toContain(頭);
      expect(注, `${文} の宛先`).toContain(目印);
      expect(件(rows, 文), `"${文}" は行が出る打ち方を斷つた（第 337 回）`).toBe(0);
    }
  });

  it("斷つた欄は實は品書に在らん（噓の斷りを書かん證拠）", () => {
    for (const 語 of [
      "スポンサー",
      "介助者",
      "託児",
      "バリアフリー",
      "通訳",
      "インボイス",
      "ダブルブラインド",
    ]) {
      const 數 = rows.filter((行) => String(行).includes(語)).length;
      expect(數, `品書に ${語} を書く行が在る（斷りが噓になる）`).toBe(0);
    }
  });

  it("增やした語尾と語は表に一度ずつ（第 552 回・第 543 回）", () => {
    const 源 = readFileSync("site/recommender.ts", "utf8");
    const i = 源.indexOf("const UI_WORD_TAILS_JA = [");
    const 語尾 = 源.slice(i, 源.indexOf("\n  ];\n", i));
    for (const 語 of [
      "か",
      "ますか",
      "ですか",
      "でしょうか",
      "しますか",
      "を知りたい",
      "を教えて",
      "募集",
      "対応",
      "の可否",
      "の制限",
      "の扱い",
      "の発行",
      "は有りますか",
    ]) {
      expect(語尾.split('"' + 語 + '",').length - 1, `${語} が語尾の一覧に二度並んで居る`).toBe(1);
    }
    /* 檢索側の語尾の表（打ち方から語尾を落として廣げる側）には增へて居らん事 – 助詞の `か` を
     * 檢索側で落すのは沉默の廣げ直し（第 362 回）。この二つの表は似た名前の物が並ぶ為、
     * 據ゑ間違いを此處に張つた（第 607 回に實發生）。 */
    const b = 源.indexOf("const 剥ぐ語尾 = [");
    const 檢索側 = 源.slice(b, 源.indexOf("\n    ];\n", b));
    /* 檢索側の表は昔から訪ねの語尾（`か` `ますか` `知りたい` …）を持つ – ここで見るのは私の增やした
     * 續きが檢索側に漏れて居らん事だけ（漏れると打ち方が沉默に廣がる – 第 362 回）。 */
    for (const 語 of [
      "の参加",
      "の扱い",
      "の発行",
      "のテンプレート",
      "のサービス",
      "が知りたいです",
    ]) {
      expect(檢索側.includes('"' + 語 + '",'), `檢索側の語尾の表に ${語} が漏れた`).toBe(false);
      expect(語尾.includes('"' + 語 + '",'), `導きの語尾に ${語} が無い`).toBe(true);
    }
    const g = 源.indexOf("const UI_WORD_GROUPS_JA");
    const 群 = 源.slice(g, 源.indexOf("\n    },\n  ];\n", g));
    for (const 語 of [
      "自己引用",
      "再現性",
      "データ公開",
      "研究倫理",
      "インボイス",
      "学協会費",
      "審査基準",
      "採点項目",
    ]) {
      expect(群.split('"' + 語 + '"').length - 1, `${語} が導きの群に二度並んで居る`).toBe(1);
    }
  });

  it("行が出る打ち方の道を塞いで居らん（第 581 回・第 587 回）", () => {
    /* 試作の品書で行の出る打ち方（`査読` は fixtures に無い為、この表の全行に掛かる語で見る）。 */
    expect(件(rows, "締切"), "`締切` の行が落ちた").toBeGreaterThan(0);
    expect(件(rows, "介助者"), "增やした語が行を持つた").toBe(0);
    for (const 文 of ["締切", "オンライン", "8月"]) {
      expect(
        件(rows, 文) === 0 || Recommender.uiWordNoteJa(文) === "" || 件(rows, 文) > 0,
        文,
      ).toBe(true);
    }
  });
});

describe("連体の「の」の後に案内の語が來る形（第 608 回）", () => {
  /* `uiWordContain` は案内の語が打ち方の**頭**に來る物だけ見る（第 505 回・第 602 回）ので、
   * 「別の語 + の + 案内の語」と打ち返す形が默つて居た（實測 – 七十一文の打ち方の表で
   * `発表の持ち時間` `参加登録者の名簿` が 0 件・無言 – 第 607 回）。其の方の群の斷りは其の方に
   * 在つたので、續く形を通しただけ（導く文は據ゑ替へず – 噓の説明は增へん、第 337 回）。*/
  const rows = 品書();
  const 見附: Array<[string, string]> = [
    ["発表の持ち時間", "持ち時間"],
    ["参加登録者の名簿", "名簿"],
    ["謝辞の記載", "謝辞"],
    ["招待講演の依頼", "招待講演"],
  ];
  it("後ろの語を名指す斷りが出る（第 388 回）", () => {
    for (const [文, 語] of 見附) {
      const 案内 = String(Recommender.uiWordNoteJa(文) || "");
      expect(案内, `「${文}」が默つて居る`).toContain(`「${語}」`);
      expect(件(rows, 文), `增やした道が行を出す打ち方になった ${文}`).toBe(0);
    }
  });
  it("前の語が案内の語を持つ時は讓る – 二つの斷りを乘せん（第 581 回）", () => {
    const 案内 = String(Recommender.uiWordNoteJa("査読期間の締切") || "");
    expect(案内, "斷りが默つた").toContain("査読期間");
    const 數 = (案内.match(/はこの表/g) || []).length;
    expect(數, `斷りが ${數} 個乘つた`).toBe(1);
  });
  it("行が出る打ち方には乘らない（第 337 回）", () => {
    for (const 文 of ["8月の締切", "セキュリティ", "オンライン参加"]) {
      expect(件(rows, 文) === 0 || Recommender.uiWordNoteJa(文) === "", 文).toBe(true);
    }
  });
  it("語の割りは變へて居らん（案内だけ – 第 362 回）", () => {
    /* 增やした道は `uiWordNoteJa` の中だけ – 打ち方の割り（檢索側）は觸つて居らん證拠として、
     * 同じ打ち方の群が其の方の語を要求したまゝ殘る事を見る（落として廣げて居らん）。*/
    const 群 = Recommender.queryTokenGroups("発表の持ち時間", AT);
    expect(群.length, "群が減つた").toBeGreaterThanOrEqual(2);
    expect(
      群.flat().some((語) => 語.includes("持ち時間")),
      "持ち時間の要求が消えた",
    ).toBe(true);
  });
});

describe("助詞で繋がれた受け身の訪ね方（第 610 回）", () => {
  /* 第 608 回の連體の道は「の」だけ見て、後ろの語が其侭案内の語の時だけ受けて居た。實測 –
   * 受け身の動詞で終る訪ね方（`論文が掲載される` `録画が保存される` `招待講演されますか`）は
   * 默つた儘だった（廿三文の受け身の表で無言 18 → 13 に殘つた內の内、此の内が其の方）。
   * 讓りの門を「前の語が群の語」から**頭の道が實際に受けるか**に作り直したのが其の方 –
   * `論文が掲載される` は残り `が掲載される` が語尾の一覧に無いので頭の道が受けれん。*/
  const rows = 品書();
  const 見附: Array<[string, string]> = [
    ["論文が掲載される", "掲載"],
    ["録画が保存される", "保存"],
    ["招待講演されますか", "招待講演"],
    ["動画は公開されますか", "動画"],
  ];
  it("後ろの語を名指す斷りが出る（第 388 回）", () => {
    for (const [文, 語] of 見附) {
      const 案内 = String(Recommender.uiWordNoteJa(文) || "");
      expect(案内, `「${文}」が默つて居る`).toContain(`「${語}」`);
    }
  });
  it("增やした語で行を出さん（案内だけ – 第 337 回）", () => {
    /* 『掲載』は品書に一度も出ん語なので斷りを出す – 出ない事の證拠として 0 件を張る。*/
    for (const 語 of ["掲載", "保存"]) {
      expect(件(rows, 語), `「${語}」で行が出て斷りが噓になった`).toBe(0);
    }
    expect(件(rows, "論文が掲載される")).toBe(0);
  });
  it("頭の道が受けれる時は讓る – 斷り一個（第 581 回）", () => {
    const 案内 = String(Recommender.uiWordNoteJa("査読期間の締切") || "");
    expect(案内, "斷りが默つた").toContain("査読期間");
    const 數 = (案内.match(/はこの表/g) || []).length;
    expect(數, `斷りが ${數} 個乘つた`).toBe(1);
  });
  it("行が出る語を案内の語に增やして居らん（第 337 回・第 512 回の棚卸し）", () => {
    /* 『公開』は實測 13 行 – 此れを「持っていません」の群に載せると斷りが噓になる（彈いた）。
     * 『保存』は別の群（書き出しの話）が既に持つて居たので二つ目に載せん（棚卸しが彈いた）。*/
    const 源 = readFileSync("site/recommender.ts", "utf8");
    const i = 源.indexOf("  const UI_WORD_GROUPS_JA");
    const 片 = 源.slice(i, 源.indexOf("\n    },\n  ];\n", i));
    for (const 語 of ["公開", "保存"]) {
      expect(
        片.split(`"${語}",`).length - 1,
        `「${語}」が案内の語に增えて居る`,
      ).toBeLessThanOrEqual(1);
    }
  });
});
