using System.Security.Cryptography;
using System.Text;
using Joeyy.Api.Infrastructure;
using Joeyy.Api.Native;
using Joeyy.Api.Tests.Support;

namespace Joeyy.Api.Tests;

public sealed class PrototypeFixture : IAsyncLifetime
{
    public const string Uid = "04DE5F1EACC040";
    public const string Password = "ordinary-fixture-password";
    public TestDatabase Db { get; private set; } = null!;
    public StubVerifier Verifier { get; private set; } = null!;
    public NativeServices Services { get; private set; } = null!;
    public TestApp App { get; private set; } = null!;
    /// <summary>The same database with prototype mode off, like a server restarted without it.</summary>
    public TestApp AccountApp { get; private set; } = null!;
    public CapturingLogs Logs { get; } = new();
    public HttpClient Http { get; } = new(new SocketsHttpHandler { AllowAutoRedirect = false });
    public volatile bool SigningBroken = true;
    public int RenderCalls;
    private int nextCounter = 1;

    public async Task InitializeAsync()
    {
        Db = await TestDatabase.Create();
        Verifier = await StubVerifier.Start();
        var store = new NativeStore(Db.Pool, prototypeMode: true);
        var wallet = new NativeWallet(store, new WalletOptions("https://prototype.example.test", "pass.com.example.prototype", Render, _ => Task.FromResult(false)));
        var verifier = new VerifierClient(Http, Verifier.Url);
        Services = new NativeServices
        {
            Store = store, Wallet = wallet, PrototypeMode = true, FactoryTest = true, Verify = verifier.Verify,
            RequestLimit = 1_000_000, LoginLimit = 1_000_000,
        };
        App = await TestApp.Start(Db.Pool, Services, Logs);
        var ordinary = new NativeStore(Db.Pool);
        AccountApp = await TestApp.Start(Db.Pool, Services with { PrototypeMode = false, Store = ordinary, Wallet = new NativeWallet(ordinary, wallet.Options) });
        var cafe = Guid.NewGuid();
        await Db.Execute("INSERT INTO native_cafes(id,name,target) VALUES($1,'Anonymous hardware-test cafe',3)", cafe);
        await Db.Execute("INSERT INTO native_tags(uid,cafe_id) VALUES($1,$2)", Uid, cafe);
    }

    private Task<byte[]> Render(NativeCard card, string token)
    {
        Interlocked.Increment(ref RenderCalls);
        return SigningBroken ? throw new InvalidOperationException("Fixture signer offline") : Task.FromResult(Encoding.UTF8.GetBytes($"fixture-pass:{card.Id}:{card.Version}"));
    }

    public sealed record Read(string Url, string RequestId, int Counter, string Ciphertext);

    /// <summary>A fresh chip read whose opaque ciphertext the stub verifier will accept once configured.</summary>
    public Read NewRead()
    {
        var counter = Interlocked.Increment(ref nextCounter) - 1;
        var ciphertext = RandomNumberGenerator.GetHexString(32, lowercase: true);
        Verifier.Responses[ciphertext] = (200, new { uid = Uid, read_ctr = counter, enc_mode = "AES" });
        return new Read($"https://expired-host.example/tagtt?e={ciphertext}", Guid.NewGuid().ToString(), counter, ciphertext);
    }

    public async Task<(string Token, string Username, bool Prototype)> Start(string? token = null)
    {
        var response = await App.Post("/api/v1/prototype/session", token);
        Assert.True(response.Code == 200, response.Body);
        var json = response.Json;
        return (json.GetProperty("token").GetString()!, json.GetProperty("username").GetString()!, json.GetProperty("prototype").GetBoolean());
    }

    public Task<Reply> Tap(string token, Read read) => App.Post("/api/v1/taps", token, new { url = read.Url, requestId = read.RequestId });

    public Task<long> CustomerCount() => Db.Scalar<long>("SELECT count(*) FROM native_customers");

    public async Task DisposeAsync()
    {
        await App.DisposeAsync();
        await AccountApp.DisposeAsync();
        await Verifier.DisposeAsync();
        await Db.DisposeAsync();
        Http.Dispose();
    }
}

public sealed class PrototypeTests(PrototypeFixture f) : IClassFixture<PrototypeFixture>
{
    [Fact]
    public async Task PrototypeModeIsExplicitAndOffByDefault()
    {
        Assert.Equal(404, (await f.AccountApp.Post("/api/v1/prototype/session")).Code);
        Assert.True((await f.App.Get("/api/v1/healthz")).Json.GetProperty("prototypeMode").GetBoolean());
        Assert.False((await f.AccountApp.Get("/api/v1/healthz")).Json.GetProperty("prototypeMode").GetBoolean());
    }

