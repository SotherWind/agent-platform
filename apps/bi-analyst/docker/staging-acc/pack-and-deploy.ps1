# Pack staging-acc context and upload to an SSH host, then accept & cleanup.
# Run from anywhere: powershell -File apps/bi-analyst/docker/staging-acc/pack-and-deploy.ps1

param(
  [string]$RemoteHost = "server",
  [string]$KnownHostsFile = (Join-Path $env:USERPROFILE ".ssh\known_hosts")
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..\")).Path
$StagingAcc = Join-Path $RepoRoot "apps\bi-analyst\docker\staging-acc"
$bi = Join-Path $RepoRoot "apps\bi-analyst"
$PackDir = Join-Path $env:TEMP "bi-analyst-staging-acc-pack"
$RemoteDir = "~/bi-analyst-staging-acc"

if (-not (Test-Path -LiteralPath $KnownHostsFile)) {
  throw "Known-hosts file not found: $KnownHostsFile. Refusing to connect without host-key verification."
}

$SshOptions = @(
  "-o", "BatchMode=yes",
  "-o", "StrictHostKeyChecking=yes",
  "-o", "UserKnownHostsFile=$KnownHostsFile"
)

function Invoke-CheckedNative {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Command failed with exit code $LASTEXITCODE"
  }
}

Write-Host "==> pack context from $RepoRoot"
Write-Host "==> generate ephemeral staging TLS certificates"
Invoke-CheckedNative "pnpm" @("--dir", $bi, "docker:certs")
if (Test-Path $PackDir) { Remove-Item -Recurse -Force $PackDir }
New-Item -ItemType Directory -Path (Join-Path $PackDir "context\packages\llm-sdk") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $PackDir "context\apps\bi-analyst") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $PackDir "mysql-init") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $PackDir "postgres-init") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $PackDir "mysql-certs") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $PackDir "postgres-certs") | Out-Null

Copy-Item (Join-Path $RepoRoot "package.json") (Join-Path $PackDir "context\package.json")
Copy-Item (Join-Path $RepoRoot "pnpm-workspace.yaml") (Join-Path $PackDir "context\pnpm-workspace.yaml")
$lock = Join-Path $RepoRoot "pnpm-lock.yaml"
if (Test-Path $lock) { Copy-Item $lock (Join-Path $PackDir "context\pnpm-lock.yaml") }

