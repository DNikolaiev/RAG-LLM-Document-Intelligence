export default function CaseLoading() {
  return (
    <main id="main-content" className="case-page" aria-busy="true">
      <header className="case-heading">
        <div className="skeleton skeleton-case-heading" />
        <div className="skeleton skeleton-recommendation" />
      </header>
      <div className="workspace-shell loading-workspace">
        <div className="skeleton skeleton-dossier" />
        <div className="skeleton skeleton-document" />
        <div className="skeleton skeleton-review" />
      </div>
      <p className="sr-only">Loading case workspace…</p>
    </main>
  );
}
