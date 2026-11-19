const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { it } = require('node:test');

function resolver({ platform, packaged, override, existing = [], lookup = '' }) {
  const file = path.resolve(__dirname, '../../desktop/src/process/backend/binaryResolver.ts');
  let source = stripTypeScriptTypes(fs.readFileSync(file, 'utf8'));
  source = source.replace(/import \{([^}]+)\} from '([^']+)';/g, 'const {$1} = require("$2");');
  source = source.replace('export function resolveBinaryPath', 'function resolveBinaryPath');
  let lookups = 0;
  const modules = {
    'node:fs': { existsSync: (file) => existing.includes(file), readdirSync: () => [] },
    'node:path': path,
    'node:child_process': {
      execSync: () => {
        lookups++;
        return lookup;
      },
    },
  };
  const fakeProcess = {
    platform,
    arch: 'x64',
    env: { AIONUI_BACKEND_BIN: override },
    resourcesPath: 'resources',
    cwd: () => '.',
  };
  const resolveBinary = vm.runInNewContext(`${source}\nresolveBinaryPath`, {
    process: fakeProcess,
    require: (name) => modules[name],
  });
  return { run: () => resolveBinary(packaged), lookups: () => lookups };
}

it('packaged Windows uses only bundled AionCore and fails closed if missing', () => {
  const bundled = path.join('resources', 'bundled-aioncore', 'win32-x64', 'aioncore.exe');
  const override = path.resolve('unapproved');
  const success = resolver({
    platform: 'win32',
    packaged: true,
    override,
    existing: [bundled, override, 'other'],
    lookup: 'other',
  });
  assert.equal(success.run(), bundled);
  assert.equal(success.lookups(), 0);
  const missing = resolver({
    platform: 'win32',
    packaged: true,
    override,
    existing: [override, 'other'],
    lookup: 'other',
  });
  assert.throws(missing.run, /bundled/);
  assert.equal(missing.lookups(), 0);
});

it('development Windows and other packaged platforms retain override and PATH behavior', () => {
  for (const [platform, packaged] of [
    ['win32', false],
    ['linux', true],
  ]) {
    const override = path.resolve('custom');
    assert.equal(resolver({ platform, packaged, override, existing: [override] }).run(), override);
    const fromPath = resolver({ platform, packaged, lookup: 'global', existing: ['global'] });
    assert.equal(fromPath.run(), 'global');
    assert.equal(fromPath.lookups(), 1);
  }
});
