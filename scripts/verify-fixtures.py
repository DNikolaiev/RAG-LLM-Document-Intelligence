#!/usr/bin/env python3
"""Render and verify every CaseLens PDF fixture corpus."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import logging
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

import pdfplumber
from PIL import Image, ImageStat
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[1]
RENDER_DIR = ROOT / "tmp" / "pdfs" / "rendered"
REPORT_PATH = ROOT / "tmp" / "pdfs" / "verification-report.json"
DEFAULT_POPPLER = Path("C:/Users/User/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/poppler/Library/bin/pdftoppm.exe")


@dataclass(frozen=True)
class Corpus:
    """One manifest-described fixture corpus.

    ``manifest_dir`` holds the copies the manifest hashes describe. When
    ``output_dir`` is set the generator writes there first and copies into
    ``manifest_dir``, so both copies must stay byte identical.
    """

    name: str
    manifest_path: Path
    manifest_dir: Path
    expected_document_count: int
    output_dir: Path | None = None
    quarantine_dir: Path | None = None
    generator: Path | None = None


CORPORA = (
    Corpus(
        name="pharmacy-supplier",
        manifest_path=ROOT / "fixtures" / "documents" / "pharmacy-supplier" / "manifest.json",
        manifest_dir=ROOT / "fixtures" / "documents" / "pharmacy-supplier",
        expected_document_count=12,
        output_dir=ROOT / "output" / "pdf",
        quarantine_dir=ROOT / "fixtures" / "documents" / "pharmacy-supplier" / "quarantine",
    ),
    Corpus(
        name="multi-tenant-policy-evidence",
        manifest_path=ROOT / "fixtures" / "documents" / "multi-tenant-fixture-pack.json",
        manifest_dir=ROOT / "fixtures" / "documents",
        expected_document_count=12,
        generator=ROOT / "scripts" / "generate-multi-tenant-fixtures.py",
    ),
)


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


def render_document(pdftoppm: str, pdf_path: Path, corpus_name: str) -> list[Path]:
    target_dir = RENDER_DIR / corpus_name / pdf_path.stem
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


def verify_quarantine(quarantine_dir: Path, output_dir: Path, manifest: dict) -> dict[str, str]:
    results: dict[str, str] = {}
    corrupt = quarantine_dir / "corrupted-pdf.pdf"
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

    wrong_mime = quarantine_dir / "wrong-mime.pdf"
    assert wrong_mime.read_bytes().startswith(b"\x89PNG\r\n\x1a\n")
    results[wrong_mime.name] = "signature_mismatch_confirmed"

    encrypted = PdfReader(str(quarantine_dir / "encrypted-insurance.pdf"))
    assert encrypted.is_encrypted
    assert encrypted.decrypt("incorrect-password") == 0
    results["encrypted-insurance.pdf"] = "encryption_confirmed"

    empty = quarantine_dir / "empty-input.pdf"
    assert empty.stat().st_size == 0
    results[empty.name] = "empty_confirmed"

    unsupported = quarantine_dir / "unsupported-note.rtf"
    assert unsupported.suffix == ".rtf" and unsupported.stat().st_size > 0
    results[unsupported.name] = "unsupported_extension_confirmed"

    duplicate = quarantine_dir / "duplicate-insurance-certificate.pdf"
    original = output_dir / manifest["quarantine"][duplicate.name]["duplicateOf"]
    assert sha256(duplicate) == sha256(original)
    results[duplicate.name] = "byte_duplicate_confirmed"
    return results


def verify_regeneration(corpus: Corpus, documents: list[dict]) -> dict[str, object]:
    """Generate the corpus twice into scratch directories and compare hashes.

    Only run-to-run stability is asserted. The committed corpus is generated
    from whichever font the generating host offered (Arial on Windows, DejaVu
    Sans elsewhere), so matching the recorded hashes is reported rather than
    required.
    """
    if importlib.util.find_spec("reportlab") is None:
        return {"status": "skipped_reportlab_unavailable"}

    runs: list[dict[str, str]] = []
    with tempfile.TemporaryDirectory(prefix="caselens-fixtures-") as scratch:
        for index in (1, 2):
            target = Path(scratch) / f"generation-{index}"
            subprocess.run(
                [sys.executable, str(corpus.generator), "--output-dir", str(target)],
                check=True,
                capture_output=True,
                text=True,
            )
            runs.append({item["filename"]: sha256(target / item["filename"]) for item in documents})

    unstable = sorted(name for name, digest in runs[0].items() if runs[1][name] != digest)
    assert not unstable, f"Generation is not byte stable for: {unstable}"
    recorded = {item["filename"]: item["sha256"] for item in documents}
    return {
        "status": "byte_stable_across_two_generations",
        "documentsCompared": len(runs[0]),
        "matchesRecordedManifest": runs[0] == recorded,
    }


def verify_document(corpus: Corpus, item: dict, pdftoppm: str) -> dict[str, object]:
    source_dir = corpus.output_dir or corpus.manifest_dir
    source_path = source_dir / item["filename"]
    assert source_path.exists(), f"Missing fixture: {source_path}"
    actual_hash = sha256(source_path)
    assert actual_hash == item["sha256"], f"Hash mismatch: {item['filename']}"
    if corpus.output_dir is not None:
        fixture_path = corpus.manifest_dir / item["filename"]
        assert fixture_path.exists(), f"Missing fixture copy: {fixture_path}"
        assert sha256(fixture_path) == actual_hash, f"Fixture copy differs: {item['filename']}"
    if "bytes" in item:
        assert source_path.stat().st_size == item["bytes"], f"Size mismatch: {item['filename']}"

    extraction_engine = "pdfplumber"
    with pdfplumber.open(source_path) as pdf:
        assert len(pdf.pages) == item["expectedPages"], f"Page count mismatch: {item['filename']}"
        page_text = [(page.extract_text() or "") for page in pdf.pages]
        text = "\n".join(page_text)
    # Some native extractors return an empty stream for metadata-rotated pages.
    # Verification deliberately exercises a second standards-compliant extractor
    # so the fixture is proven to contain text while retaining the orientation edge.
    if not text.strip() or any(phrase not in text for phrase in item["expectedPhrases"]):
        reader = PdfReader(str(source_path))
        page_text = [(page.extract_text() or "") for page in reader.pages]
        text = "\n".join(page_text)
        extraction_engine = "pypdf_rotation_fallback"
    missing = [phrase for phrase in item["expectedPhrases"] if phrase not in text]
    assert not missing, f"Missing phrases in {item['filename']}: {missing}"
    for evidence in item.get("evidence", []):
        page_index = int(evidence["page"]) - 1
        assert evidence["phrase"] in page_text[page_index], f"Evidence phrase not on expected page in {item['filename']}: {evidence}"

    images = render_document(pdftoppm, source_path, corpus.name)
    assert len(images) == item["expectedPages"]
    metrics = [image_metrics(image) for image in images]
    for image, values in zip(images, metrics):
        assert values["width"] >= 900 and values["height"] >= 900, f"Unexpected render size: {image}"
        assert values["minLuminance"] < 245, f"Rendered page looks blank: {image}"
        assert values["maxLuminance"] > 250, f"Rendered page has no paper background: {image}"

    print(f"PASS {corpus.name}/{item['filename']}: {len(images)} page(s), {len(text)} extracted characters")
    return {
        "filename": item["filename"],
        "sha256": actual_hash,
        "pages": len(images),
        "renderedImages": [str(path.relative_to(ROOT)).replace("\\", "/") for path in images],
        "imageMetrics": metrics,
        "textCharacters": len(text),
        "extractionEngine": extraction_engine,
        "expectedPhrasesVerified": len(item["expectedPhrases"]),
        "evidenceAnchorsVerified": len(item.get("evidence", [])),
    }


def verify_corpus(corpus: Corpus, pdftoppm: str) -> dict[str, object]:
    manifest = json.loads(corpus.manifest_path.read_text(encoding="utf-8"))
    documents = manifest["documents"]
    assert len(documents) == corpus.expected_document_count, f"{corpus.name} manifest has {len(documents)} documents"
    if corpus.output_dir is not None:
        final_pdfs = sorted(corpus.output_dir.glob("*.pdf"))
        assert len(final_pdfs) == corpus.expected_document_count, f"{corpus.output_dir} has {len(final_pdfs)} PDFs"
        assert {path.name for path in final_pdfs} == {item["filename"] for item in documents}

    section: dict[str, object] = {
        "name": corpus.name,
        "manifest": str(corpus.manifest_path.relative_to(ROOT)).replace("\\", "/"),
        "documentCount": len(documents),
        "documents": [verify_document(corpus, item, pdftoppm) for item in documents],
    }

    if corpus.quarantine_dir is not None:
        assert corpus.output_dir is not None, f"{corpus.name} needs generated output to confirm duplicates"
        section["quarantine"] = verify_quarantine(corpus.quarantine_dir, corpus.output_dir, manifest)
        print(f"PASS {corpus.name} quarantine: {len(section['quarantine'])} failure/duplicate cases")

    if corpus.generator is not None:
        regeneration = verify_regeneration(corpus, documents)
        section["regeneration"] = regeneration
        if regeneration["status"] == "skipped_reportlab_unavailable":
            print(f"SKIP {corpus.name} regeneration: reportlab is not installed")
        else:
            matched = "matching" if regeneration["matchesRecordedManifest"] else "differing from"
            print(
                f"PASS {corpus.name} regeneration: two consecutive generations produced identical "
                f"SHA-256 values, {matched} the recorded manifest"
            )

    print(f"PASS {corpus.name}: {len(documents)} PDFs rendered and verified")
    return section


def main() -> int:
    pdftoppm = find_pdftoppm()
    report: dict[str, object] = {"status": "pass", "corpora": [verify_corpus(corpus, pdftoppm) for corpus in CORPORA]}
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    total = sum(int(section["documentCount"]) for section in report["corpora"])
    print(f"PASS corpus: {total} PDFs across {len(CORPORA)} manifests rendered and verified")
    print(f"Report: {REPORT_PATH}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"FAIL: {error}", file=sys.stderr)
        raise
