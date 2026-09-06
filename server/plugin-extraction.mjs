const pluginIdPattern = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/;
const imageMimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_DOCUMENT_BYTES = 250 * 1024 * 1024;
const MAX_EXTRACTED_CHARACTERS = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGES = 30;
const MAX_OCR_CHARACTERS = 100_000;

const unavailable = message => Object.assign(new Error(message), { code: 'provider_unavailable' });
const boundedText = (value, label, maximum, { optional = false } = {}) => {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > maximum) {
    throw new Error(`${label} must be ${optional ? 'a bounded string' : 'a non-empty bounded string'}`);
  }
  return value;
};

const scopedSourcePath = (name, fallback) => {
  const extension = /\.([A-Za-z0-9]{1,12})$/.exec(name ?? '')?.[1]?.toLowerCase();
  return `input/${fallback}${extension ? `.${extension}` : ''}`;
};

const readyPlugin = async (component, capability, loadManager) => {
  if (!pluginIdPattern.test(component ?? '') || typeof loadManager !== 'function') {
    throw unavailable(`${capability} plugin ${component} is not configured correctly`);
  }
  const manager = await loadManager();
  const plugin = (await manager.list()).find(item => item.id === component);
  if (!plugin || plugin.status !== 'installed' || !plugin.enabled || !plugin.compatible
    || !plugin.capabilities?.includes(capability)) {
    throw unavailable(`${capability} plugin ${component} is not installed, enabled, and compatible`);
  }
  if (!plugin.permissions?.filesystem?.includes('scoped-temp')
    || !plugin.permissions.filesystem.includes('document-read')) {
    throw unavailable(`${capability} plugin ${component} must declare scoped-temp and document-read permissions`);
  }
  return { manager, plugin };
};

const validateImage = (image, index) => {
  if (!image || typeof image !== 'object' || Array.isArray(image)) {
    throw new Error(`Extractor plugin image ${index + 1} is invalid`);
  }
  const name = boundedText(image.name, `Extractor plugin image ${index + 1} name`, 1024);
  if (!imageMimeTypes.has(image.mimeType)) {
    throw new Error(`Extractor plugin image ${index + 1} has an unsupported MIME type`);
  }
  if (typeof image.data !== 'string' || image.data.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) {
    throw new Error(`Extractor plugin image ${index + 1} has invalid base64 data`);
  }
  const data = Buffer.from(image.data, 'base64');
  if (!data.length || data.length > MAX_IMAGE_BYTES) {
    throw new Error(`Extractor plugin image ${index + 1} exceeds the bounded image size`);
  }
  if (image.page !== undefined && (!Number.isSafeInteger(image.page) || image.page < 1 || image.page > 1_000_000)) {
    throw new Error(`Extractor plugin image ${index + 1} has an invalid page`);
  }
  if (image.sourceStart !== undefined && (!Number.isSafeInteger(image.sourceStart) || image.sourceStart < 0)) {
    throw new Error(`Extractor plugin image ${index + 1} has an invalid sourceStart`);
  }
  return {
    id: typeof image.id === 'string' && image.id.length <= 200 ? image.id : `image-${index}`,
    name,
    mimeType: image.mimeType,
    data: image.data,
    ...(image.page === undefined ? {} : { page: image.page }),
    ...(image.sourceStart === undefined ? {} : { sourceStart: image.sourceStart }),
    ...(boundedText(image.caption, `Extractor plugin image ${index + 1} caption`, 10_000, { optional: true }) === undefined ? {} : { caption: image.caption }),
    ...(boundedText(image.context, `Extractor plugin image ${index + 1} context`, 20_000, { optional: true }) === undefined ? {} : { context: image.context }),
    ...(boundedText(image.ocrText, `Extractor plugin image ${index + 1} OCR text`, MAX_OCR_CHARACTERS, { optional: true }) === undefined ? {} : { ocrText: image.ocrText }),
    byteLength: data.length,
  };
};

