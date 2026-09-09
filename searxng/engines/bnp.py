# SPDX-License-Identifier: AGPL-3.0-or-later
"""Pangea/BNP - Banco Nacional de Precedentes (CNJ).

Base oficial de precedentes qualificados de todos os tribunais brasileiros,
mantida pelo TRT-4 em parceria com o CNJ (Resolucao CNJ 444/2022). O manual
declara que a ferramenta e' **publica** - "destina-se a todos os cidadaos" - e a
API de consulta responde sem autenticacao.

Contrato (capturado do proprio app em 2026-09-08, nao ha documentacao publica):
``POST https://pangeabnp.pdpj.jus.br/api/v1/precedentes`` com ``{"filtro": {...}}``.
A resposta traz ``total`` e ``resultados[]`` com ``id``, ``orgao``, ``tipo``
(SUM/SV/RG/IAC/IRDR/RR/OJ/...), ``nr``, ``tese``, ``situacao`` e
``ultimaAtualizacao``.

Boas praticas seguidas do manual (docs.pdpj.jus.br, "BNP - Manual de Utilizacao"):

* **A barra simples busca "quaisquer das palavras" (OR)** e ordena por frequencia,
  o que gera muito ruido numa pergunta juridica. Esta engine usa o campo
  ``todasPalavras`` (o modo "Todas as palavras" do manual) e so' cai para a busca
  geral quando o modo restrito nao acha nada - a mesma degradacao progressiva
  usada na engine do Conjur.
* **"e" e "ou" nao sao conectores** ("O termo 'e' nao e' um conector de itens de
  pesquisa"), entao sao removidos da consulta em vez de irem como termo.
* **``cancelados: false``**: o manual diz que precedentes cancelados ficam fora
  por padrao. Manter assim importa - precedente cancelado apresentado como
  vigente e' erro grave. A ``situacao`` de cada item vai no texto do resultado.
* O banco e' **atualizado duas vezes por mes**, entao cache agressivo do lado do
  Vane e' seguro.

Limite conhecido: **o BNP nao tem deep link por precedente.** O app renderiza os
resultados no cliente e a URL fica em ``/pesquisa``. A URL de cada resultado usa
um fragmento (``#<id>``) apenas para dar identidade unica ao item - quem
identifica o precedente e' o titulo (``STJ · SUM 314 · Vigente``), nao o link.
"""

from json import dumps, loads

from searx.network import post

about = {
    "website": "https://pangeabnp.pdpj.jus.br/",
    "official_api_documentation": "https://docs.pdpj.jus.br/servicos-negociais/BNP-Pangea/",
    "use_official_api": True,
    "require_api_key": False,
    "results": "JSON",
}

categories = ["general"]
paging = True

api_url = "https://pangeabnp.pdpj.jus.br/api/v1/precedentes"

_PAGE_SIZE = 20

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
)

_ORGAOS = [
    "STF", "STJ", "TST", "STM", "TNU", "TRF01", "TRF02", "TRF03", "TRF04",
    "TRF05", "TRF06", "TJAC", "TJAL", "TJAP", "TJAM", "TJBA", "TJCE", "TJDF",
    "TJES", "TJGO", "TJMA", "TJMT", "TJMS", "TJMG", "TJPA", "TJPB", "TJPR",
    "TJPE", "TJPI", "TJRJ", "TJRN", "TJRS", "TJRO", "TJRR", "TJSC", "TJSP",
    "TJSE", "TJTO", "TRT01", "TRT02", "TRT03", "TRT04", "TRT05", "TRT06",
    "TRT07", "TRT08", "TRT09", "TRT10", "TRT11", "TRT12", "TRT13", "TRT14",
    "TRT15", "TRT16", "TRT17", "TRT18", "TRT19", "TRT20", "TRT21", "TRT22",
    "TRT23", "TRT24",
]

# Sobrescrevivel por instancia no settings.yml (`orgaos:` / `tipos:`). O nome
# tem que ser exatamente este: o SearXNG seta o atributo pelo nome declarado no
# settings, e ler um `_ORGAOS` privado aqui faz o filtro ser ignorado em
# silencio - medido em 2026-09-09, quando a instancia "bnp superiores" devolveu
# TRF03 e TRF06.
orgaos = _ORGAOS

