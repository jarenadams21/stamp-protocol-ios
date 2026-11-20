using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace Joeyy.Api.Tests.Support;

/// <summary>Generated test-only signing identities, never the real Apple identity.</summary>
public sealed class FixtureCertificates : IDisposable
{
    public string Directory { get; } = System.IO.Directory.CreateTempSubdirectory("joeyy-certs-").FullName;
    public string RootCert => Path.Combine(Directory, "root.pem");
    public string RootKey => Path.Combine(Directory, "root-key.pem");
    public string SignerCert => Path.Combine(Directory, "signer.pem");
    public string SignerKey => Path.Combine(Directory, "signer-key.pem");
    public X509Certificate2 Root { get; }

    public FixtureCertificates()
    {
        using var rootKey = RSA.Create(2048);
        var rootRequest = new CertificateRequest("CN=Native Fixture Root", rootKey, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        rootRequest.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
        rootRequest.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.KeyCertSign | X509KeyUsageFlags.CrlSign, true));
        Root = rootRequest.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-5), DateTimeOffset.UtcNow.AddDays(2));

        using var signerKey = RSA.Create(2048);
        var signerRequest = new CertificateRequest("CN=Native Fixture Signer", signerKey, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        using var signer = signerRequest.Create(Root, DateTimeOffset.UtcNow.AddMinutes(-5), DateTimeOffset.UtcNow.AddDays(1), [2]);

        File.WriteAllText(RootCert, Root.ExportCertificatePem());
        File.WriteAllText(RootKey, rootKey.ExportPkcs8PrivateKeyPem());
        File.WriteAllText(SignerCert, signer.ExportCertificatePem());
        File.WriteAllText(SignerKey, signerKey.ExportPkcs8PrivateKeyPem());
    }

    public Dictionary<string, string?> Settings(string verifierUrl, string passType = "pass.com.example.native") => new()
    {
        ["NATIVE_NFC_ENABLED"] = "1", ["NATIVE_PROTOTYPE_MODE"] = "1", ["PUBLIC_BASE_URL"] = "https://native.example.test",
        ["SDM_BACKEND_URL"] = verifierUrl, ["NATIVE_NFC_KEY_MODE"] = "factory-test", ["FACTORY_KEY_TEST"] = "1",
        ["PASS_TYPE_ID"] = passType, ["TEAM_ID"] = "TEAMTEST01",
        ["SIGNER_CERT_PATH"] = SignerCert, ["SIGNER_KEY_PATH"] = SignerKey, ["WWDR_CERT_PATH"] = RootCert,
        ["SIGNER_KEY_PASSPHRASE"] = "",
    };

    public void Dispose()
    {
        Root.Dispose();
        System.IO.Directory.Delete(Directory, recursive: true);
    }
}
