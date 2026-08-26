import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { DossierNav } from '@/components/dossier-nav';
import { DocumentSurfaceLoader } from '@/components/document-surface-loader';
import { ReviewPanel } from '@/components/review-panel';
import { StatusMark } from '@/components/status-mark';
import { WorkspaceTabs } from '@/components/workspace-tabs';
import { getCase } from '@/lib/demo-data';

interface CasePageProps {
  params: Promise<{ caseId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params }: CasePageProps): Promise<Metadata> {
  const { caseId } = await params;
  const caseDetail = await getCase(caseId);
  return {
    title: caseDetail ? `${caseDetail.supplier} · ${caseDetail.reference}` : 'Case not found',
  };
}

export default async function CasePage({ params, searchParams }: CasePageProps) {
  const [{ caseId }, query] = await Promise.all([params, searchParams]);
  const caseDetail = await getCase(caseId);
  if (!caseDetail) notFound();

  const requestedDocument = typeof query.document === 'string' ? query.document : 'insurance';
  const selectedDocument =
    caseDetail.documentsList.find((document) => document.id === requestedDocument) ??
    caseDetail.documentsList[0];
  if (!selectedDocument) notFound();
  const visibleEvidence = caseDetail.evidence.filter(
    (evidence) => evidence.documentId === selectedDocument.id,
  );
  const severityCounts = caseDetail.findings
    .filter((finding) => finding.state === 'open')
    .reduce<Record<'critical' | 'major' | 'minor', number>>(
      (counts, finding) => ({ ...counts, [finding.severity]: counts[finding.severity] + 1 }),
      { critical: 0, major: 0, minor: 0 },
    );
  const recommendationLabels = {
    request_information: 'Request information',
    approve: 'Approve',
    reject: 'Reject',
  } as const;

  return (
    <main id="main-content" className="case-page">
      <header className="case-heading">
        <div className="case-breadcrumb">
          <Link href="/">Case queue</Link>
          <span aria-hidden="true">/</span>
          <code>{caseDetail.reference}</code>
        </div>
        <div className="case-title-row">
          <div>
            <p className="eyebrow">{caseDetail.domain}</p>
            <h1>{caseDetail.supplier}</h1>
            <p>{caseDetail.subtitle}</p>
          </div>
          <div className="case-meta">
            <StatusMark status={caseDetail.status} />
            <span>Owner · {caseDetail.assignee}</span>
            <code>{caseDetail.domainPack}</code>
          </div>
        </div>
        <section className="recommendation-strip" aria-labelledby="recommendation-title">
          <span className="inspection-stamp" aria-hidden="true">
            HOLD
          </span>
          <div>
            <p className="eyebrow">System recommendation</p>
            <h2 id="recommendation-title">{recommendationLabels[caseDetail.recommendation]}</h2>
          </div>
          <p>{caseDetail.recommendationReason}</p>
          <div className="finding-tally" aria-label="Finding summary">
            <span>
              <strong>{severityCounts.critical}</strong> critical
            </span>
            <span>
              <strong>{severityCounts.major}</strong> major
            </span>
          </div>
        </section>
      </header>

      <WorkspaceTabs
        dossier={
          <DossierNav
            caseId={caseDetail.id}
            documents={caseDetail.documentsList}
            selectedDocumentId={selectedDocument.id}
          />
        }
        document={<DocumentSurfaceLoader document={selectedDocument} evidence={visibleEvidence} />}
        review={
          <ReviewPanel
            audit={caseDetail.audit}
            authoritative={caseDetail.version !== undefined}
            caseId={caseDetail.id}
            caseReference={caseDetail.reference}
            caseVersion={caseDetail.version ?? 1}
            initialFacts={caseDetail.facts}
            initialFindings={caseDetail.findings}
          />
        }
      />
    </main>
  );
}
