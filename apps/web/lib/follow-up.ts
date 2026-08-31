import type { Finding } from '@/lib/demo-data';

export interface FollowUpContact {
  name?: string;
  role?: string;
  email?: string;
}

export interface FollowUpDraft {
  subject: string;
  body: string;
  mailto?: string;
}

export function buildFollowUpDraft(input: {
  caseReference: string;
  subjectName: string;
  findings: Finding[];
  contact?: FollowUpContact | undefined;
  senderName?: string | undefined;
}): FollowUpDraft {
  const selected = input.findings.filter((finding) => finding.state === 'accepted');
  const subject = `Information request — ${input.caseReference} · ${input.subjectName}`;
  const greeting = input.contact?.name?.trim()
    ? `Dear ${input.contact.name.trim()},`
    : 'Dear Sir or Madam,';
  const points = selected
    .map(
      (finding, index) => `${index + 1}. ${finding.title}\n   Requested action: ${finding.action}`,
    )
    .join('\n\n');
  const body = [
    greeting,
    '',
    `Thank you for the documents supplied for ${input.caseReference}. To continue our review, please provide or clarify the following:`,
    '',
    points || 'No follow-up points have been selected yet.',
    '',
    'Please reply with the requested information and supporting documents at your earliest convenience. If any point is unclear, please let us know.',
    '',
    'Kind regards,',
    input.senderName?.trim() || 'Case review team',
  ].join('\n');
  const email = input.contact?.email?.trim();
  return {
    subject,
    body,
    ...(email
      ? {
          mailto: `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
        }
      : {}),
  };
}
