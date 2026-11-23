using System.Diagnostics;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Joeyy.Api.Tests.Support;

namespace Joeyy.Api.Tests;

/// <summary>Starts the real server binary as its own process, the way Azure runs it.</summary>
public sealed partial class ServerProcessTests
{
    /// <summary>services/api-dotnet/Joeyy.Api/bin/&lt;configuration&gt;/net10.0/Joeyy.Api.dll, next to this test project's output.</summary>
    private static string ServerDll()
    {
        var testOutput = new DirectoryInfo(AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar));
        var configuration = testOutput.Parent!.Name;
        var root = testOutput.Parent!.Parent!.Parent!.Parent!.FullName;
        return Path.Combine(root, "Joeyy.Api", "bin", configuration, testOutput.Name, "Joeyy.Api.dll");
    }

    private static Process Launch(Dictionary<string, string?> env, params string[] args)
    {
        var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("DOTNET_HOST_PATH") ?? "dotnet")
        {
            RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false,
        };
        start.ArgumentList.Add(ServerDll());
        foreach (var arg in args) start.ArgumentList.Add(arg);
        foreach (var key in start.Environment.Keys.Where(key => key.StartsWith("PG", StringComparison.Ordinal) || key.StartsWith("NATIVE_", StringComparison.Ordinal)).ToList())
        {
            start.Environment.Remove(key);
        }
        foreach (var (key, value) in env) start.Environment[key] = value;
        return Process.Start(start)!;
    }

    [Fact]
    public async Task ServerRefusesToStartWithMissingSettings()
    {
        using var process = Launch(new() { ["NATIVE_NFC_ENABLED"] = "1", ["PUBLIC_BASE_URL"] = "" });
        var stderr = await process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(30));
        Assert.NotEqual(0, process.ExitCode);
        Assert.Contains("Native NFC requires PUBLIC_BASE_URL", stderr);
    }

    [GeneratedRegex(@"Now listening on: (http://127\.0\.0\.1:\d+)")]
    private static partial Regex Listening();

    [Fact]
    public async Task EnabledServerStartsServesTapsAndSignedPassesAndShutsDownGracefully()
    {
        using var certificates = new FixtureCertificates();
        await using var database = await TestDatabase.Create();
        await using var verifier = await StubVerifier.Start();
        const string uid = "04DE5F1EACC040";
        verifier.Fixed = new { uid, read_ctr = 50, enc_mode = "AES" };
        var cafe = Guid.NewGuid();
        await database.Execute("INSERT INTO native_cafes(id,name,target) VALUES($1,'Hardware Test Cafe',3)", cafe);
        await database.Execute("INSERT INTO native_tags(uid,cafe_id) VALUES($1,$2)", uid, cafe);

        var settings = certificates.Settings(verifier.Url);
        var env = new Dictionary<string, string?>(settings);
        foreach (var (key, value) in TestDatabase.Env) env[key] = value;
        env["PGOPTIONS"] = $"-c search_path={database.Schema}";
        env["HOST"] = "127.0.0.1";
        env["PORT"] = "0";
        env["NODE_ENV"] = "test";

        using var process = Launch(env);
        var origin = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        var output = new StringBuilder();
        process.OutputDataReceived += (_, line) =>
        {
            if (line.Data is null) return;
            lock (output) output.AppendLine(line.Data);
            if (Listening().Match(line.Data) is { Success: true } match) origin.TrySetResult(match.Groups[1].Value);
        };
        process.ErrorDataReceived += (_, line) => { if (line.Data is not null) lock (output) output.AppendLine(line.Data); };
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        try
        {
            var exited = process.WaitForExitAsync().ContinueWith(_ => "");
            var first = await Task.WhenAny(origin.Task, exited, Task.Delay(TimeSpan.FromSeconds(30)));
            Assert.True(first == origin.Task, $"Server did not start:\n{output}");
            using var http = new HttpClient { BaseAddress = new Uri(await origin.Task) };

            Assert.True((await http.GetFromJsonAsync<JsonElement>("/healthz")).GetProperty("nativeNfc").GetProperty("enabled").GetBoolean());
            JsonAssert.Equal(new { status = "ok", factoryKeyTest = true, publicBaseURL = settings["PUBLIC_BASE_URL"], prototypeMode = true },
                await http.GetFromJsonAsync<JsonElement>("/api/v1/healthz"));

            var guestSession = await http.PostAsync("/api/v1/prototype/session", null);
            Assert.Equal(200, (int)guestSession.StatusCode);
            var guest = await guestSession.Content.ReadFromJsonAsync<JsonElement>();
            Assert.True(guest.GetProperty("prototype").GetBoolean());
            using (var request = new HttpRequestMessage(HttpMethod.Get, "/api/v1/cards"))
            {
                request.Headers.Authorization = new("Bearer", guest.GetProperty("token").GetString());
                JsonAssert.Equal(new { cards = Array.Empty<object>() }, await (await http.SendAsync(request)).Content.ReadFromJsonAsync<JsonElement>());
            }

            var signup = await http.PostAsJsonAsync("/api/v1/accounts", new { username = "running-native", password = "native-fixture-password" });
            Assert.Equal(201, (int)signup.StatusCode);
            var token = (await signup.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("token").GetString();
            using var tap = new HttpRequestMessage(HttpMethod.Post, "/api/v1/taps")
            {
                Content = JsonContent.Create(new { url = "https://expired-host.example/tagtt?e=0011", requestId = Guid.NewGuid() }),
            };
            tap.Headers.Authorization = new("Bearer", token);
            var tapped = await http.SendAsync(tap);
            var tapBody = await tapped.Content.ReadAsStringAsync();
            Assert.True((int)tapped.StatusCode == 200, $"{tapBody}\n{output}");
            var earned = JsonDocument.Parse(tapBody).RootElement;
            Assert.Equal(1, earned.GetProperty("card").GetProperty("stamps").GetInt32());

            using var download = new HttpRequestMessage(HttpMethod.Get, $"/api/v1/cards/{earned.GetProperty("card").GetProperty("id").GetString()!.ToUpperInvariant()}/pass");
            download.Headers.Authorization = new("Bearer", token);
            var pass = await http.SendAsync(download);
            Assert.Equal(200, (int)pass.StatusCode);
            Assert.Equal("PK", Encoding.ASCII.GetString((await pass.Content.ReadAsByteArrayAsync())[..2]));

            // Container Apps stops revisions with SIGTERM; the worker must stop and the process exit cleanly.
            using (var kill = Process.Start("kill", ["-TERM", process.Id.ToString(System.Globalization.CultureInfo.InvariantCulture)])) await kill.WaitForExitAsync();
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(30));
            Assert.True(process.ExitCode == 0, output.ToString());
        }
        finally
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
        }
        Assert.DoesNotContain("native-fixture-password", output.ToString());
    }
}
