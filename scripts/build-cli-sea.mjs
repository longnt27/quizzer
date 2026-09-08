import { execFile } from 'node:child_process';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { seaLanceDbPlugin } from './sea-lancedb-plugin.mjs';

const execFileAsync = promisify(execFile);
const projectDirectory = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const executableName = process.platform === 'win32' ? 'quizzer.exe' : 'quizzer';
const outputArgument = process.argv.indexOf('--output');
const outputPath = resolve(projectDirectory, outputArgument >= 0 ? process.argv[outputArgument + 1] : join('out', 'cli', executableName));
const buildDirectory = join(projectDirectory, 'out', 'sea-build');
const bundlePath = join(buildDirectory, 'quizzer-bundle.mjs');
const configPath = join(buildDirectory, 'sea-config.json');
const betterSqliteEntry = require.resolve('better-sqlite3');
const betterSqliteAddon = resolve(dirname(betterSqliteEntry), '..', 'build', 'Release', 'better_sqlite3.node');
const lanceDbTarget = process.platform === 'darwin'
  ? `@lancedb/lancedb-darwin-${process.arch}`
  : process.platform === 'win32'
    ? `@lancedb/lancedb-win32-${process.arch}-msvc`
    : `@lancedb/lancedb-linux-${process.arch}-gnu`;
const lanceDbAddon = require.resolve(lanceDbTarget);

const [major] = process.versions.node.split('.').map(Number);
if (major < 26) throw new Error('Building the Quizzer executable requires Node.js 26 or newer');
if (outputArgument >= 0 && !process.argv[outputArgument + 1]) throw new Error('--output requires a path');

try {
  const { default: Database } = await import('better-sqlite3');
  const database = new Database(':memory:');
  database.prepare('SELECT 1').get();
  database.close();
} catch (error) {
  throw new Error(`better-sqlite3 must be installed for Node ${process.versions.node} before building the CLI: ${error.message}`);
}

await rm(buildDirectory, { recursive: true, force: true });
await mkdir(buildDirectory, { recursive: true });
await mkdir(dirname(outputPath), { recursive: true });

await build({
  entryPoints: [join(projectDirectory, 'scripts', 'quizzer.mjs')],
  outfile: bundlePath,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: `node${major}`,
  sourcemap: false,
  minify: false,
  logLevel: 'info',
  banner: {
    js: "import { createRequire as __quizzerCreateRequire } from 'node:module'; const require = __quizzerCreateRequire(import.meta.url);",
  },
  plugins: [{
    name: 'quizzer-embedded-sqlite',
    setup(buildContext) {
      buildContext.onResolve({ filter: /^better-sqlite3$/ }, () => ({
        path: join(projectDirectory, 'scripts', 'sea-better-sqlite3.mjs'),
      }));
    },
  }, seaLanceDbPlugin(projectDirectory)],
});

await writeFile(configPath, `${JSON.stringify({
  main: bundlePath,
  mainFormat: 'module',
  output: outputPath,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  execArgvExtension: 'none',
  assets: {
    'better_sqlite3.node': betterSqliteAddon,
    'lancedb.node': lanceDbAddon,
    'openapi/quizzer-v1.yaml': join(projectDirectory, 'openapi', 'quizzer-v1.yaml'),
    'package.json': join(projectDirectory, 'package.json'),
    'plugin-sdk/quizzer.plugin.schema.json': join(projectDirectory, 'plugin-sdk', 'quizzer.plugin.schema.json'),
    'scripts/ocr_image.py': join(projectDirectory, 'scripts', 'ocr_image.py'),
  },
}, null, 2)}\n`);

await execFileAsync(process.execPath, ['--build-sea', configPath], { cwd: projectDirectory });
if (process.platform !== 'win32') await chmod(outputPath, 0o755);
if (process.platform === 'darwin') {
  const identity = process.env.APPLE_IDENTITY || '-';
  const signingArguments = ['--force', '--sign', identity];
  if (identity !== '-') signingArguments.push('--options', 'runtime', '--timestamp');
  signingArguments.push(outputPath);
  await execFileAsync('codesign', signingArguments);
  await execFileAsync('codesign', ['--verify', '--strict', outputPath]);
} else if (process.platform === 'win32' && process.env.WINDOWS_CERTIFICATE_FILE) {
  const { sign } = await import('@electron/windows-sign');
  await sign({
    files: [outputPath],
    certificateFile: process.env.WINDOWS_CERTIFICATE_FILE,
    certificatePassword: process.env.WINDOWS_CERTIFICATE_PASSWORD,
    hashes: ['sha256'],
    description: 'Quizzer',
    website: 'https://github.com/longnt27/quizzer',
  });
}
process.stdout.write(`Built Quizzer CLI ${outputPath}\n`);
