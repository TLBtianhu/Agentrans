<# Production uninstaller checks with isolated application identity and seeded data. #>
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Installer, [Parameter(Mandatory)][string]$ProductName,
    [Parameter(Mandatory)][string]$RegistryKey, [Parameter(Mandatory)][string]$OutputDirectory,
    [Parameter(Mandatory)][string]$Language, [Parameter(Mandatory)][string]$PackageName)
$ErrorActionPreference = 'Stop'
$copy = (Get-Content (Join-Path $PSScriptRoot "../installer/locales/$Language.json") -Encoding UTF8 -Raw | ConvertFrom-Json).uninstaller
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
. (Join-Path $PSScriptRoot 'windows-installer-ui.ps1')
[InstallerCapture]::Initialize()
$expected = Get-Content (Join-Path $PSScriptRoot 'expected/windows-uninstall.json') -Raw | ConvertFrom-Json
$roaming = [Environment]::GetFolderPath('ApplicationData')
$installPath = Join-Path $OutputDirectory 'Uninstall App'
$dataPath = Join-Path $installPath 'data'
$sessionsPath = Join-Path $dataPath 'sessions'
$settingsPath = Join-Path $dataPath 'settings'
$modelsPath = Join-Path $installPath 'models'
$runtimesPath = Join-Path $installPath 'runtime-envs'
$exportsPath = Join-Path $dataPath 'exports'
$cachePath = Join-Path $dataPath 'cache'
$homePath = Join-Path $OutputDirectory 'Harness Home'
$externalPath = Join-Path $OutputDirectory 'External Project'
$uninstaller = Join-Path $OutputDirectory 'uninstall-copy.exe'
$process = $null
function Wait-Text([string]$Text) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        $control = [InstallerCapture]::FindText($process.Id, $Text)
        if ($control -ne [IntPtr]::Zero) { return $control }
        if ($process.HasExited) { throw "Uninstaller exited: $($process.ExitCode)" }
        Start-Sleep -Milliseconds 25
    } while ($timer.Elapsed.TotalSeconds -lt 20)
    throw "Missing '$Text': $([InstallerCapture]::VisibleText($process.Id))"
}
function Wait-Exit {
    if (-not $process.WaitForExit(30000)) { $process.Kill(); $process.WaitForExit(); throw 'Uninstaller timed out' }
    if ($process.ExitCode -ne 0) { throw "Uninstall failed: $($process.ExitCode)" }
    $process.Dispose()
    $script:process = $null
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while (Test-Path -LiteralPath (Join-Path $installPath 'app')) {
        if ($timer.Elapsed.TotalSeconds -gt 20) { throw 'Application directory remained' }
        Start-Sleep -Milliseconds 100
    }
}
try {
    foreach ($mode in $expected.cases) {
        if (Test-Path -LiteralPath $installPath) { Remove-Item -LiteralPath $installPath -Recurse -Force }
        $setup = Start-Process -FilePath $Installer -ArgumentList ('/S /D=' + $installPath) -PassThru -WindowStyle Hidden
        try {
            if (-not $setup.WaitForExit(30000)) { $setup.Kill(); $setup.WaitForExit(); throw 'Setup timed out' }
            if ($setup.ExitCode -ne 0) { throw "Setup failed: $($setup.ExitCode)" }
        } finally { $setup.Dispose() }
        $entry = Get-ItemProperty ('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $RegistryKey)
        if ($entry.InstallLocation.TrimEnd('\') -ne $installPath) { throw 'Uninstall entry lacks InstallLocation' }
        foreach ($path in @($homePath, $sessionsPath, $settingsPath, $modelsPath, $runtimesPath, $exportsPath, $cachePath, $externalPath)) {
            New-Item -ItemType Directory -Force -Path $path | Out-Null
        }
        [IO.File]::WriteAllText((Join-Path $externalPath 'keep.txt'), 'outside data root')
        if (-not (Test-Path -LiteralPath (Join-Path $dataPath 'linked-project'))) {
            New-Item -ItemType Junction -Path (Join-Path $dataPath 'linked-project') -Target $externalPath | Out-Null
        }
        [IO.File]::WriteAllText((Join-Path $homePath 'session.txt'), 'keep session')
        [IO.File]::WriteAllText((Join-Path $sessionsPath 'session.txt'), 'session data')
        [IO.File]::WriteAllText((Join-Path $settingsPath 'settings.json'), '{}')
        [IO.File]::WriteAllText((Join-Path $modelsPath 'model.bin'), 'model')
        [IO.File]::WriteAllText((Join-Path $runtimesPath 'runtime.bin'), 'runtime')
        [IO.File]::WriteAllText((Join-Path $exportsPath 'result.txt'), 'export')
        [IO.File]::WriteAllText((Join-Path $cachePath 'cache.txt'), 'cache')
        Copy-Item -LiteralPath (Join-Path $installPath ('Uninstall ' + $ProductName + '.exe')) -Destination $uninstaller -Force
        $arguments = '_?=' + $installPath
        if ($mode -in @('silent', 'home-inside')) { $arguments = '/S ' + $arguments }
        if ($mode -eq 'upgrade') { $arguments = '/S /KEEP_APP_DATA --updated /currentuser ' + $arguments }
        if ($mode -eq 'replaced') { $arguments = '/S /KEEP_APP_DATA /currentuser ' + $arguments }
        if ($mode -eq 'home-inside') { $env:DSH_HOME = Join-Path $dataPath 'dsh\home' } else { Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue }
        $process = Start-Process -FilePath $uninstaller -ArgumentList $arguments -PassThru -WindowStyle ($(if ($mode -eq 'interactive') { 'Normal' } else { 'Hidden' }))
        if ($mode -eq 'interactive') {
            $welcome = Wait-Text $copy.welcome
            $window = [InstallerCapture]::TopLevel($welcome)
            [void][InstallerCapture]::SaveNative($window, (Join-Path $OutputDirectory 'uninstall-welcome.png'), $false)
            [InstallerCapture]::Click([InstallerCapture]::GetDlgItem($window, 1))
            [void](Wait-Text $copy.finished)
            [InstallerCapture]::Click([InstallerCapture]::GetDlgItem($window, 1))
        }
        Wait-Exit
        $preserveData = $true
        $preserveCache = $mode -in @('upgrade', 'replaced')
        if ([IO.File]::ReadAllText((Join-Path $externalPath 'keep.txt')) -ne 'outside data root') { throw 'Cleanup followed a junction into a project' }
        if (-not (Test-Path (Join-Path $homePath 'session.txt'))) { throw "Harness home retention failed: $mode" }
        if ((Test-Path (Join-Path $sessionsPath 'session.txt')) -ne $preserveData) { throw "Session retention failed: $mode" }
        if ((Test-Path (Join-Path $settingsPath 'settings.json')) -ne $preserveData) { throw "Settings retention failed: $mode" }
        if ((Test-Path (Join-Path $modelsPath 'model.bin')) -ne $preserveData) { throw "Model retention failed: $mode" }
        if ((Test-Path (Join-Path $runtimesPath 'runtime.bin')) -ne $preserveData) { throw "Runtime retention failed: $mode" }
        if ((Test-Path (Join-Path $exportsPath 'result.txt')) -ne $preserveData) { throw "Export retention failed: $mode" }
        if ((Test-Path $cachePath) -ne $preserveCache) { throw "Cache retention failed: $mode" }
        Write-Output "passed: $mode"
    }
} finally {
    Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue
    if ($process) { if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }; $process.Dispose() }
    foreach ($pair in @(@($homePath, $OutputDirectory), @($externalPath, $OutputDirectory))) {
        $target = [IO.Path]::GetFullPath($pair[0])
        if ([IO.Path]::GetDirectoryName($target) -ne $pair[1]) { throw 'Unexpected fixture cleanup path' }
        if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    }
}
