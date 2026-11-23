namespace Joeyy.Api.Infrastructure;

/// <summary>In-memory fixed-window limiter, one window per key (client IP). Mirrors RateLimiter in services/api/support.mjs.</summary>
public sealed class RateLimiter(int limit, TimeSpan window, TimeProvider? time = null)
{
    private const int MaxKeys = 10_000;
    private readonly Dictionary<string, (int Count, long Until)> entries = new();
    private readonly Lock gate = new();
    private readonly TimeProvider clock = time ?? TimeProvider.System;

    public void Check(string key)
    {
        var now = clock.GetUtcNow().ToUnixTimeMilliseconds();
        lock (gate)
        {
            foreach (var expired in entries.Where(entry => entry.Value.Until <= now).Select(entry => entry.Key).ToList())
            {
                entries.Remove(expired);
            }
            if (!entries.TryGetValue(key, out var entry))
            {
                if (entries.Count >= MaxKeys) throw new HttpError(429, "Too many requests. Try again later.");
                entry = (0, now + (long)window.TotalMilliseconds);
            }
            entry.Count++;
            entries[key] = entry;
            if (entry.Count > limit) throw new HttpError(429, "Too many requests. Try again later.");
        }
    }
}
