$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'Run this check only on a disposable GitHub-hosted Windows runner'
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

$oldExe = Join-Path $inputs 'old/agentrans-0.1.0-test.20261118.1-win-x64-unsigned.exe'
$newExe = Join-Path $inputs 'new/agentrans-0.1.0-test.20261118.2-win-x64-unsigned.exe'
if ([IO.Path]::GetFullPath($env:QA_OLD_EXE) -ine [IO.Path]::GetFullPath($oldExe) -or
    [IO.Path]::GetFullPath($env:QA_NEW_EXE) -ine [IO.Path]::GetFullPath($newExe)) {
  throw 'Expected the exact retained Agentrans installers'
}
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
subjectAltName=DNS:github.com
'@)
& $openssl genrsa -out $rootKey 2048
$caArgs = @('req', '-x509', '-new', '-key', $rootKey, '-sha256', '-days', '2', '-subj', "/CN=Agentrans Windows QA $env:GITHUB_RUN_ID", '-out', $rootCa,
  '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign,cRLSign')
& $openssl @caArgs
& $openssl x509 -in $rootCa -outform DER -out $rootDer
& $openssl genrsa -out $serverKey 2048
& $openssl req -new -key $serverKey -subj '/CN=github.com' -out $serverCsr
& $openssl x509 -req -in $serverCsr -CA $rootCa -CAkey $rootKey -CAcreateserial -out $serverCert -days 2 -sha256 -extfile $serverExtensions
& $openssl verify -CAfile $rootCa -verify_hostname github.com $serverCert

$configuration = [ordered]@{
  oldExe = $oldExe
  newExe = $newExe
  oldBlockMap = "$oldExe.blockmap"
  newBlockMap = "$newExe.blockmap"
  newYaml = Join-Path $inputs 'new/test.yml'
  newSignature = "$newExe.sig"
  httpsKey = $serverKey
  httpsCert = $serverCert
  rootCa = $rootCa
}
$manifest = Join-Path $inputs 'manifest.json'
$configuration | ConvertTo-Json | Set-Content -LiteralPath $manifest -Encoding utf8NoBOM
$hostsPath = Join-Path $env:SystemRoot 'System32/drivers/etc/hosts'
$originalHosts = [IO.File]::ReadAllBytes($hostsPath)
if ([Text.Encoding]::ASCII.GetString($originalHosts) -match '(?im)^[^#\r\n]+\bgithub\.com(?=\s|$)') {
  throw 'The clean runner already has a GitHub hosts override'
}
$trusted = $null
$hostsChanged = $false
try {
  $trusted = Import-Certificate -FilePath $rootDer -CertStoreLocation 'Cert:\CurrentUser\Root'
  $route = [Text.Encoding]::ASCII.GetBytes([Environment]::NewLine + '127.0.0.1 github.com # Agentrans Windows update fixture' + [Environment]::NewLine)
  $hostsChanged = $true
  [IO.File]::WriteAllBytes($hostsPath, [byte[]]($originalHosts + $route))
  ipconfig.exe /flushdns | Out-Null
  node --input-type=module -e "import {lookup} from 'node:dns/promises'; const result = await lookup('github.com'); if (result.address !== '127.0.0.1') throw Error('Loopback GitHub route is not active')"
  node scripts/verify-upgrade.mjs $manifest (Join-Path $runnerTemp 'agentrans-upgrade-qa')
} finally {
  try {
    if ($hostsChanged) {
      [IO.File]::WriteAllBytes($hostsPath, $originalHosts)
      ipconfig.exe /flushdns | Out-Null
    }
  } finally {
    if ($trusted) { Remove-Item -LiteralPath "Cert:\CurrentUser\Root\$($trusted.Thumbprint)" -ErrorAction Stop }
  }
}
