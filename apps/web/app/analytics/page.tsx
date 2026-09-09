import type { Metadata } from 'next';
import { AnalyticsDashboard } from '@/components/analytics-dashboard';
import './analytics.css';

export const metadata: Metadata = { title: 'Decision analytics' };

export default function AnalyticsPage() {
  return <AnalyticsDashboard />;
}
