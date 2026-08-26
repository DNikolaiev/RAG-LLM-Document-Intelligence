'use client';

import { useEffect } from 'react';

export default function QueueError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main id="main-content" className="error-page">
      <p className="eyebrow">Case queue unavailable</p>
      <h1>The review queue did not load</h1>
      <p>Your filters are unchanged. Retry the request, or check the API readiness status.</p>
      <button className="button button-primary" type="button" onClick={reset}>
        Retry loading cases
      </button>
    </main>
  );
}
