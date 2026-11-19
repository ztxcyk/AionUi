const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { it } = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../../..');
const verifier = path.join(root, 'resources', 'windows', 'support', 'verify-officecli-install.ps1');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const windows = process.platform === 'win32';
const powershell =
  process.env.OFFICECLI_TEST_POWERSHELL ||
  path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// 仅替换进程启动边界：保留真实文件检查、进程环境、输出捕获和退出码处理，绝不执行 OfficeCLI。
const adapter = String.raw`
param([string]$Verifier, [string]$InstallDir, [string]$LogPath)
$ErrorActionPreference = 'Stop'
$before = [Environment]::GetEnvironmentVariable('OFFICECLI_SKIP_UPDATE', 'Process')
function New-Object {
  param([string]$TypeName, [hashtable]$Property)
  if ($TypeName -ne 'System.Diagnostics.Process') {
    throw "Unexpected object construction: $TypeName"
  }
  $info = $Property.StartInfo
  $expected = Join-Path $InstallDir 'resources\officecli\officecli.exe'
  if ($info.FileName -cne $expected) { throw "Unexpected executable: $($info.FileName)" }
  if ($info.Arguments -notin @('--version', 'watch --help')) { throw 'Unexpected probe arguments' }
  if ($info.UseShellExecute -or -not $info.CreateNoWindow -or
      -not $info.RedirectStandardOutput -or -not $info.RedirectStandardError) {
    throw 'Unsafe process flags'
  }
  if ($info.EnvironmentVariables['OFFICECLI_SKIP_UPDATE'] -ne '1') { throw 'Updates not suppressed' }
  Add-Content -LiteralPath (Join-Path $InstallDir 'commands.txt') -Value $info.Arguments
  $info.EnvironmentVariables['OFFICECLI_TEST_COMMAND'] = $info.Arguments
  $info.FileName = (Get-Process -Id $PID).Path
  $child = @'
[Console]::Out.WriteLine('skip=' + $env:OFFICECLI_SKIP_UPDATE)
[Console]::Out.WriteLine('command=' + $env:OFFICECLI_TEST_COMMAND)
[Console]::Error.WriteLine('mock stderr')
if ($env:OFFICECLI_TEST_SCENARIO.StartsWith('inherited-pipes')) {
  $descendantInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $descendantInfo.FileName = (Get-Process -Id $PID).Path
  $descendantInfo.UseShellExecute = $false
  $descendantInfo.CreateNoWindow = $true
  $descendantCode = '[Console]::Out.WriteLine("descendant owns stdout"); [Console]::Error.WriteLine("descendant owns stderr"); Start-Sleep -Seconds 90'
  $descendantInfo.Arguments = '-NoProfile -NonInteractive -EncodedCommand ' +
    [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($descendantCode))
  $descendant = [System.Diagnostics.Process]::Start($descendantInfo)
  @{
    id = $descendant.Id
    startTicks = $descendant.StartTime.ToUniversalTime().Ticks.ToString()
    parentId = $PID
    parentStartTicks = (Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks.ToString()
  } | ConvertTo-Json | Set-Content -LiteralPath $env:OFFICECLI_TEST_DESCENDANT -Encoding UTF8
  $descendant.Dispose()
  if ($env:OFFICECLI_TEST_SCENARIO -eq 'inherited-pipes-delayed') { Start-Sleep -Seconds 20 }
  exit 0
}
if ($env:OFFICECLI_TEST_SCENARIO -eq 'timeout') { Start-Sleep -Seconds 40 }
if ($env:OFFICECLI_TEST_SCENARIO -eq 'version-fails' -and $env:OFFICECLI_TEST_COMMAND -eq '--version') { exit 22 }
if ($env:OFFICECLI_TEST_SCENARIO -eq 'watch-fails' -and $env:OFFICECLI_TEST_COMMAND -eq 'watch --help') { exit 23 }
if ($env:OFFICECLI_TEST_SCENARIO -eq 'large-output') {
  [Console]::Out.WriteLine(('o' * 70000))
  [Console]::Error.WriteLine(('e' * 70000))
}
exit 0
'@
  $info.Arguments = '-NoProfile -NonInteractive -EncodedCommand ' +
    [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($child))
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $info
  return $process
}
& $Verifier -InstallDir $InstallDir -LogPath $LogPath
$code = $LASTEXITCODE
$after = [Environment]::GetEnvironmentVariable('OFFICECLI_SKIP_UPDATE', 'Process')
if ($before -cne $after) { throw 'Verifier modified its parent environment' }
exit $code
`;

