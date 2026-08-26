import Link from 'next/link';

export function BrandHeader() {
  return (
    <header className="brand-header">
      <Link className="brand-lockup" href="/" aria-label="CaseLens case queue">
        <span className="brand-mark" aria-hidden="true">
          <span>CL</span>
          <i />
        </span>
        <span>
          <strong>CaseLens</strong>
          <small>Evidence review</small>
        </span>
      </Link>

      <div className="header-context" aria-label="Current workspace">
        <span className="environment-mark">Demo</span>
        <span className="header-divider" aria-hidden="true" />
        <span className="tenant-name">Düsseldorf Operations</span>
        <span className="user-avatar" aria-label="Signed in as D. Nikolaiev">
          DN
        </span>
      </div>
    </header>
  );
}
