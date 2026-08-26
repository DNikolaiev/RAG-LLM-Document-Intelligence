# Domain-pack authoring

Start by naming the business decision, not the documents. Define the subject/entity, required evidence, reviewer roles, final outcomes, and the facts that deterministically affect those outcomes. Then add document types and extraction schemas that can supply those facts.

A pack contains only validated JSON: terminology, document taxonomy, extraction schemas, policy metadata, thresholds, condition-DSL rules, severity mapping, decision mapping, confidence thresholds, and reviewer checklists. It cannot run JavaScript, access files, call networks, or choose a model vendor.

Before activation:

1. Validate the pack schema and references.
2. Run clean, missing, contradictory, expired, low-confidence, and malformed fixtures.
3. Confirm that every material fact/finding has an evidence requirement.
4. Review time-zone and inclusivity semantics for dates.
5. Compare expected decisions with subject-matter expert labels.
6. Activate a new immutable semantic version; never rewrite a version used by a historical case.

For legal review, replace supplier document types with contracts, exhibits, precedents, and playbooks. For insurance, use submissions, loss runs, policies, and underwriting guides. For manufacturing, use specifications, certificates, PPAP evidence, and quality procedures. The workflow and provider ports do not change.
