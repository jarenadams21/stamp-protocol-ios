using System.Net;
using System.Net.Http.Headers;
using System.Net.Security;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;

namespace Joeyy.Api.Native;

/// <summary>
/// Sends the empty push that tells Wallet to fetch an updated pass. A port of applePush in services/api/wallet.mjs:
/// HTTP/2 to APNs with the pass signing certificate as the client certificate.
/// </summary>
public sealed class ApplePush : IDisposable
{
    private readonly Lazy<HttpClient> client;
    private readonly string topic;

    public ApplePush(X509Certificate2 signer, X509Certificate2 wwdr, string passType, Uri? endpoint = null)
    {
        topic = passType;
        // Created on first use: an APNs problem must never stop the server (and taps) from starting.
        client = new Lazy<HttpClient>(() => new HttpClient(new SocketsHttpHandler
        {
            SslOptions = new SslClientAuthenticationOptions
            {
                ClientCertificateContext = SslStreamCertificateContext.Create(signer, [wwdr], offline: true),
            },
            PooledConnectionIdleTimeout = TimeSpan.FromMinutes(5),
        })
        {
            BaseAddress = endpoint ?? new Uri("https://api.push.apple.com"),
            Timeout = TimeSpan.FromSeconds(10),
            DefaultRequestVersion = HttpVersion.Version20,
            DefaultVersionPolicy = HttpVersionPolicy.RequestVersionExact,
        }, LazyThreadSafetyMode.PublicationOnly); // a failed creation is retried on the next push, not cached
    }

    /// <summary>Returns true when Apple says the push token is no longer valid; throws for anything retryable.</summary>
    public async Task<bool> Send(string pushToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, $"/3/device/{pushToken}")
        {
            Content = new ByteArrayContent("{}"u8.ToArray()),
        };
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        request.Headers.Add("apns-topic", topic);
        request.Headers.Add("apns-priority", "5");
        request.Headers.Add("apns-expiration", "0");
        HttpResponseMessage response;
        try { response = await client.Value.SendAsync(request); }
        catch { throw new InvalidOperationException("APNs request failed."); }
        using (response)
        {
            if (response.StatusCode == HttpStatusCode.OK) return false;
            var body = await response.Content.ReadAsByteArrayAsync();
            if (body.Length > 4096) throw new InvalidOperationException("Invalid APNs response.");
            string? reason;
            try
            {
                using var document = JsonDocument.Parse(body);
                reason = document.RootElement.ValueKind == JsonValueKind.Object &&
                    document.RootElement.TryGetProperty("reason", out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
            }
            catch { throw new InvalidOperationException("Invalid APNs response."); }
            if (response.StatusCode == HttpStatusCode.Gone ||
                (response.StatusCode == HttpStatusCode.BadRequest && reason is "BadDeviceToken" or "DeviceTokenNotForTopic"))
            {
                return true;
            }
            throw new InvalidOperationException("APNs rejected the update.");
        }
    }

    public void Dispose()
    {
        if (client.IsValueCreated) client.Value.Dispose();
    }
}
