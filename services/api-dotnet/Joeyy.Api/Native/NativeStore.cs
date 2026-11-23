using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Joeyy.Api.Infrastructure;
using Npgsql;
using Org.BouncyCastle.Crypto.Generators;

namespace Joeyy.Api.Native;

public sealed record NativeCard(Guid Id, Guid CafeId, string CafeName, int Stamps, int Target, int RewardsAvailable, string UpdatedAt, long Version)
{
    /// <summary>The card as the app sees it: everything except the internal version.</summary>
    public object Public() => new { id = Id, cafeId = CafeId, cafeName = CafeName, stamps = Stamps, target = Target, rewardsAvailable = RewardsAvailable, updatedAt = UpdatedAt };
}

public sealed record NativeCustomer(Guid Id, string Username, string SessionHash, bool IsPrototype);

public sealed record VerifiedTag(string Uid, int Counter);

public sealed record AwardResult(Guid EventId, NativeCard Card, bool Duplicate, int Counter);

public sealed record SessionResult(string Token, string Username, bool Prototype = false)
{
    public object Public() => Prototype ? new { token = Token, username = Username, prototype = true } : new { token = Token, username = Username };
}

/// <summary>Customers, sessions, cards and stamps. A line-by-line port of services/api/src/native/store.ts.</summary>
public sealed partial class NativeStore(NpgsqlDataSource pool, bool prototypeMode = false, TimeProvider? time = null)
{
    private static readonly long SessionLifetimeMs = (long)TimeSpan.FromDays(30).TotalMilliseconds;
    private readonly TimeProvider clock = time ?? TimeProvider.System;

    public NpgsqlDataSource Pool { get; } = pool;
    public bool PrototypeMode { get; } = prototypeMode;

    private long NowMs => clock.GetUtcNow().ToUnixTimeMilliseconds();

    /// <summary>JavaScript's Date.toISOString(), which existing rows already use.</summary>
    private string NowIso => clock.GetUtcNow().UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

