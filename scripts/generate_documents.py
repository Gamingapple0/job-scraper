#!/usr/bin/env python3
"""
Stage: documents (zero LLM cost).

Reads the manifest written by `generate-documents` (career_profile and
cover_letter are already-finished text from the earlier LLM stages — this
script never writes any resume/letter prose itself, and everything below is
plain deterministic text/layout logic, not judgment) and produces one PDF
resume and one PDF cover letter per job:

  1. Resume: fetch the job's base resume Google Doc (by id, anonymous
     export), find the paragraph right after the "Career Profile" heading,
     replace ONLY that paragraph's text with the job's career_profile
     (keeping the original run's size/bold/italic, but always forcing the
     font to Calibri explicitly on ascii/hAnsi/eastAsia/cs — see FONT and
     _force_font below); always normalizes the name-line paragraph to just
     Anshu's name plus " | " + relocationNote when the job isn't
     Melbourne/VIC (never appends to whatever is already on that line — the
     base doc is Anshu's own live Google Doc, so at fetch time it may carry
     a leftover note from something he was last editing by hand); dedupes
     the Technical Skills list (the template has an accidental repeat —
     "JavaScript" appears twice — this drops exact repeats only, every
     distinct skill Anshu has in the Google Doc is always kept, never
     trimmed for length). Only Career Profile, Technical Skills (dedupe
     only) and the name line are ever rewritten — Education and Employment
     text is never touched, even when fitting the page (see step 3). Save
     as .docx.
  2. Cover letter: build a plain, ATS-friendly .docx from scratch — name,
     phone/email, LinkedIn and portfolio each on their own line (packing
     them onto one line let the LinkedIn URL wrap mid-address, which looked
     broken), "Dear {company} Hiring Team,", the cover_letter body
     (paragraphs split on blank lines), "Best Regard," sign-off. No date —
     Anshu may send the same letter again later. Spacing between blocks
     comes from a single explicit space-after value per paragraph, not
     blank spacer paragraphs stacked on top of the style's own spacing
     (that double-spacing was making these look far too open).
  3. Convert to PDF and check the page count. The base template itself
     renders at one page in Google Docs but tips into a second page once
     rendered through LibreOffice (font-substitution/metric differences,
     not a content problem), more so with a longer career profile. Both
     letter and resume must stay to one page without ever touching font
     size, Education, Employment, or dropping a Technical Skill. The lever
     is the page margins: nudge the top/bottom margins in a few inches at
     a time (still well within normal print margins) until it fits — this
     alone fit 28 of 29 real jobs' full, untrimmed content at one page in
     testing. Only if margins hit their floor and it's still overflowing
     does Career Profile condensation (drop trailing sentences, floored at
     2) kick in as a last resort. This is deterministic layout/string
     logic against a measured page count, not a rewrite — it never asks an
     LLM to shorten anything, and it never shortens the skills list.
  4. Every render used for the page-fit check (step 3) happens in a LOCAL
     scratch directory, never in the real (OneDrive-mounted) output folder —
     only the final, already-fitted PDF is copied there, once, per job. The
     first version of this script rendered straight into the mounted folder
     on every fit iteration, which was both far slower (each write appears
     to go through OneDrive's sync watcher) and the source of stray
     `.~lock.*#` / `*.tmp` files LibreOffice left behind there. Doing all the
     iteration locally and copying only the finished file fixes both at the
     root instead of just sweeping the mess up afterwards.
  5. International jobs (isInternational=True, i.e. job.location.country !=
     'AU') get two extra tweaks a local application doesn't need: the resume
     and cover letter phone number switches from the local 04... format to
     "+61 406 973 781" (a domestic number doesn't dial from overseas), and
     the resume's name-line headline gets " | PTE: 88" appended after the
     relocation note.
  6. Where the PDFs go is decided by the caller, not here: each manifest
     entry carries its own `outDir` (one folder per company, an existing
     one if the company already has a folder). This script only creates
     that folder if it is missing and writes the two finished PDFs into it.

Usage: generate_documents.py <manifest.json>
Manifest shape: [{id, company, careerProfile, coverLetter, relocationNote,
                  isInternational, resumeDocId, outDir, resumeFileName,
                  coverLetterFileName}]   (file names end in .docx; the PDFs
                  are published under the same stem)
Prints a JSON result array to stdout: [{id, ok, error?, pages?, warning?}]
"""
import json
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

import docx
from docx.oxml.ns import qn
from docx.oxml import OxmlElement
from docx.shared import Pt, Emu

