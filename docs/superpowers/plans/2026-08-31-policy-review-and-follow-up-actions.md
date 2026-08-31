# Policy review and follow-up actions implementation plan

## Outcome

Unblock policy governance and case follow-up workflows without weakening validation:

- reviewers can see every generated rule, understand exactly why a rule test passed or failed, approve valid rules, and dismiss blocked rules;
- selecting a citation opens the corresponding PDF page and highlights the cited clause;
- accepted case findings form one business-tone information request;
- a known document contact opens a prefilled email draft, while missing contact data falls back to a copyable request;
- Playwright covers the notification bell plus both repaired workflows.

## Implementation

1. Extend policy proposal transitions so an invalid proposal can be dismissed, while approval remains restricted to validated proposals.
2. Redesign the policy review cards with an all-rules summary, explicit validation messages, expected-versus-actual test results, and persistent review feedback.
3. Replace the policy iframe with a PDF review surface that navigates to citation pages and highlights the cited text.
4. Add optional case contact metadata and a deterministic follow-up draft builder that includes every finding marked for follow-up.
5. Add a follow-up composer with email and clipboard paths, visible selection state, and actionable success/error feedback.
6. Add focused unit and Playwright tests, then run typecheck, lint, unit, build, and end-to-end verification.

## Guardrails

- Invalid proposals may be dismissed but never approved.
- Tenant and actor scoping remains enforced by the API.
- Request text is generated locally and deterministically; no case data is sent to an additional model.
- Email opening requires a user click and uses an encoded `mailto:` URL.
- The no-contact path always exposes the complete text for manual copying.
