using System.Collections;
using Joeyy.Api.Infrastructure;
using Npgsql;

namespace Joeyy.Api.Tests.Support;

/// <summary>
/// A fresh schema with every migration applied. Uses PG* settings from the environment (a Postgres service
/// container in CI, or the local Docker one at 127.0.0.1:55432). Never the shared Azure database.
/// </summary>
public sealed class TestDatabase : IAsyncDisposable
{
    public static IReadOnlyDictionary<string, string?> Env { get; } = LoadEnv();

    private static Dictionary<string, string?> LoadEnv()
    {
        var env = new Dictionary<string, string?>
        {
            ["PGHOST"] = "127.0.0.1", ["PGPORT"] = "55432", ["PGDATABASE"] = "joeyy",
            ["PGUSER"] = "joeyy", ["PGPASSWORD"] = "joeyy", ["PGSSLMODE"] = "disable",
        };
        foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables())
        {
            if (entry.Key is string key && key.StartsWith("PG", StringComparison.Ordinal)) env[key] = entry.Value as string;
        }
        if (env["PGHOST"] is not ("127.0.0.1" or "localhost"))
        {
            throw new InvalidOperationException("Tests require explicitly configured local PostgreSQL (PGHOST=127.0.0.1 or localhost).");
        }
        return env;
    }

    public string Schema { get; }
    public NpgsqlDataSource Pool { get; }

    private TestDatabase(string schema)
    {
        Schema = schema;
        Pool = Database.Create(Env, searchPath: schema, maxPoolSize: 8);
    }

    public static async Task<TestDatabase> Create()
    {
        var schema = $"test_{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}_{Random.Shared.Next(1_000_000)}";
        await using (var admin = Database.Create(Env, maxPoolSize: 1))
        await using (var connection = await admin.OpenConnectionAsync())
        {
            await connection.Execute($"CREATE SCHEMA {schema}");
        }
        var database = new TestDatabase(schema);
        await Migrator.Migrate(database.Pool);
        return database;
    }

    /// <summary>A genuinely separate pool on the same schema, like a second server process.</summary>
    public NpgsqlDataSource NewPool(int maxPoolSize = 4) => Database.Create(Env, searchPath: Schema, maxPoolSize: maxPoolSize);

    public async Task<int> Execute(string sql, params object?[] args)
    {
        await using var connection = await Pool.OpenConnectionAsync();
        return await connection.Execute(sql, args);
    }

    public async Task<T?> Scalar<T>(string sql, params object?[] args)
    {
        await using var connection = await Pool.OpenConnectionAsync();
        await using var command = connection.Command(sql, args);
        var value = await command.ExecuteScalarAsync();
        return value is null or DBNull ? default : (T)value;
    }

    public async ValueTask DisposeAsync()
    {
        await Pool.DisposeAsync();
        await using var admin = Database.Create(Env, maxPoolSize: 1);
        await using var connection = await admin.OpenConnectionAsync();
        await connection.Execute($"DROP SCHEMA {Schema} CASCADE");
    }
}
