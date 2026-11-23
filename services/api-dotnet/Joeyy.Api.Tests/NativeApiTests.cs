using System.Collections.Concurrent;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using Joeyy.Api.Infrastructure;
using Joeyy.Api.Native;
using Joeyy.Api.Tests.Support;

namespace Joeyy.Api.Tests;

/// <summary>Shared state for <see cref="NativeApiTests"/>, like the before() hook in services/api/test/native.test.ts.</summary>
public sealed class NativeFixture : IAsyncLifetime
{
    public const string PassType = "pass.com.example.native";
    public const string Password = "native-fixture-password";
    public TestDatabase Db { get; private set; } = null!;
    public NativeServices Services { get; private set; } = null!;
    public TestApp App { get; private set; } = null!;
    public Guid CafeId { get; } = Guid.NewGuid();
    public volatile bool SigningBroken;
    public volatile string PushState = "ok";
    public int Verified;
    public ConcurrentQueue<string> Delivered { get; } = new();

    public async Task InitializeAsync()
    {
        Db = await TestDatabase.Create();
        var store = new NativeStore(Db.Pool);
        var wallet = new NativeWallet(store, new WalletOptions("https://native.example.test", PassType, Render, Push));
        Services = new NativeServices
        {
            Store = store, Wallet = wallet, FactoryTest = true, PrototypeMode = false, Verify = Verify,
            RequestLimit = 1_000_000, LoginLimit = 1_000_000,
        };
        App = await TestApp.Start(Db.Pool, Services);
        await Db.Execute("INSERT INTO native_cafes(id,name,target) VALUES($1,'Hardware Test Cafe',3)", CafeId);
    }

    public Task<byte[]> Render(NativeCard card, string token) =>
        SigningBroken ? throw new InvalidOperationException("Fixture signer offline") : Task.FromResult(Encoding.UTF8.GetBytes($"signed-fixture:{card.Id}:{card.Version}"));

    private Task<bool> Push(string token)
    {
        Delivered.Enqueue(token);
        return PushState switch
        {
            "offline" => throw new InvalidOperationException("Fixture APNs offline"),
            "invalid" => Task.FromResult(true),
            _ => Task.FromResult(false),
        };
    }

    private async Task<VerifiedTag> Verify(string url)
    {
        Interlocked.Increment(ref Verified);
        var query = url[(url.IndexOf('?') + 1)..].Split('&').Select(pair => pair.Split('=')).ToDictionary(pair => pair[0], pair => pair[1]);
        if (query["fixture"] == "invalid") throw new HttpError(422, "Invalid signature.");
        // Delay exposes concurrent request-id and global replay races.
        await Task.Delay(10);
        return new VerifiedTag(query["uid"], int.Parse(query["fixture"], System.Globalization.CultureInfo.InvariantCulture));
    }

    /// <summary>Each test links its own chip, so tests never depend on each other's counters.</summary>
    public async Task<string> NewTag()
    {
        var uid = RandomNumberGenerator.GetHexString(14);
        await Db.Execute("INSERT INTO native_tags(uid,cafe_id) VALUES($1,$2)", uid, CafeId);
        return uid;
    }

    public static (string Url, string RequestId) Tap(object counter, string uid, string? requestId = null) =>
        ($"https://expired-host.example/tagtt?fixture={counter}&uid={uid}", requestId ?? Guid.NewGuid().ToString());

    public Task<Reply> PostTap(string token, (string Url, string RequestId) tap) =>
        App.Post("/api/v1/taps", token, new { url = tap.Url, requestId = tap.RequestId });

    public async Task<string> Account(string username)
    {
        var response = await App.Post("/api/v1/accounts", null, new { username, password = Password });
        Assert.True(response.Code == 201, response.Body);
        return response.Json.GetProperty("token").GetString()!;
    }

    public async Task DisposeAsync()
    {
        await App.DisposeAsync();
        await Db.DisposeAsync();
    }
}

public sealed class NativeApiTests(NativeFixture f) : IClassFixture<NativeFixture>
{
    private const string PassType = NativeFixture.PassType;

