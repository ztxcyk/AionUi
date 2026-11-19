const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const manifestName = 'aionui-release-manifest.json';
const arches = ['x64', 'arm64'];

function assertVersion(version) {
  if (typeof version !== 'string' || !/^[0-9][0-9A-Za-z.+-]*$/.test(version)) {
    throw new Error('Invalid release version');
  }
}

function makeManifest(selected, version) {
  assertVersion(version);
  if (
    !selected.length ||
    new Set(selected).size !== selected.length ||
    selected.some((arch) => !arches.includes(arch))
  ) {
    throw new Error('Invalid selected Windows architectures');
  }
  return {
    schemaVersion: 1,
    version,
    windows: arches
      .filter((arch) => selected.includes(arch))
      .map((arch) => ({
        arch,
        installer: `AionUi-${version}-win-${arch}.exe`,
        metadata: arch === 'x64' ? 'latest.yml' : 'latest-win-arm64.yml',
      })),
  };
}

function fromMatrix(raw, version) {
  const matrix = JSON.parse(raw);
  if (!Array.isArray(matrix?.include)) throw new Error('Invalid build matrix');
  const selected = matrix.include.filter(
    (item) => typeof item?.platform === 'string' && item.platform.startsWith('windows-')
  );
  for (const item of selected) {
    if (item.platform !== `windows-${item.arch}` || item['artifact-name'] !== `windows-build-${item.arch}`) {
      throw new Error('Invalid Windows build matrix entry');
    }
  }
  return makeManifest(
    selected.map((item) => item.arch),
    version
  );
}

function checkManifest(manifest, version) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.version !== version || !Array.isArray(manifest.windows)) {
    throw new Error('Invalid release manifest or version');
  }
  const expected = makeManifest(
    manifest.windows.map((entry) => entry?.arch),
    version
  );
  if (JSON.stringify(manifest) !== JSON.stringify(expected)) throw new Error('Invalid release manifest entries');
  return expected;
}

function readRequired(io, file) {
  if (!io.existsSync(file)) throw new Error(`Missing selected Windows release asset: ${file}`);
  return io.readFileSync(file, 'utf8');
}

function requireFile(io, file) {
  if (!io.existsSync(file) || !io.statSync(file).isFile() || io.statSync(file).size === 0) {
    throw new Error(`Missing or empty selected Windows release asset: ${file}`);
  }
}

function installerHash(io, file) {
  const hash = createHash('sha512');
  if (io !== fs) return hash.update(io.readFileSync(file)).digest('base64');
  const handle = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let size;
    while ((size = fs.readSync(handle, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, size));
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest('base64');
}

function checkMetadata(io, file, version, installer, installerPath) {
  const content = readRequired(io, file);
  const value = (name) => {
    const match = content.match(new RegExp(`^${name}:\\s*['"]?([^\\s'"]+)`, 'm'));
    return match?.[1];
  };
  if (value('version') !== version) throw new Error(`Invalid metadata version: ${file}`);
  if (installer && value('path') !== installer) throw new Error(`Invalid metadata installer path: ${file}`);
  if (installer) {
    const hash = installerHash(io, installerPath);
    const entries = [
      ...content.matchAll(
        /^[ \t]*-[ \t]+url:[ \t]*['"]?([^\s'"]+)['"]?[ \t]*\r?\n((?:(?![ \t]*-[ \t]+url:)[ \t]+[^\r\n]*\r?\n?)*)/gm
      ),
    ].filter((entry) => entry[1] === installer);
    const fields = entries[0]?.[2] || '';
    const fileHash = fields.match(/^[ \t]+sha512:[ \t]*['"]?([^\s'"]+)/m)?.[1];
    const fileSize = fields.match(/^[ \t]+size:[ \t]*(\d+)[ \t]*$/m)?.[1];
    if (
      value('sha512') !== hash ||
      entries.length !== 1 ||
      fileHash !== hash ||
      Number(fileSize) !== io.statSync(installerPath).size
    ) {
      throw new Error(`Invalid metadata installer SHA512 or size: ${file}`);
    }
  }
}

function validateBuild(manifest, root, io = fs) {
  const checked = checkManifest(manifest, manifest.version);
  const selected = new Set(checked.windows.map((entry) => `windows-build-${entry.arch}`));
  for (const dir of io.readdirSync(root)) {
    if (dir.startsWith('windows-build-') && !selected.has(dir)) throw new Error(`Unexpected Windows artifact: ${dir}`);
  }
  for (const entry of checked.windows) {
    const dir = path.join(root, `windows-build-${entry.arch}`);
    const installerPath = path.join(dir, entry.installer);
    requireFile(io, installerPath);
    checkMetadata(io, path.join(dir, 'latest.yml'), checked.version, entry.installer, installerPath);
  }
}

function validateDistribution(manifest, root, version, io = fs) {
  assertVersion(version);
  if (manifest === null) {
    throw new Error('Release manifest is required; legacy releases cannot be distributed automatically');
  }
  const checked = checkManifest(manifest, version);
  const expectedInstallers = new Set(checked.windows.map((entry) => entry.installer));
  const expectedMetadata = new Set(checked.windows.map((entry) => entry.metadata));
  for (const name of io.readdirSync(root)) {
    if (/\.(?:exe|msi)$/i.test(name) && !expectedInstallers.has(name)) {
      throw new Error(`Unexpected Windows installer: ${name}`);
    }
    if (['latest.yml', 'latest-win-arm64.yml'].includes(name) && !expectedMetadata.has(name)) {
      throw new Error(`Unexpected Windows metadata: ${name}`);
    }
  }
  for (const entry of checked.windows) {
    const installerPath = path.join(root, entry.installer);
    requireFile(io, installerPath);
    checkMetadata(io, path.join(root, entry.metadata), version, entry.installer, installerPath);
  }
  return checked.windows.map((entry) => entry.arch);
}

if (require.main === module) {
  try {
    const [command, root, version] = process.argv.slice(2);
    if (command === 'check-build') {
      validateBuild(fromMatrix(process.env.AIONUI_BUILD_MATRIX, version), root);
    } else if (command === 'write-manifest') {
      const manifest = fromMatrix(process.env.AIONUI_BUILD_MATRIX, version);
      validateDistribution(manifest, root, version);
      fs.writeFileSync(path.join(root, manifestName), `${JSON.stringify(manifest, null, 2)}\n`);
    } else if (command === 'check-distribution') {
      const file = path.join(root, manifestName);
      const manifest = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
      console.log(validateDistribution(manifest, root, version).join(','));
    } else {
      throw new Error('Unknown release asset validation command');
    }
  } catch (error) {
    console.error(`Release asset validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { fromMatrix, validateBuild, validateDistribution };
