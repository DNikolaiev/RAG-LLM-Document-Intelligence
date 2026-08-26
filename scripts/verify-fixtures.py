#!/usr/bin/env python3
"""Render and verify the complete CaseLens PDF fixture corpus."""

from __future__ import annotations

import hashlib
import json
import logging
import shutil
import subprocess
import sys
from pathlib import Path

import pdfplumber
from PIL import Image, ImageStat
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "output" / "pdf"
FIXTURE_DIR = ROOT / "fixtures" / "documents" / "pharmacy-supplier"
QUARANTINE_DIR = FIXTURE_DIR / "quarantine"
RENDER_DIR = ROOT / "tmp" / "pdfs" / "rendered"
REPORT_PATH = ROOT / "tmp" / "pdfs" / "verification-report.json"
MANIFEST_PATH = FIXTURE_DIR / "manifest.json"
EXPECTED_FINAL_COUNT = 12
DEFAULT_POPPLER = Path("C:/Users/User/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/poppler/Library/bin/pdftoppm.exe")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def find_pdftoppm() -> str:
    found = shutil.which("pdftoppm")
    if found:
        return found
    if DEFAULT_POPPLER.exists():
        return str(DEFAULT_POPPLER)
    raise RuntimeError("pdftoppm not found; load the bundled workspace dependencies")


def render_document(pdftoppm: str, pdf_path: Path) -> list[Path]:
    target_dir = RENDER_DIR / pdf_path.stem
    if target_dir.exists():
        shutil.rmtree(target_dir)
    target_dir.mkdir(parents=True)
    prefix = target_dir / "page"
    subprocess.run(
        [pdftoppm, "-r", "120", "-png", str(pdf_path), str(prefix)],
        check=True,
        capture_output=True,
        text=True,
    )
    images = sorted(target_dir.glob("page-*.png"))
    if not images:
        raise AssertionError(f"No pages rendered for {pdf_path.name}")
    return images


def image_metrics(image_path: Path) -> dict[str, object]:
    with Image.open(image_path) as image:
        gray = image.convert("L")
        extrema = gray.getextrema()
        stat = ImageStat.Stat(gray)
        return {
            "width": image.width,
            "height": image.height,
            "meanLuminance": round(stat.mean[0], 2),
            "minLuminance": extrema[0],
            "maxLuminance": extrema[1],
        }


def verify_quarantine(manifest: dict) -> dict[str, str]:
    results: dict[str, str] = {}
    corrupt = QUARANTINE_DIR / "corrupted-pdf.pdf"
    pypdf_logger = logging.getLogger("pypdf")
    previous_level = pypdf_logger.level
    pypdf_logger.setLevel(logging.CRITICAL)
    try:
        PdfReader(str(corrupt))
    except Exception:
        results[corrupt.name] = "rejected_as_corrupt"
    else:
        raise AssertionError("Corrupted fixture unexpectedly parsed")
    finally:
        pypdf_logger.setLevel(previous_level)

    wrong_mime = QUARANTINE_DIR / "wrong-mime.pdf"
    assert wrong_mime.read_bytes().startswith(b"\x89PNG\r\n\x1a\n")
    results[wrong_mime.name] = "signature_mismatch_confirmed"

    encrypted = PdfReader(str(QUARANTINE_DIR / "encrypted-insurance.pdf"))
    assert encrypted.is_encrypted
    assert encrypted.decrypt("incorrect-password") == 0
    results["encrypted-insurance.pdf"] = "encryption_confirmed"

    empty = QUARANTINE_DIR / "empty-input.pdf"
    assert empty.stat().st_size == 0
    results[empty.name] = "empty_confirmed"

    unsupported = QUARANTINE_DIR / "unsupported-note.rtf"
    assert unsupported.suffix == ".rtf" and unsupported.stat().st_size > 0
    results[unsupported.name] = "unsupported_extension_confirmed"

    duplicate = QUARANTINE_DIR / "duplicate-insurance-certificate.pdf"
    original = OUTPUT_DIR / manifest["quarantine"][duplicate.name]["duplicateOf"]
    assert sha256(duplicate) == sha256(original)
    results[duplicate.name] = "byte_duplicate_confirmed"
    return results


