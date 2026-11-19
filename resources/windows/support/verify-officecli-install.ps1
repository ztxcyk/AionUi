param(
  [Parameter(Mandatory = $true)]
  [string]$InstallDir,

  [Parameter(Mandatory = $true)]
  [string]$LogPath
)

$ErrorActionPreference = 'Stop'
$relativePath = 'resources\officecli\officecli.exe'

function Write-VerifyLog {
  param([string]$Message)
  $payload = [ordered]@{
    schemaVersion = 1
    ts = (Get-Date -Format o)
    session = ''
    version = ''
    arch = ''
    updated = $false
    instDir = $InstallDir
    event = 'verify-officecli'
    path = $relativePath
    message = $Message
  }
  Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value ($payload | ConvertTo-Json -Compress -Depth 4)
}

function Invoke-OfficeCliProbe {
  param([string]$Executable, [string]$Arguments)

  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $Executable
  $startInfo.Arguments = $Arguments
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  # 只修改本次探测子进程的环境，避免 OfficeCLI 后台检查更新或污染父进程。
  $startInfo.EnvironmentVariables['OFFICECLI_SKIP_UPDATE'] = '1'
  $process = New-Object System.Diagnostics.Process -Property @{ StartInfo = $startInfo }
  $processStarted = $false
  try {
    Write-VerifyLog "probe=start command=$Arguments"
    $timeoutMs = 30000
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    $processStarted = $process.Start()
    if (-not $processStarted) {
      throw "probe_start_failed command=$Arguments"
    }
    # 进程退出和两个管道共用一个截止时间，后代继承管道时也不能无限等待 EOF。
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $remainingMs = [Math]::Max(0, $timeoutMs - [int]$clock.ElapsedMilliseconds)
    if (-not $process.WaitForExit($remainingMs)) {
      throw "probe_timeout command=$Arguments phase=exit timeoutMs=$timeoutMs"
    }
    $remainingMs = [Math]::Max(0, $timeoutMs - [int]$clock.ElapsedMilliseconds)
    $readTasks = [System.Threading.Tasks.Task[]]@($stdout, $stderr)
    if (-not [System.Threading.Tasks.Task]::WaitAll($readTasks, $remainingMs)) {
      throw "probe_timeout command=$Arguments phase=output timeoutMs=$timeoutMs exitCode=$($process.ExitCode)"
    }
    # 仅在两路读取均完成后获取结果，不能在截止时间之外再次等待管道。
    $output = $stdout.GetAwaiter().GetResult()
    $errorOutput = $stderr.GetAwaiter().GetResult()
    $exitCode = $process.ExitCode
    Write-VerifyLog "probe=done command=$Arguments exitCode=$exitCode stdout=$output stderr=$errorOutput"
    if ($exitCode -ne 0) {
      throw "probe_failed command=$Arguments exitCode=$exitCode"
    }
  } finally {
    try {
      if ($processStarted -and -not $process.HasExited) {
        $process.Kill()
      }
    } catch {
      [Console]::Error.WriteLine("OfficeCLI probe cleanup failed: $($_.Exception.Message)")
    } finally {
      # 不再无期限等待退出，也不枚举或按名称终止其他进程。
      $process.Dispose()
    }
  }
}

try {
  $officeCli = [System.IO.Path]::GetFullPath((Join-Path $InstallDir $relativePath))
  Write-VerifyLog 'result=start'
  $item = Get-Item -LiteralPath $officeCli -ErrorAction SilentlyContinue
  if (-not $item -or $item.PSIsContainer) {
    throw 'missing_file'
  }
  if ($item.Length -le 0) {
    throw 'empty_file'
  }
  Invoke-OfficeCliProbe $officeCli '--version'
  Invoke-OfficeCliProbe $officeCli 'watch --help'
  Write-VerifyLog 'result=ok'
  exit 0
} catch {
  $reason = $_.Exception.Message
  try {
    Write-VerifyLog "result=fail reason=$reason"
  } catch {
    [Console]::Error.WriteLine("OfficeCLI verifier could not write installer log: $($_.Exception.Message)")
  }
  [Console]::Error.WriteLine("OfficeCLI verification failed: $relativePath; $reason")
  exit 1
}
