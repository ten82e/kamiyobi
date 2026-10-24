import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { siteRuntime } from "./runtime_extract.ts";

it("directs availability questions to the actual ongoing-submission control without claiming an absence of journals", () => {
  const app = siteRuntime();
  const declarations = ["SELECTABLE_KINDS", "KIND_ALL_LABEL_JA"]
    .map((name) => {
      const declaration = new RegExp(`const ${name} = [^;]+;`).exec(app)?.[0];
      expect(declaration, name).toBeDefined();
      return declaration;
    })
    .join("\n");
  const start = app.indexOf('const kindSel = $("kind");');
  const end = app.indexOf('const rankSel = $("rank");', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const options: Array<{ value: string; textContent: string }> = [];
  new Function("document", "$", "KIND_LABEL", `${declarations}\n${app.slice(start, end)}`)(
    { createElement: () => ({}) },
    () => ({ appendChild: (option: (typeof options)[number]) => options.push(option) }),
    Recommender.kindLabelTable(),
  );
  expect(options).toContainEqual({ value: "journal", textContent: "常時受付" });
  const template = readFileSync(new URL("../site/template.html", import.meta.url), "utf8");
  expect(template).toContain('<label for="kind">種別</label>');
  expect(template).toMatch(/<th\b[^>]*data-sort="rem"[^>]*>残り/);
  for (const query of ["まだ間に合う", "間に合わない", "今からでも間に合う", "遅れて提出"]) {
    const note = Recommender.uiWordNoteJa(query, false);
    const live = Recommender.uiWordLiveNoteJa(query);
    expect(note, query).toContain("『種別』で『常時受付』を選んで探せます");
    expect(note, query).toContain("受付状況は公式ページで確認してください");
    expect(note, query).toContain("検索語を消してから");
    expect(note, query).toContain("一覧の『残り』");
    expect(note, query).toContain("『過去の締切も表示』をオン");
    expect(live, query).toContain("常時受付は検索語を消して『種別』で探せます");
    expect(`${note}${live}`, query).not.toMatch(
      /収録に(?:はなく|ありません)|常時受付[』」]は出ません/,
    );
    expect([...live].length, query).toBeLessThanOrEqual(60);
  }
});
