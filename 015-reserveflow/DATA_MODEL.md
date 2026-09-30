# データモデル（DATA_MODEL）

PostgreSQL 16。定義は `src/server/db/migrations/001_init.sql`, `002_perf.sql`。全業務テーブルは `business_id` を持ち、
すべての API クエリは `business_id = セッションの事業者` を条件に含める（事業者間分離）。子テーブルは
`(business_id, id)` の複合外部キーで **他事業者の行を参照できない** ようにしている（staff_services, service_resources, bookings→customers/services 等）。

## 主要テーブル

| テーブル | 役割 | 主な列 |
|---|---|---|
| users | ログインユーザー | email_normalized(一意), password_hash(scrypt), failed_logins, locked_until |
| businesses | 事業者（テナント） | slug(一意), timezone(IANA), slot_interval_min, min_notice_min, max_advance_days, change/cancel_deadline_min, reminder_hours_before, theme_color, notes, completion_message, phone_requirement, consent_text, published, is_sample, logo(bytea) |
| memberships | ユーザー×事業者の権限 | role(owner/staff), staff_id, permissions(jsonb) |
| sessions | ログインセッション | id=sha256(token), csrf_token, expires_at |
| invites | スタッフ/オーナー招待 | token_hash, expires_at(7日), used_at |
| weekly_hours | 曜日別時間（複数区間） | owner_kind(business/staff/staff_break/resource), weekday, start_min, end_min(≤1440) |
| date_exceptions | 日付例外 | date, kind(closed/special_hours), intervals |
| services | サービス | duration_min, buffer_before/after_min, capacity, max_party_size, requires_staff, booking_mode(slots/sessions), slot_interval_min, is_public, accepts_bookings, archived_at |
| staff / staff_services | スタッフと対応サービス | display_name, internal_name(非公開), accepts_bookings, uses_business_hours, max_participants, archived_at |
| resources / service_resources | 部屋・設備と必要サービス | quantity(同時利用数), person_capacity, has_hours |
| blocks | ブロック/休み/休止 | scope(business/staff/resource), target_id, start_at, end_at |
| questions | 事前質問 | type, label, options(jsonb), required, service_id(NULL=全) |
| customers | 顧客台帳 | customer_no(事業者内連番), name/email/phone(+normalized), admin_note, tags, archived_at, anonymized_at |
| recurrence_rules | 繰り返し開催ルール | freq(weekly/monthly_nth_weekday/monthly_day), interval_n, weekdays, nth, month_day, start_time_min, start/end_date, generated_until |
| session_occurrences | 開催回 | rule_id, staff_id, local_date, start/end, occupied_start/end, capacity, status(scheduled/cancelled), modified |
| bookings | 予約 | ref_code, customer_id, service_id, staff_id, occurrence_id, session_key, start/end, occupied_start/end, party_size, status, source, service_snapshot, answers(スナップショット), forced/forced_reason, idempotency_key, rescheduled_from/to_id |
| allocations | 占有（スタッフ/リソース） | booking_id か occurrence_id, kind, target_id, occupied(tstzrange), session_key, active |
| booking_status_history | 状態履歴 | from_status, to_status, actor_type, actor_user_id, reason, at |
| manage_tokens | 予約管理リンク | token_hash(一意), expires_at, revoked_at, last_used_at |
| notifications | 通知キュー/履歴 | kind, recipient, dedupe_key(事業者内一意), scheduled_at, status, attempts, next_attempt_at, last_error, sent_at |
| waitlist_entries | 待機リスト | service_id, staff_id, date_from/to, time_from/to_min, party_size, status, expires_at, last_match_at |
| audit_logs | 監査ログ | actor_type, actor_user_id, action, entity_type/id, summary(jsonb) |
| import_batches | CSV 取込履歴 | kind, file_sha256（(事業者,種類,ハッシュ)一意＝二重取込防止） |
| rate_limits | レート制限カウンタ | key=sha256(secret:用途:IP等) |

## 状態（bookings.status）
| 値 | 表示 | 枠を占有 |
|---|---|---|
| confirmed | 予約確定 | ○ |
| checked_in | 来店/開始済み | ○ |
| completed | 完了 | ○ |
| no_show | 無断欠席 | ○（時間は経過済み） |
| cancelled_by_customer | 顧客キャンセル | ×（allocations.active=false） |
| cancelled_by_business | 事業者キャンセル | × |
| rescheduled | 変更済み（新予約へ置換） | × |

遷移: confirmed→checked_in/completed/no_show/cancelled_*/rescheduled、checked_in→completed/confirmed/cancelled_by_business、
completed→checked_in（取消）、no_show→confirmed（取消）。すべて `booking_status_history` に記録。

## 設計上の要点
- **集計の二重管理をしない**：顧客の予約数・完了数・キャンセル数・無断欠席数・初回/最終日は bookings から都度集計（customers に件数列はない）。
- **事前質問のスナップショット**：bookings.answers に `{questionId,type,label,options,value,display}` を保存。質問編集で過去回答の意味は変わらない。
- **service_snapshot**：予約時点のサービス名・所要時間・バッファ・価格表示を保存。
- **allocations** は予約時点の占有を保持するため、後でサービスの必要リソースを変更しても過去/既存予約の占有は変わらない。
- 日時は `timestamptz`、ローカル日付は `date`（TIMEZONE_RULES.md）。
- 顧客削除は **匿名化**（anonymized_at）。予約行は統計の整合性のため残し、回答・メモ・連絡先を消去。
