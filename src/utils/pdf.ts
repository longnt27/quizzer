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
