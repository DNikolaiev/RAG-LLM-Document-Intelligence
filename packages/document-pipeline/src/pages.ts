import {
  ok,
  type DocumentTextProvider,
  type OcrProvider,
  type ProviderResult,
  type TextPage,
} from '@caselens/providers';

export interface ProcessedPage extends TextPage {
  strategy: 'native' | 'ocr' | 'blank';
  warnings: string[];
  quality: number;
}
export interface PageProcessingOptions {
  minNativeCharacters: number;
  minNativeQuality: number;
  languageHints: readonly string[];
}

export function scoreNativeText(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const printable =
    [...trimmed].filter((character) => /[\p{L}\p{N}\p{P}\p{Z}]/u.test(character)).length /
    [...trimmed].length;
  const words = trimmed.match(/[\p{L}\p{N}]{2,}/gu)?.length ?? 0;
  const replacementPenalty = (trimmed.match(/�/g)?.length ?? 0) / trimmed.length;
  return Math.max(
    0,
    Math.min(1, printable * 0.65 + Math.min(words / 20, 1) * 0.35 - replacementPenalty),
  );
}

export async function processPages(
  input: Uint8Array,
  mediaType: string,
  textProvider: DocumentTextProvider,
  ocrProvider: OcrProvider,
  options: PageProcessingOptions,
): Promise<ProviderResult<ProcessedPage[]>> {
  const native = await textProvider.extract(input, mediaType);
  if (!native.ok) return native;
  const output: ProcessedPage[] = [];
  for (const page of native.value) {
    const quality = scoreNativeText(page.text);
    if (
      page.text.trim().length >= options.minNativeCharacters &&
      quality >= options.minNativeQuality
    ) {
      output.push({
        ...page,
        strategy: 'native',
        quality,
        warnings: page.rotation ? [`Page is rotated ${page.rotation} degrees.`] : [],
      });
      continue;
    }
    const ocr = await ocrProvider.recognize(input, {
      page: page.page,
      rotation: page.rotation,
      languageHints: options.languageHints,
    });
    if (ocr.ok && ocr.value.text.trim()) {
      output.push({
        ...ocr.value,
        strategy: 'ocr',
        quality: scoreNativeText(ocr.value.text),
        warnings: [
          'Native text quality was insufficient; OCR was used.',
          ...(ocr.value.rotation ? [`OCR detected ${ocr.value.rotation}-degree orientation.`] : []),
        ],
      });
    } else {
      output.push({
        ...page,
        strategy: 'blank',
        quality,
        confidence: 0,
        warnings: ['No usable text was extracted from this page.'],
      });
    }
  }
  return ok(output, native.meta);
}
