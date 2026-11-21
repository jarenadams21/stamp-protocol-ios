using Azure.Core;
using Azure.Identity;
using Npgsql;
using NpgsqlTypes;

namespace Joeyy.Api.Infrastructure;

/// <summary>PostgreSQL access. Mirrors backend/src/db.ts.</summary>
public static class Database
{
    /// <summary>Entra scope for Azure Database for PostgreSQL.</summary>
    private const string PostgresScope = "https://ossrdbms-aad.database.windows.net/.default";

    /// <summary>
    /// Creates a connection pool from the standard PG* environment variables. Uses PGPASSWORD when it is set,
    /// and a Microsoft Entra token otherwise (`az login` locally, the managed identity in Azure), so no database
    /// password is stored anywhere. TLS with certificate verification is on unless PGSSLMODE=disable.
    /// </summary>
    public static NpgsqlDataSource Create(IReadOnlyDictionary<string, string?> env, string? searchPath = null, int maxPoolSize = 10)
    {
        string? Get(string key) => env.TryGetValue(key, out var value) && !string.IsNullOrEmpty(value) ? value : null;
        var host = Get("PGHOST");
        var database = Get("PGDATABASE");
        var user = Get("PGUSER");
        if (host is null || database is null || user is null)
        {
            throw new ConfigurationException("Set PGHOST, PGDATABASE, and PGUSER (see backend/.env.example)");
        }
        var settings = new NpgsqlConnectionStringBuilder
        {
            Host = host,
            Database = database,
            Username = user,
            Port = int.Parse(Get("PGPORT") ?? "5432", System.Globalization.CultureInfo.InvariantCulture),
            SslMode = Get("PGSSLMODE") == "disable" ? SslMode.Disable : SslMode.VerifyFull,
            MaxPoolSize = maxPoolSize,
            Timeout = 30,
            ConnectionIdleLifetime = 30,
            ApplicationName = "joeyy-backend-dotnet",
            // Azure uses TLS + Entra tokens, never Kerberos; skip the GSSAPI probe (its library isn't in the image).
            GssEncryptionMode = GssEncryptionMode.Disable,
        };
        if (searchPath is not null) settings.SearchPath = searchPath;
        else if (Get("PGOPTIONS") is { } options) settings.Options = options;

        var password = Get("PGPASSWORD");
        if (password is not null) settings.Password = password;
        var builder = new NpgsqlDataSourceBuilder(settings.ConnectionString);
        if (password is null)
        {
            var credential = new DefaultAzureCredential();
            builder.UsePeriodicPasswordProvider(
                async (_, cancellation) => (await credential.GetTokenAsync(new TokenRequestContext([PostgresScope]), cancellation)).Token,
                successRefreshInterval: TimeSpan.FromMinutes(30),
                failureRefreshInterval: TimeSpan.FromSeconds(10));
        }
        return builder.Build();
    }

    /// <summary>Runs <paramref name="work"/> in a transaction, committing on success and rolling back on any error.</summary>
    public static async Task<T> Transaction<T>(this NpgsqlDataSource source, Func<NpgsqlConnection, Task<T>> work)
    {
        await using var connection = await source.OpenConnectionAsync();
        await using var transaction = await connection.BeginTransactionAsync();
        try
        {
            var result = await work(connection);
            await transaction.CommitAsync();
            return result;
        }
        catch
        {
            try { await transaction.RollbackAsync(); } catch { /* the original error matters more */ }
            throw;
        }
    }

    public static Task Transaction(this NpgsqlDataSource source, Func<NpgsqlConnection, Task> work) =>
        source.Transaction<bool>(async connection => { await work(connection); return true; });

    /// <summary>Builds a command with positional $1, $2… parameters, like node-postgres.</summary>
    public static NpgsqlCommand Command(this NpgsqlConnection connection, string sql, params object?[] args)
    {
        var command = new NpgsqlCommand(sql, connection);
        foreach (var arg in args)
        {
            command.Parameters.Add(arg as NpgsqlParameter ?? new NpgsqlParameter { Value = arg ?? DBNull.Value });
        }
        return command;
    }

    public static async Task<int> Execute(this NpgsqlConnection connection, string sql, params object?[] args)
    {
        await using var command = connection.Command(sql, args);
        return await command.ExecuteNonQueryAsync();
    }

    /// <summary>Returns the first row mapped by <paramref name="map"/>, or default when there is none.</summary>
    public static async Task<T?> QueryFirst<T>(this NpgsqlConnection connection, string sql, Func<NpgsqlDataReader, T> map, params object?[] args)
    {
        await using var command = connection.Command(sql, args);
        await using var reader = await command.ExecuteReaderAsync();
        return await reader.ReadAsync() ? map(reader) : default;
    }

    public static async Task<List<T>> QueryAll<T>(this NpgsqlConnection connection, string sql, Func<NpgsqlDataReader, T> map, params object?[] args)
    {
        await using var command = connection.Command(sql, args);
        await using var reader = await command.ExecuteReaderAsync();
        var rows = new List<T>();
        while (await reader.ReadAsync()) rows.Add(map(reader));
        return rows;
    }

    /// <summary>Uses <paramref name="connection"/> when given (inside a transaction), otherwise a pooled connection.</summary>
    public static async Task<T> With<T>(this NpgsqlDataSource source, NpgsqlConnection? connection, Func<NpgsqlConnection, Task<T>> work)
    {
        if (connection is not null) return await work(connection);
        await using var pooled = await source.OpenConnectionAsync();
        return await work(pooled);
    }

    /// <summary>A uuid parameter that may be null, for `$n::uuid IS NULL OR column=$n`.</summary>
    public static NpgsqlParameter NullableUuid(Guid? value) =>
        new() { NpgsqlDbType = NpgsqlDbType.Uuid, Value = value is { } id ? id : DBNull.Value };
}