NAME = "ANSHU MADHIKARMI"
PHONE_LOCAL = "0406973781"
PHONE_INTL = "+61 406 973 781"
LINKEDIN = "https://www.linkedin.com/in/anshu-madhikarmi/"
PORTFOLIO = "https://anshumadhikarmi.netlify.app/"
FONT = "Calibri"


def contact_line(is_international: bool) -> str:
    phone = PHONE_INTL if is_international else PHONE_LOCAL
    return f"{phone}  |  madhikarmianshu@gmail.com"

# Page-fit: margins are nudged in these steps (inches) before anything else
# is touched; MARGIN_MAX_IN is a floor, not a target — still normal print
# margins, never approaching the text.
MARGIN_START_IN = 0.15
MARGIN_STEP_IN = 0.05
MARGIN_MAX_IN = 0.35
# Last-resort fallback if margins alone can't fit it: floor so Career
# Profile is condensed, never gutted. Technical Skills is never condensed —
# only deduped (see dedupe_technical_skills) — so it has no floor here.
MIN_PROFILE_SENTENCES = 2
MAX_FIT_ATTEMPTS = 20


def fetch_doc(doc_id: str, dest: Path) -> None:
    url = f"https://docs.google.com/document/d/{doc_id}/export?format=docx"
    with urllib.request.urlopen(url, timeout=30) as resp:
        dest.write_bytes(resp.read())


def _force_font(run, name: str = FONT) -> None:
    """Sets ascii/hAnsi/eastAsia/cs all to `name` explicitly. python-docx's
    `run.font.name =` setter only sets ascii+hAnsi, leaving eastAsia/cs to
    fall back to the document's default (often a serif font) — that gap is
    exactly what was producing the mismatched font on the relocation note."""
    run.font.name = name
    rPr = run._element.get_or_add_rPr()
    rFonts = rPr.find(qn('w:rFonts'))
    if rFonts is None:
        rFonts = OxmlElement('w:rFonts')
        rPr.insert(0, rFonts)
    rFonts.set(qn('w:eastAsia'), name)
    rFonts.set(qn('w:cs'), name)


def set_name_header(docx_path: Path, relocation_note: str | None, is_international: bool) -> None:
    """Normalizes paragraph 0 (the name line) to just NAME, plus
    " | " + relocation note when there is one — matching Anshu's own
    pipe-separated convention on that line, not an em dash — and, for an
    international job, a further " | PTE: 88" (his PTE Academic score,
    relevant overseas, irrelevant for an AU job). Always REPLACES the
    paragraph's text rather than appending to whatever is already there:
    the base doc is Anshu's own live Google Doc, which he edits by hand
    too, so at fetch time it may carry a leftover note from whatever he
    was last working on. The note run copies the name run's bold/size and
    is never italic — same weight and font as the name, no visual
    mismatch."""
    doc = docx.Document(str(docx_path))
    p = doc.paragraphs[0]
    r0 = p.runs[0] if p.runs else p.add_run("")
    font_size, bold = r0.font.size, r0.font.bold
    for r in p.runs[1:]:
        r.text = ""
    r0.text = NAME
    _force_font(r0)
    r0.font.size, r0.font.bold = font_size, bold
    if relocation_note:
        note_text = f" | {relocation_note}"
        if is_international:
            note_text += " | PTE: 88"
        note_run = p.add_run(note_text)
        _force_font(note_run)
        note_run.font.size, note_run.font.bold = font_size, bold
        note_run.italic = False
    doc.save(str(docx_path))


def set_international_phone(docx_path: Path, is_international: bool) -> None:
    """Swaps the phone number to "+61 406 973 781" in the resume's contact
    block (the local 0406973781 format doesn't dial from overseas) — a
    no-op for an AU job. Only edits runs whose text contains the phone
    digits, scanning just the first few paragraphs (name line, contact
    line); python-docx's `paragraph.runs` never includes text inside a
    `w:hyperlink` element, so the LinkedIn/Portfolio hyperlinks on the same
    line can't be touched by this."""
    if not is_international:
        return
    doc = docx.Document(str(docx_path))
    for p in doc.paragraphs[:3]:
        for r in p.runs:
            if PHONE_LOCAL in r.text:
                r.text = r.text.replace(PHONE_LOCAL, PHONE_INTL)
    doc.save(str(docx_path))


def _find_section(paras, heading: str) -> tuple[int, int]:
    heading_idx = next((i for i, p in enumerate(paras) if p.text.strip().lower() == heading.lower()), None)
    if heading_idx is None:
        raise RuntimeError(f'template has no "{heading}" heading paragraph')
    content_idx = next((i for i in range(heading_idx + 1, len(paras)) if paras[i].text.strip()), None)
    if content_idx is None:
        raise RuntimeError(f'found "{heading}" heading but no content paragraph after it')
    return heading_idx, content_idx


