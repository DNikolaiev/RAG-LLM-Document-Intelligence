'use client';

import Link from 'next/link';
import { useEffect } from 'react';

export default function CaseError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main id="main-content" className="error-page">
      <p className="eyebrow">Dossier unavailable</p>
      <h1>The evidence workspace did not load</h1>
      <p>No review action was recorded. Retry this case or return to the queue.</p>
      <div className="error-actions">
        <button className="button button-primary" onClick={reset} type="button">
          Retry this case
        </button>
        <Link className="button button-secondary" href="/">
          Return to queue
        </Link>
      </div>
    </main>
  );
}
