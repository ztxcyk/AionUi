const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeReleaseInfo, WINDOWS_ASSETS } = require('./prepare-officecli');

async function verifyPackedOfficeCli({
  resourcesDir,
  arch,
  releaseJson,
  readFile = fs.readFileSync,
}) {
  let release;
  try {
    release = JSON.parse(releaseJson);
  } catch (error) {
    throw new Error(`OfficeCLI release information contains invalid JSON: ${error.message}`, { cause: error });
  }
  release = normalizeReleaseInfo(release);
  const asset = WINDOWS_ASSETS[arch];
  if (!asset || !release.assets.includes(asset)) throw new Error(`OfficeCLI release has no Windows ${arch} asset`);
  const bytes = readFile(path.join(resourcesDir, 'officecli', 'officecli.exe'));
  if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('Invalid OfficeCLI PE header');
  const offset = bytes.readUInt32LE(60);
  if (offset < 64 || offset > bytes.length - 24 || bytes.toString('hex', offset, offset + 4) !== '50450000') {
    throw new Error('Invalid OfficeCLI PE header');
  }
  const expectedMachine = arch === 'x64' ? 0x8664 : 0xaa64;
  if (bytes.readUInt16LE(offset + 4) !== expectedMachine) {
    throw new Error(`OfficeCLI PE architecture does not match ${arch}`);
  }
  const expected = release.checksums[asset];
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) throw new Error(`Packaged OfficeCLI SHA256 does not match SHA256SUMS for ${asset}`);
}

module.exports = { verifyPackedOfficeCli };
