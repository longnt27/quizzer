import { win32 as windowsPath } from 'node:path';

export const isWindowsPlatform = platform => platform === 'win32';

export const spawnOptionsForPlatform = platform => ({
  detached: !isWindowsPlatform(platform),
  windowsHide: isWindowsPlatform(platform),
});

export const electronExecutableFromPackage = requireElectron => {
  const executable = requireElectron();
  if (typeof executable !== 'string' || !executable || executable.toLowerCase().endsWith('.cmd')) {
    throw new Error('The electron package must resolve to a native Electron executable, not a command shim');
  }
  return executable;
};

export const playwrightCommandForPlatform = ({
  platform,
  nodeExecutable,
  projectDirectory,
  useXvfb = false,
}) => {
  const args = [
    'node_modules/@playwright/test/cli.js',
    'test',
    '--config=playwright.electron.config.ts',
  ];
  if (platform === 'linux' && useXvfb) {
    return {
      command: 'xvfb-run',
      args: ['--auto-servernum', '--server-args=-screen 0 1280x720x24', nodeExecutable, ...args],
      cwd: projectDirectory,
    };
  }
  return { command: nodeExecutable, args, cwd: projectDirectory };
};

export const terminationPlanForPlatform = ({ platform, pid, force = false, systemRoot }) => {
  if (isWindowsPlatform(platform)) {
    const taskkill = systemRoot ? windowsPath.join(systemRoot, 'System32', 'taskkill.exe') : 'taskkill.exe';
    return {
      command: taskkill,
      args: ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])],
    };
  }
  return { signal: force ? 'SIGKILL' : 'SIGTERM', processGroup: -pid };
};
