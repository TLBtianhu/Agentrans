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
$held = $null
$linked = $null
$retained = $null
$reportRoot = Join-Path $OutputDirectory 'Failure Reports'
New-Item -ItemType Directory -Force -Path $reportRoot | Out-Null
$originalTemp = $env:TEMP
$originalTmp = $env:TMP
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
    foreach ($mode in @($expected.cases) + @($expected.failureCases)) {
        $isFailure = $mode -in $expected.failureCases
        $isInteractive = $mode -in @('interactive', 'locked-cache-interactive')
        if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($installPath)) -ne $OutputDirectory) { throw 'Unexpected installation fixture cleanup path' }
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
        $reportCase = Join-Path $reportRoot $mode
        New-Item -ItemType Directory -Force -Path $reportCase | Out-Null
        $env:TEMP = $reportCase
        $env:TMP = $reportCase
        $shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) ($ProductName + '.lnk')
        if (-not (Test-Path -LiteralPath $shortcut)) { throw 'Test installation did not register its Start Menu shortcut' }
        $testShell = New-Object -ComObject WScript.Shell
        $currentShortcut = $testShell.CreateShortcut($shortcut)
        if (-not (Test-Path -LiteralPath $currentShortcut.TargetPath)) { throw 'Fresh shortcut does not point to the installed application' }
        $shortcutBytes = [IO.File]::ReadAllBytes($shortcut)
        if ($mode -eq 'stale-registration') { Set-ItemProperty -LiteralPath ('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $RegistryKey) -Name InstallLocation -Value $externalPath }
        if ($mode -eq 'foreign-shortcut') { $currentShortcut.TargetPath = Join-Path $externalPath 'foreign.exe'; $currentShortcut.Save() }
        if ($mode -eq 'foreign-working-directory') { $currentShortcut.WorkingDirectory = $externalPath; $currentShortcut.Save() }
        if ($mode -in @('locked-cache', 'locked-cache-interactive', 'locked-app')) {
            $lockedPath = if ($mode -eq 'locked-app') { Join-Path $installPath 'app\locked-test.txt' } else { Join-Path $cachePath 'cache.txt' }
            [IO.File]::WriteAllText($lockedPath, 'locked')
            $held = [IO.File]::Open($lockedPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        }
        if ($mode -in @('linked-cache-parent', 'linked-app')) {
            $linked = if ($mode -eq 'linked-app') { Join-Path $installPath 'app' } else { $dataPath }
            $retained = $linked + '-retained'
            Move-Item -LiteralPath $linked -Destination $retained
            New-Item -ItemType Junction -Path $linked -Target $externalPath | Out-Null
            New-Item -ItemType Directory -Path (Join-Path $externalPath 'cache') -Force | Out-Null
            [IO.File]::WriteAllText((Join-Path $externalPath 'cache\keep.txt'), 'external cache')
        }
        $arguments = '_?=' + $installPath
        if (-not $isInteractive) { $arguments = '/S ' + $arguments }
        if ($mode -eq 'upgrade') { $arguments = '/S /KEEP_APP_DATA --updated /currentuser ' + $arguments }
        if ($mode -eq 'replaced') { $arguments = '/S /KEEP_APP_DATA /currentuser ' + $arguments }
        if ($mode -eq 'home-inside') { $env:DSH_HOME = Join-Path $dataPath 'dsh\home' } else { Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue }
        $process = Start-Process -FilePath $uninstaller -ArgumentList $arguments -PassThru -WindowStyle ($(if ($isInteractive) { 'Normal' } else { 'Hidden' }))
        if ($isInteractive) {
            $welcome = Wait-Text $copy.welcome
            $window = [InstallerCapture]::TopLevel($welcome)
            [void][InstallerCapture]::SaveNative($window, (Join-Path $OutputDirectory 'uninstall-welcome.png'), $false)
            [void][InstallerCapture]::PostMessage($window, 0x0111, [IntPtr]1, [InstallerCapture]::GetDlgItem($window, 1))
            if ($isFailure) {
                $failureCopy = (Get-Content (Join-Path $PSScriptRoot "../installer/locales/$Language.json") -Encoding UTF8 -Raw | ConvertFrom-Json).strings
                # TaskDialog renders its heading with DirectUI. Its localized copy button identifies the dialog.
                $failure = Wait-Text $failureCopy.INSTALLER_EXTRACT_COPY
                $failureWindow = [InstallerCapture]::TopLevel($failure)
                try {
                    $expand = [InstallerCapture]::FindText($process.Id, $failureCopy.INSTALLER_EXTRACT_EXPAND)
                    if ($expand -ne [IntPtr]::Zero) { [InstallerCapture]::Click($expand) }
                    [void][InstallerCapture]::SaveNative($failureWindow, (Join-Path $OutputDirectory 'uninstall-failure.png'), $false)
                }
                finally { [void][InstallerCapture]::PostMessage($failureWindow, 0x0466, [IntPtr]1, [IntPtr]::Zero) }
            } else {
                $completed = [Diagnostics.Stopwatch]::StartNew()
                while ((Test-Path -LiteralPath (Join-Path $installPath 'app')) -or
                    (Test-Path -LiteralPath ('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $RegistryKey)) -or
                    -not [InstallerCapture]::IsWindowEnabled([InstallerCapture]::GetDlgItem($window, 1))) {
                    if ($completed.Elapsed.TotalSeconds -gt 10) { throw 'Uninstaller did not reach completed operations and enabled Finish' }
                    Start-Sleep -Milliseconds 20
                }
            }
            if (-not $isFailure) { [void][InstallerCapture]::PostMessage($window, 0x0111, [IntPtr]1, [InstallerCapture]::GetDlgItem($window, 1)) }
        }
        if ($isFailure) {
            if (-not $process.WaitForExit(30000)) { throw 'Failed uninstaller did not exit' }
            if ($process.ExitCode -ne 2) { throw "Expected failed uninstall exit 2, got $($process.ExitCode)" }
            $process.Dispose(); $process = $null
            if (-not (Test-Path -LiteralPath ('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $RegistryKey))) { throw 'Failed removal deleted uninstall registration' }
            if (-not (Test-Path -LiteralPath $shortcut)) { throw 'Failed removal deleted Start Menu retry shortcut' }
            if (-not (Test-Path -LiteralPath (Join-Path $installPath ('Uninstall ' + $ProductName + '.exe')))) { throw 'Failed removal deleted root uninstaller' }
            $reports = @(Get-ChildItem -LiteralPath (Join-Path $reportCase 'Agentrans-uninstall') -File)
            if ($reports.Count -ne 1) { throw 'Failed uninstall did not save one diagnostic report' }
            $report = [IO.File]::ReadAllText($reports[0].FullName)
            $failureCode = if ($mode -like 'locked-*') { 32 } else { 5 }
            if (-not $report.Contains("win32Error: $failureCode")) { throw "Report omitted original Win32 error $failureCode" }
            if (-not $report.Contains('effects: selected files may already have been removed')) { throw 'Report omitted partial removal warning' }
            if ([IO.File]::ReadAllText((Join-Path $externalPath 'keep.txt')) -ne 'outside data root') { throw 'Failure path changed external data' }
            if ($mode -eq 'stale-registration') {
                $currentEntry = Get-ItemProperty ('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $RegistryKey)
                if ($currentEntry.InstallLocation -ne $externalPath) { throw 'Stale uninstaller changed newer installation registration' }
                Set-ItemProperty -LiteralPath ('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $RegistryKey) -Name InstallLocation -Value $installPath
            }
            if ($mode -like 'foreign-*') {
                $foreignShortcut = $testShell.CreateShortcut($shortcut)
                if ($mode -eq 'foreign-shortcut' -and $foreignShortcut.TargetPath -ne (Join-Path $externalPath 'foreign.exe')) { throw 'Foreign shortcut was modified' }
                if ($mode -eq 'foreign-working-directory' -and $foreignShortcut.WorkingDirectory -ne $externalPath) { throw 'Foreign shortcut working directory was modified' }
                [IO.File]::WriteAllBytes($shortcut, $shortcutBytes)
            }
            if ($mode -in @('stale-registration', 'foreign-shortcut', 'foreign-working-directory') -and -not (Test-Path -LiteralPath (Join-Path $cachePath 'cache.txt'))) { throw 'Ownership refusal occurred after deleting cache' }
            if ($held) { $held.Dispose(); $held = $null }
            if ($linked) { [IO.Directory]::Delete($linked); Move-Item -LiteralPath $retained -Destination $linked; $linked = $null; $retained = $null }
            $process = Start-Process -FilePath $uninstaller -ArgumentList ('/S _?=' + $installPath) -PassThru -WindowStyle Hidden
            Wait-Exit
            if (Test-Path -LiteralPath ('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $RegistryKey)) { throw 'Successful recovery retained uninstall registration' }
            Write-Output "passed: $mode (failed safely, then recovery succeeded)"
            continue
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
    $env:TEMP = $originalTemp
    $env:TMP = $originalTmp
    if ($held) { $held.Dispose() }
    if ($linked) { [IO.Directory]::Delete($linked); Move-Item -LiteralPath $retained -Destination $linked }
    Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue
    if ($process) { if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }; $process.Dispose() }
    foreach ($pair in @(@($homePath, $OutputDirectory), @($externalPath, $OutputDirectory))) {
        $target = [IO.Path]::GetFullPath($pair[0])
        if ([IO.Path]::GetDirectoryName($target) -ne $pair[1]) { throw 'Unexpected fixture cleanup path' }
        if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    }
}
