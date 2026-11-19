const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REPOSITORY = 'ztxcyk/OfficeCLI';
const RELEASE_API_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const RELEASE_DOWNLOAD_URL = `https://github.com/${REPOSITORY}/releases/download`;
const CHECKSUM_ASSET = 'SHA256SUMS';
const WINDOWS_ASSETS = {
  x64: 'officecli-win-x64.exe',
  arm64: 'officecli-win-arm64.exe',
};
const SHA256_PATTERN = /^[a-f\d]{64}$/i;

function assertSuccessfulResponse(response, context) {
  if (!response || !response.ok) {
    const status = response?.status ?? 'unknown';
    throw new Error(`${context} failed with HTTP ${status}`);
  }
}

async function request(fetchImpl, url, options, context) {
  let response;
  try {
    response = await fetchImpl(url, options);
  } catch (error) {
    throw new Error(`${context} failed: ${error.message}`, { cause: error });
  }
  assertSuccessfulResponse(response, context);
  return response;
}

function normalizeReleaseBase(releaseInfo) {
  if (!releaseInfo || typeof releaseInfo !== 'object' || Array.isArray(releaseInfo)) {
    throw new Error('OfficeCLI release information is malformed');
  }
  if (releaseInfo.repository !== REPOSITORY) {
    throw new Error(`OfficeCLI release information repository must be ${REPOSITORY}`);
  }
  if (
    typeof releaseInfo.tag !== 'string' ||
    releaseInfo.tag.length === 0 ||
    releaseInfo.tag.length > 255 ||
    releaseInfo.tag === '.' ||
    releaseInfo.tag === '..' ||
    // eslint-disable-next-line no-control-regex -- 拒绝 Release tag 中的控制字符
    /[\u0000-\u001f\u007f]/u.test(releaseInfo.tag)
  ) {
    throw new Error('OfficeCLI release information tag is invalid');
  }
  if (releaseInfo.checksumAsset !== CHECKSUM_ASSET) {
    throw new Error('OfficeCLI release information must include the SHA256SUMS asset');
  }
  if (!Array.isArray(releaseInfo.assets)) {
    throw new Error('OfficeCLI release information assets are malformed');
  }

  const allowedAssets = Object.values(WINDOWS_ASSETS);
  const assets = releaseInfo.assets;
  if (assets.some((asset) => !allowedAssets.includes(asset))) {
    throw new Error('OfficeCLI release information contains an unsupported asset');
  }
  if (new Set(assets).size !== assets.length) {
    throw new Error('OfficeCLI release information contains duplicate assets');
  }

  const orderedAssets = allowedAssets.filter((asset) => assets.includes(asset));
  if (orderedAssets.length === 0) {
    throw new Error('OfficeCLI release information contains no supported Windows assets');
  }

  return {
    repository: REPOSITORY,
    tag: releaseInfo.tag,
    assets: orderedAssets,
    checksumAsset: CHECKSUM_ASSET,
  };
}

function normalizeReleaseInfo(releaseInfo) {
  const release = normalizeReleaseBase(releaseInfo);
  const checksums = releaseInfo.checksums;
  if (!checksums || typeof checksums !== 'object' || Array.isArray(checksums)) {
    throw new Error('OfficeCLI release information checksums are malformed');
  }
  if (
    Object.keys(checksums).length !== release.assets.length ||
    Object.keys(checksums).some((name) => !release.assets.includes(name))
  ) {
    throw new Error('OfficeCLI release information checksums do not match assets');
  }
  const normalized = {};
  for (const asset of release.assets) {
    if (typeof checksums[asset] !== 'string' || !SHA256_PATTERN.test(checksums[asset])) {
      throw new Error(`OfficeCLI release information checksum is malformed for ${asset}`);
    }
    normalized[asset] = checksums[asset].toLowerCase();
  }
  return { ...release, checksums: normalized };
}

async function resolveOfficeCliRelease({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('OfficeCLI release resolution requires a fetch implementation');
  }

  const response = await request(
    fetchImpl,
    RELEASE_API_URL,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'AionUi-OfficeCLI-preparer',
      },
    },
    'OfficeCLI latest release API request'
  );

  let release;
  try {
    release = await response.json();
  } catch (error) {
    throw new Error(`OfficeCLI latest release API returned invalid JSON: ${error.message}`, { cause: error });
  }

  if (!release || typeof release !== 'object' || Array.isArray(release)) {
    throw new Error('OfficeCLI latest release API returned malformed release JSON');
  }
  if (release.draft === true || release.prerelease === true) {
    throw new Error('OfficeCLI latest release API returned an unpublished release');
  }
  if (!Array.isArray(release.assets)) {
    throw new Error('OfficeCLI latest release API returned malformed assets JSON');
  }

  const names = release.assets.map((asset) => {
    if (!asset || typeof asset.name !== 'string') {
      throw new Error('OfficeCLI latest release API returned a malformed asset entry');
    }
    return asset.name;
  });
  if (new Set(names).size !== names.length) {
    throw new Error('OfficeCLI latest release API returned duplicate asset names');
  }
  if (!names.includes(CHECKSUM_ASSET)) {
    throw new Error(`OfficeCLI latest release SHA256SUMS asset is missing from ${release.tag_name}`);
  }

  const assets = Object.values(WINDOWS_ASSETS).filter((assetName) => names.includes(assetName));
  if (assets.length === 0) {
    throw new Error(`OfficeCLI latest release ${release.tag_name} has no supported Windows assets`);
  }

  const base = normalizeReleaseBase({
    repository: REPOSITORY,
    tag: release.tag_name,
    assets,
    checksumAsset: CHECKSUM_ASSET,
  });
  const checksumResponse = await request(
    fetchImpl,
    getReleaseAssetUrl(base, CHECKSUM_ASSET),
    undefined,
    'OfficeCLI SHA256SUMS download'
  );
  let checksumText;
  try {
    checksumText = await checksumResponse.text();
  } catch (error) {
    throw new Error(`OfficeCLI SHA256SUMS response could not be read: ${error.message}`, { cause: error });
  }
  const checksums = Object.fromEntries(base.assets.map((asset) => [asset, findAssetChecksum(checksumText, asset)]));
  return normalizeReleaseInfo({ ...base, checksums });
}

