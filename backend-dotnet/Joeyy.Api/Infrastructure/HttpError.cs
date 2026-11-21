namespace Joeyy.Api.Infrastructure;

/// <summary>An error whose message is safe to show to the app. Mirrors HttpError in backend/support.mjs.</summary>
public sealed class HttpError(int status, string message) : Exception(message)
{
    public int Status { get; } = status;
}

/// <summary>The request body was missing, too large, malformed, or of the wrong type.</summary>
public sealed class BodyError(int status) : Exception("The request body couldn't be read.")
{
    public int Status { get; } = status;
}

/// <summary>A configuration problem found before startup. The message names the setting, never its value.</summary>
public sealed class ConfigurationException(string message) : Exception(message);
