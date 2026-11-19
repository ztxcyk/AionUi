const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { it } = require('node:test');
const { resolveOfficeCliRelease, prepareOfficeCli } = require('./prepare-officecli');
const { createBuildMatrix } = require('./officecli-matrix');
const { verifyPackedOfficeCli } = require('./verify-packed-officecli');

const assets = ['officecli-win-x64.exe', 'officecli-win-arm64.exe'];
function pe(machine) {
  const buffer = Buffer.alloc(128);
  buffer.write('MZ');
  buffer.writeUInt32LE(64, 60);
  buffer.write('PE\0\0', 64);
  buffer.writeUInt16LE(machine, 68);
  return buffer;
}
const original = [pe(0x8664), pe(0xaa64)];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const payload = () => ({
  tag_name: 'v1',
  assets: ['SHA256SUMS', ...assets].map((name) => ({ name })),
});

it('pins one checksum snapshot for both architectures and never refetches it after packing', async () => {
  const calls = [];
  let upstreamChanged = false;
  let replacement = false;
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith('/releases/latest')) return { ok: true, json: async () => payload() };
    if (url.endsWith('/SHA256SUMS')) {
      return {
        ok: true,
        text: async () =>
          assets.map((name, i) => `${upstreamChanged ? '0'.repeat(64) : hash(original[i])}  ${name}`).join('\n'),
      };
    }
    const index = assets.findIndex((asset) => url.endsWith(`/${asset}`));
    if (index >= 0) {
      const bytes = Buffer.from(original[index]);
      if (replacement) bytes[100] = 1;
      return { ok: true, arrayBuffer: async () => Uint8Array.from(bytes).buffer };
    }
    throw new Error(`unexpected request ${url}`);
  };
  const matrix = await createBuildMatrix('all', () => resolveOfficeCliRelease({ fetchImpl }));
  assert.equal(calls.length, 2);
  const snapshot = JSON.parse(matrix.releaseInfo);
  assert.equal(snapshot.checksums[assets[0]], hash(original[0]));
  assert.equal(snapshot.checksums[assets[1]], hash(original[1]));
  upstreamChanged = true;
  const root = path.join(process.cwd(), `.officecli-snapshot-${randomUUID()}`);
  try {
    for (const [index, arch] of ['x64', 'arm64'].entries()) {
      const staged = await prepareOfficeCli({
        projectRoot: path.join(root, arch),
        arch,
        releaseInfo: snapshot,
        fetchImpl,
      });
      await verifyPackedOfficeCli({
        resourcesDir: 'mock',
        arch,
        releaseJson: matrix.releaseInfo,
        readFile: () => fs.readFileSync(staged),
        fetchImpl,
      });
    }
    assert.equal(calls.length, 4);
    const replaced = Buffer.from(original[0]);
    replaced[100] = 1;
    await assert.rejects(
      verifyPackedOfficeCli({
        resourcesDir: 'mock',
        arch: 'x64',
        releaseJson: matrix.releaseInfo,
        readFile: () => replaced,
        fetchImpl,
      }),
      /SHA256/i
    );
    replacement = true;
    await assert.rejects(
      prepareOfficeCli({
        projectRoot: path.join(root, 'replaced'),
        arch: 'x64',
        releaseInfo: snapshot,
        fetchImpl,
      }),
      /SHA256/i
    );
    assert.equal(calls.length, 5);
    assert.equal(calls.filter((url) => url.endsWith('/SHA256SUMS')).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('rejects invalid checksum lists while resolving and never queries a non-Windows matrix', async () => {
  for (const text of ['', `bad  ${assets[0]}`, `${'0'.repeat(64)}  ${assets[0]}`]) {
    const fetchImpl = async (url) =>
      url.endsWith('/releases/latest')
        ? { ok: true, json: async () => payload() }
        : { ok: true, text: async () => text };
    await assert.rejects(resolveOfficeCliRelease({ fetchImpl }), /SHA256|checksum/i);
  }
  await createBuildMatrix('linux-x64', () => {
    throw new Error('unexpected network');
  });
});
