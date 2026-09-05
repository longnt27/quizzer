import { statfsSync } from 'node:fs';
import { arch, cpus, platform, totalmem } from 'node:os';

const round = value => Math.round(value * 10) / 10;

export const recommendHardwareProfile = ({ cpuCores, memoryGB, freeDiskGB }) => {
  if (cpuCores >= 12 && memoryGB >= 32 && freeDiskGB >= 50) return 'max';
  if (cpuCores >= 6 && memoryGB >= 12 && freeDiskGB >= 10) return 'balanced';
  return 'lite';
};

const profileReasons = ({ cpuCores, memoryGB, freeDiskGB }, recommendedProfile) => {
  if (recommendedProfile === 'max') {
    return [
      `${cpuCores} CPU cores support heavier extraction and reranking.`,
      `${memoryGB} GB memory is suitable for stronger local models.`,
      `${freeDiskGB} GB free space leaves room for model and index files.`,
    ];
  }
  if (recommendedProfile === 'balanced') {
    return [
      `${memoryGB} GB memory supports local embeddings and OCR on demand.`,
      `${cpuCores} CPU cores are suitable for hybrid retrieval.`,
      'Balanced avoids downloading large generation models by default.',
    ];
  }
  return [
    'Lite keeps dense models, OCR, and local generation optional.',
    `${memoryGB} GB memory and ${freeDiskGB} GB free space remain available for documents.`,
    'Remote APIs or signed-in agents handle generation by default.',
  ];
};

const detectAcceleration = () => {
  const detected = [];
  if (platform() === 'darwin' && arch() === 'arm64') detected.push('Apple Metal');
  if (process.env.CUDA_VISIBLE_DEVICES && process.env.CUDA_VISIBLE_DEVICES !== '-1') detected.push('NVIDIA CUDA');
  if (process.platform === 'win32') detected.push('Windows GPU (runtime check required)');
  return detected;
};

export const detectHardwareCapabilities = (dataDirectory = process.cwd()) => {
  const cpuCores = Math.max(1, cpus().length);
  const memoryGB = round(totalmem() / 1024 ** 3);
  let freeDiskGB = 0;
  try {
    const disk = statfsSync(dataDirectory);
    freeDiskGB = round(Number(disk.bavail) * Number(disk.bsize) / 1024 ** 3);
  } catch {
    // A missing disk metric must never prevent setup. Lite remains the safe recommendation.
  }
  const measurements = { cpuCores, memoryGB, freeDiskGB };
  const recommendedProfile = recommendHardwareProfile(measurements);
  return {
    platform: platform(),
    architecture: arch(),
    ...measurements,
    acceleration: detectAcceleration(),
    recommendedProfile,
    reasons: profileReasons(measurements, recommendedProfile),
  };
};
