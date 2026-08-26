import Link from 'next/link';

export default function NotFound() {
  return (
    <main id="main-content" className="error-page">
      <p className="eyebrow">Case not found</p>
      <h1>This dossier is not in the current tenant</h1>
      <p>Check the case reference, or return to the queue to choose an available review.</p>
      <Link className="button button-primary" href="/">
        Return to case queue
      </Link>
    </main>
  );
}
