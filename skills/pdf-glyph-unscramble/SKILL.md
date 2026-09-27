---
name: pdf-glyph-unscramble
description: Recover garbled copy/search text from visually correct PDFs with embedded TrueType glyphs and broken /ToUnicode maps. Inspect page and Form font scopes, match glyphs to a supplied reference font, rebuild text maps, and verify extraction and rendering. CFF and image-only PDFs need a different path.
---

# PDF Text-Layer Recovery (Anti-Copy / Glyph Unscramble)

## How to read this reference

The snippets are composable reference code, not a standalone program. Supply the input PDF, output PDF, and reference fonts for each job. Keep the original PDF and embedded fonts unchanged; write a separate output with repaired `/ToUnicode` streams. This workflow supports `/FontFile2` TrueType fonts with `glyf` outlines. Use a separate parser or OCR workflow for CFF, image-only pages, or unsupported encodings.

## Symptoms

Reach for this skill when:
- Copy or search returns unrelated symbols while the page **renders correctly**.
- `/ToUnicode` is missing, identity, or present-but-wrong: it maps codes to unrelated ASCII, control codes, or Private Use Area (PUA) codepoints.
- Extraction yields `U+FFFD` or stray Latin letters where the page shows a non-Latin script.

## Mental model

A PDF keeps rendering and semantics in two layers:
- **Visual layer**: the embedded font program plus, for CID fonts, `/CIDToGIDMap`, which turns CIDs into Glyph IDs (GIDs).
- **Text layer**: `/ToUnicode`, which turns character codes into Unicode for copy and search.

These are the supported font shapes:

| Pattern | Font shape | What is broken | Repair |
| :-- | :-- | :-- | :-- |
| A. Identity CID = GID | Type0 + `/Identity-H`, `/CIDToGIDMap /Identity` | code == GID; `/ToUnicode` is missing, identity, or maps codes to unrelated values | rebuild `/ToUnicode` as GID -> Unicode |
| B. Mapped CID | Type0 + `/Identity-H`, `/CIDToGIDMap` stream | explicit CID -> GID map; `/ToUnicode` missing or wrong | rebuild `/ToUnicode` as CID -> Unicode |
| C. Simple TrueType | `/Subtype /TrueType`, `/Encoding` absent or `/Differences` | no `/ToUnicode` at all | build `/ToUnicode` keyed by character code |

A GID is meaningless without its font. Only the reference font, or the embedded glyph outlines themselves, tells you which character a GID represents.

**One visual line is often split across several fonts.** Anti-copy tooling routes each run through a different subset, so one font may carry only punctuation while its neighbour carries the Thai, and only one of them may have a broken text layer. This is why extraction can come out half-correct and half-garbage from a single line. Repair and verify every font scope, never the first broken one.

## Step 0 - Diagnose every used font scope

Parse content operators in pages and invoked nested `/Form` XObjects. Keep fonts keyed by object identity, since separate subsets can share `/BaseFont` and resource names can repeat. This collector also supplies the used-code sets for final coverage verification. PDF literal strings can contain escapes or apparent operators, so do not scan raw streams with regex.

