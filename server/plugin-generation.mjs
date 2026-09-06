const pluginIdPattern = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/;
const imagePattern = /^data:(image\/(png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/;
const extensions = Object.freeze({ png: 'png', jpeg: 'jpg', webp: 'webp', gif: 'gif' });

const unavailable = message => Object.assign(new Error(message), { code: 'provider_unavailable' });

export const generatorPluginAttachments = images => {
  if (!Array.isArray(images) || images.length > 6) throw new Error('Generator plugin images must be an array of at most 6 items');
  return images.map((image, index) => {
    const match = imagePattern.exec(image);
    if (!match) throw new Error('Generator plugin received an unsupported image payload');
    const path = `images/source-${index + 1}.${extensions[match[2]]}`;
    return {
      reference: { path, mimeType: match[1] },
      file: { path, data: Buffer.from(match[3], 'base64') },
    };
  });
};

export const runGeneratorPlugin = async ({ prompt, schema, model, images = [] }, signal, { loadManager }) => {
  if (!pluginIdPattern.test(model ?? '')) throw unavailable('A generator plugin id is required');
  if (typeof loadManager !== 'function') throw new Error('Generator plugin manager is unavailable');
  const manager = await loadManager();
  const plugin = (await manager.list()).find(item => item.id === model);
  if (!plugin || plugin.status !== 'installed' || !plugin.enabled || !plugin.compatible
    || !plugin.capabilities?.includes('generator')) {
    throw unavailable(`Generator plugin ${model} is not installed, enabled, and compatible`);
  }
  const attachments = generatorPluginAttachments(images);
  if (attachments.length && !plugin.permissions?.filesystem?.includes('scoped-temp')) {
    throw unavailable(`Generator plugin ${model} must declare scoped-temp permission for source images`);
  }
  let invocation;
  try {
    invocation = await manager.invoke(model, 'generation.generate', {
      prompt,
      schema,
      images: attachments.map(item => item.reference),
    }, {
      signal,
      timeoutMs: 5 * 60_000,
      files: attachments.map(item => item.file),
    });
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw error;
    throw unavailable(`Generator plugin ${model} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const output = invocation?.result?.output;
  if (typeof output !== 'string' || !output.trim() || output.length > 10 * 1024 * 1024) {
    throw unavailable(`Generator plugin ${model} returned an invalid output envelope`);
  }
  return output;
};

