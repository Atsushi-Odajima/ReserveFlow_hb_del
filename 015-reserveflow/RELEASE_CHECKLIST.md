# 販売前チェックリスト（RELEASE_CHECKLIST）

凡例：✅ 開発側で確認済み／👤 人間の確認・判断が必要（未実施）

## A. 完成条件（プロンプト記載 1〜22）
| # | 条件 | 状態 | 根拠 |
|---|---|---|---|
| 1 | PC/iPhone/Android 管理画面 | ✅（エミュレーション）👤 実機 | E2E-6、スクリーンショット、レスポンシブ＋下メニュー |
| 2 | 公開予約ページがスマホ完結 | ✅（エミュレーション）👤 実機 | E2E-1/6 |
| 3 | PWA 構成 | ✅ | manifest・SW・アイコン、E2E PWA |
| 4 | サービス/スタッフ/リソース/営業時間/例外管理 | ✅ | 管理画面・E2E-1 |
| 5 | before/after を含む正確な空き枠 | ✅ | エンジンテスト 1〜8,16〜20 |
| 6 | 確定時サーバー再検証 | ✅ | bookings.ts（ロック内で checkSlot） |
| 7 | 同時競合で二重予約しない | ✅ | テスト 9/13b、負荷 50 並列、DB 排他制約 |
| 8 | 手動予約も同じ競合チェック | ✅ | integration（手動・強制） |
| 9 | 事前質問スナップショット | ✅ | integration |
| 10 | 安全な予約管理リンク | ✅ | integration（推測不可・失効・再発行） |
| 11 | 原子的な予約変更 | ✅ | テスト 11、E2E-3 |
| 12 | キャンセルと枠再開放 | ✅ | テスト 12、E2E-4 |
| 13 | 当日受付/完了/無断欠席 | ✅ | integration、E2E-1/6 |
| 14 | 通知/リマインド重複防止 | ✅ | テスト 15 |
| 15 | 顧客履歴/次回予約 | ✅ | E2E-1 |
| 16 | 待機リスト | ✅ | E2E-4 |
| 17 | 定員制予約 | ✅ | テスト 13、E2E-5 |
| 18 | 繰り返し開催枠 | ✅ | integration（週次/月次、個別変更、ルール変更で予約済み回保持） |
| 19 | CSV/バックアップ/復元 | ✅ | integration、E2E-7 |
| 20 | 事業者間データ分離 | ✅ | security.test.ts |
| 21 | 各種テスト結果を正確に記録 | ✅ | TEST_REPORT.md（未検証項目を明記） |
| 22 | 購入者向け資料/運用費資料 | ✅ | buyer-docs/、OPERATING_COSTS.md |

## B. 販売前に人間が行うこと 👤
1. **実機確認**：iPhone（Safari）で予約ページから予約完了、管理画面をホーム画面に追加して受付→完了。Android（Chrome）でも同様。
   PC の Edge / Firefox / Safari で管理画面・予約ページの表示確認。
2. **実メール確認**：実際の送信サービス（例 Resend）＋独自ドメインで、確認・リマインド・変更・キャンセル・事業者通知・招待メールが
   受信箱（Gmail/iCloud/キャリアメール）に届くこと、迷惑メールに入らないこと、リンクが開けること。
3. **本番相当デプロイ**：有料プランの契約可否を判断し、Render 等へデプロイ（初期設定ガイド.txt の手順どおりに第三者が再現できるか）。
   Docker イメージのビルド確認（Docker を使う場合）。
4. **料金の再確認**：OPERATING_COSTS.md の「未確認」項目と各社の最新料金・商用利用規約。
5. **法務**：販売条件・利用規約・免責、購入者向けのプライバシーポリシー雛形の要否、医療用途不可の表示、特定商取引法表記（販売ページ）。
6. **ライセンス**：THIRD_PARTY_NOTICES.txt を同梱（すべて MIT/ISC/BSD/BlueOak/MIT-0 の許容ライセンス。開発用のみ Apache-2.0/MPL-2.0）。
7. **スクリーンリーダー手動確認**（VoiceOver / TalkBack）で予約フローが読み上げ操作できるか。
8. **サンプルの扱い**：配布物にサンプルデータ（DB）を含めない。`seed:sample` はデモ用であることを説明書どおり案内。
9. **セキュリティ最終確認**：本番の `APP_SECRET`・`ALLOW_SIGNUP=false`・HTTPS・`COOKIE_SECURE=true`・DB の自動バックアップ有効化。
10. **販売ページの表現**：負荷試験の数値を「対応件数」として広告しない（TEST_REPORT は参考値）。「医療機関の診療予約として使用不可」を明記。

## C. 配布物に含めるもの
- `015-reserveflow/`（ソース一式。`node_modules`・`dist-*`・`test-results` は含めない）
- `buyer-docs/`（はじめに〜注意事項、CSV テンプレート、THIRD_PARTY_NOTICES）
- 開発資料（PLAN / DATA_MODEL / BOOKING_ENGINE / TIMEZONE_RULES / SECURITY / NOTIFICATIONS / OPERATIONS / OPERATING_COSTS / TEST_REPORT）
- `.env.example`, `render.yaml`, `Dockerfile`
