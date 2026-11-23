-- 0006: A readable email address and last sign-in time on each account (docs/backend-spec.md section 8.5).
--
-- Numbered 0006 so it sorts after the dev database's 0005_native_prototype. Subjects don't change,
-- so existing accounts keep working; their email fills in on their next sign-in. The address is set
-- only from a Google (or Apple) token that marks it verified, or after an email code is verified.
-- Phone numbers are still never stored.

ALTER TABLE customers
    ADD COLUMN email text CHECK (char_length(email) BETWEEN 3 AND 254),
    ADD COLUMN last_sign_in_at timestamptz;

ALTER TABLE business_owners
    ADD COLUMN email text CHECK (char_length(email) BETWEEN 3 AND 254),
    ADD COLUMN last_sign_in_at timestamptz;

-- Finding who signed up with an address. Not unique: one address can be a Google account and an
-- email-code account, which are separate accounts.
CREATE INDEX customers_email_idx ON customers (email);
CREATE INDEX business_owners_email_idx ON business_owners (email);

INSERT INTO schema_migrations (version) VALUES ('0006_account_email');
