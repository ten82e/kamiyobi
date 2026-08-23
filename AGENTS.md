# kamiyobi

HPC・ネットワーク・システム・AI・セキュリティ会議・穴場ワークショップの締切を ICS/JSON/Pages で自動探知・配信する。
実装の正は `SPEC.md`。購読手順は `README.md`。

## 検証

```sh
npm ci
npm run typecheck
npm run check       # biome lint
npm test            # vitest
node src/cli.ts build --out public --offline --cache .cache --now 2026-08-09T00:00:00Z
```

- `public/` は `.gitignore`（CI が生成）。`data/snapshot.json` は健全な online ビルドが更新する。
- offline ビルドは snapshot を書かない（fixtures 汚染防止）。実キャッシュ成果を snapshot に載せるときは手でコピー。

## 収録の契約

- `taxonomy.*.venues` に書いた会議は **rank_filter を迂回して必ず残る**（名指し＝収録意思）。
- 上流に無い会議は `data/extra.yaml`。上流の誤りは `data/overrides.yaml`。
- 締切の推測はしない。公式で裏が取れた日付だけ。

## 禁止（ユーザー指示 2026-08-11）

- **https://ccfddl.com/ をフォーク・複製（パクり）するブランチは作らない**。kamiyobi は
  独自名・独自 UI の独立プロジェクト。ccfddl/ccf-deadlines の GitHub リポジトリは
  「上流データソース」としてだけ扱う。**第三者に届く送信は一切絶対禁止** — 上流に限らず、
  PR・issue・コメント・レビュー返信・リアクション・既存 PR の再オープン・fork
  （ten82e/ccf-deadlines）への push・メール・問い合わせフォーム・SNS すべて
  （2026-08-12 指示「還元 PR とかで迷惑かけるのは絶対にやめて」。要確認ですらない。
  #1629〜#1633 の無断連投を受けての改定）。上流の誤り・欠落は `data/overrides.yaml` /
  `data/extra.yaml` で自前吸収する。`upstream-patches/` は過去の記録として残すだけで、
  新規に送ることはない。
- フォーク用途の `~/ccf-deadlines` は停止済み・放置（触らない・コミットしない）。
- このリポジトリは `origin = ten82e/kamiyobi`（フォークではない）を維持する。

## レッスン

`~/.hermes/skills/research/autonomous-research-loop/references/project-lessons/conf-deadlines.md`

---

## 作業手順

- GitHub Issues が作業台帳。具体的な候補ができたら重複検索のうえ Issue を
  作成し、受入条件を固定してから着手する。
- 変更は branch → PR → CI（typecheck / check / test）緑 → merge。
- 上記の収録契約・禁止節はすべての作業で有効。変更は `ten82e/kamiyobi`
  内部のみ。
