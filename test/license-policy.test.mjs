import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { auditPackageLicenses, isAllowedLicense, licenseIdentifiers, scanProjectLicenses } from '../release/licenses.mjs';

test('accepts reviewed SPDX expressions and rejects unknown or prohibited licenses', () => {
  assert.deepEqual(licenseIdentifiers('(BSD-2-Clause OR MIT OR Apache-2.0)'), ['BSD-2-Clause', 'MIT', 'Apache-2.0']);
  assert.equal(isAllowedLicense('MIT AND ISC'), true);
  assert.equal(isAllowedLicense('Apache-2.0 AND LGPL-3.0-or-later'), true);
  assert.equal(isAllowedLicense('GPL-3.0-only'), false);
  assert.equal(isAllowedLicense('UNLICENSED'), false);
  assert.equal(isAllowedLicense(undefined), false);

  const result = auditPackageLicenses([
    { name: 'allowed', version: '1.0.0', license: 'MIT' },
    { name: 'prohibited', version: '1.0.0', license: 'GPL-3.0-only' },
    { name: 'unknown', version: '1.0.0' },
  ]);
  assert.equal(result.packages, 3);
  assert.deepEqual(result.licenses, { MIT: 1 });
  assert.deepEqual(result.violations.map(item => item.name), ['prohibited', 'unknown']);
});

test('scans the application and landing dependency trees without violations', async () => {
  for (const directory of [resolve('.'), resolve('landing')]) {
    const result = await scanProjectLicenses(directory);
    assert.ok(result.packages > 0);
    assert.deepEqual(result.violations, []);
  }
});

test('explains missing and malformed lockfiles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quizzer-license-policy-test-'));
  try {
    await assert.rejects(scanProjectLicenses(directory), /Could not read/);
    await writeFile(join(directory, 'package-lock.json'), '{not-json');
    await assert.rejects(scanProjectLicenses(directory), /Could not read/);
    await writeFile(join(directory, 'package-lock.json'), JSON.stringify({ packages: [] }));
    await assert.rejects(scanProjectLicenses(directory), /does not contain npm package metadata/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('reads legacy package license arrays when lock metadata omits SPDX fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quizzer-legacy-license-test-'));
  try {
    await writeFile(join(directory, 'package-lock.json'), JSON.stringify({
      packages: { 'node_modules/legacy-license': { version: '1.0.0' } },
    }));
    await mkdir(join(directory, 'node_modules', 'legacy-license'), { recursive: true });
    await writeFile(join(directory, 'node_modules', 'legacy-license', 'package.json'), JSON.stringify({
      name: 'legacy-license', version: '1.0.0', licenses: [{ type: 'MIT' }, { type: 'MIT' }],
    }));
    const result = await scanProjectLicenses(directory);
    assert.deepEqual(result.licenses, { MIT: 1 });
    assert.deepEqual(result.violations, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('keeps build dependencies in the audit and normalizes reviewed legacy metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quizzer-build-license-test-'));
  try {
    await writeFile(join(directory, 'package-lock.json'), JSON.stringify({
      packages: {
        'node_modules/color-convert': { version: '0.5.3', dev: true },
        'node_modules/fsevents': { version: '2.3.3', dev: true, optional: true, os: ['darwin'] },
        'node_modules/stream-buffers': { version: '2.2.0', license: 'Unlicense', dev: true },
        'node_modules/unorm': { version: '1.6.0', license: 'MIT or GPL-2.0', dev: true },
      },
    }));
    const result = await scanProjectLicenses(directory);
    assert.equal(result.packages, 4);
    assert.deepEqual(result.licenses, { MIT: 3, Unlicense: 1 });
    assert.deepEqual(result.violations, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
