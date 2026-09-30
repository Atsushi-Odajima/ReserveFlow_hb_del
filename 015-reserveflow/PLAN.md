# ReserveFlow（商品 #015）開発計画

> 予約・顧客・受付・リマインド管理。小規模サービス業が「空いている時間だけをお客様に見せて予約を受け付け、
> 予約内容・事前質問・来店状況・キャンセル・次回予約まで1か所で管理」するための Web アプリ。

## 1. スコープ

### 中心業務
サービス登録 → 営業時間/受付可能時間 → 公開予約ページ → 顧客が空き枠選択 → 事前質問 → 予約確定 →
リマインド → 来店/実施 → 完了/キャンセル/無断欠席 → 顧客履歴 → 次回予約。

### 他商品との境界
| 商品 | 中心 | ReserveFlow で扱わない |
|---|---|---|
| #011 | 小商い分析 | 売上/利益分析 |
| #012 Freelance Desk | 案件/見積/請求 | 見積・請求書・入金照合 |
| #013 StockPilot | 在庫 | 在庫 |
| #014 Client Portal | 資料/制作物/承認 | 制作物バージョン承認 |

### 今回実装しない（主役にしない）
会計、請求書、見積、銀行入金照合、在庫、制作物承認、EC、POS、医療診療予約/電子カルテ、オンライン決済、SMS、
LINE API、Google/Outlook 双方向同期、AI 予約受付/需要予測/自動シフト、高度 CRM、ポイント、回数券、
サブスク課金、多店舗チェーン、給与/勤怠。**機能数より予約エンジンの正確性を優先。**

## 2. 技術構成（決定）

| 層 | 採用 | 理由 |
|---|---|---|
| 言語 | TypeScript（サーバー・画面共通） | 型で予約ロジックの取り違えを防ぐ |
| サーバー | Node.js 22 + Fastify 5 | 軽量・安定・MIT。JSON スキーマ/フック/inject テストが容易 |
| DB | PostgreSQL 16（+ `btree_gist` 拡張） | `timestamptz`、トランザクション、排他制約（EXCLUDE）で二重予約を DB レベルでも防止 |
| DB アクセス | `pg`（パラメータ化クエリのみ、ORM なし） | SQL を明示し、ロック/制約を正確に制御 |
| 日時 | Luxon（IANA タイムゾーン） | DST を含む壁時計⇔瞬間の変換 |
| 検証 | Zod | API 入力の厳格な検証 |
| 画面 | React 19 + React Router 7 + Vite 8 | 公開予約ページと管理画面を1つの SPA で提供 |
| PWA | 手書き Service Worker + Web App Manifest | キャッシュ範囲を明示的に限定するため |
| メール | nodemailer（SMTP）/ `log` ドライバ | SMTP なら Resend/SES/SendGrid/Postmark 等どれでも可。既定は送信しない `log` |
| Job | アプリ内ワーカー（1分間隔）＋ CLI（外部 Cron 用） | `FOR UPDATE SKIP LOCKED` とユニークキーで重複送信防止 |
| テスト | Vitest（単体/結合/競合）、Playwright（E2E、PC/iPhone/Android エミュレーション） | |

認証はメール＋パスワード（scrypt）とサーバー側セッション（HttpOnly Cookie、DB 保存、CSRF トークン）。
顧客は **アカウント不要**。予約管理は高エントロピーの予約管理リンク（ハッシュのみ保存・期限・失効・再発行）。

## 3. フォルダ構成

```
015-reserveflow/
  src/shared/        画面・サーバー共通の型/定数
  src/server/        Fastify アプリ
    engine/          予約枠エンジン（純粋関数・DB 非依存）
    services/        予約作成/変更/キャンセル、通知、待機、繰り返し、CSV、バックアップ 等
    routes/          API（auth / admin / public / manage）
    jobs/            通知ワーカー・CLI
    db/migrations/   SQL マイグレーション
    seed/            サンプル事業者「Sample Studio」
  src/web/           React 画面（public = 顧客向け、admin = 管理）
  public/            manifest / sw.js / アイコン
  tests/unit         予約エンジン必須テスト 1〜20 ほか
  tests/integration  実 PostgreSQL での API・競合・分離・通知・バックアップテスト
  tests/e2e          Playwright E2E 1〜7
  tests/load         負荷用データ生成・計測
  buyer-docs/        購入者向け資料（.txt / CSV テンプレート）
```

## 4. Phase 計画

| Phase | 内容 | 完了条件 |
|---|---|---|
| 0 | 技術/料金/ライセンス確認、日時/タイムゾーン PoC、最小 PWA | TZ 単体テスト緑、manifest/SW 配信 |
| 1 | 認証、事業者、スタッフ権限、サービス、リソース | 結合テストで CRUD・権限・事業者分離 |
| 2 | 営業時間、例外、ブロック、予約枠エンジン | 必須エンジンテスト 1〜8,14,16〜20 緑 |
| 3 | 公開予約、顧客、事前質問、確定、競合防止 | テスト 9,10 緑（同時確定で1件のみ） |
| 4 | 変更、キャンセル、管理リンク、管理カレンダー、手動予約 | テスト 11,12,18 緑 |
| 5 | 通知/リマインド、当日受付、顧客履歴、次回予約 | テスト 15 緑 |
| 6 | 待機、定員制、繰り返し枠 | テスト 13 緑 |
| 7 | ダッシュボード、分析、CSV、ICS | CSV 注入対策テスト |
| 8 | セキュリティ、監査、バックアップ/復元、負荷/競合 | 復元テスト・負荷計測値を TEST_REPORT へ |
| 9 | E2E（PC/iPhone/Android）、アクセシビリティ、説明書、デプロイ準備、販売前チェック | RELEASE_CHECKLIST |

各 Phase 終了時に PROGRESS.md / NEXT_STEPS.txt / TEST_REPORT.md を更新し、途中から再開できるようにする。
未完成・未検証の項目は「完了」と書かない。

## 5. 人間の判断が必要なもの（勝手に行わない）
有料契約、実課金、本番公開、実顧客へのメール/SMS、実ユーザーデータの利用、秘密情報の使用。
