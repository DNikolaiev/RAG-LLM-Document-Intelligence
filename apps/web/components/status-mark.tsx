import type { CaseStatus } from '@/lib/demo-data';
import { statusLabels } from '@/lib/demo-data';

export function StatusMark({ status }: { status: CaseStatus }) {
  return (
    <span className={`status-mark status-${status}`}>
      <i aria-hidden="true" />
      {statusLabels[status]}
    </span>
  );
}