```python
from collections import defaultdict
from pypdf.generic import ContentStream


def collect_usage(pdf):
    fonts, used = {}, defaultdict(set)

    def walk(resources, page_resources, stream, active_forms=frozenset(), current=None):
        for operands, operator in ContentStream(stream, pdf).operations:
            if operator == b"Tf":
                ref = (resources.get("/Font") or {}).get(operands[0])
                if ref is None:
                    raise ValueError(f"Font resource {operands[0]} missing in current scope")
                font = ref.get_object()
                current = id(font)
                fonts[current] = font
            elif operator in (b"Tj", b"TJ") and current is not None:
                font = fonts[current]
                encoding = font.get("/Encoding")
                if font.get("/Subtype") == "/Type0" and encoding != "/Identity-H":
                    raise NotImplementedError(f"Unsupported encoding: {encoding}")
                width = 2 if encoding == "/Identity-H" else 1
                values = operands[0] if operator == b"TJ" else operands
                for value in values:
                    if not isinstance(value, (str, bytes)):
                        continue
                    raw = value.original_bytes if hasattr(value, "original_bytes") else bytes(value)
                    if len(raw) % width:
                        raise ValueError("Incomplete multibyte text code")
                    used[current].update(
                        int.from_bytes(raw[i:i + width], "big")
                        for i in range(0, len(raw), width)
                    )
            elif operator == b"Do":
                ref = (resources.get("/XObject") or {}).get(operands[0])
                obj = ref.get_object() if ref is not None else None
                if obj is None or obj.get("/Subtype") != "/Form":
                    continue
                key = id(obj)
                if key in active_forms:
                    raise ValueError("Cyclic Form XObject reference")
                form_resources = obj.get("/Resources")
                walk(page_resources if form_resources is None else form_resources,
                     page_resources, obj, active_forms | {key}, current)

    for page in pdf.pages:
        if page.get_contents() is not None:
            page_resources = page.get("/Resources") or {}
            walk(page_resources, page_resources, page.get_contents())
    return fonts, used
```

For each used font, record `/Subtype`, `/BaseFont`, `/Encoding`, `/ToUnicode`, and the descendant font's `/CIDToGIDMap`. Compare extracted text with the rendered page. A present `/ToUnicode` is suspect if it yields PUA, control codes, or unrelated text. A Form with no `/Resources` uses the page's resources; a Form with its own dictionary does not inherit individual missing font names. Report an unknown `Tf` resource instead of silently selecting a same-named font from another scope.

**Done when:** every used font object is classified, and every missing or suspect `/ToUnicode` is marked for repair.

## Step 1 - Load a reference pool and map GID -> Unicode

Match the embedded font's family (the `/BaseFont` with its subset prefix stripped) against reference font paths supplied for this job. A family name filters candidates but does not prove identity; confirm by outlines. For Thai, the SIPA national fonts are one possible reference source, not a bundled dependency.

```python
import collections
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.agl import toUnicode


def normalize(name):
    return "".join(char for char in str(name).casefold() if char.isalnum())


def load_pool(paths):
    """Family key -> reference font paths supplied by the caller."""
    pool = collections.defaultdict(list)
    for path in sorted(paths):
        font = TTFont(path)
        try:
            key = font["name"].getDebugName(6) or Path(path).stem
        finally:
            font.close()
        pool[normalize(key)].append(Path(path))
    return pool


def family(base_font):
    return str(base_font).split("+", 1)[-1]


# paths can come from Path(reference_dir).rglob("*.ttf")
# reference_paths = load_pool(paths).get(normalize(family(base_font)), [])
```

Resolve Unicode from glyph names such as `uni0E01` and `uni0E10.alt1` using `fontTools.agl.toUnicode`. For unrecognized names, use the reference font's non-PUA `cmap` inverse. Preserve multi-codepoint values as strings. A PUA `cmap` value is not automatically a canonical character.

```python
def cmap_inverse(reference):
    return {
        name: chr(code)
        for code, name in (reference.getBestCmap() or {}).items()
        if not 0xE000 <= code <= 0xF8FF
    }


def glyph_unicode(inverse, name):
    value = toUnicode(name)
    if value and not any(0xE000 <= ord(char) <= 0xF8FF for char in value):
        return value
    return inverse.get(name)
```

If the family key misses, match against the whole pool by outline (Step 2) instead of one file.

**Done when:** every damaged TrueType font has a verified reference candidate, or the missing reference is reported.

## Step 2 - Resolve each font's codes to Unicode

Load the embedded TrueType from each selected font object. A Type0 font keeps its descriptor on the descendant; a simple TrueType keeps it on the font itself. The returned `TTFont` is an in-memory analysis copy, so close it after use.