Copy-Item (Join-Path $RepoRoot "packages\llm-sdk\package.json") (Join-Path $PackDir "context\packages\llm-sdk\")
Copy-Item (Join-Path $RepoRoot "packages\llm-sdk\tsconfig.json") (Join-Path $PackDir "context\packages\llm-sdk\") -ErrorAction SilentlyContinue
Copy-Item -Recurse (Join-Path $RepoRoot "packages\llm-sdk\src") (Join-Path $PackDir "context\packages\llm-sdk\src")

Copy-Item (Join-Path $bi "package.json") (Join-Path $PackDir "context\apps\bi-analyst\")
Copy-Item (Join-Path $bi "tsconfig.json") (Join-Path $PackDir "context\apps\bi-analyst\")
Copy-Item (Join-Path $bi "tsconfig.build.json") (Join-Path $PackDir "context\apps\bi-analyst\")
New-Item -ItemType Directory -Path (Join-Path $PackDir "context\apps\bi-analyst\scripts") -Force | Out-Null
Copy-Item (Join-Path $bi "scripts\fix-dist-esm-extensions.mjs") (Join-Path $PackDir "context\apps\bi-analyst\scripts\")
Copy-Item (Join-Path $bi "scripts\clean-production-dist.mjs") (Join-Path $PackDir "context\apps\bi-analyst\scripts\")
Copy-Item -Recurse (Join-Path $bi "src") (Join-Path $PackDir "context\apps\bi-analyst\src")
Copy-Item -Recurse (Join-Path $bi "metadata") (Join-Path $PackDir "context\apps\bi-analyst\metadata")
Copy-Item -Recurse (Join-Path $bi "config") (Join-Path $PackDir "context\apps\bi-analyst\config")
Copy-Item (Join-Path $StagingAcc "Dockerfile") (Join-Path $PackDir "context\Dockerfile")
Copy-Item (Join-Path $StagingAcc "context.dockerignore") (Join-Path $PackDir "context\.dockerignore")
Copy-Item (Join-Path $StagingAcc "docker-compose.yml") (Join-Path $PackDir "docker-compose.yml")
Copy-Item (Join-Path $StagingAcc "remote-accept.sh") (Join-Path $PackDir "remote-accept.sh")
Copy-Item (Join-Path $StagingAcc "remote-cleanup.sh") (Join-Path $PackDir "remote-cleanup.sh")
Copy-Item (Join-Path $StagingAcc "mysql-wrap-entrypoint.sh") (Join-Path $PackDir "mysql-wrap-entrypoint.sh")
Copy-Item (Join-Path $StagingAcc "postgres-wrap-entrypoint.sh") (Join-Path $PackDir "postgres-wrap-entrypoint.sh")
Copy-Item (Join-Path $StagingAcc "mysql-init\*") (Join-Path $PackDir "mysql-init\")
Copy-Item (Join-Path $StagingAcc "postgres-init\*") (Join-Path $PackDir "postgres-init\")
Copy-Item (Join-Path $StagingAcc "mysql-certs\*") (Join-Path $PackDir "mysql-certs\")
Copy-Item (Join-Path $StagingAcc "postgres-certs\*") (Join-Path $PackDir "postgres-certs\")

# Bash on the Debian acceptance host must receive LF shell scripts. Git/PowerShell
# can preserve CRLF here, which makes `set -euo pipefail` fail before acceptance.
foreach ($script in @(
  (Join-Path $PackDir "remote-accept.sh"),
  (Join-Path $PackDir "remote-cleanup.sh"),
  (Join-Path $PackDir "mysql-wrap-entrypoint.sh"),
  (Join-Path $PackDir "postgres-wrap-entrypoint.sh")
)) {
  $content = Get-Content -Raw -LiteralPath $script
  # Shell comments are non-functional; ASCII also avoids a UTF-8 BOM on Windows PowerShell 5.
  Set-Content -LiteralPath $script -Value ($content -replace "`r`n", "`n") -NoNewline -Encoding ascii
}

$Tar = Join-Path $env:TEMP "bi-analyst-staging-acc.tgz"
if (Test-Path $Tar) { Remove-Item -Force $Tar }
Write-Host "==> create archive $Tar"
tar -czf $Tar -C $PackDir .
$Sha256 = (Get-FileHash -LiteralPath $Tar -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host "==> archive SHA-256 $Sha256"

Write-Host "==> upload to ${RemoteHost}:$RemoteDir"
Invoke-CheckedNative "ssh" ($SshOptions + @($RemoteHost, "rm -rf bi-analyst-staging-acc && mkdir -p bi-analyst-staging-acc"))
# scp tarball then extract on server
Invoke-CheckedNative "scp" ($SshOptions + @($Tar, "${RemoteHost}:~/bi-analyst-staging-acc.tgz"))
Invoke-CheckedNative "ssh" ($SshOptions + @($RemoteHost, "printf '%s  %s\n' '$Sha256' ~/bi-analyst-staging-acc.tgz | sha256sum -c -"))
Invoke-CheckedNative "ssh" ($SshOptions + @($RemoteHost, "rm -rf ~/bi-analyst-staging-acc && mkdir -p ~/bi-analyst-staging-acc && tar -xzf ~/bi-analyst-staging-acc.tgz -C ~/bi-analyst-staging-acc && rm -f ~/bi-analyst-staging-acc.tgz && chmod +x ~/bi-analyst-staging-acc/*.sh && ls -la ~/bi-analyst-staging-acc"))

Write-Host "==> remote accept"
Invoke-CheckedNative "ssh" ($SshOptions + @($RemoteHost, "bash ~/bi-analyst-staging-acc/remote-accept.sh"))

Write-Host "DONE accept. Run cleanup when ready:"
Write-Host "  ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$KnownHostsFile $RemoteHost \"bash ~/bi-analyst-staging-acc/remote-cleanup.sh\""