def _set_paragraph_text(p, new_text: str) -> None:
    r0 = p.runs[0] if p.runs else p.add_run("")
    font_size, bold, italic = r0.font.size, r0.font.bold, r0.font.italic
    for r in p.runs[1:]:
        r.text = ""
    r0.text = new_text
    _force_font(r0)
    r0.font.size, r0.font.bold, r0.font.italic = font_size, bold, italic


def swap_career_profile(docx_path: Path, new_text: str) -> None:
    doc = docx.Document(str(docx_path))
    _, content_idx = _find_section(doc.paragraphs, "Career Profile")
    _set_paragraph_text(doc.paragraphs[content_idx], new_text)
    doc.save(str(docx_path))


def dedupe_technical_skills(docx_path: Path) -> None:
    """Drops exact repeats from the Technical Skills list (the base
    template has one — "JavaScript" appears twice), preserving first-seen
    order. Never drops a distinct skill and never shortens the list for
    length — that's not condensation, just fixing a copy-paste repeat."""
    doc = docx.Document(str(docx_path))
    _, content_idx = _find_section(doc.paragraphs, "Technical Skills")
    p = doc.paragraphs[content_idx]
    seen, deduped = set(), []
    for item in (s.strip() for s in p.text.split(",")):
        key = item.lower()
        if item and key not in seen:
            seen.add(key)
            deduped.append(item)
    new_text = ", ".join(deduped)
    if new_text != p.text:
        _set_paragraph_text(p, new_text)
        doc.save(str(docx_path))


def _condense_profile(text: str) -> str | None:
    """Drops the last sentence. None once at MIN_PROFILE_SENTENCES."""
    sentences = [s.strip() for s in re.split(r'(?<=[.!?])\s+', text.strip()) if s.strip()]
    if len(sentences) <= MIN_PROFILE_SENTENCES:
        return None
    return " ".join(sentences[:-1])


def count_pages(pdf_path: Path) -> int:
    out = subprocess.run(["pdfinfo", str(pdf_path)], capture_output=True, text=True, check=True).stdout
    m = re.search(r"^Pages:\s+(\d+)", out, re.M)
    return int(m.group(1)) if m else 1


def convert_single(docx_path: Path, work_dir: Path) -> Path:
    """Renders into `work_dir`, which must be a LOCAL directory (not the
    OneDrive-mounted output folder) — see the module docstring, point 4."""
    subprocess.run(
        ["soffice", "--headless", "--convert-to", "pdf", "--outdir", str(work_dir), str(docx_path)],
        check=True, capture_output=True, timeout=60,
    )
    return work_dir / (docx_path.stem + ".pdf")


def _publish(pdf_path: Path, out_dir: Path, final_name: str) -> None:
    """Copies the one finished PDF out to the real output folder. The only
    write this script ever makes to `out_dir`."""
    shutil.copy2(pdf_path, out_dir / final_name)


def _set_margin_reduction(docx_path: Path, orig_top: Emu, orig_bottom: Emu, reduction_in: float) -> None:
    doc = docx.Document(str(docx_path))
    s = doc.sections[0]
    delta = Emu(int(reduction_in * 914400))
    s.top_margin = Emu(max(0, int(orig_top) - int(delta)))
    s.bottom_margin = Emu(max(0, int(orig_bottom) - int(delta)))
    doc.save(str(docx_path))


def fit_to_one_page(resume_path: Path, work_dir: Path) -> tuple[Path, int]:
    """Nudges top/bottom margins in (see MARGIN_*) until the rendered PDF is
    one page; only once margins hit their floor and it still overflows does
    it fall back to condensing Career Profile (floored). Technical Skills,
    font size, Education and Employment are never touched here. Renders
    only into the local `work_dir`. Returns (final pdf path, page count)."""
    doc0 = docx.Document(str(resume_path))
    orig_top, orig_bottom = doc0.sections[0].top_margin, doc0.sections[0].bottom_margin

    pdf_path = convert_single(resume_path, work_dir)
    pages = count_pages(pdf_path)
    reduction = 0.0
    attempts = 0
    while pages > 1 and attempts < MAX_FIT_ATTEMPTS:
        attempts += 1
        if reduction < MARGIN_MAX_IN:
            reduction = MARGIN_START_IN if reduction == 0.0 else min(reduction + MARGIN_STEP_IN, MARGIN_MAX_IN)
            _set_margin_reduction(resume_path, orig_top, orig_bottom, reduction)
        else:
            doc = docx.Document(str(resume_path))
            _, profile_idx = _find_section(doc.paragraphs, "Career Profile")
            condensed = _condense_profile(doc.paragraphs[profile_idx].text)
            if condensed is None:
                break  # margins maxed and profile floored; best effort, report actual page count
            _set_paragraph_text(doc.paragraphs[profile_idx], condensed)
            doc.save(str(resume_path))
        pdf_path = convert_single(resume_path, work_dir)
        pages = count_pages(pdf_path)
    return pdf_path, pages