```python
from io import BytesIO


def embedded_font(font):
    subtype = font.get("/Subtype")
    if subtype == "/Type0":
        descendant = font["/DescendantFonts"][0].get_object()
    elif subtype == "/TrueType":
        descendant = font
    else:
        raise NotImplementedError(f"Unsupported font subtype: {subtype}")
    descriptor = descendant["/FontDescriptor"].get_object()
    font_file = descriptor.get("/FontFile2")
    if font_file is None:
        raise NotImplementedError("No embedded TrueType /FontFile2")
    return TTFont(BytesIO(font_file.get_object().get_data()))
```

### Keep the visual layer intact

Repair `/ToUnicode` only. Replacing an embedded subset can change visible glyphs even when most GID positions match a reference font.

```python
from struct import error as StructError
from fontTools.pens.recordingPen import RecordingPen
from fontTools.ttLib import TTLibError

FONT_ERRORS = (TTLibError, StructError, KeyError, IndexError, ValueError, AssertionError, AttributeError)


def outline(glyph_set, name):
    if glyph_set is None:
        return None
    try:
        pen = RecordingPen()
        glyph_set[name].draw(pen)
        return tuple(pen.value)
    except FONT_ERRORS:
        return None
```

### Match re-indexed subsets

Identify each embedded glyph by its outline, then fall back to numeric structure when exact drawing operations differ. The structural key includes the **actual point count**: Thai marks such as `uni0E35` and `uni0E37` share a bbox but have different point counts. Accept a match only when all matching reference glyphs resolve to one Unicode string.

```python
def structure(font, gid):
    try:
        glyph = font["glyf"][font.getGlyphOrder()[gid]]
        if not hasattr(glyph, "xMin"):
            return None  # Empty glyph, such as a space.
        points, _, _ = glyph.getCoordinates(font["glyf"])
        return (
            glyph.numberOfContours, len(points),
            glyph.xMin, glyph.yMin, glyph.xMax, glyph.yMax,
        )
    except FONT_ERRORS:
        return None


def resolve(embedded, reference, inverse, gids):
    """Map used GIDs to Unicode strings; leave ambiguous GIDs unresolved."""
    try:
        embedded_order = embedded.getGlyphOrder()
    except FONT_ERRORS:
        return {}
    try:
        eg = embedded.getGlyphSet()
    except FONT_ERRORS:
        eg = None
    rg = reference.getGlyphSet()
    reference_order = reference.getGlyphOrder()
    by_outline, by_structure = collections.defaultdict(set), collections.defaultdict(set)
    for gid, name in enumerate(reference_order):
        value = glyph_unicode(inverse, name)
        if not value:
            continue
        contours = outline(rg, name)
        if contours:
            by_outline[contours].add(value)
        key = structure(reference, gid)
        if key is not None:
            by_structure[key].add(value)

    nonempty = [gid for gid in gids if gid < len(embedded_order) and outline(eg, embedded_order[gid])]
    aligned = len(nonempty) >= 10 and all(
        gid < len(reference_order)
        and outline(eg, embedded_order[gid]) == outline(rg, reference_order[gid])
        for gid in nonempty
    )
    mapping = {}
    for gid in gids:
        if gid >= len(embedded_order):
            continue
        name = embedded_order[gid]
        contours = outline(eg, name)
        candidates = by_outline.get(contours, set()) if contours else set()
        if len(candidates) != 1:
            candidates = by_structure.get(structure(embedded, gid), set())
        if len(candidates) == 1:
            mapping[gid] = next(iter(candidates))
        elif aligned and gid < len(reference_order):
            value = glyph_unicode(inverse, reference_order[gid])
            if value:
                mapping[gid] = value
    return mapping
```

For Type0 `/Identity-H`, the content code is a CID. `/CIDToGIDMap /Identity` means CID equals GID; a stream map stores two-byte big-endian GIDs indexed by CID. For simple TrueType, resolve the one-byte code through `/Encoding` (including `/Differences`) and the embedded font's `cmap` or glyph names. Some subsets have no usable `cmap`; establish an explicit code-to-GID map from the font and rendered glyphs, then verify it. Never assume a simple code equals its GID.

