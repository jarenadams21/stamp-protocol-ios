using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Joeyy.Api.Infrastructure;
using Npgsql;

namespace Joeyy.Api.Native;

public sealed record PassRow(Guid Serial, string Token, Guid? Revision, long Version, long Modified, string? BaseUrl, long ChangeTag, byte[]? Bytes)
{
    public static PassRow Read(NpgsqlDataReader reader) => new(
        reader.GetGuid(reader.GetOrdinal("serial")),
        reader.GetString(reader.GetOrdinal("token")),
        reader.IsDBNull(reader.GetOrdinal("revision")) ? null : reader.GetGuid(reader.GetOrdinal("revision")),
        reader.GetInt64(reader.GetOrdinal("version")),
        reader.GetInt64(reader.GetOrdinal("modified")),
        reader.IsDBNull(reader.GetOrdinal("base_url")) ? null : reader.GetString(reader.GetOrdinal("base_url")),
        reader.GetInt64(reader.GetOrdinal("change_tag")),
        reader.IsDBNull(reader.GetOrdinal("bytes")) ? null : (byte[])reader["bytes"]);
}

public sealed record WalletOptions(
    string BaseUrl,
    string PassType,
    Func<NativeCard, string, Task<byte[]>> Render,
    /// <summary>Sends an empty APNs push. Returns true when Apple says the push token is no longer valid.</summary>
    Func<string, Task<bool>> SendPush);

public sealed record WalletChanges(List<string> SerialNumbers, string LastUpdated)
{
    public object Public() => new { serialNumbers = SerialNumbers, lastUpdated = LastUpdated };
}

/// <summary>Signed pass publication and the Apple Wallet web service. A port of backend/src/native/wallet.ts.</summary>
public sealed partial class NativeWallet(NativeStore store, WalletOptions options, TimeProvider? time = null)
{
    private readonly TimeProvider clock = time ?? TimeProvider.System;

    public NativeStore Store { get; } = store;
    public WalletOptions Options { get; } = options;

    private long NowMs => clock.GetUtcNow().ToUnixTimeMilliseconds();

    public Task<PassRow> Publish(Guid serial) =>
        Store.Pool.Transaction(async db =>
        {
            // Hold the card lock through signing: another worker must never publish an
            // older snapshot over a newer stamp, even across multiple server instances.
            var locked = await db.QueryFirst("SELECT id FROM native_cards WHERE id=$1 FOR UPDATE", _ => true, serial);
            if (!locked) throw new HttpError(404, "Card not found.");
            var card = await Store.Card(serial, null, db);
            await db.Execute("INSERT INTO native_wallet_passes(serial,token) VALUES($1,$2) ON CONFLICT DO NOTHING",
                card.Id, RandomNumberGenerator.GetHexString(64, lowercase: true));
            var previous = await db.QueryFirst("SELECT * FROM native_wallet_passes WHERE serial=$1", PassRow.Read, card.Id)
                ?? throw new InvalidOperationException("Missing Wallet pass");
            if (previous.Version == card.Version && previous.BaseUrl == Options.BaseUrl && previous.Bytes is not null) return previous;
            var bytes = await Options.Render(card, previous.Token);
            if (bytes.Length == 0) throw new InvalidOperationException("Empty Wallet pass");
            var modified = Math.Max(NowMs / 1000, previous.Modified + 1);
            // Sequence allocation is not commit-ordered. Serialize publication through
            // COMMIT so a device cursor cannot skip an earlier uncommitted change.
            await db.Execute("SELECT pg_advisory_xact_lock(hashtextextended('joeyy.native-wallet.change-publication',0))");
            var current = await db.QueryFirst(
                """
                UPDATE native_wallet_passes SET revision=$1,version=$2,modified=$3,base_url=$4,
                bytes=$5,change_tag=nextval('native_wallet_change_seq') WHERE serial=$6 RETURNING *
                """, PassRow.Read, Guid.NewGuid(), card.Version, modified, Options.BaseUrl, bytes, card.Id)
                ?? throw new InvalidOperationException("Missing published Wallet pass");
            await db.Execute(
                """
                INSERT INTO native_wallet_jobs(device,generation)
                SELECT device,1 FROM native_wallet_registrations WHERE serial=$1
                ON CONFLICT(device) DO UPDATE SET generation=native_wallet_jobs.generation+1,attempts=0,next_attempt=0
                """, card.Id);
            return current;
        });

    public async Task<PassRow> Authorize(string? header, string type, string rawSerial)
    {
        var serial = NativeStore.NormalizeUuid(rawSerial);
        await using var db = await Store.Pool.OpenConnectionAsync();
        var pass = await db.QueryFirst("SELECT * FROM native_wallet_passes WHERE serial=$1", PassRow.Read, serial);
        var supplied = Encoding.UTF8.GetBytes(header ?? "");
        var expected = Encoding.UTF8.GetBytes($"ApplePass {pass?.Token ?? ""}");
        if (type != Options.PassType || pass?.Bytes is null || supplied.Length != expected.Length || !CryptographicOperations.FixedTimeEquals(supplied, expected))
        {
            throw new HttpError(401, "Invalid pass authorization.");
        }
        return pass;
    }

