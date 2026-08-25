#!/usr/bin/env zsh
set -euo pipefail

cd "${0:A:h}/.."

[[ ! -e .github/workflows/update.yml ]]
for workflow in ci.yml update-data.yml deploy.yml nightly.yml recommendation-bundle.yml; do
  [[ -f ".github/workflows/$workflow" ]]
done

while IFS= read -r use; do
  case "$use" in
    *"actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1"|\
    *"actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0"|\
    *"actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1"|\
    *"actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1"|\
    *"actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9 # v5.0.0"|\
    *"actions/deploy-pages@cd2ce8fcbc39b97be8ca5fce6e763baed58fa128 # v5.0.0"|\
    *"actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0"|\
    *"actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8 # v4.2.2") ;;
    *) print -u2 "unapproved workflow action: $use"; exit 1 ;;
  esac
done < <(rg '^\s*-\s+uses:' .github/workflows)

! rg -n 'continue-on-error|npm ci --ignore-scripts|@v[0-9]' .github/workflows
! rg -ni '\bpages\b|deploy-pages|upload-pages' .github/workflows/update-data.yml
rg -q 'branches: \[main\]' .github/workflows/deploy.yml
! rg -q 'workflow_dispatch' .github/workflows/deploy.yml
rg -Fq 'ref: ${{ github.sha }}' .github/workflows/deploy.yml
rg -q -- '--offline' .github/workflows/deploy.yml
rg -q 'automation/data-update' .github/workflows/update-data.yml
rg -q 'GH_TOKEN:' .github/workflows/update-data.yml
rg -q 'gh workflow run ci.yml --ref automation/data-update' .github/workflows/update-data.yml
rg -q 'attest-build-provenance' .github/workflows/deploy.yml
rg -q 'subject-path: public/publish.json' .github/workflows/deploy.yml
rg -q 'group: pages-main' .github/workflows/deploy.yml
rg -q 'cancel-in-progress: false' .github/workflows/deploy.yml
rg -q 'stale trigger; no build or deployment will run' .github/workflows/deploy.yml
rg -q 'workflow_run.head_sha' .github/workflows/deploy.yml
rg -q 'workflow_run.id' .github/workflows/deploy.yml
rg -Fq 'recommendation-bundle-${{ github.event.workflow_run.head_sha }}' .github/workflows/deploy.yml
rg -q 'real-paper-required-dev.json' .github/workflows/ci.yml .github/workflows/recommendation-bundle.yml
rg -q 'real-paper-negative.json' .github/workflows/ci.yml .github/workflows/recommendation-bundle.yml
! rg -q '^\s+paths:' .github/workflows/recommendation-bundle.yml
benchmark_line=$(rg -n 'Run full real-paper benchmark' .github/workflows/nightly.yml | cut -d: -f1)
seal_line=$(rg -n 'Seal recommendation bundle' .github/workflows/nightly.yml | cut -d: -f1)
upload_line=$(rg -n 'Upload immutable recommendation bundle' .github/workflows/nightly.yml | cut -d: -f1)
(( benchmark_line < seal_line && seal_line < upload_line ))

print workflow-policy-ok
