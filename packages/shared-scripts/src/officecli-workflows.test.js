const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { it } = require('node:test');

const root = path.resolve(__dirname, '../../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';

it('passes the resolved release from both callers to the reusable Windows job', () => {
  for (const file of ['build-manual.yml', 'build-and-release.yml']) {
    const workflow = read(`.github/workflows/${file}`);
    assert.match(workflow, /node scripts\/prepareOfficeCliMatrix\.js/);
    assert.match(workflow, /officecli_release_info: \$\{\{ needs\.prepare-matrix\.outputs\.release_info \}\}/);
  }
  const reusable = read('.github/workflows/_build-reusable.yml');
  assert.match(reusable, /AIONUI_OFFICECLI_RELEASE_INFO: \$\{\{ inputs\.officecli_release_info \}\}/);
  assert.match(reusable, /AIONUI_OFFICECLI_ARCH: \$\{\{ matrix\.arch \}\}/);
  assert.match(reusable, /AIONUI_OFFICECLI_PREPARED_ARCH: \$\{\{ matrix\.arch \}\}/);
  const prepare = reusable.indexOf('name: Prepare OfficeCLI');
  const build = reusable.indexOf('name: Build with electron-builder (Windows)');
  assert.ok(prepare > 0 && prepare < build);
  assert.match(reusable.slice(prepare, build), /if \(\$LASTEXITCODE -ne 0\)/);
});

it('pins manual Windows matrix resolution and builds to the same checked-out commit', () => {
  const workflow = read('.github/workflows/build-manual.yml');
  assert.match(workflow, /ref: \$\{\{ inputs\.branch \}\}[\s\S]*path: target-ref/);
  assert.match(workflow, /inputs\.platform == 'all' \|\| startsWith\(inputs\.platform, 'windows-'\)/);
  assert.match(workflow, /ref: \$\{\{ needs\.prepare-matrix\.outputs\.build_ref \}\}/);

  const script = workflow.match(/id: pin-ref\n\s+run: \|\n((?: {10}.+\n)+)/)?.[1];
  assert.ok(script, 'missing Windows ref pinning script');
  const gitStub = 'git() { if [ "$1" = "-C" ]; then echo "$TARGET_SHA"; else echo "$WORKFLOW_SHA"; fi; }\n';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'officecli-ref-test-'));
  try {
    const output = path.join(dir, 'output');
    const run = (target) =>
      spawnSync(bash, ['-c', gitStub + script], {
        encoding: 'utf8',
        env: { ...process.env, GITHUB_OUTPUT: output, WORKFLOW_SHA: 'abc123', TARGET_SHA: target },
      });

    const sameCommit = run('abc123');
    assert.equal(sameCommit.status, 0, sameCommit.stderr);
    assert.match(fs.readFileSync(output, 'utf8'), /build_ref=abc123/);
    fs.unlinkSync(output);
    const differentCommit = run('def456');
    assert.equal(differentCommit.status, 1, differentCommit.stderr);
    assert.equal(fs.existsSync(output), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('makes the Windows PR build resolve and prepare before packaging, checking native exit codes', () => {
  const workflow = read('.github/workflows/pr-checks.yml');
  const prepare = workflow.indexOf('name: Prepare OfficeCLI (Windows');
  const build = workflow.indexOf('name: Build test (Windows x64)');
  assert.ok(prepare > 0 && prepare < build);
  assert.match(workflow.slice(prepare, build), /--resolve-release/);
  assert.match(workflow.slice(prepare, build), /AIONUI_OFFICECLI_RELEASE_INFO/);
  assert.ok((workflow.slice(prepare, build).match(/\$LASTEXITCODE -ne 0/g) || []).length >= 2);
  assert.match(workflow, /AIONUI_OFFICECLI_RELEASE_INFO: \$\{\{ steps\.prepare-officecli\.outputs\.release_info \}\}/);
  assert.match(
    workflow,
    /node --test packages\/shared-scripts\/src\/prepare-officecli\.test\.js packages\/shared-scripts\/src\/officecli-matrix\.test\.js packages\/shared-scripts\/src\/officecli-workflows\.test\.js packages\/shared-scripts\/src\/officecli-build-gate\.test\.js/
  );
});

it('gates normal local Windows packaging before any build work', () => {
  const script = read('scripts/build-with-builder.js');
  assert.ok(
    script.indexOf('prepareWindowsOfficeCli({ arch: targetArch, multiArch })') <
      script.indexOf('applyDebugAutoUpdateVersionOverride(packageJsonPath);')
  );
  assert.match(script, /if \(!packOnly && windowsBuild\)/);
});

it('adds OfficeCLI only as a Windows extra resource and ignores generated staging', () => {
  const config = read('packages/desktop/electron-builder.yml');
  const windows = config.slice(config.indexOf('\nwin:'), config.indexOf('\nnsis:'));
  assert.match(
    windows,
    /extraResources:\s*\n\s*- from: resources\/bundled-officecli\/officecli\.exe\s*\n\s*to: officecli\/officecli\.exe/
  );
  assert.match(read('.gitignore'), /^\/resources\/bundled-officecli\/$/m);
});
