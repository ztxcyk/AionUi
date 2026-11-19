const fs = require('node:fs');
const { createBuildMatrix } = require('../packages/shared-scripts/src/officecli-matrix');

async function main() {
  const result = await createBuildMatrix(process.env.AIONUI_BUILD_PLATFORM);
  for (const platform of result.skipped) console.log(`Skipping ${platform}: OfficeCLI release asset is unavailable`);
  if (result.releaseInfo) console.log(`Selected OfficeCLI release: ${JSON.parse(result.releaseInfo).tag}`);
  console.log(`Build matrix: ${JSON.stringify(result.matrix)}`);
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `matrix=${JSON.stringify(result.matrix)}\nrelease_info=${result.releaseInfo}\n`
  );
}

main().catch((error) => {
  console.error(`OfficeCLI matrix preparation failed: ${error.message}`);
  process.exitCode = 1;
});
