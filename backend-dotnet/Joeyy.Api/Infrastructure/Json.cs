using System.Text;
using System.Text.Json;

namespace Joeyy.Api.Infrastructure;

public static class Json
{
    /// <summary>Property names are written exactly as declared (for example publicBaseURL), like the Node API.</summary>
    public static readonly JsonSerializerOptions Options = new() { PropertyNamingPolicy = null };

    public static IResult Send(object value, int status = 200) => Results.Json(value, Options, statusCode: status);

    public static IResult Error(int status, string message) => Send(new { error = message }, status);

    /// <summary>
    /// Reads a request body up to <paramref name="limit"/> bytes, the way Fastify does for these routes:
    /// no body is null; application/json is parsed; text/plain becomes a JSON string; anything else is 415.
    /// </summary>
    public static async Task<JsonElement?> ReadBody(HttpRequest request, int limit = 16_384)
    {
        if (request.ContentLength > limit) throw new BodyError(413);
        using var buffer = new MemoryStream();
        var chunk = new byte[8192];
        int read;
        while ((read = await request.Body.ReadAsync(chunk)) > 0)
        {
            if (buffer.Length + read > limit) throw new BodyError(413);
            buffer.Write(chunk, 0, read);
        }
        if (buffer.Length == 0) return null;
        var type = request.ContentType?.Split(';')[0].Trim().ToLowerInvariant();
        if (type == "application/json")
        {
            try
            {
                using var document = JsonDocument.Parse(buffer.ToArray());
                return document.RootElement.Clone();
            }
            catch (JsonException) { throw new BodyError(400); }
        }
        if (type == "text/plain") return JsonSerializer.SerializeToElement(Encoding.UTF8.GetString(buffer.ToArray()));
        throw new BodyError(415);
    }

    /// <summary>Mirrors objectBody() in backend/src/native/routes.ts.</summary>
    public static JsonElement ObjectBody(JsonElement? body)
    {
        if (body is not { ValueKind: JsonValueKind.Object } value) throw new HttpError(400, "Expected a JSON object.");
        return value;
    }

    /// <summary>The property's value when it is a JSON string, otherwise null (JavaScript's `typeof x === "string"`).</summary>
    public static string? StringProperty(this JsonElement value, string name) =>
        value.TryGetProperty(name, out var property) && property.ValueKind == JsonValueKind.String ? property.GetString() : null;
}
