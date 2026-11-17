#!/usr/bin/env bash
# ONE-TIME Azure setup for hosting the JOEYY backend. Must be run by a subscription Owner.
#   az login --tenant 939f4731-d4d0-4cc5-b75e-decd2df66d0a
#   infra/owner-setup.sh
# Safe to re-run. Creates: container registry, Key Vault, Container Apps environment, log workspace,
# the backend's managed identity, and a GitHub Actions deploy identity (OIDC, no stored password).
# Also lets the joeyy-devs group deploy, and adds the backend identity to joeyy-devs so it can use
# the database and image storage exactly like a team member does.
set -euo pipefail
cd "$(dirname "$0")"

RG=${RG:-joeyy-dev-rg}
TEAM_GROUP=${TEAM_GROUP:-joeyy-devs}
REPO=${GITHUB_REPOSITORY:-jarenadams21/stamp-protocol-ios}

echo "Registering Azure services (first time can take a few minutes)…"
for ns in Microsoft.App Microsoft.ContainerRegistry Microsoft.KeyVault Microsoft.OperationalInsights Microsoft.ManagedIdentity; do
  az provider register --namespace "$ns" --wait --only-show-errors
done

group_id=$(az ad group show --group "$TEAM_GROUP" --query id -o tsv)
# GitHub's OIDC token subject for this repo (new repos use immutable owner/repo IDs).
subject_prefix=$(curl -fsS "https://api.github.com/repos/$REPO/actions/oidc/customization/sub" |
  python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("sub_claim_prefix") or "")')
[[ -n $subject_prefix ]] || subject_prefix="repo:$REPO"

echo "Creating shared resources in $RG…"
az deployment group create -g "$RG" -n joeyy-foundation -f foundation.bicep \
  -p teamGroupObjectId="$group_id" githubSubjectPrefix="$subject_prefix" --only-show-errors -o none
out() { az deployment group show -g "$RG" -n joeyy-foundation --query "properties.outputs.$1.value" -o tsv; }

principal=$(out apiIdentityPrincipalId)
if [[ $(az ad group member check --group "$group_id" --member-id "$principal" --query value -o tsv) != true ]]; then
  az ad group member add --group "$group_id" --member-id "$principal"
fi

cat <<EOF

Done. Shared setup is ready.
  Registry:        $(out registryServer)
  Key Vault:       $(out keyVaultName)
  Environment:     $(out environmentName)

Add these to GitHub → $REPO → Settings → Secrets and variables → Actions → Variables:
  AZURE_CLIENT_ID        $(out deployerClientId)
  AZURE_TENANT_ID        $(az account show --query tenantId -o tsv)
  AZURE_SUBSCRIPTION_ID  $(az account show --query id -o tsv)

Wait ~10 minutes for Azure to apply the new access rights, then a $TEAM_GROUP member can run
infra/deploy.sh --upload-secrets (see infra/README.md).
EOF
