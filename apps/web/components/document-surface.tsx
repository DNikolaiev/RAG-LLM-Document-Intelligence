'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileText,
  Minus,
  Plus,
  ScanText,
} from 'lucide-react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

import type { CaseDocument, EvidenceAnchor } from '@/lib/demo-data';
import { findCitationSpanIndexes } from '@/lib/citation-matching';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

type ViewerMode = 'original' | 'extracted';
type PdfProxy = {
  getPage(page: number): Promise<{
    getTextContent(): Promise<{
      items: Array<{ str?: string; transform?: number[]; width?: number; height?: number }>;
    }>;
    getViewport(input: { scale: number }): { width: number; height: number };
  }>;
};

interface CitationHighlight {
  left: string;
  top: string;
  width: string;
  height: string;
}

const documentCopy: Record<string, { heading: string; lines: string[] }> = {
  questionnaire: {
    heading: 'Supplier Qualification Questionnaire',
    lines: [
      'Organisation: MediSupply GmbH',
      'Registered office: Düsseldorf, Germany',
      'Scope: Storage and distribution of temperature-controlled medicinal products',
      'Good Distribution Practice certificate: pending renewal.',
      'Supporting document will be provided separately.',
    ],
  },
  register: {
    heading: 'Handelsregister B · Current extract',
    lines: [
      'Amtsgericht Düsseldorf',
      'Firma: MediSupply GmbH',
      'Sitz: Düsseldorf · HRB 92831',
      'Gegenstand: Großhandel mit pharmazeutischen Erzeugnissen',
      'Vertretungsberechtigt: Dr. Klara Rehm',
    ],
  },
  insurance: {
    heading: 'Certificate of Liability Insurance',
    lines: [
      'Policyholder: MediSupply GmbH',
      'Policy number: HDI-PH-884210',
      'Public and product liability: EUR 1,000,000 per occurrence',
      'Aggregate annual limit: EUR 2,000,000',
      'Period of cover: 01 January 2026 to 31 December 2026',
    ],
  },
  contract: {
    heading: 'Pharmaceutical Supply Agreement',
    lines: [
      'Effective date: 15 August 2026',
      'This Supply Agreement is entered into by MediSupply Europe GmbH (‘Supplier’).',
      'and Northstar Online Apotheke GmbH (‘Customer’).',
      'Supplier will maintain controlled distribution conditions.',
      'Applicable law: Federal Republic of Germany',
    ],
  },
  iso: {
    heading: 'Certificate of Registration',
    lines: [
      'MediSupply GmbH',
      'Quality management system certified to ISO 13485:2016',
      'Scope: Distribution and controlled storage of medical devices',
      'Certificate valid until 18 November 2027',
      'Certification body: Q-Audit Europe GmbH',
    ],
  },
};

