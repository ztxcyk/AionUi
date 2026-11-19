const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { join } = require('node:path');
const { afterEach, describe, it } = require('node:test');
const { prepareOfficeCli, resolveOfficeCliRelease } = require('./prepare-officecli');
const { runCli } = require('../../../scripts/prepareOfficeCli');

const API_URL = 'https://api.github.com/repos/ztxcyk/OfficeCLI/releases/latest';
const RELEASE_REPOSITORY = 'ztxcyk/OfficeCLI';
const CHECKSUM_ASSET = 'SHA256SUMS';
const WINDOWS_ASSETS = {
  x64: 'officecli-win-x64.exe',
  arm64: 'officecli-win-arm64.exe',
};
const x64Bytes = Buffer.from('officecli-x64-current-release');
const arm64Bytes = Buffer.from('officecli-arm64-current-release');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const roots = new Set();

function createReleasePayload({ tag = 'v9.8.7', names = Object.values(WINDOWS_ASSETS) } = {}) {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    assets: [CHECKSUM_ASSET, ...names].map((name) => ({ name })),
  };
}

function createReleaseInfo({ tag = 'v9.8.7', assets = Object.values(WINDOWS_ASSETS) } = {}) {
  return {
    repository: RELEASE_REPOSITORY,
    tag,
    assets,
    checksumAsset: CHECKSUM_ASSET,
    checksums: Object.fromEntries(
      assets.map((asset) => [asset, hash(asset === WINDOWS_ASSETS.x64 ? x64Bytes : arm64Bytes)])
    ),
  };
}

function createResponse({ status = 200, json, text, bytes, jsonError } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      if (jsonError) throw jsonError;
      return json;
    },
    async text() {
      return text;
    },
    async arrayBuffer() {
      const buffer = Buffer.from(bytes);
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    },
  };
}

function createFetchImpl({
  release = createReleasePayload(),
  checksumText,
  assetBytes,
  failUrl,
  invalidJson = false,
} = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url === failUrl) return createResponse({ status: 503 });
    if (url === API_URL) {
      return createResponse({
        json: release,
        jsonError: invalidJson ? new SyntaxError('unexpected token') : undefined,
      });
    }
    if (url.endsWith(`/${CHECKSUM_ASSET}`)) {
      return createResponse({
        text:
          checksumText ??
          `${checksumTextFor(WINDOWS_ASSETS.x64, x64Bytes)}${checksumTextFor(WINDOWS_ASSETS.arm64, arm64Bytes)}`,
      });
    }
    if (url.endsWith(`/${WINDOWS_ASSETS.arm64}`)) {
      return createResponse({ bytes: assetBytes ?? arm64Bytes });
    }
    if (url.endsWith(`/${WINDOWS_ASSETS.x64}`)) {
      return createResponse({ bytes: assetBytes ?? x64Bytes });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function createProjectRoot() {
  const root = mkdtempSync(join(process.cwd(), `.officecli-test-${randomUUID()}-`));
  roots.add(root);
  return root;
}

function stagedPath(projectRoot) {
  return join(projectRoot, 'resources', 'bundled-officecli', 'officecli.exe');
}

function checksumTextFor(assetName, bytes) {
  return `${hash(bytes)}  ${assetName}\n`;
}

afterEach(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
    roots.delete(root);
  }
});

