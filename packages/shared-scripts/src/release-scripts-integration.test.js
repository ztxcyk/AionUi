const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { it } = require('node:test');

const root = path.resolve(__dirname, '../../..');
const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
const matrix = (arches) => JSON.stringify({
  include: arches.map((arch) => ({ platform: `windows-${arch}`, arch, 'artifact-name': `windows-build-${arch}` })),
});

it('prepares and validates complete dual and single-architecture mock releases without stale artifacts', () => {
  const id = randomUUID();
  const input = `.release-input-${id}`;
  const output = `.release-output-${id}`;
  const inputPath = path.join(root, input);
  const outputPath = path.join(root, output);
  const run = (script, args, extraEnv = {}) => spawnSync(bash, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, MOCK_VERSION: '1.0.0', ...extraEnv },
  });

  try {
    for (const arches of [['x64', 'arm64'], ['x64'], ['arm64']]) {
      let result = run('scripts/create-mock-release-artifacts.sh', [input]);
      assert.equal(result.status, 0, result.stderr);
      for (const arch of ['x64', 'arm64'].filter((arch) => !arches.includes(arch))) {
        fs.rmSync(path.join(inputPath, `windows-build-${arch}`), { recursive: true });
      }
      result = run('scripts/prepare-release-assets.sh', [input, output], { AIONUI_BUILD_MATRIX: matrix(arches) });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      const manifest = JSON.parse(fs.readFileSync(path.join(outputPath, 'aionui-release-manifest.json'), 'utf8'));
      assert.deepEqual(manifest.windows.map((entry) => entry.arch), arches);
      if (arches.length === 2) {
        const verification = run('scripts/verify-release-assets.sh', [output]);
        assert.equal(verification.status, 0, verification.stderr + verification.stdout);
      }
      const check = spawnSync(process.execPath, [
        'packages/shared-scripts/src/release-windows-assets.js', 'check-distribution', output, '1.0.0',
      ], { cwd: root, encoding: 'utf8' });
      assert.equal(check.status, 0, check.stderr);
      for (const entry of manifest.windows) {
        for (const file of [entry.installer, entry.metadata]) {
          const target = path.join(outputPath, file);
          const contents = fs.readFileSync(target);
          fs.unlinkSync(target);
          const missing = spawnSync(process.execPath, [
            'packages/shared-scripts/src/release-windows-assets.js', 'check-distribution', output, '1.0.0',
          ], { cwd: root, encoding: 'utf8' });
          assert.notEqual(missing.status, 0);
          assert.match(missing.stderr, /missing/i);
          fs.writeFileSync(target, contents);
        }
      }
      for (const arch of arches) {
        for (const file of [`AionUi-1.0.0-win-${arch}.exe`, 'latest.yml']) {
          const target = path.join(inputPath, `windows-build-${arch}`, file);
          const contents = fs.readFileSync(target);
          fs.unlinkSync(target);
          const missing = run('scripts/prepare-release-assets.sh', [input, output], { AIONUI_BUILD_MATRIX: matrix(arches) });
          assert.notEqual(missing.status, 0);
          assert.match(missing.stderr, /missing/i);
          fs.writeFileSync(target, contents);
        }
      }
    }
    const stale = run('scripts/create-mock-release-artifacts.sh', [input]);
    assert.equal(stale.status, 0);
    const result = run('scripts/prepare-release-assets.sh', [input, output], { AIONUI_BUILD_MATRIX: matrix(['x64']) });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unexpected/i);
    const missingMatrix = run('scripts/prepare-release-assets.sh', [input, output], { AIONUI_BUILD_MATRIX: '' });
    assert.notEqual(missingMatrix.status, 0);
  } finally {
    fs.rmSync(inputPath, { recursive: true, force: true });
    fs.rmSync(outputPath, { recursive: true, force: true });
  }
});

it('keeps the complete build success gate and publishes the selected manifest for distribution', () => {
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'build-and-release.yml'), 'utf8');
  const distribute = fs.readFileSync(path.join(root, '.github', 'workflows', 'release-distribute.yml'), 'utf8');
  assert.match(workflow, /needs\.build-pipeline\.result == 'success' && needs\.pack-web-cli\.result == 'success'/);
  assert.match(workflow, /AIONUI_BUILD_MATRIX: \$\{\{ needs\.prepare-matrix\.outputs\.matrix \}\}/);
  assert.match(workflow, /test -f release-assets\/aionui-release-manifest\.json/);
  assert.match(workflow, /release-assets\/aionui-release-manifest\.json/);
  assert.match(distribute, /--pattern "aionui-release-manifest\.json"/);
  assert.match(distribute, /release-windows-assets\.js check-distribution/);
  const upload = distribute.match(/- name: Upload updater metadata([\s\S]*?)- name: Summary/)?.[1];
  assert.ok(upload);
  assert.match(upload, /steps\.metadata\.outputs\.files/);
  assert.match(upload, /while IFS= read -r file/);
  assert.doesNotMatch(upload, /--include|--recursive|latest\*\.yml/);
});

it('uploads exactly the validated metadata list using a mocked AWS command', () => {
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'release-distribute.yml'), 'utf8');
  const body = workflow.match(
    /- name: Upload updater metadata[\s\S]*?\n        run: \|\n([\s\S]*?)(?=\n      - name: Summary)/
  )?.[1];
  assert.ok(body);
  const script = `aws() { printf '%s\\n' "$3"; }\n${body.replace(/^ {10}/gm, '')}`;
  const common = ['latest-mac.yml', 'latest-arm64-mac.yml', 'latest-linux.yml', 'latest-linux-arm64.yml'];
  for (const windows of [['latest.yml'], ['latest-win-arm64.yml'], ['latest.yml', 'latest-win-arm64.yml']]) {
    const files = [...common, ...windows];
    const result = spawnSync(bash, ['-c', script], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, FILES: files.join('\n'), S3_BUCKET: 'mock', S3_RELEASE_PREFIX: 'releases' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split(/\r?\n/), [...files.map((file) => `dist/${file}`), 'Uploaded updater metadata']);
  }
});
