import { createHash } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync, gzipSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { httpsResponses } = vi.hoisted(() => ({
  httpsResponses: new Map<string, Buffer>(),
}));

vi.mock('node:https', async () => {
  const { EventEmitter } = await import('node:events');
  const { Readable } = await import('node:stream');

  return {
    get: (url: string | URL, ...args: unknown[]): EventEmitter => {
      const urlString = typeof url === 'string' ? url : url.toString();
      const callback = args.find((arg): arg is (res: unknown) => void => typeof arg === 'function');
      const req = new EventEmitter() as EventEmitter & {
        destroy(err?: Error): void;
      };
      req.destroy = (err?: Error): void => {
        if (err) req.emit('error', err);
      };

      queueMicrotask(() => {
        const body = httpsResponses.get(urlString);

        if (body === undefined) {
          const res = Readable.from(Buffer.alloc(0));
          Object.assign(res, { headers: {}, statusCode: 404 });
          callback?.(res);
          return;
        }

        const res = Readable.from([body]);
        Object.assign(res, {
          headers: { 'content-length': String(body.length) },
          statusCode: 200,
        });
        callback?.(res);
      });

      return req;
    },
  };
});

import {
  detectPlatformAsset,
  installSidecar,
  parseChecksum,
  readInstallManifest,
  uninstallSidecarVariant,
  variantDirectoryPath,
} from '../src/sidecar/sidecar-installer';

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directoryPath) => rm(directoryPath, { force: true, recursive: true })),
  );
  httpsResponses.clear();
});

describe('detectPlatformAsset', () => {
  it('returns the macOS arm64 tarball for darwin arm64', () => {
    expect(detectPlatformAsset('darwin', 'arm64', 'cpu')).toEqual({
      archiveKind: 'tar.gz',
      assetName: 'sidecar-macos-arm64.tar.gz',
    });
  });

  it('rejects CUDA on macOS', () => {
    expect(() => detectPlatformAsset('darwin', 'arm64', 'cuda')).toThrow(/not available on macOS/i);
  });

  it('rejects Intel Mac', () => {
    expect(() => detectPlatformAsset('darwin', 'x64', 'cpu')).toThrow(/architecture/i);
  });

  it('returns the Linux tarball variants', () => {
    expect(detectPlatformAsset('linux', 'x64', 'cpu').assetName).toBe(
      'sidecar-linux-x86_64-cpu.tar.gz',
    );
    expect(detectPlatformAsset('linux', 'x64', 'cuda').assetName).toBe(
      'sidecar-linux-x86_64-cuda.tar.gz',
    );
  });

  it('returns the Windows zip variants', () => {
    expect(detectPlatformAsset('win32', 'x64', 'cpu')).toEqual({
      archiveKind: 'zip',
      assetName: 'sidecar-windows-x86_64-cpu.zip',
    });
    expect(detectPlatformAsset('win32', 'x64', 'cuda').assetName).toBe(
      'sidecar-windows-x86_64-cuda.zip',
    );
  });
});

describe('parseChecksum', () => {
  it('returns the hash for the matching filename', () => {
    const text = [
      '0000000000000000000000000000000000000000000000000000000000000001  sidecar-linux-x86_64-cpu.tar.gz',
      '0000000000000000000000000000000000000000000000000000000000000002 *sidecar-windows-x86_64-cpu.zip',
    ].join('\n');

    expect(parseChecksum(text, 'sidecar-linux-x86_64-cpu.tar.gz')).toBe(
      '0000000000000000000000000000000000000000000000000000000000000001',
    );
    expect(parseChecksum(text, 'sidecar-windows-x86_64-cpu.zip')).toBe(
      '0000000000000000000000000000000000000000000000000000000000000002',
    );
  });

  it('throws when the filename is not present', () => {
    expect(() => parseChecksum('', 'missing.tar.gz')).toThrow(/not found/);
  });
});

describe('readInstallManifest', () => {
  it('returns the parsed manifest', async () => {
    const variantDir = await createTempDirectory();
    const manifest = {
      installedAt: '2026-04-21T00:00:00.000Z',
      sha256: 'abc',
      variant: 'cpu' as const,
      version: '2026.4.21',
    };
    await writeFile(join(variantDir, 'install.json'), JSON.stringify(manifest), 'utf8');

    await expect(readInstallManifest(variantDir)).resolves.toEqual(manifest);
  });

  it('returns null when the manifest is missing', async () => {
    const variantDir = await createTempDirectory();
    await expect(readInstallManifest(variantDir)).resolves.toBeNull();
  });

  it('returns null when the manifest is malformed', async () => {
    const variantDir = await createTempDirectory();
    await writeFile(join(variantDir, 'install.json'), '{ not json', 'utf8');
    await expect(readInstallManifest(variantDir)).resolves.toBeNull();
  });

  it('returns null when the manifest has the wrong shape', async () => {
    const variantDir = await createTempDirectory();
    await writeFile(join(variantDir, 'install.json'), JSON.stringify({ variant: 'cpu' }), 'utf8');
    await expect(readInstallManifest(variantDir)).resolves.toBeNull();
  });
});