    [Fact]
    public async Task NativeFeatureIsOptInAndDisabledRoutesStayAbsent()
    {
        await using var disabled = await TestApp.Start(f.Db.Pool, null);
        Assert.Equal(404, (await disabled.Get("/api/v1/cards")).Code);
        Assert.Equal(404, (await disabled.Get("/api/v1/healthz")).Code);
        Assert.Equal(404, (await disabled.Post("/api/v1/prototype/session")).Code);
        Assert.Equal(404, (await disabled.Get($"/wallet/v1/passes/{PassType}/{Guid.NewGuid()}")).Code);
        Assert.False((await disabled.Get("/healthz")).Json.GetProperty("nativeNfc").GetProperty("enabled").GetBoolean());
        Assert.True((await f.App.Get("/healthz")).Json.GetProperty("nativeNfc").GetProperty("factoryKeyTest").GetBoolean());
        JsonAssert.Equal(new { error = "notFound", message = "No such route." }, (await f.App.Get("/v1/partner/business")).Json);
        await NativeReadiness.Assert(f.Db.Pool);
    }

    [Fact]
    public async Task ReadinessIsPublicSecretFreeAndReturns503ForAnUnreadySchema()
    {
        var ready = await f.App.Get("/api/v1/healthz");
        Assert.Equal(200, ready.Code);
        JsonAssert.Equal(new { status = "ok", factoryKeyTest = true, publicBaseURL = "https://native.example.test", prototypeMode = false }, ready.Json);
        Assert.Equal("no-store", ready.Header("Cache-Control"));
        Assert.Equal("nosniff", ready.Header("X-Content-Type-Options"));
        Assert.Equal("no-referrer", ready.Header("Referrer-Policy"));
        Assert.NotNull(ready.Header("x-request-id"));
        var spoofed = await f.App.Get("/api/v1/healthz", headers: new() { ["Host"] = "wrong.example.test", ["X-Forwarded-Host"] = "wrong-forwarded.example.test" });
        Assert.Equal("https://native.example.test", spoofed.Json.GetProperty("publicBaseURL").GetString());

        await using var pool = Database.Create(TestDatabase.Env, searchPath: $"missing_native_{Guid.NewGuid():N}");
        var store = new NativeStore(pool);
        await using var unready = await TestApp.Start(pool, f.Services with { Store = store, Wallet = new NativeWallet(store, f.Services.Wallet.Options), FactoryTest = false });
        var response = await unready.Get("/api/v1/healthz");
        Assert.Equal(503, response.Code);
        JsonAssert.Equal(new { status = "unavailable", factoryKeyTest = false, publicBaseURL = "https://native.example.test", prototypeMode = false }, response.Json);
    }

    [Fact]
    public async Task ReadinessReturns503WhenThePrivateVerifierIsDown()
    {
        await using var down = await TestApp.Start(f.Db.Pool, f.Services with { VerifierReady = () => throw new InvalidOperationException("verifier down") });
        var response = await down.Get("/api/v1/healthz");
        Assert.Equal(503, response.Code);
        Assert.Equal("unavailable", response.Json.GetProperty("status").GetString());
        Assert.DoesNotContain("verifier down", response.Body);
    }

