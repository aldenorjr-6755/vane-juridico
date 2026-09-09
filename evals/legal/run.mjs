#!/usr/bin/env node
/**
 * Avaliação do modo Jurídico.
 *
 * Roda cada caso de `cases.json` contra /api/search com `sources: ["legal"]` e
 * mede, para cada um:
 *
 *   retrieval   - o precedente do gabarito chegou às FONTES recuperadas?
 *                 (a métrica que mais importa: o writer não pode citar o que a
 *                 busca não trouxe)
 *   citation    - a resposta cita o que tinha que citar, e não cita o proibido
 *   caveat      - precedente não definitivo (RE pendente, afetado, cancelado)
 *                 aparece na resposta com a ressalva
 *   whitelist   - 100% das fontes em domínio jurídico permitido
 *   identifiers - todo número de Tema/Súmula/REsp/RG citado na resposta existe
 *                 em alguma fonte recuperada
 *
 * O último é o mais geral: é a regra dura do prompt forense, verificada de
 * forma automática. Um número que aparece na resposta e não está em fonte
 * nenhuma foi inventado, e é o erro mais caro numa resposta jurídica.
 *
 * Uso:  node evals/legal/run.mjs [--case <id>] [--mode balanced|speed|quality]
 *       VANE_URL, VANE_CHAT_MODEL, VANE_CHAT_PROVIDER, VANE_EMBED_* no ambiente.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const VANE = process.env.VANE_URL ?? 'http://localhost:3000';
const CHAT_PROVIDER =
  process.env.VANE_CHAT_PROVIDER ?? '7b4e8fc5-7232-4eaf-9e6d-f344209809c2';
const CHAT_MODEL = process.env.VANE_CHAT_MODEL ?? 'models/gemini-3.1-flash-lite';
const EMBED_PROVIDER =
  process.env.VANE_EMBED_PROVIDER ?? 'a07fbfdd-1a9b-40f6-b729-92150936de0a';
const EMBED_MODEL = process.env.VANE_EMBED_MODEL ?? 'Xenova/all-MiniLM-L6-v2';

const ALLOWED_HOSTS = [
  'conjur.com.br',
  'migalhas.com.br',
  'stj.jus.br',
  'stf.jus.br',
  'planalto.gov.br',
  'dizerodireito.com.br',
  'jusbrasil.com.br',
  'pdpj.jus.br',
];

const args = process.argv.slice(2);
const only = args.includes('--case') ? args[args.indexOf('--case') + 1] : null;
const mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'balanced';

const { cases } = JSON.parse(
  fs.readFileSync(path.join(HERE, 'cases.json'), 'utf-8'),
);

/** "Tema 1.162" e "RG 1162" têm que casar, então os pontos caem. */
const norm = (s) =>
  (s ?? '')
    .toLowerCase()
    .replace(/[. ]/g, '')
    .replace(/\s+/g, ' ');

const hostOf = (u) => {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return '';
  }
};

const onAllowedHost = (u) => {
  const h = hostOf(u);
  return ALLOWED_HOSTS.some((a) => h === a || h.endsWith(`.${a}`));
};

/** Identificadores de precedente citados num texto. Números de lei ficam fora. */
const identifiers = (text) => {
  const out = new Set();
  const patterns = [
    /\btema\s*(?:repetitivo\s*)?n?[ºo°]?\s*([\d.]{1,7}\d)/gi,
    /\bs[úu]mula\s*(?:vinculante\s*)?n?[ºo°]?\s*([\d.]{1,6}\d)/gi,
    /\bresp\s*n?[ºo°]?\s*([\d.]{3,}[\d]|[\d.]+\/[a-z]{2})/gi,
    /\brg\s*(\d{1,5})\b/gi,
    /\b(?:RR|IRDR|IAC|PUIL)\s*(\d{1,5})\b/g,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) out.add(norm(m[1]).replace(/\/.*$/, ''));
  }
  return [...out].filter((x) => x.length > 0);
};

