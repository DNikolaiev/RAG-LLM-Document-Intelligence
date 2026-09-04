import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEST_TENANTS } from '@caselens/contracts';

import { CaseIntake } from '@/components/case-intake';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function pdf(name: string) {
  return new File(['%PDF-1.4 evidence'], name, { type: 'application/pdf' });
}

function postCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(
    (call) => (call[1] as RequestInit | undefined)?.method === 'POST',
  );
}

function fillSubject(value: string) {
  fireEvent.change(screen.getByLabelText('Subject name'), { target: { value } });
}

// The visually-hidden file input sits inside a label whose other children ("Choose PDFs", the
// summary text) are aria-hidden - real browsers exclude them from the accessible name Playwright
// resolves in the e2e specs, but @testing-library/dom's `getByLabelText` concatenates the whole
// label textContent regardless, so it would never match on just "Documents" here. A direct query
// for the input sidesteps that mismatch between the two.
function pickFiles(...files: File[]) {
  const input = document.querySelector<HTMLInputElement>('.intake-file-input')!;
  fireEvent.change(input, { target: { files } });
}

describe('case intake workspace selection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    push.mockClear();
  });

  it('shows a static workspace label when the profile owns a single workspace', () => {
    render(<CaseIntake tenants={[TEST_TENANTS[0]]} />);

    const identity = screen.getByTestId('intake-workspace');
    expect(identity).toHaveTextContent('Düsseldorf Health Operations');
    expect(within(identity).queryByRole('combobox')).toBeNull();
  });

  it('offers every owned workspace to a platform administrator and requires a choice', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<CaseIntake tenants={TEST_TENANTS} />);

    const identity = screen.getByTestId('intake-workspace');
    const select = within(identity).getByRole('combobox', { name: /select which tenant/i });
    expect(within(select).getAllByRole('option')).toHaveLength(TEST_TENANTS.length + 1);
    expect(select).toHaveValue('');

    fillSubject('Meridian Pharma GmbH');
    pickFiles(pdf('insurance.pdf'));
    fireEvent.submit(container.querySelector('form.intake-card')!);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Choose the workspace this case belongs to.',
    );
    expect(postCalls(fetchMock)).toHaveLength(0);

    fireEvent.change(select, { target: { value: 'tenant_legal' } });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('case intake validation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    push.mockClear();
  });

  it('refuses to submit with no files and says so inline, clearing once a file is picked', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<CaseIntake tenants={[TEST_TENANTS[0]]} />);

    fillSubject('Meridian Pharma GmbH');
    fireEvent.submit(container.querySelector('form.intake-card')!);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Attach at least one document before creating the case.',
    );
    expect(postCalls(fetchMock)).toHaveLength(0);

    pickFiles(pdf('insurance.pdf'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('refuses to submit a blank subject and says so inline, clearing once it is edited', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<CaseIntake tenants={[TEST_TENANTS[0]]} />);

    pickFiles(pdf('insurance.pdf'));
    fireEvent.submit(container.querySelector('form.intake-card')!);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Name the subject before creating the case.',
    );
    expect(postCalls(fetchMock)).toHaveLength(0);

    fillSubject('M');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('case intake file selection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists every selected file by name and removes one before submitting', () => {
    render(<CaseIntake tenants={[TEST_TENANTS[0]]} />);

    pickFiles(pdf('insurance.pdf'), pdf('questionnaire.pdf'));

    const list = screen.getByRole('list', { name: 'Selected documents' });
    expect(within(list).getByText('insurance.pdf')).toBeInTheDocument();
    expect(within(list).getByText('questionnaire.pdf')).toBeInTheDocument();

    fireEvent.click(within(list).getByRole('button', { name: 'Remove insurance.pdf' }));

    expect(within(list).queryByText('insurance.pdf')).toBeNull();
    expect(within(list).getByText('questionnaire.pdf')).toBeInTheDocument();
  });

  it('does not add the same file twice when it is picked again', () => {
    render(<CaseIntake tenants={[TEST_TENANTS[0]]} />);

    const file = pdf('insurance.pdf');
    pickFiles(file);
    pickFiles(file);

    const list = screen.getByRole('list', { name: 'Selected documents' });
    expect(within(list).getAllByText('insurance.pdf')).toHaveLength(1);
  });
});

describe('case intake submission', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    push.mockClear();
  });

  it('posts subject, files, and no tenantId for a single-workspace profile, then navigates to the case', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json(
        {
          caseId: 'case_new_1',
          reference: 'CTR-2026-0099',
          documentIds: ['doc_1'],
          jobIds: ['job_1'],
        },
        201,
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<CaseIntake tenants={[TEST_TENANTS[0]]} />);

    fillSubject('Meridian Pharma GmbH');
    pickFiles(pdf('insurance.pdf'));
    fireEvent.submit(container.querySelector('form.intake-card')!);

    await waitFor(() => expect(push).toHaveBeenCalledWith('/cases/case_new_1'));
    expect(postCalls(fetchMock)).toHaveLength(1);
    const [url, init] = postCalls(fetchMock)[0]!;
    expect(url).toBe('/api/cases/intake');
    const body = init!.body as FormData;
    expect(body.get('subjectName')).toBe('Meridian Pharma GmbH');
    expect(body.get('tenantId')).toBeNull();
    expect(body.getAll('file')).toHaveLength(1);
    expect((init!.headers as Record<string, string>)['idempotency-key']).toBeTruthy();
  });

  it('includes the chosen tenantId for a platform administrator', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(json({ caseId: 'case_new_2', reference: 'CTR-2026-0100' }, 201));
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<CaseIntake tenants={TEST_TENANTS} />);

    fillSubject('Nordkontor GmbH');
    pickFiles(pdf('contract.pdf'));
    fireEvent.change(screen.getByRole('combobox', { name: /select which tenant/i }), {
      target: { value: 'tenant_legal' },
    });
    fireEvent.submit(container.querySelector('form.intake-card')!);

    await waitFor(() => expect(push).toHaveBeenCalledWith('/cases/case_new_2'));
    const body = postCalls(fetchMock)[0]![1]!.body as FormData;
    expect(body.get('tenantId')).toBe('tenant_legal');
  });

  it('keeps the selection and surfaces the refused file on failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json(
        {
          code: 'PAGE_LIMIT_EXCEEDED',
          detail: 'questionnaire.pdf exceeds the 200 page limit.',
        },
        422,
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<CaseIntake tenants={[TEST_TENANTS[0]]} />);

    fillSubject('Meridian Pharma GmbH');
    pickFiles(pdf('insurance.pdf'), pdf('questionnaire.pdf'));
    fireEvent.submit(container.querySelector('form.intake-card')!);

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'questionnaire.pdf exceeds the 200 page limit.',
      ),
    );
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Subject name')).toHaveValue('Meridian Pharma GmbH');
    const list = screen.getByRole('list', { name: 'Selected documents' });
    expect(within(list).getByText('insurance.pdf')).toBeInTheDocument();
    expect(within(list).getByText('questionnaire.pdf')).toBeInTheDocument();
  });
});