    [Fact]
    public async Task AccountsErrorsExpiryLogoutIsolationUuidsReplayRolloverAndRewards()
    {
        var uid = await f.NewTag();
        Assert.Equal(401, (await f.App.Get("/api/v1/cards")).Code);
        Assert.Equal(400, (await f.App.Post("/api/v1/accounts", null, new { username = "bad", password = "short" })).Code);
        var signup = await f.App.Post("/api/v1/accounts", null, new { username = "native-a", password = NativeFixture.Password });
        Assert.Equal(["token", "username"], JsonAssert.Keys(signup.Json));
        var a = signup.Json.GetProperty("token").GetString()!;
        var b = await f.Account("native-b");
        Assert.Equal(409, (await f.App.Post("/api/v1/accounts", null, new { username = "NATIVE-A", password = NativeFixture.Password })).Code);
        Assert.Equal(401, (await f.App.Post("/api/v1/sessions", null, new { username = "native-a", password = "incorrect-password" })).Code);
        var login = await f.App.Post("/api/v1/sessions", null, new { username = "NATIVE-A", password = NativeFixture.Password });
        Assert.Equal(200, login.Code);
        Assert.Equal("native-a", login.Json.GetProperty("username").GetString());
        JsonAssert.Equal(new { cards = Array.Empty<object>() }, (await f.App.Get("/api/v1/cards", a)).Json);

        var original = NativeFixture.Tap(1, uid);
        var accepted = await f.PostTap(a, original);
        Assert.True(accepted.Code == 200, accepted.Body);
        var earned = accepted.Json;
        Assert.Equal(["card", "duplicate", "eventId"], JsonAssert.Keys(earned));
        Assert.Equal(["cafeId", "cafeName", "id", "rewardsAvailable", "stamps", "target", "updatedAt"], JsonAssert.Keys(earned.GetProperty("card")));
        Assert.Equal(1, earned.GetProperty("card").GetProperty("stamps").GetInt32());
        Assert.Matches(@"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$", earned.GetProperty("card").GetProperty("updatedAt").GetString());
        var cardId = earned.GetProperty("card").GetProperty("id").GetString()!;
        var pass = await f.App.Get($"/api/v1/cards/{cardId.ToUpperInvariant()}/pass", a);
        Assert.Equal(200, pass.Code);
        Assert.Equal("application/vnd.apple.pkpass", pass.Header("Content-Type"));
        Assert.Equal(404, (await f.App.Get($"/api/v1/cards/{cardId}/pass", b)).Code);
        Assert.Equal(400, (await f.App.Get("/api/v1/cards/not-a-uuid/pass", a)).Code);

        var before = f.Verified;
        var retry = (await f.PostTap(a, (original.Url, original.RequestId.ToUpperInvariant()))).Json;
        Assert.Equal(earned.GetProperty("eventId").GetString(), retry.GetProperty("eventId").GetString());
        Assert.True(retry.GetProperty("duplicate").GetBoolean());
        Assert.True(before == f.Verified, "retry never re-verifies consumed encrypted data");
        Assert.Equal(409, (await f.PostTap(a, NativeFixture.Tap(2, uid, original.RequestId))).Code);
        Assert.Equal(409, (await f.PostTap(a, NativeFixture.Tap(1, uid))).Code);
        Assert.Equal(409, (await f.PostTap(b, NativeFixture.Tap(1, uid))).Code);
        var personal = (await f.PostTap(b, NativeFixture.Tap(2, uid))).Json;
        Assert.NotEqual(cardId, personal.GetProperty("card").GetProperty("id").GetString());
        Assert.Equal(1, personal.GetProperty("card").GetProperty("stamps").GetInt32());
        Assert.Equal(422, (await f.PostTap(a, NativeFixture.Tap("invalid", uid))).Code);
        Assert.Equal(2, await f.Db.Scalar<int>("SELECT last_counter FROM native_tags WHERE uid=$1", uid));

        await f.PostTap(a, NativeFixture.Tap(3, uid));
        var full = (await f.PostTap(a, NativeFixture.Tap(4, uid))).Json.GetProperty("card");
        Assert.Equal(3, full.GetProperty("stamps").GetInt32());
        Assert.Equal(1, full.GetProperty("rewardsAvailable").GetInt32());
        Assert.Equal(3, (await f.App.Get("/api/v1/cards", a)).Json.GetProperty("cards")[0].GetProperty("stamps").GetInt32());
        var rollover = (await f.PostTap(a, NativeFixture.Tap(5, uid))).Json.GetProperty("card");
        Assert.Equal(1, rollover.GetProperty("stamps").GetInt32());
        Assert.Equal(1, rollover.GetProperty("rewardsAvailable").GetInt32());
        Assert.Equal(cardId, rollover.GetProperty("id").GetString());
        await f.PostTap(a, NativeFixture.Tap(6, uid));
        Assert.Equal(2, (await f.PostTap(a, NativeFixture.Tap(7, uid))).Json.GetProperty("card").GetProperty("rewardsAvailable").GetInt32());

        var customer = await f.Services.Store.Authenticate($"Bearer {a}");
        Assert.Equal(0L, await f.Db.Scalar<long>("SELECT count(*) FROM native_sessions WHERE hash=$1", a));
        Assert.NotEqual(NativeFixture.Password, await f.Db.Scalar<string>("SELECT password_hash FROM native_customers WHERE id=$1", customer.Id));
        await f.Db.Execute("UPDATE native_sessions SET expires=0 WHERE hash=$1", NativeStore.Digest(a));
        Assert.Equal(401, (await f.App.Get("/api/v1/cards", a)).Code);
        var loginToken = login.Json.GetProperty("token").GetString()!;
        Assert.Equal(204, (await f.App.Delete("/api/v1/session", loginToken)).Code);
        Assert.Equal(401, (await f.App.Get("/api/v1/cards", loginToken)).Code);
    }

