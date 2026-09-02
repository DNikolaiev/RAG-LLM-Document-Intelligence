#!/usr/bin/env python3
"""Generate the synthetic multi-tenant policy and evidence fixture corpus.

The documents are intentionally compact, searchable PDFs used by the local
production demo. They contain no real organisations, people, or customer data.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "fixtures" / "documents"
MANIFEST = FIXTURES / "multi-tenant-fixture-pack.json"


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


def write_pdf(relative: str, title: str, subtitle: str, sections: list[tuple[str, list[str]]], fields: list[tuple[str, str]]) -> dict:
    target = FIXTURES / relative
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
        table = Table([[cell("Evidence field", True), cell("Recorded value", True)]] + [[cell(k), cell(v)] for k, v in fields], colWidths=[55 * mm, 105 * mm])
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
    doc.build(story)
    data = target.read_bytes()
    return {"filename": relative, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}


DOCUMENTS = [
    # Policies: the bold quoted condition is deliberately exact so citation validation is deterministic.
    ("legal-contract/05_contract-approval-control-policy.pdf", "Commercial Contract Review Controls", "Synthetic policy fixture · Version 1.0 · effective 01 January 2026", [
        ("1. Governing-law escalation", ["A commercial contract must be routed for legal review when its governing law is not German law.", "This control applies before an agreement is released for signature."]),
        ("2. Evidence handling", ["The reviewer records the contract parties, governing law, and termination notice period from the source evidence."]),
    ], [("Policy owner", "Rheinland Legal Services · Contract Operations"), ("Applies to", "Commercial contract review")]),
    ("insurance-claim/05_claim-cost-escalation-policy.pdf", "Claim Cost Escalation Policy", "Synthetic policy fixture · Version 1.0 · effective 01 January 2026", [
        ("1. Senior-review threshold", ["A claim must be routed to senior review when the estimated repair cost is EUR 10,000 or more.", "The threshold is inclusive and applies before a settlement instruction is issued."]),
        ("2. Evidence handling", ["The reviewer records the policy number, loss date, and estimated repair cost from the evidence package."]),
    ], [("Policy owner", "Helios Claims Europe · Claims Governance"), ("Applies to", "Property claim assessment")]),
    ("manufacturing-supplier/05_material-grade-control-policy.pdf", "Supplier Material Grade Control", "Synthetic policy fixture · Version 1.0 · effective 01 January 2026", [
        ("1. Grade escalation", ["A material certificate must be routed to quality review when the stated material grade is not 1.4404.", "This control prevents a non-approved grade from being released without an engineering deviation."]),
        ("2. Traceability record", ["The reviewer records the batch number, material grade, and heat number from the submitted evidence."]),
    ], [("Policy owner", "RuhrWorks Manufacturing · Supplier Quality"), ("Applies to", "Supplier quality assurance")]),

    # Legal evidence companions.
    ("legal-contract/02_nordstern_commercial_register_extract.pdf", "Nordstern Trading GmbH · Commercial Register Extract", "Synthetic supporting evidence · issued 18 August 2026", [
        ("Registered entity", ["Nordstern Trading GmbH is registered in Düsseldorf under HRB 88421. Managing director: Elena Fischer."]),
        ("Signature authority", ["Elena Fischer has sole authority to execute commercial agreements on behalf of Nordstern Trading GmbH."]),
    ], [("Contract parties", "Rheinland Legal Services GmbH; Nordstern Trading GmbH"), ("Governing law", "German law"), ("Termination notice days", "30")]),
    ("legal-contract/03_nordstern_data-processing-annex.pdf", "Data Processing Annex · Nordstern Trading", "Synthetic supporting evidence · Annex B to agreement RLS-CDA-2026-041", [
        ("Processing instructions", ["Nordstern Trading GmbH processes customer contact data only on documented instructions from Rheinland Legal Services GmbH."]),
        ("Security commitments", ["Appropriate technical and organisational measures are maintained for all contracted processing."]),
    ], [("Contract parties", "Rheinland Legal Services GmbH; Nordstern Trading GmbH"), ("Governing law", "German law"), ("Termination notice days", "30")]),
    ("legal-contract/04_nordstern_signature_authority_confirmation.pdf", "Signature Authority Confirmation", "Synthetic supporting evidence · 20 August 2026", [
        ("Confirmation", ["Contract Operations confirms that Elena Fischer may sign agreement RLS-CDA-2026-041 for Nordstern Trading GmbH."]),
        ("Release", ["The reviewed commercial terms retain a thirty-day written termination notice and German law."]),
    ], [("Contract parties", "Rheinland Legal Services GmbH; Nordstern Trading GmbH"), ("Governing law", "German law"), ("Termination notice days", "30")]),

    # Insurance evidence companions.
    ("insurance-claim/02_kronenberg_repair_estimate.pdf", "Kronenberg Property Repair Estimate", "Synthetic supporting evidence · Estimate EST-2026-177", [
        ("Scope", ["Water remediation, drying, and reinstatement are estimated at EUR 12,480.00 including VAT."]),
        ("Reference", ["This estimate supports claim HCE-DE-2026-005184 for a loss on 14 May 2026."]),
    ], [("Policy number", "HCE-PROP-884271"), ("Loss date", "2026-05-14"), ("Estimated cost", "EUR 12,480.00")]),
    ("insurance-claim/03_kronenberg_contractor_report.pdf", "Contractor Service Report", "Synthetic supporting evidence · report SR-26-419", [
        ("Inspection", ["The contractor inspected the property on 16 May 2026 and documented water damage consistent with the reported loss date."]),
        ("Repair recommendation", ["Recommended works align with the EUR 12,480.00 repair estimate supplied for the insured property."]),
    ], [("Policy number", "HCE-PROP-884271"), ("Loss date", "2026-05-14"), ("Estimated cost", "EUR 12,480.00")]),
    ("insurance-claim/04_kronenberg_settlement_instruction.pdf", "Settlement Preparation Instruction", "Synthetic supporting evidence · senior review requested", [
        ("Review status", ["The claim has an estimated repair cost of EUR 12,480.00 and remains pending senior review before settlement."]),
        ("Evidence check", ["Claim HCE-DE-2026-005184 includes its repair estimate and contractor report for the reported 14 May 2026 loss."]),
    ], [("Policy number", "HCE-PROP-884271"), ("Loss date", "2026-05-14"), ("Estimated cost", "EUR 12,480.00")]),

    # Manufacturing evidence companions.
    ("manufacturing-supplier/02_vektor_purchase_specification.pdf", "Vektor Purchase Specification", "Synthetic supporting evidence · PO RW-26-8821", [
        ("Material requirement", ["The released component specification requires stainless-steel material grade 1.4404 with a traceable heat number."]),
        ("Delivery scope", ["Batch VP-4421 is supplied against purchase order RW-26-8821."]),
    ], [("Batch number", "VP-4421"), ("Material grade", "1.4404"), ("Heat number", "H-26-7718")]),
    ("manufacturing-supplier/03_vektor_pmi_inspection_report.pdf", "Positive Material Identification Report", "Synthetic supporting evidence · PMI-26-8821", [
        ("Inspection result", ["Positive material identification confirmed material grade 1.4404 for batch VP-4421 and heat H-26-7718."]),
        ("Result", ["All sampled components meet the released purchase specification."]),
    ], [("Batch number", "VP-4421"), ("Material grade", "1.4404"), ("Heat number", "H-26-7718")]),
    ("manufacturing-supplier/04_vektor_release_note.pdf", "Supplier Quality Release Note", "Synthetic supporting evidence · release RLS-26-8821", [
        ("Release decision", ["Supplier Quality released batch VP-4421 after confirming grade 1.4404 and heat number H-26-7718."]),
        ("Traceability", ["The release references the material certificate, purchase specification, and PMI inspection report."]),
    ], [("Batch number", "VP-4421"), ("Material grade", "1.4404"), ("Heat number", "H-26-7718")]),
]


def main() -> None:
    written = [write_pdf(*document) for document in DOCUMENTS]
    MANIFEST.write_text(json.dumps({
        "schemaVersion": "1.0.0",
        "fixtureSet": "caselens-multi-tenant-policy-evidence",
        "generatedOn": "2026-08-31",
        "synthetic": True,
        "documents": written,
    }, indent=2) + "\n", encoding="utf-8")
    print(f"Generated {len(written)} synthetic policy/evidence PDFs")


if __name__ == "__main__":
    main()
