'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  BadgeCheck,
  BookOpenCheck,
  Braces,
  FileCheck2,
  FileUp,
  ListChecks,
  X,
  ShieldCheck,
} from 'lucide-react';
import type { TestTenant } from '@caselens/contracts';

interface PolicySummary {
  id: string;
  tenantId: string;
  title: string;
  policyVersion: string;
  collectionId: string;
  status: string;
  pageCount: number | null;
  updatedAt: string;
}

interface DomainPackConfiguration {
  tenantId: string;
  domainPack: {
    id: string;
    key: string;
    name: string;
    version: string;
    terminology: { case: string; subject: string; decision: string };
    collections: Array<{ id: string; label: string }>;
    requiredDocuments: Array<{
      id: string;
      documentType: string;
      documentLabel: string;
      severity: string;
      message: string;
      conditional: boolean;
    }>;
    documentTypes: Array<{
      id: string;
      label: string;
      description: string;
      fields: Array<{
        path: string;
        label: string;
        type: string;
        required: boolean;
        aliases: string[];
      }>;
    }>;
    baselineRules: Array<{
      id: string;
      title: string;
      description: string;
      severity: string;
    }>;
    policyRules: Array<{
      id: string;
      title: string;
      description: string;
      severity: string;
      collectionId: string;
      policyVersion: string;
    }>;
  };
}

type RuleDialogState = { kind: 'baseline' } | { kind: 'collection'; collectionId: string } | null;

interface DomainPackLoad {
  tenantId: string;
  state: 'ready' | 'error';
  domainPack: DomainPackConfiguration | null;
  error: string;
}

const COLLECTIONS: Record<string, ReadonlyArray<{ id: string; label: string }>> = {
  tenant_demo: [
    { id: 'supplier-qualification', label: 'Supplier qualification' },
    { id: 'pharmaceutical-distribution', label: 'Pharmaceutical distribution' },
    { id: 'insurance', label: 'Insurance requirements' },
    { id: 'data-protection', label: 'Data protection' },
  ],
  tenant_legal: [{ id: 'commercial-contract-review-policy', label: 'Commercial contract policy' }],
  tenant_insurance: [
    { id: 'insurance-claims-assessment-policy', label: 'Claims assessment policy' },
  ],
  tenant_manufacturing: [
    { id: 'supplier-quality-assurance-policy', label: 'Supplier quality policy' },
  ],
};

