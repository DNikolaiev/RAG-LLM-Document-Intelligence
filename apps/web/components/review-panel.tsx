'use client';

import { useState } from 'react';

import type { AuditEvent, Fact, Finding } from '@/lib/demo-data';

type ReviewSection = 'findings' | 'facts' | 'audit';

export function ReviewPanel({
  initialFindings,
  initialFacts,
  audit,
  caseId,
  caseReference,
  caseVersion,
  authoritative,
}: {
  initialFindings: Finding[];
  initialFacts: Fact[];
  audit: AuditEvent[];
  caseId: string;
  caseReference: string;
  caseVersion: number;
  authoritative: boolean;
}) {
  const [section, setSection] = useState<ReviewSection>('findings');
  const [findings, setFindings] = useState(initialFindings);
  const [facts, setFacts] = useState(initialFacts);
  const [editingFact, setEditingFact] = useState<Fact | null>(null);
  const [correction, setCorrection] = useState('');
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState('');
  const [currentCaseVersion, setCurrentCaseVersion] = useState(caseVersion);
  const openFindings = findings.filter((finding) => finding.state === 'open').length;

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
      state === 'resolved' ? 'Finding marked resolved.' : 'Finding accepted for follow-up.',
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
        ).map(([id, label]) => (
          <button
            aria-controls={`review-${id}`}
            aria-selected={section === id}
            key={id}
            onClick={() => setSection(id)}
            role="tab"
            type="button"
          >
            {label}
          </button>
        ))}
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
                className={`finding finding-${finding.severity}`}
                id={`finding-${finding.evidenceIds[0]}`}
                key={finding.id}
              >
                <div className="finding-index" aria-hidden="true">
                  {finding.evidenceIds.map((evidenceId) => {
                    const match = initialFindings
                      .flatMap((item) => item.evidenceIds)
                      .indexOf(evidenceId);
                    return <span key={evidenceId}>E{String(match + 1).padStart(2, '0')}</span>;
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
                      <a href={`#evidence-${evidenceId}`} key={evidenceId}>
                        Open evidence {index + 1}
                      </a>
                    ))}
                    {finding.state === 'open' ? (
                      <>
                        <button
                          type="button"
                          onClick={() => setFindingState(finding.id, 'accepted')}
                        >
                          Accept follow-up
                        </button>
                        <button
                          type="button"
                          onClick={() => setFindingState(finding.id, 'resolved')}
                        >
                          Mark resolved
                        </button>
                      </>
                    ) : (
                      <span className="resolution-state">{finding.state}</span>
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
            {facts.map((fact) => (
              <div className={`fact-row fact-${fact.state}`} key={fact.id}>
                <dt>{fact.label}</dt>
                <dd>
                  <code>{fact.value}</code>
                  <span>{Math.round(fact.confidence * 100)}% confidence</span>
                </dd>
                <div className="fact-actions">
                  <a href={`#evidence-${fact.evidenceId}`}>Open source</a>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingFact(fact);
                      setCorrection(fact.value);
                    }}
                  >
                    Correct value
                  </button>
                </div>
              </div>
            ))}
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
            type="button"
            onClick={() => {
              setNotice('Recording information request…');
              void persist('/decisions', 'POST', {
                outcome: 'request_information',
                reason:
                  'Required evidence and remediation for material findings remain outstanding.',
                version: currentCaseVersion,
              }).then((saved) => {
                setNotice(
                  saved
                    ? 'Information request recorded.'
                    : 'The information request was not recorded because the API request failed.',
                );
              });
            }}
          >
            Request information
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
            Record decision
          </button>
          <button className="icon-button" type="button" onClick={() => void exportCase()}>
            Export
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
    </aside>
  );
}
