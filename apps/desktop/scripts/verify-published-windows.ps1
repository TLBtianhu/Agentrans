# Verify the existing installer; never sign or access the hardware token.
param(
    [Parameter(Mandatory = $true)][string]$Installer,
    [Parameter(Mandatory = $true)][string]$Thumbprint,
    [ValidateNotNullOrEmpty()][string]$ExpectedProductName,
    [ValidateNotNullOrEmpty()][string]$ExpectedProductVersion
)
$ErrorActionPreference = 'Stop'
$signature = Get-AuthenticodeSignature -LiteralPath $Installer
if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) {
    throw 'Installer does not have a valid Authenticode signature.'
}
if ($signature.SignerCertificate.Thumbprint -ne $Thumbprint) {
    throw 'Installer signer does not match the configured release certificate.'
}
if ($null -eq $signature.TimeStamperCertificate) {
    throw 'Installer has no verified signing timestamp.'
}
if ($PSBoundParameters.ContainsKey('ExpectedProductName') -or $PSBoundParameters.ContainsKey('ExpectedProductVersion')) {
    $versionInfo = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($Installer)
    if ($PSBoundParameters.ContainsKey('ExpectedProductName') -and $versionInfo.ProductName -cne $ExpectedProductName) {
        throw "Installer product name '$($versionInfo.ProductName)' does not match '$ExpectedProductName'."
    }
    if ($PSBoundParameters.ContainsKey('ExpectedProductVersion') -and $versionInfo.ProductVersion -cne $ExpectedProductVersion) {
        throw "Installer product version '$($versionInfo.ProductVersion)' does not match '$ExpectedProductVersion'."
    }
}