    public Task<bool> Register(string device, Guid serial, string pushToken) =>
        Store.Pool.Transaction(async db =>
        {
            var old = await db.QueryFirst("SELECT push_token FROM native_wallet_devices WHERE device=$1 FOR UPDATE", reader => reader.GetString(0), device);
            // ON CONFLICT also serializes first-time registrations for the same device.
            await db.Execute(
                """
                INSERT INTO native_wallet_devices(device,push_token) VALUES($1,$2)
                ON CONFLICT(device) DO UPDATE SET push_token=excluded.push_token
                """, device, pushToken);
            var inserted = await db.QueryFirst(
                "INSERT INTO native_wallet_registrations(device,serial) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING device", _ => true, device, serial);
            if (inserted || old != pushToken)
            {
                await db.Execute(
                    """
                    INSERT INTO native_wallet_jobs(device,generation) VALUES($1,1)
                    ON CONFLICT(device) DO UPDATE SET generation=native_wallet_jobs.generation+1,attempts=0,next_attempt=0
                    """, device);
            }
            return inserted;
        });

    public Task Unregister(string device, Guid serial) =>
        Store.Pool.Transaction(async db =>
        {
            await db.Execute("SELECT device FROM native_wallet_devices WHERE device=$1 FOR UPDATE", device);
            await db.Execute("DELETE FROM native_wallet_registrations WHERE device=$1 AND serial=$2", device, serial);
            await db.Execute(
                """
                DELETE FROM native_wallet_devices WHERE device=$1 AND NOT EXISTS
                (SELECT 1 FROM native_wallet_registrations WHERE device=$1)
                """, device);
        });

    [GeneratedRegex(@"^[0-9]{1,15}\z", RegexOptions.CultureInvariant)]
    private static partial Regex UpdateTag();

    public async Task<WalletChanges?> Changes(string device, string type, string? since)
    {
        if (since is not null && !UpdateTag().IsMatch(since)) throw new HttpError(400, "Invalid update tag.");
        if (type != Options.PassType) return null;
        await using var db = await Store.Pool.OpenConnectionAsync();
        var rows = await db.QueryAll(
            """
            SELECT p.serial,p.change_tag FROM native_wallet_passes p
            JOIN native_wallet_registrations r ON r.serial=p.serial
            WHERE r.device=$1 AND p.bytes IS NOT NULL AND p.change_tag>$2 ORDER BY p.change_tag,p.serial
            """, reader => (Serial: reader.GetGuid(0), ChangeTag: reader.GetInt64(1)), device, since is null ? -1L : long.Parse(since, System.Globalization.CultureInfo.InvariantCulture));
        return rows.Count == 0
            ? null
            : new WalletChanges(rows.Select(row => row.Serial.ToString()).ToList(), rows[^1].ChangeTag.ToString(System.Globalization.CultureInfo.InvariantCulture));
    }

    public async Task<int> Flush()
    {
        var failed = 0;
        // Jobs are durable and locked across APNs delivery. SKIP LOCKED allows multiple
        // instances without racing token rotation or deleting a newer generation.
        List<string> devices;
        await using (var db = await Store.Pool.OpenConnectionAsync())
        {
            devices = await db.QueryAll("SELECT device FROM native_wallet_jobs WHERE next_attempt<=$1 ORDER BY next_attempt LIMIT 50", reader => reader.GetString(0), NowMs);
        }
        foreach (var device in devices)
        {
            await Store.Pool.Transaction(async db =>
            {
                var job = await db.QueryFirst(
                    """
                    SELECT j.generation,j.attempts,d.push_token FROM native_wallet_jobs j
                    JOIN native_wallet_devices d ON d.device=j.device
                    WHERE j.device=$1 AND j.next_attempt<=$2 FOR UPDATE OF d,j SKIP LOCKED
                    """, reader => (Generation: reader.GetInt64(0), Attempts: reader.GetInt32(1), PushToken: reader.GetString(2)), device, NowMs);
                if (job.PushToken is null) return;
                bool invalid;
                try
                {
                    invalid = await Options.SendPush(job.PushToken);
                }
                catch
                {
                    var delay = Math.Min(3_600_000L, 30_000L * (1L << Math.Min(job.Attempts, 7)));
                    await db.Execute("UPDATE native_wallet_jobs SET attempts=attempts+1,next_attempt=$1 WHERE device=$2 AND generation=$3",
                        NowMs + delay, device, job.Generation);
                    failed++;
                    return;
                }
                if (invalid) await db.Execute("DELETE FROM native_wallet_devices WHERE device=$1 AND push_token=$2", device, job.PushToken);
                else await db.Execute("DELETE FROM native_wallet_jobs WHERE device=$1 AND generation=$2", device, job.Generation);
            });
        }
        return failed;
    }

    public async Task Reconcile(Action onFailure)
    {
        List<Guid> ids;
        await using (var db = await Store.Pool.OpenConnectionAsync())
        {
            ids = await db.QueryAll(
                """
                SELECT c.id FROM native_cards c LEFT JOIN native_wallet_passes p ON p.serial=c.id
                WHERE p.bytes IS NULL OR p.version<>c.version OR p.base_url IS DISTINCT FROM $1
                ORDER BY c.updated_at LIMIT 50
                """, reader => reader.GetGuid(0), Options.BaseUrl);
        }
        foreach (var id in ids)
        {
            try { await Publish(id); }
            catch { onFailure(); }
        }
    }
}