describe('resolveOfficeCliRelease', () => {
  it('resolves only available Windows assets once and returns stable release information', async () => {
    const fetchImpl = createFetchImpl({
      release: createReleasePayload({
        names: ['officecli-linux-x64.tar.gz', WINDOWS_ASSETS.arm64, 'officecli-macos-arm64.zip', WINDOWS_ASSETS.x64],
      }),
    });

    const info = await resolveOfficeCliRelease({ fetchImpl });

    assert.deepEqual(info, createReleaseInfo());
    assert.equal(fetchImpl.calls.length, 2);
    assert.equal(fetchImpl.calls[0].url, API_URL);
    assert.equal(fetchImpl.calls[0].options.headers.Accept, 'application/vnd.github+json');
  });

  it('returns a single available Windows architecture without inventing the other', async (t) => {
    for (const assetName of Object.values(WINDOWS_ASSETS)) {
      await t.test(assetName, async () => {
        const info = await resolveOfficeCliRelease({
          fetchImpl: createFetchImpl({ release: createReleasePayload({ names: [assetName] }) }),
        });

        assert.deepEqual(info.assets, [assetName]);
      });
    }
  });

  it('fails when the latest release has no Windows asset', async () => {
    const fetchImpl = createFetchImpl({
      release: createReleasePayload({ names: ['officecli-linux-x64.tar.gz'] }),
    });

    await assert.rejects(resolveOfficeCliRelease({ fetchImpl }), /no supported Windows assets/i);
  });

  it('fails when the latest release has no SHA256SUMS asset', async () => {
    const fetchImpl = createFetchImpl({
      release: { ...createReleasePayload(), assets: Object.values(WINDOWS_ASSETS).map((name) => ({ name })) },
    });

    await assert.rejects(resolveOfficeCliRelease({ fetchImpl }), /SHA256SUMS.*missing/i);
  });

  it('reports API HTTP and malformed JSON failures clearly', async () => {
    const httpFailure = createFetchImpl({ failUrl: API_URL });
    await assert.rejects(resolveOfficeCliRelease({ fetchImpl: httpFailure }), /HTTP 503/i);

    const invalidJson = createFetchImpl({ invalidJson: true });
    await assert.rejects(resolveOfficeCliRelease({ fetchImpl: invalidJson }), /invalid JSON/i);

    await assert.rejects(
      resolveOfficeCliRelease({
        fetchImpl: async () => {
          throw new Error('network unavailable');
        },
      }),
      /latest release API request failed: network unavailable/i
    );
  });

  it('rejects malformed release metadata', async () => {
    const fetchImpl = createFetchImpl({ release: { tag_name: 'v1', assets: null } });

    await assert.rejects(resolveOfficeCliRelease({ fetchImpl }), /malformed.*assets/i);
  });
});

