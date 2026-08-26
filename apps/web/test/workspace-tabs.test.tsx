import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { WorkspaceTabs } from '@/components/workspace-tabs';

describe('responsive workspace tabs', () => {
  it('starts on the document and exposes every pane in a stable reading order', () => {
    const { container } = render(
      <WorkspaceTabs
        dossier={<p>Dossier content</p>}
        document={<p>Document content</p>}
        review={<p>Review content</p>}
      />,
    );

    expect(screen.getByRole('tab', { name: 'Document' })).toHaveAttribute('aria-selected', 'true');
    expect(
      Array.from(container.querySelectorAll('[role="tabpanel"]')).map((item) => item.id),
    ).toEqual(['workspace-dossier', 'workspace-document', 'workspace-review']);
  });

  it('switches the active mobile pane with a semantic tab control', () => {
    const { container } = render(
      <WorkspaceTabs dossier={<p>Dossier</p>} document={<p>Document</p>} review={<p>Review</p>} />,
    );

    const reviewTab = screen.getByRole('tab', { name: 'Review' });
    reviewTab.focus();
    fireEvent.click(reviewTab);

    expect(reviewTab).toHaveFocus();
    expect(reviewTab).toHaveAttribute('aria-selected', 'true');
    expect(container.querySelector('.workspace-shell')).toHaveAttribute(
      'data-active-pane',
      'review',
    );
  });
});
