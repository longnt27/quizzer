import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

const formats = new Map([['.zip', 'zip'], ['.exe', 'exe'], ['.deb', 'deb'], ['.rpm', 'rpm']]);
const minimumOs = { macos: 'macOS 13', windows: 'Windows 10 x64 / Windows 11 arm64', linux: 'Current 64-bit Ubuntu or Fedora' };

const filesBelow = async directory => {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory()
    ? filesBelow(join(directory, entry.name))
    : [join(directory, entry.name)]))).flat();
};

export const collectDesktopArtifacts = async ({ sourceDirectory, outputDirectory, platform, architecture, version }) => {
  if (!minimumOs[platform] || (architecture !== 'x64' && architecture !== 'arm64')) throw new Error('Unsupported release target');
  const candidates = (await filesBelow(sourceDirectory)).filter(path => formats.has(extname(path).toLowerCase()));
  if (!candidates.length) throw new Error(`No supported release artifacts found in ${sourceDirectory}`);
  await mkdir(outputDirectory, { recursive: true });
  const artifacts = [];
  const seen = new Set();
  for (const path of candidates) {
    const extension = extname(path).toLowerCase();
    const format = formats.get(extension);
    const name = `quizzer-${version}-${platform}-${architecture}.${format}`;
    if (seen.has(name)) throw new Error(`Multiple ${format} artifacts were produced for ${platform}/${architecture}`);
    seen.add(name);
    const destination = join(outputDirectory, name);
    await copyFile(path, destination);
    artifacts.push({ path: destination, name, platform, architecture, format, minimumOs: minimumOs[platform] });
  }
  const descriptorPath = join(outputDirectory, `artifacts-${platform}-${architecture}.json`);
  await writeFile(descriptorPath, `${JSON.stringify(artifacts, null, 2)}\n`);
  return { artifacts, descriptorPath };
};

export const mergeDesktopArtifacts = async ({ inputDirectory, outputDirectory }) => {
  const files = await filesBelow(inputDirectory);
  const descriptorPaths = files.filter(path => /^artifacts-(?:macos|windows|linux)-(?:x64|arm64)\.json$/.test(basename(path)));
  if (!descriptorPaths.length) throw new Error('No release artifact descriptors were downloaded');
  await mkdir(outputDirectory, { recursive: true });
  const descriptors = (await Promise.all(descriptorPaths.map(path => readFile(path, 'utf8').then(JSON.parse)))).flat();
  const merged = [];
  const seen = new Set();
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.name)) throw new Error(`Duplicate release artifact: ${descriptor.name}`);
    const matches = files.filter(path => basename(path) === descriptor.name);
    if (matches.length !== 1) throw new Error(`Expected exactly one downloaded ${descriptor.name}, found ${matches.length}`);
    seen.add(descriptor.name);
    const path = join(outputDirectory, descriptor.name);
    await copyFile(matches[0], path);
    merged.push({ ...descriptor, path });
  }
  const descriptorPath = join(outputDirectory, 'artifacts.json');
  await writeFile(descriptorPath, `${JSON.stringify(merged, null, 2)}\n`);
  return { artifacts: merged, descriptorPath };
};
