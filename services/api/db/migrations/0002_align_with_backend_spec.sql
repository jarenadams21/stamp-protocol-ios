-- 0002: Align the schema with docs/backend-spec.md (sections 3.1, 4, 5, 7, and 9).
--
-- 0001 was written for the standalone partner prototype. This migration moves it to the agreed
-- spec. Every table was empty when this was written, so columns are added as NOT NULL directly.
--
--   * Identities come from an OIDC provider, not only Sign in with Apple: owners and customers
--     are keyed by the token's `sub` claim.
--   * One business per owner, with a single free-text location (spec section 3.1). The
--     `locations` table is dropped; punches now record the reader that sent them instead.
--   * Card appearance is the `theme` contract from section 3.1, plus an optional cover image key.
--   * Cards can be `closed` (a full card claimed early), archived, and favorited, and never hold
--     more punches than their version requires.
--   * NFC readers (section 5) and partner notifications (section 7).
--
-- Wallet registrations and customer groups get their own migrations once their handlers exist.

-- Owners and customers: OIDC subjects ------------------------------------------------------

ALTER TABLE business_owners RENAME COLUMN apple_subject TO subject;
ALTER TABLE business_owners RENAME CONSTRAINT business_owners_apple_subject_key TO business_owners_subject_key;
ALTER TABLE business_owners
    ADD CONSTRAINT business_owners_subject_check CHECK (char_length(subject) BETWEEN 1 AND 255);

ALTER TABLE customers
    ADD COLUMN subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 255),
    ADD CONSTRAINT customers_subject_key UNIQUE (subject);

-- Businesses: one per owner, one location, image keys instead of URLs ----------------------

DROP INDEX businesses_owner_idx;
ALTER TABLE businesses ADD CONSTRAINT businesses_owner_id_key UNIQUE (owner_id);

ALTER TABLE businesses RENAME COLUMN logo_url TO logo_key;
ALTER TABLE businesses
    ADD CONSTRAINT businesses_logo_key_check CHECK (char_length(logo_key) BETWEEN 1 AND 200),
    -- Text chosen from Apple Maps suggestions; empty when the owner hasn't picked one.
    ADD COLUMN location text NOT NULL DEFAULT '' CHECK (char_length(location) <= 120),
    -- IANA zone. Apps choose dashboard periods in it and send UTC instants (section 8.4).
    ADD COLUMN time_zone text NOT NULL DEFAULT 'UTC' CHECK (char_length(time_zone) BETWEEN 1 AND 64);

-- Readers: NFC devices registered to one business (section 5) ------------------------------

CREATE TABLE readers (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid        NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
    label           text        CHECK (char_length(btrim(label)) BETWEEN 1 AND 40),
    -- SHA-256 of the reader's credential; the credential itself is never stored.
    credential_hash text        NOT NULL UNIQUE,
    created_at      timestamptz NOT NULL DEFAULT now(),
    revoked_at      timestamptz,
    UNIQUE (id, business_id)
);
CREATE INDEX readers_business_idx ON readers (business_id);

-- Punches come from readers, not locations ------------------------------------------------

ALTER TABLE punches DROP COLUMN location_id; -- also drops its foreign key and index
ALTER TABLE punches RENAME COLUMN recorded_at TO received_at;
ALTER TABLE punches
    ADD COLUMN reader_id uuid NOT NULL,
    ADD CONSTRAINT punches_reader_id_business_id_fkey
        FOREIGN KEY (reader_id, business_id) REFERENCES readers (id, business_id);

DROP TABLE locations;

-- Card configuration: the section 3.1 theme contract --------------------------------------

