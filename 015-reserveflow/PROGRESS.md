# 進捗（PROGRESS）

最終更新：2026-09-30

| Phase | 内容 | 状態 | 備考 |
|---|---|---|---|
| 0 | 技術/料金/ライセンス確認、日時/TZ PoC、最小 PWA | ✅ 完了 | OPERATING_COSTS.md（一部「未確認」明記）、TZ/DST 単体テスト、manifest/SW |
| 1 | 認証、事業者、スタッフ権限、サービス、リソース | ✅ 完了 | scrypt・DB セッション・CSRF・招待・権限 |
| 2 | 営業時間、例外、ブロック、予約枠エンジン | ✅ 完了 | 必須エンジンテスト 1〜8,14,16〜20 |
| 3 | 公開予約、顧客、事前質問、確定、競合防止 | ✅ 完了 | advisory lock＋排他制約＋冪等キー、テスト 9,10 |
| 4 | 変更、キャンセル、管理リンク、管理カレンダー、手動予約 | ✅ 完了 | テスト 11,12,18、日/週/月/予定リスト |
| 5 | 通知/リマインド、当日受付、顧客履歴、次回予約 | ✅ 完了 | テスト 15、SMTP ローカル送信 |
| 6 | 待機、定員制、繰り返し枠 | ✅ 完了 | テスト 13、週次/月次ルール |
| 7 | ダッシュボード、分析、CSV、ICS | ✅ 完了 | CSV 注入対策、取込プレビュー/二重取込防止、ICS 出力 |
| 8 | セキュリティ、監査、バックアップ/復元、負荷/競合 | ✅ 完了 | 20万予約で計測、性能問題（93秒）を発見し修正 |
| 9 | 実機E2E、アクセシビリティ、説明書、デプロイ、販売前チェック | ⚠️ 一部未検証 | E2E はエミュレーション（Chromium）で全成功、axe 違反0、説明書・デプロイ設定完成。**実機確認・本番デプロイ・実メール到達は未実施（人間の判断/作業が必要）** |

未完成 Phase があるため「全体完成」ではなく「実装・自動検証は完了、実機/本番確認待ち」の状態。

## 主な成果物
- アプリ：`src/`（server / web / shared）、`public/`（PWA）
- テスト：`tests/unit`（21）、`tests/integration`（41）、`tests/e2e`（11 実行）、`tests/load`
- 開発資料：PLAN, DATA_MODEL, BOOKING_ENGINE, TIMEZONE_RULES, DECISIONS, SECURITY, NOTIFICATIONS, OPERATIONS, OPERATING_COSTS, DEVELOPMENT, TEST_REPORT, RELEASE_CHECKLIST, NEXT_STEPS.txt
- 購入者資料：`buyer-docs/`
- デプロイ：Dockerfile, render.yaml, .env.example
