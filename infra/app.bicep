// The running JOEYY backend: one Container App with two containers in the same private network space.
//   api      - the Node backend (public HTTPS through Container Apps ingress)
//   verifier - the NTAG 424 SDM verifier, listening only on 127.0.0.1:5005 inside the app
// Secrets stay in Key Vault; the app reads them with its managed identity.
// Safe to redeploy any time (GitHub Actions does this on every merge to main).

param location string = resourceGroup().location

@description('Image tag (usually the git commit) for both containers.')
param imageTag string

param appName string = 'joeyy-api'

@description('Registry repository of the api container: joeyy-api (Node, services/api/) or joeyy-api-dotnet (ASP.NET, services/api-dotnet/).')
param apiImageName string = 'joeyy-api'

param environmentName string = 'joeyy-dev-env'
param registryName string
param keyVaultName string
param apiIdentityName string = 'joeyy-api-identity'

@description('Optional permanent public origin, for example https://api.joeyy.com. Empty uses the Azure address.')
param publicBaseURL string = ''

param passTypeId string
param teamId string

@description('Keep 1 for the prototype: anonymous no-account scanning. Turn off before real customers.')
@allowed(['0', '1'])
param prototypeMode string = '1'

@description('factory-test only works with chips still using factory keys. Use provisioned for real chips.')
@allowed(['factory-test', 'provisioned'])
param nfcKeyMode string = 'factory-test'

param databaseHost string = 'joeyy-dev-pg.postgres.database.azure.com'
param databaseName string = 'joeyyRewards'
param databaseUser string = 'joeyy-devs'
param imageStorageAccountName string = 'joeyydevimages'

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: environmentName
}
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}
resource apiIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: apiIdentityName
}

var origin = empty(publicBaseURL) ? 'https://${appName}.${environment.properties.defaultDomain}' : publicBaseURL
var vaultSecret = '${vault.properties.vaultUri}secrets/'
var secretNames = ['signer-cert', 'signer-key', 'wwdr-cert', 'sdm-master-key']

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${apiIdentity.id}': {} }
  }
  properties: {
    environmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        { server: registry.properties.loginServer, identity: apiIdentity.id }
      ]
      secrets: [for name in secretNames: {
        name: name
        keyVaultUrl: '${vaultSecret}${name}'
        identity: apiIdentity.id
      }]
    }
    template: {
      // One copy: the Wallet update worker and rate limits live in this process.
      scale: { minReplicas: 1, maxReplicas: 1 }
      volumes: [
        {
          name: 'wallet-signing'
          storageType: 'Secret'
          secrets: [
            { secretRef: 'signer-cert', path: 'signer-cert' }
            { secretRef: 'signer-key', path: 'signer-key' }
            { secretRef: 'wwdr-cert', path: 'wwdr-cert' }
          ]
        }
      ]
      containers: [
        {
          name: 'api'
          image: '${registry.properties.loginServer}/${apiImageName}:${imageTag}'
          resources: { cpu: json('0.5'), memory: '1Gi' }
          volumeMounts: [ { volumeName: 'wallet-signing', mountPath: '/secrets' } ]
          env: [
            { name: 'NODE_ENV', value: prototypeMode == '1' ? 'development' : 'production' }
            { name: 'PORT', value: '8080' }
            { name: 'PGHOST', value: databaseHost }
            { name: 'PGPORT', value: '5432' }
            { name: 'PGDATABASE', value: databaseName }
            { name: 'PGUSER', value: databaseUser }
            { name: 'AZURE_CLIENT_ID', value: apiIdentity.properties.clientId }
            { name: 'AZURE_TOKEN_CREDENTIALS', value: 'prod' }
            { name: 'AUTH_MODE', value: 'dev' }
            { name: 'IMAGE_STORE', value: 'azure' }
            { name: 'AZURE_STORAGE_ACCOUNT', value: imageStorageAccountName }
            { name: 'IMAGE_CLEANUP', value: 'off' }
            { name: 'NATIVE_NFC_ENABLED', value: '1' }
            { name: 'NATIVE_PROTOTYPE_MODE', value: prototypeMode }
            { name: 'NATIVE_NFC_KEY_MODE', value: nfcKeyMode }
            { name: 'FACTORY_KEY_TEST', value: nfcKeyMode == 'factory-test' ? '1' : '0' }
            { name: 'PUBLIC_BASE_URL', value: origin }
            { name: 'SDM_BACKEND_URL', value: 'http://127.0.0.1:5005' }
            { name: 'PASS_TYPE_ID', value: passTypeId }
            { name: 'TEAM_ID', value: teamId }
            { name: 'SIGNER_CERT_PATH', value: '/secrets/signer-cert' }
            { name: 'SIGNER_KEY_PATH', value: '/secrets/signer-key' }
            { name: 'WWDR_CERT_PATH', value: '/secrets/wwdr-cert' }
          ]
          probes: [
            {
              type: 'Startup'
              httpGet: { path: '/healthz', port: 8080 }
              periodSeconds: 5
              failureThreshold: 24
            }
            {
              type: 'Liveness'
              httpGet: { path: '/healthz', port: 8080 }
              periodSeconds: 30
            }
          ]
        }
        {
          name: 'verifier'
          image: '${registry.properties.loginServer}/joeyy-verifier:${imageTag}'
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: [
            { name: 'MASTER_KEY', secretRef: 'sdm-master-key' }
            { name: 'DERIVE_MODE', value: 'legacy' }
          ]
        }
      ]
    }
  }
}

output publicBaseURL string = origin
output fqdn string = app.properties.configuration.ingress.fqdn
