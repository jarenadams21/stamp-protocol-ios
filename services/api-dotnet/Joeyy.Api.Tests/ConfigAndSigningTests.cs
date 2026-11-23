using System.Diagnostics;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Security.Cryptography.Pkcs;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using Joeyy.Api.Infrastructure;
using Joeyy.Api.Native;
using Joeyy.Api.Tests.Support;

namespace Joeyy.Api.Tests;

public sealed class ConfigAndSigningTests : IDisposable
{
    private readonly FixtureCertificates certificates = new();

    public void Dispose() => certificates.Dispose();

    private static void Rejects(Dictionary<string, string?> env, string pattern) =>
        Assert.Matches(pattern, Assert.Throws<ConfigurationException>(() => NativeConfig.FromEnvironment(env)).Message);

    [Fact]
    public void ConfigurationFailsExplicitlyAndFactoryKeysRequireTwoGates()
    {
        Assert.Null(NativeConfig.FromEnvironment(new Dictionary<string, string?>()));
        Assert.Null(NativeConfig.FromEnvironment(new Dictionary<string, string?> { ["NATIVE_NFC_ENABLED"] = "0" }));
        Rejects(new() { ["NATIVE_NFC_ENABLED"] = "yes" }, "0 or 1");
        Rejects(new() { ["NATIVE_NFC_ENABLED"] = "1" }, "PUBLIC_BASE_URL");
        Dictionary<string, string?> Base() => new()
        {
            ["NATIVE_NFC_ENABLED"] = "1", ["PUBLIC_BASE_URL"] = "https://native.example.test", ["SDM_BACKEND_URL"] = "http://127.0.0.1:5005",
        };
        Rejects(Base(), "NATIVE_NFC_KEY_MODE");
        Rejects(new(Base()) { ["NATIVE_NFC_KEY_MODE"] = "factory-test" }, "FACTORY_KEY_TEST");
        Rejects(new(Base()) { ["NATIVE_NFC_KEY_MODE"] = "provisioned", ["FACTORY_KEY_TEST"] = "1" }, "FACTORY_KEY_TEST");
        Rejects(new(Base()) { ["NATIVE_NFC_KEY_MODE"] = "provisioned" }, "PASS_TYPE_ID");
        Rejects(new(Base()) { ["SDM_BACKEND_URL"] = "http://public.example.com", ["NATIVE_NFC_KEY_MODE"] = "provisioned" }, "private HTTP");
        Rejects(new(Base()) { ["SDM_BACKEND_URL"] = "http://user:pw@127.0.0.1:5005", ["NATIVE_NFC_KEY_MODE"] = "provisioned" }, "private HTTP");
        Rejects(new(Base()) { ["SDM_BACKEND_URL"] = "http://127.0.0.1:5005/path", ["NATIVE_NFC_KEY_MODE"] = "provisioned" }, "private HTTP");
        Rejects(new(Base()) { ["PUBLIC_BASE_URL"] = "http://native.example.test" }, "HTTPS origin");
        Rejects(new(Base()) { ["PUBLIC_BASE_URL"] = "https://native.example.test/path" }, "HTTPS origin");
        // Private container service names and RFC 1918 addresses are accepted as plain HTTP verifiers.
        foreach (var verifier in new[] { "http://verifier:5005", "http://10.0.0.4:5005", "http://172.20.1.1", "http://localhost:5005", "http://sdm.internal" })
        {
            Rejects(new(Base()) { ["SDM_BACKEND_URL"] = verifier, ["NATIVE_NFC_KEY_MODE"] = "provisioned" }, "PASS_TYPE_ID");
        }
    }

    [Fact]
    public void PrototypeModeRequiresNativeSupportAndIsRejectedInProduction()
    {
        Assert.Null(NativeConfig.FromEnvironment(new Dictionary<string, string?> { ["NATIVE_PROTOTYPE_MODE"] = "0" }));
        Rejects(new() { ["NATIVE_PROTOTYPE_MODE"] = "yes" }, "must be 0 or 1");
        Rejects(new() { ["NATIVE_PROTOTYPE_MODE"] = "1" }, "requires NATIVE_NFC_ENABLED=1");
        Rejects(new() { ["NATIVE_NFC_ENABLED"] = "0", ["NATIVE_PROTOTYPE_MODE"] = "1" }, "requires NATIVE_NFC_ENABLED=1");
        Rejects(new() { ["NATIVE_NFC_ENABLED"] = "1", ["NATIVE_PROTOTYPE_MODE"] = "1", ["NODE_ENV"] = "production" }, "not allowed when NODE_ENV=production");
    }

