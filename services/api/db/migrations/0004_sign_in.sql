-- 0004: Sign-in (docs/backend-spec.md section 8.5).
--
-- The API issues its own tokens after Apple, Google, or a one-time code sent by text or email proves who someone is.
-- Access tokens are short-lived JWTs and aren't stored. Refresh tokens and one-time codes are stored
-- only as hashes, and phone numbers and email addresses only as a keyed hash, never in the clear.

CREATE TABLE auth_refresh_tokens (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Every token from one sign-in shares a family. Reusing an already-rotated token revokes the
    -- whole family, because one of the two holders must have stolen it.
    family_id   uuid        NOT NULL,
    token_hash  bytea       NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    audience    text        NOT NULL CHECK (audience IN ('partner', 'customer')),
    subject     text        NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 255),
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    used_at     timestamptz,
    revoked_at  timestamptz,
    CHECK (expires_at > created_at)
);
CREATE INDEX auth_refresh_tokens_family_idx ON auth_refresh_tokens (family_id);
CREATE INDEX auth_refresh_tokens_expires_idx ON auth_refresh_tokens (expires_at);

-- One row per phone number or email address that asked for a code, keyed by a hash that includes
-- the channel. The row outlives the code so send limits hold across codes; `code_hash` is cleared
-- once the code is used or has had too many wrong guesses.
CREATE TABLE auth_codes (
    target_hash       text        PRIMARY KEY CHECK (char_length(target_hash) = 64),
    channel           text        NOT NULL CHECK (channel IN ('phone', 'email')),
    code_hash         bytea       CHECK (octet_length(code_hash) = 32),
    expires_at        timestamptz NOT NULL,
    attempts          integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    sent_at           timestamptz NOT NULL,
    window_started_at timestamptz NOT NULL,
    sends_in_window   integer     NOT NULL CHECK (sends_in_window >= 1)
);
CREATE INDEX auth_codes_window_idx ON auth_codes (window_started_at);

INSERT INTO schema_migrations (version) VALUES ('0004_sign_in');