// 仅清理本测试记录且创建时间匹配的进程，绝不按名称枚举或终止其他程序。
const cleanupDescendant = String.raw`
param([string]$RecordPath)
$ErrorActionPreference = 'Stop'
$record = Get-Content -LiteralPath $RecordPath -Raw -Encoding UTF8 | ConvertFrom-Json
$parentExited = $true
try {
  $parent = [System.Diagnostics.Process]::GetProcessById([int]$record.parentId)
  $parentExited = $parent.StartTime.ToUniversalTime().Ticks.ToString() -ne $record.parentStartTicks
  $parent.Dispose()
} catch [ArgumentException] {}
$process = [System.Diagnostics.Process]::GetProcessById([int]$record.id)
try {
  if ($process.StartTime.ToUniversalTime().Ticks.ToString() -ne $record.startTicks) {
    throw 'PID was reused; refusing to stop this process'
  }
  $process.Kill()
  if (-not $process.WaitForExit(5000)) { throw 'Test descendant cleanup timed out' }
  @{ parentExited = $parentExited; descendantStopped = $true } | ConvertTo-Json -Compress
} finally {
  $process.Dispose()
}
`;

function probe({ scenario = 'success', resource = 'mock', inherited = '0', logFailure = false } = {}) {
  assert.ok(fs.existsSync(verifier), 'OfficeCLI install verifier must exist');
  const fixture = fs.mkdtempSync(path.join(root, '.officecli-install-test-'));
  const descendantPath = path.join(fixture, 'descendant.json');
  const cleanupPath = path.join(fixture, 'cleanup-descendant.ps1');
  const cleanup = {};
  try {
    const installDir = path.join(fixture, "安装 [private] O'Brien");
    const officeCli = path.join(installDir, 'resources', 'officecli', 'officecli.exe');
    fs.mkdirSync(path.dirname(officeCli), { recursive: true });
    if (resource === 'directory') fs.mkdirSync(officeCli);
    else if (resource !== 'missing') fs.writeFileSync(officeCli, resource === 'empty' ? '' : 'not a real executable');
    const logPath = path.join(installDir, logFailure ? 'absent\\verify.jsonl' : 'verify.jsonl');
    const wrapper = path.join(fixture, 'probe-adapter.ps1');
    fs.writeFileSync(wrapper, `\uFEFF${adapter}`);
    fs.writeFileSync(cleanupPath, `\uFEFF${cleanupDescendant}`);
    const env = {
      ...process.env,
      OFFICECLI_TEST_SCENARIO: scenario,
      OFFICECLI_TEST_DESCENDANT: descendantPath,
    };
    if (inherited === null) delete env.OFFICECLI_SKIP_UPDATE;
    else env.OFFICECLI_SKIP_UPDATE = inherited;
    const stdoutPath = path.join(fixture, 'verifier.stdout');
    const stderrPath = path.join(fixture, 'verifier.stderr');
    const stdoutFd = fs.openSync(stdoutPath, 'w');
    const stderrFd = fs.openSync(stderrPath, 'w');
    const started = performance.now();
    let result;
    try {
      // 外层输出使用文件，避免后代意外继承测试运行器的管道，使断言测量真实校验进程退出。
      result = spawnSync(
        powershell,
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          resource === 'mock' ? wrapper : verifier,
          ...(resource === 'mock' ? ['-Verifier', verifier] : []),
          '-InstallDir',
          installDir,
          '-LogPath',
          logPath,
        ],
        { cwd: root, env, stdio: ['ignore', stdoutFd, stderrFd], timeout: 45000, windowsHide: true }
      );
    } finally {
      fs.closeSync(stdoutFd);
      fs.closeSync(stderrFd);
    }
    const elapsedMs = performance.now() - started;
    result.stdout = fs.readFileSync(stdoutPath, 'utf8');
    result.stderr = fs.readFileSync(stderrPath, 'utf8');
    assert.equal(result.error, undefined, result.stderr);
    const events = fs.existsSync(logPath)
      ? fs
          .readFileSync(logPath, 'utf8')
          .replace(/^\uFEFF/, '')
          .trim()
          .split(/\r?\n/)
          .map((line) => JSON.parse(line))
      : [];
    const trace = path.join(installDir, 'commands.txt');
    const commands = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').trim().split(/\r?\n/) : [];
    return { ...result, events, commands, elapsedMs, cleanup };
  } finally {
    try {
      if (fs.existsSync(descendantPath)) {
        const stopped = spawnSync(
          powershell,
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', cleanupPath, descendantPath],
          { cwd: root, encoding: 'utf8', timeout: 10000, windowsHide: true }
        );
        assert.ifError(stopped.error);
        assert.equal(stopped.status, 0, stopped.stderr);
        Object.assign(cleanup, JSON.parse(stopped.stdout));
      }
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  }
}