def main() -> int:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    documents = manifest["documents"]
    final_pdfs = sorted(OUTPUT_DIR.glob("*.pdf"))
    assert len(documents) == EXPECTED_FINAL_COUNT, f"Manifest has {len(documents)} documents"
    assert len(final_pdfs) == EXPECTED_FINAL_COUNT, f"Output has {len(final_pdfs)} PDFs"
    assert {path.name for path in final_pdfs} == {item["filename"] for item in documents}

    pdftoppm = find_pdftoppm()
    report: dict[str, object] = {"status": "pass", "finalPdfCount": len(final_pdfs), "documents": [], "quarantine": {}}
    for item in documents:
        output_path = OUTPUT_DIR / item["filename"]
        fixture_path = FIXTURE_DIR / item["filename"]
        assert fixture_path.exists(), f"Missing fixture copy: {fixture_path}"
        actual_hash = sha256(output_path)
        assert actual_hash == item["sha256"], f"Hash mismatch: {output_path.name}"
        assert sha256(fixture_path) == actual_hash, f"Fixture copy differs: {fixture_path.name}"

        extraction_engine = "pdfplumber"
        with pdfplumber.open(output_path) as pdf:
            assert len(pdf.pages) == item["expectedPages"], f"Page count mismatch: {output_path.name}"
            page_text = [(page.extract_text() or "") for page in pdf.pages]
            text = "\n".join(page_text)
        # Some native extractors return an empty stream for metadata-rotated pages.
        # Verification deliberately exercises a second standards-compliant extractor
        # so the fixture is proven to contain text while retaining the orientation edge.
        if not text.strip() or any(phrase not in text for phrase in item["expectedPhrases"]):
            reader = PdfReader(str(output_path))
            page_text = [(page.extract_text() or "") for page in reader.pages]
            text = "\n".join(page_text)
            extraction_engine = "pypdf_rotation_fallback"
        missing = [phrase for phrase in item["expectedPhrases"] if phrase not in text]
        assert not missing, f"Missing phrases in {output_path.name}: {missing}"
        for evidence in item.get("evidence", []):
            page_index = int(evidence["page"]) - 1
            assert evidence["phrase"] in page_text[page_index], f"Evidence phrase not on expected page in {output_path.name}: {evidence}"

        images = render_document(pdftoppm, output_path)
        assert len(images) == item["expectedPages"]
        metrics = [image_metrics(image) for image in images]
        for image, values in zip(images, metrics):
            assert values["width"] >= 900 and values["height"] >= 900, f"Unexpected render size: {image}"
            assert values["minLuminance"] < 245, f"Rendered page looks blank: {image}"
            assert values["maxLuminance"] > 250, f"Rendered page has no paper background: {image}"

        report["documents"].append(
            {
                "filename": output_path.name,
                "sha256": actual_hash,
                "pages": len(images),
                "renderedImages": [str(path.relative_to(ROOT)).replace("\\", "/") for path in images],
                "imageMetrics": metrics,
                "textCharacters": len(text),
                "extractionEngine": extraction_engine,
                "expectedPhrasesVerified": len(item["expectedPhrases"]),
            }
        )
        print(f"PASS {output_path.name}: {len(images)} page(s), {len(text)} extracted characters")

    report["quarantine"] = verify_quarantine(manifest)
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"PASS quarantine: {len(report['quarantine'])} failure/duplicate cases")
    print(f"PASS corpus: {EXPECTED_FINAL_COUNT} PDFs rendered and verified")
    print(f"Report: {REPORT_PATH}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"FAIL: {error}", file=sys.stderr)
        raise
