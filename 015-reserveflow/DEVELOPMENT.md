# 開発手順（DEVELOPMENT）

購入者（事業者）には開発環境は不要です。以下は開発者・保守者向け。

## 必要なもの
- Node.js 22 以上、PostgreSQL 16（`btree_gist` 拡張）
- E2E テストのみ：Playwright の Chromium（`@playwright/test` 1.56.1。ブラウザは環境に合わせて用意）

## セットアップ
```bash
cd 015-reserveflow
npm ci
createdb reserveflow_dev && createdb reserveflow_test   # ユーザー/パスワードは DATABASE_URL に合わせる
npm run migrate:dev              # 既定 DATABASE_URL=postgres://reserveflow:reserveflow@127.0.0.1:5432/reserveflow_dev
npm run seed:sample              # 架空の Sample Studio（owner@sample.invalid / sample-password-123）
npm run dev                      # API :8787（tsx watch）＋ 画面 :5173（Vite, /api をプロキシ）
```
画面: http://127.0.0.1:5173/login 、予約ページ: http://127.0.0.1:5173/book/sample-studio

## コマンド
| コマンド | 内容 |
|---|---|
| `npm run build` | 画面（dist-web）とサーバー（dist-server）をビルド |
| `npm start` | 本番起動（マイグレーション自動適用・ワーカー内蔵） |
| `npm run typecheck` | サーバー/画面の型チェック |
| `npm test` | 単体（予約エンジン）＋結合（実 PostgreSQL、`TEST_DATABASE_URL` 既定 reserveflow_test）。**テスト DB のスキーマを削除して作り直す** |
| `npm run test:e2e` | Playwright（build 済みの本番サーバーを reserveflow_e2e で起動。DB は毎回初期化） |
| `npm run load:seed` / `npm run load:run` | 負荷試験データ（reserveflow_load）生成／計測（サーバーを別途 :8791 で起動） |
| `npm run icons` | PWA アイコン PNG を生成（Chromium 使用） |
| `npm run jobs:run` | 通知等のジョブを 1 回実行（本番ビルド） |

## ディレクトリ
PLAN.md §3 参照。予約ロジックは `src/server/engine/`（DB 非依存・純粋関数）と `src/server/services/bookings.ts`（トランザクション）に集約。

## 開発ルール
- 空き判定を変更する場合は必ず `engine/availability.ts` の `checkSlot` を修正し、一覧と確定の両方に効くようにする（別ロジックを作らない）。
- 予約の占有を増やす処理は `lockBusiness()` を取ってから再検証する。
- 管理 API は `requireMember/requireOwner` → `business_id` 条件付きクエリ。参照 ID は `assertOwned` で検証。
- 新しい設定項目・テーブルを追加したら `services/backup.ts` の対象と DATA_MODEL.md を更新。
- 各 Phase 終了時に PROGRESS.md / NEXT_STEPS.txt / TEST_REPORT.md を更新。

## 環境変数
`.env.example` を参照。`RATE_LIMIT_SCALE` は自動テスト専用（本番は 1）。
