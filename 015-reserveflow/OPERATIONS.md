# 運用手順（OPERATIONS）

## 1. 構成
- Web サービス 1 つ（`npm start` = `node dist-server/server/index.js`）。起動時に DB マイグレーションを自動適用し、通知ワーカーを内蔵起動。
- PostgreSQL 16（`btree_gist` 拡張を使用。マイグレーションが `CREATE EXTENSION IF NOT EXISTS btree_gist` を実行するため、DB ユーザーに拡張作成権限が必要。主要マネージド PG は対応）。
- ヘルスチェック：`GET /api/health`（DB 疎通込み）。

## 2. 初回デプロイ（例：Render）※有料契約・本番公開は購入者が判断して実施
1. リポジトリを自分の GitHub に置く（`015-reserveflow` フォルダをルートにする、または Render の Root Directory に指定）。
2. Render で Postgres（Basic 以上）と Web Service を作成（`render.yaml` を参考。Region は Singapore）。
3. 環境変数（`.env.example` 参照）：`DATABASE_URL`、`APP_SECRET`（32 文字以上のランダム文字列）、`PUBLIC_BASE_URL`（https://〜）、
   `ALLOW_SIGNUP=true`（最初のオーナー登録後 `false` に戻す）、`NODE_ENV=production`。
4. デプロイ後 `/signup` でオーナー登録 → `ALLOW_SIGNUP=false` にして再デプロイ。
5. 事業者設定 → 営業時間 → リソース → サービス → スタッフ → 公開。
6. メール送信を有効化：送信サービス（例 Resend）でドメイン認証（SPF/DKIM）→ `EMAIL_DRIVER=smtp`、`SMTP_URL`、`EMAIL_FROM` を設定。
   設定前は通知は記録のみで送信されない（管理画面に警告表示）。
7. 自分宛てにテスト予約を1件入れ、確認メール・リマインド・キャンセルメールが届くことを確認。

Docker で動かす場合：`docker build -t reserveflow .` → `docker run -e DATABASE_URL=... -e APP_SECRET=... -e PUBLIC_BASE_URL=... -p 8787:8787 reserveflow`
（本リポジトリの開発環境には Docker デーモンがなく、イメージのビルドは **未検証**。同等手順 `npm ci → build → prune → start` は検証済み）。

## 3. 日常運用
- 通知失敗：ダッシュボードに件数表示 → 通知履歴で原因確認 → 「再送」。`unknown`（送信中に中断）は届いたか不明なので確認後に再送。
- 待機リスト：ダッシュボード/待機リストに「空きあり」が出たらお客様へ連絡し、新規予約から登録。
- ブロック：休み・半休・機材メンテは「休み・ブロック」。既存予約は自動キャンセルされないので警告一覧から個別対応。

## 4. バックアップ
- **アプリ内バックアップ**（CSV・バックアップ画面）：事業者単位 JSON。週 1 回以上ダウンロードし、安全な場所に保管（個人情報を含む）。
- **DB バックアップ**：マネージド PG の自動バックアップ/PITR を有効化（Render 有料 PG は PITR あり）。
  手動：`pg_dump --format=custom "$DATABASE_URL" > reserveflow-$(date +%F).dump`、復元：`pg_restore --clean --no-owner -d "$NEW_DATABASE_URL" file.dump`。
- **復元テスト**（推奨：月 1 回）：新環境（または同環境で新しい空の事業者）を作り、アプリ内バックアップを「復元」→ 予約数・顧客数・サービスが一致するか確認。
  自動テスト `tests/integration/data.test.ts` と E2E-7 で「空環境への復元一致」を検証済み。
- 復元は空の事業者にのみ可能。失敗時は何も変更されない（1 トランザクション）。復元後は予約ページが非公開になるので内容確認後に公開。

## 5. 更新（アップデート）
1. アプリ内バックアップ＋DB バックアップを取得。
2. 新バージョンをデプロイ（起動時にマイグレーション自動適用。マイグレーションは advisory lock で多重実行を防止）。
3. `/api/health` の version を確認し、テスト予約で動作確認。
4. PWA はサービスワーカーの版を更新しているため、利用者は次回起動時に新しい画面になる（反映しない場合はアプリを一度閉じて開き直す）。

## 6. 障害時
| 症状 | 確認 | 対処 |
|---|---|---|
| 画面が開かない | `/api/health` | DB 接続（DATABASE_URL, sslmode）・ホスティングのログ |
| 予約が確定できない（409） | 管理画面「新規予約」の「予約できるか確認」で理由表示 | 営業時間・勤務時間・ブロック・リソース・定員の設定 |
| メールが届かない | 通知履歴の状態/エラー | EMAIL_DRIVER/SMTP_URL/送信ドメイン認証、迷惑メール |
| 429 が多い | 同一 IP からの大量アクセス | 共有 IP の可能性。必要ならレート制限値を調整（http.ts） |
| リマインドが出ない | 事業者設定のリマインド時間、ワーカー稼働（RUN_WORKER） | 予約時点で既にリマインド時刻を過ぎていた予約は対象外 |

## 7. サンプル事業者
`npm run seed:sample`（開発用）で架空の「Sample Studio」を作成。`is_sample=true` のためメールは送信されない。本番環境では作成しないか、確認後に削除（DB から business を削除）すること。

## 8. 外部 Cron を使う場合（任意）
Web プロセスのワーカーを止める（`RUN_WORKER=false`）場合、`npm run jobs:run` を 1〜5 分間隔で実行。ワーカーと同時に動いても二重送信しない。