```python
def cid_to_gid(font, cid):
    descendant = font["/DescendantFonts"][0].get_object()
    cid_map = descendant.get("/CIDToGIDMap")
    if cid_map is None or cid_map == "/Identity":
        return cid
    data = cid_map.get_object().get_data()
    offset = cid * 2
    if offset + 2 > len(data):
        raise ValueError(f"CID {cid} is outside /CIDToGIDMap")
    return int.from_bytes(data[offset:offset + 2], "big")


def simple_to_gid(font, embedded, code):
    candidates = set()
    encoding = font.get("/Encoding")
    if hasattr(encoding, "get_object"):
        encoding = encoding.get_object()
    if isinstance(encoding, dict):
        current = None
        for item in encoding.get("/Differences", []):
            if isinstance(item, int):
                current = item
            elif current is not None:
                if current == code:
                    name = str(item).lstrip("/")
                    if name in embedded.getGlyphOrder():
                        candidates.add(embedded.getGlyphID(name))
                current += 1
    if "cmap" in embedded:
        for table in embedded["cmap"].tables:
            for value in (code, code + 0xF000):
                name = table.cmap.get(value)
                if name is not None:
                    candidates.add(embedded.getGlyphID(name))
    if len(candidates) > 1:
        raise ValueError(f"Conflicting glyphs for simple code {code}")
    return next(iter(candidates)) if candidates else None


def map_used_codes(font, embedded, reference, codes):
    """Return content-code -> Unicode and the codes still unresolved."""
    if font.get("/Subtype") == "/Type0":
        if font.get("/Encoding") != "/Identity-H":
            raise NotImplementedError("Unsupported Type0 encoding")
        gid_by_code = {cid: cid_to_gid(font, cid) for cid in codes}
    else:
        gid_by_code = {
            code: gid for code in codes
            if (gid := simple_to_gid(font, embedded, code)) is not None
        }
    unicode_by_gid = resolve(embedded, reference, cmap_inverse(reference), set(gid_by_code.values()))
    mapping = {
        code: unicode_by_gid[gid]
        for code, gid in gid_by_code.items()
        if gid in unicode_by_gid
    }
    return mapping, set(codes) - mapping.keys()
```

`map_used_codes()` closes the mapped-CID seam: `CID -> GID -> Unicode`, then re-keys the result by the original CID for `/ToUnicode`. For a simple font it uses the one-byte character code as the key. `simple_to_gid()` returns `None` when encoding data is insufficient; establish an explicit mapping for those used codes from font data and rendered glyphs, not from the code number alone. When every nonempty used GID is proven positionally identical to the reference, `resolve()` may use the reference glyph name to break outline collisions or identify an empty space glyph. Otherwise, handle empty glyphs from encoding or established font semantics. Report every code in the returned unresolved set. A matching outline never justifies replacing the embedded font.

### Malformed subsets

Some subsets have padded `head` or `loca` tables, or cause fontTools to raise `not enough 'glyf' table data`. The outline and structure helpers return no match for a glyph they cannot read, so `map_used_codes()` reports its content code as unresolved. To recover it, use a trusted font parser or inspect the raw `head`, `loca`, `glyf`, and `maxp` tables with validated offsets and lengths. A bbox-only fallback has no point count and can collide for Thai marks such as `uni0E35` and `uni0E37`; leave those codes unresolved unless another independent feature distinguishes them. Keep the visual font data untouched.

**Done when:** every code used by the content stream resolves to a Unicode value or appears in an explicit uncovered list.

## Step 3 - Build and inject `/ToUnicode`

The map key is the content code: the CID for Type0 fonts, the character code for simple fonts. Do not write a GID-keyed CMap for a mapped-CID font. Encode each Unicode string as UTF-16BE, including surrogate pairs and multi-codepoint mappings. Emit `beginbfchar` chunks of at most 100 entries.

