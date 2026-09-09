export const SUPPORTED_CHANNELS = Object.freeze(['stable', 'beta']);

export const validateUpdaterChannel = channel => {
  if (channel !== 'stable' && channel !== 'beta') {
    throw new Error('Channel must be stable or beta');
  }
  return channel;
};

export const validateUpdaterCheckOptions = options => {
  if (options === undefined) return {};
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new Error('Invalid options for updater:check');
  }
  const allowedKeys = new Set(['channel', 'preferredFormat', 'force']);
  for (const key of Object.keys(options)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unknown option "${key}" for updater:check`);
    }
  }
  const validated = {};
  if (options.channel !== undefined) {
    validated.channel = validateUpdaterChannel(options.channel);
  }
  if (options.preferredFormat !== undefined) {
    if (typeof options.preferredFormat !== 'string' || !options.preferredFormat.trim()) {
      throw new Error('preferredFormat must be a non-empty string');
    }
    validated.preferredFormat = options.preferredFormat.trim();
  }
  if (options.force !== undefined) {
    if (typeof options.force !== 'boolean') {
      throw new Error('force must be a boolean');
    }
    validated.force = options.force;
  }
  return validated;
};

export const validateUpdaterApplyOptions = options => {
  if (options === undefined) return {};
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new Error('Invalid options for updater:apply');
  }
  const allowedKeys = new Set(['restart']);
  for (const key of Object.keys(options)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unknown option "${key}" for updater:apply`);
    }
  }
  const validated = {};
  if (options.restart !== undefined) {
    if (typeof options.restart !== 'boolean') {
      throw new Error('restart must be a boolean');
    }
    validated.restart = options.restart;
  }
  return validated;
};

export const validateAutoDownloadPreference = enabled => {
  if (typeof enabled !== 'boolean') {
    throw new Error('autoDownload must be a boolean');
  }
  return enabled;
};
