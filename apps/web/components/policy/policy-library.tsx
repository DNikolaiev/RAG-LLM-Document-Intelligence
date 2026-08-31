'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { BookOpenCheck, FileUp, ShieldCheck } from 'lucide-react';
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
          <strong>{items.length}</strong>
          <span>policy versions</span>
        </div>
      </section>
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
                onChange={(event) => setTenantId(event.target.value)}
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
          ) : items.length ? (
            <div className="policy-list">
              {items.map((policy) => (
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
              No policy sources yet. Upload the first version to start the governed workflow.
            </p>
          )}
        </section>
      </div>
    </main>
  );
}
