-- 0001: Initial schema for the shared JOEYY backend (partner app and customer app).
--
-- Loyalty model: a business publishes immutable card versions. Each version needs 3–12
-- punches for one reward. A customer holds one active card per business, shared across all
-- of the business's locations. A card keeps its version's rules once it has a punch; when it
-- completes it earns exactly one reward (rewards never expire) and the next card starts.
--
-- Apply with: psql --single-transaction -v ON_ERROR_STOP=1 -f 0001_initial_schema.sql
-- (This file has no BEGIN/COMMIT so it can also be dry-run inside a transaction and rolled back.)

-- Migration bookkeeping ---------------------------------------------------------------

CREATE TABLE schema_migrations (
    version    text        PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);

-- Shared helpers ------------------------------------------------------------------------

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

CREATE FUNCTION reject_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% rows are immutable; publish a new version instead', TG_TABLE_NAME;
END;
$$;

-- People --------------------------------------------------------------------------------

-- Accounts that sign in to the partner app (Sign in with Apple).
CREATE TABLE business_owners (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    apple_subject text        NOT NULL UNIQUE,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- People who collect punches in the customer app. How they sign in is not decided yet;
-- an identity column will be added by a later migration.
CREATE TABLE customers (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Businesses (the brand) and their locations -------------------------------------------

-- `id` is the "Client ID" the partner app shows and customers search by.
CREATE TABLE businesses (
    id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id           uuid        NOT NULL REFERENCES business_owners (id) ON DELETE CASCADE,
    name               text        NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
    logo_url           text,
    -- The live card version. Foreign key added below, after program_versions exists.
    current_version_id uuid,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX businesses_owner_idx ON businesses (owner_id);
CREATE TRIGGER businesses_updated_at BEFORE UPDATE ON businesses
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Each restaurant or shop of a business. One card works at every location.
CREATE TABLE locations (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid        NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
    -- Optional short label, such as "Capitol Hill".
    name        text        CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
    -- Place chosen from Apple Maps suggestions: a city, street address, or map listing.
    address     text        NOT NULL CHECK (char_length(btrim(address)) BETWEEN 1 AND 120),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, business_id)
);
CREATE INDEX locations_business_idx ON locations (business_id);
CREATE TRIGGER locations_updated_at BEFORE UPDATE ON locations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Card versions -------------------------------------------------------------------------

-- A published, immutable set of rules and card design. Editing the card publishes N+1.
CREATE TABLE program_versions (
    id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id        uuid        NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
    version            integer     NOT NULL CHECK (version >= 1),
    required_punches   integer     NOT NULL CHECK (required_punches BETWEEN 3 AND 12),
    reward_description text        NOT NULL CHECK (char_length(btrim(reward_description)) BETWEEN 1 AND 60),
    card_title         text        NOT NULL CHECK (char_length(btrim(card_title)) BETWEEN 1 AND 30),
    background_rgb     integer     NOT NULL CHECK (background_rgb BETWEEN 0 AND 16777215), -- 0xRRGGBB
    stamp_symbol       text        NOT NULL CHECK (stamp_symbol IN (
                           'cup.and.saucer.fill', 'mug.fill', 'star.fill',
                           'heart.fill', 'leaf.fill', 'checkmark.seal.fill')),
    shows_logo         boolean     NOT NULL,
    published_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, version),
    UNIQUE (id, business_id)
);
CREATE TRIGGER program_versions_immutable BEFORE UPDATE ON program_versions
    FOR EACH ROW EXECUTE FUNCTION reject_update();

-- The live version must belong to the same business.
ALTER TABLE businesses
    ADD CONSTRAINT businesses_current_version_fk
    FOREIGN KEY (current_version_id, id) REFERENCES program_versions (id, business_id);

-- Cards, punches, rewards --------------------------------------------------------------

CREATE TABLE cards (
    id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id        uuid        NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
    customer_id        uuid        NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
    -- Reassigned to a newly published version only while the card has no punches.
    program_version_id uuid        NOT NULL,
    punches            integer     NOT NULL DEFAULT 0 CHECK (punches BETWEEN 0 AND 12),
    status             text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed')),
    created_at         timestamptz NOT NULL DEFAULT now(),
    completed_at       timestamptz,
    CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
    UNIQUE (id, business_id),
    FOREIGN KEY (program_version_id, business_id) REFERENCES program_versions (id, business_id)
);
-- One active card per customer per business; a new one starts after the last completes.
CREATE UNIQUE INDEX cards_one_active_per_customer
    ON cards (business_id, customer_id) WHERE status = 'active';
-- Version usage (Live / Finishing / Retired) and publish-impact counts.
CREATE INDEX cards_business_version_status_idx ON cards (business_id, program_version_id, status);
CREATE INDEX cards_customer_idx ON cards (customer_id);

CREATE TABLE punches (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid        NOT NULL,
    card_id     uuid        NOT NULL,
    -- Where the punch happened. Kept as NULL if that location is later removed.
    location_id uuid,
    -- Validated external (NFC) event ID; a retried tap with the same ID is rejected.
    event_id    text        NOT NULL CHECK (char_length(event_id) BETWEEN 1 AND 200),
    occurred_at timestamptz NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, event_id),
    FOREIGN KEY (card_id, business_id) REFERENCES cards (id, business_id) ON DELETE CASCADE,
    FOREIGN KEY (location_id, business_id) REFERENCES locations (id, business_id)
        ON DELETE SET NULL (location_id)
);
-- Dashboard: punches where from <= occurred_at < to.
CREATE INDEX punches_business_time_idx ON punches (business_id, occurred_at);
CREATE INDEX punches_card_idx ON punches (card_id);
CREATE INDEX punches_location_time_idx ON punches (location_id, occurred_at) WHERE location_id IS NOT NULL;

-- Exactly one reward per completed card. Rewards never expire.
CREATE TABLE rewards (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid        NOT NULL,
    card_id     uuid        NOT NULL UNIQUE,
    earned_at   timestamptz NOT NULL,
    redeemed_at timestamptz,
    CHECK (redeemed_at IS NULL OR redeemed_at >= earned_at),
    FOREIGN KEY (card_id, business_id) REFERENCES cards (id, business_id) ON DELETE CASCADE
);
-- Dashboard: rewards earned and redeemed in a date range.
CREATE INDEX rewards_business_earned_idx ON rewards (business_id, earned_at);
CREATE INDEX rewards_business_redeemed_idx ON rewards (business_id, redeemed_at) WHERE redeemed_at IS NOT NULL;

INSERT INTO schema_migrations (version) VALUES ('0001_initial_schema');
