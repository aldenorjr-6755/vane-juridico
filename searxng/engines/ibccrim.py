# SPDX-License-Identifier: AGPL-3.0-or-later
"""IBCCRIM - Instituto Brasileiro de Ciencias Criminais.

Doutrina e noticia de direito penal e processo penal. Roda WordPress 7.0.2 com
a REST API aberta, e - ao contrario do Conjur - o endpoint de busca em texto
completo **funciona**: ``/wp-json/wp/v2/posts?search=<termo>`` responde 200 com
os posts. Por isso esta engine e' a mais simples das seis: uma chamada, sem
resolucao de tag, sem pre-voo.

``robots.txt`` libera tudo (``User-agent: * / Disallow:``).

Atencao ao dominio: o site e' **ibccrim.org.br**. O ``.com.br`` nao resolve.

Manter ``disabled: true`` no settings.yml - o modo Juridico do Vane ativa a
engine nomeando-a em ``engines=``, sem poluir a busca web comum.
"""

from json import loads
from urllib.parse import urlencode

about = {
    "website": "https://www.ibccrim.org.br",
    "official_api_documentation": "https://developer.wordpress.org/rest-api/",
    "use_official_api": True,
    "require_api_key": False,
    "results": "JSON",
}

categories = ["general", "news"]
paging = True

base_url = "https://www.ibccrim.org.br/wp-json/wp/v2"

_PAGE_SIZE = 20

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
)


def request(query, params):
    params["url"] = f"{base_url}/posts?" + urlencode(
        {
            "search": query,
            "per_page": _PAGE_SIZE,
            "page": params.get("pageno", 1),
            "_fields": "link,date,title,excerpt",
        }
    )
    params["headers"]["User-Agent"] = _UA
    return params


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

    return (
        "".join(out)
        .replace("&nbsp;", " ")
        .replace("&#8230;", "...")
        .replace("&#8217;", "'")
        .replace("&amp;", "&")
        .strip()
    )


def response(resp):
    results = []

    # Pagina alem do fim devolve 400 com `rest_post_invalid_page_number`;
    # zero resultados e' a resposta correta, nao um erro a propagar.
    if resp.status_code != 200:
        return results

    try:
        posts = loads(resp.text)
    except ValueError:
        return results

    if not isinstance(posts, list):
        return results

    for post in posts:
        url = post.get("link")
        title = _plain((post.get("title") or {}).get("rendered"))

        if not url or not title:
            continue

        result = {
            "url": url,
            "title": f"{title} — IBCCRIM",
            "content": _plain((post.get("excerpt") or {}).get("rendered"))[:400],
        }

        published = post.get("date")
        if published:
            try:
                from datetime import datetime

                result["publishedDate"] = datetime.fromisoformat(published)
            except (TypeError, ValueError):
                pass

        results.append(result)

    return results
