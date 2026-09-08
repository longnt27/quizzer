import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);
const projectDirectory = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const version = '1.0.0-beta.1';
const targets = [
  ['macos', 'x64', 'zip'],
  ['macos', 'arm64', 'zip'],
  ['windows', 'x64', 'exe'],
  ['windows', 'arm64', 'exe'],
  ['linux', 'x64', 'zip'],
  ['linux', 'arm64', 'zip'],
];

const nodeScript = (script, args, options = {}) => execute(process.execPath, [script, ...args], {
  cwd: projectDirectory,
  ...options,
});

test('runs the signed shell-installer release pipeline for all six supported targets', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'quizzer-release-pipeline-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(directory, { recursive: true, force: true });
  });

  const collectedDirectory = join(directory, 'collected');
  for (const [platform, architecture, format] of targets) {
    const target = `${platform}-${architecture}`;
    const source = join(directory, 'builds', target);
    const cliDirectory = join(directory, 'cli', target);
    const cliName = platform === 'windows' ? 'quizzer.exe' : 'quizzer';
    await Promise.all([mkdir(source, { recursive: true }), mkdir(cliDirectory, { recursive: true })]);
    await Promise.all([
      writeFile(join(source, `Quizzer.${format}`), `desktop:${target}`),
      writeFile(join(cliDirectory, cliName), `cli:${target}`),
    ]);
    const { stdout } = await nodeScript('scripts/collect-release-artifacts.mjs', [
      '--source', source,
      '--cli', join(cliDirectory, cliName),
      '--output', join(collectedDirectory, target),
      '--platform', platform,
      '--architecture', architecture,
      '--version', version,
    ]);
    assert.match(stdout, /Collected 2 release artifacts/);
  }

  const bundle = join(directory, 'bundle');
  const merged = await nodeScript('scripts/merge-release-artifacts.mjs', [
    '--input', collectedDirectory,
    '--output', bundle,
  ]);
  assert.match(merged.stdout, /Merged 12 release artifacts/);
  const descriptors = JSON.parse(await readFile(join(bundle, 'artifacts.json'), 'utf8'));
  assert.equal(descriptors.length, 12);
  assert.deepEqual(
    [...new Set(descriptors.map(item => `${item.platform}/${item.architecture}`))].sort(),
    targets.map(([platform, architecture]) => `${platform}/${architecture}`).sort(),
  );
  assert.equal(descriptors.filter(item => item.cli).length, 6);

  const { privateKey } = generateKeyPairSync('ed25519');
  const privateKeyBase64 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const manifestPath = join(bundle, 'release-manifest.json');
  const signingEnvironment = { ...process.env, QUIZZER_RELEASE_PRIVATE_KEY: privateKeyBase64 };
  const generated = await nodeScript('scripts/generate-release-manifest.mjs', [
    '--version', version,
    '--channel', 'beta',
    '--artifacts', join(bundle, 'artifacts.json'),
    '--output', manifestPath,
    '--public-key-id', 'quizzer-release-pipeline-test',
  ], { env: signingEnvironment });
  assert.match(generated.stdout, /Signed 12 artifacts/);

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.artifacts.length, 12);
  for (const artifact of manifest.artifacts) {
    const bytes = await readFile(join(bundle, artifact.name));
    assert.equal(artifact.size, bytes.byteLength);
    assert.equal(artifact.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(artifact.url, `https://github.com/longnt27/quizzer/releases/download/v${version}/${artifact.name}`);
  }

  const prepared = join(directory, 'prepared');
  const installers = await nodeScript('scripts/prepare-release-installers.mjs', [
    '--manifest', manifestPath,
    '--output', prepared,
    '--apple-team-id', 'ABCDE12345',
    '--windows-certificate-sha256', 'A'.repeat(64),
  ], { env: signingEnvironment });
  assert.match(installers.stdout, /Prepared signed metadata and installers/);

  const publicKeyPath = join(prepared, 'release-public.pem');
  const publicKey = createPublicKey(privateKey).export({ format: 'pem', type: 'spki' });
  await writeFile(publicKeyPath, publicKey);
  const verified = await nodeScript('scripts/quizzer.mjs', [
    'release', 'verify',
    '--metadata', join(prepared, 'release-manifest.canonical.json'),
    '--signature', join(prepared, 'release-manifest.sig'),
    '--public-key', publicKeyPath,
    '--json',
  ], { env: { ...process.env, QUIZZER_APP_DATA_DIR: join(directory, 'app-data') } });
  assert.deepEqual(JSON.parse(verified.stdout), {
    valid: true,
    version,
    publicKeyId: 'quizzer-release-pipeline-test',
    artifacts: 12,
  });
  await execute('sh', ['-n', join(prepared, 'install.sh')]);
  const [shellInstaller, powershellInstaller] = await Promise.all([
    readFile(join(prepared, 'install.sh'), 'utf8'),
    readFile(join(prepared, 'install.ps1'), 'utf8'),
  ]);
  for (const placeholder of [
    '__QUIZZER_RELEASE_PUBLIC_KEY_PEM__',
    '__QUIZZER_RELEASE_BASE_URL__',
    '__QUIZZER_APPLE_TEAM_ID__',
    '__QUIZZER_WINDOWS_CERTIFICATE_SHA256__',
  ]) {
    assert.doesNotMatch(`${shellInstaller}\n${powershellInstaller}`, new RegExp(placeholder));
  }
});
