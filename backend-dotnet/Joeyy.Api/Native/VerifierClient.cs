using System.Text.Json;
using System.Text.RegularExpressions;
using Joeyy.Api.Infrastructure;

namespace Joeyy.Api.Native;

/// <summary>
/// Sends the chip's encrypted data to the private SDM verifier sidecar. A port of verifyTag in backend/support.mjs.
/// No cryptography happens here; the verifier does all of it.
/// </summary>
public sealed partial class VerifierClient(HttpClient http, string baseUrl)
{
    private static readonly string[] Fields = ["e", "picc_data", "enc", "cmac"];

    [GeneratedRegex(@"^[0-9a-fA-F]+\z", RegexOptions.CultureInvariant)]
    private static partial Regex Hex();

    [GeneratedRegex(@"^[0-9a-fA-F]{14}\z", RegexOptions.CultureInvariant)]
    private static partial Regex Uid();

    /// <summary>Parses a query string like URLSearchParams: '+' is a space, then percent-decoding.</summary>
    private static List<(string Key, string Value)> Query(string query) =>
        query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries).Select(pair =>
        {
            var split = pair.IndexOf('=');
            string Decode(string value) => Uri.UnescapeDataString(value.Replace('+', ' '));
            return split < 0 ? (Decode(pair), "") : (Decode(pair[..split]), Decode(pair[(split + 1)..]));
        }).ToList();

    public async Task<VerifiedTag> Verify(string rawUrl)
    {
        if (!Uri.TryCreate(rawUrl, UriKind.Absolute, out var input)) throw new HttpError(400, "The chip did not contain a valid URL.");
        if (input.Scheme != "https" || input.AbsolutePath is not ("/tagtt" or "/tag" or "/tap") || rawUrl.Length > 4096)
        {
            throw new HttpError(400, "Use a programmed NTAG 424 DNA chip.");
        }
        var query = Query(input.Query);
        var forwarded = new List<(string Key, string Value)>();
        foreach (var field in Fields)
        {
            var values = query.Where(pair => pair.Key == field).Select(pair => pair.Value).ToList();
            if (values.Count > 1) throw new HttpError(400, "Repeated chip parameters.");
            if (values.Count == 1)
            {
                var value = values[0];
                if (!Hex().IsMatch(value) || value.Length > 512 || value.Length % 2 != 0) throw new HttpError(400, "Invalid chip data.");
                forwarded.Add((field, value));
            }
        }
        bool Has(string key) => forwarded.Any(pair => pair.Key == key);
        if (!Has("e") && (!Has("picc_data") || !Has("cmac"))) throw new HttpError(400, "This chip is missing its dynamic signature.");

        var endpoint = new UriBuilder(new Uri(new Uri(baseUrl), "/api/tagtt"))
        {
            Query = string.Join('&', forwarded.Select(pair => $"{pair.Key}={pair.Value}")),
        }.Uri;
        JsonElement body;
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            using var response = await http.GetAsync(endpoint, timeout.Token);
            if (!response.IsSuccessStatusCode) throw new InvalidOperationException("Verifier unavailable");
            using var document = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(timeout.Token), cancellationToken: timeout.Token);
            body = document.RootElement.Clone();
        }
        catch { throw new HttpError(503, "The private NFC verifier is unavailable. Try again."); }

        if (body.ValueKind is JsonValueKind.Null or JsonValueKind.False || (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("error", out _)))
        {
            throw new HttpError(422, "Chip verification failed. Check its programming key.");
        }
        var uid = body.ValueKind == JsonValueKind.Object ? body.StringProperty("uid") : null;
        int? counter = null;
        if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("read_ctr", out var readCounter) &&
            readCounter.ValueKind == JsonValueKind.Number && readCounter.TryGetDouble(out var number) &&
            number == Math.Floor(number) && number >= 0 && number <= 0xffffff)
        {
            counter = (int)number;
        }
        var mode = body.ValueKind == JsonValueKind.Object ? body.StringProperty("enc_mode") : null;
        if (uid is null || !Uid().IsMatch(uid) || counter is null || mode is not ("AES" or "LRP"))
        {
            throw new HttpError(502, "Invalid verifier response.");
        }
        return new VerifiedTag(uid.ToUpperInvariant(), counter.Value);
    }

    /// <summary>Confirms the verifier answers, so health checks catch a broken verifier before real taps do.</summary>
    public async Task Ready()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        using var response = await http.GetAsync(new Uri(new Uri(baseUrl), "/healthz"), timeout.Token);
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException("Private NFC verifier is not ready.");
    }
}
