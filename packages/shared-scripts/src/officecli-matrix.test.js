const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const { createBuildMatrix } = require('./officecli-matrix');
const { runCli } = require('../../../scripts/prepareOfficeCli');

const x64 = 'officecli-win-x64.exe';
const arm64 = 'officecli-win-arm64.exe';
const fixtureHash = createHash('sha256').update('mock binary').digest('hex');
const release = (assets) => ({
  repository: 'ztxcyk/OfficeCLI',
  tag: 'v1.2.3',
  assets,
  checksumAsset: 'SHA256SUMS',
  checksums: Object.fromEntries(assets.map((asset) => [asset, fixtureHash])),
});

describe('OfficeCLI build matrix', () => {
  it('resolves once and propagates the same release for both Windows targets', async () => {
    let calls = 0;
    const info = release([x64, arm64]);
    const result = await createBuildMatrix('all', async () => {
      calls++;
      return info;
    });
    assert.equal(calls, 1);
    assert.deepEqual(
      result.matrix.include.map((item) => item.platform),
      ['macos-arm64', 'macos-x64', 'windows-x64', 'windows-arm64', 'linux-x64', 'linux-arm64']
    );
    assert.deepEqual(JSON.parse(result.releaseInfo), info);
    assert.deepEqual(result.skipped, []);
  });

  it('skips and reports unavailable requested architectures without affecting other platforms', async () => {
    const result = await createBuildMatrix('all', async () => release([x64]));
    assert.deepEqual(
      result.matrix.include.map((item) => item.platform),
      ['macos-arm64', 'macos-x64', 'windows-x64', 'linux-x64', 'linux-arm64']
    );
    assert.deepEqual(result.skipped, ['windows-arm64']);
  });

  it('fails when the only requested Windows architecture is unavailable', async () => {
    await assert.rejects(createBuildMatrix('windows-arm64', async () => release([x64])), /no requested Windows/i);
    await assert.rejects(createBuildMatrix('all', async () => release([])), /no supported Windows/i);
  });

  it('does not resolve a release for a non-Windows-only request', async () => {
    const result = await createBuildMatrix('linux-x64', async () => {
      throw new Error('must not resolve');
    });
    assert.deepEqual(result.matrix.include.map((item) => item.platform), ['linux-x64']);
    assert.equal(result.releaseInfo, '');
  });

  it('propagates resolution failures and rejects invalid platform selection', async () => {
    await assert.rejects(
      createBuildMatrix('all', async () => {
        throw new Error('missing SHA256SUMS');
      }),
      /SHA256SUMS/
    );
    await assert.rejects(createBuildMatrix('unknown', async () => release([x64])), /unsupported platform/i);
  });

  it('rejects a malformed snapshot before publishing the Windows matrix', async () => {
    const bad = { ...release([x64]), checksums: { [x64]: 'bad' } };
    await assert.rejects(createBuildMatrix('all', async () => bad), /checksum/i);
  });

  it('passes the matrix release JSON to both preparers without another latest lookup', async () => {
    const result = await createBuildMatrix('all', async () => release([x64, arm64]));
    const root = path.join(process.cwd(), `.officecli-matrix-test-${randomUUID()}`);
    const bytes = Buffer.from('mock binary');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(url);
      assert.match(url, /\/releases\/download\/v1\.2\.3\//);
      return {
        ok: true,
        text: async () => `${digest}  ${x64}\n${digest}  ${arm64}\n`,
        arrayBuffer: async () => Uint8Array.from(bytes).buffer,
      };
    };
    try {
      for (const arch of ['x64', 'arm64']) {
        await runCli({
          args: [],
          env: { AIONUI_OFFICECLI_ARCH: arch, AIONUI_OFFICECLI_RELEASE_INFO: result.releaseInfo },
          projectRoot: path.join(root, arch),
          fetchImpl,
          stdout: { write() {} },
        });
      }
      assert.equal(urls.length, 2);
      assert.ok(urls.some((url) => url.endsWith(x64)));
      assert.ok(urls.some((url) => url.endsWith(arm64)));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
