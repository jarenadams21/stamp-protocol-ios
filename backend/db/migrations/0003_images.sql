-- 0003: Uploaded images (docs/backend-spec.md sections 2, 8.1, and 10).
--
-- The image bytes live in private object storage (Azure Blob Storage). This table records each
-- upload and which business owns it, so the API can check ownership without asking storage, and
-- the database itself refuses a logo or cover that belongs to another business.

CREATE TABLE images (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  uuid        NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
    kind         text        NOT NULL CHECK (kind IN ('logo', 'cover')),
    -- The blob's name in the container: businesses/<business id>/<kind>/<image id>.<png|jpg>.
    storage_key  text        NOT NULL UNIQUE CHECK (char_length(storage_key) BETWEEN 1 AND 200),
    -- What the API stored after re-encoding, not what the client claimed to send.
    content_type text        NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg')),
    byte_size    integer     NOT NULL CHECK (byte_size > 0),
    width        integer     NOT NULL CHECK (width > 0),
    height       integer     NOT NULL CHECK (height > 0),
    created_at   timestamptz NOT NULL DEFAULT now(),
    -- Target of the composite foreign keys below.
    UNIQUE (storage_key, business_id)
);
CREATE INDEX images_business_idx ON images (business_id, kind, created_at DESC);

-- A business's logo and a version's cover must be images uploaded by that same business. The API
-- also checks the kind (a cover can't be used as a logo); every key was NULL when this was written.
ALTER TABLE businesses
    ADD CONSTRAINT businesses_logo_key_fkey
        FOREIGN KEY (logo_key, id) REFERENCES images (storage_key, business_id);
ALTER TABLE program_versions
    ADD CONSTRAINT program_versions_cover_key_fkey
        FOREIGN KEY (cover_key, business_id) REFERENCES images (storage_key, business_id);

-- Cleanup: finding unused images, and the foreign key checks when an images row is deleted.
CREATE INDEX images_created_idx ON images (created_at);
CREATE INDEX businesses_logo_key_idx ON businesses (logo_key) WHERE logo_key IS NOT NULL;
CREATE INDEX program_versions_cover_key_idx ON program_versions (cover_key) WHERE cover_key IS NOT NULL;

-- Files still to delete from storage. Every deleted images row is queued here by the trigger below,
-- whether the cleanup removed it or its business was deleted (ON DELETE CASCADE). The cleanup job
-- deletes the file, then the queue row, so a failed delete is retried and no file is forgotten.
CREATE TABLE image_deletions (
    storage_key text        PRIMARY KEY,
    queued_at   timestamptz NOT NULL DEFAULT now(),
    attempts    integer     NOT NULL DEFAULT 0,
    last_error  text
);

CREATE FUNCTION queue_image_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO image_deletions (storage_key) VALUES (OLD.storage_key) ON CONFLICT DO NOTHING;
    RETURN OLD;
END;
$$;
CREATE TRIGGER images_queue_deletion
    AFTER DELETE ON images
    FOR EACH ROW EXECUTE FUNCTION queue_image_deletion();

INSERT INTO schema_migrations (version) VALUES ('0003_images');
