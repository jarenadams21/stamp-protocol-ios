using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.RegularExpressions;
using Joeyy.Api.Infrastructure;

namespace Joeyy.Api.Native;

/// <summary>Native NFC/Wallet settings. Same variables and same checks as backend/src/native/config.ts.</summary>
public sealed record NativeConfig(
    string BaseUrl,
    string VerifierUrl,
    string PassType,
    string TeamId,
    bool FactoryTest,
    bool PrototypeMode,
    X509Certificate2 Signer,
    X509Certificate2 Wwdr)
{
    /// <summary>
    /// NODE_ENV=production marks a production deployment, exactly as for the Node backend, so infra/app.bicep
    /// keeps working unchanged. ASPNETCORE_ENVIRONMENT is deliberately not used: leaving it at its default
    /// (Production) keeps ASP.NET's detailed developer error pages off even in the dev environment.
    /// </summary>
    public static bool IsProduction(IReadOnlyDictionary<string, string?> env) => Value(env, "NODE_ENV") == "production";

    private static string? Value(IReadOnlyDictionary<string, string?> env, string key) => env.TryGetValue(key, out var value) ? value : null;

    private static string Required(IReadOnlyDictionary<string, string?> env, string key)
    {
        var value = Value(env, key);
        if (string.IsNullOrWhiteSpace(value)) throw new ConfigurationException($"Native NFC requires {key}.");
        return value;
    }

    private static Uri ServiceUrl(string value, string setting) =>
        Uri.TryCreate(value, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https"
            ? uri
            : throw new ConfigurationException($"Native NFC requires a valid {setting}.");

    private static readonly Regex DottedQuad = new(@"^(0|[1-9][0-9]{0,2})(\.(0|[1-9][0-9]{0,2})){3}\z", RegexOptions.CultureInvariant);

    /// <summary>Node's net.isIP(host) === 4: strict dotted decimal only.</summary>
    private static bool IsIPv4(string host) =>
        DottedQuad.IsMatch(host) && host.Split('.').All(part => int.Parse(part, System.Globalization.CultureInfo.InvariantCulture) <= 255);

    private static bool PrivateHttpHost(string hostname)
    {
        var host = hostname.Trim('[', ']');
        if (host is "localhost" or "::1" || host.EndsWith(".internal", StringComparison.Ordinal) || host.EndsWith(".local", StringComparison.Ordinal)) return true;
        if (!host.Contains('.') && !host.Contains(':') && !IsIPv4(host)) return true; // private container service name
        if (!IsIPv4(host)) return false;
        var parts = host.Split('.').Select(part => int.Parse(part, System.Globalization.CultureInfo.InvariantCulture)).ToArray();
        return parts[0] == 127 || parts[0] == 10 ||
            (parts[0] == 192 && parts[1] == 168) || (parts[0] == 172 && parts[1] >= 16 && parts[1] <= 31);
    }

    private static readonly Regex PassTypePattern = new(@"^pass\.[a-zA-Z0-9.-]+\z", RegexOptions.CultureInvariant);
    private static readonly Regex TeamPattern = new(@"^[A-Z0-9]{10}\z", RegexOptions.CultureInvariant);

    /// <summary>Returns null when native NFC is off. Throws <see cref="ConfigurationException"/> for any invalid setting.</summary>
    public static NativeConfig? FromEnvironment(IReadOnlyDictionary<string, string?> env)
    {
        var enabled = Value(env, "NATIVE_NFC_ENABLED");
        if (enabled is not null && enabled is not ("0" or "1")) throw new ConfigurationException("NATIVE_NFC_ENABLED must be 0 or 1.");
        var prototype = Value(env, "NATIVE_PROTOTYPE_MODE");
        if (prototype is not null && prototype is not ("0" or "1")) throw new ConfigurationException("NATIVE_PROTOTYPE_MODE must be 0 or 1.");
        var prototypeMode = prototype == "1";
        if (prototypeMode && enabled != "1") throw new ConfigurationException("NATIVE_PROTOTYPE_MODE=1 requires NATIVE_NFC_ENABLED=1.");
        if (prototypeMode && IsProduction(env)) throw new ConfigurationException("NATIVE_PROTOTYPE_MODE=1 is not allowed when NODE_ENV=production.");
        if (enabled != "1") return null;

        var baseUrl = Required(env, "PUBLIC_BASE_URL");
        if (baseUrl.EndsWith('/')) baseUrl = baseUrl[..^1];
        var origin = ServiceUrl(baseUrl, "PUBLIC_BASE_URL");
        if (origin.Scheme != "https" || origin.GetLeftPart(UriPartial.Authority) != baseUrl)
        {
            throw new ConfigurationException("Native NFC requires PUBLIC_BASE_URL to be an HTTPS origin.");
        }
        var verifierUrl = Required(env, "SDM_BACKEND_URL");
        var verifier = ServiceUrl(verifierUrl, "SDM_BACKEND_URL");
        if (verifier.UserInfo.Length > 0 || verifier.Query.Length > 0 || verifier.Fragment.Length > 0 || verifier.AbsolutePath != "/" ||
            (verifier.Scheme == "http" && !PrivateHttpHost(verifier.Host)))
        {
            throw new ConfigurationException("SDM_BACKEND_URL must be a private HTTP or authenticated-network HTTPS service origin, without URL credentials.");
        }
        var mode = Required(env, "NATIVE_NFC_KEY_MODE");
        var factoryKey = Value(env, "FACTORY_KEY_TEST") == "1";
        if (mode is not ("provisioned" or "factory-test") || (mode == "factory-test" && !factoryKey) || (mode == "provisioned" && factoryKey))
        {
            throw new ConfigurationException("Select NATIVE_NFC_KEY_MODE=provisioned, or factory-test with explicit FACTORY_KEY_TEST=1.");
        }
        var passType = Required(env, "PASS_TYPE_ID");
        var teamId = Required(env, "TEAM_ID");
        if (!PassTypePattern.IsMatch(passType) || !TeamPattern.IsMatch(teamId))
        {
            throw new ConfigurationException("Configure a valid PASS_TYPE_ID and 10-character TEAM_ID.");
        }
        var paths = new[] { "SIGNER_CERT_PATH", "SIGNER_KEY_PATH", "WWDR_CERT_PATH" }.Select(key => (Key: key, Path: Required(env, key))).ToList();
        var files = paths.Select(entry =>
        {
            try { return File.ReadAllBytes(entry.Path); }
            catch { throw new ConfigurationException($"Native NFC could not read {entry.Key}."); }
        }).ToList();
        var passphrase = Value(env, "SIGNER_KEY_PASSPHRASE");
        X509Certificate2 signer, wwdr;
        try
        {
            var certificate = LoadCertificate(files[0]);
            wwdr = LoadCertificate(files[2]);
            var key = RSA.Create();
            var keyText = Encoding.ASCII.GetString(files[1]);
            if (string.IsNullOrEmpty(passphrase)) key.ImportFromPem(keyText);
            else key.ImportFromEncryptedPem(keyText, passphrase);
            var publicKey = certificate.GetRSAPublicKey()?.ExportSubjectPublicKeyInfo();
            if (publicKey is null || !publicKey.AsSpan().SequenceEqual(key.ExportSubjectPublicKeyInfo()) ||
                certificate.NotAfter.ToUniversalTime() <= DateTime.UtcNow)
            {
                throw new CryptographicException("Invalid signing identity");
            }
            signer = certificate.CopyWithPrivateKey(key);
        }
        catch
        {
            throw new ConfigurationException("Native NFC signing identity is invalid, expired, or its key/passphrase does not match.");
        }
        return new NativeConfig(baseUrl, verifierUrl, passType, teamId, mode == "factory-test", prototypeMode, signer, wwdr);
    }

    /// <summary>Accepts PEM or DER, like Node's X509Certificate.</summary>
    private static X509Certificate2 LoadCertificate(byte[] bytes)
    {
        var text = Encoding.ASCII.GetString(bytes);
        return text.Contains("-----BEGIN CERTIFICATE-----", StringComparison.Ordinal)
            ? X509Certificate2.CreateFromPem(text)
            : X509CertificateLoader.LoadCertificate(bytes);
    }
}
