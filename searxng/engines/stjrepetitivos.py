# SPDX-License-Identifier: AGPL-3.0-or-later
"""STJ - Precedentes Qualificados (temas repetitivos), busca em texto livre.

A base oficial de repetitivos do STJ aceita busca textual pelo parametro
``pesquisa_livre`` e responde 200 com HTML util, sem desafio anti-bot. E' o
caminho do tribunal que **nao gasta a cota do ``google cse``**, que e' um CX
publico compartilhado e suspende depois de poucas consultas.

Tres pegadinhas medidas em 2026-09-08, todas silenciosas:

1. **A consulta precisa ir percent-encoded em latin-1.** A pagina e' ISO-8859-1 e
   o servidor decodifica o parametro assim. Em UTF-8, ``prescrição`` vira 0
   resultados com **HTTP 200** - filtro aplicado e vazio e' indistinguivel de
   filtro ignorado. Por isso a URL e' montada com ``quote(..., encoding=latin-1)``
   e nunca por ``urlencode`` padrao.
2. **Nome de parametro errado nao da erro, devolve a colecao inteira.**
   ``texto=``, ``livre=`` e ``palavra=`` sao ignorados e a pagina responde com os
   1.473 temas do acervo. So' ``pesquisa_livre`` filtra de verdade.
3. **A pagina declara o total** ("N documentos encontrados"), e' o unico jeito
   de distinguir "nada casou" de "o filtro nao pegou".

O link por tema (``cod_tema_inicial``/``cod_tema_final``) e' deep link de
verdade e serve para citacao.
"""

import re
from urllib.parse import quote

from searx.network import get

about = {
    "website": "https://processo.stj.jus.br/repetitivos/temas_repetitivos/",
    "official_api_documentation": None,
    "use_official_api": False,
    "require_api_key": False,
    "results": "HTML",
}

categories = ["general"]
paging = True

base_url = "https://processo.stj.jus.br/repetitivos/temas_repetitivos/pesquisa.jsp"

_PAGE_SIZE = 20

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
)

# "e" / "ou" nao sao conectores nesta base; passam como termo e derrubam o
# resultado. Mesma observacao vale para o BNP, e esta no manual dele.
_STOPWORDS = {"e", "ou", "de", "da", "do", "das", "dos", "a", "o", "as", "os", "em", "no", "na"}

_BLOCK_RE = re.compile(r'<div class="container containerDocumento">(.*?)(?=<div class="container containerDocumento">|<div class="rodape|\Z)', re.S)
_TEMA_RE = re.compile(r'Tema Repetitivo\s*<span class="dados_campo_processo fonte_destaque\s*">\s*(\d+)\s*</span>', re.S)
_TOTAL_RE = re.compile(r'(\d+)\s+documentos?\s+encontrados?', re.I)


def _field(block, label):
    """Texto do campo rotulado `label` dentro de um bloco de resultado."""
    m = re.search(
        r'>\s*' + re.escape(label) + r'\s*</div>\s*<div[^>]*class="[^"]*dados_campo[^"]*"[^>]*>(.*?)</div>',
        block,
        re.S,
    )
    return _plain(m.group(1)) if m else ""


def _plain(html):
    text = re.sub(r"(?is)<script.*?</script>", " ", html or "")
    text = re.sub(r"<[^>]+>", " ", text)
    text = (
        text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
    )
    return " ".join(text.split())


def _encode(livre):
    # latin-1: ver pegadinha 1 no docstring. Caracter fora do charset vira "?"
    # em vez de estourar, o que degrada a busca mas nao quebra a engine.
    return quote(livre, safe="", encoding="latin-1", errors="replace")


def _url(encoded, start=1, size=_PAGE_SIZE):
    return (
        f"{base_url}?novaConsulta=true&tipo_pesquisa=T"
        f"&quantidadeResultadosPorPagina={size}"
        f"&i={start}"
        f"&pesquisa_livre={encoded}"
    )


def _hits(encoded):
    """Le so' o "N documentos encontrados" - None quando a pagina nao e' de resultados.

    Pede **1 resultado por pagina**: a pagina cheia tem ~250 KB e tres sondagens
    dessas estouravam o timeout da engine.
    """
    try:
        resp = get(_url(encoded, size=1), headers={"User-Agent": _UA}, timeout=8.0)
    except Exception:  # pylint: disable=broad-except
        return None

    if resp.status_code != 200:
        return None

    found = _TOTAL_RE.search(resp.content.decode("latin-1", errors="replace"))
    return int(found.group(1)) if found else None


def _candidates(terms):
    """Consulta cheia, depois formas mais curtas.

    A busca e' AND entre os termos: "prescricao intercorrente execucao fiscal"
    devolve **0** enquanto "prescricao intercorrente" devolve 22 e "execucao
    fiscal" devolve 148. Sem esta degradacao, a pergunta mais especifica e' a
    que volta vazia - e vazia com HTTP 200, que nao parece erro.
    """
    forms = [" ".join(terms)] if terms else []

    if len(terms) > 2:
        forms.append(" ".join(terms[:2]))

    if terms:
        forms.append(max(terms, key=len))

    seen, out = set(), []
    for form in forms:
        if form and form.lower() not in seen:
            seen.add(form.lower())
            out.append(form)
    return out


def request(query, params):
    terms = [w for w in query.split() if w.lower() not in _STOPWORDS] or query.split()

    encoded = _encode(" ".join(terms) or query)

    # Consulta curta ja' costuma casar; so' vale sondar quando ha' o que encurtar.
    if len(terms) > 2:
        for form in _candidates(terms):
            candidate = _encode(form)
            if (_hits(candidate) or 0) > 0:
                encoded = candidate
                break

    pageno = params.get("pageno", 1)

    params["url"] = _url(encoded, (pageno - 1) * _PAGE_SIZE + 1)
    params["headers"]["User-Agent"] = _UA
    return params


def response(resp):
    results = []

    if resp.status_code != 200:
        return results

    html = resp.content.decode("latin-1", errors="replace")

    total = _TOTAL_RE.search(html)

    # Sem o marcador de total a pagina nao e' uma pagina de resultados (erro,
    # sessao expirada, formulario). Devolver [] e' melhor do que garimpar.
    if not total:
        return results

    for block in _BLOCK_RE.findall(html):
        tema = _TEMA_RE.search(block)
        if not tema:
            continue

        numero = tema.group(1)
        questao = _field(block, "Questão submetida a julgamento")
        tese = _field(block, "Tese Firmada")
        situacao = _field(block, "Situação")
        orgao = _field(block, "Órgão julgador")
        ramo = _field(block, "Ramo do direito")

        header = f"STJ · Tema Repetitivo {numero}"
        if situacao:
            header += f" · {situacao}"

        body = " ".join(
            part for part in (
                f"Questão: {questao}" if questao else "",
                f"Tese firmada: {tese}" if tese else "",
                f"Órgão julgador: {orgao}." if orgao else "",
                f"Ramo: {ramo}." if ramo else "",
            ) if part
        )

        results.append(
            {
                "url": (
                    f"{base_url}?novaConsulta=true&tipo_pesquisa=T"
                    f"&cod_tema_inicial={numero}&cod_tema_final={numero}"
                ),
                "title": header,
                "content": body[:900],
            }
        )

    return results
