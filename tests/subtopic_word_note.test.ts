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
    ["GPU", "CUDA", "Kubernetes", "OpenMP", "連合学習"].forEach((語) => {
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

  it("弹いた語と空白を含む語を、群の一覽に混ぜん", () => {
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
    /* 弹いた語 – 其の方で行が出る語と、打ち方が曖昧な語を群に混ぜん。 */
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
    ["当日券", "正規登録", "グループ割", "無料参加", "聴講無料", "服装", "持ち物", "荷物", "手荷物", "両替", ].forEach((w) => {
      expect(Recommender.uiWordNoteJa(w).length).toBeGreaterThan(0);
      expect(件(rows, w)).toBe(0);
    });
  });
it("機材とリハの語も默らん（第 558 回）", () => {
    const rows = 品書();
    ["プロジェクター", "電源", "有線LAN", "機材", "椅子", "配布物", "会場レイアウト", "搬入", "搬出", "設営", "解体", "登壇リハ", "事前リハ", ].forEach((w) => {
      expect(Recommender.uiWordNoteJa(w).length).toBeGreaterThan(0);
      expect(件(rows, w)).toBe(0);
    });
  });
it("交流と採用關連の語も默らん（第 559 回）", () => {
    const rows = 品書();
    ["名刺交換", "ネットワーキング", "情報交換", "採用", "求人", "リクルート", "企業説明", "産学交流", "連携提案", ].forEach((w) => {
      expect(Recommender.uiWordNoteJa(w).length).toBeGreaterThan(0);
      expect(件(rows, w)).toBe(0);
    });
  });
it("發表の順と時間の語も默らん（第 561 回）", () => {
    const rows = 品書();
    ["発表順", "セッション順", "登壇時間", ].forEach((w) => {
      expect(Recommender.uiWordNoteJa(w).length).toBeGreaterThan(0);
      expect(件(rows, w)).toBe(0);
    });
  });
it("採否の照會と登錄の變更、金の明細の語も默らん（第 564 回）", () => {
    const rows = 品書();
    ["採否の照会", "採択証明", "掲載証明", "登録内容の変更", "口座情報", "名義変更", "明細書", ].forEach((w) => {
      expect(Recommender.uiWordNoteJa(w).length).toBeGreaterThan(0);
      expect(件(rows, w)).toBe(0);
    });
  });
it("會員に關する語も默らん（第 565 回）", () => {
    const rows = 品書();
    ["個人会員", "法人会員", "会員費", "入会手続", "退会", "会員番号", "会員証", "二重会員", "会員種別の変更", "非会員参加", "会員以外", ].forEach((w) => {
      expect(Recommender.uiWordNoteJa(w).length).toBeGreaterThan(0);
      expect(件(rows, w)).toBe(0);
    });
  });
it("集録の類と配信の語も默らん（第 567 回）", () => {
    const rows = 品書();
    ["予稿集", "プログラム集", "講演集録", "抄録集", "プロシーディングス購読", "生配信", "アーカイブ配信", "見逃し配信", "後日視聴", ].forEach((w) => {
      expect(Recommender.uiWordNoteJa(w).length).toBeGreaterThan(0);
      expect(件(rows, w)).toBe(0);
    });
  });
it("證明と郵送の語も默らん（第 568 回）", () => {
    const rows = 品書();
    ["在學証明", "在籍証明", "指導教員", "業績", "研究実績", "発表実績", "簡易書留", "書留", "消印", ].forEach((w) => {
      expect(Recommender.uiWordNoteJa(w).length).toBeGreaterThan(0);
      expect(件(rows, w)).toBe(0);
    });
  });
it("日帰りと宿の打ち方も默らん（第 569 回）", () => {
    const rows = 品書();
    ["宿泊無し", "日帰り", "近場", ].forEach((w) => {
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
    ["総会", "理事会", "支部", "地域支部", "幹事", "役員の選出", "投票", "電子投票", "委任状", "議事録", ].forEach((w) => {
      expect(Recommender.uiWordNoteJa(w).length).toBeGreaterThan(0);
      expect(件(rows, w)).toBe(0);
    });
  });
it("出版倫理と別刷りの語も默らん（第 573 回）", () => {
    const rows = 品書();
    ["リジェクト", "別投稿", "転載", "二重投稿", "自己援用", "プレプリント", "arXiv投稿", "出版倫理", "利益相反", ].forEach((w) => {
      expect(Recommender.uiWordNoteJa(w).length).toBeGreaterThan(0);
      expect(件(rows, w)).toBe(0);
    });
  });
it("旅と送金の語も默らん（第 574 回）", () => {
    const rows = 品書();
    ["査証", "パスポート", "在外参加", "時差", "送金", "外貨", "源泉徴収", "個人番号", ].forEach((w) => {
      expect(Recommender.uiWordNoteJa(w).length).toBeGreaterThan(0);
      expect(件(rows, w)).toBe(0);
    });
  });
it("撮りと會場の裏方の語も默らん（第 575 回）", () => {
    const rows = 品書();
    ["撮影", "写真撮影", "報道", "取材", "記者", "プレス", "USBメモリ", "前日入り", "後片付け", ].forEach((w) => {
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
    ["減免", "免除", "助成", "出張支援", "若手支援", ].forEach((w) => {
      expect(Recommender.uiWordNoteJa(w).length).toBeGreaterThan(0);
      expect(件(rows, w)).toBe(0);
    });
  });
  it("發表の言語に關する語も默らん（第 579 回）", () => {
    const rows = 品書();
    ["日本語発表", "英語必須", "発音", "翻訳サービス", "英語支援", "筆談", ].forEach((w) => {
      expect(Recommender.uiWordNoteJa(w).length).toBeGreaterThan(0);
      expect(件(rows, w)).toBe(0);
    });
  });
});
