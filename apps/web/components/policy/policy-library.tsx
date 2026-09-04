'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  BadgeCheck,
  BookOpenCheck,
  Braces,
  Building2,
  ExternalLink,
  FileCheck2,
  FileUp,
  GitMerge,
  Hourglass,
  ListChecks,
  ShieldCheck,
} from 'lucide-react';
import type {
  DomainPackConfiguration,
  FieldProposal,
  RegistryCollection,
  RegistryRule,
  TestTenant,
} from '@caselens/contracts';

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

interface RuleCollectionGroup {
  id: string;
  label: string;
  rules: RegistryRule[];
}

interface DomainPackLoad {
  tenantId: string;
  state: 'ready' | 'error';
  domainPack: DomainPackConfiguration | null;
  error: string;
}

interface FieldProposalsLoad {
  tenantId: string;
  state: 'ready' | 'error';
  items: FieldProposal[];
  error: string;
}

function groupRulesByCollection(
  collections: readonly RegistryCollection[],
  rules: readonly RegistryRule[],
): RuleCollectionGroup[] {
  const groups = new Map<string, RuleCollectionGroup>(
    collections.map((collection) => [
      collection.id,
      { id: collection.id, label: collection.label, rules: [] },
    ]),
  );
  for (const rule of rules) {
    const group = groups.get(rule.collectionId);
    if (group) {
      group.rules.push(rule);
      continue;
    }
    groups.set(rule.collectionId, {
      id: rule.collectionId,
      label: rule.collectionId,
      rules: [rule],
    });
  }
  return [...groups.values()];
}

/**
 * The one `<option>` value in the collection select that is not a collection id. It never leaves
 * the browser: `upload()` translates it into a `newCollectionLabel` field instead of sending it
 * as a `collectionId` the API would refuse.
 */
const CREATE_COLLECTION = '__create__';