const ask = async (query) => {
  const res = await fetch(`${VANE}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      optimizationMode: mode,
      sources: ['legal'],
      chatModel: { providerId: CHAT_PROVIDER, key: CHAT_MODEL },
      embeddingModel: { providerId: EMBED_PROVIDER, key: EMBED_MODEL },
      query,
      history: [],
      stream: false,
    }),
    signal: AbortSignal.timeout(600000),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

const check = (c, answer, sources) => {
  const a = norm(answer);
  const srcText = norm(
    sources
      .map((s) => `${s?.metadata?.title ?? ''} ${s?.metadata?.url ?? ''} ${s?.pageContent ?? s?.content ?? ''}`)
      .join(' \n '),
  );

  const fails = [];
  const notes = [];

  // 1. retrieval
  if ((c.gold ?? []).length > 0) {
    const hit = c.gold.find((g) => srcText.includes(norm(g)));
    if (hit) notes.push(`gold: ${hit}`);
    else fails.push(`retrieval: nenhum de [${c.gold.join(', ')}] nas fontes`);
  }

  // 2. citation
  for (const m of c.must_cite ?? [])
    if (!a.includes(norm(m))) fails.push(`citation: falta "${m}" na resposta`);
  for (const m of c.must_not ?? [])
    if (a.includes(norm(m))) fails.push(`proibido: "${m}" apareceu na resposta`);

  // 3. caveat de precedente não definitivo
  if (c.caveat_for) {
    const cited = sources.some((s) =>
      norm(s?.metadata?.title ?? '').includes(norm(c.caveat_for)),
    );
    if (cited) {
      const ok = (c.caveat_words ?? []).some((w) => new RegExp(w, 'i').test(answer));
      if (ok) notes.push(`ressalva de "${c.caveat_for}" presente`);
      else fails.push(`caveat: fonte "${c.caveat_for}" citada sem ressalva`);
    }
  }

  // 4. recusa esperada
  if (c.expect_refusal) {
    const ok = (c.refusal_words ?? []).some((w) => new RegExp(w, 'i').test(answer));
    if (ok) notes.push('recusou corretamente');
    else fails.push('refusal: não declarou que não encontrou');
  }

  // 5. whitelist
  const fora = sources.map((s) => s?.metadata?.url ?? '').filter((u) => u && !onAllowedHost(u));
  if (fora.length) fails.push(`whitelist: ${fora.length} fora (${hostOf(fora[0])})`);

  // 6. identificadores inventados
  const inventados = identifiers(answer).filter((id) => !srcText.includes(id));
  if (inventados.length)
    fails.push(`identificador sem fonte: ${inventados.join(', ')}`);

  return { fails, notes };
};

const main = async () => {
  const selected = only ? cases.filter((c) => c.id === only) : cases;
  const report = [];
  let failed = 0;

  console.log(`modo=${mode}  modelo=${CHAT_MODEL}  casos=${selected.length}\n`);

  for (const c of selected) {
    const t0 = Date.now();
    let answer = '';
    let sources = [];
    let erro = null;

    try {
      const r = await ask(c.query);
      answer = r.message ?? '';
      sources = r.sources ?? [];
    } catch (e) {
      erro = String(e).slice(0, 90);
    }

    const secs = ((Date.now() - t0) / 1000).toFixed(0);

    if (erro) {
      failed++;
      console.log(`FALHA  ${c.id}  (${secs}s)\n         erro: ${erro}`);
      report.push({ id: c.id, ok: false, erro });
      continue;
    }

    const { fails, notes } = check(c, answer, sources);
    const ok = fails.length === 0;
    if (!ok) failed++;

    console.log(
      `${ok ? 'OK   ' : 'FALHA'}  ${c.id.padEnd(38)} ${secs}s  ${sources.length} fontes`,
    );
    for (const n of notes) console.log(`         · ${n}`);
    for (const f of fails) console.log(`         ✗ ${f}`);

    report.push({ id: c.id, ok, fails, notes, sources: sources.length, secs: +secs, answer });
  }

  const out = path.join(HERE, 'last-run.json');
  fs.writeFileSync(out, JSON.stringify({ mode, model: CHAT_MODEL, at: new Date().toISOString(), report }, null, 2));

  console.log(
    `\n${selected.length - failed}/${selected.length} passaram. Relatório: ${out}`,
  );
  process.exit(failed > 0 ? 1 : 0);
};

main();
