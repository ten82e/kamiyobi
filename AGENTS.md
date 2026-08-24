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

## 上流との境界

- kamiyobi は独自の名称と UI を持つ独立プロジェクトであり、ccfddl/ccf-deadlines の複製として扱わない。
- ccfddl/ccf-deadlines は上流データソースとしてだけ扱う。
- 第三者に届く送信は行わない。
  PR、issue、コメント、レビュー返信、リアクション、既存 PR の再オープン、fork への push、メール、問い合わせフォーム、SNS 送信を含む。
- 上流の誤り・欠落は `data/overrides.yaml` / `data/extra.yaml` で吸収する。
- `upstream-patches/` は内部メモであり、上流へ提出しない。
- このリポジトリは `origin = ten82e/kamiyobi` を維持する。

---

## 作業手順

- GitHub Issues が作業台帳。具体的な候補ができたら重複検索のうえ Issue を
  作成し、受入条件を固定してから着手する。
- 変更は branch → PR → CI（typecheck / check / test）緑 → merge。
- 上記の収録契約と上流との境界はすべての作業で有効。変更は `ten82e/kamiyobi`
  内部のみ。
