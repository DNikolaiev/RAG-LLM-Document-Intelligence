'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

export function DocumentUpload({ caseId }: { caseId: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState('');
  const [uploading, setUploading] = useState(false);
  const router = useRouter();

  async function upload(file: File): Promise<void> {
    setUploading(true);
    setMessage(`Uploading ${file.name}…`);
    const form = new FormData();
    form.append('file', file);
    try {
      const response = await fetch(`/api/cases/${encodeURIComponent(caseId)}/documents`, {
        method: 'POST',
        body: form,
      });
      if (!response.ok) {
        const problem = (await response.json().catch(() => null)) as { detail?: string } | null;
        setMessage(problem?.detail ?? 'The document could not be uploaded.');
        return;
      }
      setMessage(`${file.name} was accepted and queued for review.`);
      router.refresh();
    } catch {
      setMessage('The document could not be uploaded because the API is unavailable.');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <div className="dossier-upload">
      <input
        className="sr-only"
        ref={inputRef}
        id="document-upload"
        type="file"
        accept=".pdf,.txt,application/pdf,text/plain"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
        }}
      />
      <button
        className="button button-secondary button-full"
        disabled={uploading}
        onClick={() => inputRef.current?.click()}
        type="button"
      >
        {uploading ? 'Uploading…' : 'Add document'}
      </button>
      {message ? (
        <p className="upload-message" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}
