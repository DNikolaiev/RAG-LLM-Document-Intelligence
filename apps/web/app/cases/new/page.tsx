import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { TEST_TENANTS } from '@caselens/contracts';
import { CaseIntake } from '@/components/case-intake';
import { getSelectedProfile } from '@/lib/session-profile';
import './case-intake.css';

export const metadata: Metadata = { title: 'New case' };

export default async function NewCasePage() {
  const profile = await getSelectedProfile();
  const tenants = TEST_TENANTS.filter((tenant) => profile.tenantIds.includes(tenant.id));

  return (
    <main id="main-content" className="case-page intake-page">
      <header className="case-heading">
        <div className="case-breadcrumb">
          <Link href="/">
            <ArrowLeft aria-hidden="true" size={14} /> Case queue
          </Link>
        </div>
        <div className="case-title-row intake-title-row">
          <div>
            <p className="eyebrow">Case intake</p>
            <h1>Start a new case</h1>
            <p>
              Attach every source document for this subject. Nothing is created until every file has
              passed validation, so a rejected upload leaves nothing behind.
            </p>
          </div>
        </div>
      </header>
      <CaseIntake tenants={tenants} />
    </main>
  );
}