ALTER TABLE program_versions
    DROP COLUMN card_title,
    DROP COLUMN background_rgb,
    DROP COLUMN stamp_symbol,
    DROP COLUMN shows_logo,
    -- { lightPaper, lightInk, darkPaper, darkInk: "#RRGGBB", typeface, artwork, allowsMotion }.
    -- The 4.5:1 contrast rule is enforced by the API, which rejects failures with 400.
    ADD COLUMN theme jsonb NOT NULL,
    -- COALESCE: a missing key yields NULL, which a CHECK would otherwise accept.
    ADD CONSTRAINT program_versions_theme_check CHECK (COALESCE(
        jsonb_typeof(theme) = 'object'
        AND theme ->> 'lightPaper' ~ '^#[0-9A-F]{6}$'
        AND theme ->> 'lightInk'   ~ '^#[0-9A-F]{6}$'
        AND theme ->> 'darkPaper'  ~ '^#[0-9A-F]{6}$'
        AND theme ->> 'darkInk'    ~ '^#[0-9A-F]{6}$'
        AND theme ->> 'typeface' IN ('standard', 'rounded', 'serif', 'monospaced')
        AND theme ->> 'artwork' IN ('rail', 'cloud', 'stone')
        AND jsonb_typeof(theme -> 'allowsMotion') = 'boolean',
        false
    )),
    -- Private storage key of the cover photo. Apps get a short-lived URL from the API.
    ADD COLUMN cover_key text CHECK (char_length(cover_key) BETWEEN 1 AND 200);

-- Cards: closed state, customer flags, and punches bounded by their version ----------------

ALTER TABLE cards DROP CONSTRAINT cards_status_check;
ALTER TABLE cards DROP CONSTRAINT cards_check;
ALTER TABLE cards
    -- active: collecting. completed: full, reward earned. closed: full and claimed early, so the
    -- customer's next card already started (section 4, step 6).
    ADD CONSTRAINT cards_status_check CHECK (status IN ('active', 'completed', 'closed')),
    ADD CONSTRAINT cards_completed_at_check
        CHECK ((status IN ('completed', 'closed')) = (completed_at IS NOT NULL)),
    ADD COLUMN archived boolean NOT NULL DEFAULT false,
    ADD COLUMN favorite boolean NOT NULL DEFAULT false;

-- Finding a customer's newest card at a business (enrollment, punches, rollover).
CREATE INDEX cards_business_customer_created_idx ON cards (business_id, customer_id, created_at DESC);

-- A card is active exactly while it has fewer punches than its version requires.
CREATE FUNCTION check_card_punches() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    required integer;
BEGIN
    SELECT required_punches INTO required FROM program_versions WHERE id = NEW.program_version_id;
    IF NEW.punches > required THEN
        RAISE EXCEPTION 'card % has % punches but its version requires %', NEW.id, NEW.punches, required
            USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW.status = 'active') <> (NEW.punches < required) THEN
        RAISE EXCEPTION 'card % is % with % of % punches', NEW.id, NEW.status, NEW.punches, required
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER cards_punches_within_version
    BEFORE INSERT OR UPDATE OF punches, status, program_version_id ON cards
    FOR EACH ROW EXECUTE FUNCTION check_card_punches();

-- Rewards: owned by a customer, stackable --------------------------------------------------

ALTER TABLE rewards
    ADD COLUMN customer_id uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE;
-- Dashboard: rewardsWaiting and customersWithStackedRewards are all-time unredeemed counts.
CREATE INDEX rewards_business_waiting_idx ON rewards (business_id, customer_id) WHERE redeemed_at IS NULL;
CREATE INDEX rewards_customer_idx ON rewards (customer_id);

-- Partner notifications (section 7) --------------------------------------------------------

CREATE TABLE notifications (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid        NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
    kind        text        NOT NULL CHECK (kind IN ('card.rolledOver', 'reward.waiting')),
    payload     jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
    created_at  timestamptz NOT NULL DEFAULT now(),
    read_at     timestamptz
);
-- Newest first, paged by (created_at, id).
CREATE INDEX notifications_business_created_idx ON notifications (business_id, created_at DESC, id DESC);

INSERT INTO schema_migrations (version) VALUES ('0002_align_with_backend_spec');
