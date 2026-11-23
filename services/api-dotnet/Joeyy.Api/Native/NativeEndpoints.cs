using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Joeyy.Api.Infrastructure;

namespace Joeyy.Api.Native;

/// <summary>/api/v1 and /wallet/v1. Same paths, status codes, headers and messages as services/api/src/native/routes.ts.</summary>
public static partial class NativeEndpoints
{
    private const string PassMediaType = "application/vnd.apple.pkpass";

    [GeneratedRegex(@"^[\x21-\x7e]{1,200}\z", RegexOptions.CultureInvariant)]
    private static partial Regex DevicePattern();

    [GeneratedRegex(@"^[0-9a-fA-F]{32,512}\z", RegexOptions.CultureInvariant)]
    private static partial Regex PushTokenPattern();

    private static string DeviceId(string value)
    {
        if (!DevicePattern().IsMatch(value) || value.IndexOfAny(['/', '\\', '?', '#']) >= 0) throw new HttpError(400, "Invalid device identifier.");
        return value;
    }

    /// <summary>The Authorization header; null when absent, so an empty header stays distinguishable.</summary>
    private static string? Authorization(HttpRequest request) =>
        request.Headers.TryGetValue("Authorization", out var value) ? value.ToString() : null;

    private static string ClientIp(HttpContext context) => context.Connection.RemoteIpAddress?.ToString() ?? "unknown";

