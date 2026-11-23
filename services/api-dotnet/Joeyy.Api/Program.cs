using System.Collections;
using Joeyy.Api;
using Joeyy.Api.Infrastructure;
using Joeyy.Api.Native;

// JOEYY native NFC/Wallet API (the ASP.NET port of services/api/).
//   dotnet Joeyy.Api.dll            start the server
//   dotnet Joeyy.Api.dll migrate    apply services/api/db/migrations (MIGRATION_ROLE optional)
var env = Environment.GetEnvironmentVariables().Cast<DictionaryEntry>()
    .ToDictionary(entry => (string)entry.Key, entry => (string?)entry.Value);

try
{
    if (args.FirstOrDefault() == "migrate")
    {
        await using var migrationPool = Database.Create(env, maxPoolSize: 1);
        await Migrator.Migrate(migrationPool, role: env.GetValueOrDefault("MIGRATION_ROLE") is { Length: > 0 } role ? role : null, log: Console.WriteLine);
        return 0;
    }

    // Validate the opt-in configuration before creating a pool or opening the listener.
    var config = NativeConfig.FromEnvironment(env);
    await using var pool = Database.Create(env);
    if (config is not null) await NativeReadiness.Assert(pool);

    using var verifierHttp = new HttpClient(new SocketsHttpHandler { AllowAutoRedirect = false });
    using var push = config is null ? null : new ApplePush(config.Signer, config.Wwdr, config.PassType);
    var native = config is null ? null : NativeServices.Create(pool, config, verifierHttp, push!);

    var builder = WebApplication.CreateBuilder(args);
    builder.Logging.ClearProviders();
    builder.Logging.AddJsonConsole();
    builder.WebHost.UseUrls($"http://{env.GetValueOrDefault("HOST") ?? "0.0.0.0"}:{env.GetValueOrDefault("PORT") ?? "8080"}");
    // Stop the Wallet worker before the pool closes; Container Apps sends SIGTERM on every revision change.
    builder.Services.Configure<HostOptions>(options => options.ShutdownTimeout = TimeSpan.FromSeconds(25));

    var app = JoeyyApp.Build(builder, pool, native, runWorker: true);
    await app.RunAsync();
    return 0;
}
catch (Exception error) when (error is ConfigurationException or InvalidOperationException)
{
    // Messages name settings or migrations, never secret values.
    Console.Error.WriteLine(error.Message);
    return 1;
}
