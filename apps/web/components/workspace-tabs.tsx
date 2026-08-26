'use client';

import type { ReactNode } from 'react';
import { useState } from 'react';

type WorkspacePane = 'dossier' | 'document' | 'review';

const panes: Array<{ id: WorkspacePane; label: string }> = [
  { id: 'dossier', label: 'Dossier' },
  { id: 'document', label: 'Document' },
  { id: 'review', label: 'Review' },
];

export function WorkspaceTabs({
  dossier,
  document,
  review,
}: {
  dossier: ReactNode;
  document: ReactNode;
  review: ReactNode;
}) {
  const [activePane, setActivePane] = useState<WorkspacePane>('document');

  return (
    <section className="workspace-shell" data-active-pane={activePane}>
      <div className="mobile-workspace-tabs" role="tablist" aria-label="Case workspace views">
        {panes.map((pane) => (
          <button
            aria-controls={`workspace-${pane.id}`}
            aria-selected={activePane === pane.id}
            className="mobile-tab"
            id={`tab-${pane.id}`}
            key={pane.id}
            onClick={() => setActivePane(pane.id)}
            role="tab"
            type="button"
          >
            {pane.label}
          </button>
        ))}
      </div>
      <div
        aria-labelledby="tab-dossier"
        className="workspace-pane dossier-pane"
        id="workspace-dossier"
        role="tabpanel"
      >
        {dossier}
      </div>
      <div
        aria-labelledby="tab-document"
        className="workspace-pane document-pane"
        id="workspace-document"
        role="tabpanel"
      >
        {document}
      </div>
      <div
        aria-labelledby="tab-review"
        className="workspace-pane review-pane"
        id="workspace-review"
        role="tabpanel"
      >
        {review}
      </div>
    </section>
  );
}
