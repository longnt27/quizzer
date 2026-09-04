import * as pdfjsLib from 'pdfjs-dist';

// This is where the real magic happens:
pdfjsLib.GlobalWorkerOptions.workerSrc = `/node_modules/pdfjs-dist/build/pdf.worker.min.mjs`;

export interface ExtractedPdf {
  content: string;
  pageCount: number;
}

export const extractPdf = async (file: File): Promise<ExtractedPdf> => {
  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  const pdf = await loadingTask.promise;

  let fullText = '';
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const strings = content.items.map(item => 'str' in item ? item.str : '');
    fullText += `\n\n--- Page ${pageNum} ---\n\n${strings.join(' ')}`;
  }
  return { content: fullText.trim(), pageCount: pdf.numPages };
};

export const extractTextFromPdf = async (file: File): Promise<string> =>
  (await extractPdf(file)).content;

export interface PdfSourcePreview {
  kind: 'slides' | 'document';
  page?: number;
  imageUrl?: string;
}

const pdfCache = new WeakMap<Blob, ReturnType<typeof pdfjsLib.getDocument>['promise']>();
const kindCache = new WeakMap<Blob, Promise<'slides' | 'document'>>();

const openPdf = (file: Blob) => {
  let cached = pdfCache.get(file);
  if (!cached) {
    cached = file.arrayBuffer().then(data => pdfjsLib.getDocument({ data }).promise);
    pdfCache.set(file, cached);
  }
  return cached;
};

const classifyPdf = (file: Blob) => {
  let cached = kindCache.get(file);
  if (!cached) {
    cached = openPdf(file).then(async pdf => {
      const count = Math.min(5, pdf.numPages);
      let landscape = 0;
      let sparseWide = 0;
      for (let index = 0; index < count; index++) {
        const pageNumber = count === 1 ? 1 : Math.round(1 + index * (pdf.numPages - 1) / (count - 1));
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1 });
        const text = await page.getTextContent();
        const characters = text.items.reduce((total, item) => total + ('str' in item ? item.str.length : 0), 0);
        const ratio = viewport.width / viewport.height;
        if (ratio >= 1.15) landscape++;
        if (ratio >= 0.95 && characters < 900) sparseWide++;
      }
      return landscape / count >= 0.6 || sparseWide / count >= 0.8 ? 'slides' : 'document';
    });
    kindCache.set(file, cached);
  }
  return cached;
};

const locatePage = async (file: Blob, excerpt: string) => {
  const pdf = await openPdf(file);
  const queryTokens = [...new Set(excerpt.toLocaleLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [])].slice(0, 80);
  if (!queryTokens.length) return undefined;
  let bestPage: number | undefined;
  let bestScore = 0;
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items.map(item => 'str' in item ? item.str : '').join(' ').toLocaleLowerCase();
    const score = queryTokens.reduce((total, token) => total + (text.includes(token) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      bestPage = pageNumber;
    }
  }
  return bestScore >= Math.min(4, Math.ceil(queryTokens.length * 0.15)) ? bestPage : undefined;
};

export const getPdfSourcePreview = async (file: Blob, page: number | undefined, excerpt = ''): Promise<PdfSourcePreview> => {
  const kind = await classifyPdf(file);
  if (kind === 'document') return { kind };
  const pdf = await openPdf(file);
  const resolvedPage = page && page >= 1 && page <= pdf.numPages ? page : await locatePage(file, excerpt);
  if (!resolvedPage) return { kind };
  const sourcePage = await pdf.getPage(resolvedPage);
  const natural = sourcePage.getViewport({ scale: 1 });
  const viewport = sourcePage.getViewport({ scale: 900 / natural.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const canvasContext = canvas.getContext('2d');
  if (!canvasContext) return { kind, page: resolvedPage };
  await sourcePage.render({ canvasContext, viewport }).promise;
  return { kind, page: resolvedPage, imageUrl: canvas.toDataURL('image/jpeg', 0.88) };
};
