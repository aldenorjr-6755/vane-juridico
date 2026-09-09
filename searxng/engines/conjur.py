# SPDX-License-Identifier: AGPL-3.0-or-later
"""Consultor Jurídico (Conjur) - pt-BR legal doctrine and news.

Conjur runs WordPress with an open REST API, but its full-text search endpoint
(``/wp-json/wp/v2/posts?search=``) answers a hard **500** for every term, and the
site's own ``/?s=`` search page is behind Cloudflare (403). What does work is the
taxonomy: ``/wp-json/wp/v2/tags?search=<term>`` returns matching tags with a post
count, and ``posts?tags=<id>`` lists the articles carrying that tag.

So this engine resolves the query to a tag and lists that tag's posts. Coverage
is narrower than full text - it complements the ``google cse`` ``site:`` path
rather than replacing it - but it costs nothing from that engine's shared quota
and returns clean titles, dates and excerpts.

Keep ``disabled: true`` in settings.yml; Vane's legal search names it explicitly
in the request's ``engines=`` parameter.
"""

from json import loads
from urllib.parse import urlencode

from searx.network import get

about = {
    "website": "https://www.conjur.com.br",
    "official_api_documentation": "https://developer.wordpress.org/rest-api/",
    "use_official_api": True,
    "require_api_key": False,
    "results": "JSON",
}

categories = ["general", "news"]
paging = True

base_url = "https://www.conjur.com.br/wp-json/wp/v2"

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
)

# Sentinel used when the query matches no tag: WordPress answers an empty list
# for a tag id that does not exist, which is exactly the "no results" we want.
_NO_TAG = "0"


def _lookup(term):
    """One tags?search= call. Returns the best tag id, or None."""
    url = f"{base_url}/tags?" + urlencode(
        {"search": term, "per_page": 10, "_fields": "id,name,count"}
    )

    try:
        resp = get(url, headers={"User-Agent": _UA}, timeout=10.0)
    except Exception:  # pylint: disable=broad-except
        return None

    if resp.status_code != 200:
        return None

    try:
        tags = loads(resp.text)
    except ValueError:
        return None

    if not isinstance(tags, list) or not tags:
        return None

    needle = term.strip().lower()

    exact = [t for t in tags if (t.get("name") or "").strip().lower() == needle]
    if exact:
        return str(exact[0]["id"])

    best = max(tags, key=lambda t: t.get("count") or 0)
    return str(best.get("id")) if best.get("id") else None


def _candidates(query):
    """Query, then shorter forms of it.

    `tags?search=` matches against tag names, so a full sentence matches
    nothing: "prescrição intercorrente execução fiscal" found no tag and the
    engine returned zero results with no error, while "prescrição
    intercorrente" matched and returned 20. Falling back to the leading pair of
    words and then to the longest single word keeps a specific question from
    silently coming back empty.
    """
    words = [w for w in query.split() if len(w) > 2]

    forms = [query.strip()]

    if len(words) > 2:
        forms.append(" ".join(words[:2]))

    if words:
        forms.append(max(words, key=len))

    seen = set()
    out = []

    for form in forms:
        key = form.lower()
        if form and key not in seen:
            seen.add(key)
            out.append(form)

    return out


def _resolve_tag(query):
    """Maps the query to the id of the most-used matching tag."""
    for term in _candidates(query):
        tag_id = _lookup(term)
        if tag_id:
            return tag_id

    return _NO_TAG


def request(query, params):
    tag_id = _resolve_tag(query)

    params["url"] = f"{base_url}/posts?" + urlencode(
        {
            "tags": tag_id,
            "per_page": 20,
            "page": params.get("pageno", 1),
            "orderby": "date",
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
            "title": title,
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