for (const resource of ['missing', 'empty', 'directory', 'invalid']) {
  it(`rejects ${resource} private executables and records the resource failure`, { skip: !windows }, () => {
    const result = probe({ resource });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.events.at(-1).message, /result=fail/);
    if (resource !== 'invalid') {
      assert.match(result.events.at(-1).message, resource === 'empty' ? /reason=empty_file/ : /reason=missing_file/);
    }
    assert.ok(result.events.every((event) => event.path === 'resources\\officecli\\officecli.exe'));
    assert.deepEqual(result.commands, []);
  });
}

for (const inherited of [null, '0', '1']) {
  it(`checks both capabilities with child-only update suppression (inherited ${inherited})`, { skip: !windows }, () => {
    const parentBefore = process.env.OFFICECLI_SKIP_UPDATE;
    const result = probe({ inherited });
    assert.equal(result.status, 0, result.stderr + JSON.stringify(result.events));
    assert.deepEqual(result.commands, ['--version', 'watch --help']);
    const logged = result.events.map((event) => event.message).join('\n');
    assert.match(logged, /skip=1/);
    assert.match(logged, /mock stderr/);
    assert.match(result.events.at(-1).message, /result=ok/);
    assert.equal(process.env.OFFICECLI_SKIP_UPDATE, parentBefore);
  });
}

for (const [scenario, code, commands] of [
  ['version-fails', 22, ['--version']],
  ['watch-fails', 23, ['--version', 'watch --help']],
]) {
  it(`fails closed when ${scenario}, preserving the native exit code in the log`, { skip: !windows }, () => {
    const result = probe({ scenario });
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(result.commands, commands);
    assert.match(
      result.events.map((event) => event.message).join('\n'),
      new RegExp(`exitCode=${code}`)
    );
    assert.match(result.events.at(-1).message, /result=fail/);
  });
}

it('drains both output streams without blocking on full pipes', { skip: !windows }, () => {
  const result = probe({ scenario: 'large-output' });
  assert.equal(result.status, 0, result.stderr);
  const logged = result.events.map((event) => event.message).join('\n');
  assert.ok(logged.includes('o'.repeat(70000)) && logged.includes('e'.repeat(70000)));
});

it('returns nonzero even when writing the installer log fails', { skip: !windows }, () => {
  const result = probe({ resource: 'missing', logFailure: true });
  assert.equal(result.status, 1);
  assert.notEqual(result.stderr.trim(), '');
});

it('terminates a hung probe and fails installation instead of waiting indefinitely', { skip: !windows }, () => {
  const result = probe({ scenario: 'timeout' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.events.at(-1).message, /result=fail reason=probe_timeout command=--version/);
  assert.deepEqual(result.commands, ['--version']);
});

for (const scenario of ['inherited-pipes', 'inherited-pipes-delayed']) {
  it(`bounds inherited stdout/stderr with a shared deadline (${scenario})`, { skip: !windows }, () => {
    const result = probe({ scenario });
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.elapsedMs < 40000, `Verifier exceeded its deadline: ${result.elapsedMs}ms`);
    assert.match(
      result.events.at(-1).message,
      /result=fail reason=probe_timeout command=--version phase=output timeoutMs=30000 exitCode=0/
    );
    assert.deepEqual(result.commands, ['--version']);
    assert.deepEqual(result.cleanup, { parentExited: true, descendantStopped: true });
  });
}

it('does not use shell invocation or process/user/system environment mutation', () => {
  const source = fs.readFileSync(verifier, 'utf8');
  assert.doesNotMatch(source, /\$env:|SetEnvironmentVariable|Set-Item\s+Env:|Invoke-Expression|Start-Process/i);
});

it('runs the OfficeCLI NSIS check after AionCore and before installation success', () => {
  const source = read('resources/windows/installer-update-verify.nsh');
  const macro = source.match(/!macro AIONUI_VERIFY_BUNDLED_OFFICECLI_RESOURCES\b([\s\S]*?)!macroend/);
  assert.ok(macro, 'NSIS must invoke the OfficeCLI verifier');
  assert.match(macro[1], /File .*verify-officecli-install\.ps1/);
  assert.match(
    macro[1],
    /nsExec::Exec .*powershell\.exe.*-File .*verify-officecli-install\.ps1.*-InstallDir "\$INSTDIR".*-LogPath "\$AionUiSessionLogPath"/
  );
  assert.match(macro[1], /Pop \$AionUiVerifyResourceResult/);
  assert.match(
    macro[1],
    /\$\{If\} \$AionUiVerifyResourceResult != 0[\s\S]*AIONUI_FAIL_UX[\s\S]*AIONUI_E_OFFICECLI_INCOMPLETE/
  );
  const custom = source.match(/!macro customInstall\b([\s\S]*?)!macroend/)[1];
  assert.match(
    custom,
    /AIONUI_VERIFY_BUNDLED_AIONCORE_RESOURCES[\s\S]*AIONUI_VERIFY_BUNDLED_OFFICECLI_RESOURCES[\s\S]*AIONUI_SESSION_SUCCESS/
  );
  assert.match(read('resources/windows/installer-errors-sentry.nsh'), /SetErrorLevel 2\s+Quit/);
  const messages = read('resources/windows/installer-messages.nsh');
  for (const suffix of ['ZH', 'EN', 'ACTION_ZH', 'ACTION_EN']) {
    assert.match(macro[1], new RegExp(`AIONUI_MSG_OFFICECLI_INCOMPLETE_${suffix}`));
    assert.match(messages, new RegExp(`!define AIONUI_MSG_OFFICECLI_INCOMPLETE_${suffix} "[^"]+"`));
  }
});

