#!/usr/bin/env python3
"""Generate the deterministic CaseLens pharmacy supplier fixture corpus.

The twelve PDFs under output/pdf are final, renderable demo artifacts. Deliberately
unsafe inputs are written only to the fixture quarantine directory.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Callable, Iterable

from pypdf import PdfReader, PdfWriter
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import (
    HRFlowable,
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "output" / "pdf"
FIXTURE_DIR = ROOT / "fixtures" / "documents" / "pharmacy-supplier"
QUARANTINE_DIR = FIXTURE_DIR / "quarantine"
TMP_DIR = ROOT / "tmp" / "pdfs"
MANIFEST_PATH = FIXTURE_DIR / "manifest.json"

PAGE_W, PAGE_H = A4
INK = colors.HexColor("#172126")
NAVY = colors.HexColor("#16333D")
TEAL = colors.HexColor("#2A8D9C")
PALE = colors.HexColor("#EDF4F4")
MIST = colors.HexColor("#F6F8F8")
SLATE = colors.HexColor("#5F7077")
AMBER = colors.HexColor("#D78B2B")
ROSE = colors.HexColor("#C65363")
WHITE = colors.white


def _register_fonts() -> None:
    families = (
        (
            Path("C:/Windows/Fonts/arial.ttf"),
            Path("C:/Windows/Fonts/arialbd.ttf"),
            Path("C:/Windows/Fonts/ariali.ttf"),
        ),
        (
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf"),
        ),
    )
    for regular, bold, italic in families:
        if regular.exists() and bold.exists() and italic.exists():
            pdfmetrics.registerFont(TTFont("CaseLensSans", str(regular)))
            pdfmetrics.registerFont(TTFont("CaseLensSans-Bold", str(bold)))
            pdfmetrics.registerFont(TTFont("CaseLensSans-Italic", str(italic)))
            return
    raise RuntimeError("A Unicode Arial or DejaVu Sans font family is required to generate fixtures")


_register_fonts()


def styles():
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "Title",
            parent=base["Title"],
            fontName="CaseLensSans-Bold",
            fontSize=24,
            leading=29,
            textColor=NAVY,
            spaceAfter=8,
            alignment=TA_LEFT,
        ),
        "subtitle": ParagraphStyle(
            "Subtitle",
            parent=base["Normal"],
            fontName="CaseLensSans",
            fontSize=10,
            leading=15,
            textColor=SLATE,
            spaceAfter=18,
        ),
        "h1": ParagraphStyle(
            "H1",
            parent=base["Heading1"],
            fontName="CaseLensSans-Bold",
            fontSize=15,
            leading=20,
            textColor=NAVY,
            spaceBefore=14,
            spaceAfter=7,
        ),
        "h2": ParagraphStyle(
            "H2",
            parent=base["Heading2"],
            fontName="CaseLensSans-Bold",
            fontSize=10,
            leading=14,
            textColor=TEAL,
            spaceBefore=9,
            spaceAfter=4,
        ),
        "body": ParagraphStyle(
            "Body",
            parent=base["BodyText"],
            fontName="CaseLensSans",
            fontSize=9.3,
            leading=14,
            textColor=INK,
            spaceAfter=7,
        ),
        "small": ParagraphStyle(
            "Small",
            parent=base["BodyText"],
            fontName="CaseLensSans",
            fontSize=7.7,
            leading=10.5,
            textColor=SLATE,
        ),
        "label": ParagraphStyle(
            "Label",
            parent=base["BodyText"],
            fontName="CaseLensSans-Bold",
            fontSize=7.5,
            leading=10,
            textColor=SLATE,
            uppercase=True,
        ),
        "center": ParagraphStyle(
            "Center",
            parent=base["BodyText"],
            fontName="CaseLensSans",
            fontSize=10,
            leading=15,
            textColor=INK,
            alignment=TA_CENTER,
        ),
        "center_title": ParagraphStyle(
            "CenterTitle",
            parent=base["Title"],
            fontName="CaseLensSans-Bold",
            fontSize=28,
            leading=34,
            textColor=NAVY,
            alignment=TA_CENTER,
            spaceAfter=14,
        ),
        "right": ParagraphStyle(
            "Right",
            parent=base["BodyText"],
            fontName="CaseLensSans",
            fontSize=8,
            leading=11,
            textColor=SLATE,
            alignment=TA_RIGHT,
        ),
    }


S = styles()


@dataclass(frozen=True)
class DocumentSpec:
    filename: str
    classification: str
    expected_pages: int
    expected_phrases: tuple[str, ...]
    facts: dict[str, object]
    warnings: tuple[str, ...] = ()
    evidence: tuple[dict[str, object], ...] = ()


SPECS = (
    DocumentSpec(
        "01_supplier_questionnaire.pdf",
        "supplier_questionnaire",
        2,
        ("Supplier onboarding questionnaire", "MediSupply Europe GmbH", "GDP certificate: pending"),
        {"declaredLegalName": "MediSupply Europe GmbH", "temperatureControlled": True, "gdpCertificateStatus": "pending"},
        ("declared_name_conflicts_with_register", "required_gdp_certificate_not_attached"),
        ({"page": 1, "phrase": "MediSupply Europe GmbH", "field": "declaredLegalName"},),
    ),
    DocumentSpec(
        "02_commercial_register_extract.pdf",
        "commercial_register_extract",
        2,
        ("Amtsgericht Duesseldorf", "MediSupply GmbH", "HRB 98421"),
        {"registeredLegalName": "MediSupply GmbH", "registerNumber": "HRB 98421", "registeredOffice": "Duesseldorf"},
        (),
        ({"page": 1, "phrase": "MediSupply GmbH", "field": "registeredLegalName"},),
    ),
    DocumentSpec(
        "03_iso_13485_certificate.pdf",
        "iso_13485_certificate",
        1,
        ("ISO 13485:2016", "Valid until 31 October 2027", "Certificate QMS-13485-7719"),
        {"standard": "ISO 13485:2016", "certificateNumber": "QMS-13485-7719", "validUntil": "2027-10-31"},
        (),
        ({"page": 1, "phrase": "Valid until 31 October 2027", "field": "validUntil"},),
    ),
    DocumentSpec(
        "04_insurance_certificate.pdf",
        "insurance_certificate",
        1,
        ("Product liability insurance", "EUR 1,000,000", "Policy MS-PL-2026-441"),
        {"policyNumber": "MS-PL-2026-441", "coverageEur": 1000000, "validUntil": "2027-03-31"},
        ("coverage_below_required_2000000_eur",),
        ({"page": 1, "phrase": "EUR 1,000,000", "field": "coverageEur"},),
    ),
    DocumentSpec(
        "05_data_processing_agreement.pdf",
        "data_processing_agreement",
        3,
        ("Data Processing Agreement", "Article 28 GDPR", "Signed electronically"),
        {"controller": "Northstar Pharmacy SE", "processor": "MediSupply Europe GmbH", "signed": True, "signedAt": "2026-08-18"},
        ("processor_name_conflicts_with_register",),
        ({"page": 3, "phrase": "Signed electronically", "field": "signed"},),
    ),
    DocumentSpec(
        "06_supply_contract.pdf",
        "supply_contract",
        3,
        ("Framework Supply Agreement", "MediSupply Europe GmbH", "cold-chain products"),
        {"supplierParty": "MediSupply Europe GmbH", "customerParty": "Northstar Pharmacy SE", "governingLaw": "Germany"},
        ("supplier_name_conflicts_with_register",),
        ({"page": 1, "phrase": "MediSupply Europe GmbH", "field": "supplierParty"},),
    ),
    DocumentSpec(
        "07_supplier_qualification_policy.pdf",
        "policy_supplier_qualification",
        2,
        ("Supplier Qualification Policy", "GDP certificate is mandatory", "Decision matrix"),
        {"policyId": "POL-SQ-04", "version": "4.2", "effectiveFrom": "2026-01-15"},
        (),
        ({"page": 1, "phrase": "GDP certificate is mandatory", "field": "gdpRequirement"},),
    ),
    DocumentSpec(
        "08_pharmaceutical_distribution_policy.pdf",
        "policy_pharmaceutical_distribution",
        2,
        ("Pharmaceutical Distribution Policy", "2 C to 8 C", "temperature excursion"),
        {"policyId": "POL-GDP-07", "version": "3.1", "temperatureRange": "2 C to 8 C"},
    ),
    DocumentSpec(
        "09_insurance_requirements_policy.pdf",
        "policy_insurance_requirements",
        2,
        ("Insurance Requirements", "EUR 2,000,000", "product liability"),
        {"policyId": "POL-RISK-02", "version": "2.0", "minimumCoverageEur": 2000000},
        (),
        ({"page": 1, "phrase": "EUR 2,000,000", "field": "minimumCoverageEur"},),
    ),
    DocumentSpec(
        "10_data_protection_policy.pdf",
        "policy_data_protection",
        2,
        ("Data Protection and Processor Policy", "Article 28", "72 hours"),
        {"policyId": "POL-DP-09", "version": "5.0", "incidentNoticeHours": 72},
    ),
    DocumentSpec(
        "11_multilingual_product_catalog.pdf",
        "product_catalog",
        2,
        ("Multilingual Product Catalogue", "Kuehlpflichtig", "Зберігати охолодженим"),
        {"languages": ["de", "en", "uk"], "temperatureRange": "2 C to 8 C", "productCount": 6},
        ("mixed_language_document",),
    ),
    DocumentSpec(
        "12_rotated_low_contrast_delivery_note.pdf",
        "delivery_note",
        1,
        ("Delivery note DN-2026-0819", "Temperature on receipt: 5.2 C", "MediSupply Europe GmbH"),
        {"deliveryNoteNumber": "DN-2026-0819", "receiptTemperatureC": 5.2, "supplierName": "MediSupply Europe GmbH"},
        ("page_rotated_90_degrees", "low_contrast_source", "supplier_name_conflicts_with_register"),
    ),
)


def P(text: str, style: str = "body") -> Paragraph:
    return Paragraph(text, S[style])


def _header_footer(document_code: str, classification: str) -> Callable:
    def draw(c: canvas.Canvas, doc) -> None:
        c.saveState()
        c.setFillColor(NAVY)
        c.rect(0, PAGE_H - 12 * mm, PAGE_W, 12 * mm, stroke=0, fill=1)
        c.setFont("CaseLensSans-Bold", 7.5)
        c.setFillColor(WHITE)
        c.drawString(18 * mm, PAGE_H - 7.7 * mm, "CASELENS / CONTROLLED DEMO RECORD")
        c.setFont("CaseLensSans", 7.2)
        c.drawRightString(PAGE_W - 18 * mm, PAGE_H - 7.7 * mm, f"{document_code}  |  {classification}")
        c.setStrokeColor(colors.HexColor("#CDD9DC"))
        c.line(18 * mm, 14 * mm, PAGE_W - 18 * mm, 14 * mm)
        c.setFillColor(SLATE)
        c.setFont("CaseLensSans", 7.2)
        c.drawString(18 * mm, 9 * mm, "Synthetic portfolio fixture - no real person or company")
        c.drawRightString(PAGE_W - 18 * mm, 9 * mm, f"Page {doc.page}")
        c.restoreState()

    return draw


def _doc(path: Path, code: str, classification: str) -> SimpleDocTemplate:
    return SimpleDocTemplate(
        str(path),
        pagesize=A4,
        rightMargin=18 * mm,
        leftMargin=18 * mm,
        topMargin=22 * mm,
        bottomMargin=19 * mm,
        title=path.stem,
        author="CaseLens Fixture Generator",
        subject=classification,
        creator="CaseLens deterministic fixture generator",
    )


def _build(path: Path, code: str, classification: str, story: list) -> None:
    doc = _doc(path, code, classification)
    callback = _header_footer(code, classification)
    doc.build(story, onFirstPage=callback, onLaterPages=callback, canvasmaker=InvariantCanvas)


class InvariantCanvas(canvas.Canvas):
    """ReportLab canvas with stable metadata and document IDs across runs."""

    def __init__(self, *args, **kwargs):
        kwargs["invariant"] = 1
        super().__init__(*args, **kwargs)


def _meta(rows: Iterable[tuple[str, str]]) -> Table:
    data = [[P(label.upper(), "label"), P(value)] for label, value in rows]
    table = Table(data, colWidths=[43 * mm, 119 * mm], hAlign="LEFT")
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (0, -1), PALE),
                ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#C9D6D9")),
                ("INNERGRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#D8E1E3")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 7),
                ("RIGHTPADDING", (0, 0), (-1, -1), 7),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    return table


def _grid(headers: list[str], rows: list[list[str]], widths: list[float] | None = None, font_size: float = 8.2) -> Table:
    data = [[P(value, "label") for value in headers]] + [[P(value, "small") for value in row] for row in rows]
    table = Table(data, colWidths=widths, repeatRows=1, hAlign="LEFT")
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), NAVY),
                ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
                ("FONTNAME", (0, 0), (-1, 0), "CaseLensSans-Bold"),
                ("FONTSIZE", (0, 1), (-1, -1), font_size),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, MIST]),
                ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#CCD8DB")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    return table


def _callout(title: str, text: str, accent=AMBER) -> Table:
    table = Table([[P(title, "label"), P(text)]], colWidths=[40 * mm, 122 * mm])
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#FFF8EB")),
                ("LINEBEFORE", (0, 0), (0, -1), 4, accent),
                ("BOX", (0, 0), (-1, -1), 0.4, colors.HexColor("#E8D8BA")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 8),
                ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                ("TOPPADDING", (0, 0), (-1, -1), 8),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
            ]
        )
    )
    return table


def generate_questionnaire(path: Path) -> None:
    story = [
        P("Supplier onboarding questionnaire", "title"),
        P("Submission QN-2026-0818 | Completed 18 August 2026 | Review case CL-2026-0042", "subtitle"),
        _meta(
            [
                ("Declared legal name", "MediSupply Europe GmbH"),
                ("Trading name", "MediSupply"),
                ("Address", "Hansaallee 148, 40549 Duesseldorf, Germany"),
                ("Primary contact", "Elena Hoffmann, Quality Operations"),
                ("Contact", "quality@medisupply.example | +49 211 555 0188"),
                ("VAT ID", "DE 347 219 806"),
            ]
        ),
        P("Operations profile", "h1"),
        _grid(
            ["Question", "Response", "Evidence supplied"],
            [
                ["Will you distribute medicinal products?", "Yes", "Product catalogue; supply contract"],
                ["Are any products temperature controlled?", "Yes - 2 C to 8 C", "Delivery note; lane validation summary"],
                ["Do you hold a GDP certificate?", "GDP certificate: pending", "No attachment"],
                ["Do you process customer personal data?", "Limited contact and delivery data", "Signed DPA"],
                ["Is subcontracted transport used?", "Yes - validated regional carriers", "Carrier list on page 2"],
            ],
            [76 * mm, 39 * mm, 47 * mm],
        ),
        Spacer(1, 10),
        _callout("OPEN ITEM", "GDP certification renewal is pending with the competent authority. The supplier expects an updated certificate by 30 September 2026."),
        PageBreak(),
        P("Controls and declarations", "title"),
        P("The following responses were attested by the supplier quality representative.", "subtitle"),
        _grid(
            ["Control", "Answer", "Comment"],
            [
                ["Temperature mapping", "Implemented", "Annual mapping and seasonal qualification"],
                ["Excursion handling", "Implemented", "Electronic alerts; deviation record within four hours"],
                ["Recall support", "Implemented", "Two-hour acknowledgement; 24-hour reconciliation"],
                ["Sanctions screening", "Implemented", "Supplier and beneficial owner checked monthly"],
                ["Business continuity", "Implemented", "Secondary cold store in Neuss"],
                ["Cyber incident notification", "72 hours", "Aligned to signed DPA"],
            ],
            [65 * mm, 34 * mm, 63 * mm],
        ),
        P("Declared carriers", "h1"),
        _meta(
            [
                ("Primary carrier", "Rhein Cold Logistics GmbH - validated"),
                ("Backup carrier", "WestCargo Pharma GmbH - qualification in progress"),
                ("Lane scope", "Germany, Benelux, Austria"),
            ]
        ),
        Spacer(1, 14),
        P("Attestation", "h1"),
        P("I confirm that the responses are complete and accurate to the best of my knowledge and that material changes will be notified without delay."),
        _meta([("Signed by", "Elena Hoffmann, Head of Quality Operations"), ("Signature", "/s/ Elena Hoffmann"), ("Date", "18 August 2026")]),
    ]
    _build(path, "QN-2026-0818", "Supplier questionnaire", story)


def generate_register(path: Path) -> None:
    story = [
        P("Commercial register extract", "title"),
        P("Certified synthetic extract for portfolio testing | Issued 12 August 2026", "subtitle"),
        _meta(
            [
                ("Register court", "Amtsgericht Duesseldorf"),
                ("Register number", "HRB 98421"),
                ("Registered legal name", "MediSupply GmbH"),
                ("Registered office", "Duesseldorf"),
                ("Business address", "Hansaallee 148, 40549 Duesseldorf"),
                ("Legal form", "Gesellschaft mit beschraenkter Haftung (GmbH)"),
            ]
        ),
        P("Purpose of the company", "h1"),
        P("Wholesale distribution, storage, quality coordination and transport management for medicinal products, medical devices and related healthcare goods, including temperature-controlled products."),
        P("Representation", "h1"),
        _grid(
            ["Role", "Name", "Authority"],
            [
                ["Managing director", "Dr. Jonas Keller", "Sole power of representation"],
                ["Authorised signatory", "Miriam Vogt", "Jointly with a managing director"],
            ],
            [45 * mm, 52 * mm, 65 * mm],
        ),
        P("Capital", "h1"),
        _meta([("Share capital", "EUR 100,000"), ("Last filing", "Annual accounts for 2025 filed 30 June 2026")]),
        _callout("IDENTITY RECORD", "The authoritative registered legal name in this extract is MediSupply GmbH. Trading names and contract aliases are not shown in the register.", accent=TEAL),
        PageBreak(),
        P("Filing history", "title"),
        P("Selected current entries and changes", "subtitle"),
        _grid(
            ["Date", "Entry", "Status"],
            [
                ["12 Aug 2026", "Electronic certified extract generated", "Current"],
                ["30 Jun 2026", "Annual accounts 2025 submitted", "Accepted"],
                ["03 Feb 2025", "Business address changed to Hansaallee 148", "Registered"],
                ["16 Nov 2023", "Dr. Jonas Keller appointed managing director", "Registered"],
                ["22 Sep 2022", "Company incorporated; HRB 98421", "Registered"],
            ],
            [34 * mm, 92 * mm, 36 * mm],
        ),
        P("Beneficial ownership declaration", "h1"),
        P("The company declares that the transparency register filing is current. This extract does not replace an independent beneficial ownership or sanctions check."),
        P("Certification note", "h1"),
        P("Generated as a synthetic document for CaseLens. It resembles a register extract for workflow testing but has no legal validity."),
        _meta([("Verification code", "CL-DE-HRB98421-20260812"), ("Extract scope", "Current and historical entries"), ("Language", "English rendering of German register fields")]),
    ]
    _build(path, "REG-HRB98421", "Commercial register extract", story)


def generate_iso(path: Path) -> None:
    story = [
        Spacer(1, 16 * mm),
        P("CERTIFICATE", "center_title"),
        P("Quality management system", "center"),
        Spacer(1, 8 * mm),
        HRFlowable(width="58%", thickness=2, color=TEAL, spaceBefore=4, spaceAfter=18, hAlign="CENTER"),
        P("MediSupply GmbH", "center_title"),
        P("Hansaallee 148, 40549 Duesseldorf, Germany", "center"),
        Spacer(1, 10 * mm),
        P("has demonstrated a quality management system conforming to", "center"),
        Spacer(1, 4 * mm),
        P("ISO 13485:2016", "center_title"),
        P("for storage, handling and distribution support of medical devices and associated temperature-controlled healthcare products.", "center"),
        Spacer(1, 12 * mm),
        _meta(
            [
                ("Certificate", "Certificate QMS-13485-7719"),
                ("Initial certification", "01 November 2024"),
                ("Current issue", "01 November 2025"),
                ("Validity", "Valid until 31 October 2027"),
                ("Certification body", "Argent Quality Assurance GmbH"),
            ]
        ),
        Spacer(1, 8 * mm),
        P("Subject to continued satisfactory surveillance. Authenticity can be checked using verification reference AQA-7719-2025. Synthetic testing certificate; not valid for conformity claims.", "small"),
    ]
    _build(path, "QMS-13485-7719", "ISO 13485 certificate", story)


def generate_insurance(path: Path) -> None:
    story = [
        P("Product liability insurance", "title"),
        P("Certificate of insurance | Issued 02 April 2026", "subtitle"),
        _meta(
            [
                ("Insurer", "Rheinland Mutual Insurance AG"),
                ("Policyholder", "MediSupply GmbH"),
                ("Policy number", "Policy MS-PL-2026-441"),
                ("Period", "01 April 2026 to 31 March 2027"),
                ("Territory", "European Economic Area, Switzerland and United Kingdom"),
            ]
        ),
        P("Insured limit", "h1"),
        _callout("AGGREGATE LIMIT", "EUR 1,000,000 per occurrence and in the annual aggregate for bodily injury, property damage and consequential financial loss.", accent=ROSE),
        P("Scope of cover", "h1"),
        _grid(
            ["Coverage", "Included", "Deductible"],
            [
                ["Products and completed operations", "Yes", "EUR 10,000"],
                ["Temperature excursion consequential loss", "Yes", "EUR 25,000"],
                ["Product recall expense", "Sub-limit EUR 250,000", "EUR 25,000"],
                ["Cyber and privacy liability", "No", "Not applicable"],
            ],
            [75 * mm, 51 * mm, 36 * mm],
        ),
        P("Conditions", "h1"),
        P("This certificate is evidence of cover only and does not amend, extend or alter the policy. Cancellation or material reduction is subject to 30 days notice where legally permitted."),
        Spacer(1, 6 * mm),
        _meta([("Authorised representative", "Nora Albrecht, Commercial Underwriting"), ("Verification", "RMI-MSPL-441-2026")]),
    ]
    _build(path, "MS-PL-2026-441", "Insurance certificate", story)


def generate_dpa(path: Path) -> None:
    story = [
        P("Data Processing Agreement", "title"),
        P("Appendix to the Framework Supply Agreement | DPA-2026-188", "subtitle"),
        _meta([("Controller", "Northstar Pharmacy SE"), ("Processor", "MediSupply Europe GmbH"), ("Legal basis", "Article 28 GDPR"), ("Effective date", "18 August 2026")]),
        P("1. Scope and instructions", "h1"),
        P("The Processor processes business contact, consignee, delivery, exception and support data only on documented instructions from the Controller for supplier fulfilment and quality management."),
        P("2. Processing details", "h1"),
        _grid(
            ["Category", "Description", "Retention"],
            [
                ["Data subjects", "Customer contacts, consignee staff, support requesters", "Contract term plus legal retention"],
                ["Personal data", "Name, business email, phone, delivery location, ticket notes", "Purpose-limited"],
                ["Special categories", "Not intended; quarantine and notify if received", "Delete after triage"],
                ["Operations", "Collect, consult, transmit, reconcile, delete", "Per instruction"],
            ],
            [41 * mm, 81 * mm, 40 * mm],
        ),
        P("3. Confidentiality and access", "h1"),
        P("Access is role-based, reviewed quarterly and limited to personnel under confidentiality obligations. Production access requires multi-factor authentication and is logged."),
        PageBreak(),
        P("Technical and organisational measures", "title"),
        P("Schedule 1 | Baseline controls", "subtitle"),
        _grid(
            ["Control area", "Measure", "Evidence cadence"],
            [
                ["Identity", "Single sign-on, MFA, least privilege, quarterly review", "Quarterly"],
                ["Encryption", "TLS in transit; AES-256 equivalent at rest", "Continuous"],
                ["Availability", "Daily backup; quarterly restore exercise", "Quarterly"],
                ["Logging", "Immutable security and access events", "Monthly review"],
                ["Vulnerability", "Monthly scanning; risk-based remediation", "Monthly"],
                ["Personnel", "Onboarding training and annual refresher", "Annual"],
                ["Deletion", "Verified deletion workflow and exception register", "Per request"],
            ],
            [38 * mm, 82 * mm, 42 * mm],
        ),
        P("4. Sub-processors", "h1"),
        P("The Processor will provide at least 30 days prior notice of a new sub-processor. The Controller may object on documented data-protection grounds."),
        P("5. Security incidents", "h1"),
        _callout("NOTICE", "The Processor will notify the Controller without undue delay and no later than 72 hours after becoming aware of a confirmed personal-data breach."),
        PageBreak(),
        P("Signatures and schedules", "title"),
        P("Schedule 2 | Approved sub-processors", "subtitle"),
        _grid(
            ["Provider", "Service", "Region", "Safeguard"],
            [
                ["Rhein Cloud Systems GmbH", "Managed hosting", "Germany", "EU processing"],
                ["WestCargo Pharma GmbH", "Backup transport", "Germany", "DPA and restricted fields"],
                ["SignalDesk Europe BV", "Support ticketing", "Netherlands", "EU processing"],
            ],
            [47 * mm, 47 * mm, 30 * mm, 38 * mm],
        ),
        P("Execution", "h1"),
        _meta(
            [
                ("For the Controller", "Lea Stein, Director Supplier Quality"),
                ("For the Processor", "Elena Hoffmann, Head of Quality Operations"),
                ("Signature method", "Signed electronically"),
                ("Signature date", "18 August 2026"),
                ("Document integrity ID", "DPA-2026-188-CL-DEMO")
            ]
        ),
        Spacer(1, 12 * mm),
        P("/s/ Lea Stein", "h1"),
        P("/s/ Elena Hoffmann", "h1"),
    ]
    _build(path, "DPA-2026-188", "Data processing agreement", story)


def generate_contract(path: Path) -> None:
    story = [
        P("Framework Supply Agreement", "title"),
        P("Agreement FSA-2026-118 | Effective 01 September 2026", "subtitle"),
        _meta([("Customer", "Northstar Pharmacy SE"), ("Supplier", "MediSupply Europe GmbH"), ("Term", "24 months"), ("Governing law", "Germany")]),
        P("1. Appointment and scope", "h1"),
        P("The Customer appoints the Supplier to supply medicinal products, medical devices and cold-chain products listed in approved purchase orders. The Supplier accepts the appointment subject to this Agreement and the quality schedule."),
        P("2. Order and delivery controls", "h1"),
        _grid(
            ["Service", "Commitment", "Record"],
            [
                ["Order acknowledgement", "Within four business hours", "Electronic acknowledgement"],
                ["Standard dispatch", "Same day before 13:00 CET", "Dispatch event"],
                ["Cold-chain delivery", "2 C to 8 C unless product specifies otherwise", "Logger and delivery note"],
                ["Exception notice", "Within two hours of confirmed deviation", "Deviation record"],
            ],
            [48 * mm, 75 * mm, 39 * mm],
        ),
        P("3. Documentation", "h1"),
        P("The Supplier will maintain licences, GDP evidence, insurance, training records, lane qualifications, traceability records and recall contacts throughout the term."),
        _callout("CONDITION PRECEDENT", "Cold-chain supply may begin only after the Customer approves current GDP evidence and the supplier qualification decision is recorded."),
        PageBreak(),
        P("Commercial and quality terms", "title"),
        P("Schedule A", "subtitle"),
        P("4. Quality events", "h1"),
        _grid(
            ["Event", "Initial notice", "Written report"],
            [
                ["Temperature excursion", "2 hours", "2 business days"],
                ["Suspected falsification", "Immediate", "24 hours"],
                ["Recall or field action", "2 hours", "Daily until closed"],
                ["Personal-data incident", "Without undue delay", "No later than 72 hours"],
            ],
            [62 * mm, 48 * mm, 52 * mm],
        ),
        P("5. Audit and records", "h1"),
        P("The Customer may audit relevant facilities, systems and records on reasonable notice. For-cause audits may be initiated without the standard notice period. Records supporting product traceability are retained for the longer of ten years or the applicable product requirement."),
        P("6. Insurance", "h1"),
        P("The Supplier will maintain product liability insurance at the minimum required by the Customer's then-current supplier policy and provide evidence on request."),
        P("7. Change notification", "h1"),
        P("The Supplier will notify changes to legal identity, ownership, critical sub-contractors, licensed activities, certified scope or distribution sites before implementation where practicable."),
        PageBreak(),
        P("Execution", "title"),
        P("Schedule B | Contacts and signatures", "subtitle"),
        _meta(
            [
                ("Customer quality", "Lea Stein | supplier.quality@northstar.example"),
                ("Supplier quality", "Elena Hoffmann | quality@medisupply.example"),
                ("24/7 deviation line", "+49 211 555 0199"),
                ("Customer signature", "/s/ Lea Stein - 18 August 2026"),
                ("Supplier signature", "/s/ Elena Hoffmann - 18 August 2026"),
            ]
        ),
        P("Entire agreement", "h1"),
        P("This Agreement, its schedules, approved change orders and the Data Processing Agreement constitute the agreement for the stated scope. If quality requirements conflict with a purchase order, the stricter patient-safety control applies."),
        Spacer(1, 15 * mm),
        _callout("REVIEW NOTE", "The contract party is written as MediSupply Europe GmbH. The submitted commercial register extract names MediSupply GmbH; reviewers should request identity reconciliation rather than silently merging the entities.", accent=ROSE),
    ]
    _build(path, "FSA-2026-118", "Supply contract", story)


def generate_policy(path: Path, code: str, title: str, version: str, meta: list[tuple[str, str]], sections: list[tuple[str, str]], matrix: tuple[list[str], list[list[str]], list[float]]) -> None:
    first_sections, second_sections = sections[:3], sections[3:]
    story = [P(title, "title"), P(f"Controlled policy {code} | Version {version}", "subtitle"), _meta(meta)]
    for heading, body in first_sections:
        story.extend([P(heading, "h1"), P(body)])
    story.extend([PageBreak(), P(f"{title} - controls", "title"), P(f"Continuation of {code} | Version {version}", "subtitle")])
    for heading, body in second_sections:
        story.extend([P(heading, "h1"), P(body)])
    story.extend([P("Decision matrix", "h1"), _grid(matrix[0], matrix[1], matrix[2]), Spacer(1, 10), _meta([("Owner", "Director Supplier Quality"), ("Next review", "15 January 2027"), ("Record class", "Controlled policy")])])
    _build(path, code, title, story)


def generate_multilingual_catalog(path: Path) -> None:
    story = [
        P("Multilingual Product Catalogue", "title"),
        P("Produktkatalog / Product catalogue / Каталог продукції | Revision 2026-08", "subtitle"),
        _meta([("Supplier", "MediSupply Europe GmbH"), ("Catalogue", "CAT-CC-2026-08"), ("Languages", "Deutsch / English / Українська"), ("Temperature", "2 C to 8 C unless noted")]),
        P("Temperature-controlled products", "h1"),
        _grid(
            ["SKU", "Deutsch", "English", "Українська", "Storage"],
            [
                ["MS-10021", "Insulin-Kuehlbox", "Insulin shipper", "Контейнер для інсуліну", "2 C to 8 C"],
                ["MS-10418", "Impfstoff-Transportset", "Vaccine transport set", "Набір для вакцин", "2 C to 8 C"],
                ["MS-10977", "Temperaturdatenlogger", "Temperature data logger", "Реєстратор температури", "Ambient"],
            ],
            [23 * mm, 42 * mm, 40 * mm, 36 * mm, 28 * mm],
            7.5,
        ),
        P("Handling statement", "h1"),
        _callout("KUEHLPFLICHTIG", "Kuehlpflichtig / Keep refrigerated / Зберігати охолодженим. Do not freeze. Inspect the temperature indicator before acceptance.", accent=TEAL),
        P("Legend", "h1"),
        _meta([("DE", "Kuehlpflichtig - Temperaturbereich 2 C bis 8 C"), ("EN", "Refrigerated - temperature range 2 C to 8 C"), ("UK", "Потрібне охолодження - діапазон температур від 2 C до 8 C")]),
        PageBreak(),
        P("Product specifications", "title"),
        P("Technische Daten / Technical data / Tekhnichni dani", "subtitle"),
        _grid(
            ["SKU", "Pack", "Qualification", "Shelf life", "UDI / lot trace"],
            [
                ["MS-10021", "12 L reusable", "96 h summer / 120 h winter", "60 cycles", "Lot and serial"],
                ["MS-10418", "8 L single use", "72 h universal", "24 months", "Lot"],
                ["MS-10977", "10 devices", "EN 12830 aligned", "36 months", "Serial"],
                ["MS-11202", "PCM pack 500 g", "Conditioned at 5 C", "36 months", "Lot"],
                ["MS-11331", "Tamper seal 100", "Visual integrity", "60 months", "Lot"],
                ["MS-11880", "Probe sleeve 50", "Food-safe polymer", "48 months", "Lot"],
            ],
            [26 * mm, 39 * mm, 48 * mm, 28 * mm, 30 * mm],
        ),
        P("Ordering and traceability", "h1"),
        P("Purchase orders must state SKU, quantity, delivery temperature, destination and required logger configuration. Batch or serial identifiers appear on the delivery note and electronic dispatch message."),
        P("Contact", "h1"),
        _meta([("Technical", "catalogue@medisupply.example"), ("Quality", "quality@medisupply.example"), ("Emergency", "+49 211 555 0199")]),
    ]
    _build(path, "CAT-CC-2026-08", "Multilingual product catalogue", story)


def generate_rotated_delivery_note(path: Path) -> None:
    intermediate = TMP_DIR / "delivery-note-unrotated.pdf"
    c = InvariantCanvas(str(intermediate), pagesize=A4)
    c.setTitle("Delivery note DN-2026-0819")
    c.setAuthor("CaseLens Fixture Generator")
    c.setFillColor(colors.HexColor("#F9FAFA"))
    c.rect(0, 0, PAGE_W, PAGE_H, stroke=0, fill=1)
    c.setFillColor(colors.HexColor("#A0AAAD"))
    c.setFont("CaseLensSans-Bold", 22)
    c.drawString(23 * mm, PAGE_H - 30 * mm, "Delivery note DN-2026-0819")
    c.setFont("CaseLensSans", 9)
    c.drawRightString(PAGE_W - 23 * mm, PAGE_H - 29 * mm, "LOW-CONTRAST SCAN SIMULATION")
    c.setStrokeColor(colors.HexColor("#CCD1D2"))
    c.line(23 * mm, PAGE_H - 35 * mm, PAGE_W - 23 * mm, PAGE_H - 35 * mm)
    rows = [
        ("Supplier", "MediSupply Europe GmbH"),
        ("Ship to", "Northstar Pharmacy SE, Rheinstrasse 40, 40213 Duesseldorf"),
        ("Dispatch", "19 August 2026 06:15 CET"),
        ("Receipt", "19 August 2026 09:42 CET"),
        ("Temperature on receipt", "Temperature on receipt: 5.2 C"),
        ("Logger", "TL-77821 - no excursion reported"),
    ]
    y = PAGE_H - 54 * mm
    for label, value in rows:
        c.setFont("CaseLensSans-Bold", 8)
        c.drawString(23 * mm, y, label.upper())
        c.setFont("CaseLensSans", 10)
        c.drawString(70 * mm, y, value)
        y -= 11 * mm
    c.setFont("CaseLensSans-Bold", 9)
    c.drawString(23 * mm, y - 3 * mm, "ITEM")
    c.drawString(70 * mm, y - 3 * mm, "DESCRIPTION")
    c.drawString(147 * mm, y - 3 * mm, "QTY")
    c.line(23 * mm, y - 7 * mm, PAGE_W - 23 * mm, y - 7 * mm)
    items = [("MS-10021", "Insulin shipper 12 L", "4"), ("MS-10977", "Temperature data logger", "4"), ("MS-11331", "Tamper seals", "16")]
    y -= 16 * mm
    for sku, description, qty in items:
        c.setFont("CaseLensSans", 9)
        c.drawString(23 * mm, y, sku)
        c.drawString(70 * mm, y, description)
        c.drawString(147 * mm, y, qty)
        y -= 10 * mm
    c.setFont("CaseLensSans-Italic", 8)
    c.drawString(23 * mm, 35 * mm, "Received by: /s/ Anja Weber | Packaging intact | Synthetic portfolio fixture")
    c.save()
    reader = PdfReader(str(intermediate))
    writer = PdfWriter()
    writer.add_page(reader.pages[0].rotate(90))
    writer.add_metadata({"/Title": "Delivery note DN-2026-0819", "/Subject": "Rotated low-contrast delivery note", "/Author": "CaseLens Fixture Generator"})
    with path.open("wb") as stream:
        writer.write(stream)
    intermediate.unlink()


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write_quarantine() -> dict[str, dict[str, object]]:
    QUARANTINE_DIR.mkdir(parents=True, exist_ok=True)
    known = (
        "corrupted-pdf.pdf",
        "wrong-mime.pdf",
        "encrypted-insurance.pdf",
        "empty-input.pdf",
        "unsupported-note.rtf",
        "duplicate-insurance-certificate.pdf",
    )
    for name in known:
        candidate = QUARANTINE_DIR / name
        if candidate.exists():
            candidate.unlink()

    (QUARANTINE_DIR / "corrupted-pdf.pdf").write_bytes(b"%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n%%TRUNCATED")
    (QUARANTINE_DIR / "wrong-mime.pdf").write_bytes(b"\x89PNG\r\n\x1a\nCASELENS MIME SPOOF FIXTURE")
    (QUARANTINE_DIR / "empty-input.pdf").write_bytes(b"")
    (QUARANTINE_DIR / "unsupported-note.rtf").write_text(r"{\rtf1\ansi CaseLens unsupported document fixture}", encoding="ascii")

    insurance = OUTPUT_DIR / "04_insurance_certificate.pdf"
    duplicate = QUARANTINE_DIR / "duplicate-insurance-certificate.pdf"
    shutil.copyfile(insurance, duplicate)

    reader = PdfReader(str(insurance))
    writer = PdfWriter()
    writer.clone_document_from_reader(reader)
    writer.encrypt("caselens-demo-password", algorithm="AES-256")
    encrypted = QUARANTINE_DIR / "encrypted-insurance.pdf"
    with encrypted.open("wb") as stream:
        writer.write(stream)

    return {
        "corrupted-pdf.pdf": {"expectedDisposition": "quarantine", "expectedError": "pdf_corrupt_or_truncated"},
        "wrong-mime.pdf": {"expectedDisposition": "quarantine", "expectedError": "mime_signature_mismatch", "declaredMime": "application/pdf", "detectedMime": "image/png"},
        "encrypted-insurance.pdf": {"expectedDisposition": "quarantine", "expectedError": "pdf_encrypted", "passwordAvailableToPipeline": False},
        "empty-input.pdf": {"expectedDisposition": "quarantine", "expectedError": "empty_file"},
        "unsupported-note.rtf": {"expectedDisposition": "quarantine", "expectedError": "unsupported_format", "declaredMime": "application/rtf"},
        "duplicate-insurance-certificate.pdf": {
            "expectedDisposition": "duplicate",
            "duplicateOf": "04_insurance_certificate.pdf",
            "sha256": _sha256(duplicate),
        },
    }


def _write_manifest(quarantine: dict[str, dict[str, object]]) -> None:
    documents = []
    for spec in SPECS:
        output_path = OUTPUT_DIR / spec.filename
        documents.append(
            {
                "filename": spec.filename,
                "classification": spec.classification,
                "sha256": _sha256(output_path),
                "expectedPages": spec.expected_pages,
                "expectedPhrases": list(spec.expected_phrases),
                "expectedFacts": spec.facts,
                "expectedWarnings": list(spec.warnings),
                "evidence": list(spec.evidence),
                "source": "synthetic",
            }
        )
    manifest = {
        "schemaVersion": "1.0.0",
        "fixtureSet": "pharmacy-supplier-onboarding",
        "seed": "caselens-pharmacy-v1",
        "generatedOn": str(date(2026, 8, 26)),
        "synthetic": True,
        "case": {
            "id": "case_demo_medisupply",
            "subject": "MediSupply supplier qualification",
            "authoritativeRegisteredName": "MediSupply GmbH",
            "declaredAndContractName": "MediSupply Europe GmbH",
            "expectedDecision": "request_information",
        },
        "documents": documents,
        "quarantine": quarantine,
        "intentionallyMissing": [
            {
                "classification": "gdp_certificate",
                "requirement": "Current GDP certificate for suppliers distributing medicinal products",
                "severity": "critical",
                "expectedFinding": "missing_gdp_certificate",
            }
        ],
        "expectedCaseFindings": [
            {"code": "missing_gdp_certificate", "severity": "critical", "status": "open"},
            {"code": "insufficient_liability_coverage", "severity": "major", "actual": 1000000, "required": 2000000, "currency": "EUR"},
            {"code": "legal_name_mismatch", "severity": "major", "registered": "MediSupply GmbH", "declared": "MediSupply Europe GmbH"},
            {"code": "iso_13485_valid", "severity": "informational", "validUntil": "2027-10-31"},
            {"code": "dpa_signed", "severity": "informational", "signedAt": "2026-08-18"},
        ],
        "edgeCaseCoverage": {
            "nativeText": ["01_supplier_questionnaire.pdf", "02_commercial_register_extract.pdf"],
            "multiPage": ["05_data_processing_agreement.pdf", "06_supply_contract.pdf"],
            "tables": ["01_supplier_questionnaire.pdf", "11_multilingual_product_catalog.pdf"],
            "multilingual": ["11_multilingual_product_catalog.pdf"],
            "rotated": ["12_rotated_low_contrast_delivery_note.pdf"],
            "lowContrast": ["12_rotated_low_contrast_delivery_note.pdf"],
            "crossDocumentConflict": ["02_commercial_register_extract.pdf", "06_supply_contract.pdf"],
            "missingRequiredDocument": ["gdp_certificate"],
            "belowThreshold": ["04_insurance_certificate.pdf", "09_insurance_requirements_policy.pdf"],
            "corrupt": ["quarantine/corrupted-pdf.pdf"],
            "mimeSpoof": ["quarantine/wrong-mime.pdf"],
            "encrypted": ["quarantine/encrypted-insurance.pdf"],
            "empty": ["quarantine/empty-input.pdf"],
            "unsupported": ["quarantine/unsupported-note.rtf"],
            "byteDuplicate": ["quarantine/duplicate-insurance-certificate.pdf"],
        },
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def generate_all() -> None:
    for directory in (OUTPUT_DIR, FIXTURE_DIR, QUARANTINE_DIR, TMP_DIR):
        directory.mkdir(parents=True, exist_ok=True)
    for spec in SPECS:
        for directory in (OUTPUT_DIR, FIXTURE_DIR):
            candidate = directory / spec.filename
            if candidate.exists():
                candidate.unlink()

    generators: dict[str, Callable[[Path], None]] = {
        "01_supplier_questionnaire.pdf": generate_questionnaire,
        "02_commercial_register_extract.pdf": generate_register,
        "03_iso_13485_certificate.pdf": generate_iso,
        "04_insurance_certificate.pdf": generate_insurance,
        "05_data_processing_agreement.pdf": generate_dpa,
        "06_supply_contract.pdf": generate_contract,
        "11_multilingual_product_catalog.pdf": generate_multilingual_catalog,
        "12_rotated_low_contrast_delivery_note.pdf": generate_rotated_delivery_note,
    }
    policy_args = {
        "07_supplier_qualification_policy.pdf": (
            "POL-SQ-04",
            "Supplier Qualification Policy",
            "4.2",
            [("Owner", "Director Supplier Quality"), ("Effective", "15 January 2026"), ("Applies to", "Medicinal products, medical devices, critical services"), ("Review cycle", "Annual")],
            [
                ("1. Purpose", "This policy defines risk-based due diligence and approval controls before a supplier may provide regulated products or services."),
                ("2. Risk classification", "Suppliers of medicinal products, sterile devices, patient-facing services or controlled-temperature logistics are critical unless a documented assessment supports a lower class."),
                ("3. Mandatory evidence", "For a distributor of medicinal products, a current GDP certificate is mandatory. A commercial register extract, insurance evidence, quality certification where applicable, signed privacy terms and contract are also required."),
                ("4. Identity reconciliation", "The registered entity, contracting party, invoice entity, certificate holder and operational site must be reconciled. An alias is acceptable only with documented legal evidence."),
                ("5. Exceptions", "A critical missing document cannot be waived by an automated model. A time-limited exception requires Quality and Legal approval, compensating controls and an expiry date."),
                ("6. Reassessment", "Critical suppliers are reassessed annually and after a serious quality event, ownership change, material scope change or certificate suspension."),
            ],
            (["Condition", "Classification", "Outcome"], [["Critical required document missing", "Critical", "Request information or reject"], ["Identity conflict unresolved", "Major", "Request information"], ["All mandatory evidence valid", "Clear", "Eligible for approval"]], [78 * mm, 38 * mm, 46 * mm]),
        ),
        "08_pharmaceutical_distribution_policy.pdf": (
            "POL-GDP-07",
            "Pharmaceutical Distribution Policy",
            "3.1",
            [("Owner", "Responsible Person GDP"), ("Effective", "01 March 2026"), ("Scope", "Storage and distribution of medicinal products"), ("Review cycle", "Annual")],
            [
                ("1. Distribution principles", "Medicinal products must be sourced, stored, handled and transported within authorised channels with traceability and protection from falsification."),
                ("2. Temperature control", "Products labelled for refrigerated storage are maintained at 2 C to 8 C. Qualified packaging, calibrated monitoring and documented receipt checks are required."),
                ("3. Dispatch evidence", "Each cold-chain dispatch records product, lot, quantity, logger identifier, dispatch time, consignee and transport lane."),
                ("4. Excursions", "A temperature excursion triggers quarantine, impact assessment by qualified personnel and a disposition record. Product may not be released solely from an automated recommendation."),
                ("5. Returns and recalls", "Returned medicinal product remains segregated until identity, condition, traceability and storage history are verified. Recall instructions are acknowledged within two hours."),
                ("6. Subcontractors", "Transport subcontractors are qualified, trained, monitored and governed by written quality responsibilities. Material changes require prior notice."),
            ],
            (["Event", "Required action", "Deadline"], [["Temperature excursion", "Quarantine and notify", "2 hours"], ["Suspected falsification", "Block and escalate", "Immediate"], ["Recall", "Acknowledge and trace", "2 hours"]], [56 * mm, 70 * mm, 36 * mm]),
        ),
        "09_insurance_requirements_policy.pdf": (
            "POL-RISK-02",
            "Insurance Requirements",
            "2.0",
            [("Owner", "Enterprise Risk"), ("Effective", "01 July 2026"), ("Applies to", "Critical suppliers and logistics providers"), ("Currency", "EUR")],
            [
                ("1. Minimum cover", "A critical product supplier must maintain product liability cover of at least EUR 2,000,000 per occurrence and in the annual aggregate."),
                ("2. Evidence", "The certificate must identify the insured legal entity, insurer, policy number, period, territorial scope, limits and material exclusions."),
                ("3. Validity", "Cover must be valid at approval and for the planned service period. Renewal evidence is due 30 days before expiry."),
                ("4. Name matching", "The insured legal entity must match the approved supplier or a documented group policy must explicitly extend cover to that entity."),
                ("5. Sub-limits", "Recall and temperature-excursion sub-limits are evaluated against exposure. They do not replace the base product-liability minimum."),
                ("6. Exceptions", "A shortfall requires documented Risk acceptance, an expiry date and mitigating commercial controls. Automated systems may flag but may not approve the exception."),
            ],
            (["Supplier risk", "Minimum", "Exception authority"], [["Critical product", "EUR 2,000,000", "Head of Risk and Legal"], ["High service", "EUR 1,000,000", "Head of Risk"], ["Standard", "Risk assessed", "Business owner"]], [58 * mm, 46 * mm, 58 * mm]),
        ),
        "10_data_protection_policy.pdf": (
            "POL-DP-09",
            "Data Protection and Processor Policy",
            "5.0",
            [("Owner", "Data Protection Officer"), ("Effective", "10 May 2026"), ("Applies to", "Processors and sub-processors"), ("Framework", "GDPR and national law")],
            [
                ("1. Processor onboarding", "Before processing begins, the business documents purpose, categories, locations, recipients, retention and security risk, then executes Article 28 terms."),
                ("2. Data minimisation", "Only fields necessary for fulfilment and quality operations may be transferred. Free text must not be used for health data unless explicitly approved."),
                ("3. Technical measures", "Access control, encryption, logging, backup, vulnerability management, staff training and verified deletion are proportionate to risk."),
                ("4. Incident notification", "A processor must notify the Controller without undue delay and no later than 72 hours after confirmed awareness, while urgent preliminary facts are shared sooner."),
                ("5. Sub-processors", "Sub-processors require equivalent terms, current inventory and prior notice. International transfers require an approved transfer mechanism and assessment."),
                ("6. Exit", "At termination, the processor returns or deletes data as instructed and records exceptions required by law. Access is removed promptly."),
            ],
            (["Issue", "Severity", "Required response"], [["No signed Article 28 terms", "Critical", "Block processing"], ["Incident notice over 72 hours", "Major", "Remediate before approval"], ["Minor inventory gap", "Moderate", "Track corrective action"]], [66 * mm, 34 * mm, 62 * mm]),
        ),
    }

    for spec in SPECS:
        destination = OUTPUT_DIR / spec.filename
        if spec.filename in generators:
            generators[spec.filename](destination)
        else:
            args = policy_args[spec.filename]
            generate_policy(destination, *args)

    for spec in SPECS:
        shutil.copyfile(OUTPUT_DIR / spec.filename, FIXTURE_DIR / spec.filename)

    quarantine = _write_quarantine()
    _write_manifest(quarantine)
    print(f"Generated {len(SPECS)} final PDFs in {OUTPUT_DIR}")
    print(f"Copied verified-source candidates to {FIXTURE_DIR}")
    print(f"Wrote manifest {MANIFEST_PATH}")


if __name__ == "__main__":
    generate_all()
