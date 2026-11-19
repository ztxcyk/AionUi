const assert = require('node:assert/strict');
const { it } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { prepareWindowsOfficeCli, assertPrivateModeRelease } = require('./officecli-build-gate');
const releaseInfo = JSON.stringify({
  repository: 'ztxcyk/OfficeCLI',
  tag: 'v1',
  assets: ['officecli-win-x64.exe', 'officecli-win-arm64.exe'],
  checksumAsset: 'SHA256SUMS',
  checksums: {
    'officecli-win-x64.exe': 'a'.repeat(64),
    'officecli-win-arm64.exe': 'b'.repeat(64),
  },
});

it('prepares the requested architecture for ordinary local Windows packaging', () => {
  const calls = [];
  prepareWindowsOfficeCli({
    arch: 'arm64',
    env: { AIONUI_OFFICECLI_RELEASE_INFO: releaseInfo },
    run: (arch) => calls.push(arch),
  });
  assert.deepEqual(calls, ['arm64']);
});

it('does not continue if preparation fails or multiple Windows architectures were requested', () => {
  assert.throws(
    () =>
      prepareWindowsOfficeCli({
        arch: 'x64',
        env: { AIONUI_OFFICECLI_RELEASE_INFO: releaseInfo },
        run: () => {
          throw new Error('preparation failed');
        },
      }),
    /preparation failed/
  );
  assert.throws(() => prepareWindowsOfficeCli({ arch: 'x64', multiArch: true, env: {} }), /one architecture/i);
});

it('accepts the workflow-prepared resource only with matching architecture and release metadata', () => {
  let called = false;
  const run = () => {
    called = true;
  };
  prepareWindowsOfficeCli({
    arch: 'x64',
    env: { AIONUI_OFFICECLI_PREPARED_ARCH: 'x64', AIONUI_OFFICECLI_RELEASE_INFO: releaseInfo },
    run,
  });

  assert.equal(called, false);
  assert.throws(
    () =>
      prepareWindowsOfficeCli({
        arch: 'arm64',
        env: { AIONUI_OFFICECLI_PREPARED_ARCH: 'x64', AIONUI_OFFICECLI_RELEASE_INFO: releaseInfo },
        run,
      }),
    /architecture/i
  );
  assert.throws(
    () =>
      prepareWindowsOfficeCli({
        arch: 'x64',
        env: { AIONUI_OFFICECLI_PREPARED_ARCH: 'x64' },
        run,
      }),
    /release/i
  );
  assert.throws(
    () => prepareWindowsOfficeCli({
      arch: 'x64',
      env: { AIONUI_OFFICECLI_PREPARED_ARCH: 'x64', AIONUI_OFFICECLI_RELEASE_INFO: 'not json' },
      run,
    }),
    /JSON/i
  );
});

it('resolves a local release once and passes the same JSON to preparation and afterPack', () => {
  const env = {};
  let resolutions = 0;
  let preparedInfo;
  prepareWindowsOfficeCli({
    arch: 'x64',
    env,
    resolveRelease: () => { resolutions++; return releaseInfo; },
    run: (_arch, actualEnv) => { preparedInfo = actualEnv.AIONUI_OFFICECLI_RELEASE_INFO; },
  });
  assert.equal(resolutions, 1);
  assert.equal(preparedInfo, releaseInfo);
  assert.equal(env.AIONUI_OFFICECLI_RELEASE_INFO, releaseInfo);
});

it('blocks unconfirmed Windows AionCore releases, including the current pin', () => {
  for (const version of ['v0.2.2-ztxcyk.1', 'v9.0.0', 'latest', '']) {
    assert.throws(() => assertPrivateModeRelease({ version, env: {} }), /private.mode/i);
  }
  for (const version of ['latest', '', 'v0.2.2-ztxcyk.1']) {
    assert.throws(() => assertPrivateModeRelease({ version, approved: [version], env: {} }), /private.mode/i);
  }
});

it('allows only the explicitly confirmed pinned release and its downloaded bundle', () => {
  const approved = ['v9.0.0'];
  const validUrl =
    'https://github.com/ztxcyk/AionCore/releases/download/v9.0.0/aioncore-v9.0.0-x86_64-pc-windows-msvc.zip';
  const armUrl = validUrl.replace('x86_64', 'aarch64');
  for (const [arch, url] of [
    ['x64', validUrl],
    ['arm64', armUrl],
  ]) {
    assert.doesNotThrow(() =>
      assertPrivateModeRelease({
        version: 'v9.0.0',
        arch,
        approved,
        env: { AIONUI_BACKEND_VERSION: 'v9.0.0' },
        manifest: {
          platform: 'win32',
          arch,
          version: 'v9.0.0',
          generatedAt: '2026-11-19T00:00:00Z',
          sourceType: 'download',
          source: { url },
          files: ['aioncore.exe', 'managed-resources/'],
        },
      })
    );
  }
  for (const env of [
    { AIONUI_BACKEND_VERSION: 'v9.0.1' },
    { AIONUI_BACKEND_RUN_ID: '123' },
    { AIONUI_BACKEND_LOCAL_BUNDLE_DIR: 'local' },
    { AIONUI_BACKEND_LOCAL_BINARY: 'local' },
  ]) {
    assert.throws(() => assertPrivateModeRelease({ version: 'v9.0.0', approved, env }), /private.mode/i);
  }
  for (const manifest of [
    null,
    {},
    { version: 'v9.0.1', sourceType: 'download' },
    { version: 'v9.0.0', sourceType: 'local-bundle' },
    ...[
      undefined,
      {},
      { url: validUrl.replace('ztxcyk', 'iOfficeAI') },
      { url: armUrl },
      { url: validUrl.replaceAll('v9.0.0', 'v9.0.1') },
    ].map((source) => ({
      version: 'v9.0.0',
      sourceType: 'download',
      source,
    })),
  ]) {
    assert.throws(
      () => assertPrivateModeRelease({ version: 'v9.0.0', arch: 'x64', approved, env: {}, manifest }),
      /private.mode/i
    );
  }
});

