# Gates: release-readiness verification

Scope: Confirm the kamiyobi improvement plan (PRs #584-#595) is complete and the project is healthy.

## State gates

- [x] G1: No open PRs on the repository
  CHECK: gh pr list --state open --json number 2>&1 | head -1
  EXPECT: []
  EVIDENCE: []

- [x] G2: No open issues on the repository
  CHECK: gh issue list --state open --json number 2>&1 | head -1
  EXPECT: []
  EVIDENCE: []

- [x] G3: All recent CI runs are green
  CHECK: gh run list --limit 5 --json conclusion --jq '[.[].conclusion] | unique' 2>&1
  EXPECT: ["success"]
  EVIDENCE: ["success"]

- [x] G4: TypeScript typecheck passes
  CHECK: npm run typecheck 2>&1; echo "EXIT:$?"
  EXPECT: EXIT:0
  EVIDENCE: > tsc --noEmit && tsc --noEmit -p site/tsconfig.json | EXIT:0

- [x] G5: Biome lint passes (no files need fixing)
  CHECK: npm run check 2>&1 | tail -1
  EXPECT: No fixes applied.
  EVIDENCE: Checked 63 files in 65ms. No fixes applied.

- [x] G6: Core tests pass (226 tests across 4 files)
  CHECK: npx vitest run tests/health_gate.test.ts tests/build_golden.test.ts tests/merge.test.ts tests/recommendation.test.ts 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep "Tests"
  EXPECT: 226 passed (226)
  EVIDENCE: Tests  226 passed (226)

- [x] G7: All 12 PRs in the improvement series are merged
  CHECK: gh pr list --state merged --limit 12 --json number,title --jq '[.[].number]'
  EXPECT: [595,594,593,592,591,590,589,588,587,586,585,584]
  EVIDENCE: [595,594,593,592,591,590,589,588,587,586,585,584]

- [x] G8: Reverification manifest script runs without error
  CHECK: node scripts/reverification-manifest.ts 2>&1; echo "EXIT:$?"
  EXPECT: EXIT:0
  EVIDENCE: VerificationState is populated during the build pipeline. | EXIT:0

- [x] G9: Observation baseline has zero parse warnings
  CHECK: node -e "const h=JSON.parse(require('fs').readFileSync('data/source-observation-baseline.json','utf8'));console.log('count='+h.parse_warning_count)"
  EXPECT: count=0
  EVIDENCE: count=0

- [x] G10: No edition_conflicts in snapshot
  CHECK: node -e "const s=JSON.parse(require('fs').readFileSync('data/snapshot.json','utf8'));console.log('edition_conflicts='+(s.edition_conflicts||[]).length)"
  EXPECT: edition_conflicts=0
  EVIDENCE: edition_conflicts=0

- [x] G11: No uncommitted changes to tracked source files
  CHECK: git status --short 2>&1
  EXPECT: clean working tree for all tracked files
  EVIDENCE: no tracked files modified

- [x] G12: All 12 gates above pass
  EVIDENCE: 11/11 automated gates PASS as recorded above. G12 is the meta-gate confirming all others pass.
