# SPDX-License-Identifier: AGPL-3.0-or-later
"""Dizer o Direito - comentários de jurisprudência (STF/STJ) em pt-BR.

O site roda no Blogger, que expõe a **API de feeds oficial**:
``/feeds/posts/default?alt=json&q=<termo>`` faz busca em texto completo e devolve
JSON com título, link, data de publicação e o conteúdo inteiro do post.

Isso importa por um motivo de etica, nao so' de conveniencia: o ``robots.txt``
do site **proibe ``/search``** (a busca on-site do Blogger) e libera o resto
(``Allow: /``). O caminho ``/feeds/`` nao esta proibido — entao a busca vai pelo
feed, nao pela pagina de busca. Nao trocar por ``/search?q=``.

Medido em 2026-09-08: ``q=prescrição intercorrente`` devolveu 200 com
``openSearch$totalResults`` e entradas datadas, incluindo os "INFORMATIVO
Comentado", que sao o principal desta fonte para jurisprudencia.

Manter ``disabled: true`` no settings.yml; o modo Juridico do Vane ativa a engine
nomeando-a em ``engines=``.
"""

from json import loads
from urllib.parse import urlencode

about = {
    "website": "https://www.dizerodireito.com.br",
    "official_api_documentation": "https://developers.google.com/blogger/docs/2.0/developers_guide_protocol",
    "use_official_api": True,
    "require_api_key": False,
    "results": "JSON",
}

categories = ["general", "news"]
paging = True

base_url = "https://www.dizerodireito.com.br"

_PAGE_SIZE = 20

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
)


def request(query, params):
    pageno = params.get("pageno", 1)

    params["url"] = f"{base_url}/feeds/posts/default?" + urlencode(
        {
            "alt": "json",
            "q": query,
            "max-results": _PAGE_SIZE,
            "start-index": (pageno - 1) * _PAGE_SIZE + 1,
        }
    )
    params["headers"]["User-Agent"] = _UA
    return params


def _text(node):
    return (node or {}).get("$t", "") or ""


def _plain(html):
    out = []
    depth = 0

    for char in html or "":
        if char == "<":
            depth += 1
        elif char == ">":
            depth = max(depth - 1, 0)
        elif depth == 0:
            out.append(char)

    return " ".join("".join(out).replace("&nbsp;", " ").split())


def response(resp):
    results = []

    if resp.status_code != 200:
        return results

    try:
        feed = loads(resp.text).get("feed") or {}
    except ValueError:
        return results

    for entry in feed.get("entry") or []:
        url = next(
            (
                link.get("href")
                for link in entry.get("link") or []
                if link.get("rel") == "alternate" and link.get("href")
            ),
            None,
        )

        title = _text(entry.get("title"))

        if not url or not title:
            continue

        body = _plain(_text(entry.get("content")) or _text(entry.get("summary")))

        result = {
            "url": url,
            "title": title,
            "content": body[:400],
        }

        published = _text(entry.get("published"))
        if published:
            try:
                from datetime import datetime

                result["publishedDate"] = datetime.fromisoformat(published)
            except (TypeError, ValueError):
                pass

        results.append(result)

    return results
