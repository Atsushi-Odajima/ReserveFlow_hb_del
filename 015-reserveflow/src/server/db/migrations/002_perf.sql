-- Performance: per-customer lookups (visit counts, ledger) and time-range scans across statuses.
CREATE INDEX IF NOT EXISTS bookings_customer_only_idx ON bookings(customer_id, status);
CREATE INDEX IF NOT EXISTS bookings_end_idx ON bookings(business_id, end_at);
