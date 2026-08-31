function terms(value: string): string[] {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}€$]+/u)
    .filter(Boolean);
}

export function findCitationSpanIndexes(spans: readonly string[], quote: string): number[] {
  const quoteTerms = terms(quote);
  if (!quoteTerms.length) return [];
  const pageTerms = spans.flatMap((span, spanIndex) =>
    terms(span).map((term) => ({ term, spanIndex })),
  );
  for (let start = 0; start <= pageTerms.length - quoteTerms.length; start += 1) {
    if (quoteTerms.every((term, offset) => pageTerms[start + offset]?.term === term)) {
      return Array.from(
        new Set(
          pageTerms.slice(start, start + quoteTerms.length).map(({ spanIndex }) => spanIndex),
        ),
      );
    }
  }
  return [];
}