describe('prepareOfficeCli', () => {
  it('downloads and stages only the requested architecture from the supplied release', async () => {
    const projectRoot = createProjectRoot();
    const releaseInfo = createReleaseInfo();
    const fetchImpl = createFetchImpl({
      checksumText: checksumTextFor(WINDOWS_ASSETS.arm64, arm64Bytes),
      assetBytes: arm64Bytes,
    });

    const result = await prepareOfficeCli({ projectRoot, arch: 'arm64', fetchImpl, releaseInfo });

    assert.equal(result, stagedPath(projectRoot));
    assert.deepEqual(readFileSync(result), arm64Bytes);
    assert.deepEqual(
      fetchImpl.calls.map(({ url }) => url),
      [
        `https://github.com/${RELEASE_REPOSITORY}/releases/download/${releaseInfo.tag}/${WINDOWS_ASSETS.arm64}`,
      ]
    );
    assert.equal(fetchImpl.calls.some(({ url }) => url === API_URL), false);
  });

  it('resolves the latest release exactly once when no release information is supplied', async () => {
    const projectRoot = createProjectRoot();
    const fetchImpl = createFetchImpl({
      release: createReleasePayload({ names: [WINDOWS_ASSETS.x64] }),
      checksumText: checksumTextFor(WINDOWS_ASSETS.x64, x64Bytes),
      assetBytes: x64Bytes,
    });

    await prepareOfficeCli({ projectRoot, arch: 'x64', fetchImpl });

    assert.equal(fetchImpl.calls.filter(({ url }) => url === API_URL).length, 1);
    assert.equal(existsSync(stagedPath(projectRoot)), true);
  });

  it('rejects a requested architecture absent from the resolved asset list without downloading', async () => {
    const fetchImpl = createFetchImpl();

    await assert.rejects(
      prepareOfficeCli({
        projectRoot: createProjectRoot(),
        arch: 'arm64',
        fetchImpl,
        releaseInfo: createReleaseInfo({ assets: [WINDOWS_ASSETS.x64] }),
      }),
      /does not contain.*arm64/i
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('rejects unsupported architectures without querying GitHub', async () => {
    const fetchImpl = createFetchImpl();

    await assert.rejects(
      prepareOfficeCli({ projectRoot: createProjectRoot(), arch: 'ia32', fetchImpl }),
      /unsupported.*architecture/i
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('rejects checksum rows that are missing, malformed, or duplicated at resolution', async (t) => {
    const cases = [
      ['missing', ''],
      ['malformed', `not-a-hash  ${WINDOWS_ASSETS.x64}\n`],
      [
        'duplicated',
        `${checksumTextFor(WINDOWS_ASSETS.x64, x64Bytes)}${checksumTextFor(WINDOWS_ASSETS.x64, x64Bytes)}`,
      ],
    ];

    for (const [label, checksumText] of cases) {
      await t.test(label, async () => {
        const fetchImpl = createFetchImpl({ checksumText, assetBytes: x64Bytes });

        await assert.rejects(resolveOfficeCliRelease({ fetchImpl }), /SHA256|checksum/i);
      });
    }
  });

  it('verifies downloaded bytes against the checksum even for a stale release tag', async () => {
    const projectRoot = createProjectRoot();
    const releaseInfo = createReleaseInfo({ tag: 'v0.1.0' });
    releaseInfo.checksums[WINDOWS_ASSETS.x64] = hash(Buffer.from('different released bytes'));
    const fetchImpl = createFetchImpl({
      checksumText: checksumTextFor(WINDOWS_ASSETS.x64, Buffer.from('different released bytes')),
      assetBytes: x64Bytes,
    });

    await assert.rejects(
      prepareOfficeCli({ projectRoot, arch: 'x64', fetchImpl, releaseInfo }),
      /SHA256.*does not match/i
    );

    const stagingDirectory = join(projectRoot, 'resources', 'bundled-officecli');
    assert.equal(existsSync(stagedPath(projectRoot)), false);
    assert.deepEqual(existsSync(stagingDirectory) ? readdirSync(stagingDirectory) : [], []);
  });

  it('preserves an existing staged file and removes only the failed temporary download', async () => {
    const projectRoot = createProjectRoot();
    const stagingDirectory = join(projectRoot, 'resources', 'bundled-officecli');
    const stagedFile = stagedPath(projectRoot);
    const existingData = Buffer.from('pre-existing-test-fixture');
    mkdirSync(stagingDirectory, { recursive: true });
    writeFileSync(stagedFile, existingData);
    const fetchImpl = createFetchImpl({
      checksumText: checksumTextFor(WINDOWS_ASSETS.x64, x64Bytes),
      assetBytes: Buffer.from('invalid-download'),
    });

    await assert.rejects(
      prepareOfficeCli({
        projectRoot,
        arch: 'x64',
        fetchImpl,
        releaseInfo: createReleaseInfo(),
      }),
      /SHA256.*does not match/i
    );

    assert.deepEqual(readFileSync(stagedFile), existingData);
    assert.deepEqual(readdirSync(stagingDirectory), ['officecli.exe']);
  });

  it('refuses to overwrite an existing target when the verified download would succeed', async () => {
    const projectRoot = createProjectRoot();
    const stagingDirectory = join(projectRoot, 'resources', 'bundled-officecli');
    const stagedFile = stagedPath(projectRoot);
    const existingData = Buffer.from('existing-test-data');
    mkdirSync(stagingDirectory, { recursive: true });
    writeFileSync(stagedFile, existingData);
    const fetchImpl = createFetchImpl({
      checksumText: checksumTextFor(WINDOWS_ASSETS.x64, x64Bytes),
      assetBytes: x64Bytes,
    });

    await assert.rejects(
      prepareOfficeCli({
        projectRoot,
        arch: 'x64',
        fetchImpl,
        releaseInfo: createReleaseInfo(),
      }),
      /already exists.*refusing to overwrite/i
    );

    assert.deepEqual(readFileSync(stagedFile), existingData);
    assert.deepEqual(readdirSync(stagingDirectory), ['officecli.exe']);
  });

  it('does not overwrite a target created concurrently during download', async () => {
    const projectRoot = createProjectRoot();
    const stagingDirectory = join(projectRoot, 'resources', 'bundled-officecli');
    const stagedFile = stagedPath(projectRoot);
    const concurrentlyCreatedData = Buffer.from('concurrent-test-data');
    const baseFetch = createFetchImpl({
      checksumText: checksumTextFor(WINDOWS_ASSETS.x64, x64Bytes),
      assetBytes: x64Bytes,
    });
    const fetchImpl = async (url, options) => {
      const response = await baseFetch(url, options);
      if (!url.endsWith(`/${WINDOWS_ASSETS.x64}`)) return response;
      return {
        ...response,
        async arrayBuffer() {
          mkdirSync(stagingDirectory, { recursive: true });
          writeFileSync(stagedFile, concurrentlyCreatedData);
          return response.arrayBuffer();
        },
      };
    };

    await assert.rejects(
      prepareOfficeCli({
        projectRoot,
        arch: 'x64',
        fetchImpl,
        releaseInfo: createReleaseInfo(),
      }),
      /already exists.*refusing to overwrite/i
    );

    assert.deepEqual(readFileSync(stagedFile), concurrentlyCreatedData);
    assert.deepEqual(readdirSync(stagingDirectory), ['officecli.exe']);
  });

  it('rejects non-2xx checksum resolution and asset responses', async (t) => {
    for (const failAsset of [CHECKSUM_ASSET, WINDOWS_ASSETS.x64]) {
      await t.test(failAsset, async () => {
        const releaseInfo = createReleaseInfo();
        const fetchImpl = createFetchImpl({
          checksumText: checksumTextFor(WINDOWS_ASSETS.x64, x64Bytes),
          assetBytes: x64Bytes,
          failUrl: `https://github.com/${RELEASE_REPOSITORY}/releases/download/${releaseInfo.tag}/${failAsset}`,
        });

        if (failAsset === CHECKSUM_ASSET) {
          await assert.rejects(resolveOfficeCliRelease({ fetchImpl }), /HTTP 503/i);
        } else {
          await assert.rejects(
            prepareOfficeCli({ projectRoot: createProjectRoot(), arch: 'x64', fetchImpl, releaseInfo }),
            /HTTP 503/i
          );
        }
      });
    }
  });

  it('rejects malformed or mismatched release information', async (t) => {
    const cases = [
      ['wrong repository', { ...createReleaseInfo(), repository: 'other/OfficeCLI' }],
      ['empty tag', { ...createReleaseInfo(), tag: '' }],
      ['missing checksums', { ...createReleaseInfo(), checksumAsset: undefined }],
      ['missing snapshot', { ...createReleaseInfo(), checksums: undefined }],
      ['malformed snapshot', { ...createReleaseInfo(), checksums: { [WINDOWS_ASSETS.x64]: 'bad' } }],
    ];

    for (const [label, releaseInfo] of cases) {
      await t.test(label, async () => {
        const fetchImpl = createFetchImpl();

        await assert.rejects(
          prepareOfficeCli({
            projectRoot: createProjectRoot(),
            arch: 'x64',
            fetchImpl,
            releaseInfo,
          }),
          /release information/i
        );
        assert.equal(fetchImpl.calls.length, 0);
      });
    }
  });
});

describe('prepareOfficeCli wrapper', () => {
  it('writes one stable JSON line for release resolution', async () => {
    const output = [];
    const fetchImpl = createFetchImpl();
    await runCli({
      args: ['--resolve-release'],
      env: {},
      fetchImpl,
      stdout: { write: (value) => output.push(value) },
      projectRoot: createProjectRoot(),
    });

    assert.equal(output.length, 1);
    assert.equal(output[0], `${JSON.stringify(createReleaseInfo())}\n`);
  });

  it('accepts a serialized release from another job without resolving latest again', async () => {
    const projectRoot = createProjectRoot();
    const info = createReleaseInfo({ assets: [WINDOWS_ASSETS.x64] });
    const fetchImpl = createFetchImpl({
      checksumText: checksumTextFor(WINDOWS_ASSETS.x64, x64Bytes),
      assetBytes: x64Bytes,
    });
    const logs = [];

    await runCli({
      args: [],
      env: {
        AIONUI_OFFICECLI_ARCH: 'x64',
        AIONUI_OFFICECLI_RELEASE_INFO: JSON.stringify(info),
      },
      fetchImpl,
      stdout: { write: (value) => logs.push(value) },
      projectRoot,
    });

    assert.equal(fetchImpl.calls.some(({ url }) => url === API_URL), false);
    assert.deepEqual(readFileSync(stagedPath(projectRoot)), x64Bytes);
    assert.equal(logs.length, 1);
  });

  it('propagates a staging failure without reporting preparation success', async () => {
    const projectRoot = createProjectRoot();
    const info = createReleaseInfo({ assets: [WINDOWS_ASSETS.x64] });
    const fetchImpl = createFetchImpl({
      checksumText: checksumTextFor(WINDOWS_ASSETS.x64, x64Bytes),
      assetBytes: Buffer.from('invalid-download'),
    });
    const output = [];

    await assert.rejects(
      runCli({
        args: [],
        env: {
          AIONUI_OFFICECLI_ARCH: 'x64',
          AIONUI_OFFICECLI_RELEASE_INFO: JSON.stringify(info),
        },
        fetchImpl,
        projectRoot,
        stdout: { write: (value) => output.push(value) },
      }),
      /SHA256.*does not match/i
    );

    assert.deepEqual(output, []);
    assert.equal(existsSync(stagedPath(projectRoot)), false);
  });

  it('rejects malformed serialized release information', async () => {
    await assert.rejects(
      runCli({
        args: [],
        env: {
          AIONUI_OFFICECLI_ARCH: 'x64',
          AIONUI_OFFICECLI_RELEASE_INFO: '{invalid',
        },
        fetchImpl: createFetchImpl(),
        projectRoot: createProjectRoot(),
        stdout: { write() {} },
      }),
      /release information.*JSON/i
    );
  });
});
