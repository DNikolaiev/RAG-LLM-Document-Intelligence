import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DocumentUpload } from '@/components/document-upload';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

describe('document upload', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    refresh.mockClear();
  });

  it('posts the selected file as multipart data and refreshes the dossier', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'doc_new' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<DocumentUpload caseId="case-1" />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(['supplier evidence'], 'evidence.txt', { type: 'text/plain' });

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith('/api/cases/case-1/documents', {
      method: 'POST',
      body: expect.any(FormData),
    });
    expect(screen.getByRole('status')).toHaveTextContent('accepted and queued');
  });
});