```python
from pypdf.generic import DecodedStreamObject, NameObject


def to_unicode_cmap(mapping, code_bytes):
    if code_bytes not in (1, 2):
        raise ValueError("Unsupported code width")
    limit = 1 << (8 * code_bytes)
    lines = [
        "/CIDInit /ProcSet findresource begin",
        "12 dict begin",
        "begincmap",
        "/CMapType 2 def",
        "/CMapName /RecoveredUnicode def",
        "1 begincodespacerange",
        f"<{'00' * code_bytes}><{'ff' * code_bytes}>",
        "endcodespacerange",
    ]
    items = sorted(mapping.items())
    for start in range(0, len(items), 100):
        chunk = items[start:start + 100]
        lines.append(f"{len(chunk)} beginbfchar")
        for code, value in chunk:
            if not 0 <= code < limit or not value:
                raise ValueError(f"Invalid mapping for code {code}")
            lines.append(f"<{code:0{2 * code_bytes}x}><{value.encode('utf-16-be').hex()}>")
        lines.append("endbfchar")
    lines += ["endcmap", "CMapName currentdict /CMap defineresource pop", "end", "end"]
    return ("\n".join(lines) + "\n").encode("ascii")


def inject_to_unicode(writer, font, mapping, code_bytes):
    stream = DecodedStreamObject()
    stream.set_data(to_unicode_cmap(mapping, code_bytes))
    font[NameObject("/ToUnicode")] = writer._add_object(stream)
```

Notes:
- Use `code_bytes=1` for simple fonts and `code_bytes=2` for `/Identity-H`.
- `writer._add_object` is a private pypdf API. Pin the pypdf version and retest on upgrade.
- If a simple font has no usable `cmap`, establish an explicit code-to-GID mapping for its used codes and record how it was verified.

This driver collects usage from the **writer's** object graph, the same graph it patches. Supply `reference_for_font(font)`, a function that returns a reference TTF path for each damaged font and `None` for a healthy font such as Helvetica. Count the damaged font objects during Step 0 and pass that count as `expected_targets`; a skipped target then stops the run. Font object `id()` values from the reader cannot be reused in the writer.

```python
from pathlib import Path
from pypdf import PdfReader, PdfWriter


def repair_pdf(source, output, reference_for_font, expected_targets):
    if Path(source).resolve() == Path(output).resolve():
        raise ValueError("Output must be separate from the source PDF")
    writer = PdfWriter()
    writer.clone_document_from_reader(PdfReader(source))
    fonts, used = collect_usage(writer)
    targets = {
        key: path for key, font in fonts.items()
        if (path := reference_for_font(font)) is not None
    }
    if len(targets) != expected_targets:
        raise ValueError(f"Selected {len(targets)} of {expected_targets} expected fonts")
    repaired = set()
    for key, reference_path in targets.items():
        font = fonts[key]
        embedded = embedded_font(font)
        try:
            reference = TTFont(reference_path)
            try:
                mapping, unresolved = map_used_codes(font, embedded, reference, used[key])
            finally:
                reference.close()
        finally:
            embedded.close()
        if unresolved:
            raise ValueError(f"Unresolved codes in {font['/BaseFont']}: {sorted(unresolved)}")
        if mapping.keys() != used[key]:
            raise ValueError(f"Coverage mismatch in {font['/BaseFont']}")
        code_bytes = 2 if font.get("/Encoding") == "/Identity-H" else 1
        inject_to_unicode(writer, font, mapping, code_bytes)
        repaired.add(key)
    if repaired != targets.keys():
        raise AssertionError("A selected font was not patched")
    with Path(output).open("wb") as file:
        writer.write(file)
```

When `map_used_codes()` reports an unresolved code, resolve it from validated font evidence before writing. Do not silently emit a partial map. For malformed subsets, repair the in-memory analysis copy or use a trusted alternate parser; leave the embedded font bytes in the PDF unchanged.

**Done when:** each repaired font has a `/ToUnicode` whose key set covers every code recorded in Step 2.

## Step 4 - Verify

Do not trust the patch until all three checks pass.

