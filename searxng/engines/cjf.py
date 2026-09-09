# SPDX-License-Identifier: AGPL-3.0-or-later
"""CJF - Jurisprudência Unificada da Justiça Federal.

Portal oficial do Conselho da Justiça Federal que reúne a jurisprudência do
STJ, das Turmas Recursais, da TNU e dos TRFs. Diferente das outras fontes
juridicas ligadas aqui, este e' um app **JSF/PrimeFaces com estado**: a busca e'
um POST parcial que exige o ``javax.faces.ViewState`` da pagina e o cookie de
sessao. Por isso a engine faz dois passos - GET no formulario para colher o
ViewState e o cookie, POST com a consulta.

Boas praticas tiradas da propria pagina de ajuda (``/ajuda.xhtml``):

* **Nao usar preposicoes, conjuncoes nem artigos** na expressao de busca, e
  **nao usar pontuacao**. A engine remove os dois antes de consultar.
* **O operador de conjuncao e' ``E``** ("Para pesquisar no STJ utilize o
  operador E. Exemplo: lei E 8112"). Os termos sao unidos por ``E``, e nao por
  espaco, que na busca livre significa outra coisa.
* A busca ignora maiusculas e acentos, entao nao ha o que normalizar ali.
* A ajuda documenta busca por campo (``termo[EMEN]``, ``termo[TRIB]``,
  ``termo[DTDE]``, ``termo[REFL]``...). Nao usada por padrao, mas e' o caminho
  para refinar depois - os nomes curtos estao na ajuda.

Duas fragilidades, anotadas de proposito:

1. **O nome do campo de tribunal e' gerado pelo JSF** (``formulario:j_idt51``
   hoje) e muda quando o CJF reconstroi a pagina. A engine **extrai o nome do
   formulario** em vez de fixa-lo - fixar seria repetir o erro das classes
   ``elementor-element-<hash>`` do Conjur.
2. **A busca so' devolve documentos com UM tribunal selecionado.** Com varios,
   a resposta traz apenas os totais por tribunal (medido: 444 KB de totais,
   nenhum documento). Por isso o padrao e' STJ, que e' o de maior valor para
   pesquisa juridica; ``tribunal`` troca isso.

Sem deep link por documento: o portal renderiza tudo no POST e a URL fica em
``/unificada/index.xhtml``. Quem identifica o julgado e' o titulo do resultado
(classe, numero e relator), como no BNP.
"""

import re
from html import unescape
from urllib.parse import urlencode

from searx.network import get

about = {
    "website": "https://jurisprudencia.cjf.jus.br/",
    "official_api_documentation": None,
    "use_official_api": False,
    "require_api_key": False,
    "results": "HTML",
}

categories = ["general"]
paging = False

base_url = "https://jurisprudencia.cjf.jus.br/unificada/index.xhtml"

tribunal = "STJ"

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
)

# A ajuda manda nao usar preposicoes, conjuncoes nem artigos.
_STOPWORDS = {
    "a", "o", "as", "os", "um", "uma", "de", "da", "do", "das", "dos", "em",
    "no", "na", "nos", "nas", "por", "para", "com", "sem", "sob", "sobre",
    "e", "ou", "que", "ao", "aos", "à", "às",
}

_VIEWSTATE_RE = re.compile(r'name="javax\.faces\.ViewState"[^>]*value="([^"]+)"')
_TRIBUNAL_FIELD_RE = re.compile(r'name="(formulario:j_idt\d+)"')
_DOC_SPLIT_RE = re.compile(r"formulario:tabelaDocumentos:(\d+):")
_FIELD_RE = {
    "tipo": re.compile(r"\bTipo\s+([^\s].{0,40}?)\s+Número\b"),
    "numero": re.compile(r"\bNúmero\s+([\d.\-/]+)"),
    "classe": re.compile(r"\bClasse\s+(.{3,120}?)\s+Relator"),
    "relator": re.compile(r"\bRelator\(a\)\s+(.{3,60}?)\s+Origem"),
    "origem": re.compile(r"\bOrigem\s+(.{3,70}?)\s+Órgão"),
    "orgao": re.compile(r"\bÓrgão julgador\s+(.{3,50}?)\s+Data"),
    "data": re.compile(r"\bData\s+(\d{2}/\d{2}/\d{4})"),
}


