const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { getReleaseDownloadUrl } = require('./prepare-aioncore');
const { normalizeReleaseInfo, WINDOWS_ASSETS } = require('./prepare-officecli');

// 发布并验证私有模式后，仅将已确认的精确 Release tag 加入此列表。
const PRIVATE_MODE_APPROVED_RELEASES = [];

function assertPrivateModeRelease({ version, env = process.env, arch, manifest, approved = PRIVATE_MODE_APPROVED_RELEASES }) {
  const override = env.AIONUI_BACKEND_VERSION?.trim();
  const alternateSource = [
    'AIONUI_BACKEND_RUN_ID',
    'AIONUI_BACKEND_LOCAL_BUNDLE_DIR',
    'AIONUI_BACKEND_LOCAL_BINARY',
  ].some((key) => env[key]?.trim());
  if (
    typeof version !== 'string' ||
    !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version) ||
    version === 'v0.2.2-ztxcyk.1' ||
    !approved.includes(version) ||
    (override && override !== version) ||
    alternateSource
  ) {
    throw new Error(
      'Windows AionCore private-mode release is not confirmed or the bundle source does not match the confirmed pin. ' +
        'Publish and verify a compatible release, then update aioncoreVersion and PRIVATE_MODE_APPROVED_RELEASES together.'
    );
  }
  if (manifest !== undefined) {
    const url = getReleaseDownloadUrl('win32', arch, version);
    if (!url || manifest?.version !== version || manifest?.sourceType !== 'download' || manifest?.source?.url !== url) {
      throw new Error(`Windows AionCore private-mode bundle must come from the confirmed release asset: ${url}`);
    }
  }
}

function prepareWindowsOfficeCli({ arch, multiArch = false, env = process.env, run, resolveRelease } = {}) {
  if (multiArch) throw new Error('Windows OfficeCLI packaging requires one architecture per build');
  if (!['x64', 'arm64'].includes(arch)) throw new Error(`Unsupported Windows OfficeCLI architecture: ${arch}`);
  if (env.AIONUI_OFFICECLI_PREPARED_ARCH) {
    if (env.AIONUI_OFFICECLI_PREPARED_ARCH !== arch) throw new Error('Prepared OfficeCLI architecture does not match');
    if (!env.AIONUI_OFFICECLI_RELEASE_INFO) throw new Error('Prepared OfficeCLI release information is missing');
  }
  if (!env.AIONUI_OFFICECLI_RELEASE_INFO) {
    const resolve =
      resolveRelease ||
      (() => {
        const result = spawnSync(
          process.execPath,
          [path.resolve(__dirname, '../../../scripts/prepareOfficeCli.js'), '--resolve-release'],
          { encoding: 'utf8', env }
        );
        if (result.error) throw result.error;
        if (result.status !== 0) {
          throw new Error(`OfficeCLI release resolution failed: ${result.stderr || result.status}`);
        }
        return result.stdout.trim();
      });
    env.AIONUI_OFFICECLI_RELEASE_INFO = resolve();
  }
  let release;
  try {
    release = JSON.parse(env.AIONUI_OFFICECLI_RELEASE_INFO);
  } catch (error) {
    throw new Error(`OfficeCLI release information contains invalid JSON: ${error.message}`, { cause: error });
  }
  release = normalizeReleaseInfo(release);
  if (!release.assets.includes(WINDOWS_ASSETS[arch])) throw new Error(`OfficeCLI release has no Windows ${arch} asset`);
  env.AIONUI_OFFICECLI_RELEASE_INFO = JSON.stringify(release);
  if (env.AIONUI_OFFICECLI_PREPARED_ARCH) return;
  const prepare =
    run ||
    ((targetArch, prepareEnv) => {
      const result = spawnSync(process.execPath, [path.resolve(__dirname, '../../../scripts/prepareOfficeCli.js')], {
        stdio: 'inherit',
        env: { ...prepareEnv, AIONUI_OFFICECLI_ARCH: targetArch },
      });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`OfficeCLI preparation failed with exit code ${result.status}`);
    });
  prepare(arch, env);
}

module.exports = { assertPrivateModeRelease, prepareWindowsOfficeCli };
