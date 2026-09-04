'use client';

import { useRouter } from 'next/navigation';
import { useState, type ChangeEvent, type FormEvent } from 'react';
import { Building2, FileText, FileUp, X } from 'lucide-react';
import type { TestTenant } from '@caselens/contracts';

/**
 * Shape of a successful `POST /v1/cases/intake` response. Kept local rather than imported from
 * `@caselens/contracts` because the endpoint contract, owned by a parallel track, had not landed
 * there at the time this screen was built - the network contract in the intake plan is the source
 * of truth here, not a shared type that may not exist yet.
 */
interface IntakeResult {
  caseId?: string;
  reference?: string;
  documentIds?: string[];
  jobIds?: string[];
}

/**
 * The API's global exception filter (`apps/api/src/problem.filter.ts`) normalizes every error into
 * an RFC 7807 problem body, where the human-readable text is `detail`, not `message`. `message` is
 * read too, defensively, in case that ever changes.
 */
interface IntakeProblem {
  code?: string;
  message?: string;
  detail?: string;
}

function fileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

export function CaseIntake({ tenants }: { tenants: readonly TestTenant[] }) {
  const router = useRouter();
  const [subjectName, setSubjectName] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [subjectError, setSubjectError] = useState('');
  const [filesError, setFilesError] = useState('');
  const [workspaceError, setWorkspaceError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState('');

  // A single-workspace profile never sees a choice at all; the endpoint refuses a tenantId from
  // anyone but a platform administrator, and every non-admin test profile owns exactly one tenant.
  const switchableWorkspaces = tenants.length > 1;
  const singleWorkspace = tenants[0];
  const fileSummary =
    files.length === 0
      ? 'No files selected'
      : `${files.length} file${files.length === 1 ? '' : 's'} selected`;

  function onPickFiles(event: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.target.files ?? []);
    // Cleared immediately so picking the very same file again after removing it still fires
    // onChange - the browser otherwise treats an unchanged selection as a no-op.
    event.target.value = '';
    if (!picked.length) return;
    setFiles((current) => {
      const seen = new Set(current.map(fileKey));
      const additions = picked.filter((file) => !seen.has(fileKey(file)));
      return [...current, ...additions];
    });
    setFilesError('');
  }

  function removeFile(index: number) {
    setFiles((current) => current.filter((_, position) => position !== index));
    setFilesError('');
  }

  function handleSubjectChange(event: ChangeEvent<HTMLInputElement>) {
    setSubjectName(event.target.value);
    if (subjectError) setSubjectError('');
  }

  function handleWorkspaceChange(event: ChangeEvent<HTMLSelectElement>) {
    setTenantId(event.target.value);
    if (workspaceError) setWorkspaceError('');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedSubject = subjectName.trim();

    // The whole intake succeeds or fails as a unit, so every field is checked before anything is
    // sent - a reviewer correcting a blank subject should not also have to re-attach documents.
    let hasError = false;
    if (!trimmedSubject) {
      setSubjectError('Name the subject before creating the case.');
      hasError = true;
    }
    if (files.length === 0) {
      setFilesError('Attach at least one document before creating the case.');
      hasError = true;
    }
    if (switchableWorkspaces && !tenantId) {
      setWorkspaceError('Choose the workspace this case belongs to.');
      hasError = true;
    }
    if (hasError) return;

    setSubmitting(true);
    setMessage('Validating documents and creating the case…');
    const form = new FormData();
    form.set('subjectName', trimmedSubject);
    // A single-workspace profile sends nothing: the endpoint rejects a tenantId from anyone but a
    // platform administrator, so the field is only ever appended when there was a real choice.
    if (switchableWorkspaces) form.set('tenantId', tenantId);
    for (const file of files) form.append('file', file);

    try {
      const response = await fetch('/api/cases/intake', {
        method: 'POST',
        body: form,
        headers: { 'idempotency-key': crypto.randomUUID() },
      });
      const body = (await response.json().catch(() => null)) as
        (IntakeResult & IntakeProblem) | null;
      if (!response.ok || !body?.caseId) {
        setMessage(
          body?.detail ??
            body?.message ??
            'The case could not be created. Check the documents and try again.',
        );
        setSubmitting(false);
        return;
      }
      // On success the whole screen is left behind for the case it just created; failure keeps
      // every field exactly as the reviewer left it so the refused file is easy to find and fix.
      router.push(`/cases/${encodeURIComponent(body.caseId)}`);
    } catch {
      setMessage('The case could not be created because the API is unavailable.');
      setSubmitting(false);
    }
  }

  return (
    <form className="intake-card" onSubmit={submit} noValidate>
      <div className="intake-workspace" data-testid="intake-workspace">
        <Building2 aria-hidden="true" size={16} />
        {switchableWorkspaces ? (
          <div className="intake-workspace-control">
            <label className="intake-workspace-label" htmlFor="intake-workspace-select">
              Workspace <span className="sr-only">— select which tenant this case belongs to</span>
            </label>
            <select
              id="intake-workspace-select"
              className="intake-workspace-select"
              value={tenantId}
              aria-invalid={workspaceError ? true : undefined}
              aria-describedby={workspaceError ? 'intake-workspace-error' : undefined}
              onChange={handleWorkspaceChange}
            >
              <option value="" disabled>
                Select a workspace…
              </option>
              {tenants.map((tenant) => (
                <option key={tenant.id} value={tenant.id}>
                  {tenant.name}
                </option>
              ))}
            </select>
            {workspaceError ? (
              <p className="intake-field-error" id="intake-workspace-error" role="alert">
                {workspaceError}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="intake-workspace-control">
            <span className="intake-workspace-label">Workspace</span>
            <strong>{singleWorkspace?.name ?? 'Workspace'}</strong>
          </div>
        )}
      </div>

      <label className="intake-field">
        Subject name
        <input
          name="subjectName"
          type="text"
          value={subjectName}
          minLength={2}
          maxLength={200}
          placeholder="Meridian Pharma GmbH"
          aria-invalid={subjectError ? true : undefined}
          aria-describedby={subjectError ? 'intake-subject-error' : undefined}
          onChange={handleSubjectChange}
        />
      </label>
      {subjectError ? (
        <p className="intake-field-error" id="intake-subject-error" role="alert">
          {subjectError}
        </p>
      ) : null}

      <label className="intake-file">
        Documents
        <span className="intake-file-control">
          <span className="intake-file-button" aria-hidden="true">
            <FileUp size={13} /> Choose PDFs
          </span>
          <span className="intake-file-name" aria-hidden="true">
            {fileSummary}
          </span>
        </span>
        <input
          className="intake-file-input"
          type="file"
          accept="application/pdf,.pdf"
          multiple
          aria-invalid={filesError ? true : undefined}
          aria-describedby={filesError ? 'intake-file-error' : undefined}
          onChange={onPickFiles}
        />
      </label>
      {filesError ? (
        <p className="intake-field-error" id="intake-file-error" role="alert">
          {filesError}
        </p>
      ) : null}
      {files.length > 0 ? (
        <ul className="intake-file-list" aria-label="Selected documents">
          {files.map((file, index) => (
            <li key={fileKey(file)}>
              <FileText aria-hidden="true" size={14} />
              <span className="intake-file-item-name">{file.name}</span>
              <button
                type="button"
                className="intake-file-remove"
                onClick={() => removeFile(index)}
                aria-label={`Remove ${file.name}`}
              >
                <X aria-hidden="true" size={13} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <button className="button button-primary intake-submit" disabled={submitting} type="submit">
        {submitting ? 'Creating case…' : 'Create case'}
      </button>
      {message ? (
        <p className="intake-message" role="status">
          {message}
        </p>
      ) : null}
    </form>
  );
}