_TIPOS = [
    "SUM", "SV", "RG", "ADI", "ADC", "ADO", "ADPF", "IAC", "SIRDR", "RR",
    "CT", "IRDR", "IRR", "PUIL", "NT", "OJ",
]

# Conectores que o manual diz explicitamente que nao sao operadores aqui.
_STOPWORDS = {"e", "ou", "de", "da", "do", "das", "dos", "a", "o", "as", "os", "em", "no", "na"}


# Nao usar `None` como padrao: o SearXNG trata atributo de modulo valendo None
# como **configuracao obrigatoria** e recusa a engine com
# `Missing engine config attribute`. Medido em 2026-09-09.
tipos = _TIPOS


def _filtro(termos, modo, pagina, tamanho):
    return {
        "filtro": {
            "buscaGeral": termos if modo == "geral" else "",
            "todasPalavras": termos if modo == "todas" else "",
            "quaisquerPalavras": "",
            "semPalavras": "",
            "trechoExato": "",
            "atualizacaoDesde": "",
            "atualizacaoAte": "",
            "cancelados": False,
            "ordenacao": "Text",
            "nr": "",
            "pagina": pagina,
            "tamanhoPagina": tamanho,
            "orgaos": orgaos,
            "tipos": tipos,
        }
    }


def _total(termos, modo):
    """Pre-voo barato (uma pagina de 1 item) so' para ler o `total`."""
    try:
        resp = post(
            api_url,
            data=dumps(_filtro(termos, modo, 1, 1)),
            headers={"Content-Type": "application/json", "User-Agent": _UA},
            timeout=10.0,
        )
    except Exception:  # pylint: disable=broad-except
        return None

    if resp.status_code != 200:
        return None

    try:
        return loads(resp.text).get("total")
    except ValueError:
        return None


def request(query, params):
    termos = " ".join(w for w in query.split() if w.lower() not in _STOPWORDS) or query

    # "Todas as palavras" da precisao; a barra simples (OR) da cobertura. Comeca
    # restrito e afrouxa, para uma pergunta especifica nao voltar vazia.
    modo = "todas" if (_total(termos, "todas") or 0) > 0 else "geral"

    params["method"] = "POST"
    params["url"] = api_url
    params["data"] = dumps(_filtro(termos, modo, params.get("pageno", 1), _PAGE_SIZE))
    params["headers"]["Content-Type"] = "application/json"
    params["headers"]["User-Agent"] = _UA
    return params


def _plain(html):
    import re

    text = re.sub(r"<[^>]+>", " ", html or "")
    text = (
        text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
    )
    return " ".join(text.split())


def response(resp):
    results = []

    if resp.status_code != 200:
        return results

    try:
        data = loads(resp.text)
    except ValueError:
        return results

    for item in data.get("resultados") or []:
        item_id = item.get("id")
        orgao = item.get("orgao") or ""
        tipo = item.get("tipo") or ""
        numero = item.get("nr")
        situacao = item.get("situacao") or ""

        titulo = " · ".join(
            p for p in (orgao, f"{tipo} {numero}".strip(), situacao) if p and p.strip()
        )

        tese = _plain(item.get("tese"))

        if not titulo or not item_id:
            continue

        # O numero do processo paradigma vai junto: sem ele o modelo inventa um
        # ao lado de um precedente correto (medido no Tema/RR 985 em 2026-09-08).
        paradigmas = [
            str(p.get("numero"))
            for p in (item.get("processosParadigma") or [])
            if p and p.get("numero")
        ]

        conteudo = (
            f"Processo(s) paradigma: {', '.join(paradigmas[:4])}. " if paradigmas else ""
        ) + (f"Tese: {tese}" if tese else "")
        if situacao:
            conteudo = f"[{situacao}] {conteudo}".strip()

        results.append(
            {
                "url": f"https://pangeabnp.pdpj.jus.br/pesquisa#{item_id}",
                "title": f"{titulo} — Banco Nacional de Precedentes (CNJ)",
                "content": conteudo[:900],
            }
        )

    return results
