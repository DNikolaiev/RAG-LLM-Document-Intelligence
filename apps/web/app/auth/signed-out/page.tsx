import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Signed out' };

/**
 * Where the console lands after signing out, and where sign-in problems are explained.
 *
 * One page for every reason, each worded for what actually happened. "Sign-in failed" for a user
 * who authenticated perfectly and simply has no workspace sends them to reset a password that was
 * never the problem.
 */
const MESSAGES: Record<string, { title: string; detail: string }> = {
  default: {
    title: 'You have signed out',
    detail: 'Your CaseLens session and your identity provider session have both ended.',
  },
  expired: {
    title: 'That sign-in expired',
    detail: 'The sign-in took too long or was started in a different browser. Start again.',
  },
  failed: {
    title: 'Sign-in could not be completed',
    detail: 'The identity provider did not confirm the sign-in. Try again.',
  },
  'no-access': {
    title: 'No CaseLens access yet',
    detail:
      'You signed in successfully, but your account has no CaseLens role or workspace. Ask an administrator to grant one.',
  },
  unavailable: {
    title: 'Sign-in is unavailable',
    detail: 'The identity provider cannot be reached right now. Try again shortly.',
  },
};

interface SignedOutProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function SignedOutPage({ searchParams }: SignedOutProps) {
  const { reason } = await searchParams;
  const message = (typeof reason === 'string' ? MESSAGES[reason] : undefined) ?? MESSAGES.default!;
  return (
    <section className="error-page">
      <p className="eyebrow">Session</p>
      <h1>{message.title}</h1>
      <p>{message.detail}</p>
      <div className="error-actions">
        <Link className="button button-primary" href="/auth/login">
          Sign in
        </Link>
      </div>
    </section>
  );
}
