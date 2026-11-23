-- 0007: The website's diners and the stands they tap (docs/web-connect.md).
--
-- A stand is a passive NFC tag on the counter, read by the diner's phone. It is a row in `readers`
-- with kind = 'stand', so punches, the dashboard, and notifications work unchanged: a stand's punch
-- is an ordinary punch whose reader is the stand. A diner on the website is an ordinary customer,
-- found through an HttpOnly cookie (`web_sessions`) instead of a bearer token. Until they sign in,
-- their subject is `web:<uuid>`; signing in with a phone or email code moves the browser to that
-- account's customer (the same one the iOS app gets) and merges the anonymous cards into it.

-- Stands -----------------------------------------------------------------------------------------

ALTER TABLE readers
    ADD COLUMN kind text NOT NULL DEFAULT 'reader' CHECK (kind IN ('reader', 'stand')),
    -- The chip's UID (uppercase hex for NTAG 424 DNA), or a dev tag's name. Stands only.
    ADD COLUMN tag_uid text UNIQUE CHECK (char_length(tag_uid) BETWEEN 1 AND 64),
    -- allocated: packed for this business, not linked yet; taps stamp nothing. active: linked by
    -- the owner (pairing window). disabled: turned off by the owner (lost, stolen, replaced).
    ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('allocated', 'active', 'disabled')),
    -- The highest SUN read counter accepted. A tap must beat it (replay protection); the tap route
    -- accepts a counter with one UPDATE ... WHERE last_counter < $counter.
    ADD COLUMN last_counter bigint NOT NULL DEFAULT -1,
    ADD COLUMN activated_at timestamptz,
    ADD COLUMN last_tap_at timestamptz,
    ADD CONSTRAINT readers_stand_tag_check CHECK ((kind = 'stand') = (tag_uid IS NOT NULL)),
    -- A stand has been linked exactly when it isn't merely allocated. Readers don't use status.
    ADD CONSTRAINT readers_stand_activated_check
        CHECK (kind = 'reader' OR (status = 'allocated') = (activated_at IS NULL));
-- Stands still fill credential_hash (NOT NULL UNIQUE): the API stores SHA-256 of "tag:<tag_uid>".

-- An owner's 2-minute window for linking a stand: the first tap on one of this business's allocated
-- stands while it is open activates that stand instead of stamping.
ALTER TABLE businesses ADD COLUMN pairing_expires_at timestamptz;

-- The business's own limit on repeat stamps (team decision, 2026-11-11): a tap this many minutes or
-- less after the diner's last stamp there adds nothing. NULL means no limit; JOEYY sets none. Part of
-- the immutable version, like the rest of the card's rules.
ALTER TABLE program_versions
    ADD COLUMN min_minutes_between_stamps integer CHECK (min_minutes_between_stamps BETWEEN 1 AND 1440);

-- Customers: what the website keeps on the account --------------------------------------------

ALTER TABLE customers
    -- What the diner asked to be called. Only the diner's own routes return it.
    ADD COLUMN display_name text CHECK (char_length(display_name) BETWEEN 1 AND 40),
    -- The diner's own order for their cards, by business ID. NULL: never set (most recent visit first).
    ADD COLUMN card_order uuid[] CHECK (cardinality(card_order) <= 200);

-- Browser sessions ---------------------------------------------------------------------------

CREATE TABLE web_sessions (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    -- SHA-256 of the cookie's random 32 bytes; the cookie itself is never stored.
    token_hash          bytea       NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    customer_id         uuid        NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
    -- How this browser signed in to its account; NULL while it is anonymous (or for an account it
    -- reached another way).
    signed_in_with      text        CHECK (signed_in_with IN ('phone', 'email')),
    -- "••• ••• 0123" for a phone sign-in, shown back to the diner. The number itself is never stored.
    masked_phone        text        CHECK (char_length(masked_phone) <= 32),
    -- A code sign-in in progress: the keyed hash of the number or address (auth_codes.target_hash),
    -- its channel, and for email the address, which becomes customers.email once the code is right.
    pending_channel     text        CHECK (pending_channel IN ('phone', 'email')),
    pending_target_hash text        CHECK (char_length(pending_target_hash) = 64),
    pending_masked      text        CHECK (char_length(pending_masked) <= 260),
    pending_email       text        CHECK (char_length(pending_email) BETWEEN 3 AND 254),
    created_at          timestamptz NOT NULL DEFAULT now(),
    last_seen_at        timestamptz NOT NULL DEFAULT now(),
    CHECK ((pending_channel IS NULL) = (pending_target_hash IS NULL))
);
CREATE INDEX web_sessions_customer_idx ON web_sessions (customer_id);
CREATE INDEX web_sessions_last_seen_idx ON web_sessions (last_seen_at);

-- Redeem windows -------------------------------------------------------------------------------

-- "Use your reward now?": for 2 minutes, this diner's next tap on one of the business's stands
-- redeems the reward instead of stamping. Single use; starting again replaces the open one.
CREATE TABLE redeem_intents (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid        NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
    business_id uuid        NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
    reward_id   uuid        NOT NULL REFERENCES rewards (id) ON DELETE CASCADE,
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    -- Set by the tap that used it, with the short code the staff screen shows.
    used_at     timestamptz,
    code        text        CHECK (char_length(code) BETWEEN 1 AND 8),
    CHECK (expires_at > created_at),
    CHECK ((used_at IS NULL) = (code IS NULL))
);
CREATE UNIQUE INDEX redeem_intents_one_open ON redeem_intents (customer_id, business_id) WHERE used_at IS NULL;
CREATE INDEX redeem_intents_reward_idx ON redeem_intents (reward_id);

INSERT INTO schema_migrations (version) VALUES ('0007_web');
