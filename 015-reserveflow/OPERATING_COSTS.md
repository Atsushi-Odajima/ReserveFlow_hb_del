# 運用費（OPERATING_COSTS）

確認日：**2026-09-30**。値は各社公式ドメインの料金/ドキュメントページ（検索結果の抜粋を含む）で確認した。
開発環境のネットワーク制限で一部ページを直接開けなかったため、「未確認」と記したものは **購入者/販売者が公開前に
必ず公式ページで再確認** すること。為替は 1 USD ≒ 150 円で概算（変動あり）。料金は予告なく変わる。

ReserveFlow の必要構成：Node.js 22 の常時稼働 Web サービス 1 つ（通知ワーカーを内蔵）＋ PostgreSQL 16（`btree_gist` 拡張）
＋ SMTP メール送信。外部 Cron は **不要**（ワーカーがアプリ内で1分ごとに動く）。

## 1. 推奨構成と月額目安

| 構成 | 内容 | 月額目安 | 備考 |
|---|---|---|---|
| **A. 推奨（Render + Resend）** | Render Starter Web（$7）＋ Render Postgres Basic-256mb（約$6）＋ Resend Free | **約 $13（約 2,000 円）** | Singapore リージョン（Tokyo なし）。有料 Postgres は PITR（Hobby 3日）。Resend Free は 3,000 通/月・100 通/日 |
| B. 送信量が多い | A ＋ Resend Pro（$20、50,000 通/月） | 約 $33（約 5,000 円） | 1 日 100 通を超える場合 |
| C. 東京リージョン重視 | Fly.io Machine（約 $2〜6）＋ Fly Managed Postgres Basic（$38〜）＋ Resend | 約 $40〜（約 6,000 円〜） | nrt/sin の単価は **未確認** |
| D. DB を Supabase（東京） | Web（Render $7 等）＋ Supabase Pro（$25〜） | 約 $32〜 | Free は 1 週間アクセスなしで一時停止するため本番不可 |
| 試用のみ | Render Free Web ＋ Free Postgres | $0 | **本番不可**：15 分アイドルで停止（復帰約 1 分）、Free Postgres は作成 30 日で期限切れ→14 日後削除、バックアップなし |

独自ドメイン（任意）：年 1,000〜3,000 円程度（レジストラにより異なる、**未確認**）。

## 2. ホスティング比較（2026-09-30 時点）
| 事業者 | 最安の常時稼働 | アジア | バックアップ |
|---|---|---|---|
| Render | Starter $7 + Postgres Basic 約$6 | Singapore | 有料 PG は PITR（Hobby 3日/Pro 7日） |
| Railway | Hobby $5（$5 分の利用枠込み、超過は従量） | Singapore | Volume バックアップあり（保持期間 **未確認**） |
| Fly.io | Machine $1.94〜 + MPG $38〜 | Tokyo / Singapore | MPG にバックアップ付き |
| Koyeb | Eco 約 $1.61〜 + Postgres 約 $20.89〜 | Tokyo/Singapore（DB は Singapore） | **未確認** |

- Railway の Cron は最短 5 分。ReserveFlow はアプリ内ワーカーのため Cron 不要。
- 各社の商用利用可否は規約本文を **未確認**（一般に有料プランでの商用利用は想定されている）。販売前に確認。

## 3. マネージド PostgreSQL
| サービス | 無料 | 有料 | 東京 | 備考 |
|---|---|---|---|---|
| Render Postgres | 30 日で失効 | 約 $6〜 | なし（Singapore） | PITR |
| Neon | 0.5GB、100 CU 時間/月 | Launch 従量（最低額なし） | なし（Singapore/Sydney） | アイドル時ゼロスケール → 初回応答が遅れることがある |
| Supabase | 500MB、1 週間無アクセスで停止 | Pro $25〜（日次バックアップ 7 日） | あり | PITR は追加 $100/月〜 |

`btree_gist` 拡張が `CREATE EXTENSION` できることが必須（主要マネージド PG は対応。実環境で要確認）。

## 4. メール送信
| サービス | 無料枠 | 最初の有料 | 備考 |
|---|---|---|---|
| Resend | 3,000 通/月（100 通/日） | Pro $20 / 50,000 通 | SMTP 可、Tokyo 送信リージョン選択可 |
| Postmark | 100 通/月 | $15 / 10,000 通 | SMTP 可 |
| SendGrid | 恒久無料プラン **廃止**（60 日トライアル） | Essentials $19.95 | |
| Amazon SES | 2026-07-21 以降の新規は 12 か月無料枠なし | 単価 **未確認** | サンドボックス解除申請が必要 |
| Brevo | 300 通/日 | Starter $9 | |

送信ドメイン認証：SPF・DKIM 必須、DMARC 推奨（Gmail は全送信者に SPF または DKIM、1 日 5,000 通超は 3 つ全て）。
予約通知は取引メールであり、小規模事業者の通常利用では 5,000 通/日を超えない想定。

### 通数の目安
1 予約あたり：確定 1 ＋ 事業者通知 1 ＋ リマインド 1 ＝ 約 3 通（変更/キャンセル時 +1〜2）。
月 300 予約 → 約 900〜1,200 通 → Resend Free の範囲（ただし **1 日 100 通上限** に注意。1 日 30 予約超なら Pro を検討）。

## 5. 任意：CAPTCHA
Cloudflare Turnstile：Managed ウィジェットは無料・回数無制限（Free はアカウントあたり 20 ウィジェット）。
初期状態では **無効**（外部通信なし）。有効化する場合はプライバシーポリシーに Cloudflare への送信を明記。

## 6. 本アプリが発生させない費用
SMS、オンライン決済手数料、外部カレンダー API、AI API は初版で使用しないため費用なし。

## 出典（2026-09-30 確認）
render.com/pricing, render.com/docs/free, render.com/docs/regions, render.com/docs/postgresql-backups,
docs.railway.com/pricing/plans, docs.railway.com/cron-jobs, fly.io/docs/about/pricing/, fly.io/docs/mpg/,
koyeb.com/pricing, neon.com/pricing, neon.com/docs/introduction/regions, supabase.com/pricing,
supabase.com/docs/guides/platform/backups, resend.com/pricing, postmarkapp.com/pricing,
support.sendgrid.com（Trial Account Plan）, aws.amazon.com/ses/pricing/, brevo.com/pricing/,
support.google.com/a/answer/81126, developers.cloudflare.com/turnstile/plans/
