using System.Text.RegularExpressions;
using Npgsql;

namespace Joeyy.Api.Infrastructure;

/// <summary>Applies backend/db/migrations. Same rules as backend/src/migrate.ts.</summary>
public static partial class Migrator
{
    /// <summary>The SQL files are copied next to the app at build time (see Joeyy.Api.csproj).</summary>
    public static string DefaultDirectory => Path.Combine(AppContext.BaseDirectory, "migrations");

    [GeneratedRegex(@"^\d{4}_.+\.sql\z", RegexOptions.CultureInvariant)]
    private static partial Regex MigrationFile();

    /// <summary>
    /// Applies every migration not yet recorded in schema_migrations, in file name order, each in its own
    /// transaction. Each file records its own version. <paramref name="role"/>: run as this role
    /// (SET LOCAL ROLE) so the objects it creates share one owner.
    /// </summary>
    public static async Task<List<string>> Migrate(NpgsqlDataSource source, string? directory = null, string? role = null, Action<string>? log = null)
    {
        log ??= _ => { };
        var files = Directory.GetFiles(directory ?? DefaultDirectory)
            .Select(Path.GetFileName)
            .OfType<string>()
            .Where(name => MigrationFile().IsMatch(name))
            .Order(StringComparer.Ordinal)
            .ToList();

        var applied = new HashSet<string>();
        await using (var connection = await source.OpenConnectionAsync())
        {
            var exists = await connection.QueryFirst("SELECT to_regclass('schema_migrations')::text", reader => reader.IsDBNull(0) ? null : reader.GetString(0));
            if (exists is not null)
            {
                foreach (var version in await connection.QueryAll("SELECT version FROM schema_migrations", reader => reader.GetString(0)))
                {
                    applied.Add(version);
                }
            }
        }

        var ran = new List<string>();
        foreach (var file in files)
        {
            var version = Path.GetFileNameWithoutExtension(file);
            if (applied.Contains(version)) continue;
            var sql = await File.ReadAllTextAsync(Path.Combine(directory ?? DefaultDirectory, file));
            try
            {
                await source.Transaction(async connection =>
                {
                    if (role is not null) await connection.Execute($"SET LOCAL ROLE {QuoteIdentifier(role)}");
                    // No parameters, so the whole file runs as one simple-protocol batch, like `psql -f`.
                    await using (var batch = new NpgsqlCommand(sql, connection))
                    {
                        await batch.ExecuteNonQueryAsync();
                    }
                    var recorded = await connection.QueryFirst("SELECT 1 FROM schema_migrations WHERE version = $1", _ => true, version);
                    if (!recorded) throw new InvalidOperationException($"{file} must insert '{version}' into schema_migrations");
                });
            }
            catch (Exception error)
            {
                throw new InvalidOperationException($"Migration {file} failed and was rolled back: {error.Message}", error);
            }
            log($"applied {version}");
            ran.Add(version);
        }
        if (ran.Count == 0) log("database is up to date");
        return ran;
    }

    public static string QuoteIdentifier(string name) => $"\"{name.Replace("\"", "\"\"")}\"";
}
