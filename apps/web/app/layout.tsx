import '@fontsource-variable/newsreader/wght.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import './foundation.css';
import './queue.css';
import './workspace.css';
import './evidence.css';

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { BrandHeader } from '@/components/brand-header';

export const metadata: Metadata = {
  title: {
    default: 'CaseLens · Evidence review',
    template: '%s · CaseLens',
  },
  description: 'Evidence-backed document review for regulated operations.',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        <BrandHeader />
        {children}
      </body>
    </html>
  );
}
