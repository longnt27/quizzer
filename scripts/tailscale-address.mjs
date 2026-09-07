import { execFileSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';

export const isTailscaleIPv4 = address => {
  const octets = typeof address === 'string' ? address.split('.').map(Number) : undefined;
  return octets?.length === 4
    && octets.every(octet => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
};

export const findTailscaleAddress = ({ run = execFileSync, interfaces = networkInterfaces() } = {}) => {
  try {
    const output = run('tailscale', ['ip', '-4'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const address = output.split(/\r?\n/).map(value => value.trim()).find(isTailscaleIPv4);
    if (address) return address;
  } catch { /* Fall back to the operating system's network interfaces. */ }
  for (const addresses of Object.values(interfaces)) {
    const address = addresses?.find(item => item.family === 'IPv4' && isTailscaleIPv4(item.address));
    if (address) return address.address;
  }
};
