#!/usr/bin/env python3
"""Generate the synthetic policy-lab fixture corpus.

The corpus exercises the policy-upload pipeline end to end for the three
single-document-type tenants (legal, insurance, manufacturing). Each policy PDF
carries one deliberately shaped clause so that a named pipeline outcome is
produced, and each evidence PDF states the facts an approved rule tests.

Nothing here is real: every organisation, person, reference, and value is
invented for testing. Generation is byte stable, so two consecutive runs produce
identical SHA-256 values.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from pypdf import PdfReader
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "fixtures" / "documents" / "policy-lab"
MANIFEST_NAME = "policy-lab-fixture-pack.json"


def register_fonts() -> None:
    candidates = [
        (Path("C:/Windows/Fonts/arial.ttf"), Path("C:/Windows/Fonts/arialbd.ttf")),
        (
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
        ),
    ]
    for regular, bold in candidates:
        if regular.exists() and bold.exists():
            pdfmetrics.registerFont(TTFont("FixtureSans", str(regular)))
            pdfmetrics.registerFont(TTFont("FixtureSansBold", str(bold)))
            return
    raise RuntimeError("Arial or DejaVu Sans is required to generate PDFs")


register_fonts()
styles = getSampleStyleSheet()
TITLE = ParagraphStyle(
    "FixtureTitle", parent=styles["Title"], fontName="FixtureSansBold", fontSize=22,
    leading=27, textColor=colors.HexColor("#172554"), spaceAfter=6,
)
SUBTITLE = ParagraphStyle(
    "FixtureSubtitle", parent=styles["Normal"], fontName="FixtureSans", fontSize=9,
    leading=13, textColor=colors.HexColor("#475569"), spaceAfter=16,
)
HEADING = ParagraphStyle(
    "FixtureHeading", parent=styles["Heading2"], fontName="FixtureSansBold", fontSize=11,
    leading=15, textColor=colors.HexColor("#0f766e"), spaceBefore=10, spaceAfter=5,
)
BODY = ParagraphStyle(
    "FixtureBody", parent=styles["BodyText"], fontName="FixtureSans", fontSize=10,
    leading=15, textColor=colors.HexColor("#1e293b"), spaceAfter=7,
)


def cell(value: str, bold: bool = False) -> Paragraph:
    return Paragraph(value, ParagraphStyle(
        "FixtureCellBold" if bold else "FixtureCell", parent=BODY,
        fontName="FixtureSansBold" if bold else "FixtureSans", fontSize=8.8, leading=12,
        spaceAfter=0,
    ))


class InvariantCanvas(canvas.Canvas):
    """ReportLab canvas with stable metadata and document IDs across runs."""

    def __init__(self, *args, **kwargs):
        kwargs["invariant"] = 1
        super().__init__(*args, **kwargs)


def write_pdf(
    output_dir: Path,
    relative: str,
    tenant_id: str,
    kind: str,
    collection_id: str,
    outcome: str,
    title: str,
    subtitle: str,
    sections: list[tuple[str, list[str]]],
    fields: list[tuple[str, str]],
    expected_pages: int,
    expected_phrases: list[str],
    evidence: list[dict[str, object]],
) -> dict:
    target = output_dir / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    doc = SimpleDocTemplate(
        str(target), pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm,
        topMargin=17 * mm, bottomMargin=17 * mm, title=title,
        author="CaseLens synthetic fixture generator",
    )
    story = [Paragraph(title, TITLE), Paragraph(subtitle, SUBTITLE)]
    for heading, paragraphs in sections:
        story.append(Paragraph(heading, HEADING))
        story.extend(Paragraph(paragraph, BODY) for paragraph in paragraphs)
    if fields:
        story.append(Spacer(1, 4))
        header = "Evidence field" if kind == "evidence" else "Policy attribute"
        table = Table([[cell(header, True), cell("Recorded value", True)]] + [[cell(k), cell(v)] for k, v in fields], colWidths=[55 * mm, 105 * mm])
        table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e0f2fe")),
            ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#cbd5e1")),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 7),
            ("RIGHTPADDING", (0, 0), (-1, -1), 7),
            ("TOPPADDING", (0, 0), (-1, -1), 6),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ]))
        story.append(table)
    doc.build(story, canvasmaker=InvariantCanvas)
    data = target.read_bytes()
    pages = len(PdfReader(str(target)).pages)
    if pages != expected_pages:
        raise AssertionError(f"{relative} rendered {pages} page(s), expected {expected_pages}")
    return {
        "filename": relative,
        "tenantId": tenant_id,
        "kind": kind,
        "collectionId": collection_id,
        "outcome": outcome,
        "sha256": hashlib.sha256(data).hexdigest(),
        "bytes": len(data),
        "expectedPages": expected_pages,
        "expectedPhrases": list(expected_phrases),
        "evidence": [dict(item) for item in evidence],
    }


LEGAL_OWNER = [
    ("Policy owner", "Rheinland Legal Services \u00b7 Contract Operations"),
    ("Applies to", "Commercial contract review"),
]
INSURANCE_OWNER = [
    ("Policy owner", "Helios Claims Europe \u00b7 Claims Governance"),
    ("Applies to", "Insurance claims assessment"),
]
MANUFACTURING_OWNER = [
    ("Policy owner", "RuhrWorks Manufacturing \u00b7 Supplier Quality"),
    ("Applies to", "Supplier quality assurance"),
]
POLICY_SUBTITLE = "Synthetic policy fixture \u00b7 Version 1.0 \u00b7 effective 01 January 2026"


DOCUMENTS: list[dict] = [
    # ----------------------------------------------------------------- legal
    # Outcome A. "notice period" is an alias of contract.terminationNoticeDays and the
    # clause states a number, so an approvable numeric comparison is both required and
    # writable. No EUR amount appears, so the currency requirement check stays silent.
    {
        "relative": "legal/01_termination-notice-minimum-policy.pdf",
        "tenant_id": "tenant_legal",
        "kind": "policy",
        "collection_id": "commercial-contract-review-policy",
        "outcome": "A_approvable_rule",
        "title": "Termination Notice Minimum Control",
        "subtitle": POLICY_SUBTITLE,
        "sections": [
            ("1. Notice period floor", [
                "The termination notice period agreed in a commercial contract must be at least ninety (90) days.",
                "A shorter notice period is an exception and is recorded as an approved deviation by contract operations.",
            ]),
            ("2. Scope", [
                "This control covers every agreement prepared for signature by the commercial review team.",
            ]),
        ],
        "fields": LEGAL_OWNER,
        "expected_pages": 1,
        "expected_phrases": [
            "Termination Notice Minimum Control",
            "at least ninety (90) days",
            "Commercial contract review",
        ],
        "evidence": [
            {"page": 1, "phrase": "at least ninety (90) days", "field": "terminationNoticeFloor"},
        ],
    },
    # Outcome C. The clause targets contract.governingLaw but names neither its label
    # ("Governing law") nor its alias ("applicable law"), so grounding must reject it.
    # Nothing else in this document names a catalog field either.
    {
        "relative": "legal/02_jurisdiction-escalation-policy.pdf",
        "tenant_id": "tenant_legal",
        "kind": "policy",
        "collection_id": "commercial-contract-review-policy",
        "outcome": "C_citation_condition_mismatch",
        "title": "Jurisdiction Escalation Control",
        "subtitle": POLICY_SUBTITLE,
        "sections": [
            ("1. Forum escalation", [
                "A commercial agreement must be escalated when it is subject to courts outside Germany.",
                "An agreement is treated as domestic only when Germany is the country whose courts decide a dispute.",
                "Contract operations records the escalation reason in the review file.",
            ]),
            ("2. Scope", [
                "This control covers every agreement prepared for signature by the commercial review team.",
            ]),
        ],
        "fields": LEGAL_OWNER,
        "expected_pages": 1,
        "expected_phrases": [
            "Jurisdiction Escalation Control",
            "subject to courts outside Germany",
            "Commercial contract review",
        ],
        "evidence": [
            {"page": 1, "phrase": "subject to courts outside Germany", "field": "forumEscalation"},
        ],
    },
    # Evidence that satisfies the notice-period floor: 120 days, so the rule must not fire.
    {
        "relative": "legal/03_talwerk_supply_agreement_extract.pdf",
        "tenant_id": "tenant_legal",
        "kind": "evidence",
        "collection_id": "",
        "outcome": "satisfies_A_legal",
        "title": "Talwerk Logistik Supply Agreement",
        "subtitle": "Synthetic case evidence \u00b7 executed extract \u00b7 agreement RLS-CDA-2026-118",
        "sections": [
            ("1. Agreement summary", [
                "This extract records the executed commercial terms agreed between Rheinland Legal Services GmbH and Talwerk Logistik GmbH.",
            ]),
            ("2. Termination", [
                "Either party may terminate this agreement for convenience by giving one hundred and twenty (120) days written notice.",
                "The termination notice period recorded for this agreement is 120 days.",
            ]),
            ("3. Applicable law", [
                "This agreement is governed by German law.",
            ]),
        ],
        "fields": [
            ("Contract parties", "Rheinland Legal Services GmbH; Talwerk Logistik GmbH"),
            ("Termination notice days", "120"),
            ("Governing law", "German law"),
        ],
        "expected_pages": 1,
        "expected_phrases": [
            "Talwerk Logistik Supply Agreement",
            "one hundred and twenty (120) days",
            "German law",
        ],
        "evidence": [
            {"page": 1, "phrase": "one hundred and twenty (120) days", "field": "terminationNoticeDays"},
        ],
    },
    # Evidence that violates the notice-period floor: 45 days, so the rule must fire.
    {
        "relative": "legal/04_ostkante_supply_agreement_extract.pdf",
        "tenant_id": "tenant_legal",
        "kind": "evidence",
        "collection_id": "",
        "outcome": "violates_A_legal",
        "title": "Ostkante Vertrieb Supply Agreement",
        "subtitle": "Synthetic case evidence \u00b7 executed extract \u00b7 agreement RLS-CDA-2026-119",
        "sections": [
            ("1. Agreement summary", [
                "This extract records the executed commercial terms agreed between Rheinland Legal Services GmbH and Ostkante Vertrieb GmbH.",
            ]),
            ("2. Termination", [
                "Either party may terminate this agreement for convenience by giving forty-five (45) days written notice.",
                "The termination notice period recorded for this agreement is 45 days.",
            ]),
            ("3. Applicable law", [
                "This agreement is governed by German law.",
            ]),
        ],
        "fields": [
            ("Contract parties", "Rheinland Legal Services GmbH; Ostkante Vertrieb GmbH"),
            ("Termination notice days", "45"),
            ("Governing law", "German law"),
        ],
        "expected_pages": 1,
        "expected_phrases": [
            "Ostkante Vertrieb Supply Agreement",
            "forty-five (45) days",
            "German law",
        ],
        "evidence": [
            {"page": 1, "phrase": "forty-five (45) days", "field": "terminationNoticeDays"},
        ],
    },

    # ------------------------------------------------------------- insurance
    # Outcome A. "date of loss" is an alias of claim.lossDate and the clause states a
    # calendar cut-off, so a date comparison is required and writable.
    {
        "relative": "insurance/01_loss-date-cutoff-policy.pdf",
        "tenant_id": "tenant_insurance",
        "kind": "policy",
        "collection_id": "insurance-claims-assessment-policy",
        "outcome": "A_approvable_rule",
        "title": "Claim Loss Date Escalation Control",
        "subtitle": POLICY_SUBTITLE,
        "sections": [
            ("1. Loss date cut-off", [
                "A claim must be escalated to senior review when the date of loss is before 01 January 2026.",
                "A date of loss on or after 2026-01-01 stays inside the automated assessment window.",
            ]),
            ("2. Scope", [
                "This control applies to every property claim assessed by the claims governance team.",
            ]),
        ],
        "fields": INSURANCE_OWNER,
        "expected_pages": 1,
        "expected_phrases": [
            "Claim Loss Date Escalation Control",
            "date of loss is before 01 January 2026",
            "Insurance claims assessment",
        ],
        "evidence": [
            {"page": 1, "phrase": "date of loss is before 01 January 2026", "field": "lossDateCutoff"},
        ],
    },
    # Outcome E. "Claim settlement value" is new wording for the existing currency field
    # claim.estimatedCostEur, so the dedup ladder must merge it as an alias rather than
    # mint a second field. The clause carries no threshold, so no rule is expected.
    {
        "relative": "insurance/02_claim-settlement-value-policy.pdf",
        "tenant_id": "tenant_insurance",
        "kind": "policy",
        "collection_id": "insurance-claims-assessment-policy",
        "outcome": "E_alias_proposal",
        "title": "Claim Settlement Value Standard",
        "subtitle": POLICY_SUBTITLE,
        "sections": [
            ("1. Settlement value record", [
                "Every property claim file must record the claim settlement value in euro, being the total amount the insurer expects to pay to return the insured property to its pre-incident condition.",
                "The claim settlement value is entered by the assessor while the claim file is prepared for a settlement decision.",
            ]),
            ("2. Scope", [
                "This standard applies to every property claim assessed by the claims governance team.",
            ]),
        ],
        "fields": INSURANCE_OWNER,
        "expected_pages": 1,
        "expected_phrases": [
            "Claim Settlement Value Standard",
            "record the claim settlement value",
            "Insurance claims assessment",
        ],
        "evidence": [
            {"page": 1, "phrase": "record the claim settlement value", "field": "claimSettlementValue"},
        ],
    },
    # Evidence that satisfies the loss-date cut-off: 2026-05-14, so the rule must not fire.
    # The estimated cost stays below the legacy EUR 10,000 escalation threshold so that no
    # previously activated fixture rule fires alongside it.
    {
        "relative": "insurance/03_lindenhof_claim_evidence.pdf",
        "tenant_id": "tenant_insurance",
        "kind": "evidence",
        "collection_id": "",
        "outcome": "satisfies_A_insurance",
        "title": "Lindenhof Property Claim Evidence",
        "subtitle": "Synthetic case evidence \u00b7 claim HCE-DE-2026-006042",
        "sections": [
            ("1. Claim summary", [
                "Helios Claims Europe assessed a water ingress loss reported for the insured property at Lindenhof.",
            ]),
            ("2. Loss record", [
                "The date of loss recorded for this claim is 2026-05-14.",
                "The policyholder notified the loss on 2026-05-19.",
            ]),
            ("3. Cost record", [
                "The estimated cost of restoring the insured property is 8400 euro.",
                "The claim settlement value agreed with the assessor is 8400 euro.",
            ]),
        ],
        "fields": [
            ("Policy number", "HCE-PROP-771903"),
            ("Loss date", "2026-05-14"),
            ("Estimated cost (EUR)", "8400"),
            ("Claim settlement value (EUR)", "8400"),
        ],
        "expected_pages": 1,
        "expected_phrases": [
            "Lindenhof Property Claim Evidence",
            "recorded for this claim is 2026-05-14",
            "HCE-PROP-771903",
        ],
        "evidence": [
            {"page": 1, "phrase": "recorded for this claim is 2026-05-14", "field": "lossDate"},
        ],
    },
    # Evidence that violates the loss-date cut-off: 2025-11-03, so the rule must fire.
    {
        "relative": "insurance/04_altmarkt_claim_evidence.pdf",
        "tenant_id": "tenant_insurance",
        "kind": "evidence",
        "collection_id": "",
        "outcome": "violates_A_insurance",
        "title": "Altmarkt Property Claim Evidence",
        "subtitle": "Synthetic case evidence \u00b7 claim HCE-DE-2026-006108",
        "sections": [
            ("1. Claim summary", [
                "Helios Claims Europe assessed a storm damage loss reported for the insured property at Altmarkt.",
            ]),
            ("2. Loss record", [
                "The date of loss recorded for this claim is 2025-11-03.",
                "The policyholder notified the loss on 2026-02-17.",
            ]),
            ("3. Cost record", [
                "The estimated cost of restoring the insured property is 9250 euro.",
                "The claim settlement value agreed with the assessor is 9250 euro.",
            ]),
        ],
        "fields": [
            ("Policy number", "HCE-PROP-660184"),
            ("Loss date", "2025-11-03"),
            ("Estimated cost (EUR)", "9250"),
            ("Claim settlement value (EUR)", "9250"),
        ],
        "expected_pages": 1,
        "expected_phrases": [
            "Altmarkt Property Claim Evidence",
            "recorded for this claim is 2025-11-03",
            "HCE-PROP-660184",
        ],
        "evidence": [
            {"page": 1, "phrase": "recorded for this claim is 2025-11-03", "field": "lossDate"},
        ],
    },

    # --------------------------------------------------------- manufacturing
    # Outcome A. The clause names the field label ("material grade") and fixes an allowed
    # set, so a membership comparison is required and writable.
    {
        "relative": "manufacturing/01_approved-grade-list-policy.pdf",
        "tenant_id": "tenant_manufacturing",
        "kind": "policy",
        "collection_id": "supplier-quality-assurance-policy",
        "outcome": "A_approvable_rule",
        "title": "Approved Material Grade Control",
        "subtitle": POLICY_SUBTITLE,
        "sections": [
            ("1. Approved grades", [
                "Supplier quality must route an incoming batch to quality review when the material grade is not one of 1.4404, 1.4571, or 1.4462.",
                "Only a batch whose material grade matches this approved list is released for series production without an engineering deviation.",
            ]),
            ("2. Scope", [
                "This control applies to every incoming batch accepted by supplier quality.",
            ]),
        ],
        "fields": MANUFACTURING_OWNER,
        "expected_pages": 1,
        "expected_phrases": [
            "Approved Material Grade Control",
            "when the material grade is not one of 1.4404",
            "Supplier quality assurance",
        ],
        "evidence": [
            {"page": 1, "phrase": "when the material grade is not one of 1.4404", "field": "approvedGrades"},
        ],
    },
    # Outcome B. The clause names material.heatNumber (so grounding passes) and demands a
    # cross-document match against a report CaseLens holds no fact for, so the only
    # writable condition is presence-only and must be blocked as condition_too_weak.
    {
        "relative": "manufacturing/02_heat-number-cross-check-policy.pdf",
        "tenant_id": "tenant_manufacturing",
        "kind": "policy",
        "collection_id": "supplier-quality-assurance-policy",
        "outcome": "B_condition_too_weak",
        "title": "Heat Number Cross-Check Control",
        "subtitle": POLICY_SUBTITLE,
        "sections": [
            ("1. Cross-check", [
                "The heat number stated on the material certificate must match the heat number recorded on the mill test report issued by the steel producer.",
                "A batch whose heat number does not match the mill test report is held until the producer supplies a corrected report.",
            ]),
            ("2. Scope", [
                "This control applies to every incoming batch accepted by supplier quality.",
            ]),
        ],
        "fields": MANUFACTURING_OWNER,
        "expected_pages": 1,
        "expected_phrases": [
            "Heat Number Cross-Check Control",
            "must match the heat number recorded",
            "Supplier quality assurance",
        ],
        "evidence": [
            {"page": 1, "phrase": "must match the heat number recorded", "field": "heatNumberCrossCheck"},
        ],
    },
    # Outcome D. Tensile strength in megapascals is absent from the pack, so the field
    # stage must mint a new_field proposal grounded in this clause.
    {
        "relative": "manufacturing/03_tensile-strength-policy.pdf",
        "tenant_id": "tenant_manufacturing",
        "kind": "policy",
        "collection_id": "supplier-quality-assurance-policy",
        "outcome": "D_new_field_proposal",
        "title": "Tensile Strength Acceptance Control",
        "subtitle": POLICY_SUBTITLE,
        "sections": [
            ("1. Tensile strength record", [
                "Each material certificate must state the tensile strength of the delivered batch in megapascals (MPa).",
                "A batch whose tensile strength is below 485 MPa is held for an engineering deviation before release.",
            ]),
            ("2. Scope", [
                "This control applies to every incoming batch accepted by supplier quality.",
            ]),
        ],
        "fields": MANUFACTURING_OWNER,
        "expected_pages": 1,
        "expected_phrases": [
            "Tensile Strength Acceptance Control",
            "tensile strength is below 485 MPa",
            "Supplier quality assurance",
        ],
        "evidence": [
            {"page": 1, "phrase": "tensile strength is below 485 MPa", "field": "tensileStrengthMpa"},
        ],
    },
    # Evidence that satisfies the approved-grade list: 1.4404, so the rule must not fire.
    # Tensile strength is stated so the proposed new field extracts after approval.
    {
        "relative": "manufacturing/04_hallwerk_material_certificate.pdf",
        "tenant_id": "tenant_manufacturing",
        "kind": "evidence",
        "collection_id": "",
        "outcome": "satisfies_A_manufacturing",
        "title": "Hallwerk Stahl Material Certificate",
        "subtitle": "Synthetic case evidence \u00b7 certificate MC-2026-4471",
        "sections": [
            ("1. Delivery", [
                "Hallwerk Stahl GmbH supplied batch HW-9042 to RuhrWorks Manufacturing against purchase order RW-26-9042.",
            ]),
            ("2. Material identification", [
                "The material grade of the delivered batch is 1.4404 and the heat number is H-26-5510.",
            ]),
            ("3. Mechanical properties", [
                "The tensile strength measured for this batch is 512 MPa.",
            ]),
        ],
        "fields": [
            ("Batch number", "HW-9042"),
            ("Material grade", "1.4404"),
            ("Heat number", "H-26-5510"),
            ("Tensile strength (MPa)", "512"),
        ],
        "expected_pages": 1,
        "expected_phrases": [
            "Hallwerk Stahl Material Certificate",
            "delivered batch is 1.4404",
            "H-26-5510",
        ],
        "evidence": [
            {"page": 1, "phrase": "delivered batch is 1.4404", "field": "materialGrade"},
        ],
    },
    # Evidence that violates the approved-grade list: 1.4301, so the rule must fire.
    {
        "relative": "manufacturing/05_kantstahl_material_certificate.pdf",
        "tenant_id": "tenant_manufacturing",
        "kind": "evidence",
        "collection_id": "",
        "outcome": "violates_A_manufacturing",
        "title": "Kantstahl Werke Material Certificate",
        "subtitle": "Synthetic case evidence \u00b7 certificate MC-2026-4488",
        "sections": [
            ("1. Delivery", [
                "Kantstahl Werke GmbH supplied batch KS-3318 to RuhrWorks Manufacturing against purchase order RW-26-9061.",
            ]),
            ("2. Material identification", [
                "The material grade of the delivered batch is 1.4301 and the heat number is H-26-6127.",
            ]),
            ("3. Mechanical properties", [
                "The tensile strength measured for this batch is 431 MPa.",
            ]),
        ],
        "fields": [
            ("Batch number", "KS-3318"),
            ("Material grade", "1.4301"),
            ("Heat number", "H-26-6127"),
            ("Tensile strength (MPa)", "431"),
        ],
        "expected_pages": 1,
        "expected_phrases": [
            "Kantstahl Werke Material Certificate",
            "delivered batch is 1.4301",
            "H-26-6127",
        ],
        "evidence": [
            {"page": 1, "phrase": "delivered batch is 1.4301", "field": "materialGrade"},
        ],
    },
]


def generate(output_dir: Path, manifest_path: Path) -> list[dict]:
    """Write the corpus below ``output_dir`` and record its manifest.

    Generation is byte-stable, so verification can regenerate into a scratch
    directory and compare SHA-256 values without touching the committed corpus.
    """
    written = [write_pdf(output_dir, **document) for document in DOCUMENTS]
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    # newline="" keeps the manifest LF-terminated on Windows so it stays Prettier-clean.
    with manifest_path.open("w", encoding="utf-8", newline="") as handle:
        handle.write(json.dumps({
            "schemaVersion": "1.0.0",
            "fixtureSet": "caselens-policy-lab",
            "generatedOn": "2026-09-03",
            "synthetic": True,
            "documents": written,
        }, indent=2) + "\n")
    return written


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Generate the policy-lab fixture corpus")
    parser.add_argument("--output-dir", type=Path, default=FIXTURES, help="directory to write the corpus into")
    parser.add_argument("--manifest", type=Path, default=None, help=f"manifest path (default: <output-dir>/{MANIFEST_NAME})")
    args = parser.parse_args(argv)
    output_dir = args.output_dir.resolve()
    manifest_path = (args.manifest or output_dir / MANIFEST_NAME).resolve()
    written = generate(output_dir, manifest_path)
    print(f"Generated {len(written)} synthetic policy-lab PDFs")


if __name__ == "__main__":
    main()