    public static string Digest(string value) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    [GeneratedRegex(@"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex UuidPattern();

    public static Guid NormalizeUuid(string? value)
    {
        if (value is null || !UuidPattern().IsMatch(value)) throw new HttpError(400, "Invalid identifier.");
        return Guid.Parse(value);
    }

    [GeneratedRegex(@"^[a-zA-Z0-9._-]{3,40}\z", RegexOptions.CultureInvariant)]
    private static partial Regex UsernamePattern();

    [GeneratedRegex(@"^Bearer [0-9a-f]{64}\z", RegexOptions.CultureInvariant)]
    private static partial Regex BearerPattern();

    [GeneratedRegex(@"^[0-9A-F]{14}\z", RegexOptions.CultureInvariant)]
    private static partial Regex UidPattern();

    /// <summary>Node's crypto.scrypt(password, salt, 64): N=16384, r=8, p=1, salt used as its UTF-8 text.</summary>
    public static Task<byte[]> Scrypt(string password, string salt) =>
        Task.Run(() => SCrypt.Generate(Encoding.UTF8.GetBytes(password), Encoding.UTF8.GetBytes(salt), 16384, 8, 1, 64));

    private static (string Username, string Password) Credentials(string? username, string? password)
    {
        if (username is null || !UsernamePattern().IsMatch(username) || password is null || password.Length < 12 || password.Length > 128)
        {
            throw new HttpError(400, "Use a 3-40 character username (letters, numbers, . _ -) and a 12-128 character password.");
        }
        return (username.ToLowerInvariant(), password);
    }

    public async Task<SessionResult> Signup(string? rawUsername, string? rawPassword)
    {
        var (username, password) = Credentials(rawUsername, rawPassword);
        var salt = RandomNumberGenerator.GetHexString(32, lowercase: true);
        var hash = Convert.ToHexStringLower(await Scrypt(password, salt));
        return await Pool.Transaction(async db =>
        {
            var id = Guid.NewGuid();
            var inserted = await db.QueryFirst(
                """
                INSERT INTO native_customers(id,username,salt,password_hash) VALUES($1,$2,$3,$4)
                ON CONFLICT(username) DO NOTHING RETURNING id
                """, _ => true, id, username, salt, hash);
            if (!inserted) throw new HttpError(409, "That username is already taken.");
            return await Session(db, id, username);
        });
    }

    public async Task<SessionResult> Login(string? rawUsername, string? rawPassword)
    {
        var (username, password) = Credentials(rawUsername, rawPassword);
        await using var db = await Pool.OpenConnectionAsync();
        var customer = await db.QueryFirst(
            "SELECT id,username,salt,password_hash FROM native_customers WHERE username=$1 AND NOT is_prototype",
            reader => (Id: reader.GetGuid(0), Username: reader.GetString(1), Salt: reader.GetString(2), Hash: reader.GetString(3)), username);
        // Always hash, so an unknown username takes as long as a wrong password.
        var hash = await Scrypt(password, customer.Salt ?? "unknown-account-salt");
        var expected = customer.Hash is null ? new byte[64] : Convert.FromHexString(customer.Hash);
        if (hash.Length != expected.Length || !CryptographicOperations.FixedTimeEquals(hash, expected) || customer.Hash is null)
        {
            throw new HttpError(401, "Incorrect username or password.");
        }
        return await Session(db, customer.Id, customer.Username);
    }

    private async Task<SessionResult> Session(NpgsqlConnection db, Guid id, string username, bool prototype = false)
    {
        var token = RandomNumberGenerator.GetHexString(64, lowercase: true);
        await db.Execute("INSERT INTO native_sessions(hash,customer_id,expires) VALUES($1,$2,$3)", Digest(token), id, NowMs + SessionLifetimeMs);
        return new SessionResult(token, username, prototype);
    }

    private static string BearerToken(string? header)
    {
        if (header is null || !BearerPattern().IsMatch(header)) throw new HttpError(401, "Please sign in.");
        return header[7..];
    }

    /// <param name="header">The Authorization header; null when absent (an empty header is present and invalid).</param>
    public async Task<SessionResult> PrototypeSession(string? header)
    {
        if (!PrototypeMode) throw new HttpError(404, "NFC prototype mode is disabled.");
        return await Pool.Transaction(async db =>
        {
            if (header is not null)
            {
                var token = BearerToken(header);
                var hash = Digest(token);
                // Expiry is renewable only for an existing guest session. A revoked
                // token or ordinary account must never silently become another guest.
                var username = await db.QueryFirst(
                    """
                    SELECT c.username FROM native_sessions s JOIN native_customers c ON c.id=s.customer_id
                    WHERE s.hash=$1 AND c.is_prototype FOR UPDATE OF s,c
                    """, reader => reader.GetString(0), hash);
                if (username is null) throw new HttpError(401, "This NFC prototype session is invalid or was revoked.");
                await db.Execute("UPDATE native_sessions SET expires=$2 WHERE hash=$1", hash, NowMs + SessionLifetimeMs);
                return new SessionResult(token, username, Prototype: true);
            }
            var id = Guid.NewGuid();
            var guest = $"nfc-{RandomNumberGenerator.GetHexString(32, lowercase: true)}";
            // Random, unusable credentials: this technical row is not a password account.
            await db.Execute(
                "INSERT INTO native_customers(id,username,salt,password_hash,is_prototype) VALUES($1,$2,$3,$4,true)",
                id, guest, RandomNumberGenerator.GetHexString(32, lowercase: true), RandomNumberGenerator.GetHexString(128, lowercase: true));
            return await Session(db, id, guest, prototype: true);
        });
    }

    public async Task<NativeCustomer> Authenticate(string? header)
    {
        var hash = Digest(BearerToken(header));
        await using var db = await Pool.OpenConnectionAsync();
        var customer = await db.QueryFirst(
            """
            SELECT c.id,c.username,c.is_prototype FROM native_sessions s JOIN native_customers c ON c.id=s.customer_id
            WHERE s.hash=$1 AND s.expires>$2 AND (NOT c.is_prototype OR $3::boolean)
            """, reader => new NativeCustomer(reader.GetGuid(0), reader.GetString(1), hash, reader.GetBoolean(2)), hash, NowMs, PrototypeMode);
        return customer ?? throw new HttpError(401, "Your session expired. Please sign in.");
    }

    public async Task Logout(NativeCustomer customer)
    {
        await using var db = await Pool.OpenConnectionAsync();
        await db.Execute("DELETE FROM native_sessions WHERE hash=$1", customer.SessionHash);
    }

    public Task<NativeCard> Card(Guid id, Guid? customerId = null, NpgsqlConnection? connection = null) =>
        Pool.With(connection, async db =>
            await db.QueryFirst(
                """
                SELECT c.id,c.cafe_id,f.name,c.stamps,f.target,c.rewards,c.updated_at,c.version
                FROM native_cards c JOIN native_cafes f ON f.id=c.cafe_id WHERE c.id=$1
                AND ($2::uuid IS NULL OR c.customer_id=$2)
                """,
                reader => new NativeCard(reader.GetGuid(0), reader.GetGuid(1), reader.GetString(2), reader.GetInt32(3), reader.GetInt32(4),
                    reader.GetInt32(5), reader.GetString(6), reader.GetInt64(7)),
                id, Database.NullableUuid(customerId))
            ?? throw new HttpError(404, "Card not found."));

    public async Task<List<NativeCard>> Cards(Guid customerId)
    {
        await using var db = await Pool.OpenConnectionAsync();
        var ids = await db.QueryAll("SELECT id FROM native_cards WHERE customer_id=$1 ORDER BY updated_at DESC,id", reader => reader.GetGuid(0), customerId);
        var cards = new List<NativeCard>();
        foreach (var id in ids) cards.Add(await Card(id, customerId, db));
        return cards;
    }

    public sealed record EventRow(Guid Id, Guid CardId, string Fingerprint, int Counter);

    public Task<EventRow?> Previous(Guid customerId, Guid requestId, string url, NpgsqlConnection? connection = null) =>
        Pool.With(connection, async db =>
        {
            var row = await db.QueryFirst(
                "SELECT id,card_id,fingerprint,counter FROM native_events WHERE customer_id=$1 AND request_id=$2",
                reader => new EventRow(reader.GetGuid(0), reader.GetGuid(1), reader.GetString(2), reader.GetInt32(3)), customerId, requestId);
            if (row is not null && row.Fingerprint != Digest(url)) throw new HttpError(409, "This request ID was already used for a different tap.");
            return row;
        });

    public Task<AwardResult> Award(Guid customerId, Guid requestId, string url, VerifiedTag? verified) =>
        Pool.Transaction(async db =>
        {
            // Cross-process customer serialization makes the request-id decision atomic,
            // including two different chips using the same request ID concurrently.
            await db.Execute("SELECT id FROM native_customers WHERE id=$1 FOR UPDATE", customerId);
            var previous = await Previous(customerId, requestId, url, db);
            if (previous is not null) return new AwardResult(previous.Id, await Card(previous.CardId, customerId, db), true, previous.Counter);
            if (verified is null) throw new HttpError(409, "Scan the physical chip again.");
            if (!UidPattern().IsMatch(verified.Uid) || verified.Counter < 0 || verified.Counter > 0xffffff)
            {
                throw new HttpError(502, "Invalid verifier response.");
            }
            var tag = await db.QueryFirst(
                "SELECT cafe_id,last_counter FROM native_tags WHERE uid=$1 FOR UPDATE",
                reader => (CafeId: reader.GetGuid(0), LastCounter: reader.GetInt32(1)), verified.Uid);
            if (tag == default) throw new HttpError(409, "This chip has not been linked to a cafe. Ask the operator to link it.");
            if (verified.Counter <= tag.LastCounter) throw new HttpError(409, "This tap link was already used. Scan the physical chip again.");
            await db.Execute(
                """
                INSERT INTO native_cards(id,customer_id,cafe_id,stamps,updated_at) VALUES($1,$2,$3,0,$4)
                ON CONFLICT(customer_id,cafe_id) DO NOTHING
                """, Guid.NewGuid(), customerId, tag.CafeId, NowIso);
            var locked = await db.QueryFirst(
                "SELECT id FROM native_cards WHERE customer_id=$1 AND cafe_id=$2 FOR UPDATE", reader => (Guid?)reader.GetGuid(0), customerId, tag.CafeId)
                ?? throw new InvalidOperationException("Missing native card");
            var card = await Card(locked, customerId, db);
            var stamps = card.Stamps >= card.Target ? 1 : card.Stamps + 1;
            var id = Guid.NewGuid();
            var inserted = await db.QueryFirst(
                """
                INSERT INTO native_events(id,customer_id,request_id,fingerprint,card_id,uid,counter)
                VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING seq,counter
                """, reader => (Seq: reader.GetInt64(0), Counter: reader.GetInt32(1)),
                id, customerId, requestId, Digest(url), card.Id, verified.Uid, verified.Counter);
            if (inserted == default) throw new InvalidOperationException("Missing native event");
            await db.Execute("UPDATE native_tags SET last_counter=$1 WHERE uid=$2", verified.Counter, verified.Uid);
            await db.Execute(
                "UPDATE native_cards SET stamps=$1,rewards=$2,updated_at=$3,version=$4 WHERE id=$5",
                stamps, card.RewardsAvailable + (stamps == card.Target ? 1 : 0), NowIso, inserted.Seq, card.Id);
            return new AwardResult(id, await Card(card.Id, customerId, db), false, inserted.Counter);
        });
}