it('stops the normal Windows build wrapper before invoking any build or downloader', () => {
  const root = path.resolve(__dirname, '../../..');
  const filename = path.join(root, 'scripts', 'build-with-builder.js');
  const source = fs.readFileSync(filename, 'utf8').replace(/^#![^\n]*\n/, '');
  const fakeProcess = { argv: ['node', filename, 'x64', '--win', '--x64'], arch: 'x64', platform: 'win32', env: {} };
  const errors = [];
  let executions = 0;
  const fakeRequire = (name) => {
    if (name === 'child_process') return { execSync: () => executions++, spawnSync: () => executions++ };
    if (name === '../packages/shared-scripts/src/officecli-build-gate') return require('./officecli-build-gate');
    return require(name);
  };
  const run = vm.runInThisContext(`(function(require, __dirname, process, console) { ${source}\n})`);
  run(fakeRequire, path.dirname(filename), fakeProcess, { log() {}, error: (...args) => errors.push(args.join(' ')) });
  assert.equal(fakeProcess.exitCode, 1);
  assert.match(errors.join('\n'), /private.mode/i);
  assert.equal(executions, 0);
});

it('rejects direct Windows electron-builder packaging but leaves non-Windows packaging unaffected', async () => {
  const root = path.resolve(__dirname, '../../..');
  const filename = path.join(root, 'scripts', 'afterPack.js');
  const source = fs.readFileSync(filename, 'utf8');
  let checked = false;
  const fakeFs = {
    readFileSync: (file) =>
      file.endsWith('package.json')
        ? fs.readFileSync(path.join(root, 'package.json'), 'utf8')
        : JSON.stringify({ version: 'v0.2.2-ztxcyk.1', sourceType: 'download' }),
    existsSync: () => true,
    readdirSync: () => [],
  };
  const fakeRequire = (name) => {
    if (name === 'builder-util') return { Arch: {} };
    if (name === 'fs') return fakeFs;
    if (name === 'os') return { arch: () => 'x64' };
    if (name === './rebuildNativeModules') return { normalizeArch: (arch) => arch };
    if (name.includes('verify-bundled-aioncore-resources')) {
      return {
        verifyBundledAioncoreResources: () => {
          checked = true;
          return { missing: [], checked: [], runtimeKey: 'linux-x64' };
        },
      };
    }
    if (name.includes('officecli-build-gate')) return require('./officecli-build-gate');
    if (name.includes('verify-packed-officecli')) return { verifyPackedOfficeCli: async () => {} };
    return require(name);
  };
  const module = { exports: {} };
  const load = vm.runInThisContext(`(function(require, module, __dirname) { ${source}\n})`);
  load(fakeRequire, module, path.dirname(filename));
  await assert.rejects(module.exports({ arch: 'x64', electronPlatformName: 'win32', appOutDir: root }), /private.mode/i);
  assert.equal(checked, false);
  await module.exports({ arch: 'x64', electronPlatformName: 'linux', appOutDir: root });
  assert.equal(checked, true);
});

it('afterPack validates the final Windows resource with the build release information', async () => {
  const root = path.resolve(__dirname, '../../..');
  const filename = path.join(root, 'scripts', 'afterPack.js');
  const source = fs.readFileSync(filename, 'utf8');
  let actual;
  const fakeRequire = (name) => {
    if (name === 'builder-util') return { Arch: {} };
    if (name === 'fs') return { readFileSync: () => '{}' };
    if (name === 'os') return { arch: () => 'x64' };
    if (name === './rebuildNativeModules') return { normalizeArch: (arch) => arch };
    if (name.includes('verify-bundled-aioncore-resources')) return {};
    if (name.includes('officecli-build-gate')) return { assertPrivateModeRelease: () => {} };
    if (name.includes('verify-packed-officecli')) return {
      verifyPackedOfficeCli: async (options) => { actual = options; throw new Error('verification failed'); },
    };
    return require(name);
  };
  const module = { exports: {} };
  const load = vm.runInThisContext(`(function(require, module, __dirname, process) { ${source}\n})`);
  load(fakeRequire, module, path.dirname(filename), { env: { AIONUI_OFFICECLI_RELEASE_INFO: releaseInfo } });
  await assert.rejects(module.exports({ arch: 'x64', electronPlatformName: 'win32', appOutDir: root }), /verification failed/);
  assert.deepEqual(actual, { resourcesDir: path.join(root, 'resources'), arch: 'x64', releaseJson: releaseInfo });
});
