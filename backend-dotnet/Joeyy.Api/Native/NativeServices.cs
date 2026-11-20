using Joeyy.Api.Infrastructure;
using Npgsql;

namespace Joeyy.Api.Native;

/// <summary>Everything the native routes need. Tests swap in fakes for Verify, Render and SendPush.</summary>
public sealed record NativeServices
{
    public required NativeStore Store { get; init; }
    public required NativeWallet Wallet { get; init; }
    public required Func<string, Task<VerifiedTag>> Verify { get; init; }
    public required bool FactoryTest { get; init; }
    public required bool PrototypeMode { get; init; }
    /// <summary>Confirms the private SDM verifier answers, so health checks catch a broken verifier before real taps do.</summary>
    public Func<Task>? VerifierReady { get; init; }
    /// <summary>Requests per client IP per minute on every native route.</summary>
    public int RequestLimit { get; init; } = 120;
    /// <summary>Sign-in and session starts per client IP per 15 minutes.</summary>
    public int LoginLimit { get; init; } = 10;

    public static NativeServices Create(NpgsqlDataSource pool, NativeConfig config, HttpClient verifierHttp, ApplePush push)
    {
        var store = new NativeStore(pool, config.PrototypeMode);
        var renderer = new PassRenderer(config);
        var wallet = new NativeWallet(store, new WalletOptions(config.BaseUrl, config.PassType, renderer.Render, push.Send));
        var verifier = new VerifierClient(verifierHttp, config.VerifierUrl);
        return new NativeServices
        {
            Store = store,
            Wallet = wallet,
            Verify = verifier.Verify,
            FactoryTest = config.FactoryTest,
            PrototypeMode = config.PrototypeMode,
            VerifierReady = verifier.Ready,
        };
    }
}

public static class NativeReadiness
{
    private static readonly string[] Tables =
    [
        "native_customers", "native_sessions", "native_cafes", "native_tags", "native_cards", "native_events",
        "native_wallet_passes", "native_wallet_devices", "native_wallet_registrations", "native_wallet_jobs",
    ];

    /// <summary>Same checks as assertNativeReady in backend/src/native/index.ts. Migrations never run at startup.</summary>
    public static async Task Assert(NpgsqlDataSource pool)
    {
        await using var db = await pool.OpenConnectionAsync();
        if (!await db.QueryFirst("SELECT 1 FROM schema_migrations WHERE version='0004_native_nfc'", _ => true))
        {
            throw new InvalidOperationException("Native NFC requires explicit migration 0004_native_nfc; run the migrate command as the schema owner.");
        }
        if (!await db.QueryFirst("SELECT 1 FROM schema_migrations WHERE version='0005_native_prototype'", _ => true))
        {
            throw new InvalidOperationException("Native NFC requires explicit migration 0005_native_prototype; run the migrate command as the schema owner.");
        }
        await db.Execute("SELECT is_prototype FROM native_customers WHERE false");
        await db.Execute(string.Join(" UNION ALL ", Tables.Select(table => $"SELECT 1 FROM {table} WHERE false")));
    }
}

/// <summary>
/// Every <c>interval</c>: republish passes whose card changed, then send queued APNs pushes. One run at a time.
/// Mirrors scheduleNativeWorker in backend/src/native/index.ts.
/// </summary>
public sealed class NativeWorker : IAsyncDisposable
{
    private readonly CancellationTokenSource stopping = new();
    private readonly Task loop;

    private NativeWorker(NativeServices services, Action<string> warn, TimeSpan interval)
    {
        loop = Task.Run(async () =>
        {
            while (!stopping.IsCancellationRequested)
            {
                try
                {
                    await services.Wallet.Reconcile(() => warn("Native Wallet publication failed; durable state retained for retry."));
                    if (await services.Wallet.Flush() > 0) warn("Native Wallet APNs delivery failed; durable jobs retained for retry.");
                }
                catch
                {
                    warn("Native Wallet worker failed; durable state retained for retry.");
                }
                try { await Task.Delay(interval, stopping.Token); }
                catch (OperationCanceledException) { break; }
            }
        });
    }

    public static NativeWorker Start(NativeServices services, Action<string> warn, TimeSpan? interval = null) =>
        new(services, warn, interval ?? TimeSpan.FromSeconds(15));

    /// <summary>Stops the timer and waits for an in-progress run to finish.</summary>
    public async Task Stop()
    {
        await stopping.CancelAsync();
        await loop;
    }

    public async ValueTask DisposeAsync()
    {
        await Stop();
        stopping.Dispose();
    }
}

/// <summary>Runs <see cref="NativeWorker"/> for the lifetime of the server.</summary>
public sealed class NativeWorkerService(NativeServices services, ILogger<NativeWorkerService> log) : IHostedService
{
    private NativeWorker? worker;

    public Task StartAsync(CancellationToken cancellationToken)
    {
        worker = NativeWorker.Start(services, message => log.LogWarning("{Message}", message));
        return Task.CompletedTask;
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        if (worker is not null) await worker.Stop();
    }
}