export function PolicyLibrary({
  tenants,
  administrator,
}: {
  tenants: readonly TestTenant[];
  administrator: boolean;
}) {
  const [items, setItems] = useState<PolicySummary[]>([]);
  const [tenantId, setTenantId] = useState(tenants[0]?.id ?? '');
  const [state, setState] = useState<'loading' | 'ready' | 'submitting'>('loading');
  const [message, setMessage] = useState('');
  const [fileName, setFileName] = useState('');
  const [domainPackLoad, setDomainPackLoad] = useState<DomainPackLoad | null>(null);
  const [fieldProposalsLoad, setFieldProposalsLoad] = useState<FieldProposalsLoad | null>(null);
  const [pendingProposalId, setPendingProposalId] = useState('');
  const [collectionSelection, setCollectionSelection] = useState<{
    tenantId: string;
    value: string;
  } | null>(null);
  const [newCollectionName, setNewCollectionName] = useState('');
  const [collectionError, setCollectionError] = useState('');
  const currentDomainPackLoad = domainPackLoad?.tenantId === tenantId ? domainPackLoad : null;
  const domainPack = currentDomainPackLoad?.domainPack ?? null;
  const domainPackState: 'loading' | 'ready' | 'error' = !tenantId
    ? 'ready'
    : (currentDomainPackLoad?.state ?? 'loading');
  const domainPackError = currentDomainPackLoad?.error ?? '';
  const currentFieldProposalsLoad =
    fieldProposalsLoad?.tenantId === tenantId ? fieldProposalsLoad : null;
  const fieldProposalsState: 'loading' | 'ready' | 'error' = !tenantId
    ? 'ready'
    : (currentFieldProposalsLoad?.state ?? 'loading');
  const fieldProposalsError = currentFieldProposalsLoad?.error ?? '';
  const reviewableProposals = (currentFieldProposalsLoad?.items ?? []).filter(
    (proposal) => proposal.status === 'proposed' || proposal.status === 'invalid',
  );
  const pendingReviewCount = reviewableProposals.filter(
    (proposal) => proposal.status === 'proposed',
  ).length;
  const blockedProposalCount = reviewableProposals.length - pendingReviewCount;
  const selectedTenant = tenants.find((tenant) => tenant.id === tenantId);
  const workspaceName = selectedTenant?.name ?? 'Workspace';
  const switchableWorkspaces = tenants.length > 1;
  const tenantItems = items.filter((item) => item.tenantId === tenantId);
  const registryRules = domainPack?.domainPack.rules ?? [];
  const registryGroups = domainPack
    ? groupRulesByCollection(domainPack.domainPack.collections, registryRules)
    : [];
  // The collections a policy may actually be uploaded into, straight from the API. Deliberately
  // NOT `domainPack.collections`, which is the rule registry's display grouping and can include
  // the synthetic `general-controls` bucket that no upload may target.
  const uploadableCollections = domainPack?.domainPack.uploadableCollections ?? [];
  const collectionsReady = domainPackState === 'ready' && Boolean(domainPack);
  // Derived during render and keyed by tenant, the way `domainPackLoad` and `fieldProposalsLoad`
  // are, so switching workspace falls back to that workspace's own first collection instead of
  // carrying over a selection that does not exist there. A stored id the pack no longer declares
  // falls back the same way.
  const chosenCollection =
    collectionSelection?.tenantId === tenantId ? collectionSelection.value : '';
  const selectedCollection =
    chosenCollection === CREATE_COLLECTION ||
    uploadableCollections.some((collection) => collection.id === chosenCollection)
      ? chosenCollection
      : (uploadableCollections[0]?.id ?? CREATE_COLLECTION);
  const creatingCollection = selectedCollection === CREATE_COLLECTION;
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

  /**
   * One domain-pack read, shaped into the keyed record the panel renders from. Never throws, so
   * both callers - the effect below and `upload()`, which re-reads the pack after an attempt that
   * may have minted a collection - handle success and failure the same way.
   */
  const readDomainPack = useCallback(async (forTenantId: string): Promise<DomainPackLoad> => {
    try {
      const response = await fetch(
        `/api/policies/domain-pack?tenantId=${encodeURIComponent(forTenantId)}`,
        { cache: 'no-store' },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message ?? 'Could not load the domain pack.');
      return {
        tenantId: forTenantId,
        state: 'ready',
        domainPack: body as DomainPackConfiguration,
        error: '',
      };
    } catch (error) {
      return {
        tenantId: forTenantId,
        state: 'error',
        domainPack: null,
        error: (error as Error).message,
      };
    }
  }, []);

  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
    void readDomainPack(tenantId).then((load) => {
      if (!cancelled) setDomainPackLoad(load);
    });
    return () => {
      cancelled = true;
    };
  }, [tenantId, readDomainPack]);

  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
    void fetch(`/api/policies/field-proposals?tenantId=${encodeURIComponent(tenantId)}`, {
      cache: 'no-store',
    })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.message ?? 'Could not load field proposals.');
        if (!cancelled) {
          setFieldProposalsLoad({
            tenantId,
            state: 'ready',
            items: (body.items ?? []) as FieldProposal[],
            error: '',
          });
        }
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setFieldProposalsLoad({
            tenantId,
            state: 'error',
            items: [],
            error: error.message,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  // Everything below the switcher is tenant scoped. The keyed domain-pack and field-proposal
  // loads fall back to their loading state on their own, so only the state that is not keyed by
  // tenant has to be dropped here: an in-flight proposal decision and a message about the
  // workspace the reader just left.
  function selectWorkspace(nextTenantId: string) {
    if (nextTenantId === tenantId) return;
    setTenantId(nextTenantId);
    setPendingProposalId('');
    setMessage('');
    setNewCollectionName('');
    setCollectionError('');
  }

  async function decideFieldProposal(proposal: FieldProposal, decision: 'approve' | 'reject') {
    const priorLoad = currentFieldProposalsLoad;
    if (!priorLoad || pendingProposalId) return;
    setPendingProposalId(proposal.id);
    setFieldProposalsLoad({
      ...priorLoad,
      items: priorLoad.items.filter((item) => item.id !== proposal.id),
    });
    const response = await fetch(`/api/policies/field-proposals/${proposal.id}/${decision}`, {
      method: 'POST',
      headers: { 'idempotency-key': crypto.randomUUID() },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setFieldProposalsLoad(priorLoad);
      setMessage(body.message ?? `Could not ${decision} the field proposal.`);
      setPendingProposalId('');
      return;
    }
    setMessage(
      decision === 'approve'
        ? proposal.kind === 'alias'
          ? `Wording merged into ${proposal.path} · pack v${body.semanticVersion ?? '—'}.`
          : `Field approved · pack v${body.semanticVersion ?? '—'}.`
        : 'Field proposal rejected.',
    );
    setPendingProposalId('');
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Captured before the first await: React nulls `event.currentTarget` after dispatch.
    const formElement = event.currentTarget;
    const newCollectionLabel = newCollectionName.trim();
    if (creatingCollection && !newCollectionLabel) {
      setCollectionError('Name the new collection before uploading into it.');
      return;
    }
    setCollectionError('');
    setState('submitting');
    setMessage('Uploading the immutable source and adding processing to the queue…');
    const form = new FormData(formElement);
    // The page-level workspace switcher owns the tenant; the form no longer asks for it.
    form.set('tenantId', tenantId);
    form.set('domainPackId', `pack_${tenantId}`);
    // Exactly one of the two reaches the API: an existing collection id, or a name to create.
    if (creatingCollection) {
      form.delete('collectionId');
      form.set('newCollectionLabel', newCollectionLabel);
    } else {
      form.set('collectionId', selectedCollection);
      form.delete('newCollectionLabel');
    }
    const response = await fetch('/api/policies', {
      method: 'POST',
      body: form,
      headers: { 'idempotency-key': crypto.randomUUID() },
    });
    const body = await response.json().catch(() => ({}));
    // The API mints the collection before it stores anything, so an attempt that named one may
    // have created it even when the upload itself then failed. Re-reading the pack on BOTH paths
    // is what makes that recoverable in place: the new collection becomes selectable, and the
    // administrator retries into it instead of being told it already exists.
    if (creatingCollection) {
      const reloaded = await readDomainPack(tenantId);
      if (reloaded.state === 'ready') setDomainPackLoad(reloaded);
    }
    if (!response.ok) {
      setMessage(body.message ?? 'Policy upload failed.');
      setState('ready');
      return;
    }
    setMessage(
      creatingCollection
        ? `Collection “${newCollectionLabel}” created and the policy accepted. Its private processing timeline is available in notifications.`
        : 'Policy accepted. Its private processing timeline is available in notifications.',
    );
    formElement.reset();
    setFileName('');
    setNewCollectionName('');
    // Keep the collection the API confirmed this policy landed in selected, so a second version
    // of the same policy does not have to be re-chosen.
    if (typeof body.collectionId === 'string' && body.collectionId) {
      setCollectionSelection({ tenantId, value: body.collectionId });
    }
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
          <div
            className={`domain-pack-identity${switchableWorkspaces ? ' domain-pack-identity-switch' : ''}`}
            data-testid="workspace-switcher"
          >
            {switchableWorkspaces ? (
              <>
                <label className="domain-pack-identity-label" htmlFor="policy-workspace">
                  Workspace{' '}
                  <span className="sr-only">— select the workspace this library describes</span>
                </label>
                <select
                  id="policy-workspace"
                  className="workspace-switcher"
                  value={tenantId}
                  onChange={(event) => selectWorkspace(event.target.value)}
                >
                  {tenants.map((tenant) => (
                    <option key={tenant.id} value={tenant.id}>
                      {tenant.name}
                    </option>
                  ))}
                </select>
              </>
            ) : (
              <>
                <span className="domain-pack-identity-label">Workspace</span>
                <strong>{workspaceName}</strong>
              </>
            )}
            <span className="domain-pack-identity-pack" aria-live="polite">
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
              <section className="domain-pack-section domain-rule-registry">
                <div className="domain-pack-section-heading">
                  <ListChecks aria-hidden="true" size={16} />
                  <div>
                    <h3>Rule registry</h3>
                    <p>
                      Every rule active in this workspace, grouped by policy collection and labelled
                      with the source it came from.
                    </p>
                  </div>
                </div>
                <p className="domain-pack-rule-summary">
                  {registryRules.length} active {registryRules.length === 1 ? 'rule' : 'rules'} in{' '}
                  {registryGroups.length}{' '}
                  {registryGroups.length === 1 ? 'collection' : 'collections'}.
                </p>
                {registryGroups.length ? (
                  <div className="domain-registry-groups">
                    {registryGroups.map((group) => (
                      <section
                        key={group.id}
                        className="domain-registry-group"
                        aria-label={`${group.label} rules`}
                      >
                        <div className="domain-registry-group-heading">
                          <h4>{group.label}</h4>
                          <span className="domain-registry-count">
                            {group.rules.length} {group.rules.length === 1 ? 'rule' : 'rules'}
                          </span>
                        </div>
                        {group.rules.length === 0 ? (
                          <p className="domain-registry-group-empty">
                            No rules yet. Upload and approve a policy in this collection to add one.
                          </p>
                        ) : null}
                        <ul className="domain-registry-rules">
                          {group.rules.map((rule) => (
                            <li key={rule.id}>
                              <div className="domain-registry-tags">
                                <span className={`policy-status policy-status-${rule.severity}`}>
                                  {rule.severity}
                                </span>
                                {rule.origin.kind === 'domain_pack' ? (
                                  <span className="domain-origin domain-origin-system">
                                    SYSTEM DEFAULT
                                  </span>
                                ) : (
                                  <span className="domain-origin domain-origin-policy">
                                    FROM POLICY REGISTER
                                  </span>
                                )}
                              </div>
                              <strong>{rule.title}</strong>
                              <p>{rule.description}</p>
                              {rule.origin.kind === 'domain_pack' ? (
                                <span className="domain-registry-source">
                                  {rule.origin.domainPackName} v{rule.origin.domainPackVersion}
                                </span>
                              ) : (
                                <Link
                                  className="domain-registry-source domain-registry-source-link"
                                  href={`/policies/${rule.origin.policyId}`}
                                >
                                  {rule.origin.policyTitle} · {rule.origin.policyVersion}
                                </Link>
                              )}
                            </li>
                          ))}
                        </ul>
                      </section>
                    ))}
                  </div>
                ) : (
                  <p className="domain-registry-empty">
                    No rules are active in this workspace yet. Upload a policy version, then approve
                    its cited proposals to fill the registry.
                  </p>
                )}
              </section>
              <details className="domain-pack-section domain-pack-disclosure domain-evidence-gates">
                <summary>
                  <div className="domain-pack-section-heading">
                    <ShieldCheck aria-hidden="true" size={16} />
                    <div>
                      <h3>Evidence gates</h3>
                      <p>Missing-document checks. They are not extracted policy rules.</p>
                    </div>
                  </div>
                  <span className="domain-pack-toggle">
                    <span className="domain-pack-toggle-show">Show gates</span>
                    <span className="domain-pack-toggle-hide">Hide gates</span>
                  </span>
                </summary>
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
              </details>
              <details className="domain-pack-section domain-pack-disclosure domain-fact-vocabulary">
                <summary>
                  <div className="domain-pack-section-heading">
                    <Braces aria-hidden="true" size={16} />
                    <div>
                      <h3>Fact vocabulary</h3>
                      <p>Fields a cited clause may constrain. A field is not a rule by itself.</p>
                    </div>
                  </div>
                  <span className="domain-pack-toggle">
                    <span className="domain-pack-toggle-show">Show fields</span>
                    <span className="domain-pack-toggle-hide">Hide fields</span>
                  </span>
                </summary>
                <div className="field-proposal-queue" aria-label="Field proposals awaiting review">
                  <div className="domain-pack-section-heading">
                    <Hourglass aria-hidden="true" size={15} />
                    <div>
                      <h4>Field proposals</h4>
                      <p>
                        Candidates a policy introduced. Nothing here changes extraction until an
                        administrator approves it.
                      </p>
                    </div>
                  </div>
                  {fieldProposalsState === 'loading' ? (
                    <p className="field-proposal-summary">Loading field proposals…</p>
                  ) : fieldProposalsState === 'error' ? (
                    <p className="field-proposal-summary field-proposal-error" role="alert">
                      {fieldProposalsError}
                    </p>
                  ) : (
                    <>
                      <p className="field-proposal-summary">
                        {pendingReviewCount} {pendingReviewCount === 1 ? 'proposal' : 'proposals'}{' '}
                        awaiting review
                        {blockedProposalCount
                          ? `, ${blockedProposalCount} blocked by validation`
                          : ''}
                        .
                      </p>
                      {reviewableProposals.length ? (
                        <div className="field-proposal-list">
                          {reviewableProposals.map((proposal) => {
                            const documentTypeLabel =
                              domainPack.domainPack.documentTypes.find(
                                (documentType) => documentType.id === proposal.documentTypeId,
                              )?.label ?? proposal.documentTypeId;
                            return (
                              <article className="field-proposal-card" key={proposal.id}>
                                <div className="field-proposal-heading">
                                  <strong>
                                    {proposal.kind === 'alias'
                                      ? `New wording for ${proposal.label}`
                                      : proposal.label}
                                  </strong>
                                  <div className="domain-registry-tags">
                                    <span
                                      className={`policy-status policy-status-${proposal.status}`}
                                    >
                                      {proposal.status.replaceAll('_', ' ')}
                                    </span>
                                    <span className="domain-origin domain-origin-pending">
                                      AWAITING GOVERNANCE
                                    </span>
                                  </div>
                                </div>
                                <p className="field-proposal-path">
                                  <code>{proposal.path}</code>
                                  <span>{proposal.fieldType}</span>
                                  <small>{documentTypeLabel}</small>
                                </p>
                                {proposal.kind === 'alias' ? (
                                  <div className="field-proposal-merge" role="note">
                                    <GitMerge size={14} aria-hidden="true" />
                                    <div>
                                      <strong>
                                        Merges into{' '}
                                        <code>{proposal.dedup.matchedPath ?? proposal.path}</code>
                                      </strong>
                                      <span>
                                        {typeof proposal.dedup.similarity === 'number'
                                          ? `${Math.round(proposal.dedup.similarity * 100)}% similarity match`
                                          : 'Similarity unavailable'}
                                        {proposal.dedup.reason ? ` — ${proposal.dedup.reason}` : ''}
                                      </span>
                                    </div>
                                  </div>
                                ) : null}
                                {proposal.aliases.length ? (
                                  <p className="field-proposal-aliases">
                                    <strong>
                                      {proposal.kind === 'alias'
                                        ? 'Adds the wording'
                                        : 'Also known as'}
                                    </strong>{' '}
                                    {proposal.aliases.join(', ')}
                                  </p>
                                ) : null}
                                <blockquote className="field-proposal-quote">
                                  “{proposal.citation.quote}”
                                </blockquote>
                                <div className="field-proposal-meta">
                                  <span>Page {proposal.citation.page}</span>
                                  <Link href={`/policies/${proposal.policyDocumentId}`}>
                                    Open source policy
                                    <ExternalLink size={12} aria-hidden="true" />
                                  </Link>
                                </div>
                                {proposal.status === 'invalid' && proposal.issues.length ? (
                                  <ul
                                    className="field-proposal-issues"
                                    aria-label="Why this proposal cannot be approved"
                                  >
                                    {proposal.issues.map((issue, index) => (
                                      <li key={`${issue.code}-${index}`}>{issue.message}</li>
                                    ))}
                                  </ul>
                                ) : null}
                                {administrator && proposal.status === 'proposed' ? (
                                  <div className="field-proposal-actions">
                                    <button
                                      type="button"
                                      className="policy-secondary"
                                      disabled={pendingProposalId !== ''}
                                      onClick={() => void decideFieldProposal(proposal, 'reject')}
                                    >
                                      Reject
                                    </button>
                                    <button
                                      type="button"
                                      className="policy-primary"
                                      disabled={pendingProposalId !== ''}
                                      onClick={() => void decideFieldProposal(proposal, 'approve')}
                                    >
                                      {proposal.kind === 'alias'
                                        ? 'Approve merge'
                                        : 'Approve field'}
                                    </button>
                                  </div>
                                ) : null}
                              </article>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="field-proposal-empty">
                          No field proposals are waiting on review.
                        </p>
                      )}
                    </>
                  )}
                </div>
                <p className="domain-pack-rule-summary field-proposal-catalog-label">
                  Approved fields
                </p>
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
            </div>
          </>
        ) : null}
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
            <p className="policy-upload-scope">
              <Building2 size={15} aria-hidden="true" />
              <span>
                <span>
                  Uploading into <strong>{workspaceName}</strong>
                </span>
                {switchableWorkspaces ? (
                  <small>Change it with the workspace switcher above.</small>
                ) : null}
              </span>
            </p>
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
              {/* `for`/`id` rather than a wrapping label, like the workspace switcher above: a
                  select nested inside its own label drags its option text into the label's text
                  content, so the accessible name stops being just "Collection". The value is
                  derived per tenant during render, so the control also needs no per-tenant key
                  to forget the workspace the reader just left. */}
              <div className="policy-form-field">
                <label htmlFor="policy-collection">Collection</label>
                <select
                  id="policy-collection"
                  name="collectionId"
                  value={collectionsReady ? selectedCollection : ''}
                  disabled={!collectionsReady}
                  onChange={(event) => {
                    setCollectionSelection({ tenantId, value: event.target.value });
                    setCollectionError('');
                  }}
                >
                  {collectionsReady ? (
                    [
                      ...uploadableCollections.map((collection) => (
                        <option key={collection.id} value={collection.id}>
                          {collection.label}
                        </option>
                      )),
                      <option key={CREATE_COLLECTION} value={CREATE_COLLECTION}>
                        Create a new collection…
                      </option>,
                    ]
                  ) : (
                    <option value="">
                      {domainPackState === 'error'
                        ? 'Collections unavailable'
                        : 'Loading collections…'}
                    </option>
                  )}
                </select>
              </div>
            </div>
            {collectionsReady && creatingCollection ? (
              <div className="policy-form-field">
                <label htmlFor="policy-new-collection">New collection name</label>
                <input
                  id="policy-new-collection"
                  name="newCollectionLabel"
                  value={newCollectionName}
                  maxLength={80}
                  placeholder="Product recall handling"
                  aria-invalid={collectionError ? true : undefined}
                  aria-describedby={collectionError ? 'policy-collection-error' : undefined}
                  onChange={(event) => {
                    setNewCollectionName(event.target.value);
                    if (collectionError) setCollectionError('');
                  }}
                />
                {collectionError ? (
                  <p className="policy-field-error" id="policy-collection-error" role="alert">
                    {collectionError}
                  </p>
                ) : (
                  <p className="policy-collection-hint">
                    Created in this workspace as a new domain-pack version, then used for this
                    upload.
                  </p>
                )}
              </div>
            ) : null}
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
              <span className="policy-file-control">
                <span className="policy-file-button" aria-hidden="true">
                  <FileUp size={13} /> Choose PDF
                </span>
                <span className="policy-file-name" aria-hidden="true">
                  {fileName || 'No file selected'}
                </span>
              </span>
              <input
                className="policy-file-input"
                name="file"
                type="file"
                accept="application/pdf,.pdf"
                required
                onChange={(event) => setFileName(event.target.files?.[0]?.name ?? '')}
              />
            </label>
            <button
              className="policy-primary"
              disabled={state === 'submitting' || !collectionsReady}
            >
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
