"""Helpers for build-pdf.js.

  python find_pages.py pages <pdf>          -> JSON {heading_id: page_number} from @@id@@ markers
  python find_pages.py meta <pdf> <json>    -> set document metadata from a JSON object
"""
import json
import re
import sys

from pypdf import PdfReader, PdfWriter


def pages(path):
    reader = PdfReader(path)
    found = {}
    for number, page in enumerate(reader.pages, start=1):
        text = page.extract_text() or ""
        for marker in re.findall(r"@@([A-Za-z0-9-]+)@@", text):
            found.setdefault(marker, number)
    print(json.dumps({"pages": found, "count": len(reader.pages)}))


def meta(path, meta_json):
    info = json.loads(meta_json)
    reader = PdfReader(path)
    writer = PdfWriter(clone_from=reader)
    writer.add_metadata({"/" + k: v for k, v in info.items()})
    writer.page_mode = "/UseOutlines"
    with open(path, "wb") as fh:
        writer.write(fh)
    print("ok")


if __name__ == "__main__":
    if sys.argv[1] == "pages":
        pages(sys.argv[2])
    elif sys.argv[1] == "meta":
        meta(sys.argv[2], sys.argv[3])
    else:
        raise SystemExit(__doc__)
