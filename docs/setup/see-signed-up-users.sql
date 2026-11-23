-- Everyone who has signed in to JOEYY, newest first: customers and business owners.
--
-- Run it against the dev database (see dev-database.md, "See who signed up"), for example:
--   psql "<connection>" -f docs/setup/see-signed-up-users.sql
--
-- side            customer or business owner. The same person on both sides is two rows.
-- email           The verified address (Google, or an email code). Empty for accounts that haven't
--                 signed in since migration 0006, and for phone sign-ins.
-- provider        google, email, apple, or phone (the first part of the subject).
-- active_devices  Signed-in sessions that are still usable: refresh tokens not revoked, not expired,
--                 and not yet rotated (each signed-in device holds exactly one).
-- business        The owner's business, if they've set one up.

SELECT side, email, provider, created_at, last_sign_in_at, active_devices, business, subject
FROM (
    SELECT 'customer' AS side, c.email, split_part(c.subject, ':', 1) AS provider,
           c.created_at, c.last_sign_in_at, c.subject, NULL::text AS business,
           (SELECT count(*) FROM auth_refresh_tokens t
             WHERE t.audience = 'customer' AND t.subject = c.subject
               AND t.revoked_at IS NULL AND t.used_at IS NULL AND t.expires_at > now()) AS active_devices
    FROM customers c
    UNION ALL
    SELECT 'business owner', o.email, split_part(o.subject, ':', 1),
           o.created_at, o.last_sign_in_at, o.subject, b.name,
           (SELECT count(*) FROM auth_refresh_tokens t
             WHERE t.audience = 'partner' AND t.subject = o.subject
               AND t.revoked_at IS NULL AND t.used_at IS NULL AND t.expires_at > now())
    FROM business_owners o
    LEFT JOIN businesses b ON b.owner_id = o.id
) AS accounts
ORDER BY coalesce(last_sign_in_at, created_at) DESC;
