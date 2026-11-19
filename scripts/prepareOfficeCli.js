const path = require('node:path');
const {
  prepareOfficeCli,
  resolveOfficeCliRelease,
} = require('../packages/shared-scripts/src/prepare-officecli');

async function runCli({
  args = process.argv.slice(2),
  env = process.env,
  fetchImpl = globalThis.fetch,
  projectRoot = path.resolve(__dirname, '..'),
  stdout = process.stdout,
} = {}) {
  if (args.length === 1 && args[0] === '--resolve-release') {
    const releaseInfo = await resolveOfficeCliRelease({ fetchImpl });
    stdout.write(`${JSON.stringify(releaseInfo)}\n`);
    return releaseInfo;
  }
  if (args.length > 0) {
    throw new Error(`Unsupported prepareOfficeCli argument: ${args[0]}`);
  }

  const arch = env.AIONUI_OFFICECLI_ARCH || env.npm_config_target_arch || process.arch;
  let releaseInfo;
  if (env.AIONUI_OFFICECLI_RELEASE_INFO) {
    try {
      releaseInfo = JSON.parse(env.AIONUI_OFFICECLI_RELEASE_INFO);
    } catch (error) {
      throw new Error(`OfficeCLI release information contains invalid JSON: ${error.message}`, { cause: error });
    }
  }

  const filePath = await prepareOfficeCli({ projectRoot, arch, fetchImpl, releaseInfo });
  stdout.write(`Prepared OfficeCLI: ${filePath}\n`);
  return filePath;
}

if (require.main === module) {
  runCli().catch((error) => {
    console.error('prepareOfficeCli failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { runCli };
