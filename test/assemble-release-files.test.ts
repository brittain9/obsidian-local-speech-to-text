import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  buildChecksumsFile,
  EXPECTED_SIDECAR_ARCHIVES,
  validateSidecarArchives,
} from '../scripts/assemble-release-files.mjs';

function present(name: string, size = 16): { name: string; size: number } {
  return { name, size };
}

function fullSet(): Array<{ name: string; size: number }> {
  return EXPECTED_SIDECAR_ARCHIVES.map((name) => present(name));
}

describe('validateSidecarArchives', () => {
  it('returns no errors when exactly the expected archives are present', () => {
    expect(validateSidecarArchives(fullSet())).toEqual([]);
  });

  it('fails when an expected archive is missing', () => {
    const entries = fullSet().filter((e) => e.name !== 'sidecar-macos-arm64.tar.gz');
    const errors = validateSidecarArchives(entries);
    expect(errors).toContain('missing sidecar archive: sidecar-macos-arm64.tar.gz');
  });

  it('fails when an expected archive is empty', () => {
    const entries = fullSet().map((e) =>
      e.name === 'sidecar-linux-x86_64-cpu.tar.gz' ? present(e.name, 0) : e,
    );
    const errors = validateSidecarArchives(entries);
    expect(errors).toContain('empty sidecar archive: sidecar-linux-x86_64-cpu.tar.gz');
  });

  it('fails when an unexpected archive is present', () => {
    const entries = [...fullSet(), present('sidecar-bogus.zip')];
    const errors = validateSidecarArchives(entries);
    expect(errors).toContain('unexpected sidecar archive: sidecar-bogus.zip');
  });

  it('fails when an expected archive appears more than once', () => {
    const entries = [...fullSet(), present('sidecar-macos-arm64.tar.gz')];
    const errors = validateSidecarArchives(entries);
    expect(errors).toContain('duplicate sidecar archive: sidecar-macos-arm64.tar.gz');
  });
});

describe('buildChecksumsFile', () => {
  it('emits one SHA-256 line per expected archive in deterministic order', () => {
    const contents = new Map<string, Buffer>();
    for (const name of EXPECTED_SIDECAR_ARCHIVES) {
      contents.set(name, Buffer.from(`payload-${name}`, 'utf8'));
    }

    const body = buildChecksumsFile(contents);
    const lines = body.trimEnd().split('\n');
    expect(lines).toHaveLength(EXPECTED_SIDECAR_ARCHIVES.length);

    const sorted = [...EXPECTED_SIDECAR_ARCHIVES].sort();
    lines.forEach((line, index) => {
      const expectedName = sorted[index];
      expect(expectedName).toBeDefined();
      const expectedDigest = createHash('sha256')
        .update(Buffer.from(`payload-${expectedName}`, 'utf8'))
        .digest('hex');
      expect(line).toBe(`${expectedDigest}  ${expectedName}`);
    });
  });

  it('refuses to emit a checksum file from an empty archive set', () => {
    expect(() => buildChecksumsFile(new Map())).toThrow(/SHA-256 of stdin/);
  });

  it('refuses to emit when any expected archive is missing from the map', () => {
    const contents = new Map<string, Buffer>();
    for (const name of EXPECTED_SIDECAR_ARCHIVES) {
      if (name === 'sidecar-windows-x86_64-cuda.zip') continue;
      contents.set(name, Buffer.from(`payload-${name}`, 'utf8'));
    }
    expect(() => buildChecksumsFile(contents)).toThrow(/sidecar-windows-x86_64-cuda\.zip/);
  });

  it('refuses to emit when an unexpected archive is in the map', () => {
    const contents = new Map<string, Buffer>();
    for (const name of EXPECTED_SIDECAR_ARCHIVES) {
      contents.set(name, Buffer.from(`payload-${name}`, 'utf8'));
    }
    contents.set('sidecar-bogus.zip', Buffer.from('x', 'utf8'));
    expect(() => buildChecksumsFile(contents)).toThrow(/unexpected archive/);
  });
});
