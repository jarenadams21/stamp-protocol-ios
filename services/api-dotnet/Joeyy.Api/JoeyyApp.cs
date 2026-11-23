using Joeyy.Api.Infrastructure;
using Joeyy.Api.Native;
using Npgsql;

namespace Joeyy.Api;

/// <summary>Builds the web app. Used by Program.cs and by the tests (with an in-memory test server).</summary>
public static class JoeyyApp
{
    public static WebApplication Build(WebApplicationBuilder builder, NpgsqlDataSource pool, NativeServices? native, bool runWorker = false)
    {
        // Wallet and /api/v1 paths contain device identifiers and push tokens, and verifier URLs contain
        // encrypted chip data, so framework request and HTTP-client logging stay off.
        builder.Logging.AddFilter("Microsoft.AspNetCore", LogLevel.Warning);
        builder.Logging.AddFilter("System.Net.Http", LogLevel.Warning);
        builder.WebHost.ConfigureKestrel(kestrel =>
        {
            kestrel.AddServerHeader = false;
            kestrel.Limits.MaxRequestBodySize = 64 * 1024;
        });
        if (native is not null && runWorker)
        {
            builder.Services.AddSingleton(native);
            builder.Services.AddHostedService<NativeWorkerService>();
        }

        var app = builder.Build();

        // Every response gets its own ID for support; client-supplied IDs are not trusted.
        app.Use(async (context, next) =>
        {
            context.Response.Headers["x-request-id"] = Guid.NewGuid().ToString();
            await next(context);
        });

        app.MapGet("/healthz", async () =>
        {
            try
            {
                await using var db = await pool.OpenConnectionAsync();
                await db.Execute("SELECT 1");
                return Json.Send(new
                {
                    status = "ok",
                    nativeNfc = native is null ? (object)new { enabled = false } : new { enabled = true, factoryKeyTest = native.FactoryTest },
                });
            }
            catch
            {
                app.Logger.LogError("Database health check failed.");
                return Json.Send(new { status = "unavailable" }, 503);
            }
        });

        if (native is not null) app.MapNative(native);

        app.MapFallback(() => Json.Send(new { error = "notFound", message = "No such route." }, 404));
        return app;
    }
}