export const validatePluginExtraction = (result, plugin) => {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('Extractor plugin returned an invalid result envelope');
  }
  const content = boundedText(result.content, 'Extractor plugin content', MAX_EXTRACTED_CHARACTERS);
  if (result.pageCount !== undefined
    && (!Number.isSafeInteger(result.pageCount) || result.pageCount < 1 || result.pageCount > 1_000_000)) {
    throw new Error('Extractor plugin returned an invalid page count');
  }
  if (result.images !== undefined && (!Array.isArray(result.images) || result.images.length > MAX_IMAGES)) {
    throw new Error(`Extractor plugin images must be an array of at most ${MAX_IMAGES} items`);
  }
  const validatedImages = (result.images ?? []).map(validateImage);
  if (validatedImages.reduce((total, image) => total + image.byteLength, 0) > MAX_TOTAL_IMAGE_BYTES) {
    throw new Error('Extractor plugin images exceed the total output limit');
  }
  const parserDetail = boundedText(result.parserVersion, 'Extractor plugin parserVersion', 100, { optional: true });
  return {
    content,
    ...(result.pageCount === undefined ? {} : { pageCount: result.pageCount }),
    ...(validatedImages.length ? { images: validatedImages.map(({ byteLength: _byteLength, ...image }) => image) } : {}),
    parserVersion: `plugin:${plugin.id}@${plugin.version}${parserDetail ? `/${parserDetail}` : ''}`,
    extractor: plugin.id,
  };
};

export const validatePluginOcr = result => {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('OCR plugin returned an invalid result envelope');
  }
  return boundedText(result.text, 'OCR plugin text', MAX_OCR_CHARACTERS, { optional: true }) ?? '';
};

export const resolveDocumentExtractor = async (settings, { loadManager } = {}) => {
  const component = settings?.values?.['extraction.extractorPlugin'] ?? 'builtin';
  if (component === 'builtin') return { component, identity: 'builtin', extract: undefined };
  const { manager, plugin } = await readyPlugin(component, 'extractor', loadManager);
  return {
    component,
    identity: `plugin:${component}@${plugin.version}`,
    extract: async (data, { name = 'document', mimeType = 'application/octet-stream', signal } = {}) => {
      if (!Buffer.isBuffer(data) && !(data instanceof Uint8Array)) throw new Error('Extractor plugin document must be binary');
      const source = Buffer.from(data);
      if (!source.length || source.length > MAX_DOCUMENT_BYTES) throw new Error('Extractor plugin document exceeds the 250 MB limit');
      boundedText(name, 'Extractor plugin document name', 1024);
      boundedText(mimeType, 'Extractor plugin document MIME type', 255);
      const path = scopedSourcePath(name, 'document');
      let invocation;
      try {
        invocation = await manager.invoke(component, 'document.extract', {
          document: { path, name, mimeType, size: source.length },
        }, {
          signal,
          timeoutMs: 10 * 60_000,
          files: [{ path, data: source }],
          fileLimits: { maximumFiles: 1, maximumFileBytes: MAX_DOCUMENT_BYTES, maximumTotalBytes: MAX_DOCUMENT_BYTES },
        });
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw error;
        throw unavailable(`Extractor plugin ${component} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        return validatePluginExtraction(invocation?.result, plugin);
      } catch (error) {
        throw unavailable(`Extractor plugin ${component} returned unsafe output: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
};

export const resolveOcrProvider = async (settings, { loadManager, builtin } = {}) => {
  const component = settings?.values?.['extraction.ocrPlugin'] ?? 'builtin';
  if (component === 'builtin') return { component, identity: 'builtin', ocr: builtin };
  const { manager, plugin } = await readyPlugin(component, 'ocr', loadManager);
  return {
    component,
    identity: `plugin:${component}@${plugin.version}`,
    ocr: async (data, { name = 'image.png', mimeType = 'image/png', signal } = {}) => {
      if (!Buffer.isBuffer(data) && !(data instanceof Uint8Array)) throw new Error('OCR plugin image must be binary');
      const source = Buffer.from(data);
      if (!source.length || source.length > MAX_IMAGE_BYTES) throw new Error('OCR plugin image exceeds the bounded image size');
      if (!imageMimeTypes.has(mimeType)) throw new Error('OCR plugin image has an unsupported MIME type');
      boundedText(name, 'OCR plugin image name', 1024);
      const path = scopedSourcePath(name, 'image');
      let invocation;
      try {
        invocation = await manager.invoke(component, 'document.ocr', {
          image: { path, name, mimeType, size: source.length },
        }, {
          signal,
          timeoutMs: 90_000,
          files: [{ path, data: source }],
        });
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw error;
        throw unavailable(`OCR plugin ${component} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        return validatePluginOcr(invocation?.result);
      } catch (error) {
        throw unavailable(`OCR plugin ${component} returned unsafe output: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
};
