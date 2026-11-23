using System.IO.Compression;
using System.Security.Cryptography;
using System.Security.Cryptography.Pkcs;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using SkiaSharp;

namespace Joeyy.Api.Native;

/// <summary>
/// Builds and signs the Apple Wallet .pkpass, matching renderPass in services/api/wallet.mjs (passkit-generator):
/// the same pass.json, SHA-1 manifest, and a detached CMS signature with a SHA-1 digest and signing time
/// that carries the signer and Apple WWDR certificates.
/// </summary>
public sealed class PassRenderer(NativeConfig config)
{
    private static readonly SKColor Background = new(0x19, 0x39, 0x4f);
    private static readonly SKColor Ink = new(0xff, 0xf6, 0xdf);

    /// <summary>The Docker image installs DejaVu; elsewhere the platform default font is used.</summary>
    private static readonly Lazy<SKTypeface> Typeface = new(() =>
    {
        foreach (var path in new[] { "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf" })
        {
            if (File.Exists(path) && SKTypeface.FromFile(path) is { } typeface) return typeface;
        }
        return SKTypeface.Default;
    });

    public Task<byte[]> Render(NativeCard card, string token) => Task.Run(() => Build(card, token));

    private byte[] Build(NativeCard card, string token)
    {
        var files = new List<(string Name, byte[] Bytes)>
        {
            ("pass.json", PassJson(card, token)),
            ("icon.png", Icon(29)), ("icon@2x.png", Icon(58)), ("icon@3x.png", Icon(87)),
            ("strip.png", Strip(card, 375, 144)), ("strip@2x.png", Strip(card, 750, 288)), ("strip@3x.png", Strip(card, 1125, 432)),
        };
        var manifest = Manifest(files);
        files.Add(("manifest.json", manifest));
        files.Add(("signature", Sign(manifest)));
        using var output = new MemoryStream();
        using (var zip = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var (name, bytes) in files)
            {
                using var entry = zip.CreateEntry(name, CompressionLevel.Optimal).Open();
                entry.Write(bytes);
            }
        }
        return output.ToArray();
    }

    private byte[] PassJson(NativeCard card, string token)
    {
        using var buffer = new MemoryStream();
        using (var json = new Utf8JsonWriter(buffer))
        {
            json.WriteStartObject();
            json.WriteNumber("formatVersion", 1);
            json.WriteString("passTypeIdentifier", config.PassType);
            json.WriteString("teamIdentifier", config.TeamId);
            json.WriteString("serialNumber", card.Id.ToString());
            json.WriteString("organizationName", "Cafe Wallet Prototype");
            json.WriteString("description", $"{card.CafeName} loyalty test");
            json.WriteString("logoText", card.CafeName);
            json.WriteString("backgroundColor", "rgb(25,57,79)");
            json.WriteString("foregroundColor", "rgb(255,246,223)");
            json.WriteString("labelColor", "rgb(255,246,223)");
            json.WriteString("webServiceURL", config.BaseUrl + "/wallet");
            json.WriteString("authenticationToken", token);
            json.WriteStartArray("barcodes");
            json.WriteStartObject();
            json.WriteString("format", "PKBarcodeFormatQR");
            json.WriteString("message", card.Id.ToString());
            json.WriteString("messageEncoding", "iso-8859-1");
            json.WriteEndObject();
            json.WriteEndArray();
            json.WriteStartObject("storeCard");
            void Field(string group, string key, string label, Action<Utf8JsonWriter> value)
            {
                json.WriteStartArray(group);
                json.WriteStartObject();
                json.WriteString("key", key);
                json.WriteString("label", label);
                value(json);
                json.WriteEndObject();
                json.WriteEndArray();
            }
            void Empty(string group) { json.WriteStartArray(group); json.WriteEndArray(); }
            Field("headerFields", "stamps", "STAMPS", writer => writer.WriteString("value", $"{card.Stamps} / {card.Target}"));
            Empty("primaryFields");
            Empty("secondaryFields");
            Field("auxiliaryFields", "rewards", "REWARDS AVAILABLE", writer => writer.WriteNumber("value", card.RewardsAvailable));
            Field("backFields", "terms", "Prototype", writer => writer.WriteString("value", "Cafe Wallet Prototype test pass. Not redeemable for real purchases."));
            Empty("additionalInfoFields");
            json.WriteEndObject();
            json.WriteEndObject();
        }
        return buffer.ToArray();
    }

    private static byte[] Manifest(List<(string Name, byte[] Bytes)> files)
    {
        using var buffer = new MemoryStream();
        using (var json = new Utf8JsonWriter(buffer))
        {
            json.WriteStartObject();
            foreach (var (name, bytes) in files) json.WriteString(name, Convert.ToHexStringLower(SHA1.HashData(bytes)));
            json.WriteEndObject();
        }
        return buffer.ToArray();
    }

    private byte[] Sign(byte[] manifest)
    {
        var cms = new SignedCms(new ContentInfo(manifest), detached: true);
        var signer = new CmsSigner(SubjectIdentifierType.IssuerAndSerialNumber, config.Signer)
        {
            DigestAlgorithm = new Oid("1.3.14.3.2.26"), // SHA-1, as passkit-generator uses
            IncludeOption = X509IncludeOption.EndCertOnly,
        };
        signer.Certificates.Add(config.Wwdr);
        signer.SignedAttributes.Add(new Pkcs9SigningTime(DateTime.UtcNow));
        cms.ComputeSignature(signer, silent: true);
        return cms.Encode();
    }

    private static byte[] Png(int width, int height, Action<SKCanvas> draw)
    {
        using var bitmap = new SKBitmap(width, height);
        using (var canvas = new SKCanvas(bitmap)) draw(canvas);
        using var image = SKImage.FromBitmap(bitmap);
        using var data = image.Encode(SKEncodedImageFormat.Png, 100);
        return data.ToArray();
    }

    private static byte[] Icon(int size) => Png(size, size, canvas => canvas.Clear(Background));

    /// <summary>The 400×144 stamp strip from renderPass, drawn at <paramref name="width"/>×<paramref name="height"/>.</summary>
    internal static byte[] Strip(NativeCard card, int width, int height) => Png(width, height, canvas =>
    {
        canvas.Clear(Background);
        var scale = Math.Min(width / 400f, height / 144f);
        canvas.Translate((width - 400 * scale) / 2, (height - 144 * scale) / 2);
        canvas.Scale(scale);
        using var text = new SKPaint { Color = Ink, IsAntialias = true };
        using var font = new SKFont(Typeface.Value, 13);
        canvas.DrawText(card.CafeName, 12, 20, SKTextAlign.Left, font, text);
        using var stroke = new SKPaint { Color = Ink, IsAntialias = true, Style = SKPaintStyle.Stroke, StrokeWidth = 2 };
        using var fill = new SKPaint { Color = Ink, IsAntialias = true, Style = SKPaintStyle.Fill };
        for (var index = 0; index < card.Target; index++)
        {
            float x = 25 + index % 6 * 63, y = 55 + index / 6 * 55;
            if (index < card.Stamps) canvas.DrawCircle(x, y, 16, fill);
            canvas.DrawCircle(x, y, 16, stroke);
        }
    });
}
