# JOEYY backend API (ASP.NET). Build from the REPOSITORY ROOT, because the SQL migrations live in backend/:
#   docker build --platform linux/amd64 -f backend-dotnet/Dockerfile -t joeyy-api-dotnet .
# Azure Container Registry builds natively on linux/amd64. (Its Dockerfile scanner rejects
# `FROM --platform=$BUILDPLATFORM`, so this file doesn't use it. On an Apple Silicon Mac, build without
# --platform for a native arm64 test image: .NET crashes under amd64 emulation.)
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
ARG TARGETARCH
WORKDIR /src
COPY backend-dotnet/global.json backend-dotnet/
COPY backend-dotnet/Joeyy.Api/Joeyy.Api.csproj backend-dotnet/Joeyy.Api/
RUN dotnet restore backend-dotnet/Joeyy.Api/Joeyy.Api.csproj -a "${TARGETARCH:-amd64}"
COPY backend-dotnet/Joeyy.Api/ backend-dotnet/Joeyy.Api/
COPY backend/db/migrations/ backend/db/migrations/
RUN dotnet publish backend-dotnet/Joeyy.Api/Joeyy.Api.csproj -c Release -a "${TARGETARCH:-amd64}" --self-contained false -o /app --no-restore \
    && test -f /app/migrations/0005_native_prototype.sql

FROM mcr.microsoft.com/dotnet/aspnet:10.0
# Wallet strip images draw the cafe name, which needs a font.
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-dejavu-core ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app .
ENV HOST=0.0.0.0 PORT=8080 DOTNET_EnableDiagnostics=0
# The base image's non-root user.
USER $APP_UID
EXPOSE 8080
ENTRYPOINT ["dotnet", "Joeyy.Api.dll"]