    public static void MapNative(this WebApplication app, NativeServices services)
    {
        var store = services.Store;
        var wallet = services.Wallet;
        var requests = new RateLimiter(services.RequestLimit, TimeSpan.FromMinutes(1));
        var logins = new RateLimiter(services.LoginLimit, TimeSpan.FromMinutes(15));
        var log = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Joeyy.Native");

        async ValueTask<object?> Guard(EndpointFilterInvocationContext invocation, EndpointFilterDelegate next)
        {
            var context = invocation.HttpContext;
            context.Response.Headers.CacheControl = "no-store";
            context.Response.Headers.XContentTypeOptions = "nosniff";
            context.Response.Headers["Referrer-Policy"] = "no-referrer";
            try
            {
                requests.Check(ClientIp(context));
                return await next(invocation);
            }
            catch (HttpError error) { return Json.Error(error.Status, error.Message); }
            catch (BodyError error) { return Json.Error(error.Status, error.Message); }
            catch (Exception)
            {
                // Do not log database errors, route parameters, body or upstream URLs.
                log.LogError("Native API operation failed; credentials and chip/device data omitted.");
                return Json.Error(500, "The service could not complete this request. Retry safely.");
            }
        }

        var api = app.MapGroup("/api/v1").AddEndpointFilter(Guard);
        var walletApi = app.MapGroup("/wallet/v1").AddEndpointFilter(Guard);

        api.MapGet("/healthz", async (HttpContext _) =>
        {
            var configuration = new { factoryKeyTest = services.FactoryTest, publicBaseURL = wallet.Options.BaseUrl, prototypeMode = services.PrototypeMode };
            try
            {
                await NativeReadiness.Assert(store.Pool);
                if (services.VerifierReady is { } ready) await ready();
                return Json.Send(new { status = "ok", configuration.factoryKeyTest, configuration.publicBaseURL, configuration.prototypeMode });
            }
            catch
            {
                return Json.Send(new { status = "unavailable", configuration.factoryKeyTest, configuration.publicBaseURL, configuration.prototypeMode }, 503);
            }
        });

        if (services.PrototypeMode)
        {
            api.MapPost("/prototype/session", async (HttpContext context) =>
            {
                var body = await Json.ReadBody(context.Request);
                logins.Check(ClientIp(context));
                if (body is not null) throw new HttpError(400, "Do not send a body to start or resume an NFC prototype session.");
                return Json.Send((await store.PrototypeSession(Authorization(context.Request))).Public());
            });
        }

        foreach (var account in new[] { true, false })
        {
            api.MapPost(account ? "/accounts" : "/sessions", async (HttpContext context) =>
            {
                var body = await Json.ReadBody(context.Request);
                logins.Check(ClientIp(context));
                var credentials = Json.ObjectBody(body);
                var username = credentials.StringProperty("username");
                var password = credentials.StringProperty("password");
                var session = account ? await store.Signup(username, password) : await store.Login(username, password);
                return Json.Send(session.Public(), account ? 201 : 200);
            });
        }

        api.MapDelete("/session", async (HttpContext context) =>
        {
            await store.Logout(await store.Authenticate(Authorization(context.Request)));
            return Results.StatusCode(204);
        });

        api.MapGet("/cards", async (HttpContext context) =>
        {
            var customer = await store.Authenticate(Authorization(context.Request));
            return Json.Send(new { cards = (await store.Cards(customer.Id)).Select(card => card.Public()) });
        });

        api.MapGet("/cards/{id}/pass", async (HttpContext context, string id) =>
        {
            var customer = await store.Authenticate(Authorization(context.Request));
            var card = await store.Card(NativeStore.NormalizeUuid(id), customer.Id);
            PassRow pass;
            try { pass = await wallet.Publish(card.Id); }
            catch { throw new HttpError(503, "Wallet pass is not ready. Retry the request."); }
            return Results.Bytes(pass.Bytes!, PassMediaType);
        });

        api.MapPost("/taps", async (HttpContext context) =>
        {
            var raw = await Json.ReadBody(context.Request);
            var customer = await store.Authenticate(Authorization(context.Request));
            var body = Json.ObjectBody(raw);
            var url = body.StringProperty("url");
            var rawRequestId = body.StringProperty("requestId");
            if (url is null || url.Length > 4096 || rawRequestId is null)
            {
                throw new HttpError(400, "Scan a programmed chip and include a valid request ID.");
            }
            var requestId = NativeStore.NormalizeUuid(rawRequestId);
            var previous = await store.Previous(customer.Id, requestId, url);
            var verified = previous is null ? await services.Verify(url) : null;
            var result = await store.Award(customer.Id, requestId, url, verified);
            if (!customer.IsPrototype)
            {
                try { await wallet.Publish(result.Card.Id); }
                catch
                {
                    throw new HttpError(503, "Stamp recorded, but Wallet generation failed. Retry this same request to finish without adding another stamp.");
                }
            }
            // Publication can race a later accepted stamp; return the authoritative card.
            var card = (await store.Card(result.Card.Id, customer.Id)).Public();
            return customer.IsPrototype
                ? Json.Send(new { eventId = result.EventId, card, duplicate = result.Duplicate, verification = new { verified = true, counter = result.Counter } })
                : Json.Send(new { eventId = result.EventId, card, duplicate = result.Duplicate });
        });

        const string registration = "/devices/{device}/registrations/{type}/{serial}";
        walletApi.MapPost(registration, async (HttpContext context, string device, string type, string serial) =>
        {
            var raw = await Json.ReadBody(context.Request);
            var pass = await wallet.Authorize(Authorization(context.Request), type, serial);
            var pushToken = Json.ObjectBody(raw).StringProperty("pushToken");
            if (pushToken is null || !PushTokenPattern().IsMatch(pushToken)) throw new HttpError(400, "Invalid push token.");
            var inserted = await wallet.Register(DeviceId(device), pass.Serial, pushToken);
            return Results.StatusCode(inserted ? 201 : 200);
        });

        walletApi.MapDelete(registration, async (HttpContext context, string device, string type, string serial) =>
        {
            var pass = await wallet.Authorize(Authorization(context.Request), type, serial);
            await wallet.Unregister(DeviceId(device), pass.Serial);
            return Results.StatusCode(200);
        });

        walletApi.MapGet("/devices/{device}/registrations/{type}", async (HttpContext context, string device, string type) =>
        {
            var query = context.Request.Query["passesUpdatedSince"];
            if (query.Count > 1) throw new HttpError(400, "Invalid update tag.");
            var changes = await wallet.Changes(DeviceId(device), type, query.Count == 1 ? query[0] : null);
            return changes is null ? Results.StatusCode(204) : Json.Send(changes.Public());
        });

        walletApi.MapGet("/passes/{type}/{serial}", async (HttpContext context, string type, string serial) =>
        {
            var authorized = await wallet.Authorize(Authorization(context.Request), type, serial);
            PassRow pass;
            try { pass = await wallet.Publish(authorized.Serial); }
            catch { throw new HttpError(503, "Wallet pass is not ready. Retry the request."); }
            var etag = $"\"{pass.Revision}\"";
            var modifiedMs = pass.Modified * 1000;
            context.Response.Headers.LastModified = DateTimeOffset.FromUnixTimeMilliseconds(modifiedMs).ToString("r", CultureInfo.InvariantCulture);
            context.Response.Headers.ETag = etag;
            var headers = context.Request.Headers;
            var notModified = headers.TryGetValue("If-None-Match", out var noneMatch)
                ? noneMatch.ToString() == etag
                : DateTimeOffset.TryParse(headers.IfModifiedSince.ToString(), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var since) &&
                  since.ToUnixTimeMilliseconds() >= modifiedMs;
            return notModified ? Results.StatusCode(304) : Results.Bytes(pass.Bytes!, PassMediaType);
        });

        walletApi.MapPost("/log", async (HttpContext context) =>
        {
            var body = Json.ObjectBody(await Json.ReadBody(context.Request));
            if (!body.TryGetProperty("logs", out var logs) || logs.ValueKind != JsonValueKind.Array || logs.GetArrayLength() > 100 ||
                logs.EnumerateArray().Any(value => value.ValueKind != JsonValueKind.String))
            {
                throw new HttpError(400, "Invalid diagnostics.");
            }
            // Device-supplied diagnostics are deliberately not logged.
            return Results.StatusCode(200);
        });
    }
}