    [Fact]
    public async Task ConcurrentSameAndDifferentRequestIdsAndChipsAreAtomicAcrossIndependentPools()
    {
        var uid = await f.NewTag();
        var uid2 = await f.NewTag();
        var a = await f.Account("concurrent-native");
        var b = await f.Account("concurrent-other");
        var customer = await f.Services.Store.Authenticate($"Bearer {a}");
        await using var otherPool = f.Db.NewPool();
        var independent = new NativeStore(otherPool);
        var request = NativeFixture.Tap(10, uid);
        var tag = new VerifiedTag(uid, 10);
        var requestId = Guid.Parse(request.RequestId);
        var results = await Task.WhenAll(
            f.Services.Store.Award(customer.Id, requestId, request.Url, tag),
            independent.Award(customer.Id, requestId, request.Url, tag));
        Assert.Equal(results[0].EventId, results[1].EventId);
        Assert.Single(results, result => !result.Duplicate);

        var httpRequest = NativeFixture.Tap(11, uid);
        var http = await Task.WhenAll(f.PostTap(a, httpRequest), f.PostTap(a, httpRequest));
        Assert.All(http, response => Assert.Equal(200, response.Code));
        Assert.Equal(http[0].Json.GetProperty("eventId").GetString(), http[1].Json.GetProperty("eventId").GetString());

        var collisions = await Task.WhenAll(f.PostTap(a, NativeFixture.Tap(12, uid)), f.PostTap(b, NativeFixture.Tap(12, uid)));
        Assert.Equal([200, 409], collisions.Select(response => response.Code).Order());

        var collisionId = Guid.NewGuid().ToString();
        var different = await Task.WhenAll(f.PostTap(a, NativeFixture.Tap(13, uid, collisionId)), f.PostTap(a, NativeFixture.Tap(1, uid2, collisionId)));
        Assert.Equal([200, 409], different.Select(response => response.Code).Order());
        Assert.Equal(1L, await f.Db.Scalar<long>("SELECT count(*) FROM native_events WHERE customer_id=$1 AND request_id=$2", customer.Id, Guid.Parse(collisionId)));
    }

    [Fact]
    public async Task PostCommitPublicationFailuresAndRestartReconciliationNeverDoubleAwardOrRotateAuth()
    {
        var uid = await f.NewTag();
        var a = await f.Account("publication-native");
        var first = NativeFixture.Tap(20, uid);
        f.SigningBroken = true;
        try
        {
            Assert.Equal(503, (await f.PostTap(a, first)).Code);
            Assert.Equal(1, (await f.App.Get("/api/v1/cards", a)).Json.GetProperty("cards")[0].GetProperty("stamps").GetInt32());
        }
        finally { f.SigningBroken = false; }
        var retry = (await f.PostTap(a, first)).Json;
        Assert.True(retry.GetProperty("duplicate").GetBoolean());
        Assert.Equal(1, retry.GetProperty("card").GetProperty("stamps").GetInt32());
        var cardId = Guid.Parse(retry.GetProperty("card").GetProperty("id").GetString()!);
        var original = await f.Services.Wallet.Publish(cardId);

        f.SigningBroken = true;
        try { Assert.Equal(503, (await f.PostTap(a, NativeFixture.Tap(21, uid))).Code); }
        finally { f.SigningBroken = false; }

        // A genuinely new pool represents a restarted process, not in-memory state.
        await using var restartedPool = f.Db.NewPool();
        var restarted = new NativeWallet(new NativeStore(restartedPool), f.Services.Wallet.Options);
        await restarted.Reconcile(() => Assert.Fail("Unexpected publication failure"));
        var recovered = await restarted.Publish(cardId);
        Assert.Equal(original.Token, recovered.Token);
        Assert.NotEqual(original.Revision, recovered.Revision);
        Assert.True(recovered.ChangeTag > original.ChangeTag);
        Assert.StartsWith("signed-fixture:", Encoding.UTF8.GetString(recovered.Bytes!));
        Assert.Equal(2, (await restarted.Store.Card(cardId)).Stamps);
    }

