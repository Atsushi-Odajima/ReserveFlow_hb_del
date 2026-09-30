# ReserveFlow（商品 #015）

予約・顧客・受付・リマインド管理 — 公開予約ページから空き枠・事前質問・受付・キャンセル・再予約まで、小規模サービス業の予約業務を一元化。

- 購入者向け：`buyer-docs/はじめに.txt` から
- 開発者向け：`DEVELOPMENT.md`、設計は `PLAN.md` / `BOOKING_ENGINE.md` / `DATA_MODEL.md`
- テスト結果：`TEST_REPORT.md`、販売前チェック：`RELEASE_CHECKLIST.md`、運用費：`OPERATING_COSTS.md`

```bash
npm ci && npm run build && npm start   # 要 DATABASE_URL / APP_SECRET / PUBLIC_BASE_URL（.env.example）
```

技術：Node.js 22 / Fastify 5 / PostgreSQL 16 / React 19 / Vite 8 / Luxon / Zod / Playwright / Vitest
