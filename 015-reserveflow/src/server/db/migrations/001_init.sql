-- ReserveFlow schema v1
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  email_normalized text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  failed_logins int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE businesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{2,39}$'),
  name text NOT NULL,
  brand_name text,
  description text NOT NULL DEFAULT '',
  phone text,
  email text,
  address text,
  website_url text,
  sns_url text,
  timezone text NOT NULL,
  week_start smallint NOT NULL DEFAULT 1 CHECK (week_start BETWEEN 0 AND 6),
  slot_interval_min int NOT NULL DEFAULT 30 CHECK (slot_interval_min IN (5,10,15,20,30,60)),
  min_notice_min int NOT NULL DEFAULT 120 CHECK (min_notice_min BETWEEN 0 AND 43200),
  max_advance_days int NOT NULL DEFAULT 60 CHECK (max_advance_days BETWEEN 1 AND 365),
  change_deadline_min int NOT NULL DEFAULT 1440 CHECK (change_deadline_min BETWEEN 0 AND 43200),
  cancel_deadline_min int NOT NULL DEFAULT 1440 CHECK (cancel_deadline_min BETWEEN 0 AND 43200),
  reminder_hours_before int NOT NULL DEFAULT 24 CHECK (reminder_hours_before BETWEEN 0 AND 168),
  theme_color text NOT NULL DEFAULT '#2f6f5e' CHECK (theme_color ~ '^#[0-9a-fA-F]{6}$'),
  completion_message text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  phone_requirement text NOT NULL DEFAULT 'optional' CHECK (phone_requirement IN ('required','optional','hidden')),
  consent_text text NOT NULL DEFAULT '',
  email_signature text NOT NULL DEFAULT '',
  notify_owner_new_booking boolean NOT NULL DEFAULT true,
  owner_notify_email text,
  published boolean NOT NULL DEFAULT false,
  is_sample boolean NOT NULL DEFAULT false,
  logo bytea,
  logo_mime text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','staff')),
  staff_id uuid,
  permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, business_id)
);

CREATE TABLE sessions (
  id text PRIMARY KEY,                -- sha256(token) hex
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id uuid REFERENCES businesses(id) ON DELETE CASCADE,
  csrf_token text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner','staff')),
  staff_id uuid,
  permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Weekly hours: owner_kind = business|staff|resource
CREATE TABLE weekly_hours (
  id bigserial PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  owner_kind text NOT NULL CHECK (owner_kind IN ('business','staff','staff_break','resource')),
  owner_id uuid NOT NULL,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),  -- 0=Sunday
  start_min int NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
  end_min int NOT NULL CHECK (end_min BETWEEN 1 AND 1440),
  CHECK (end_min > start_min)
);
CREATE INDEX weekly_hours_owner_idx ON weekly_hours(business_id, owner_kind, owner_id);

CREATE TABLE date_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  date date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('closed','special_hours')),
  label text NOT NULL DEFAULT '',
  intervals jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{startMin,endMin}]
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX date_exceptions_idx ON date_exceptions(business_id, date);

CREATE TABLE services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT '',
  duration_min int NOT NULL CHECK (duration_min BETWEEN 5 AND 1440),
  buffer_before_min int NOT NULL DEFAULT 0 CHECK (buffer_before_min BETWEEN 0 AND 240),
  buffer_after_min int NOT NULL DEFAULT 0 CHECK (buffer_after_min BETWEEN 0 AND 240),
  price_text text NOT NULL DEFAULT '',
  capacity int NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 500),
  max_party_size int NOT NULL DEFAULT 1 CHECK (max_party_size BETWEEN 1 AND 500),
  requires_staff boolean NOT NULL DEFAULT true,
  booking_mode text NOT NULL DEFAULT 'slots' CHECK (booking_mode IN ('slots','sessions')),
  slot_interval_min int CHECK (slot_interval_min IS NULL OR slot_interval_min IN (5,10,15,20,30,60,90,120)),
  accepts_bookings boolean NOT NULL DEFAULT true,
  is_public boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0,
  notes text NOT NULL DEFAULT '',
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);

CREATE TABLE staff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  internal_name text NOT NULL DEFAULT '',
  email text,
  profile text NOT NULL DEFAULT '',
  accepts_bookings boolean NOT NULL DEFAULT true,
  uses_business_hours boolean NOT NULL DEFAULT true,
  max_participants int CHECK (max_participants IS NULL OR max_participants >= 1),
  color text NOT NULL DEFAULT '#4a7bd0',
  sort_order int NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);

