# 通知・リマインド（NOTIFICATIONS）

## 種類
| kind | 宛先 | きっかけ | dedupe_key |
|---|---|---|---|
| booking_confirmed | お客様 | 予約作成（メールがある場合） | `confirmed:{bookingId}` |
| owner_new_booking | 事業者 | 公開ページからの予約 | `owner_new:{bookingId}` |
| reminder | お客様 | 開始の N 時間前（事業者設定、0 で無効） | `reminder:{bookingId}:{startISO}` |
| booking_changed / owner_booking_changed | お客様 / 事業者（お客様が変更した場合） | 日時変更 | `changed:{newId}` / `owner_changed:{newId}` |
| booking_cancelled / owner_booking_cancelled | お客様 / 事業者（お客様がキャンセルした場合） | キャンセル | `cancelled:{id}` / `owner_cancelled:{id}` |
| waitlist_opening | 事業者 | キャンセルで待機候補がある | `waitlist:{cancelledBookingId}` |
| manage_link | お客様 | 管理リンク再発行 | `manage_link:{id}:{time}` |
| staff_invite | 招待先 | ログイン招待 | `invite:{inviteId}` |

事業者宛は「事業者の通知先メール」→ 未設定なら事業者メール。設定でオフにできる。

## Job
- Web プロセス内のワーカーが `WORKER_INTERVAL_MS`（既定 60 秒）ごとに実行。外部 Cron 用に `npm run jobs:run` も同じ処理。
- 1 回の処理：
  1. `sending` のまま 10 分以上経過 → `unknown`（二重送信防止のため自動再送しない）。
  2. `pending/failed` かつ予定時刻到来・試行回数上限未満を `FOR UPDATE SKIP LOCKED` で最大 25 件 claim し `sending` に更新（attempts+1）。
  3. 送信直前に状態を再確認（キャンセル済み予約のリマインド・確定通知は `skipped`）。サンプル事業者は `skipped`。
  4. 成功 → `sent`（sent_at, provider_message_id）。失敗 → `failed`、`last_error`、次回 1/5/15/60/180 分後（最大 5 回）。
- 同時に複数のワーカー/CLI が動いても同じ通知を二重に送らない（テスト 15）。

## 予約変更・キャンセル時
- 旧予約の未送信リマインドは `cancelled`。新予約に新しいリマインドを作成（dedupe_key は開始時刻を含む）。
- 来店/完了/無断欠席の記録時も未送信リマインドを取消。

## 本文
- plain text。事業者名・予約番号・日時（事業者タイムゾーン＋TZ 名）・メニュー・担当・人数・管理リンク・締切・注意事項・連絡先・署名。
- 管理リンクは送信時に新しいトークンを発行（DB に平文なし）。送信失敗ならそのトークンを失効。
- 変数は制御文字を除去して展開。HTML は生成しない。

## 送信設定
- `EMAIL_DRIVER=log`（既定）：送信しない（記録のみ）。管理画面「通知履歴」に警告を表示。
- `EMAIL_DRIVER=smtp` + `SMTP_URL` + `EMAIL_FROM`：Resend/Postmark/SES/SendGrid/Brevo 等の SMTP で送信。送信ドメインの SPF/DKIM（推奨 DMARC）設定が必要。
- SMS は初版対象外。

## 時刻
- リマインド時刻は「開始時刻 − N 時間」の瞬間で計算。本文の日時は事業者タイムゾーンで整形。
- 予約時点で既にリマインド時刻を過ぎている場合は作成しない。