def build_cover_letter(company: str, body: str, dest: Path, is_international: bool) -> None:
    doc = docx.Document()
    style = doc.styles["Normal"]
    style.font.size = Pt(11)

    def add(text: str, *, bold=False, size=Pt(11), space_after=Pt(10)) -> None:
        p = doc.add_paragraph()
        p.paragraph_format.space_after = space_after
        p.paragraph_format.space_before = Pt(0)
        r = p.add_run(text)
        _force_font(r)
        r.font.size = size
        r.font.bold = bold

    add(NAME, bold=True, size=Pt(14), space_after=Pt(2))
    add(contact_line(is_international), space_after=Pt(2))
    add(LINKEDIN, space_after=Pt(2))
    add(PORTFOLIO, space_after=Pt(16))
    add(f"Dear {company} Hiring Team,", space_after=Pt(12))
    paras = [p.strip() for p in body.split("\n\n") if p.strip()]
    for para in paras:
        add(para, space_after=Pt(10))
    add("Best Regard,", space_after=Pt(0))
    add("Anshu Madhikarmi", space_after=Pt(0))
    doc.save(str(dest))


def fit_cover_letter_to_one_page(letter_path: Path, work_dir: Path) -> tuple[Path, int]:
    """No text-condensation lever here (the body is already-drafted LLM
    prose, out of scope for this zero-LLM-cost stage to rewrite) — the
    layout fix above (single explicit space-after, no blank spacer
    paragraphs) is what brings these back to one page. This just reports
    the final page count so an outlier that's still too long is visible in
    the run summary rather than silently shipped as a 2-page letter."""
    pdf_path = convert_single(letter_path, work_dir)
    return pdf_path, count_pages(pdf_path)


def main() -> None:
    manifest_path = Path(sys.argv[1])
    jobs = json.loads(manifest_path.read_text(encoding="utf-8"))

    scratch = Path(tempfile.mkdtemp(prefix="docgen-"))
    work_dir = scratch / "render"  # local PDF render target for every fit attempt — see module docstring, point 4
    work_dir.mkdir()
    doc_cache: dict[str, Path] = {}
    results = []

    for job in jobs:
        try:
            is_intl = bool(job.get("isInternational"))
            segment_dir = Path(job["outDir"])
            segment_dir.mkdir(parents=True, exist_ok=True)

            doc_id = job["resumeDocId"]
            if doc_id not in doc_cache:
                cached = scratch / f"base-{doc_id}.docx"
                fetch_doc(doc_id, cached)
                doc_cache[doc_id] = cached

            resume_out = scratch / job["resumeFileName"]
            resume_out.write_bytes(doc_cache[doc_id].read_bytes())
            swap_career_profile(resume_out, job["careerProfile"])
            set_name_header(resume_out, job.get("relocationNote"), is_intl)
            set_international_phone(resume_out, is_intl)
            dedupe_technical_skills(resume_out)
            resume_pdf, resume_pages = fit_to_one_page(resume_out, work_dir)
            _publish(resume_pdf, segment_dir, resume_out.stem + ".pdf")

            letter_out = scratch / job["coverLetterFileName"]
            build_cover_letter(job["company"], job["coverLetter"], letter_out, is_intl)
            letter_pdf, letter_pages = fit_cover_letter_to_one_page(letter_out, work_dir)
            _publish(letter_pdf, segment_dir, letter_out.stem + ".pdf")

            entry = {"id": job["id"], "ok": True, "pages": {"resume": resume_pages, "coverLetter": letter_pages}}
            if resume_pages > 1 or letter_pages > 1:
                entry["warning"] = "still over one page after maxing out margin reduction and career-profile condensation"
            results.append(entry)
        except Exception as e:  # noqa: BLE001 - report, don't crash the whole batch
            results.append({"id": job["id"], "ok": False, "error": str(e)})

    shutil.rmtree(scratch, ignore_errors=True)  # this runs daily via the scheduled task; don't leak a new tmp dir every time
    print(json.dumps(results))


if __name__ == "__main__":
    main()
