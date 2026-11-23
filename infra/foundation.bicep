// One-time shared setup for hosting the JOEYY backend in joeyy-dev-rg.
// Needs Owner (it creates role assignments). Run through infra/owner-setup.sh.
// Everything else (infra/app.bicep) can then be deployed by the team or GitHub Actions.

@description('Azure region. Matches the existing database.')
param location string = resourceGroup().location

@description('GitHub OIDC subject prefix for the repository allowed to deploy. Newer repos use immutable IDs; see GET /repos/OWNER/REPO/actions/oidc/customization/sub.')
param githubSubjectPrefix string = 'repo:jarenadams21@94200103/stamp-protocol-ios@1437938662'

@description('Branch whose pushes GitHub Actions may deploy.')
param deployBranch string = 'main'

@description('Object ID of the Entra group whose members may deploy and manage secrets. Empty to skip.')
param teamGroupObjectId string = ''

@description('Existing storage account used for partner images.')
param imageStorageAccountName string = 'joeyydevimages'

var suffix = take(uniqueString(resourceGroup().id), 6)
var roles = {
  acrPull: '7f951dda-4ed3-4680-a7ca-43fe172d538d'
  acrPush: '8311e382-0749-4cb8-b61a-304f252e45ec'
  contributor: 'b24988ac-6180-42a0-ab88-20f7382dd24c'
  keyVaultSecretsUser: '4633458b-17de-408a-b874-0445c86b69e6'
  keyVaultSecretsOfficer: 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
  storageBlobDataContributor: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
}

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'joeyy-dev-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: 'joeyydevacr${suffix}'
  location: location
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false }
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: 'joeyy-dev-kv-${suffix}'
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
  }
}

// The identity the running backend uses for the registry, Key Vault, storage and (via joeyy-devs) PostgreSQL.
resource apiIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'joeyy-api-identity'
  location: location
}

// The identity GitHub Actions signs in as. No stored password: GitHub proves who it is with OIDC.
resource deployer 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'joeyy-github-deployer'
  location: location
}

resource githubTrust 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: deployer
  name: 'github-${deployBranch}'
  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    subject: '${githubSubjectPrefix}:ref:refs/heads/${deployBranch}'
    audiences: ['api://AzureADTokenExchange']
  }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'joeyy-dev-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

resource imageStorage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: imageStorageAccountName
}

resource apiPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, apiIdentity.id, roles.acrPull)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.acrPull)
    principalId: apiIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource apiSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, apiIdentity.id, roles.keyVaultSecretsUser)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.keyVaultSecretsUser)
    principalId: apiIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource apiImages 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: imageStorage
  name: guid(imageStorage.id, apiIdentity.id, roles.storageBlobDataContributor)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.storageBlobDataContributor)
    principalId: apiIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource deployerPush 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, deployer.id, roles.acrPush)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.acrPush)
    principalId: deployer.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource deployerContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, deployer.id, roles.contributor)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.contributor)
    principalId: deployer.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource teamContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(teamGroupObjectId)) {
  name: guid(resourceGroup().id, teamGroupObjectId, roles.contributor)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.contributor)
    principalId: teamGroupObjectId
    principalType: 'Group'
  }
}

resource teamPush 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(teamGroupObjectId)) {
  scope: registry
  name: guid(registry.id, teamGroupObjectId, roles.acrPush)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.acrPush)
    principalId: teamGroupObjectId
    principalType: 'Group'
  }
}

resource teamSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(teamGroupObjectId)) {
  scope: vault
  name: guid(vault.id, teamGroupObjectId, roles.keyVaultSecretsOfficer)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.keyVaultSecretsOfficer)
    principalId: teamGroupObjectId
    principalType: 'Group'
  }
}

output registryName string = registry.name
output registryServer string = registry.properties.loginServer
output keyVaultName string = vault.name
output environmentName string = environment.name
output apiIdentityName string = apiIdentity.name
output apiIdentityPrincipalId string = apiIdentity.properties.principalId
output deployerClientId string = deployer.properties.clientId