    [Fact]
    public void RealSigningIdentityIsValidatedAndMismatchedKeysAreRejected()
    {
        var settings = certificates.Settings("http://127.0.0.1:5005");
        var config = NativeConfig.FromEnvironment(settings);
        Assert.NotNull(config);
        Assert.True(config.PrototypeMode);
        Assert.True(config.FactoryTest);
        Assert.False(NativeConfig.FromEnvironment(new Dictionary<string, string?>(settings) { ["NATIVE_PROTOTYPE_MODE"] = "0" })!.PrototypeMode);
        Rejects(new(settings) { ["SIGNER_KEY_PATH"] = certificates.RootKey }, "does not match");
        Rejects(new(settings) { ["SIGNER_CERT_PATH"] = Path.Combine(certificates.Directory, "missing.pem") }, "could not read SIGNER_CERT_PATH");
    }

    private static readonly NativeCard GoldenCard = new(Guid.Parse("6a2e3d81-7b49-4f12-a0c3-819d62e00101"), Guid.NewGuid(), "Hardware Test Cafe", 2, 8, 1, "", 1);

    [Fact]
    public async Task PassesMatchTheNodeLayoutAndCarryAVerifiableDetachedSignature()
    {
        var config = NativeConfig.FromEnvironment(certificates.Settings("http://127.0.0.1:5005", "pass.com.example.native"))!;
        var signed = await new PassRenderer(config).Render(GoldenCard, "fixture-token-0123456789");
        Assert.Equal("PK", Encoding.ASCII.GetString(signed, 0, 2));
        using var zip = new ZipArchive(new MemoryStream(signed));
        var files = zip.Entries.ToDictionary(entry => entry.FullName, entry =>
        {
            using var stream = entry.Open();
            using var copy = new MemoryStream();
            stream.CopyTo(copy);
            return copy.ToArray();
        });
        Assert.Equal(
            ["icon.png", "icon@2x.png", "icon@3x.png", "manifest.json", "pass.json", "signature", "strip.png", "strip@2x.png", "strip@3x.png"],
            files.Keys.Order(StringComparer.Ordinal));

        // The exact pass.json the Node renderPass (passkit-generator 3.7.0) produced for this card.
        const string nodePassJson = """
            {"formatVersion":1,"passTypeIdentifier":"pass.com.example.native","teamIdentifier":"TEAMTEST01",
             "serialNumber":"6a2e3d81-7b49-4f12-a0c3-819d62e00101","organizationName":"Cafe Wallet Prototype",
             "description":"Hardware Test Cafe loyalty test","logoText":"Hardware Test Cafe","backgroundColor":"rgb(25,57,79)",
             "foregroundColor":"rgb(255,246,223)","labelColor":"rgb(255,246,223)","webServiceURL":"https://native.example.test/wallet",
             "authenticationToken":"fixture-token-0123456789",
             "barcodes":[{"format":"PKBarcodeFormatQR","message":"6a2e3d81-7b49-4f12-a0c3-819d62e00101","messageEncoding":"iso-8859-1"}],
             "storeCard":{"headerFields":[{"key":"stamps","label":"STAMPS","value":"2 / 8"}],"primaryFields":[],"secondaryFields":[],
               "auxiliaryFields":[{"key":"rewards","label":"REWARDS AVAILABLE","value":1}],
               "backFields":[{"key":"terms","label":"Prototype","value":"Cafe Wallet Prototype test pass. Not redeemable for real purchases."}],
               "additionalInfoFields":[]}}
            """;
        JsonAssert.Equal(JsonDocument.Parse(nodePassJson).RootElement, JsonDocument.Parse(files["pass.json"]).RootElement);

        var manifest = JsonDocument.Parse(files["manifest.json"]).RootElement;
        Assert.Equal(files.Keys.Except(["manifest.json", "signature"]).Order(StringComparer.Ordinal), JsonAssert.Keys(manifest));
        foreach (var property in manifest.EnumerateObject())
        {
            Assert.Equal(Convert.ToHexStringLower(SHA1.HashData(files[property.Name])), property.Value.GetString());
        }

        var cms = new SignedCms(new ContentInfo(files["manifest.json"]), detached: true);
        cms.Decode(files["signature"]);
        cms.CheckSignature(verifySignatureOnly: true);
        var signer = Assert.Single(cms.SignerInfos.Cast<SignerInfo>());
        Assert.Equal("1.3.14.3.2.26", signer.DigestAlgorithm.Value);
        Assert.Contains(signer.SignedAttributes.Cast<CryptographicAttributeObject>(), attribute => attribute.Oid.Value == "1.2.840.113549.1.9.5");
        Assert.Equal(2, cms.Certificates.Count);
        Assert.Contains(cms.Certificates.Cast<X509Certificate2>(), certificate => certificate.Thumbprint == certificates.Root.Thumbprint);
        using var chain = new X509Chain { ChainPolicy = { TrustMode = X509ChainTrustMode.CustomRootTrust, RevocationMode = X509RevocationMode.NoCheck } };
        chain.ChainPolicy.CustomTrustStore.Add(certificates.Root);
        Assert.True(chain.Build(signer.Certificate!), "the signer chains to the WWDR certificate in the pass");

        foreach (var (name, width, height) in new[] { ("icon.png", 29, 29), ("icon@2x.png", 58, 58), ("icon@3x.png", 87, 87),
            ("strip.png", 375, 144), ("strip@2x.png", 750, 288), ("strip@3x.png", 1125, 432) })
        {
            var png = files[name];
            Assert.Equal((width, height), (System.Buffers.Binary.BinaryPrimitives.ReadInt32BigEndian(png.AsSpan(16)), System.Buffers.Binary.BinaryPrimitives.ReadInt32BigEndian(png.AsSpan(20))));
        }
        VerifyWithOpenSsl(files);
    }

