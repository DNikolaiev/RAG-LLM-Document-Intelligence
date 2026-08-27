import base64
import io
from typing import Literal

import fitz
import pytesseract
from fastapi import FastAPI, HTTPException
from PIL import Image
from pydantic import BaseModel, Field

MAX_BYTES = 16 * 1024 * 1024
app = FastAPI(title="CaseLens local document text service", version="1.0.0")


class DocumentRequest(BaseModel):
    content: str
    mediaType: str = "application/pdf"


class OcrRequest(BaseModel):
    content: str
    page: int = Field(ge=1)
    rotation: Literal[0, 90, 180, 270] | None = None
    languageHints: list[str] = Field(default_factory=list)


class TextPage(BaseModel):
    page: int
    text: str
    rotation: Literal[0, 90, 180, 270] = 0
    language: str | None = None
    confidence: float = Field(ge=0, le=1)


def decode_content(value: str) -> bytes:
    try:
        content = base64.b64decode(value, validate=True)
    except ValueError as error:
        raise HTTPException(status_code=400, detail="content must be valid base64") from error
    if not content or len(content) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="document is empty or exceeds 16 MiB")
    return content


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "engine": "pymupdf+tesseract"}


@app.post("/v1/text")
def extract_text(request: DocumentRequest) -> dict[str, list[TextPage]]:
    content = decode_content(request.content)
    if request.mediaType == "text/plain":
        return {"pages": [TextPage(page=1, text=content.decode("utf-8", errors="replace"), confidence=1)]}
    if request.mediaType != "application/pdf":
        raise HTTPException(status_code=415, detail="only PDF and plain text are supported")
    try:
        document = fitz.open(stream=content, filetype="pdf")
        pages = [
            TextPage(page=index + 1, text=page.get_text("text"), rotation=page.rotation, confidence=1)
            for index, page in enumerate(document)
        ]
        document.close()
        return {"pages": pages}
    except Exception as error:
        raise HTTPException(status_code=422, detail="PDF could not be parsed") from error


@app.post("/v1/ocr")
def recognize(request: OcrRequest) -> TextPage:
    content = decode_content(request.content)
    try:
        document = fitz.open(stream=content, filetype="pdf")
        if request.page > len(document):
            raise HTTPException(status_code=400, detail="page is outside the document")
        page = document[request.page - 1]
        matrix = fitz.Matrix(2.2, 2.2).prerotate(request.rotation or 0)
        pixmap = page.get_pixmap(matrix=matrix, alpha=False)
        image = Image.open(io.BytesIO(pixmap.tobytes("png")))
        requested = [code for code in request.languageHints if code in {"eng", "deu"}]
        language = "+".join(requested) or "eng+deu"
        data = pytesseract.image_to_data(image, lang=language, output_type=pytesseract.Output.DICT)
        words = [word.strip() for word in data["text"] if word.strip()]
        scores = [float(score) for score in data["conf"] if float(score) >= 0]
        document.close()
        confidence = (sum(scores) / len(scores) / 100) if scores else 0
        return TextPage(
            page=request.page,
            text=" ".join(words),
            rotation=request.rotation or 0,
            language=language,
            confidence=max(0, min(1, confidence)),
        )
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=422, detail="OCR could not process the PDF page") from error
