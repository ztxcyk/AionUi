const assert = require('node:assert/strict');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { it } = require('node:test');
const { fromMatrix, validateBuild, validateDistribution } = require('./release-windows-assets');

const version = '1.2.3';
const matrix = (arches) =>
  JSON.stringify({
    include: arches.map((arch) => ({ platform: `windows-${arch}`, arch, 'artifact-name': `windows-build-${arch}` })),
  });
function files(arches, layout) {
  const entries = new Map();
  for (const arch of arches) {
    const installer = `AionUi-${version}-win-${arch}.exe`;
    const dir = layout === 'build' ? path.join('root', `windows-build-${arch}`) : 'root';
    const metadata = layout === 'build' ? 'latest.yml' : arch === 'x64' ? 'latest.yml' : 'latest-win-arm64.yml';
    entries.set(path.join(dir, installer), 'mock installer');
    const sha512 = createHash('sha512').update('mock installer').digest('base64');
    entries.set(
      path.join(dir, metadata),
      `version: ${version}\nfiles:\n  - url: ${installer}\n    sha512: ${sha512}\n    size: 14\npath: ${installer}\nsha512: ${sha512}\n`
    );
  }
  return {
    entries,
    existsSync: (file) => entries.has(file),
    statSync: (file) => ({ isFile: () => true, size: entries.get(file).length }),
    readFileSync: (file) => {
      if (!entries.has(file)) throw new Error(`missing ${file}`);
      return entries.get(file);
    },
    readdirSync: () =>
      layout === 'build'
        ? arches.map((arch) => `windows-build-${arch}`)
        : [...entries.keys()].map((file) => path.basename(file)),
  };
}
it('binds the manifest to each selected matrix and requires every selected installer and metadata', () => {
  for (const arches of [['x64'], ['arm64'], ['x64', 'arm64']]) {
    const manifest = fromMatrix(matrix(arches), version);
    const build = files(arches, 'build');
    assert.doesNotThrow(() => validateBuild(manifest, 'root', build));
    const dist = files(arches, 'dist');
    assert.doesNotThrow(() => validateDistribution(manifest, 'root', version, dist));
    for (const file of build.entries.keys()) {
      const broken = files(arches, 'build');
      broken.entries.delete(file);
      assert.throws(() => validateBuild(manifest, 'root', broken), /missing/i);
    }
    for (const file of dist.entries.keys()) {
      const broken = files(arches, 'dist');
      broken.entries.delete(file);
      assert.throws(() => validateDistribution(manifest, 'root', version, broken), /missing/i);
    }
  }
});
it('rejects invalid matrices, unexpected old windows artifacts and malformed or wrong-version manifests', () => {
  for (const raw of ['{}', matrix([]), matrix(['x64', 'x64']), matrix(['ia32'])]) {
    assert.throws(() => fromMatrix(raw, version));
  }
  assert.throws(
    () => validateBuild(fromMatrix(matrix(['x64']), version), 'root', files(['x64', 'arm64'], 'build')),
    /unexpected/i
  );
  const dist = files(['x64'], 'dist');
  assert.throws(() => validateDistribution({ schemaVersion: 1, version, windows: [] }, 'root', version, dist));
  assert.throws(() => validateDistribution(fromMatrix(matrix(['x64']), version), 'root', '9.9.9', dist), /version/i);
  dist.entries.set(path.join('root', 'latest.yml'), 'version: 9.9.9\npath: wrong.exe\n');
  assert.throws(() => validateDistribution(fromMatrix(matrix(['x64']), version), 'root', version, dist));
  const empty = files(['x64'], 'build');
  empty.entries.set(path.join('root', 'windows-build-x64', `AionUi-${version}-win-x64.exe`), '');
  assert.throws(() => validateBuild(fromMatrix(matrix(['x64']), version), 'root', empty), /empty/i);
  const stale = files(['x64', 'arm64'], 'dist');
  assert.throws(() => validateDistribution(fromMatrix(matrix(['x64']), version), 'root', version, stale), /unexpected/i);
  const modified = files(['x64'], 'dist');
  modified.entries.set(path.join('root', `AionUi-${version}-win-x64.exe`), 'replaced installer');
  assert.throws(() => validateDistribution(fromMatrix(matrix(['x64']), version), 'root', version, modified), /SHA512/i);
});
it('fails closed without a manifest, including for otherwise complete legacy releases', () => {
  for (const releaseVersion of ['1.0.0', '9.0.0']) {
    for (const arches of [['x64', 'arm64'], ['x64'], []]) {
      assert.throws(
        () => validateDistribution(null, 'root', releaseVersion, files(arches, 'dist')),
        /manifest.*required/i
      );
    }
  }
});

it('rejects unselected Windows metadata in either single-architecture release', () => {
  for (const [selected, stale] of [['x64', 'latest-win-arm64.yml'], ['arm64', 'latest.yml']]) {
    const dist = files([selected], 'dist');
    dist.entries.set(path.join('root', stale), `version: ${version}\n`);
    assert.throws(() => validateDistribution(fromMatrix(matrix([selected]), version), 'root', version, dist), /unexpected/i);
  }
});

it('rejects extra installers, including unselected MSI and noncanonical names', () => {
  const manifest = fromMatrix(matrix(['x64']), version);
  for (const name of ['AionUi-1.2.3-win-arm64.msi', 'unselected-arm64-setup.exe']) {
    const dist = files(['x64'], 'dist');
    dist.entries.set(path.join('root', name), 'stale');
    assert.throws(() => validateDistribution(manifest, 'root', version, dist), /unexpected/i);
  }
});