export function DocumentSurface({
  document,
  evidence,
  selectedEvidence,
  page,
  onPageChange,
}: {
  document: CaseDocument;
  evidence: EvidenceAnchor[];
  selectedEvidence?: EvidenceAnchor | undefined;
  page: number;
  onPageChange: (page: number) => void;
}) {
  const [zoom, setZoom] = useState(100);
  const canRenderOriginal = Boolean(document.sourceUrl && /\.pdf$/i.test(document.fileName));
  const [mode, setMode] = useState<ViewerMode>(canRenderOriginal ? 'original' : 'extracted');
  const [pageCount, setPageCount] = useState(Math.max(1, document.pages));
  const [loadFailed, setLoadFailed] = useState(false);
  const [pageWidth, setPageWidth] = useState(560);
  const [pdf, setPdf] = useState<PdfProxy | null>(null);
  const [citationHighlights, setCitationHighlights] = useState<CitationHighlight[]>([]);
  const stageRef = useRef<HTMLDivElement>(null);
  const locatorRef = useRef<HTMLElement>(null);
  const copy = documentCopy[document.id] ?? {
    heading: document.label,
    lines: [
      `Source file: ${document.fileName}`,
      `Classified as: ${document.kind}`,
      'No extracted text preview is available for this document.',
    ],
  };

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const updateWidth = () => setPageWidth(Math.max(280, Math.min(720, stage.clientWidth - 56)));
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [document.id]);

  useEffect(() => {
    if (!selectedEvidence) return;
    const locator = locatorRef.current;
    if (!locator) return;
    locator.scrollIntoView({ block: 'nearest' });
    locator.focus({ preventScroll: true });
  }, [page, selectedEvidence]);

  useEffect(() => {
    let cancelled = false;
    if (!pdf || !selectedEvidence?.excerpt) {
      setCitationHighlights([]);
      return;
    }
    void pdf
      .getPage(page)
      .then(async (pdfPage) => {
        const [content, viewport] = await Promise.all([
          pdfPage.getTextContent(),
          Promise.resolve(pdfPage.getViewport({ scale: 1 })),
        ]);
        const items = content.items.filter(
          (
            item,
          ): item is Required<
            Pick<(typeof content.items)[number], 'str' | 'transform' | 'width' | 'height'>
          > =>
            typeof item.str === 'string' &&
            Array.isArray(item.transform) &&
            typeof item.width === 'number' &&
            typeof item.height === 'number',
        );
        const indexes = findCitationSpanIndexes(
          items.map((item) => item.str),
          selectedEvidence.excerpt,
        );
        if (cancelled) return;
        setCitationHighlights(
          indexes.map((index) => {
            const item = items[index]!;
            const x = item.transform[4] ?? 0;
            const y = item.transform[5] ?? 0;
            return {
              left: `${(x / viewport.width) * 100}%`,
              top: `${((viewport.height - y - item.height) / viewport.height) * 100}%`,
              width: `${(item.width / viewport.width) * 100}%`,
              height: `${Math.max((item.height / viewport.height) * 100, 1.8)}%`,
            };
          }),
        );
      })
      .catch(() => {
        if (!cancelled) setCitationHighlights([]);
      });
    return () => {
      cancelled = true;
    };
  }, [page, pdf, selectedEvidence?.excerpt]);

  function changePage(nextPage: number) {
    onPageChange(Math.min(Math.max(1, nextPage), pageCount));
  }

  return (
    <div className="document-viewer">
      <div className="document-toolbar">
        <div className="toolbar-document-title">
          <span className="toolbar-document-icon" aria-hidden="true">
            <ScanText size={17} />
          </span>
          <div>
            <span className="toolbar-kicker">Original source</span>
            <strong>{document.label}</strong>
            <span className="toolbar-file-name">{document.fileName}</span>
          </div>
        </div>
        <div className="document-toolbar-actions">
          <div className="viewer-mode-switch" aria-label="Document representation" role="group">
            <button
              aria-pressed={mode === 'original'}
              disabled={!canRenderOriginal}
              onClick={() => setMode('original')}
              type="button"
            >
              <FileText aria-hidden="true" size={13} /> Original
            </button>
            <button
              aria-pressed={mode === 'extracted'}
              onClick={() => setMode('extracted')}
              type="button"
            >
              <ScanText aria-hidden="true" size={13} /> Extracted text
            </button>
          </div>
          {mode === 'original' ? (
            <div className="page-controls" aria-label="PDF page" role="group">
              <button
                aria-label="Previous page"
                disabled={page <= 1}
                onClick={() => changePage(page - 1)}
                type="button"
              >
                <ChevronLeft aria-hidden="true" size={15} />
              </button>
              <output aria-live="polite">
                {page} / {pageCount}
              </output>
              <button
                aria-label="Next page"
                disabled={page >= pageCount}
                onClick={() => changePage(page + 1)}
                type="button"
              >
                <ChevronRight aria-hidden="true" size={15} />
              </button>
            </div>
          ) : null}
          <div className="zoom-controls" aria-label="Document zoom" role="group">
            <button
              aria-label="Zoom out"
              disabled={zoom <= 70}
              onClick={() => setZoom((value) => Math.max(70, value - 10))}
              type="button"
            >
              <Minus aria-hidden="true" size={15} />
            </button>
            <output aria-live="polite">{zoom}%</output>
            <button
              aria-label="Zoom in"
              disabled={zoom >= 160}
              onClick={() => setZoom((value) => Math.min(160, value + 10))}
              type="button"
            >
              <Plus aria-hidden="true" size={15} />
            </button>
          </div>
        </div>
      </div>

      {document.state === 'missing' ? (
        <div className="missing-document">
          <span aria-hidden="true">!</span>
          <h2>{document.label} was not supplied</h2>
          <p>This required document has no original file or page evidence.</p>
        </div>
      ) : mode === 'original' && document.sourceUrl && canRenderOriginal ? (
        <div className="document-stage pdf-document-stage" ref={stageRef}>
          {selectedEvidence ? (
            <aside
              className={`evidence-locator severity-${selectedEvidence.severity}`}
              aria-label={`Selected evidence ${selectedEvidence.index}`}
              aria-live="polite"
              ref={locatorRef}
              tabIndex={-1}
            >
              <span>E{String(selectedEvidence.index).padStart(2, '0')}</span>
              <div>
                <strong>{selectedEvidence.label}</strong>
                <q>{selectedEvidence.excerpt}</q>
              </div>
              <small>Page {selectedEvidence.page} · quote-match highlight</small>
            </aside>
          ) : (
            <p className="viewer-guidance">
              Select a fact or finding to locate one of {evidence.length} cited evidence anchors.
            </p>
          )}
          <section
            className="pdf-canvas-shell"
            aria-label={`${document.label}, original PDF page ${page}`}
            style={{ '--document-zoom': zoom / 100 } as React.CSSProperties}
          >
            <Document
              error={null}
              file={document.sourceUrl}
              loading={
                <div className="pdf-loading" role="status">
                  Rendering original page…
                </div>
              }
              onLoadError={() => setLoadFailed(true)}
              onLoadSuccess={(loaded) => {
                setLoadFailed(false);
                setPdf(loaded as PdfProxy);
                setPageCount(loaded.numPages);
                if (page > loaded.numPages) onPageChange(loaded.numPages);
              }}
            >
              {!loadFailed ? (
                <div className="pdf-page-frame">
                  <Page
                    onRenderError={(error) => {
                      if (!/Worker was terminated/i.test(error.message)) setLoadFailed(true);
                    }}
                    pageNumber={page}
                    renderAnnotationLayer
                    renderTextLayer
                    scale={zoom / 100}
                    width={pageWidth}
                  />
                  {citationHighlights.map((highlight, index) => (
                    <span
                      aria-label="Exact policy citation highlight"
                      className="pdf-evidence-highlight"
                      key={`${selectedEvidence?.id ?? 'citation'}-${index}`}
                      style={highlight}
                    />
                  ))}
                </div>
              ) : null}
            </Document>
            {loadFailed ? (
              <div className="pdf-load-error" role="alert">
                <strong>The original PDF could not be rendered.</strong>
                <span>The extracted review copy is still available.</span>
                <button type="button" onClick={() => setMode('extracted')}>
                  View extracted text
                </button>
              </div>
            ) : null}
          </section>
          <a
            className="open-original-link"
            href={document.sourceUrl}
            target="_blank"
            rel="noreferrer"
          >
            Open original in a new tab <ExternalLink aria-hidden="true" size={12} />
          </a>
        </div>
      ) : (
        <div className="document-stage extracted-document-stage">
          <div className="extracted-copy-warning">
            <ScanText aria-hidden="true" size={15} />
            <span>
              <strong>Extracted text</strong>
              Review aid only—verify decisions against the original file.
            </span>
            {document.sourceUrl ? (
              <a href={document.sourceUrl} rel="noreferrer" target="_blank">
                Open source <ExternalLink aria-hidden="true" size={12} />
              </a>
            ) : null}
          </div>
          <article
            className="paper-page"
            style={{ '--document-zoom': zoom / 100 } as React.CSSProperties}
            aria-label={`${document.label}, extracted text`}
          >
            <header className="paper-letterhead">
              <span>CASELENS EXTRACTION</span>
              <small>{document.kind}</small>
            </header>
            <div className="paper-body">
              <p className="paper-reference">EXTRACTED / {document.kind.toUpperCase()}</p>
              <h2>{copy.heading}</h2>
              <div className="paper-rule" />
              {copy.lines.map((line) => {
                const highlighted =
                  selectedEvidence && lineMatchesExcerpt(line, selectedEvidence.excerpt);
                return (
                  <p className={highlighted ? 'evidence-highlight' : undefined} key={line}>
                    {line}
                  </p>
                );
              })}
            </div>
            <footer>
              <span>{document.fileName}</span>
              <span>Derived text</span>
            </footer>
          </article>
        </div>
      )}
    </div>
  );
}

function evidenceTerms(excerpt: string | undefined): string[] {
  return (excerpt ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}€$]+/u)
    .filter(Boolean);
}

function lineMatchesExcerpt(line: string, excerpt: string): boolean {
  const lineTerms = evidenceTerms(line);
  const quoteTerms = evidenceTerms(excerpt);
  return quoteTerms.length > 0 && quoteTerms.every((term) => lineTerms.includes(term));
}
