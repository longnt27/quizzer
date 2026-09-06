import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { prepareReleaseInstallers } from '../release/installers.mjs';
import { buildReleaseManifest, canonicalizeManifest, privateKeyFromBase64, signReleaseManifest } from '../release/manifest.mjs';

const execute = promisify(execFile);

test('renders installers with the signing key and exact verifiable release metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quizzer-installers-'));
  try {
    const artifactPath = join(directory, 'quizzer-cli');
    const manifestPath = join(directory, 'release-manifest.json');
    const outputDirectory = join(directory, 'output');
    await writeFile(artifactPath, 'standalone cli');
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privateKeyBase64 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
    const manifest = await buildReleaseManifest({
      version: '1.0.0-beta.1',
      channel: 'beta',
      publishedAt: '2026-09-05T00:00:00.000Z',
      publicKeyId: 'quizzer-release-test',
      releaseUrl: 'https://github.com/Somethings1/quizzer/releases/download/v1.0.0-beta.1',
      artifacts: [{
        path: artifactPath, name: 'quizzer-cli-1.0.0-beta.1-linux-x64',
        platform: 'linux', architecture: 'x64', format: 'sea', cli: true,
        minimumOs: 'Current 64-bit Ubuntu or Fedora',
      }],
    });
    const signed = signReleaseManifest(manifest, privateKeyFromBase64(privateKeyBase64));
    await writeFile(manifestPath, JSON.stringify(signed));
    const result = await prepareReleaseInstallers({
      manifestPath,
      privateKeyBase64,
      outputDirectory,
      shellTemplatePath: new URL('../installers/install.sh.in', import.meta.url),
      powershellTemplatePath: new URL('../installers/install.ps1.in', import.meta.url),
      appleTeamId: 'ABCDE12345',
      windowsCertificateSha256: 'ab '.repeat(31) + 'ab',
    });

    const metadata = await readFile(result.metadata);
    const signature = await readFile(result.signature);
    assert.equal(metadata.toString(), canonicalizeManifest(signed));
    assert.equal(verify(null, metadata, publicKey, signature), true);
    const shell = await readFile(result.shell, 'utf8');
    const powershell = await readFile(result.powershell, 'utf8');
    assert.doesNotMatch(shell, /__QUIZZER_RELEASE_PUBLIC_KEY_PEM__/);
    assert.doesNotMatch(powershell, /__QUIZZER_RELEASE_PUBLIC_KEY_PEM__/);
    assert.doesNotMatch(shell, /__QUIZZER_RELEASE_BASE_URL__/);
    assert.doesNotMatch(powershell, /__QUIZZER_RELEASE_BASE_URL__/);
    assert.doesNotMatch(shell, /__QUIZZER_APPLE_TEAM_ID__/);
    assert.doesNotMatch(powershell, /__QUIZZER_WINDOWS_CERTIFICATE_SHA256__/);
    assert.match(shell, /BEGIN PUBLIC KEY/);
    assert.match(powershell, /BEGIN PUBLIC KEY/);
    assert.match(shell, /releases\/download\/v1\.0\.0-beta\.1/);
    assert.match(powershell, /releases\/download\/v1\.0\.0-beta\.1/);
    assert.match(shell, /expected_apple_team_id='ABCDE12345'/);
    assert.match(shell, /TeamIdentifier/);
    assert.match(powershell, /ExpectedCertificateSha256 = 'ABAB/);
    assert.match(powershell, /SignerCertificate\.RawData/);
    assert.ok(shell.indexOf('cli_team_id=') < shell.indexOf('"$cli_download" release verify'));
    assert.ok(powershell.indexOf('Assert-Authenticode $CliDownload') < powershell.indexOf('& $CliDownload release verify'));
    assert.equal((await stat(result.shell)).mode & 0o777, 0o755);
    await execute('sh', ['-n', result.shell]);
    if (process.platform === 'linux') {
      const installerPublicKeyPath = join(outputDirectory, 'installer-test-public.pem');
      await writeFile(installerPublicKeyPath, result.publicKeyPem);
      await execute('openssl', [
        'pkeyutl', '-verify', '-pubin', '-inkey', installerPublicKeyPath,
        '-rawin', '-in', result.metadata, '-sigfile', result.signature,
      ]);
    }

    const unrelatedKey = generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
    await assert.rejects(prepareReleaseInstallers({
      manifestPath,
      privateKeyBase64: unrelatedKey,
      outputDirectory: join(directory, 'rejected'),
      shellTemplatePath: new URL('../installers/install.sh.in', import.meta.url),
      powershellTemplatePath: new URL('../installers/install.ps1.in', import.meta.url),
      appleTeamId: 'ABCDE12345',
      windowsCertificateSha256: 'A'.repeat(64),
    }), /not signed by the supplied release key/);

    for (const pins of [
      { appleTeamId: '', windowsCertificateSha256: 'A'.repeat(64), error: /APPLE_TEAM_ID/ },
      { appleTeamId: 'lowercase1', windowsCertificateSha256: 'A'.repeat(64), error: /APPLE_TEAM_ID/ },
      { appleTeamId: 'ABCDE12345', windowsCertificateSha256: '', error: /CERTIFICATE_SHA256/ },
      { appleTeamId: 'ABCDE12345', windowsCertificateSha256: 'A'.repeat(40), error: /CERTIFICATE_SHA256/ },
    ]) {
      await assert.rejects(prepareReleaseInstallers({
        manifestPath,
        privateKeyBase64,
        outputDirectory: join(directory, 'invalid-pins'),
        shellTemplatePath: new URL('../installers/install.sh.in', import.meta.url),
        powershellTemplatePath: new URL('../installers/install.ps1.in', import.meta.url),
        appleTeamId: pins.appleTeamId,
        windowsCertificateSha256: pins.windowsCertificateSha256,
      }), pins.error);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