describe('installSidecar', () => {
  const originalPlatform = process.platform;
  const originalArch = process.arch;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    Object.defineProperty(process, 'arch', { value: 'x64' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    Object.defineProperty(process, 'arch', { value: originalArch });
  });

  it('downloads, verifies, extracts, and writes install.json last', async () => {
    const pluginDirectory = await createTempDirectory();
    const archive = buildTarGz([
      { content: Buffer.from('#!/bin/bash\n'), name: 'obsidian-local-stt-sidecar' },
    ]);
    const archiveSha256 = sha256Hex(archive);
    const assetName = 'sidecar-linux-x86_64-cpu.tar.gz';
    const checksumsText = `${archiveSha256}  ${assetName}\n`;

    stubHttps({
      [`https://releases.test/2026.4.21/${assetName}`]: archive,
      'https://releases.test/2026.4.21/checksums.txt': Buffer.from(checksumsText),
    });

    const progressEvents: Array<{ phase: string; bytes: number; total: number | null }> = [];

    const result = await installSidecar({
      onProgress: (progress) => {
        progressEvents.push({
          bytes: progress.bytesDownloaded,
          phase: progress.phase,
          total: progress.totalBytes,
        });
      },
      pluginDirectory,
      releaseBaseUrl: 'https://releases.test',
      variant: 'cpu',
      version: '2026.4.21',
    });

    expect(result.variantDirectory).toBe(variantDirectoryPath(pluginDirectory, 'cpu'));
    expect(result.manifest.sha256).toBe(archiveSha256);
    expect(result.manifest.variant).toBe('cpu');
    expect(result.manifest.version).toBe('2026.4.21');

    const installedBinary = await readFile(
      join(result.variantDirectory, 'obsidian-local-stt-sidecar'),
    );
    expect(installedBinary.toString('utf8')).toBe('#!/bin/bash\n');

    const manifest = await readInstallManifest(result.variantDirectory);
    expect(manifest).not.toBeNull();
    expect(manifest?.sha256).toBe(archiveSha256);

    expect(progressEvents.some((entry) => entry.phase === 'download')).toBe(true);
    expect(progressEvents.some((entry) => entry.phase === 'verify')).toBe(true);
    expect(progressEvents.some((entry) => entry.phase === 'extract')).toBe(true);
  });

  it('fails and leaves no manifest when the checksum does not match', async () => {
    const pluginDirectory = await createTempDirectory();
    const archive = buildTarGz([
      { content: Buffer.from('binary'), name: 'obsidian-local-stt-sidecar' },
    ]);
    const assetName = 'sidecar-linux-x86_64-cpu.tar.gz';
    const checksumsText = `${'0'.repeat(64)}  ${assetName}\n`;

    stubHttps({
      [`https://releases.test/2026.4.21/${assetName}`]: archive,
      'https://releases.test/2026.4.21/checksums.txt': Buffer.from(checksumsText),
    });

    await expect(
      installSidecar({
        pluginDirectory,
        releaseBaseUrl: 'https://releases.test',
        variant: 'cpu',
        version: '2026.4.21',
      }),
    ).rejects.toThrow(/Checksum mismatch/);

    const manifest = await readInstallManifest(variantDirectoryPath(pluginDirectory, 'cpu'));
    expect(manifest).toBeNull();
  });

  it('rejects archive entries that escape the destination directory', async () => {
    const pluginDirectory = await createTempDirectory();
    const archive = buildTarGz([{ content: Buffer.from('malicious'), name: '../escape.txt' }]);
    const archiveSha256 = sha256Hex(archive);
    const assetName = 'sidecar-linux-x86_64-cpu.tar.gz';
    const checksumsText = `${archiveSha256}  ${assetName}\n`;

    stubHttps({
      [`https://releases.test/2026.4.21/${assetName}`]: archive,
      'https://releases.test/2026.4.21/checksums.txt': Buffer.from(checksumsText),
    });

    await expect(
      installSidecar({
        pluginDirectory,
        releaseBaseUrl: 'https://releases.test',
        variant: 'cpu',
        version: '2026.4.21',
      }),
    ).rejects.toThrow(/Refusing archive entry/);
  });

  it('rejects with HTTP 404 when checksums.txt is missing for the version', async () => {
    const pluginDirectory = await createTempDirectory();
    const archive = buildTarGz([
      { content: Buffer.from('binary'), name: 'obsidian-local-stt-sidecar' },
    ]);
    const assetName = 'sidecar-linux-x86_64-cpu.tar.gz';

    // Archive is reachable but checksums.txt is not stubbed — mock returns 404.
    stubHttps({
      [`https://releases.test/2026.4.21/${assetName}`]: archive,
    });

    await expect(
      installSidecar({
        pluginDirectory,
        releaseBaseUrl: 'https://releases.test',
        variant: 'cpu',
        version: '2026.4.21',
      }),
    ).rejects.toThrow(/HTTP 404/);

    const manifest = await readInstallManifest(variantDirectoryPath(pluginDirectory, 'cpu'));
    expect(manifest).toBeNull();
  });

  it('aborts before any HTTP fetch when the signal is already aborted', async () => {
    const pluginDirectory = await createTempDirectory();
    const controller = new AbortController();
    controller.abort();

    await expect(
      installSidecar({
        pluginDirectory,
        releaseBaseUrl: 'https://releases.test',
        signal: controller.signal,
        variant: 'cpu',
        version: '2026.4.21',
      }),
    ).rejects.toThrow(/aborted/i);

    const manifest = await readInstallManifest(variantDirectoryPath(pluginDirectory, 'cpu'));
    expect(manifest).toBeNull();
  });

  it('extracts zip archives on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const pluginDirectory = await createTempDirectory();
    const archive = buildZip([
      { content: Buffer.from('windows-binary'), name: 'obsidian-local-stt-sidecar.exe' },
    ]);
    const archiveSha256 = sha256Hex(archive);
    const assetName = 'sidecar-windows-x86_64-cpu.zip';
    const checksumsText = `${archiveSha256}  ${assetName}\n`;

    stubHttps({
      [`https://releases.test/2026.4.21/${assetName}`]: archive,
      'https://releases.test/2026.4.21/checksums.txt': Buffer.from(checksumsText),
    });

    const result = await installSidecar({
      pluginDirectory,
      releaseBaseUrl: 'https://releases.test',
      variant: 'cpu',
      version: '2026.4.21',
    });

    const installedBinary = await readFile(
      join(result.variantDirectory, 'obsidian-local-stt-sidecar.exe'),
    );
    expect(installedBinary.toString('utf8')).toBe('windows-binary');
  });
});

