const { resolveOfficeCliRelease, normalizeReleaseInfo } = require('./prepare-officecli');

const targets = [
  {
    platform: 'macos-arm64',
    os: 'macos-14',
    command: 'node scripts/build-with-builder.js arm64 --mac --arm64',
    'artifact-name': 'macos-build-arm64',
    arch: 'arm64',
  },
  {
    platform: 'macos-x64',
    os: 'macos-14',
    command: 'node scripts/build-with-builder.js x64 --mac --x64',
    'artifact-name': 'macos-build-x64',
    arch: 'x64',
  },
  {
    platform: 'windows-x64',
    os: 'windows-2022',
    command: 'node scripts/build-with-builder.js x64 --win --x64',
    'artifact-name': 'windows-build-x64',
    arch: 'x64',
  },
  {
    platform: 'windows-arm64',
    os: 'windows-11-arm',
    command: 'node scripts/build-with-builder.js arm64 --win --arm64',
    'artifact-name': 'windows-build-arm64',
    arch: 'arm64',
  },
  {
    platform: 'linux-x64',
    os: 'ubuntu-latest',
    command: 'node scripts/build-with-builder.js x64 --linux --x64',
    'artifact-name': 'linux-build-x64',
    arch: 'x64',
  },
  {
    platform: 'linux-arm64',
    os: 'ubuntu-24.04-arm',
    command: 'node scripts/build-with-builder.js arm64 --linux --arm64',
    'artifact-name': 'linux-build-arm64',
    arch: 'arm64',
  },
];

async function createBuildMatrix(platform, resolveRelease = resolveOfficeCliRelease) {
  const requested = platform === 'all' ? targets : targets.filter((target) => target.platform === platform);
  if (!requested.length) throw new Error(`Unsupported platform: ${platform}`);

  const windows = requested.filter((target) => target.platform.startsWith('windows-'));
  if (!windows.length) return { matrix: { include: requested }, releaseInfo: '', skipped: [] };

  const info = normalizeReleaseInfo(await resolveRelease());
  const skipped = windows
    .filter((target) => !info.assets.includes(`officecli-win-${target.arch}.exe`))
    .map((target) => target.platform);
  const include = requested.filter((target) => !skipped.includes(target.platform));
  if (windows.length === skipped.length) {
    throw new Error(`OfficeCLI release ${info.tag} has no requested Windows architecture; skipped: ${skipped.join(', ')}`);
  }
  return { matrix: { include }, releaseInfo: JSON.stringify(info), skipped };
}

module.exports = { createBuildMatrix };
