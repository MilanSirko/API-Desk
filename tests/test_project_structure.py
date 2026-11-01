import json
import unittest
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urljoin, urlsplit


ROOT = Path(__file__).resolve().parents[1]
WEBSITE = ROOT / "website"


class LocalReferenceParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.references = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        for name in ("href", "src", "poster"):
            value = attrs.get(name)
            if value:
                self.references.append(value.strip())


class ProjectStructureTests(unittest.TestCase):
    def test_expected_project_directories_and_entrypoints_exist(self):
        expected = [
            ROOT / "backend.py",
            ROOT / "backend.js",
            ROOT / "database" / "schema.sql",
            ROOT / ".env.example",
            ROOT / "vercel.json",
            WEBSITE / "index.html",
            WEBSITE / "api-tester.html",
            WEBSITE / "app.js",
            ROOT / "assets" / "images",
            ROOT / "assets" / "brand",
            ROOT / "assets" / "favicon",
            ROOT / "assets" / "vendor",
        ]
        for path in expected:
            with self.subTest(path=path.relative_to(ROOT)):
                self.assertTrue(path.exists(), f"Missing project path: {path}")

    def test_vercel_rewrites_public_pages_into_website(self):
        config = json.loads((ROOT / "vercel.json").read_text(encoding="utf-8"))
        rewrites = config.get("rewrites", [])
        self.assertIn(
            {"source": "/", "destination": "/website/index.html"},
            rewrites,
        )
        self.assertIn(
            {"source": "/(.*)", "destination": "/website/$1"},
            rewrites,
        )

    def test_local_html_references_resolve(self):
        for html_file in WEBSITE.rglob("*.html"):
            relative_page = html_file.relative_to(WEBSITE).as_posix()
            parser = LocalReferenceParser()
            parser.feed(html_file.read_text(encoding="utf-8"))

            page_url = "/" + relative_page
            for reference in parser.references:
                parsed = urlsplit(reference)
                if parsed.scheme or parsed.netloc or not parsed.path:
                    continue

                public_path = unquote(urlsplit(urljoin(page_url, reference)).path)
                if public_path.startswith("/assets/"):
                    target = ROOT / public_path.lstrip("/")
                elif public_path == "/backend.js":
                    target = ROOT / "backend.js"
                elif public_path == "/runtime-config.js":
                    target = WEBSITE / "runtime-config.js"
                else:
                    target = WEBSITE / public_path.lstrip("/")

                with self.subTest(page=relative_page, reference=reference):
                    self.assertTrue(target.is_file(), f"Missing local target: {public_path}")


if __name__ == "__main__":
    unittest.main()
