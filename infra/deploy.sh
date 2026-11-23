#!/usr/bin/env bash
# Build and deploy the JOEYY backend to Azure Container Apps. Any joeyy-devs member can run it
# (after infra/owner-setup.sh has been run once). GitHub Actions runs the same script on merge to main.
#
#   infra/deploy.sh                  build the current commit in Azure and deploy it
#   infra/deploy.sh --upload-secrets also (re)upload Wallet signing files + verifier key to Key Vault
#
# --upload-secrets reads file paths from SIGNER_CERT_PATH, SIGNER_KEY_PATH, WWDR_CERT_PATH and
# SDM_ENV_FILE (a file containing MASTER_KEY=...). Nothing secret is printed or committed.
set -euo pipefail
cd "$(dirname "$0")/.."

RG=${RG:-joeyy-dev-rg}
foundation() { az deployment group show -g "$RG" -n joeyy-foundation --query "properties.outputs.$1.value" -o tsv; }
export REGISTRY_NAME=${REGISTRY_NAME:-$(foundation registryName)}
export KEY_VAULT_NAME=${KEY_VAULT_NAME:-$(foundation keyVaultName)}

if [[ ${1:-} == --upload-secrets ]]; then
  for key in SIGNER_CERT_PATH SIGNER_KEY_PATH WWDR_CERT_PATH SDM_ENV_FILE; do
    [[ -r ${!key:-} ]] || { echo "Set $key to a readable file." >&2; exit 1; }
  done
  upload() { az keyvault secret set --vault-name "$KEY_VAULT_NAME" -n "$1" --file "$2" --only-show-errors -o none; }
  upload signer-cert "$SIGNER_CERT_PATH"
  upload signer-key "$SIGNER_KEY_PATH"
  upload wwdr-cert "$WWDR_CERT_PATH"
  master=$(mktemp); trap 'rm -f "$master"' EXIT; chmod 600 "$master"
  sed -n 's/^MASTER_KEY=//p' "$SDM_ENV_FILE" | tr -d '"\r\n' >"$master"
  grep -Eq '^[0-9A-Fa-f]{32}$' "$master" || { echo "SDM_ENV_FILE must contain MASTER_KEY=<32 hex characters>." >&2; exit 1; }
  upload sdm-master-key "$master"
  echo "Secrets uploaded to Key Vault $KEY_VAULT_NAME."
fi

if [[ -n $(git status --porcelain -- services/api services/api-dotnet services/verifier infra .dockerignore) ]]; then
  echo "Commit your services/ and infra/ changes first, so the deployed version matches a commit." >&2
  exit 1
fi
export IMAGE_TAG=${IMAGE_TAG:-$(git rev-parse --short=12 HEAD)}

echo "Building images ${IMAGE_TAG} in Azure Container Registry ${REGISTRY_NAME}…"
# The api is the ASP.NET backend. Its build context is the repository root, because the SQL migrations
# it ships with live in services/api/db/migrations.
az acr build -r "$REGISTRY_NAME" -t "joeyy-api-dotnet:$IMAGE_TAG" --platform linux/amd64 --no-logs --only-show-errors -o none \
  -f services/api-dotnet/Dockerfile .
az acr build -r "$REGISTRY_NAME" -t "joeyy-verifier:$IMAGE_TAG" --platform linux/amd64 --no-logs --only-show-errors -o none services/verifier

echo "Deploying…"
# Retries cover Azure's delay in applying new access rights on the very first deploy.
for attempt in 1 2 3; do
  if origin=$(az deployment group create -g "$RG" -n "joeyy-api-$IMAGE_TAG" -p infra/dev.bicepparam \
      --query properties.outputs.publicBaseURL.value -o tsv --only-show-errors); then break; fi
  [[ $attempt -lt 3 ]] || exit 1
  echo "Deployment failed (attempt $attempt); retrying in 2 minutes…" >&2; sleep 120
done

echo "Waiting for $origin to report healthy…"
for _ in $(seq 1 30); do
  if body=$(curl -fsS --max-time 10 "$origin/api/v1/healthz" 2>/dev/null); then
    echo "Live: $origin  $body"
    exit 0
  fi
  sleep 10
done
echo "Deployed, but $origin/api/v1/healthz is not healthy yet. Check logs:" >&2
echo "  az containerapp logs show -g $RG -n joeyy-api --container api --tail 50" >&2
exit 1