describe('uninstallSidecarVariant', () => {
  it('removes the variant directory', async () => {
    const pluginDirectory = await createTempDirectory();
    const variantDir = variantDirectoryPath(pluginDirectory, 'cuda');
    await mkdir(variantDir, { recursive: true });
    await writeFile(join(variantDir, 'obsidian-local-stt-sidecar'), 'binary');

    await uninstallSidecarVariant(pluginDirectory, 'cuda');

    await expect(readInstallManifest(variantDir)).resolves.toBeNull();
  });

  it('does not throw when the variant directory is already missing', async () => {
    const pluginDirectory = await createTempDirectory();
    await expect(uninstallSidecarVariant(pluginDirectory, 'cuda')).resolves.toBeUndefined();
  });
});

async function createTempDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'obsidian-local-stt-installer-'));
  tempDirectories.push(path);
  return path;
}

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function stubHttps(responseMap: Record<string, Buffer>): void {
  httpsResponses.clear();
  for (const [url, body] of Object.entries(responseMap)) {
    httpsResponses.set(url, body);
  }
}

function buildTarGz(entries: Array<{ name: string; content: Buffer }>): Buffer {
  const blocks: Buffer[] = [];

  for (const entry of entries) {
    blocks.push(buildTarHeader(entry.name, entry.content.length));
    blocks.push(padToBlock(entry.content));
  }

  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function buildTarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000755\0', 100, 8, 'utf8');
  header.write('0000000\0', 108, 8, 'utf8');
  header.write('0000000\0', 116, 8, 'utf8');
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8');
  header.write('00000000000\0', 136, 12, 'utf8');
  header.write('        ', 148, 8, 'utf8');
  header.write('0', 156, 1, 'utf8');
  header.write('ustar\0', 257, 6, 'utf8');
  header.write('00', 263, 2, 'utf8');

  let sum = 0;
  for (const byte of header) sum += byte;
  const checksum = `${sum.toString(8).padStart(6, '0')}\0 `;
  header.write(checksum, 148, 8, 'utf8');

  return header;
}

function padToBlock(content: Buffer): Buffer {
  const remainder = content.length % 512;
  if (remainder === 0) return content;
  return Buffer.concat([content, Buffer.alloc(512 - remainder)]);
}

function buildZip(entries: Array<{ name: string; content: Buffer }>): Buffer {
  const localRecords: Buffer[] = [];
  const centralRecords: Buffer[] = [];
  let cursor = 0;

  for (const entry of entries) {
    const deflated = deflateRawSync(entry.content);
    const nameBytes = Buffer.from(entry.name, 'utf8');

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);

    localRecords.push(local);
    localRecords.push(deflated);

    const localOffset = cursor;
    cursor += local.length + deflated.length;

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(entry.content.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(localOffset, 42);
    nameBytes.copy(central, 46);

    centralRecords.push(central);
  }

  const cdOffset = cursor;
  const cdSize = centralRecords.reduce((total, record) => total + record.length, 0);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localRecords, ...centralRecords, eocd]);
}