1. **Text**: re-extract all pages, inspect passages from every repaired font, and confirm coherent script with no unexplained controls, PUA, or `U+FFFD`. A wrong map can produce plausible Latin text, so compare at least one visible phrase per font with the extracted phrase; codepoint statistics alone cannot prove correctness. Poppler may insert `U+000C` between pages; `-nopgbrk` suppresses it.
   ```bash
   pdftotext -nopgbrk output.pdf -
   ```
2. **Visual**: render every page before and after at the same DPI and compare corresponding images pixel by pixel. Expect zero changed pixels.
   ```bash
   pdftoppm -r 150 -png input.pdf input-page
   pdftoppm -r 150 -png output.pdf output-page
   ```
   ```python
   from pathlib import Path
   from PIL import Image, ImageChops

   before = sorted(Path(".").glob("input-page-*.png"))
   after = sorted(Path(".").glob("output-page-*.png"))
   if not before or len(before) != len(after):
       raise ValueError("Rendered page counts differ")
   for original, repaired in zip(before, after):
       with Image.open(original) as left, Image.open(repaired) as right:
           if left.size != right.size or ImageChops.difference(
               left.convert("RGB"), right.convert("RGB")
           ).getbbox() is not None:
               raise ValueError(f"Rendered page differs: {original.name}")
   ```
   Any pixel difference needs investigation before accepting the output. `input.pdf`, `output.pdf`, and the image prefixes are placeholders; use a clean directory for each comparison.
3. **Coverage**: `repair_pdf()` checks each selected writer font's used-code set against its mapping keys **before writing**. Object `id()` values change after re-reading a PDF, so never compare IDs from different reader/writer instances. After writing, inspect extraction and rendering as above; if checking the serialized CMap, collect fonts and parse CMap keys within the same newly opened PDF.

**Done when:** text extracts cleanly, every page has zero changed pixels, and every used code in a repaired font has a justified Unicode mapping.

## Step 5 - Optional Thai normalization for search

Typeset Thai often decomposes sara am into nikhahit plus sara aa (`U+0E4D` + `U+0E32`) instead of the precomposed `U+0E33`. Unicode NFC does **not** compose it, because Thai sara am has no canonical decomposition. When the goal is search and copy ergonomics, offer an opt-in normalization `U+0E4D U+0E32 -> U+0E33` and leave the original bytes untouched otherwise.

## Thai legacy PUA reference

Legacy WinThai/Windows-874 typesetting shifted tone marks and cut consonants into `U+F700`-`U+F71D` plus ligatures at `U+F880`-`U+F882`. Derive these from glyph names (`uniXXXX.altN`, `uniXXXX.liga`); the table below is a sanity check only.

| PUA | Unicode | PUA | Unicode |
| :-- | :-- | :-- | :-- |
| `F700` | `0E10` | `F710` | `0E31` |
| `F701`-`F704` | `0E34`-`0E37` | `F711` | `0E4D` |
| `F705`-`F709` | `0E48`-`0E4C` | `F712` | `0E47` |
| `F70A`-`F70E` | `0E48`-`0E4C` | `F713`-`F717` | `0E48`-`0E4C` |
| `F70F` | `0E0D` | `F718`-`F71A` | `0E38`-`0E3A` |
| `F71B` | `0E0E` | `F881` | `0E24` |
| `F71C` | `0E0F` | `F882` | `0E26` |
| `F71D` | `0E2C` | `F880` | `0E4F` |

The `alt` variants differ only in mark positioning and map to the same canonical character.

## Pitfalls

- Patching only page-level `/Font` while the text lives in form `/XObject`s.
- Repairing the first broken font and stopping: one line can span several fonts, each with its own `/ToUnicode`.
- Writing a GID-keyed CMap for a mapped-CID font.
- Assuming exact outline matching will always succeed, or accepting a structural match without a unique Unicode value.
- Adding `/ToUnicode` but never verifying extraction, rendering, or coverage.

## Dependencies and assets

- `pip install pypdf fontTools Pillow`; Poppler's `pdftotext` and `pdftoppm` for verification. Pin the tested pypdf version because CMap injection uses a private API.
- Supply reference fonts for each job. The skill includes no font binaries, sample PDFs, or machine-specific paths.
