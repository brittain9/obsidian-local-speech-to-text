import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

interface WatchedPath {
  absolutePath: string;
  displayPath: string;
}

export async function assertSidecarExecutableIsFresh(
  executablePath: string,
  sidecarProjectDirectory: string,
): Promise<void> {
  const executableStats = await stat(executablePath);
  const watchedPaths = await collectWatchedPaths(sidecarProjectDirectory);

  for (const watchedPath of watchedPaths) {
    const watchedStats = await stat(watchedPath.absolutePath);

    if (watchedStats.mtimeMs > executableStats.mtimeMs) {
      throw new Error(
        `Sidecar executable is stale. ${watchedPath.displayPath} is newer than ${executablePath}. Rebuild with \`npm run build\` or \`cargo build --manifest-path native/Cargo.toml\`.`,
      );
    }
  }
}

async function collectWatchedPaths(sidecarProjectDirectory: string): Promise<WatchedPath[]> {
  const watchedPaths: WatchedPath[] = [
    {
      absolutePath: join(sidecarProjectDirectory, 'Cargo.toml'),
      displayPath: 'native/Cargo.toml',
    },
    {
      absolutePath: join(sidecarProjectDirectory, 'Cargo.lock'),
      displayPath: 'native/Cargo.lock',
    },
  ];

  watchedPaths.push(
    ...(await collectRustSourcePaths(join(sidecarProjectDirectory, 'src'), 'native/src')),
  );

  return watchedPaths;
}

async function collectRustSourcePaths(
  directoryPath: string,
  displayDirectoryPath: string,
): Promise<WatchedPath[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const watchedPaths: WatchedPath[] = [];

  for (const entry of entries) {
    const absolutePath = join(directoryPath, entry.name);
    const displayPath = `${displayDirectoryPath}/${entry.name}`;

    if (entry.isDirectory()) {
      watchedPaths.push(...(await collectRustSourcePaths(absolutePath, displayPath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.rs')) {
      watchedPaths.push({
        absolutePath,
        displayPath,
      });
    }
  }

  return watchedPaths;
}