    [Fact]
    public async Task Migration0005IsAdditiveAndPreservesExistingCredentialsAndSession()
    {
        await using var target = await TestDatabase.Create();
        var store = new NativeStore(target.Pool);
        var account = await store.Signup("before-prototype", PrototypeFixture.Password);
        var customer = await store.Authenticate($"Bearer {account.Token}");
        const string snapshot = "SELECT id::text||username||salt||password_hash FROM native_customers";
        var before = await target.Scalar<string>(snapshot);
        await target.Execute("ALTER TABLE native_customers DROP COLUMN is_prototype; DELETE FROM schema_migrations WHERE version='0005_native_prototype'");
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => NativeReadiness.Assert(target.Pool));
        Assert.Contains("0005_native_prototype", error.Message);
        Assert.Equal(["0005_native_prototype"], await Migrator.Migrate(target.Pool));
        await NativeReadiness.Assert(target.Pool);
        Assert.Equal(before, await target.Scalar<string>(snapshot));
        var again = await store.Authenticate($"Bearer {account.Token}");
        Assert.Equal(customer.Id, again.Id);
        Assert.False(again.IsPrototype);
        Assert.Equal(account.Username, (await store.Login("before-prototype", PrototypeFixture.Password)).Username);
    }

    [Fact]
    public async Task AnonymousSessionCreatesOneMarkedTechnicalOwnerWithAnOpaqueHashedSession()
    {
        var before = await f.CustomerCount();
        var response = await f.App.Post("/api/v1/prototype/session");
        Assert.Equal(["prototype", "token", "username"], JsonAssert.Keys(response.Json));
        var guest = await f.Start();
        Assert.True(guest.Prototype);
        Assert.Matches("^nfc-[0-9a-f]{32}$", guest.Username);
        Assert.Matches("^[0-9a-f]{64}$", guest.Token);
        var customer = await f.Services.Store.Authenticate($"Bearer {guest.Token}");
        Assert.True(customer.IsPrototype);
        Assert.True(await f.Db.Scalar<bool>("SELECT is_prototype FROM native_customers WHERE id=$1", customer.Id));
        Assert.Matches("^[0-9a-f]{32}$", await f.Db.Scalar<string>("SELECT salt FROM native_customers WHERE id=$1", customer.Id));
        Assert.Matches("^[0-9a-f]{128}$", await f.Db.Scalar<string>("SELECT password_hash FROM native_customers WHERE id=$1", customer.Id));
        Assert.Equal(0L, await f.Db.Scalar<long>("SELECT count(*) FROM native_sessions WHERE hash=$1", guest.Token));
        Assert.Equal(2, await f.CustomerCount() - before);
        JsonAssert.Equal(new { cards = Array.Empty<object>() }, (await f.App.Get("/api/v1/cards", guest.Token)).Json);
        Assert.Equal(401, (await f.App.Post("/api/v1/sessions", null, new { username = guest.Username, password = PrototypeFixture.Password })).Code);
        Assert.Equal(400, (await f.App.Post("/api/v1/prototype/session", null, new { username = "not-an-account", password = PrototypeFixture.Password })).Code);
        Assert.Equal(2, await f.CustomerCount() - before);
    }

    [Fact]
    public async Task ResumeRenewsAnExpiredGuestTokenWithoutReplacingIdentityCardsOrPendingRequests()
    {
        var guest = await f.Start();
        var customer = await f.Services.Store.Authenticate($"Bearer {guest.Token}");
        var firstRead = f.NewRead();
        var first = await f.Tap(guest.Token, firstRead);
        Assert.True(first.Code == 200, first.Body);
        var earned = first.Json;
        await f.Db.Execute("UPDATE native_sessions SET expires=0 WHERE hash=$1", NativeStore.Digest(guest.Token));
        Assert.Equal(401, (await f.App.Get("/api/v1/cards", guest.Token)).Code);
        var before = await f.CustomerCount();
        var callsBefore = f.Verifier.Requests;
        var resumed = await f.Start(guest.Token);
        Assert.Equal(guest, resumed);
        Assert.Equal(customer.Id, (await f.Services.Store.Authenticate($"Bearer {resumed.Token}")).Id);
        Assert.Equal(1L, await f.Db.Scalar<long>("SELECT count(*) FROM native_sessions WHERE customer_id=$1", customer.Id));
        Assert.True(await f.Db.Scalar<long>("SELECT expires FROM native_sessions WHERE hash=$1", NativeStore.Digest(guest.Token)) > DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());

        var retried = (await f.Tap(resumed.Token, firstRead)).Json;
        Assert.Equal(earned.GetProperty("eventId").GetString(), retried.GetProperty("eventId").GetString());
        Assert.Equal(earned.GetProperty("card").GetProperty("id").GetString(), retried.GetProperty("card").GetProperty("id").GetString());
        Assert.Equal(1, retried.GetProperty("card").GetProperty("stamps").GetInt32());
        Assert.True(retried.GetProperty("duplicate").GetBoolean());
        JsonAssert.Equal(new { verified = true, counter = firstRead.Counter }, retried.GetProperty("verification"));
        Assert.Equal(callsBefore, f.Verifier.Requests);

        Assert.Equal(2, (await f.Tap(resumed.Token, f.NewRead())).Json.GetProperty("card").GetProperty("stamps").GetInt32());
        var oldRetry = (await f.Tap(resumed.Token, firstRead)).Json;
        Assert.True(oldRetry.GetProperty("card").GetProperty("stamps").GetInt32() == 2, "retry returns current card, not a stale balance");
        JsonAssert.Equal(new { verified = true, counter = firstRead.Counter }, oldRetry.GetProperty("verification"));
        var concurrent = await Task.WhenAll(f.Start(guest.Token), f.Start(guest.Token));
        Assert.All(concurrent, session => Assert.Equal(guest, session));
        Assert.Equal(before, await f.CustomerCount());
    }

    [Fact]
    public async Task InvalidRevokedAndRegularAccountTokensNeverResumeOrCreateAnotherGuest()
    {
        var regular = (await f.App.Post("/api/v1/accounts", null, new { username = "regular-prototype-test", password = PrototypeFixture.Password })).Json;
        var regularToken = regular.GetProperty("token").GetString()!;
        Assert.False((await f.Services.Store.Authenticate($"Bearer {regularToken}")).IsPrototype);
        var guest = await f.Start();
        var before = await f.CustomerCount();
        Assert.Equal(401, (await f.App.Post("/api/v1/prototype/session", regularToken)).Code);
        Assert.Equal(401, (await f.App.Post("/api/v1/prototype/session", new string('0', 64))).Code);
        Assert.Equal(401, (await f.App.SendRaw("POST", "/api/v1/prototype/session", context => context.Request.Headers.Authorization = "")).Status);
        Assert.Equal(401, (await f.App.Post("/api/v1/prototype/session", "invalid-token")).Code);
        Assert.Equal(204, (await f.App.Delete("/api/v1/session", guest.Token)).Code);
        Assert.Equal(401, (await f.App.Post("/api/v1/prototype/session", guest.Token)).Code);
        Assert.Equal(before, await f.CustomerCount());
        Assert.Equal(200, (await f.App.Post("/api/v1/sessions", null, new { username = "regular-prototype-test", password = PrototypeFixture.Password })).Code);
        Assert.Equal(200, (await f.AccountApp.Get("/api/v1/cards", regularToken)).Code);
        // An expired ordinary token is not eligible for prototype renewal either.
        await f.Db.Execute("UPDATE native_sessions SET expires=0 WHERE hash=$1", NativeStore.Digest(regularToken));
        Assert.Equal(401, (await f.App.Post("/api/v1/prototype/session", regularToken)).Code);
        Assert.Equal(before, await f.CustomerCount());
    }

    [Fact]
    public async Task TurningPrototypeModeOffRejectsRetainedGuestTokensOnEveryRoute()
    {
        var guest = await f.Start();
        var callsBefore = f.Verifier.Requests;
        Assert.Equal(401, (await f.AccountApp.Get("/api/v1/cards", guest.Token)).Code);
        Assert.Equal(401, (await f.AccountApp.Get($"/api/v1/cards/{Guid.NewGuid()}/pass", guest.Token)).Code);
        Assert.Equal(401, (await f.AccountApp.Delete("/api/v1/session", guest.Token)).Code);
        Assert.Equal(401, (await f.AccountApp.Post("/api/v1/taps", guest.Token, new { url = "https://expired-host.example/tagtt?e=0011", requestId = Guid.NewGuid() })).Code);
        Assert.Equal(401, (await Assert.ThrowsAsync<HttpError>(() => new NativeStore(f.Db.Pool).Authenticate($"Bearer {guest.Token}"))).Status);
        Assert.Equal(404, (await Assert.ThrowsAsync<HttpError>(() => new NativeStore(f.Db.Pool).PrototypeSession($"Bearer {guest.Token}"))).Status);
        Assert.Equal(callsBefore, f.Verifier.Requests);
        Assert.Equal(guest, await f.Start(guest.Token));
    }

    [Fact]
    public async Task TwoGuestsOwnIsolatedCardsWhileChipCountersStayGlobal()
    {
        var a = await f.Start();
        var b = await f.Start();
        var firstRead = f.NewRead();
        var first = (await f.Tap(a.Token, firstRead)).Json;
        Assert.Equal(409, (await f.Tap(b.Token, firstRead with { RequestId = Guid.NewGuid().ToString() })).Code);
        var second = (await f.Tap(b.Token, f.NewRead() with { RequestId = firstRead.RequestId })).Json;
        Assert.Equal(1, first.GetProperty("card").GetProperty("stamps").GetInt32());
        Assert.Equal(1, second.GetProperty("card").GetProperty("stamps").GetInt32());
        var firstId = first.GetProperty("card").GetProperty("id").GetString();
        Assert.NotEqual(firstId, second.GetProperty("card").GetProperty("id").GetString());
        Assert.Equal(firstId, (await f.App.Get("/api/v1/cards", a.Token)).Json.GetProperty("cards")[0].GetProperty("id").GetString());
        Assert.Equal(second.GetProperty("card").GetProperty("id").GetString(), (await f.App.Get("/api/v1/cards", b.Token)).Json.GetProperty("cards")[0].GetProperty("id").GetString());
        Assert.Equal(404, (await f.App.Get($"/api/v1/cards/{firstId}/pass", b.Token)).Code);
    }

    [Fact]
    public async Task TamperedCiphertextForgedMetadataAndInvalidVerifierOutputNeverAwardOrAdvanceCounters()
    {
        var guest = await f.Start();
        var value = f.NewRead();
        var before = await f.Db.Scalar<int>("SELECT last_counter FROM native_tags WHERE uid=$1", PrototypeFixture.Uid);
        var invalid = await f.App.Post("/api/v1/taps", guest.Token, new
        {
            url = $"https://expired-host.example/tagtt?e={RandomNumberGenerator.GetHexString(32, lowercase: true)}",
            requestId = Guid.NewGuid(), verification = new { verified = true, counter = 9999 },
        });
        Assert.True(invalid.Code == 422, "HTTP-200 verifier error bodies are never successful reads");
        Assert.Equal(400, (await f.App.Post("/api/v1/taps", guest.Token, new { url = "https://expired-host.example/tagtt?uid=04DE5F1EACC040&counter=9999", requestId = Guid.NewGuid() })).Code);
        foreach (var url in new[]
        {
            "http://expired-host.example/tagtt?e=0011", "https://expired-host.example/other?e=0011", "not a url",
            "https://expired-host.example/tagtt?e=0011&e=0022", "https://expired-host.example/tagtt?e=zz", "https://expired-host.example/tagtt?e=001",
            "https://expired-host.example/tagtt?picc_data=0011",
        })
        {
            Assert.Equal(400, (await f.App.Post("/api/v1/taps", guest.Token, new { url, requestId = Guid.NewGuid() })).Code);
        }
        f.Verifier.Responses[value.Ciphertext] = (200, new { uid = "invalid", read_ctr = value.Counter, enc_mode = "AES" });
        Assert.Equal(502, (await f.Tap(guest.Token, value)).Code);
        f.Verifier.Responses[value.Ciphertext] = (200, new { uid = PrototypeFixture.Uid, read_ctr = 1.5, enc_mode = "AES" });
        Assert.Equal(502, (await f.Tap(guest.Token, value)).Code);
        f.Verifier.Responses[value.Ciphertext] = (503, new { error = "fixture unavailable" });
        Assert.Equal(503, (await f.Tap(guest.Token, value)).Code);
        JsonAssert.Equal(new { cards = Array.Empty<object>() }, (await f.App.Get("/api/v1/cards", guest.Token)).Json);
        Assert.Equal(before, await f.Db.Scalar<int>("SELECT last_counter FROM native_tags WHERE uid=$1", PrototypeFixture.Uid));
        var customer = await f.Services.Store.Authenticate($"Bearer {guest.Token}");
        Assert.Equal(0L, await f.Db.Scalar<long>("SELECT count(*) FROM native_events WHERE customer_id=$1", customer.Id));
    }

    [Fact]
    public async Task FreshVerifiedReadsCountThroughRolloverWithAccumulatedRewardsDespiteSigningFailure()
    {
        var guest = await f.Start();
        var callsBefore = f.RenderCalls;
        int[] stamps = [1, 2, 3, 1, 2, 3, 1], rewards = [0, 0, 1, 1, 1, 2, 2];
        string? serial = null;
        for (var index = 0; index < stamps.Length; index++)
        {
            var value = f.NewRead();
            var response = await f.Tap(guest.Token, value);
            Assert.True(response.Code == 200, response.Body);
            var result = response.Json;
            Assert.Equal(["card", "duplicate", "eventId", "verification"], JsonAssert.Keys(result));
            JsonAssert.Equal(new { verified = true, counter = value.Counter }, result.GetProperty("verification"));
            Assert.Equal(stamps[index], result.GetProperty("card").GetProperty("stamps").GetInt32());
            Assert.Equal(rewards[index], result.GetProperty("card").GetProperty("rewardsAvailable").GetInt32());
            if (serial is not null) Assert.Equal(serial, result.GetProperty("card").GetProperty("id").GetString());
            serial = result.GetProperty("card").GetProperty("id").GetString();
            var retried = (await f.Tap(guest.Token, value)).Json;
            Assert.Equal(result.GetProperty("eventId").GetString(), retried.GetProperty("eventId").GetString());
            Assert.True(retried.GetProperty("duplicate").GetBoolean());
            Assert.Equal(stamps[index], retried.GetProperty("card").GetProperty("stamps").GetInt32());
            Assert.Equal(409, (await f.Tap(guest.Token, value with { RequestId = Guid.NewGuid().ToString() })).Code);
        }
        Assert.True(callsBefore == f.RenderCalls, "guest taps never synchronously invoke Wallet publication");
        Assert.Equal(0L, await f.Db.Scalar<long>("SELECT count(*) FROM native_wallet_passes WHERE serial=$1", Guid.Parse(serial!)));
    }

    [Fact]
    public async Task ConcurrentGuestRetriesAreAtomicAndCarryPersistedVerificationMetadata()
    {
        var guest = await f.Start();
        var value = f.NewRead();
        var callsBefore = f.RenderCalls;
        var responses = await Task.WhenAll(f.Tap(guest.Token, value), f.Tap(guest.Token, value));
        Assert.All(responses, response => Assert.Equal(200, response.Code));
        var results = responses.Select(response => response.Json).ToList();
        Assert.Equal(results[0].GetProperty("eventId").GetString(), results[1].GetProperty("eventId").GetString());
        Assert.Single(results, result => !result.GetProperty("duplicate").GetBoolean());
        foreach (var result in results)
        {
            Assert.Equal(1, result.GetProperty("card").GetProperty("stamps").GetInt32());
            JsonAssert.Equal(new { verified = true, counter = value.Counter }, result.GetProperty("verification"));
        }
        Assert.Equal(callsBefore, f.RenderCalls);
        Assert.Equal(409, (await f.Tap(guest.Token, f.NewRead() with { RequestId = value.RequestId })).Code);
    }

    [Fact]
    public async Task NormalAccountsKeepTheirTapContractWhileGuestPassesStayManuallyPublishable()
    {
        var regular = (await f.App.Post("/api/v1/accounts", null, new { username = "ordinary-wallet-test", password = PrototypeFixture.Password })).Json.GetProperty("token").GetString()!;
        var value = f.NewRead();
        Assert.Equal(503, (await f.Tap(regular, value)).Code);
        Assert.Equal(1, (await f.App.Get("/api/v1/cards", regular)).Json.GetProperty("cards")[0].GetProperty("stamps").GetInt32());
        f.SigningBroken = false;
        try
        {
            var retried = await f.Tap(regular, value);
            Assert.Equal(200, retried.Code);
            Assert.Equal(["card", "duplicate", "eventId"], JsonAssert.Keys(retried.Json));
            Assert.True(retried.Json.GetProperty("duplicate").GetBoolean());
            Assert.Equal(1, retried.Json.GetProperty("card").GetProperty("stamps").GetInt32());
            var guest = await f.Start();
            var earned = (await f.Tap(guest.Token, f.NewRead())).Json;
            var downloaded = await f.App.Get($"/api/v1/cards/{earned.GetProperty("card").GetProperty("id").GetString()}/pass", guest.Token);
            Assert.Equal(200, downloaded.Code);
            Assert.StartsWith("fixture-pass:", downloaded.Body);
            await f.Services.Wallet.Reconcile(() => Assert.Fail("Unexpected fixture publication failure"));
            Assert.DoesNotContain(f.Logs.Lines, line => line.Contains(guest.Token) || line.Contains(regular) || line.Contains(value.Ciphertext) || line.Contains(PrototypeFixture.Password));
        }
        finally { f.SigningBroken = true; }
    }
}
