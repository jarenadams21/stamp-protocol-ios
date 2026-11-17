using 'app.bicep'

// Non-secret settings for the shared dev backend. Secrets live in Key Vault (see infra/README.md).
param imageTag = readEnvironmentVariable('IMAGE_TAG')
param registryName = readEnvironmentVariable('REGISTRY_NAME')
param keyVaultName = readEnvironmentVariable('KEY_VAULT_NAME')
param publicBaseURL = readEnvironmentVariable('PUBLIC_BASE_URL', '')

param passTypeId = 'pass.com.cafewallet.prototype'
param teamId = 'S23DT2V34P'
param prototypeMode = '1'
param nfcKeyMode = 'factory-test'
