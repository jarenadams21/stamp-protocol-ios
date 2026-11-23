-- Technical per-install guest ownership is not customer identity. Existing password
-- accounts and legacy imports remain ordinary accounts without changing their IDs.
ALTER TABLE native_customers ADD COLUMN is_prototype boolean NOT NULL DEFAULT false;
INSERT INTO schema_migrations(version) VALUES ('0005_native_prototype');
