const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { it } = require('node:test');
const { verifyPackedOfficeCli } = require('./verify-packed-officecli');

const release = {
  repository: 'ztxcyk/OfficeCLI',
  tag: 'v1.2.3',
  checksumAsset: 'SHA256SUMS',
  assets: ['officecli-win-x64.exe', 'officecli-win-arm64.exe'],
  checksums: {
    'officecli-win-x64.exe': createHash('sha256').update(pe(0x8664)).digest('hex'),
    'officecli-win-arm64.exe': createHash('sha256').update(pe(0xaa64)).digest('hex'),
  },
};
function pe(machine) {
  const bytes = Buffer.alloc(128);
  bytes.write('MZ');
  bytes.writeUInt32LE(64, 60);
  bytes.write('PE\0\0', 64);
  bytes.writeUInt16LE(machine, 68);
  return bytes;
}
function options(bytes = pe(0x8664)) {
  const urls = [];
  return {
    urls,
    args: {
      resourcesDir: 'mock-resources',
      arch: 'x64',
      releaseJson: JSON.stringify(release),
      readFile: () => bytes,
      fetchImpl: async (url) => {
        urls.push(url);
        throw new Error('unexpected network request');
      },
    },
  };
}
it('verifies the packed binary against the exact release checksum and PE architecture', async () => {
  for (const [arch, machine] of [
    ['x64', 0x8664],
    ['arm64', 0xaa64],
  ]) {
    const bytes = pe(machine);
    const { args, urls } = options(bytes);
    args.arch = arch;
    await verifyPackedOfficeCli(args);
    assert.deepEqual(urls, []);
  }
});
it('rejects invalid release JSON, missing files, bad PE and changed bytes', async () => {
  const { args } = options();
  await assert.rejects(verifyPackedOfficeCli({ ...args, releaseJson: 'not json' }), /JSON/i);
  await assert.rejects(verifyPackedOfficeCli({ ...args, releaseJson: '{"tag":"v1"}' }), /release/i);
  await assert.rejects(verifyPackedOfficeCli({ ...args, releaseJson: JSON.stringify({ ...release, tag: '..' }) }), /tag/i);
  await assert.rejects(
    verifyPackedOfficeCli({
      ...args,
      readFile: () => {
        throw new Error('missing');
      },
    }),
    /missing/i
  );
  await assert.rejects(verifyPackedOfficeCli({ ...args, readFile: () => pe(0xaa64) }), /architecture/i);
  await assert.rejects(verifyPackedOfficeCli({ ...args, readFile: () => Buffer.from('not PE') }), /PE/i);
  const changed = pe(0x8664);
  changed[100] = 1;
  await assert.rejects(verifyPackedOfficeCli({ ...args, readFile: () => changed }), /SHA256/i);
  await assert.rejects(verifyPackedOfficeCli({
    ...args,
    releaseJson: JSON.stringify({ ...release, checksums: { ...release.checksums, 'officecli-win-x64.exe': 'bad' } }),
  }), /checksum/i);
});
