$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or
    $env:RUNNER_ARCH -ne 'X64' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'Run this check only on a disposable GitHub-hosted Windows x64 runner'
}

$runnerTemp = (Resolve-Path -LiteralPath $env:RUNNER_TEMP).Path
$inputs = Join-Path $runnerTemp 'agentrans-upgrade-inputs'
if ((Resolve-Path -LiteralPath $env:QA_INPUTS_ROOT).Path -ine $inputs) {
  throw 'Expected verified inputs directly under RUNNER_TEMP'
}

$openssl = (Get-Command openssl.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $openssl) {
  $openssl = Join-Path $env:ProgramFiles 'Git/usr/bin/openssl.exe'
}
if (-not (Test-Path -LiteralPath $openssl -PathType Leaf)) {
  throw 'OpenSSL is required to generate the isolated HTTPS test certificates'
}

$oldExe = Join-Path $inputs 'old/agentrans-0.1.0-test.20261119.1-win-x64-unsigned.exe'
$newExe = Join-Path $inputs 'new/agentrans-0.1.0-test.20261120.1-win-x64-unsigned.exe'
if ([IO.Path]::GetFullPath($env:QA_OLD_EXE) -ine [IO.Path]::GetFullPath($oldExe) -or
    [IO.Path]::GetFullPath($env:QA_NEW_EXE) -ine [IO.Path]::GetFullPath($newExe)) {
  throw 'Expected the selected public and candidate Agentrans installers'
}
if ($env:QA_NEW_SHA256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Expected the verified candidate EXE hash' }
$certificates = Join-Path $inputs 'tls'
New-Item -Path $certificates -ItemType Directory | Out-Null
$rootKey = Join-Path $certificates 'root.key'
$rootCa = Join-Path $certificates 'root.pem'
$rootDer = Join-Path $certificates 'root.cer'
$serverKey = Join-Path $certificates 'server.key'
$serverCsr = Join-Path $certificates 'server.csr'
$serverCert = Join-Path $certificates 'server.pem'
$serverExtensions = Join-Path $certificates 'server.ext'
[IO.File]::WriteAllText($serverExtensions, @'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:github.com,DNS:api.github.com
'@)
& $openssl genrsa -out $rootKey 2048
$caArgs = @('req', '-x509', '-new', '-key', $rootKey, '-sha256', '-days', '2', '-subj', "/CN=Agentrans Windows QA $env:GITHUB_RUN_ID", '-out', $rootCa,
  '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign,cRLSign')
& $openssl @caArgs
& $openssl x509 -in $rootCa -outform DER -out $rootDer
& $openssl genrsa -out $serverKey 2048
& $openssl req -new -key $serverKey -subj '/CN=github.com' -out $serverCsr
& $openssl x509 -req -in $serverCsr -CA $rootCa -CAkey $rootKey -CAcreateserial -out $serverCert -days 2 -sha256 -extfile $serverExtensions
$feedHosts = @('github.com', 'api.github.com')
foreach ($feedHost in $feedHosts) {
  & $openssl verify -CAfile $rootCa -verify_hostname $feedHost $serverCert
}

$configuration = [ordered]@{
  oldExe = $oldExe
  newExe = $newExe
  oldBlockMap = "$oldExe.blockmap"
  newBlockMap = "$newExe.blockmap"
  newYaml = Join-Path $inputs 'new/test.yml'
  newSignature = "$newExe.sig"
  newYamlSignature = Join-Path $inputs 'new/test.yml.sig'
  expectedNewSha256 = $env:QA_NEW_SHA256
  httpsKey = $serverKey
  httpsCert = $serverCert
  rootCa = $rootCa
}
$manifest = Join-Path $inputs 'manifest.json'
$configuration | ConvertTo-Json | Set-Content -LiteralPath $manifest -Encoding utf8NoBOM
$hostsPath = Join-Path $env:SystemRoot 'System32/drivers/etc/hosts'
$originalHosts = [IO.File]::ReadAllBytes($hostsPath)
if ([Text.Encoding]::ASCII.GetString($originalHosts) -match '(?im)^[^#\r\n]+[ \t](?:api\.)?github\.com(?=[ \t#]|\r?$)') {
  throw 'The clean runner already has a GitHub hosts override'
}
$certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($rootDer)
$rootStore = [Security.Cryptography.X509Certificates.X509Store]::new('Root', 'LocalMachine')
$trusted = $false
$hostsChanged = $false
try {
  $rootStore.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
  $rootStore.Add($certificate)
  $trusted = $true
  Write-Output 'Trusted the isolated CA in the disposable runner'
  $routeLines = $feedHosts | ForEach-Object { "127.0.0.1 $_ # Agentrans Windows update fixture" }
  $newline = [Environment]::NewLine
  $route = [Text.Encoding]::ASCII.GetBytes($newline + ($routeLines -join $newline) + $newline)
  $hostsChanged = $true
  [IO.File]::WriteAllBytes($hostsPath, [byte[]]($originalHosts + $route))
  ipconfig.exe /flushdns | Out-Null
  $checkRoutes = @'
import { lookup } from 'node:dns/promises'
for (const host of process.argv.slice(1)) {
  const { address } = await lookup(host, { family: 4 })
  if (address !== '127.0.0.1') throw Error(`Loopback route for ${host} is not active`)
}
'@
  node --input-type=module -e $checkRoutes -- @feedHosts
  Write-Output 'Verified the GitHub web and API loopback routes'
  node (Join-Path $PSScriptRoot 'verify-win-candidate.mjs') $manifest (Join-Path $runnerTemp 'agentrans-upgrade-qa')
} finally {
  try {
    if ($hostsChanged) {
      [IO.File]::WriteAllBytes($hostsPath, $originalHosts)
      ipconfig.exe /flushdns | Out-Null
    }
  } finally {
    try {
      if ($trusted) { $rootStore.Remove($certificate) }
    } finally {
      $rootStore.Dispose()
      $certificate.Dispose()
    }
  }
}
