using 'app.bicep'

// Non-secret settings for the shared dev backend. Secrets live in Key Vault (see infra/README.md).
param imageTag = readEnvironmentVariable('IMAGE_TAG')
param registryName = readEnvironmentVariable('REGISTRY_NAME')
param keyVaultName = readEnvironmentVariable('KEY_VAULT_NAME')
param publicBaseURL = readEnvironmentVariable('PUBLIC_BASE_URL', '')

// The api container runs the ASP.NET backend (services/api-dotnet/). To go back to Node, see infra/README.md.
param apiImageName = 'joeyy-api-dotnet'

param passTypeId = 'pass.com.cafewallet.prototype'
param teamId = 'S23DT2V34P'
param prototypeMode = '1'
param nfcKeyMode = 'factory-test'

// The app's own database login (created once by a PostgreSQL Entra admin, member of joeyy-devs).
param databaseUser = 'joeyy-api-identity'
