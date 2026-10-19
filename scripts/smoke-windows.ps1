# Install only on a disposable GitHub-hosted runner. Never run against a
# developer's installation or request interactive elevation.
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or
    $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'Windows installer verification runs only on GitHub-hosted Windows runners.'
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'The runner must already be elevated for the machine-wide MSI; no elevation will be requested.'
}
if (-not $env:RUNNER_TEMP -or -not (Test-Path -LiteralPath $env:RUNNER_TEMP -PathType Container)) {
    throw 'The runner temporary directory is unavailable.'
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$bundleDirectories = @(
    (Join-Path $repoRoot 'target/release/bundle/msi'),
    (Join-Path $repoRoot 'apps/desktop/src-tauri/target/release/bundle/msi')
)
$installers = @(
    foreach ($directory in $bundleDirectories) {
        if (Test-Path -LiteralPath $directory -PathType Container) {
            Get-ChildItem -LiteralPath $directory -Filter '*.msi' -File
        }
    }
)
if ($installers.Count -ne 1) {
    throw "Expected exactly one newly built MSI; found $($installers.Count)."
}
$installerPath = $installers[0].FullName
$releaseDirectory = [IO.Path]::GetFullPath((Join-Path $installers[0].DirectoryName '../..'))
$builtExecutable = Join-Path $releaseDirectory 'devledger-desktop.exe'
if (-not (Test-Path -LiteralPath $builtExecutable -PathType Leaf)) {
    throw "The packaged release executable is missing: $builtExecutable"
}

$smokeDirectory = Join-Path $env:RUNNER_TEMP ('devledger-windows-smoke-' + [guid]::NewGuid().ToString('N'))
$installDirectory = Join-Path $smokeDirectory 'installed'
$installLog = Join-Path $smokeDirectory 'install.log'
New-Item -ItemType Directory -Path $smokeDirectory | Out-Null

# Tauri's WiX MSI accepts INSTALLDIR. /qn avoids UI and /norestart prevents
# rebooting the runner. Its normal finish-dialog launch action cannot run.
$arguments = @(
    '/i', ('"{0}"' -f $installerPath),
    '/qn', '/norestart',
    ('INSTALLDIR="{0}"' -f $installDirectory),
    '/L*v', ('"{0}"' -f $installLog)
)
$installer = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32/msiexec.exe') `
    -ArgumentList $arguments -WindowStyle Hidden -PassThru
if (-not $installer.WaitForExit(180000)) {
    $installer.Kill()
    throw "MSI installation timed out. See $installLog"
}
if ($installer.ExitCode -notin @(0, 3010)) {
    throw "MSI installation failed with exit code $($installer.ExitCode). See $installLog"
}

$installedExecutable = Join-Path $installDirectory 'devledger-desktop.exe'
if (-not (Test-Path -LiteralPath $installedExecutable -PathType Leaf)) {
    throw "The MSI did not install the application into INSTALLDIR. See $installLog"
}
$builtHash = (Get-FileHash -LiteralPath $builtExecutable -Algorithm SHA256).Hash
$installedHash = (Get-FileHash -LiteralPath $installedExecutable -Algorithm SHA256).Hash
if ($builtHash -ne $installedHash) {
    throw 'The installed executable does not match the release executable packaged by this build.'
}
Write-Output 'MSI installation passed; installed executable matches this build.'

# Hosted runners can execute their agent without an interactive Windows
# desktop. In that case installation is verified, and GUI startup is reported
# separately instead of making the installer check depend on a desktop.
if (-not [Environment]::UserInteractive -or [Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) {
    Write-Output '::notice::GUI startup not checked: this runner has no interactive desktop. MSI installation and installed executable verification passed.'
    return
}

$appDataDirectory = Join-Path $smokeDirectory 'appdata'
$localDataDirectory = Join-Path $smokeDirectory 'localappdata'
New-Item -ItemType Directory -Path $appDataDirectory, $localDataDirectory | Out-Null
$startInfo = [Diagnostics.ProcessStartInfo]::new($installedExecutable)
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
$startInfo.WorkingDirectory = $smokeDirectory
$startInfo.Environment['APPDATA'] = $appDataDirectory
$startInfo.Environment['LOCALAPPDATA'] = $localDataDirectory
$startInfo.Environment['WEBVIEW2_USER_DATA_FOLDER'] = Join-Path $smokeDirectory 'webview2'

$application = $null
try {
    $application = [Diagnostics.Process]::Start($startInfo)
    if ($application.WaitForExit(10000)) {
        throw "The installed application exited during startup with code $($application.ExitCode)."
    }
    Write-Output 'Installed application survived its initial 10 seconds of startup.'
} finally {
    if ($null -ne $application) {
        if (-not $application.HasExited) {
            $null = $application.CloseMainWindow()
            if (-not $application.WaitForExit(5000)) {
                $application.Kill()
                $null = $application.WaitForExit(5000)
            }
        }
        $application.Dispose()
    }
}
