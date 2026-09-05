/**
 * kind_of: SPEC.md section 3.3, against the upstream type names listed in 1.1 / 1.2.
 */

import { describe, expect, it } from "vitest";
import { KINDS, kindOf, refineKindWithLabel } from "../src/model.ts";

const KINDS_SET = new Set(KINDS);

// A transcription of the SPEC.md 3.3 table.
const SPEC_TABLE: Array<[string, string]> = [
  ["deadline", "paper"],
  ["paper", "paper"],
  ["submission", "paper"],
  ["full_paper", "paper"],
  ["abstract_deadline", "abstract"],
  ["abstract deadline", "abstract"],
  ["abstract", "abstract"],
  ["supplementary", "supplementary"],
  ["notification", "notification"],
  ["first-notification", "notification"],
  ["final-notification", "notification"],
  ["camera_ready", "camera_ready"],
  ["camera-ready", "camera_ready"],
  ["camera_ready_deadline", "camera_ready"],
  ["camera", "camera_ready"],
  ["final_paper", "camera_ready"],
  ["final_submission", "camera_ready"],
  ["revision-deadline", "camera_ready"],
  ["rebuttal_start", "rebuttal_start"],
  ["rebuttal_end", "rebuttal_end"],
  ["rebuttal", "rebuttal_end"],
  ["rebuttal_and_revision", "rebuttal_end"],
  ["author_response", "rebuttal_end"],
  ["review_release", "review_release"],
  ["registration", "registration"],
  ["reviewer_registration", "registration"],
  ["commitment_deadline", "registration"],
  ["withdrawal", "other"],
];

const UPSTREAM_TYPES = SPEC_TABLE.map(([raw]) => raw);

describe("kind_of", () => {
  it.each(UPSTREAM_TYPES)("every upstream type %s maps into the ten kinds", (raw) => {
    expect(KINDS_SET.has(kindOf(raw))).toBe(true);
  });

  it.each(SPEC_TABLE)("explicit mapping %s -> %s", (raw, expected) => {
    expect(kindOf(raw)).toBe(expected);
  });

  it("ccfddl main deadline key is a paper deadline", () => {
    expect(kindOf("deadline")).toBe("paper");
  });

  it("supplementary is not collapsed into paper", () => {
    expect(kindOf("supplementary")).toBe("supplementary");
    expect(kindOf("supplementary")).not.toBe(kindOf("paper"));
  });

  it("rebuttal start and end are distinct", () => {
    expect(kindOf("rebuttal_start")).not.toBe(kindOf("rebuttal_end"));
    expect(["rebuttal_start", "rebuttal_end"]).not.toContain(kindOf("review_release"));
  });

  it.each(["withdrawal", "banquet", "", "something-else"])(
    "unmapped types %j fall back to other",
    (raw) => {
      expect(kindOf(raw)).toBe("other");
    },
  );

  it("mapping is total and pure", () => {
    for (const raw of [...UPSTREAM_TYPES, "???", "PAPER"]) {
      expect(kindOf(raw)).toBe(kindOf(raw));
      expect(KINDS_SET.has(kindOf(raw))).toBe(true);
    }
  });

  it("declared kinds match the spec table", () => {
    expect(KINDS_SET).toEqual(
      new Set([
        "abstract",
        "paper",
        "supplementary",
        "notification",
        "camera_ready",
        "rebuttal_start",
        "rebuttal_end",
        "review_release",
        "registration",
        "other",
      ]),
    );
  });
});

describe("refineKindWithLabel (#516)", () => {
  it("demotes generic-type paper rows whose label names a non-paper track", () => {
    expect(refineKindWithLabel("paper", "Posters deadline")).toBe("other");
    expect(refineKindWithLabel("paper", "Art Gallery deadline")).toBe("other");
    expect(refineKindWithLabel("paper", "Student Volunteers Applications deadline")).toBe("other");
    expect(refineKindWithLabel("paper", "Technical Workshops deadline")).toBe("other");
    expect(refineKindWithLabel("paper", "Student Research Competition deadline")).toBe("other");
    expect(refineKindWithLabel("paper", "Rising Stars Award applications")).toBe("other");
    expect(refineKindWithLabel("paper", "Appy Hour deadline")).toBe("other");
    expect(refineKindWithLabel("paper", "Real-Time Live! deadline")).toBe("other");
    expect(
      refineKindWithLabel(
        "paper",
        "Talks, Production Sessions, Panels, Courses, Educator Forum deadline",
      ),
    ).toBe("other");
  });

  it("keeps genuine paper rows", () => {
    expect(refineKindWithLabel("paper", "Paper submission deadline")).toBe("paper");
    expect(refineKindWithLabel("paper", "Full research papers submission deadline")).toBe("paper");
    // 論文本体トラック (proceedings あり) は誤爆させない
    expect(refineKindWithLabel("paper", "Art Papers deadline")).toBe("paper");
    expect(refineKindWithLabel("paper", "")).toBe("paper");
    expect(refineKindWithLabel("paper", null)).toBe("paper");
  });

  it("does not touch non-paper kinds", () => {
    expect(refineKindWithLabel("abstract", "Posters deadline")).toBe("abstract");
    expect(refineKindWithLabel("notification", "Posters deadline")).toBe("notification");
    expect(refineKindWithLabel("other", "anything")).toBe("other");
  });

  it("abstract rows are never demoted (abstract tracks are small by nature)", () => {
    expect(refineKindWithLabel("abstract", "Poster abstract submission")).toBe("abstract");
  });

  it("explicitly declared paper type is never demoted by label vocabulary (#520)", () => {
    // overrides.yaml / extra.yaml の明示的な kind:paper は公式裏取り済みの決定。
    // msn 2026 Industry Paper and Poster Submission（Industry papers も proceedings 論文）。
    expect(refineKindWithLabel("paper", "Industry Paper and Poster Submission", "paper")).toBe(
      "paper",
    );
    expect(refineKindWithLabel("paper", "Posters deadline", "paper")).toBe("paper");
    // 一方、汎用語 (deadline/submission/空) のときは従来どおり格下げされる。
    expect(refineKindWithLabel("paper", "Posters deadline", "deadline")).toBe("other");
    expect(refineKindWithLabel("paper", "Posters deadline", "")).toBe("other");
    expect(refineKindWithLabel("paper", "Posters deadline")).toBe("other");
    // ccfddl の paper_deadline / submission_deadline キーも汎用語扱い。
    expect(refineKindWithLabel("paper", "Posters Track", "submission_deadline")).toBe("other");
  });
});