CREATE TABLE staff_services (
  business_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  service_id uuid NOT NULL,
  PRIMARY KEY (staff_id, service_id),
  FOREIGN KEY (business_id, staff_id) REFERENCES staff(business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, service_id) REFERENCES services(business_id, id) ON DELETE CASCADE
);

CREATE TABLE resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'room',
  quantity int NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 100),
  person_capacity int CHECK (person_capacity IS NULL OR person_capacity >= 1),
  has_hours boolean NOT NULL DEFAULT false,
  sort_order int NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);

CREATE TABLE service_resources (
  business_id uuid NOT NULL,
  service_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  PRIMARY KEY (service_id, resource_id),
  FOREIGN KEY (business_id, service_id) REFERENCES services(business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, resource_id) REFERENCES resources(business_id, id) ON DELETE CASCADE
);

CREATE TABLE blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('business','staff','resource')),
  target_id uuid,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  reason text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at),
  CHECK ((scope = 'business') = (target_id IS NULL))
);
CREATE INDEX blocks_range_idx ON blocks(business_id, start_at, end_at);

CREATE TABLE questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  service_id uuid,  -- NULL = all services
  type text NOT NULL CHECK (type IN ('short_text','long_text','single_choice','multi_choice','yes_no','confirm')),
  label text NOT NULL,
  help_text text NOT NULL DEFAULT '',
  required boolean NOT NULL DEFAULT false,
  options jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{id,label}]
  sort_order int NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_no bigint NOT NULL,
  name text NOT NULL,
  name_normalized text NOT NULL,
  email text,
  email_normalized text,
  phone text,
  phone_normalized text,
  admin_note text NOT NULL DEFAULT '',
  tags text[] NOT NULL DEFAULT '{}',
  archived_at timestamptz,
  anonymized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, customer_no),
  UNIQUE (business_id, id)
);
CREATE INDEX customers_email_idx ON customers(business_id, email_normalized);
CREATE INDEX customers_phone_idx ON customers(business_id, phone_normalized);
CREATE INDEX customers_name_idx ON customers(business_id, name_normalized text_pattern_ops);

CREATE TABLE recurrence_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  service_id uuid NOT NULL,
  staff_id uuid,
  freq text NOT NULL CHECK (freq IN ('weekly','monthly_nth_weekday','monthly_day')),
  interval_n int NOT NULL DEFAULT 1 CHECK (interval_n BETWEEN 1 AND 12),
  weekdays smallint[] NOT NULL DEFAULT '{}',
  nth smallint,          -- 1..5, -1 = last (monthly_nth_weekday)
  month_day smallint,    -- 1..31 (monthly_day)
  start_time_min int NOT NULL CHECK (start_time_min BETWEEN 0 AND 1439),
  start_date date NOT NULL,
  end_date date,
  capacity int CHECK (capacity IS NULL OR capacity >= 1),
  active boolean NOT NULL DEFAULT true,
  generated_until date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, service_id) REFERENCES services(business_id, id) ON DELETE CASCADE
);

CREATE TABLE session_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  service_id uuid NOT NULL,
  rule_id uuid REFERENCES recurrence_rules(id) ON DELETE SET NULL,
  staff_id uuid,
  local_date date NOT NULL,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  occupied_start timestamptz NOT NULL,
  occupied_end timestamptz NOT NULL,
  capacity int NOT NULL CHECK (capacity >= 1),
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','cancelled')),
  modified boolean NOT NULL DEFAULT false,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, service_id) REFERENCES services(business_id, id) ON DELETE CASCADE
);
CREATE INDEX occurrences_range_idx ON session_occurrences(business_id, start_at);
CREATE UNIQUE INDEX occurrences_rule_slot_uq ON session_occurrences(rule_id, start_at) WHERE rule_id IS NOT NULL;

CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  ref_code text NOT NULL,
  customer_id uuid NOT NULL,
  service_id uuid NOT NULL,
  staff_id uuid,
  occurrence_id uuid REFERENCES session_occurrences(id) ON DELETE RESTRICT,
  session_key text NOT NULL,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  occupied_start timestamptz NOT NULL,
  occupied_end timestamptz NOT NULL,
  party_size int NOT NULL DEFAULT 1 CHECK (party_size >= 1),
  status text NOT NULL CHECK (status IN ('confirmed','checked_in','completed','cancelled_by_customer','cancelled_by_business','no_show','rescheduled')),
  source text NOT NULL CHECK (source IN ('public','phone','walk_in','dm','email','admin','other')),
  service_snapshot jsonb NOT NULL,
  answers jsonb NOT NULL DEFAULT '[]'::jsonb,
  customer_note text NOT NULL DEFAULT '',
  staff_note text NOT NULL DEFAULT '',
  resource_ids uuid[] NOT NULL DEFAULT '{}',
  forced boolean NOT NULL DEFAULT false,
  forced_reason text,
  idempotency_key text,
  rescheduled_from_id uuid REFERENCES bookings(id),
  rescheduled_to_id uuid REFERENCES bookings(id),
  cancel_reason text,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, ref_code),
  UNIQUE (business_id, idempotency_key),
  FOREIGN KEY (business_id, customer_id) REFERENCES customers(business_id, id),
  FOREIGN KEY (business_id, service_id) REFERENCES services(business_id, id),
  CHECK (end_at > start_at)
);
CREATE INDEX bookings_start_idx ON bookings(business_id, start_at);
CREATE INDEX bookings_customer_idx ON bookings(business_id, customer_id, start_at);
CREATE INDEX bookings_status_idx ON bookings(business_id, status, start_at);
CREATE INDEX bookings_occurrence_idx ON bookings(occurrence_id) WHERE occurrence_id IS NOT NULL;

-- Occupancy held by a booking (slot mode) or a session occurrence.
CREATE TABLE allocations (
  id bigserial PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  booking_id uuid REFERENCES bookings(id) ON DELETE CASCADE,
  occurrence_id uuid REFERENCES session_occurrences(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('staff','resource')),
  target_id uuid NOT NULL,
  occupied tstzrange NOT NULL,
  session_key text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  CHECK ((booking_id IS NULL) <> (occurrence_id IS NULL)),
  -- DB-level guard: a staff member can never hold two different sessions at overlapping times.
  CONSTRAINT allocations_staff_no_overlap EXCLUDE USING gist (
    target_id WITH =, occupied WITH &&, session_key WITH <>
  ) WHERE (active AND kind = 'staff')
);
CREATE INDEX allocations_lookup_idx ON allocations USING gist (business_id, occupied) WHERE active;
CREATE INDEX allocations_booking_idx ON allocations(booking_id);
CREATE INDEX allocations_occurrence_idx ON allocations(occurrence_id);

CREATE TABLE booking_status_history (
  id bigserial PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('customer','user','system')),
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  reason text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX booking_status_history_idx ON booking_status_history(booking_id, at);

CREATE TABLE manage_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX manage_tokens_booking_idx ON manage_tokens(booking_id);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  booking_id uuid REFERENCES bookings(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('booking_confirmed','booking_changed','booking_cancelled','owner_new_booking','owner_booking_changed','owner_booking_cancelled','reminder','waitlist_opening','manage_link','staff_invite')),
  recipient text NOT NULL,
  dedupe_key text NOT NULL,
  scheduled_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','cancelled','skipped','unknown')),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  next_attempt_at timestamptz,
  last_error text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  sent_at timestamptz,
  claimed_at timestamptz,
  provider_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, dedupe_key)
);
CREATE INDEX notifications_due_idx ON notifications(status, scheduled_at) WHERE status IN ('pending','failed');
CREATE INDEX notifications_business_idx ON notifications(business_id, created_at DESC);
CREATE INDEX notifications_booking_idx ON notifications(booking_id);

CREATE TABLE waitlist_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id uuid,
  name text NOT NULL,
  email text,
  phone text,
  service_id uuid NOT NULL,
  staff_id uuid,
  date_from date NOT NULL,
  date_to date NOT NULL,
  time_from_min int NOT NULL DEFAULT 0,
  time_to_min int NOT NULL DEFAULT 1440,
  party_size int NOT NULL DEFAULT 1,
  note text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','contacted','booked','expired','cancelled')),
  expires_at timestamptz NOT NULL,
  last_match_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (date_to >= date_from),
  CHECK (time_to_min > time_from_min)
);
CREATE INDEX waitlist_idx ON waitlist_entries(business_id, status, date_from);

CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  business_id uuid REFERENCES businesses(id) ON DELETE CASCADE,
  actor_type text NOT NULL CHECK (actor_type IN ('customer','user','system')),
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_idx ON audit_logs(business_id, at DESC);

CREATE TABLE import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('customers','services')),
  file_sha256 text NOT NULL,
  row_count int NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, kind, file_sha256)
);

CREATE TABLE rate_limits (
  key text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  count int NOT NULL
);

CREATE TABLE app_meta (
  key text PRIMARY KEY,
  value text NOT NULL
);
