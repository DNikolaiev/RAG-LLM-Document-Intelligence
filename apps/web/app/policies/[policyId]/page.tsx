import type { Metadata } from 'next';
import { PolicyReviewWorkspace } from '@/components/policy/policy-review-workspace';
import '../policies.css';

export const metadata: Metadata = { title: 'Policy review' };

export default async function PolicyPage({ params }: { params: Promise<{ policyId: string }> }) {
  const { policyId } = await params;
  return <PolicyReviewWorkspace policyId={policyId} />;
}
