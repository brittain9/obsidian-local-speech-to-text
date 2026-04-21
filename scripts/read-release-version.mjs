import { readFile } from 'node:fs/promises';

const DATE_VERSION_PATTERN = /^(\d{4})\.(1[0-2]|[1-9])\.(3[01]|[12]\d|[1-9])$/;

const args = new Set(process.argv.slice(2));
const releaseTag = readFlagValue('--tag');

const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const cargoManifest = await readFile('native/Cargo.toml', 'utf8');
const cargoVersionMatch = cargoManifest.match(/^version = "([^"]+)"$/m);

if (cargoVersionMatch === null) {
  throw new Error('Failed to read the sidecar version from native/Cargo.toml.');
}

const releaseVersion = manifest.version;

assertDateVersion('manifest.json', releaseVersion);

const mismatchedFiles = [
  ['package.json', packageJson.version],
  ['native/Cargo.toml', cargoVersionMatch[1]],
].filter(([, version]) => version !== releaseVersion);

if (mismatchedFiles.length > 0) {
  const mismatchSummary = mismatchedFiles
    .map(([filePath, version]) => `${filePath}=${version}`)
    .join(', ');
  throw new Error(
    `Release versions must match manifest.json=${releaseVersion}. Found mismatches: ${mismatchSummary}.`,
  );
}

if (releaseTag !== null) {
  assertDateVersion('release tag', releaseTag);

  if (releaseTag !== releaseVersion) {
    throw new Error(
      `Release tag ${releaseTag} must match manifest.json version ${releaseVersion} exactly.`,
    );
  }
}

process.stdout.write(releaseVersion);

function assertDateVersion(source, value) {
  if (!DATE_VERSION_PATTERN.test(value)) {
    throw new Error(
      `${source} version "${value}" must match date format YYYY.M.D (e.g. 2026.4.21).`,
    );
  }
}

function readFlagValue(flagName) {
  if (!args.has(flagName)) {
    return null;
  }

  const argv = process.argv.slice(2);
  const flagIndex = argv.indexOf(flagName);
  const flagValue = argv[flagIndex + 1];

  if (flagValue === undefined) {
    throw new Error(`${flagName} requires a value.`);
  }

  return flagValue;
}
