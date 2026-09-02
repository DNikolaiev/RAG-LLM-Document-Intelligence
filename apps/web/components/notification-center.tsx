'use client';

import { Bell, CheckCircle2, Clock3, LoaderCircle, TriangleAlert, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { JobLifecycleEvent, JobNotification } from '@caselens/contracts';

interface JobPage {
  items: JobNotification[];
}

interface ToastNotice {
  event: JobLifecycleEvent;
  job: JobNotification;
}

const toastEvents = new Set([
  'queue.enqueued',
  'worker.started',
  'job.completed',
  'job.failed',
  'job.cancelled',
  'queue.record_removed',
]);

export function NotificationCenter({
  profileId,
  aggregate = false,
}: {
  profileId: string;
  aggregate?: boolean;
}) {
  const [jobs, setJobs] = useState<JobNotification[]>([]);
  const [events, setEvents] = useState<JobLifecycleEvent[]>([]);
  const [open, setOpen] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastNotice | null>(null);
  const [connectionState, setConnectionState] = useState<'live' | 'polling' | 'offline'>('live');
  const knownEventIds = useRef(new Set<string>());
  const initialized = useRef(false);
  const centerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    let source: EventSource | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    const resetTimer = setTimeout(() => {
      if (cancelled) return;
      setJobs([]);
      setEvents([]);
      setSelectedJobId(null);
      setToast(null);
      setOpen(false);
      setConnectionState('live');
    }, 0);
    knownEventIds.current = new Set();
    initialized.current = false;

    const applyPage = (page: JobPage): void => {
      if (cancelled || !Array.isArray(page.items)) return;
      const latestEvents = page.items.flatMap((job) => (job.latestEvent ? [job.latestEvent] : []));
      if (initialized.current) {
        const fresh = latestEvents.find((event) => !knownEventIds.current.has(event.id));
        const job = fresh ? page.items.find((item) => item.id === fresh.jobId) : undefined;
        if (fresh && job && toastEvents.has(fresh.type)) setToast({ event: fresh, job });
      }
      for (const event of latestEvents) knownEventIds.current.add(event.id);
      initialized.current = true;
      setJobs(page.items);
    };

    const poll = async (): Promise<void> => {
      if (cancelled) return;
      try {
        const response = await fetch('/api/jobs?limit=30', { cache: 'no-store' });
        if (!response.ok) throw new Error('Notification polling failed');
        applyPage((await response.json()) as JobPage);
        setConnectionState('polling');
      } catch {
        if (!cancelled) setConnectionState('offline');
      } finally {
        if (!cancelled) pollTimer = setTimeout(() => void poll(), 4_000);
      }
    };

    const startPollingFallback = (): void => {
      if (cancelled || pollTimer) return;
      source?.close();
      source = null;
      setConnectionState('polling');
      void poll();
    };

    if (typeof EventSource === 'undefined') {
      startPollingFallback();
    } else {
      source = new EventSource('/api/job-events/stream');
      source.addEventListener('jobs', (raw) => {
        if (cancelled) return;
        try {
          applyPage(JSON.parse((raw as MessageEvent<string>).data) as JobPage);
          setConnectionState('live');
        } catch {
          startPollingFallback();
        }
      });
      source.addEventListener('unavailable', startPollingFallback);
      source.onerror = startPollingFallback;
    }
    return () => {
      cancelled = true;
      clearTimeout(resetTimer);
      source?.close();
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [profileId]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !centerRef.current?.contains(event.target))
        setOpen(false);
    };
    document.addEventListener('keydown', closeOnEscape);
    document.addEventListener('pointerdown', closeOutside);
    return () => {
      document.removeEventListener('keydown', closeOnEscape);
      document.removeEventListener('pointerdown', closeOutside);
    };
  }, [open]);

  const unread = aggregate ? 0 : jobs.filter((job) => job.latestEvent?.readAt === null).length;

  async function selectJob(job: JobNotification): Promise<void> {
    setSelectedJobId(job.id);
    const response = await fetch(`/api/jobs/${encodeURIComponent(job.id)}/events`);
    if (!response.ok) return;
    const page = (await response.json()) as { items: JobLifecycleEvent[] };
    const ordered = [...page.items].sort((a, b) => a.sequence - b.sequence);
    setEvents(ordered);
    const unreadIds = aggregate
      ? []
      : ordered.filter((event) => event.readAt === null).map((event) => event.id);
    if (unreadIds.length) {
      await fetch('/api/jobs/events/read', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ eventIds: unreadIds }),
      });
      setJobs((current) =>
        current.map((item) =>
          item.id === job.id && item.latestEvent
            ? { ...item, latestEvent: { ...item.latestEvent, readAt: new Date().toISOString() } }
            : item,
        ),
      );
    }
  }

  async function cancelSelectedJob(): Promise<void> {
    if (!selectedJobId) return;
    const response = await fetch(`/api/jobs/${encodeURIComponent(selectedJobId)}/cancel`, {
      method: 'POST',
    });
    if (!response.ok) return;
    setJobs((current) =>
      current.map((job) =>
        job.id === selectedJobId ? { ...job, status: 'cancelled' as const } : job,
      ),
    );
  }

  async function retrySelectedJob(): Promise<void> {
    if (!selectedJobId) return;
    const response = await fetch(`/api/jobs/${encodeURIComponent(selectedJobId)}/retry`, {
      method: 'POST',
    });
    if (!response.ok) return;
    setJobs((current) =>
      current.map((job) =>
        job.id === selectedJobId ? { ...job, status: 'queued' as const, progress: 0 } : job,
      ),
    );
  }

  const selectedJob = jobs.find((job) => job.id === selectedJobId) ?? null;

  return (
    <>
      <div className="notification-center" ref={centerRef}>
        <button
          ref={triggerRef}
          className="notification-trigger"
          type="button"
          aria-label={`Processing notifications${unread ? `, ${unread} unread` : ''}`}
          aria-expanded={open}
          aria-controls="processing-notifications-panel"
          aria-haspopup="dialog"
          onClick={() => setOpen((current) => !current)}
        >
          <Bell aria-hidden="true" size={17} />
          {unread ? <span>{unread > 9 ? '9+' : unread}</span> : null}
        </button>
        {open ? (
          <section
            id="processing-notifications-panel"
            className="notification-panel"
            aria-label="Processing notifications"
            role="dialog"
          >
            <header>
              <div>
                <p>Processing ledger</p>
                <strong>Job activity</strong>
              </div>
              <button type="button" aria-label="Close notifications" onClick={() => setOpen(false)}>
                <X aria-hidden="true" size={16} />
              </button>
            </header>
            <div className={`notification-connection is-${connectionState}`} role="status">
              <span aria-hidden="true" />
              {connectionState === 'live'
                ? 'Live updates'
                : connectionState === 'polling'
                  ? 'Polling for updates'
                  : 'Updates temporarily unavailable'}
            </div>
            <div className="notification-body">
              <div className="notification-list" role="list">
                {jobs.length ? (
                  jobs.map((job) => {
                    const event = job.latestEvent;
                    return (
                      <button
                        type="button"
                        role="listitem"
                        className={selectedJobId === job.id ? 'is-selected' : ''}
                        key={job.id}
                        onClick={() => void selectJob(job)}
                      >
                        <JobIcon status={job.status} />
                        <span>
                          <strong>{event?.message ?? 'Processing request created.'}</strong>
                          <small>
                            {formatJobContext(job)} · {job.progress}% ·{' '}
                            {formatRelative(job.updatedAt)}
                          </small>
                        </span>
                        {!aggregate && event?.readAt === null ? <i aria-label="Unread" /> : null}
                      </button>
                    );
                  })
                ) : (
                  <div className="notification-empty">
                    <Bell aria-hidden="true" size={20} />
                    <strong>No processing activity</strong>
                    <span>Requests you enqueue will appear here.</span>
                  </div>
                )}
              </div>
              {selectedJobId ? (
                <div className="job-event-detail">
                  {selectedJob ? (
                    <div className="job-event-context">
                      <strong>{formatJobContext(selectedJob)}</strong>
                      <span>
                        Enqueued by {selectedJob.enqueuedByName ?? selectedJob.enqueuedByUserId}
                      </span>
                    </div>
                  ) : null}
                  <ol className="job-event-timeline" aria-label="Job processing timeline">
                    {events.map((event) => (
                      <li key={event.id} className={`event-${event.status}`}>
                        <span aria-hidden="true" />
                        <div>
                          <strong>{event.message}</strong>
                          <small>
                            {event.stage ?? 'processing'} · {event.progress}% ·{' '}
                            {new Date(event.occurredAt).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </small>
                        </div>
                      </li>
                    ))}
                  </ol>
                  {selectedJob?.status === 'queued' ? (
                    <button
                      className="notification-cancel"
                      type="button"
                      onClick={() => void cancelSelectedJob()}
                    >
                      Cancel queued request
                    </button>
                  ) : null}
                  {selectedJob?.status === 'failed' ? (
                    <button
                      className="notification-retry"
                      type="button"
                      onClick={() => void retrySelectedJob()}
                    >
                      Retry failed request
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </section>
        ) : null}
      </div>
      {toast && typeof document !== 'undefined'
        ? createPortal(
            <div className={`job-toast toast-${toast.event.status}`} role="status">
              <JobIcon status={toast.event.status} />
              <span>
                <strong>{toast.event.message}</strong>
                <small>
                  {formatJobContext(toast.job)} · {toast.event.stage ?? 'Processing update'}
                </small>
              </span>
              <button
                type="button"
                aria-label="Dismiss processing update"
                onClick={() => setToast(null)}
              >
                <X aria-hidden="true" size={15} />
              </button>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function JobIcon({ status }: { status: string }) {
  if (status === 'failed') return <TriangleAlert aria-hidden="true" size={17} />;
  if (['completed', 'needs_review', 'cancelled'].includes(status)) {
    return <CheckCircle2 aria-hidden="true" size={17} />;
  }
  if (status === 'processing')
    return <LoaderCircle className="spin" aria-hidden="true" size={17} />;
  return <Clock3 aria-hidden="true" size={17} />;
}

function formatTarget(value: JobNotification['targetType']): string {
  if (value === 'policy_version') return 'Policy';
  if (value === 'case_document') return 'Document';
  return 'Case';
}

function formatJobContext(job: JobNotification): string {
  const target = job.targetName ?? job.caseSubjectName ?? formatTarget(job.targetType);
  return job.caseReference
    ? `${job.caseReference} · ${target}`
    : `${formatTarget(job.targetType)} · ${target}`;
}

function formatRelative(value: string): string {
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  if (elapsed < 60_000) return 'now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  return new Date(value).toLocaleDateString();
}