export function PolicyLibrary({ tenants }: { tenants: readonly TestTenant[] }) {
  const [items, setItems] = useState<PolicySummary[]>([]);
  const [tenantId, setTenantId] = useState(tenants[0]?.id ?? '');
  const [state, setState] = useState<'loading' | 'ready' | 'submitting'>('loading');
  const [message, setMessage] = useState('');
  const [domainPackLoad, setDomainPackLoad] = useState<DomainPackLoad | null>(null);
  const [ruleDialog, setRuleDialog] = useState<RuleDialogState>(null);
  const ruleDialogRef = useRef<HTMLDialogElement>(null);
  const currentDomainPackLoad = domainPackLoad?.tenantId === tenantId ? domainPackLoad : null;
  const domainPack = currentDomainPackLoad?.domainPack ?? null;
  const domainPackState: 'loading' | 'ready' | 'error' = !tenantId
    ? 'ready'
    : (currentDomainPackLoad?.state ?? 'loading');
  const domainPackError = currentDomainPackLoad?.error ?? '';
  const selectedTenant = tenants.find((tenant) => tenant.id === tenantId);
  const tenantItems = items.filter((item) => item.tenantId === tenantId);
  const selectedCollection = domainPack?.domainPack.collections.find(
    (collection) => ruleDialog?.kind === 'collection' && collection.id === ruleDialog.collectionId,
  );
  const selectedCollectionRules = selectedCollection
    ? (domainPack?.domainPack.policyRules.filter(
        (rule) => rule.collectionId === selectedCollection.id,
      ) ?? [])
    : [];
  const load = useCallback(async () => {
    const response = await fetch('/api/policies', { cache: 'no-store' });
    const body = await response.json().catch(() => ({ items: [] }));
    if (!response.ok) throw new Error(body.message ?? 'Could not load policies.');
    setItems(body.items ?? []);
    setState('ready');
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      void load().catch((error: Error) => {
        setMessage(error.message);
        setState('ready');
      });
    }, 0);
    return () => clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
    void fetch(`/api/policies/domain-pack?tenantId=${encodeURIComponent(tenantId)}`, {
      cache: 'no-store',
    })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.message ?? 'Could not load the domain pack.');
        if (!cancelled) {
          setDomainPackLoad({
            tenantId,
            state: 'ready',
            domainPack: body as DomainPackConfiguration,
            error: '',
          });
        }
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setDomainPackLoad({
            tenantId,
            state: 'error',
            domainPack: null,
            error: error.message,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  useEffect(() => {
    const dialog = ruleDialogRef.current;
    if (!dialog) return;
    if (!ruleDialog) {
      if (dialog.open) dialog.close();
      return;
    }
    if (!dialog.open) dialog.showModal();
    const onClose = () => setRuleDialog(null);
    dialog.addEventListener('close', onClose);
    return () => dialog.removeEventListener('close', onClose);
  }, [ruleDialog]);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState('submitting');
    setMessage('Uploading the immutable source and adding processing to the queue…');
    const form = new FormData(event.currentTarget);
    const tenantId = String(form.get('tenantId'));
    form.set('domainPackId', `pack_${tenantId}`);
    const response = await fetch('/api/policies', {
      method: 'POST',
      body: form,
      headers: { 'idempotency-key': crypto.randomUUID() },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setMessage(body.message ?? 'Policy upload failed.');
      setState('ready');
      return;
    }
    setMessage('Policy accepted. Its private processing timeline is available in notifications.');
    event.currentTarget.reset();
    await load();
  }

  return (
    <main id="main-content" className="policy-shell">
      <section className="policy-hero">
        <div>
          <span className="policy-eyebrow">
            <ShieldCheck size={15} /> Governed source library
          </span>
          <h1>Policies become evidence before they become rules.</h1>
          <p>
            Upload an immutable PDF, inspect every extracted clause, then approve only cited and
            tested rule proposals.
          </p>
        </div>
        <div className="policy-hero-mark" aria-hidden="true">
          <BookOpenCheck />
          <strong>{tenantItems.length}</strong>
          <span>policy versions</span>
        </div>
      </section>
      <section className="policy-rule-guide" aria-labelledby="policy-rule-guide-title">
        <div className="policy-rule-guide-mark" aria-hidden="true">
          <Braces size={22} />
        </div>
        <div>
          <span className="policy-eyebrow">Rule coverage</span>
          <h2 id="policy-rule-guide-title">What can become a rule</h2>
          <p>
            The engine turns cited policy language into conditions for values, presence, dates,
            amounts, allowed values, text or list content, and all/any/not combinations.
          </p>
        </div>
        <ul aria-label="Supported policy condition categories">
          <li>
            <strong>Evidence</strong>
            <span>Present, missing, or contains required content</span>
          </li>
          <li>
            <strong>Values</strong>
            <span>Equals, differs, or belongs to an allowed set</span>
          </li>
          <li>
            <strong>Time &amp; limits</strong>
            <span>Before/after dates and numeric thresholds</span>
          </li>
          <li>
            <strong>Combinations</strong>
            <span>All, any, and explicit exceptions</span>
          </li>
        </ul>
        <p className="policy-rule-guide-gate">
          <BadgeCheck size={16} aria-hidden="true" /> Exact PDF citation + four deterministic checks
          are required before approval.
        </p>
      </section>
      <section
        className="domain-pack-panel"
        aria-labelledby="domain-pack-title"
        data-testid="domain-pack-configuration"
      >
        <header className="domain-pack-heading">
          <div className="domain-pack-mark" aria-hidden="true">
            <FileCheck2 size={22} />
          </div>
          <div>
            <span className="policy-eyebrow">Fixed review vocabulary</span>
            <h2 id="domain-pack-title">What a policy may become</h2>
            <p>
              This setup names the evidence and facts a policy may constrain. It does not create
              policy-derived rules; each new rule must come from a cited source clause.
            </p>
          </div>
          <div className="domain-pack-identity" aria-live="polite">
            <strong>{selectedTenant?.name ?? 'Workspace'}</strong>
            <span>
              {domainPack
                ? `${domainPack.domainPack.name} · v${domainPack.domainPack.version}`
                : 'Loading baseline…'}
            </span>
          </div>
        </header>
        {domainPackState === 'loading' ? (
          <p className="domain-pack-loading">Loading the tenant-specific evidence contract…</p>
        ) : domainPackState === 'error' ? (
          <p className="domain-pack-loading domain-pack-error" role="alert">
            {domainPackError}
          </p>
        ) : domainPack ? (
          <>
            <ol className="domain-pack-flow" aria-label="How policy text becomes an active rule">
              <li>
                <span>01</span>
                <div>
                  <strong>Read source policy</strong>
                  <p>Extract clauses from the uploaded PDF.</p>
                </div>
              </li>
              <li>
                <span>02</span>
                <div>
                  <strong>Propose new condition</strong>
                  <p>Use the vocabulary below and exact citations.</p>
                </div>
              </li>
              <li>
                <span>03</span>
                <div>
                  <strong>Review and activate</strong>
                  <p>Only approved proposals affect case reviews.</p>
                </div>
              </li>
            </ol>
            <div className="domain-pack-grid">
              <article className="domain-pack-section">
                <div className="domain-pack-section-heading">
                  <ShieldCheck aria-hidden="true" size={16} />
                  <div>
                    <h3>Evidence gates</h3>
                    <p>Missing-document checks. They are not extracted policy rules.</p>
                  </div>
                </div>
                <ul className="domain-requirements">
                  {domainPack.domainPack.requiredDocuments.map((requirement) => (
                    <li key={requirement.id}>
                      <span className={`policy-status policy-status-${requirement.severity}`}>
                        {requirement.conditional ? 'conditional' : 'mandatory'}
                      </span>
                      <div>
                        <strong>{requirement.documentLabel}</strong>
                        <p>{requirement.message}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </article>
              <details className="domain-pack-section domain-fact-vocabulary">
                <summary>
                  <div className="domain-pack-section-heading">
                    <Braces aria-hidden="true" size={16} />
                    <div>
                      <h3>Fact vocabulary</h3>
                      <p>Fields a cited clause may constrain. A field is not a rule by itself.</p>
                    </div>
                  </div>
                  <span className="domain-fact-toggle">
                    <span className="domain-fact-toggle-show">Show fields</span>
                    <span className="domain-fact-toggle-hide">Hide fields</span>
                  </span>
                </summary>
                <div className="domain-document-types">
                  {domainPack.domainPack.documentTypes.map((documentType) => (
                    <section key={documentType.id}>
                      <strong>{documentType.label}</strong>
                      <p>{documentType.description}</p>
                      <ul>
                        {documentType.fields.map((field) => (
                          <li key={field.path}>
                            <code>{field.path}</code>
                            <span>
                              {field.required ? 'required' : 'optional'} · {field.type}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
              </details>
              <article className="domain-pack-section domain-pack-rules">
                <div className="domain-pack-section-heading">
                  <ListChecks aria-hidden="true" size={16} />
                  <div>
                    <h3>Installed controls</h3>
                    <p>Known checks that already run before any policy is uploaded.</p>
                  </div>
                </div>
                <p className="domain-pack-rule-summary">
                  {domainPack.domainPack.baselineRules.length} fixed controls are active in this
                  workspace.
                </p>
                <button
                  type="button"
                  className="domain-pack-rule-action"
                  onClick={() => setRuleDialog({ kind: 'baseline' })}
                >
                  View installed controls
                </button>
              </article>
              <article className="domain-pack-section domain-pack-collections">
                <div className="domain-pack-section-heading">
                  <BookOpenCheck aria-hidden="true" size={16} />
                  <div>
                    <h3>Policy collections</h3>
                    <p>Source-policy channels. Open one to see rules discovered from its PDFs.</p>
                  </div>
                </div>
                <div className="domain-collection-list">
                  {domainPack.domainPack.collections.map((collection) => (
                    <button
                      type="button"
                      key={collection.id}
                      onClick={() =>
                        setRuleDialog({ kind: 'collection', collectionId: collection.id })
                      }
                    >
                      <span>{collection.label}</span>
                      <small>
                        {
                          domainPack.domainPack.policyRules.filter(
                            (rule) => rule.collectionId === collection.id,
                          ).length
                        }{' '}
                        policy rules
                      </small>
                    </button>
                  ))}
                </div>
              </article>
            </div>
          </>
        ) : null}
      </section>
      <dialog
        ref={ruleDialogRef}
        aria-labelledby="collection-rule-dialog-title"
        className="domain-rule-dialog"
        onCancel={(event) => {
          event.preventDefault();
          setRuleDialog(null);
        }}
      >
        <header>
          <div>
            <span className="policy-eyebrow">Collection rulebook</span>
            <h2 id="collection-rule-dialog-title">
              {ruleDialog?.kind === 'baseline'
                ? 'Installed controls'
                : selectedCollection
                  ? `Rules discovered from ${selectedCollection.label}`
                  : 'Policy-derived rules'}
            </h2>
            <p>
              {ruleDialog?.kind === 'baseline'
                ? 'These fixed checks are part of the workspace configuration. Uploading a policy does not recreate them.'
                : 'Every rule here originated in an uploaded policy PDF, has an exact citation, and was approved before activation.'}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close collection rules"
            onClick={() => setRuleDialog(null)}
          >
            <X size={17} aria-hidden="true" />
          </button>
        </header>
        {ruleDialog?.kind === 'baseline' && domainPack ? (
          <ul className="domain-rule-dialog-list">
            {domainPack.domainPack.baselineRules.map((rule) => (
              <li key={rule.id}>
                <span className={`policy-status policy-status-${rule.severity}`}>
                  {rule.severity}
                </span>
                <div>
                  <strong>{rule.title}</strong>
                  <p>{rule.description}</p>
                  <small>Fixed workspace control</small>
                </div>
              </li>
            ))}
          </ul>
        ) : selectedCollectionRules.length ? (
          <ul className="domain-rule-dialog-list">
            {selectedCollectionRules.map((rule) => (
              <li key={rule.id}>
                <span className={`policy-status policy-status-${rule.severity}`}>
                  {rule.severity}
                </span>
                <div>
                  <strong>{rule.title}</strong>
                  <p>{rule.description}</p>
                  <small>Approved policy · v{rule.policyVersion}</small>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="domain-rule-dialog-empty">
            <strong>No policy-derived rules are active in this collection yet.</strong>
            <p>
              Upload a policy version, then review its cited proposals. An approved proposal only
              appears here after its policy version is activated.
            </p>
          </div>
        )}
      </dialog>
      <div className="policy-grid">
        <section className="policy-card policy-upload-card">
          <header>
            <FileUp aria-hidden="true" />
            <div>
              <h2>Add policy version</h2>
              <p>PDF · 15 MB maximum · English, German, or mixed</p>
            </div>
          </header>
          <form onSubmit={upload} className="policy-form">
            <label>
              Workspace
              <select
                name="tenantId"
                value={tenantId}
                onChange={(event) => {
                  setRuleDialog(null);
                  setTenantId(event.target.value);
                }}
              >
                {tenants.map((tenant) => (
                  <option key={tenant.id} value={tenant.id}>
                    {tenant.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Policy title
              <input
                name="title"
                required
                minLength={2}
                placeholder="Supplier insurance requirements"
              />
            </label>
            <div className="policy-form-row">
              <label>
                Version
                <input name="policyVersion" required placeholder="3.0" />
              </label>
              <label>
                Collection
                <select name="collectionId" key={tenantId}>
                  {(COLLECTIONS[tenantId] ?? []).map((collection) => (
                    <option key={collection.id} value={collection.id}>
                      {collection.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="policy-form-row">
              <label>
                Valid from
                <input
                  name="validFrom"
                  required
                  type="date"
                  defaultValue={new Date().toISOString().slice(0, 10)}
                />
              </label>
              <label>
                Language
                <select name="language" defaultValue="de,en">
                  <option value="de,en">German + English</option>
                  <option value="de">German</option>
                  <option value="en">English</option>
                </select>
              </label>
            </div>
            <label className="policy-file">
              Original PDF
              <input name="file" type="file" accept="application/pdf,.pdf" required />
            </label>
            <button className="policy-primary" disabled={state === 'submitting'}>
              {state === 'submitting' ? 'Adding to queue…' : 'Upload and process'}
            </button>
          </form>
          {message ? (
            <p className="policy-message" role="status">
              {message}
            </p>
          ) : null}
        </section>
        <section className="policy-card policy-list-card">
          <header>
            <BookOpenCheck aria-hidden="true" />
            <div>
              <h2>Policy register</h2>
              <p>Immutable versions and their governance state</p>
            </div>
          </header>
          {state === 'loading' ? (
            <p className="policy-empty">Loading policy register…</p>
          ) : tenantItems.length ? (
            <div className="policy-list">
              {tenantItems.map((policy) => (
                <Link href={`/policies/${policy.id}`} key={policy.id} className="policy-row">
                  <span className={`policy-status policy-status-${policy.status}`}>
                    {policy.status.replaceAll('_', ' ')}
                  </span>
                  <strong>{policy.title}</strong>
                  <span>
                    {policy.policyVersion} · {policy.collectionId}
                  </span>
                  <small>
                    {policy.tenantId} · {policy.pageCount ?? '—'} pages
                  </small>
                </Link>
              ))}
            </div>
          ) : (
            <p className="policy-empty">
              No policy sources for {selectedTenant?.name ?? 'this workspace'} yet. Upload the first
              version to start the governed workflow.
            </p>
          )}
        </section>
      </div>
    </main>
  );
}
