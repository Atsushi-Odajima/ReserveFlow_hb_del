export const STATUS_LABEL: Record<string, string> = {
  confirmed: '予約確定',
  checked_in: '来店/開始済み',
  completed: '完了',
  cancelled_by_customer: '顧客キャンセル',
  cancelled_by_business: '事業者キャンセル',
  no_show: '無断欠席',
  rescheduled: '変更済み',
};

/** Icons are text symbols so the status is never conveyed by colour alone. */
export const STATUS_ICON: Record<string, string> = {
  confirmed: '●',
  checked_in: '▶',
  completed: '✓',
  cancelled_by_customer: '✕',
  cancelled_by_business: '✕',
  no_show: '!',
  rescheduled: '↻',
};

export const SOURCE_LABEL: Record<string, string> = {
  public: '予約ページ',
  phone: '電話',
  walk_in: '店頭',
  dm: 'DM/SNS',
  email: 'メール',
  admin: '管理画面',
  other: 'その他',
};

export const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

export const QUESTION_TYPE_LABEL: Record<string, string> = {
  short_text: '短文',
  long_text: '長文',
  single_choice: '単一選択',
  multi_choice: '複数選択',
  yes_no: 'はい/いいえ',
  confirm: '確認チェック',
};

export const NOTIFICATION_STATUS_LABEL: Record<string, string> = {
  pending: '送信待ち',
  sending: '送信中',
  sent: '送信済み',
  failed: '失敗',
  cancelled: '取消',
  skipped: '送信対象外',
  unknown: '不明（要確認）',
};
