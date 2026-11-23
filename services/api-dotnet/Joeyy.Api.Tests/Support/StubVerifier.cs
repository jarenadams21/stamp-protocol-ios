using System.Collections.Concurrent;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Joeyy.Api.Tests.Support;

/// <summary>
/// A real HTTP server standing in for the private SDM verifier sidecar. Opaque test vectors replace its
/// responses; production code still calls it through the real VerifierClient.
/// </summary>
public sealed class StubVerifier : IAsyncDisposable
{
    private readonly WebApplication app;
    public ConcurrentDictionary<string, (int Status, object Body)> Responses { get; } = new();
    public int Requests;
    public string Url { get; private set; } = "";
    /// <summary>When set, every /api/tagtt request gets this answer regardless of the ciphertext.</summary>
    public object? Fixed { get; set; }

    private StubVerifier()
    {
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        app = builder.Build();
        app.MapGet("/healthz", () => Results.Json(new { status = "ok" }));
        app.MapGet("/api/tagtt", (HttpContext context) =>
        {
            Interlocked.Increment(ref Requests);
            if (Fixed is not null) return Results.Json(Fixed);
            var key = context.Request.Query["e"].ToString();
            return Responses.TryGetValue(key, out var fixture)
                ? Results.Json(fixture.Body, statusCode: fixture.Status)
                : Results.Json(new { error = "fixture signature mismatch" });
        });
    }

    public static async Task<StubVerifier> Start()
    {
        var verifier = new StubVerifier();
        await verifier.app.StartAsync();
        verifier.Url = verifier.app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.First();
        return verifier;
    }

    public async ValueTask DisposeAsync()
    {
        await app.StopAsync();
        await app.DisposeAsync();
    }
}