    [Fact]
    public async Task WalletAuthorizationRegistrationUpdatesConditionalDownloadsRotationRetryAndInvalidation()
    {
        var uid = await f.NewTag();
        var a = await f.Account("wallet-native");
        var result = (await f.PostTap(a, NativeFixture.Tap(30, uid))).Json;
        var pass = await f.Services.Wallet.Publish(Guid.Parse(result.GetProperty("card").GetProperty("id").GetString()!));
        const string device = "device-fixture";
        var registration = $"/wallet/v1/devices/{device}/registrations/{PassType}/{pass.Serial.ToString().ToUpperInvariant()}";
        var auth = new Dictionary<string, string> { ["Authorization"] = $"ApplePass {pass.Token}" };
        var pushToken = new string('a', 64);
        Task<Reply> Invoke(HttpMethod method, string url, bool authorized = false, object? json = null, Dictionary<string, string>? headers = null) =>
            f.App.Send(method, url, json: json, headers: authorized ? auth.Concat(headers ?? []).ToDictionary() : headers);

        Assert.Equal(401, (await Invoke(HttpMethod.Post, registration, json: new { pushToken })).Code);
        Assert.Equal(400, (await Invoke(HttpMethod.Post, registration, true, new { pushToken = "invalid" })).Code);
        Assert.Equal(201, (await Invoke(HttpMethod.Post, registration, true, new { pushToken })).Code);
        var deliveredBefore = f.Delivered.Count(token => token == pushToken);
        Assert.Equal(0, await f.Services.Wallet.Flush());
        Assert.Equal(deliveredBefore + 1, f.Delivered.Count(token => token == pushToken));
        Assert.Equal(200, (await Invoke(HttpMethod.Post, registration, true, new { pushToken })).Code);
        Assert.Equal(0L, await f.Db.Scalar<long>("SELECT count(*) FROM native_wallet_jobs WHERE device=$1", device));

        var changesUrl = $"/wallet/v1/devices/{device}/registrations/{PassType}";
        var changes = (await Invoke(HttpMethod.Get, changesUrl)).Json;
        Assert.Equal([pass.Serial.ToString()], changes.GetProperty("serialNumbers").EnumerateArray().Select(value => value.GetString()));
        var lastUpdated = changes.GetProperty("lastUpdated").GetString()!;
        Assert.Equal(204, (await Invoke(HttpMethod.Get, $"{changesUrl}?passesUpdatedSince={lastUpdated}")).Code);
        Assert.Equal(400, (await Invoke(HttpMethod.Get, $"{changesUrl}?passesUpdatedSince=oops")).Code);
        Assert.Equal(400, (await Invoke(HttpMethod.Get, $"{changesUrl}?passesUpdatedSince=1&passesUpdatedSince=2")).Code);
        Assert.Equal(204, (await Invoke(HttpMethod.Get, $"/wallet/v1/devices/unknown/registrations/{PassType}")).Code);

        var downloadUrl = $"/wallet/v1/passes/{PassType}/{pass.Serial.ToString().ToUpperInvariant()}";
        Assert.Equal(401, (await Invoke(HttpMethod.Get, downloadUrl)).Code);
        Assert.Equal(401, (await Invoke(HttpMethod.Get, downloadUrl.Replace(PassType, "pass.wrong"), true)).Code);
        var downloaded = await Invoke(HttpMethod.Get, downloadUrl, true);
        Assert.Equal(200, downloaded.Code);
        Assert.Equal("application/vnd.apple.pkpass", downloaded.Header("Content-Type"));
        Assert.Equal(pass.Bytes, await downloaded.Response.Content.ReadAsByteArrayAsync());
        Assert.Equal($"\"{pass.Revision}\"", downloaded.Header("ETag"));
        Assert.Equal(304, (await Invoke(HttpMethod.Get, downloadUrl, true, headers: new() { ["If-None-Match"] = downloaded.Header("ETag")! })).Code);
        Assert.Equal(304, (await Invoke(HttpMethod.Get, downloadUrl, true, headers: new() { ["If-Modified-Since"] = downloaded.Header("Last-Modified")! })).Code);
        Assert.Equal(200, (await Invoke(HttpMethod.Get, downloadUrl, true, headers: new() { ["If-None-Match"] = "\"stale\"" })).Code);

        await f.PostTap(a, NativeFixture.Tap(31, uid));
        var updated = (await Invoke(HttpMethod.Get, $"{changesUrl}?passesUpdatedSince={lastUpdated}")).Json;
        var updatedTag = updated.GetProperty("lastUpdated").GetString()!;
        Assert.True(long.Parse(updatedTag) > long.Parse(lastUpdated));

        var newOrigin = new NativeWallet(f.Services.Store, f.Services.Wallet.Options with { BaseUrl = "https://replacement.example.test" });
        var republished = await newOrigin.Publish(pass.Serial);
        Assert.Equal(pass.Token, republished.Token);
        Assert.True(republished.ChangeTag > long.Parse(updatedTag), "origin-only republication advances the Wallet update cursor");
        Assert.Equal([pass.Serial.ToString()], (await newOrigin.Changes(device, PassType, updatedTag))?.SerialNumbers);
        await f.Services.Wallet.Publish(pass.Serial);

        f.PushState = "offline";
        try
        {
            Assert.Equal(1, await f.Services.Wallet.Flush());
            Assert.Equal(1, await f.Db.Scalar<int>("SELECT attempts FROM native_wallet_jobs WHERE device=$1", device));
            Assert.True(await f.Db.Scalar<long>("SELECT next_attempt FROM native_wallet_jobs WHERE device=$1", device) > DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            await Invoke(HttpMethod.Post, registration, true, new { pushToken = new string('b', 64) });
            Assert.Equal(0, await f.Db.Scalar<int>("SELECT attempts FROM native_wallet_jobs WHERE device=$1", device));
            f.PushState = "invalid";
            await f.Services.Wallet.Flush();
            Assert.Equal(0L, await f.Db.Scalar<long>("SELECT count(*) FROM native_wallet_devices WHERE device=$1", device));
            Assert.Equal(0L, await f.Db.Scalar<long>("SELECT count(*) FROM native_wallet_registrations WHERE device=$1", device));
        }
        finally { f.PushState = "ok"; }
        Assert.Equal(201, (await Invoke(HttpMethod.Post, registration, true, new { pushToken })).Code);
        Assert.Equal(200, (await Invoke(HttpMethod.Delete, registration, true)).Code);
        Assert.Equal(0L, await f.Db.Scalar<long>("SELECT count(*) FROM native_wallet_jobs WHERE device=$1", device));
        Assert.Equal(200, (await Invoke(HttpMethod.Post, "/wallet/v1/log", json: new { logs = new[] { "Fixture diagnostics deliberately not logged" } })).Code);
    }

    [Fact]
    public async Task WalletPublicationCursorsCannotOvertakeAnUncommittedChangeOnAnotherCard()
    {
        await using var firstPool = f.Db.NewPool(maxPoolSize: 1);
        await using var secondPool = f.Db.NewPool(maxPoolSize: 1);
        await using var gate = await f.Db.Pool.OpenConnectionAsync();
        const string gateKey = "hashtext('joeyy.test.native-wallet.publication-gate'),hashtext(current_schema())";
        const string device = "cursor-order-device";
        var rendered = new ConcurrentQueue<Guid>();
        var options = f.Services.Wallet.Options with
        {
            Render = (card, token) => { rendered.Enqueue(card.Id); return f.Services.Wallet.Options.Render(card, token); },
        };
        var firstWallet = new NativeWallet(new NativeStore(firstPool), options);
        var secondWallet = new NativeWallet(new NativeStore(secondPool), options);
        Guid[] serials = [Guid.NewGuid(), Guid.NewGuid()];
        var publications = new List<Task<PassRow>>();
        bool gateHeld = false, triggerInstalled = false;

        async Task<int> Pid(Npgsql.NpgsqlDataSource pool)
        {
            await using var connection = await pool.OpenConnectionAsync();
            return (await connection.QueryFirst("SELECT pg_backend_pid()", reader => reader.GetInt32(0)))!;
        }
        async Task WaitForAdvisoryBlock(int waiter, int holder)
        {
            var deadline = DateTime.UtcNow.AddSeconds(5);
            do
            {
                var blocked = await f.Db.Scalar<bool>(
                    """
                    SELECT EXISTS(
                        SELECT 1 FROM pg_locks w JOIN pg_locks h
                          ON h.locktype=w.locktype AND h.database=w.database AND h.classid=w.classid
                         AND h.objid=w.objid AND h.objsubid=w.objsubid
                        WHERE w.locktype='advisory' AND w.pid=$1 AND h.pid=$2 AND NOT w.granted AND h.granted)
                    """, waiter, holder);
                if (blocked) return;
                await Task.Delay(10);
            } while (DateTime.UtcNow < deadline);
            Assert.Fail($"Expected PostgreSQL backend {waiter} to wait for an advisory lock held by {holder}.");
        }

        try
        {
            for (var index = 0; index < serials.Length; index++)
            {
                var account = await f.Services.Store.Signup($"cursor-order-{index}", NativeFixture.Password);
                var customer = await f.Services.Store.Authenticate($"Bearer {account.Token}");
                await f.Db.Execute("INSERT INTO native_cards(id,customer_id,cafe_id,stamps,updated_at) VALUES($1,$2,$3,1,$4)",
                    serials[index], customer.Id, f.CafeId, DateTime.UtcNow.ToString("O"));
                await f.Services.Wallet.Publish(serials[index]);
                await f.Services.Wallet.Register(device, serials[index], new string('d', 64));
            }
            var baseline = await f.Services.Wallet.Changes(device, PassType, null);
            Assert.NotNull(baseline);
            await f.Db.Execute("UPDATE native_cards SET version=version+1 WHERE id=ANY($1)", serials);
            await f.Db.Execute(
                $"""
                CREATE FUNCTION test_wallet_publication_gate() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN
                    PERFORM pg_advisory_xact_lock({gateKey});
                    RETURN NEW;
                END;
                $$;
                CREATE TRIGGER test_wallet_publication_gate AFTER UPDATE ON native_wallet_passes
                FOR EACH ROW WHEN (NEW.serial='{serials[0]}'::uuid AND NEW.change_tag<>OLD.change_tag)
                EXECUTE FUNCTION test_wallet_publication_gate();
                """);
            triggerInstalled = true;
            await gate.Execute($"SELECT pg_advisory_lock({gateKey})");
            gateHeld = true;
            var gatePid = (await gate.QueryFirst("SELECT pg_backend_pid()", reader => reader.GetInt32(0)))!;
            var firstPid = await Pid(firstPool);
            var secondPid = await Pid(secondPool);

            var firstPublication = firstWallet.Publish(serials[0]);
            publications.Add(firstPublication);
            // AFTER UPDATE means the first publication has already allocated its new sequence value.
            await WaitForAdvisoryBlock(firstPid, gatePid);
            var secondPublication = secondWallet.Publish(serials[1]);
            publications.Add(secondPublication);
            await WaitForAdvisoryBlock(secondPid, firstPid);
            Assert.True(rendered.SequenceEqual(serials), "different-card rendering completes before the global publication lock");
            Assert.True(await f.Services.Wallet.Changes(device, PassType, baseline.LastUpdated) is null,
                "a polling device cannot advance its cursor past the first card's uncommitted change");

            await gate.Execute($"SELECT pg_advisory_unlock({gateKey})");
            gateHeld = false;
            var first = await firstPublication.WaitAsync(TimeSpan.FromSeconds(10));
            var second = await secondPublication.WaitAsync(TimeSpan.FromSeconds(10));
            Assert.True(first.ChangeTag < second.ChangeTag);
            var changes = await f.Services.Wallet.Changes(device, PassType, baseline.LastUpdated);
            Assert.Equal(serials.Select(serial => serial.ToString()), changes?.SerialNumbers);
            Assert.Equal(second.ChangeTag.ToString(System.Globalization.CultureInfo.InvariantCulture), changes?.LastUpdated);
            Assert.Null(await f.Services.Wallet.Changes(device, PassType, changes?.LastUpdated));
        }
        finally
        {
            if (gateHeld) await gate.Execute($"SELECT pg_advisory_unlock({gateKey})");
            try { await Task.WhenAll(publications).WaitAsync(TimeSpan.FromSeconds(10)); } catch { /* reported above */ }
            if (triggerInstalled)
            {
                await f.Db.Execute("DROP TRIGGER test_wallet_publication_gate ON native_wallet_passes; DROP FUNCTION test_wallet_publication_gate()");
            }
            foreach (var serial in serials) await f.Services.Wallet.Unregister(device, serial);
        }
    }

    [Fact]
    public async Task BodyLimitsMalformedJsonAndSensitivePathsAreNeverLogged()
    {
        Assert.Equal(413, (await f.App.Post("/wallet/v1/log", null, new { logs = new[] { new string('x', 17_000) } })).Code);
        var malformed = await f.App.Send(HttpMethod.Post, "/api/v1/accounts", rawBody: "{");
        Assert.Equal(400, malformed.Code);
        JsonAssert.Equal(new { error = "The request body couldn't be read." }, malformed.Json);
        Assert.Equal(400, (await f.App.Send(HttpMethod.Post, "/wallet/v1/log", rawBody: "[]")).Code);
        Assert.Equal(415, (await f.App.Send(HttpMethod.Post, "/api/v1/accounts", rawBody: "<x/>", contentType: "application/xml")).Code);

        var logs = new CapturingLogs();
        var token = await f.Account("logged-native");
        // The verifier failure carries the chip URL in its exception, as a real upstream error might.
        var leaky = f.Services with { Verify = url => throw new InvalidOperationException($"upstream failed for {url}") };
        await using (var logged = await TestApp.Start(f.Db.Pool, leaky, logs))
        {
            await logged.Post($"/wallet/v1/devices/secret-device/registrations/{PassType}/{Guid.NewGuid()}", null, new { pushToken = new string('c', 64) });
            await logged.Post("/wallet/v1/log", null, new { logs = new[] { "secret-diagnostic" } });
            var failed = await logged.Post("/api/v1/taps", token, new { url = "https://expired-host.example/tagtt?e=5ec7e7c41b", requestId = Guid.NewGuid() });
            Assert.Equal(500, failed.Code);
        }
        Assert.Contains(logs.Lines, line => line.Contains("Native API operation failed"));
        Assert.DoesNotContain(logs.Lines, line => line.Contains("secret-device") || line.Contains("secret-diagnostic") ||
            line.Contains("cccccccc") || line.Contains("5ec7e7c41b") || line.Contains(token));
    }

    [Fact]
    public async Task UnexpectedErrorsReturnAGeneric500WithoutDetails()
    {
        var logs = new CapturingLogs();
        await using var broken = await TestApp.Start(f.Db.Pool, f.Services with { Verify = _ => throw new InvalidOperationException("internal-secret-detail") }, logs);
        var uid = await f.NewTag();
        var signup = await broken.Post("/api/v1/accounts", null, new { username = "broken-verifier", password = NativeFixture.Password });
        var response = await f.App.Send(HttpMethod.Post, "/api/v1/taps", signup.Json.GetProperty("token").GetString(), new { url = NativeFixture.Tap(1, uid).Url, requestId = Guid.NewGuid() });
        Assert.Equal(200, response.Code); // the normal app still works
        var failing = await broken.Send(HttpMethod.Post, "/api/v1/taps", signup.Json.GetProperty("token").GetString(), new { url = NativeFixture.Tap(2, uid).Url, requestId = Guid.NewGuid() });
        Assert.Equal(500, failing.Code);
        JsonAssert.Equal(new { error = "The service could not complete this request. Retry safely." }, failing.Json);
        Assert.DoesNotContain(logs.Lines, line => line.Contains("internal-secret-detail"));
    }

    [Fact]
    public async Task RateLimitsReturn429WithAnErrorMessage()
    {
        await using var limited = await TestApp.Start(f.Db.Pool, f.Services with { RequestLimit = 2 });
        Assert.Equal(200, (await limited.Get("/api/v1/healthz")).Code);
        Assert.Equal(200, (await limited.Get("/api/v1/healthz")).Code);
        var blocked = await limited.Get("/api/v1/healthz");
        Assert.Equal(429, blocked.Code);
        JsonAssert.Equal(new { error = "Too many requests. Try again later." }, blocked.Json);
    }

    [Fact]
    public async Task WorkerCatchesTransientFailuresRetriesDirtyPublicationsAndStopsCleanly()
    {
        var uid = await f.NewTag();
        var a = await f.Account("worker-native");
        var customer = await f.Services.Store.Authenticate($"Bearer {a}");
        var request = NativeFixture.Tap(40, uid);
        await f.Services.Store.Award(customer.Id, Guid.Parse(request.RequestId), request.Url, new VerifiedTag(uid, 40));
        var warnings = 0;
        Guid cardId;
        f.SigningBroken = true;
        var worker = NativeWorker.Start(f.Services, _ => Interlocked.Increment(ref warnings), TimeSpan.FromMilliseconds(20));
        try
        {
            var deadline = DateTime.UtcNow.AddSeconds(5);
            while (warnings == 0 && DateTime.UtcNow < deadline) await Task.Delay(20);
            Assert.True(warnings > 0);
            f.SigningBroken = false;
            cardId = (await f.Services.Store.Cards(customer.Id))[0].Id;
            while (DateTime.UtcNow < deadline &&
                   await f.Db.Scalar<long>("SELECT count(*) FROM native_wallet_passes WHERE serial=$1 AND bytes IS NOT NULL", cardId) == 0)
            {
                await Task.Delay(20);
            }
        }
        finally
        {
            f.SigningBroken = false;
            await worker.DisposeAsync();
        }
        var card = (await f.Services.Store.Cards(customer.Id))[0];
        Assert.True(card.Version == await f.Db.Scalar<long>("SELECT version FROM native_wallet_passes WHERE serial=$1", cardId),
            "the worker, not a foreground publish, completed reconciliation");
    }
}
