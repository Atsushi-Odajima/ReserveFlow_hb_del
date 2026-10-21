# ReserveFlow — 小規模サービスの予約・受付管理

公開予約ページから空き枠・事前質問・受付・キャンセル・再予約までを管理するWebアプリです。

> **実装ブランチ：`claude/reserveflow-015`**。この既定ブランチのREADMEは製品の案内です。以下のソース・資料リンクと起動手順は、実装ブランチを参照します。

## できること

- サービス・担当・予約枠、顧客、事前質問の管理
- 予約受付・変更・取消・リマインドとジョブ処理
- PostgreSQLによる予約競合の制御、権限・監査・PWA

## 現在の範囲・制限

- オンライン決済を含むシステムではありません。実メール到達にはSMTP等の設定が必要です。
- 本番ホスト、Docker配備、Safari等の実機・ブラウザ確認はリリース前の残項目です。

## 実装の見どころ

**構成：** React / TypeScript / Vite、Node.js / Fastify、PostgreSQL、Luxon、Playwright。

- [015-reserveflow/src/server](https://github.com/Atsushi-Odajima/ReserveFlow_hb_del/tree/claude%2Freserveflow-015/015-reserveflow/src/server)
- [015-reserveflow/src/web](https://github.com/Atsushi-Odajima/ReserveFlow_hb_del/tree/claude%2Freserveflow-015/015-reserveflow/src/web)
- [015-reserveflow/tests](https://github.com/Atsushi-Odajima/ReserveFlow_hb_del/tree/claude%2Freserveflow-015/015-reserveflow/tests)

## ローカルで試す

Node.js 22以上、PostgreSQL。DATABASE_URL / APP_SECRET / PUBLIC_BASE_URL等を設定します。

実装ブランチを取得し、次のディレクトリで作業します。

```sh
git clone --branch claude/reserveflow-015 https://github.com/Atsushi-Odajima/ReserveFlow_hb_del.git
cd ReserveFlow_hb_del/015-reserveflow
npm ci
```

開発手順に沿って専用DBへ移行・サンプル設定を行い、npm run dev を実行します。通知・期限処理はジョブ起動の手順も参照してください。

環境設定・初期化の詳細：[セットアップ手順](https://github.com/Atsushi-Odajima/ReserveFlow_hb_del/blob/claude%2Freserveflow-015/015-reserveflow/DEVELOPMENT.md)。

## 検証方法

`015-reserveflow/` の `package.json` に定義された主な確認コマンドです。DB・ブラウザ・外部ツールを要するものは、開発手順の事前設定が必要です。

```sh
npm run typecheck
npm run test
npm run test:e2e
npm run build
npm run build:web
```

試験の実施環境・結果・未実施項目は、下記の記録を参照してください。画面エミュレーションと実機確認、モックと外部サービスでの確認を区別しています。

## 資料

- [015-reserveflow/DEVELOPMENT.md](https://github.com/Atsushi-Odajima/ReserveFlow_hb_del/blob/claude%2Freserveflow-015/015-reserveflow/DEVELOPMENT.md)
- [015-reserveflow/NEXT_STEPS.txt](https://github.com/Atsushi-Odajima/ReserveFlow_hb_del/blob/claude%2Freserveflow-015/015-reserveflow/NEXT_STEPS.txt)
- [015-reserveflow/README.md](https://github.com/Atsushi-Odajima/ReserveFlow_hb_del/blob/claude%2Freserveflow-015/015-reserveflow/README.md)
- [015-reserveflow/TEST_REPORT.md](https://github.com/Atsushi-Odajima/ReserveFlow_hb_del/blob/claude%2Freserveflow-015/015-reserveflow/TEST_REPORT.md)
- [015-reserveflow/RELEASE_CHECKLIST.md](https://github.com/Atsushi-Odajima/ReserveFlow_hb_del/blob/claude%2Freserveflow-015/015-reserveflow/RELEASE_CHECKLIST.md)
- [015-reserveflow/DATA_MODEL.md](https://github.com/Atsushi-Odajima/ReserveFlow_hb_del/blob/claude%2Freserveflow-015/015-reserveflow/DATA_MODEL.md)
- [015-reserveflow/DECISIONS.md](https://github.com/Atsushi-Odajima/ReserveFlow_hb_del/blob/claude%2Freserveflow-015/015-reserveflow/DECISIONS.md)
- [015-reserveflow/SECURITY.md](https://github.com/Atsushi-Odajima/ReserveFlow_hb_del/blob/claude%2Freserveflow-015/015-reserveflow/SECURITY.md)
- [015-reserveflow/OPERATIONS.md](https://github.com/Atsushi-Odajima/ReserveFlow_hb_del/blob/claude%2Freserveflow-015/015-reserveflow/OPERATIONS.md)

## 制作・利用条件

制作・管理：**Atsushi Odajima**。実装・資料作成にはAI支援を利用しています。
ソース・同梱ライブラリ・フォント・モデル等の利用条件は、各ライセンスと第三者表記を参照してください。リポジトリの閲覧可能性と、再配布・商用利用の許諾は別です。