def _plain(html):
    text = re.sub(r"(?is)<script.*?</script>", " ", html or "")
    text = re.sub(r"<[^>]+>", " ", text)
    return " ".join(unescape(text).split())


def _expressao(query):
    """Termos sem pontuação e sem palavra vazia, unidos pelo operador E."""
    limpo = re.sub(r"[^\wÀ-ÿ\s]", " ", query)
    termos = [t for t in limpo.split() if t.lower() not in _STOPWORDS]
    return " E ".join(termos) if termos else query


def request(query, params):
    try:
        form = get(base_url, headers={"User-Agent": _UA}, timeout=15.0)
    except Exception:  # pylint: disable=broad-except
        params["url"] = base_url
        return params

    html = form.text

    viewstate = _VIEWSTATE_RE.search(html)
    campo_tribunal = _TRIBUNAL_FIELD_RE.search(html)

    # Sem ViewState nao ha busca possivel: aponta para o formulario, o parser
    # nao encontra o marcador de documento e a engine devolve zero - melhor do
    # que mandar um POST que o servidor rejeita.
    if not viewstate:
        params["url"] = base_url
        return params

    data = [
        ("javax.faces.partial.ajax", "true"),
        ("javax.faces.source", "formulario:actPesquisar"),
        ("javax.faces.partial.execute", "@all"),
        ("javax.faces.partial.render", "formulario:resultado"),
        ("formulario:actPesquisar", "formulario:actPesquisar"),
        ("formulario", "formulario"),
        ("formulario:textoLivre", _expressao(query)),
        ("javax.faces.ViewState", viewstate.group(1)),
    ]

    if campo_tribunal:
        data.insert(-1, (campo_tribunal.group(1), tribunal))

    params["method"] = "POST"
    params["url"] = base_url
    params["data"] = urlencode(data)
    params["headers"]["User-Agent"] = _UA
    params["headers"]["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8"
    params["headers"]["Faces-Request"] = "partial/ajax"
    params["cookies"] = dict(form.cookies)
    return params


def response(resp):
    results = []

    if resp.status_code != 200:
        return results

    body = unescape(resp.text)

    if "validationFailed" in body:
        return results

    partes = _DOC_SPLIT_RE.split(body)

    blocos = {}
    for i in range(1, len(partes) - 1, 2):
        blocos.setdefault(partes[i], "")
        blocos[partes[i]] += partes[i + 1]

    for indice in sorted(blocos, key=lambda x: int(x)):
        texto = _plain(blocos[indice])

        campos = {}
        for nome, padrao in _FIELD_RE.items():
            achado = padrao.search(texto)
            if achado:
                campos[nome] = achado.group(1).strip()

        if not campos.get("classe") and not campos.get("numero"):
            continue

        # O tribunal vem da instancia da engine, nao do HTML: o campo "Origem"
        # varia entre os tribunais (as vezes truncado, as vezes ausente) e o
        # titulo e' o que identifica o julgado para quem le a resposta.
        # O numero entra junto porque e' o material que evita o modelo
        # reconstruir um de memoria.
        classe = campos.get("classe", "")
        numero = campos.get("numero", "")

        if numero and numero not in classe:
            classe = f"{classe} {numero}".strip()

        titulo = " · ".join(
            p for p in (
                tribunal,
                classe or None,
                campos.get("relator") and f"Rel. {campos['relator']}",
                campos.get("data"),
            ) if p
        )

        # O corpo util comeca depois do cabecalho de campos.
        corte = texto.find("Data ")
        corpo = texto[corte:] if corte > 0 else texto

        results.append(
            {
                "url": f"{base_url}#doc{indice}-{campos.get('numero', indice)}",
                "title": f"{titulo} — CJF Jurisprudência Unificada",
                "content": corpo[:900],
            }
        )

    return results