    /// <summary>The same independent check the Node test ran: `openssl cms -verify`.</summary>
    private void VerifyWithOpenSsl(Dictionary<string, byte[]> files)
    {
        var directory = Directory.CreateTempSubdirectory("joeyy-pass-").FullName;
        try
        {
            File.WriteAllBytes(Path.Combine(directory, "signature"), files["signature"]);
            File.WriteAllBytes(Path.Combine(directory, "manifest.json"), files["manifest.json"]);
            Process process;
            try
            {
                process = Process.Start(new ProcessStartInfo("openssl",
                    ["cms", "-verify", "-inform", "DER", "-in", Path.Combine(directory, "signature"), "-content", Path.Combine(directory, "manifest.json"),
                     "-CAfile", certificates.RootCert, "-purpose", "any", "-out", Path.Combine(directory, "verified.json")])
                { RedirectStandardError = true, RedirectStandardOutput = true })!;
            }
            catch (System.ComponentModel.Win32Exception) { return; } // openssl not installed
            process.WaitForExit();
            Assert.True(process.ExitCode == 0, process.StandardError.ReadToEnd());
        }
        finally { Directory.Delete(directory, recursive: true); }
    }

    [Fact]
    public async Task PasswordHashesMatchNodeScryptSoExistingAccountsKeepWorking()
    {
        // node -e 'crypto.scrypt("ordinary-fixture-password","0123456789abcdef0123456789abcdef",64,…)'
        const string node = "45c4376c9a85142c11a2978ce694d3311c13d0898a91858106f0da9381dc30c9662a8267fcb4f9180ed40af5e4d4e5c62a7c07cc029d03733f821a3e6156a9f6";
        Assert.Equal(node, Convert.ToHexStringLower(await NativeStore.Scrypt("ordinary-fixture-password", "0123456789abcdef0123456789abcdef")));
    }

    [Fact]
    public void RateLimiterAllowsTheLimitPerWindowAndThenRefuses()
    {
        var time = new ManualTime();
        var limiter = new RateLimiter(2, TimeSpan.FromMinutes(1), time);
        limiter.Check("a");
        limiter.Check("a");
        Assert.Equal(429, Assert.Throws<HttpError>(() => limiter.Check("a")).Status);
        limiter.Check("b");
        time.Advance(TimeSpan.FromMinutes(1));
        limiter.Check("a");
    }

    private sealed class ManualTime : TimeProvider
    {
        private DateTimeOffset now = DateTimeOffset.UnixEpoch.AddYears(56);
        public override DateTimeOffset GetUtcNow() => now;
        public void Advance(TimeSpan by) => now += by;
    }
}