function getReleaseAssetUrl(releaseInfo, assetName) {
  return `${RELEASE_DOWNLOAD_URL}/${encodeURIComponent(releaseInfo.tag)}/${encodeURIComponent(assetName)}`;
}

function findAssetChecksum(checksumText, assetName) {
  if (typeof checksumText !== 'string') {
    throw new Error('OfficeCLI SHA256SUMS contents are malformed');
  }

  const rows = checksumText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\S+)\s+\*?(.+?)\s*$/);
      return match ? { checksum: match[1], name: match[2] } : null;
    })
    .filter((row) => row?.name === assetName);

  if (rows.length !== 1) {
    throw new Error(`OfficeCLI SHA256SUMS must contain exactly one entry for ${assetName}`);
  }
  if (!SHA256_PATTERN.test(rows[0].checksum)) {
    throw new Error(`OfficeCLI SHA256 checksum is malformed for ${assetName}`);
  }
  return rows[0].checksum.toLowerCase();
}

async function prepareOfficeCli({ projectRoot, arch, fetchImpl = globalThis.fetch, releaseInfo } = {}) {
  if (arch !== 'x64' && arch !== 'arm64') {
    throw new Error(`Unsupported OfficeCLI architecture: ${arch}`);
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('OfficeCLI preparation requires a fetch implementation');
  }

  const resolvedRelease = normalizeReleaseInfo(
    releaseInfo === undefined ? await resolveOfficeCliRelease({ fetchImpl }) : releaseInfo
  );
  const assetName = WINDOWS_ASSETS[arch];
  if (!resolvedRelease.assets.includes(assetName)) {
    throw new Error(`OfficeCLI release ${resolvedRelease.tag} does not contain a Windows ${arch} asset`);
  }

  const releaseChecksum = resolvedRelease.checksums[assetName];

  const assetUrl = getReleaseAssetUrl(resolvedRelease, assetName);
  const assetResponse = await request(fetchImpl, assetUrl, undefined, 'OfficeCLI asset download');
  let assetBytes;
  try {
    assetBytes = Buffer.from(await assetResponse.arrayBuffer());
  } catch (error) {
    throw new Error(`OfficeCLI asset response could not be read: ${error.message}`, { cause: error });
  }

  const stagingDirectory = path.join(projectRoot, 'resources', 'bundled-officecli');
  const stagedPath = path.join(stagingDirectory, 'officecli.exe');
  const temporaryPath = path.join(stagingDirectory, `.officecli-${randomUUID()}.tmp`);

  fs.mkdirSync(stagingDirectory, { recursive: true });
  try {
    fs.writeFileSync(temporaryPath, assetBytes, { flag: 'wx' });
    const actualChecksum = createHash('sha256').update(fs.readFileSync(temporaryPath)).digest('hex');
    if (actualChecksum !== releaseChecksum) {
      throw new Error(`Downloaded OfficeCLI SHA256 does not match SHA256SUMS for ${assetName}`);
    }
    try {
      // 同目录硬链接以原子方式拒绝已存在的目标，避免 rename 覆盖并发创建的文件。
      fs.linkSync(temporaryPath, stagedPath);
    } catch (error) {
      if (error.code === 'EEXIST' || fs.existsSync(stagedPath)) {
        throw new Error(
          `OfficeCLI staging target already exists; refusing to overwrite it: ${stagedPath}. Verify and remove it manually before retrying.`,
          { cause: error }
        );
      }
      throw new Error(
        `Could not safely publish OfficeCLI without overwriting the staging target ${stagedPath}: ${error.message}`,
        { cause: error }
      );
    }
    fs.unlinkSync(temporaryPath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }

  return stagedPath;
}

module.exports = {
  prepareOfficeCli,
  resolveOfficeCliRelease,
  normalizeReleaseInfo,
  getReleaseAssetUrl,
  findAssetChecksum,
  request,
  WINDOWS_ASSETS,
};
