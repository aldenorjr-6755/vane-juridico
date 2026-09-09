# SPDX-License-Identifier: AGPL-3.0-or-later
"""Migalhas (pt-BR legal news and doctrine).

Queries the site's own search at ``/busca``. That page is client-rendered - the
plain HTML carries zero result anchors - but the server embeds the whole result
set as JSON inside a ``<script>`` tag, using ``&q;`` for the quote character and
``&l;``/``&g;`` for angle brackets. The payload lives under a key that starts
with ``/Search/Query`` and holds ``Data.results[]`` with ``URL``, ``title``,
``summary``, ``date`` and ``stringcategories`` ("Migalhas Quentes" for news,
"Migalhas de Peso" for doctrine), plus ``Data.qty`` as the total.

``robots.txt`` disallows /tour_juridico, /academias, /promocao, /fachadas,
/fenalaw and /conteudo - not /busca.

Keep this engine ``disabled: true`` in settings.yml: naming it in the request's
``engines=`` parameter activates it for that query alone, which is how Vane's
legal search uses it, without putting Migalhas results in every web search.
"""

import json
import re
from urllib.parse import urlencode

about = {
    "website": "https://www.migalhas.com.br",
    "official_api_documentation": None,
    "use_official_api": False,
    "require_api_key": False,
    "results": "JSON",
}

categories = ["general", "news"]
paging = True

base_url = "https://www.migalhas.com.br"

_SCRIPT_RE = re.compile(r"<script[^>]*>(.*?)</script>", re.S)


def request(query, params):
    params["url"] = f"{base_url}/busca?" + urlencode({"q": query, "page": params.get("pageno", 1)})
    params["headers"]["User-Agent"] = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
    )
    return params


def _unescape(text):
    return (
        text.replace("&l;", "<")
        .replace("&g;", ">")
        .replace("&q;", '"')
        .replace("&a;", "&")
    )


def _payload(html):
    """Returns the decoded prefetch blob that carries the search results."""
    for raw in _SCRIPT_RE.findall(html):
        if "&q;" not in raw or "Search/Query" not in raw:
            continue

        start = raw.find("{")
        if start < 0:
            continue

        text = raw[start:].replace("&q;", '"').replace("&a;", "&")

        try:
            return json.loads(text)
        except ValueError:
            continue

    return None


def response(resp):
    results = []

    payload = _payload(resp.text)
    if not payload:
        return results

    node = None
    for key, value in payload.items():
        if key.startswith("/Search/Query"):
            node = value
            break

    if not isinstance(node, dict):
        return results

    data = node.get("Data") or {}

    for item in data.get("results") or []:
        url = item.get("URL")
        title = item.get("title") or item.get("nom_titulo")

        if not url or not title:
            continue

        content = item.get("summary") or _unescape(item.get("highlight") or "")
        category = item.get("stringcategories")

        if category:
            content = f"[{category}] {content}".strip()

        result = {
            "url": url,
            "title": title,
            "content": content,
        }

        published = item.get("date")
        if published:
            try:
                from datetime import datetime

                result["publishedDate"] = datetime.fromisoformat(published)
            except (TypeError, ValueError):
                pass

        results.append(result)

    return results
