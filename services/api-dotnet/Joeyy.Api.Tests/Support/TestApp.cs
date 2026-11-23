using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;
using Joeyy.Api.Native;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Logging;
using Npgsql;

namespace Joeyy.Api.Tests.Support;

public sealed record Reply(HttpStatusCode Status, string Body, HttpResponseMessage Response)
{
    public int Code => (int)Status;
    public JsonElement Json => JsonDocument.Parse(Body).RootElement;
    public string? Header(string name) =>
        Response.Headers.TryGetValues(name, out var values) || Response.Content.Headers.TryGetValues(name, out values) ? string.Join(",", values) : null;
}

/// <summary>The real app on an in-memory test server, like Fastify's inject().</summary>
public sealed class TestApp : IAsyncDisposable
{
    private readonly WebApplication app;
    public HttpClient Client { get; }

    private TestApp(WebApplication app)
    {
        this.app = app;
        Client = app.GetTestClient();
    }

    public static async Task<TestApp> Start(NpgsqlDataSource pool, NativeServices? native, ILoggerProvider? logs = null)
    {
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Testing" });
        builder.WebHost.UseTestServer();
        builder.Logging.ClearProviders();
        if (logs is not null)
        {
            builder.Logging.AddProvider(logs);
            builder.Logging.SetMinimumLevel(LogLevel.Trace);
        }
        var app = JoeyyApp.Build(builder, pool, native);
        await app.StartAsync();
        return new TestApp(app);
    }

    public async Task<Reply> Send(HttpMethod method, string path, string? token = null, object? json = null,
        Dictionary<string, string>? headers = null, string? rawBody = null, string contentType = "application/json")
    {
        using var request = new HttpRequestMessage(method, path);
        if (token is not null) request.Headers.TryAddWithoutValidation("Authorization", $"Bearer {token}");
        foreach (var (name, value) in headers ?? []) request.Headers.TryAddWithoutValidation(name, value);
        var body = rawBody ?? (json is null ? null : JsonSerializer.Serialize(json));
        if (body is not null) request.Content = new StringContent(body, Encoding.UTF8, contentType);
        var response = await Client.SendAsync(request);
        return new Reply(response.StatusCode, await response.Content.ReadAsStringAsync(), response);
    }

    /// <summary>Sends a request built directly on the server side, for headers HttpClient refuses to send (an empty Authorization).</summary>
    public async Task<(int Status, string Body)> SendRaw(string method, string path, Action<Microsoft.AspNetCore.Http.HttpContext> configure)
    {
        var context = await app.GetTestServer().SendAsync(context =>
        {
            context.Request.Method = method;
            context.Request.Path = path;
            configure(context);
        });
        return (context.Response.StatusCode, await new StreamReader(context.Response.Body).ReadToEndAsync());
    }

    public Task<Reply> Get(string path, string? token = null, Dictionary<string, string>? headers = null) => Send(HttpMethod.Get, path, token, headers: headers);
    public Task<Reply> Post(string path, string? token = null, object? json = null) => Send(HttpMethod.Post, path, token, json);
    public Task<Reply> Delete(string path, string? token = null) => Send(HttpMethod.Delete, path, token);

    public async ValueTask DisposeAsync()
    {
        Client.Dispose();
        await app.StopAsync();
        await app.DisposeAsync();
    }
}

/// <summary>Captures every log line so tests can check nothing sensitive is written.</summary>
public sealed class CapturingLogs : ILoggerProvider
{
    public ConcurrentQueue<string> Lines { get; } = new();
    public ILogger CreateLogger(string categoryName) => new Logger(this, categoryName);
    public void Dispose() { }

    private sealed class Logger(CapturingLogs owner, string category) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) =>
            owner.Lines.Enqueue($"{category} {logLevel} {formatter(state, exception)} {exception}");
    }
}
