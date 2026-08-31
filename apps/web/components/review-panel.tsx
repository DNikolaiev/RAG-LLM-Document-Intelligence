'use client';

import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import {
  CheckCircle2,
  ClipboardCheck,
  Copy,
  Download,
  FileSearch,
  History,
  ListChecks,
  Mail,
  PencilLine,
  Send,
  X,
} from 'lucide-react';

import type { AuditEvent, CaseContact, EvidenceAnchor, Fact, Finding } from '@/lib/demo-data';
import { buildFollowUpDraft } from '@/lib/follow-up';

type ReviewSection = 'findings' | 'facts' | 'audit';

export function ReviewPanel({
  initialFindings,
  initialFacts,
  audit,
  caseId,
  caseReference,
  caseVersion,
  authoritative,
  evidence = [],
  onOpenEvidence,
  selectedEvidenceId,
  contact,
  subjectName,
  senderName,
}: {
  initialFindings: Finding[];
  initialFacts: Fact[];
  audit: AuditEvent[];
  caseId: string;
  caseReference: string;
  caseVersion: number;
  authoritative: boolean;
  evidence?: EvidenceAnchor[];
  onOpenEvidence?: (evidenceId: string) => void;
  selectedEvidenceId?: string | undefined;
  contact?: CaseContact | undefined;
  subjectName?: string | undefined;
  senderName?: string | undefined;
}) {
  const [section, setSection] = useState<ReviewSection>('findings');
  const [findings, setFindings] = useState(initialFindings);
  const [facts, setFacts] = useState(initialFacts);
  const [editingFact, setEditingFact] = useState<Fact | null>(null);
  const [correction, setCorrection] = useState('');
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState('');
  const [currentCaseVersion, setCurrentCaseVersion] = useState(caseVersion);
  const [followUpOpen, setFollowUpOpen] = useState(false);
  const [requestSaving, setRequestSaving] = useState(false);
  const [followUpOutcome, setFollowUpOutcome] = useState('');
  const requestTriggerRef = useRef<HTMLButtonElement>(null);
  const followUpDialogRef = useRef<HTMLElement>(null);
  const openFindings = findings.filter((finding) => finding.state === 'open').length;
  const followUpFindings = findings.filter((finding) => finding.state === 'accepted');
  const followUpDraft = useMemo(
    () =>
      buildFollowUpDraft({
        caseReference,
        subjectName: subjectName ?? caseReference,
        findings,
        contact,
        senderName,
      }),
    [caseReference, contact, findings, senderName, subjectName],
  );
  const sectionIcons = {
    findings: ListChecks,
    facts: FileSearch,
    audit: History,
  } as const;
  const evidenceById = useMemo(
    () => new Map(evidence.map((anchor) => [anchor.id, anchor])),
    [evidence],
  );

  useEffect(() => {
    if (!followUpOpen) return;
    const dialog = followUpDialogRef.current;
    if (!dialog) return;
    const firstControl = dialog.querySelector<HTMLElement>('button, input, textarea, [href]');
    firstControl?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setFollowUpOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href]',
        ),
      );
      if (!controls.length) return;
      const first = controls[0]!;
      const last = controls.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener('keydown', onKeyDown);
    return () => {
      dialog.removeEventListener('keydown', onKeyDown);
      requestTriggerRef.current?.focus();
    };
  }, [followUpOpen]);

  function evidenceHref(evidenceId: string): string {
    const anchor = evidenceById.get(evidenceId);
    if (!anchor) return `#evidence-${encodeURIComponent(evidenceId)}`;
    const params = new URLSearchParams({
      document: anchor.documentId,
      evidence: anchor.id,
      page: String(anchor.page),
    });
    return `/cases/${encodeURIComponent(caseId)}?${params.toString()}`;
  }

  function handleEvidenceClick(event: MouseEvent<HTMLAnchorElement>, evidenceId: string) {
    if (!onOpenEvidence) return;
    event.preventDefault();
    onOpenEvidence(evidenceId);
  }

  async function persist<T>(
    path: string,
    method: 'PATCH' | 'POST',
    body: unknown,
  ): Promise<T | null> {
    try {
      const response = await fetch(`/api/cases/${encodeURIComponent(caseId)}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) return null;
      return (await response.json()) as T;
    } catch {
      return null;
    }
  }

  function setFindingState(id: string, state: Finding['state']) {
    const finding = findings.find((item) => item.id === id);
    setFindings((current) =>
      current.map((finding) => (finding.id === id ? { ...finding, state } : finding)),
    );
    setNotice(
      state === 'resolved'
        ? 'Finding marked resolved.'
        : 'Finding added to the information request.',
    );
    if (finding?.version) {
      void persist<{ version: number; caseVersion: number }>(
        `/findings/${encodeURIComponent(id)}`,
        'PATCH',
        {
          status: state === 'resolved' ? 'resolved' : 'accepted',
          reason:
            state === 'resolved'
              ? 'Reviewer confirmed that the exception has been resolved.'
              : 'Reviewer accepted this exception for supplier follow-up.',
          version: finding.version,
        },
      ).then((saved) => {
        if (saved) {
          setCurrentCaseVersion(saved.caseVersion);
          setFindings((current) =>
            current.map((item) => (item.id === id ? { ...item, version: saved.version } : item)),
          );
          return;
        }
        setFindings((current) =>
          current.map((item) => (item.id === id ? { ...item, state: finding.state } : item)),
        );
        setNotice('The finding was not changed because the API request failed.');
      });
    }
  }

  async function copyFollowUp(): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(`${followUpDraft.subject}\n\n${followUpDraft.body}`);
      setNotice('Information request copied to the clipboard.');
      setFollowUpOutcome('Information request copied to the clipboard.');
      return true;
    } catch {
      setNotice('Copy failed. Select the request text and copy it manually.');
      setFollowUpOutcome('Copy failed. Select the request text and copy it manually.');
      return false;
    }
  }

  async function recordInformationRequest(): Promise<boolean> {
    setRequestSaving(true);
    const saved = await persist<{ caseVersion: number }>('/decisions', 'POST', {
      outcome: 'request_information',
      reason: `Requested follow-up for ${followUpFindings.length} accepted finding(s).`,
      version: currentCaseVersion,
    });
    setRequestSaving(false);
    if (!saved) {
      setNotice('The information request was not recorded because the API request failed.');
      return false;
    }
    setCurrentCaseVersion(saved.caseVersion);
    setNotice('Information request recorded and ready to send.');
    return true;
  }

  async function completeInformationRequest(mode: 'email' | 'copy') {
    const saved = await recordInformationRequest();
    if (!saved) return;
    if (mode === 'copy') {
      await copyFollowUp();
      return;
    }
    setFollowUpOutcome('Information request recorded. Opening your email client…');
    if (followUpDraft.mailto) window.location.href = followUpDraft.mailto;
  }

  function saveCorrection() {
    if (!editingFact || correction.trim().length === 0 || reason.trim().length === 0) return;
    const previousValue = editingFact.value;
    const previousState = editingFact.state;
    const correctedValue = correction.trim();
    setFacts((current) =>
      current.map((fact) =>
        fact.id === editingFact.id ? { ...fact, value: correctedValue, state: 'confirmed' } : fact,
      ),
    );
    setEditingFact(null);
    setNotice('Correction saved with its review reason.');
    if (editingFact.version) {
      void persist<{ version: number; caseVersion: number }>(
        `/facts/${encodeURIComponent(editingFact.id)}`,
        'PATCH',
        {
          value: correctedValue,
          reason: reason.trim(),
          version: editingFact.version,
        },
      ).then((saved) => {
        if (saved) {
          setCurrentCaseVersion(saved.caseVersion);
          setFacts((current) =>
            current.map((fact) =>
              fact.id === editingFact.id ? { ...fact, version: saved.version } : fact,
            ),
          );
          return;
        }
        setFacts((current) =>
          current.map((fact) =>
            fact.id === editingFact.id
              ? { ...fact, value: previousValue, state: previousState }
              : fact,
          ),
        );
        setNotice('The correction was not saved because the API request failed.');
      });
    }
    setCorrection('');
    setReason('');
  }

  async function exportCase() {
    let exported: unknown = {
      caseReference,
      recommendation: 'request_information',
      findings,
      facts,
      exportedAt: new Date().toISOString(),
    };
    if (authoritative) {
      try {
        const response = await fetch(`/api/cases/${encodeURIComponent(caseId)}/export`);
        if (response.ok) exported = await response.json();
        else {
          setNotice('The authoritative export could not be created.');
          return;
        }
      } catch {
        setNotice('The authoritative export could not be created because the API is unavailable.');
        return;
      }
    }
    const payload = JSON.stringify(exported, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = window.document.createElement('a');
    link.href = url;
    link.download = `${caseReference}-audit-export.json`;
    link.click();
    URL.revokeObjectURL(url);
    setNotice(
      authoritative
        ? 'Audit package exported as JSON.'
        : 'Offline demo package exported as non-authoritative JSON.',
    );
  }

  return (
    <aside className="review-panel" aria-label="Case review">
      <div className="review-section-tabs" role="tablist" aria-label="Review detail">
        {(
          [
            ['findings', `Findings ${openFindings}`],
            ['facts', `Facts ${facts.length}`],
            ['audit', 'Audit'],
          ] as const
        ).map(([id, label]) => {
          const SectionIcon = sectionIcons[id];
          return (
            <button
              aria-controls={`review-${id}`}
              aria-selected={section === id}
              key={id}
              onClick={() => setSection(id)}
              role="tab"
              type="button"
            >
              <SectionIcon aria-hidden="true" size={14} />
              {label}
            </button>
          );
        })}
      </div>

      {section === 'findings' ? (
        <div className="review-scroll" id="review-findings" role="tabpanel">
          <div className="section-heading">
            <p className="eyebrow">Evidence-linked exceptions</p>
            <h2>Material findings</h2>
          </div>
          <ol className="findings-list">
            {findings.map((finding) => (
              <li
                className={`finding finding-${finding.severity}${finding.evidenceIds.includes(selectedEvidenceId ?? '') ? ' finding-selected' : ''}`}
                id={`finding-${finding.evidenceIds[0]}`}
                key={finding.id}
              >
                <div className="finding-index" aria-hidden="true">
                  {finding.evidenceIds.map((evidenceId) => {
                    const anchor = evidenceById.get(evidenceId);
                    const fallbackIndex =
                      initialFindings.flatMap((item) => item.evidenceIds).indexOf(evidenceId) + 1;
                    return (
                      <span key={evidenceId}>
                        E{String(anchor?.index ?? fallbackIndex).padStart(2, '0')}
                      </span>
                    );
                  })}
                </div>
                <div className="finding-body">
                  <div className="finding-meta">
                    <span className={`severity-label severity-${finding.severity}`}>
                      {finding.severity}
                    </span>
                    <code>{finding.policy}</code>
                  </div>
                  <h3>{finding.title}</h3>
                  <p>{finding.detail}</p>
                  <div className="finding-actions">
                    {finding.evidenceIds.map((evidenceId, index) => (
                      <a
                        aria-current={selectedEvidenceId === evidenceId ? 'location' : undefined}
                        href={evidenceHref(evidenceId)}
                        key={evidenceId}
                        onClick={(event) => handleEvidenceClick(event, evidenceId)}
                      >
                        <FileSearch aria-hidden="true" size={12} /> Open source {index + 1}
                      </a>
                    ))}
                    {finding.state === 'open' ? (
                      <>
                        <button
                          type="button"
                          onClick={() => setFindingState(finding.id, 'accepted')}
                        >
                          <Send aria-hidden="true" size={12} /> Add to follow-up
                        </button>
                        <button
                          type="button"
                          onClick={() => setFindingState(finding.id, 'resolved')}
                        >
                          <CheckCircle2 aria-hidden="true" size={12} /> Mark resolved
                        </button>
                      </>
                    ) : (
                      <span className="resolution-state">
                        {finding.state === 'accepted' ? 'Included in follow-up' : finding.state}
                      </span>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {section === 'facts' ? (
        <div className="review-scroll" id="review-facts" role="tabpanel">
          <div className="section-heading">
            <p className="eyebrow">Normalized extraction</p>
            <h2>Material facts</h2>
          </div>
          <dl className="facts-list">
            {facts.map((fact) => {
              const anchor = evidenceById.get(fact.evidenceId);
              return (
                <div
                  className={`fact-row fact-${fact.state}${selectedEvidenceId === fact.evidenceId ? ' fact-selected' : ''}`}
                  key={fact.id}
                >
                  <dt>{fact.label}</dt>
                  <dd>
                    <code>{fact.value}</code>
                    <span>{Math.round(fact.confidence * 100)}% confidence</span>
                    {anchor ? (
                      <div className="fact-source">
                        <span>
                          {anchor.label} · page {anchor.page}
                        </span>
                        <q>{anchor.excerpt}</q>
                      </div>
                    ) : null}
                    <div className="fact-actions">
                      <a
                        aria-current={
                          selectedEvidenceId === fact.evidenceId ? 'location' : undefined
                        }
                        href={evidenceHref(fact.evidenceId)}
                        onClick={(event) => handleEvidenceClick(event, fact.evidenceId)}
                      >
                        <FileSearch aria-hidden="true" size={12} /> Open in document
                      </a>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingFact(fact);
                          setCorrection(fact.value);
                        }}
                      >
                        <PencilLine aria-hidden="true" size={12} /> Correct value
                      </button>
                    </div>
                  </dd>
                </div>
              );
            })}
          </dl>
        </div>
      ) : null}

      {section === 'audit' ? (
        <div className="review-scroll" id="review-audit" role="tabpanel">
          <div className="section-heading">
            <p className="eyebrow">Immutable activity</p>
            <h2>Audit trail</h2>
          </div>
          <ol className="audit-list">
            {audit.map((event) => (
              <li key={event.id}>
                <time>{event.at}</time>
                <strong>{event.action}</strong>
                <p>{event.detail}</p>
                <span>{event.actor}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      <div className="review-decision-bar">
        {notice ? <p role="status">{notice}</p> : null}
        <div>
          <button
            className="button button-primary"
            disabled={followUpFindings.length === 0}
            title={
              followUpFindings.length === 0
                ? 'Add at least one finding to the follow-up first.'
                : undefined
            }
            type="button"
            onClick={() => {
              setFollowUpOutcome('');
              setFollowUpOpen(true);
            }}
            ref={requestTriggerRef}
          >
            <Send aria-hidden="true" size={14} /> Request information
            {followUpFindings.length > 0 ? (
              <span className="follow-up-count" aria-label={`${followUpFindings.length} selected`}>
                {followUpFindings.length}
              </span>
            ) : null}
          </button>
          <button
            className="button button-secondary"
            disabled={openFindings > 0}
            title={openFindings > 0 ? 'Resolve all material findings before approval.' : undefined}
            type="button"
            onClick={() => {
              setNotice('Recording decision…');
              void persist('/decisions', 'POST', {
                outcome: 'approve',
                reason:
                  'All material findings were resolved and the approver confirmed the evidence.',
                version: currentCaseVersion,
              }).then((saved) => {
                setNotice(
                  saved
                    ? 'Decision recorded: approved with reviewer override.'
                    : 'The decision was not recorded because the API request failed.',
                );
              });
            }}
          >
            <ClipboardCheck aria-hidden="true" size={14} /> Record decision
          </button>
          <button className="icon-button" type="button" onClick={() => void exportCase()}>
            <Download aria-hidden="true" size={14} /> Export
          </button>
        </div>
      </div>

      {editingFact ? (
        <div className="dialog-backdrop">
          <section
            aria-labelledby="correction-title"
            aria-modal="true"
            className="correction-dialog"
            role="dialog"
          >
            <p className="eyebrow">Fact correction</p>
            <h2 id="correction-title">Correct {editingFact.label.toLowerCase()}</h2>
            <p>The original extraction remains in the audit trail.</p>
            <label>
              Corrected value
              <input
                autoFocus
                value={correction}
                onChange={(event) => setCorrection(event.target.value)}
              />
            </label>
            <label>
              Reason for correction
              <textarea
                placeholder="Describe what the source document confirms"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            <div className="dialog-actions">
              <button
                className="button button-secondary"
                type="button"
                onClick={() => setEditingFact(null)}
              >
                Cancel
              </button>
              <button
                className="button button-primary"
                disabled={correction.trim().length === 0 || reason.trim().length < 8}
                type="button"
                onClick={saveCorrection}
              >
                Save correction
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {followUpOpen ? (
        <div className="dialog-backdrop">
          <section
            aria-labelledby="follow-up-title"
            aria-modal="true"
            className="correction-dialog follow-up-dialog"
            ref={followUpDialogRef}
            role="dialog"
          >
            <button
              aria-label="Close information request"
              className="dialog-close"
              type="button"
              onClick={() => setFollowUpOpen(false)}
            >
              <X aria-hidden="true" size={17} />
            </button>
            <p className="eyebrow">Supplier follow-up</p>
            <h2 id="follow-up-title">Review the information request</h2>
            <div className="follow-up-recipient">
              <Mail aria-hidden="true" size={16} />
              <span>
                <strong>{contact?.name ?? 'No document contact found'}</strong>
                <small>{contact?.email ?? 'Copy the request and address it manually'}</small>
              </span>
            </div>
            <label>
              Subject
              <input readOnly value={followUpDraft.subject} />
            </label>
            <label>
              Message covering {followUpFindings.length} follow-up point
              {followUpFindings.length === 1 ? '' : 's'}
              <textarea className="follow-up-body" readOnly value={followUpDraft.body} />
            </label>
            <p className="follow-up-privacy">
              The draft was created locally from the findings you selected. Review it before
              sending.
            </p>
            {followUpOutcome ? (
              <p className="follow-up-outcome" role="status">
                {followUpOutcome}
              </p>
            ) : null}
            <div className="dialog-actions follow-up-actions">
              <button
                className="button button-secondary"
                type="button"
                onClick={() => void copyFollowUp()}
              >
                <Copy aria-hidden="true" size={14} /> Copy request
              </button>
              <button
                className="button button-primary"
                disabled={requestSaving}
                type="button"
                onClick={() =>
                  void completeInformationRequest(followUpDraft.mailto ? 'email' : 'copy')
                }
              >
                {followUpDraft.mailto ? (
                  <>
                    <Mail aria-hidden="true" size={14} />{' '}
                    {requestSaving ? 'Recording…' : 'Record and open email'}
                  </>
                ) : (
                  <>
                    <Copy aria-hidden="true" size={14} />{' '}
                    {requestSaving ? 'Recording…' : 'Record and copy'}
                  </>
                )}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </aside>
  );
}
