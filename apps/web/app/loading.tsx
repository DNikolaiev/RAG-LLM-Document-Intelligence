export default function QueueLoading() {
  return (
    <main id="main-content" className="queue-page" aria-busy="true" aria-label="Loading cases">
      <section className="queue-intro">
        <div className="skeleton skeleton-title" />
        <div className="skeleton skeleton-ledger" />
      </section>
      <section className="queue-workbench">
        <div className="skeleton skeleton-tools" />
        {Array.from({ length: 4 }, (_, index) => (
          <div className="skeleton skeleton-row" key={index} />
        ))}
      </section>
      <p className="sr-only">Loading case queue…</p>
    </main>
  );
}