it('keeps failure-messagebox scenarios complete when the OfficeCLI error is added', () => {
  const result = spawnSync(process.execPath, ['scripts/smoke-installer-failure-messagebox.js', '--list-codes-json'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const { scenarios } = JSON.parse(result.stdout);
  assert.ok(scenarios.some((scenario) => scenario.code === 'E1032' && scenario.id === 'officecli-incomplete'));
});

it('makes Windows CI check installer exit and reuse the offline verifier without bypassing the release gate', () => {
  const workflow = read('.github/workflows/pr-checks.yml');
  const smoke = workflow.slice(
    workflow.indexOf('name: Silent install smoke test (Windows x64)'),
    workflow.indexOf('name: Install smoke test (macOS arm64)')
  );
  assert.match(smoke, /Start-Process .* -PassThru/);
  assert.match(smoke, /\.ExitCode -ne 0/);
  assert.match(smoke, /verify-officecli-install\.ps1/);
  assert.match(smoke, /-InstallDir .* -LogPath /);
  assert.match(smoke, /\$LASTEXITCODE/);
  assert.match(smoke, /throw "Bundled OfficeCLI/);
  const safeTests = workflow.indexOf('name: Test OfficeCLI install verifier (Windows)');
  const gate = workflow.indexOf('name: Check Windows AionCore private-mode release');
  assert.ok(safeTests > 0 && safeTests < gate, 'Safe tests must run even while the release gate is closed');
  assert.match(
    workflow.slice(safeTests, gate),
    /node --test packages\/shared-scripts\/src\/verify-officecli-install\.test\.js/
  );
  assert.match(workflow.slice(gate, gate + 400), /assertPrivateModeRelease/);
});

function windowsUnitEntry() {
  const workflow = read('.github/workflows/pr-checks.yml');
  const unit = workflow.match(/^  unit-tests:\n([\s\S]*?)(?=^  \S)/m)[1];
  const step = unit.match(
    /- name: Test OfficeCLI install verifier \(Windows unit tests\)\n([\s\S]*?)(?=\n      - name:)/
  );
  assert.ok(step, 'Windows unit tests must run the install verifier independently of build-test');
  const jobIf = unit.match(/^    if: (.+)$/m)[1];
  const stepIf = step[1].match(/if: (.+)/)[1];
  const command = step[1].match(/run: (node --test .+)/)[1];
  return { workflow, unit, jobIf, stepIf, command };
}

it('runs the Windows unit entry when builds are skipped for both PR and manual checks', () => {
  const { workflow, unit, jobIf, stepIf, command } = windowsUnitEntry();
  assert.match(unit, /os: \[.*windows-2022/);
  assert.equal(command, 'node --test packages/shared-scripts/src/verify-officecli-install.test.js');
  assert.doesNotMatch(jobIf + stepIf, /skip_build_test|needs\.|always\(\)/);
  const buildIf = workflow.match(/^  build-test:\n[\s\S]*?^    if: (.+)$/m)[1];
  for (const eventName of ['pull_request', 'workflow_dispatch']) {
    const context = {
      github: { event_name: eventName, event: { action: 'synchronize', pull_request: { draft: false } } },
      inputs: { skip_build_test: true },
      matrix: { os: 'windows-2022' },
    };
    assert.equal(vm.runInNewContext(jobIf, context), true);
    assert.equal(vm.runInNewContext(stepIf, context), true);
    assert.equal(vm.runInNewContext(buildIf, context), false);
  }
});

it('executes a real safe capability case through the Windows unit workflow command', { skip: !windows }, () => {
  const { command } = windowsUnitEntry();
  const [, ...args] = command.split(' ');
  const env = { ...process.env };
  // 独立验证工作流命令，不能继承当前 Node 测试子进程的内部通信模式。
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [args[0], '--test-name-pattern=inherited null', ...args.slice(1)], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /checks both capabilities.*inherited null/);
  assert.match(result.stdout, /# pass 1\b/);
});
