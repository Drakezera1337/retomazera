// Extratores do Retomazera Coletor. Cada função roda DENTRO da página (world MAIN) via
// chrome.scripting.executeScript, então precisa ser autossuficiente (nada de fora da função).
// Só leitura: abrem conversas e leem o que está na tela. Nunca digitam em caixa de mensagem.
// Recebem 'desde' (ms: início do período = última coleta) e devolvem { conversas: [...], aviso?, erro? }.
// Cada conversa: { nome, contato, anuncio?, rotulo, mensagens: [{ data, hora, eu, autor, texto }] }.

/* eslint-disable no-unused-vars */

// ------------------------------------------------------------------ OLX
async function extrairOlx(desde, ignorar = []) {
  // período: tudo desde a última coleta (desde, em ms) até agora
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const diasJanela = (() => { const st = new Set(); const d = new Date(desde); d.setHours(0, 0, 0, 0); const h = new Date(); for (; d <= h; d.setDate(d.getDate() + 1)) st.add(iso(d)); return st; })();
  const noPeriodo = (data, hora) => {
    if (!data) return true;
    const [a, m, d] = data.split('-').map(Number);
    const [hh, mi] = String(hora || '23:59').split(':').map(Number);
    return new Date(a, m - 1, d, hh || 0, mi || 0).getTime() >= desde - 60000;
  };
  // rótulo da lista ("14:32", "Ontem", "Domingo"/"Dom", "05/11") → esse dia cai no período?
  const rotuloNoPeriodo = (r) => {
    r = (r || '').trim().toLowerCase();
    const d = new Date(); d.setHours(0, 0, 0, 0);
    if (/^\d{1,2}:\d{2}$/.test(r) || /^\d+\s*(min|h)$/.test(r)) return true;
    if (r === 'ontem') { d.setDate(d.getDate() - 1); return diasJanela.has(iso(d)); }
    const i = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'].findIndex((x) => r.startsWith(x) || (x === 'sáb' && r.startsWith('sab')));
    if (i >= 0) { do { d.setDate(d.getDate() - 1); } while (d.getDay() !== i); return diasJanela.has(iso(d)); }
    const m = r.match(/^(\d{1,2})\/(\d{1,2})/);
    if (m) return [...diasJanela].some((x) => x.endsWith(`-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`));
    return false;
  };
  // contatos pessoais que o João pediu para não coletar (nome exatamente igual ou telefone)
  const normal = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const termos = (ignorar || []).map(normal).filter(Boolean);
  const ignorado = (nome, fone) => {
    const n = normal(nome), f = String(fone || '').replace(/\D/g, '');
    return termos.some((t) => /^\d{8,}$/.test(t.replace(/ /g, '')) ? (f && f.endsWith(t.replace(/ /g, '').slice(-8))) : n === t);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esperar = async (fn, ms = 20000) => { const fim = Date.now() + ms; while (Date.now() < fim) { const v = fn(); if (v) return v; await sleep(400); } return null; };
  const MESES = { janeiro: 1, fevereiro: 2, 'março': 3, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12 };

  if (!await esperar(() => document.querySelector('a[data-testid="chat-list-item"]'))) {
    return { erro: 'lista de conversas não carregou (OLX deslogada?)', conversas: [] };
  }
  const filtro = [...document.querySelectorAll('button,[role=tab],label')].find((e) => e.innerText.trim() === 'Vendendo');
  if (filtro) { filtro.click(); await sleep(2500); }

  const ehRotulo = (r) => /^\d{1,2}:\d{2}$/.test(r) || /^(ontem|domingo|segunda|terça|quarta|quinta|sexta|sábado)/i.test(r) || /^\d{1,2}\/\d{1,2}/.test(r);
  // linhas do item: [inicial, anúncio, nome, última mensagem, horário, (contador de não lidas)]
  const linhas = (a) => {
    const l = a.innerText.split('\n').map((s) => s.trim()).filter(Boolean);
    let i = l.length - 1;
    while (i > 0 && !ehRotulo(l[i])) i--;
    return l.slice(0, i + 1);
  };
  const alvos = [...document.querySelectorAll('a[data-testid="chat-list-item"]')]
    .map((a) => ({ a, l: linhas(a) }))
    .filter((x) => rotuloNoPeriodo(x.l[x.l.length - 1]))
    .slice(0, 40);

  const conversas = [];
  for (const { a, l } of alvos) {
    if (ignorado(l[l.length - 3], '')) continue;
    const href = a.getAttribute('href') || '';
    try {
      const idAlvo = new URLSearchParams(href.replace(/^[^?]*/, '')).get('chat-id');
      a.click();
      await sleep(1200);
      // espera a conversa NOVA: URL com o chat-id dela e mensagens na tela
      const raiz = await esperar(() => {
        if (idAlvo && new URLSearchParams(location.search).get('chat-id') !== idAlvo) return null;
        const r = document.querySelector('div.flex-col-reverse.min-h-full');
        return r && r.children[0] && r.children[0].children.length ? r : null;
      }, 12000);
      if (!raiz) { conversas.push({ nome: l[l.length - 3] || '', anuncio: l[l.length - 4] || '', contato: location.href, rotulo: l[l.length - 1], mensagens: [], aviso: 'conversa não carregou' }); continue; }
      await sleep(1500);
      const msgs = [];
      let dataAtual = '';
      for (const filho of [...raiz.children[0].children].reverse()) {
        const ehGrupo = filho.querySelector('span.font-bold') && filho.querySelector('[class*="group/bubble"]');
        if (!ehGrupo) {
          const m = filho.innerText.match(/(\d{1,2}) de ([a-zçã]+) de (\d{4})/i);
          if (m && MESES[m[2].toLowerCase()]) dataAtual = `${m[3]}-${String(MESES[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
          continue;
        }
        const spans = filho.querySelectorAll('span.typo-caption');
        const autor = (filho.querySelector('span.font-bold')?.innerText || '').trim();
        const hora = [...spans].map((s) => s.innerText.trim()).find((t) => /^\d{1,2}:\d{2}$/.test(t)) || '';
        const eu = filho.classList.contains('items-end') || autor === 'Você';
        for (const b of [...filho.querySelectorAll('[class*="group/bubble"]')].reverse()) {
          const texto = b.innerText.trim() || (b.querySelector('img,video,audio') ? '[mídia]' : '');
          if (texto) msgs.push({ data: dataAtual, hora, eu, autor: eu ? 'João' : autor, texto: texto.slice(0, 1500) });
        }
      }
      if (msgs.length && !msgs.some((m) => noPeriodo(m.data, m.hora))) continue; // nada novo no período
      conversas.push({ nome: l[l.length - 3] || '', anuncio: l[l.length - 4] || '', contato: location.href, rotulo: l[l.length - 1], mensagens: msgs.slice(-80) });
    } catch (e) {
      conversas.push({ nome: l[l.length - 3] || '', contato: href, mensagens: [], aviso: 'erro: ' + String(e).slice(0, 120) });
    }
    await sleep(800);
  }
  return { conversas };
}

// ------------------------------------------------------------------ Facebook Marketplace
async function extrairFacebook(desde, ignorar = []) {
  // período: tudo desde a última coleta (desde, em ms) até agora
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const diasJanela = (() => { const st = new Set(); const d = new Date(desde); d.setHours(0, 0, 0, 0); const h = new Date(); for (; d <= h; d.setDate(d.getDate() + 1)) st.add(iso(d)); return st; })();
  const noPeriodo = (data, hora) => {
    if (!data) return true;
    const [a, m, d] = data.split('-').map(Number);
    const [hh, mi] = String(hora || '23:59').split(':').map(Number);
    return new Date(a, m - 1, d, hh || 0, mi || 0).getTime() >= desde - 60000;
  };
  // rótulo da lista ("14:32", "Ontem", "Domingo"/"Dom", "05/11") → esse dia cai no período?
  const rotuloNoPeriodo = (r) => {
    r = (r || '').trim().toLowerCase();
    const d = new Date(); d.setHours(0, 0, 0, 0);
    if (/^\d{1,2}:\d{2}$/.test(r) || /^\d+\s*(min|h)$/.test(r)) return true;
    if (r === 'ontem') { d.setDate(d.getDate() - 1); return diasJanela.has(iso(d)); }
    const i = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'].findIndex((x) => r.startsWith(x) || (x === 'sáb' && r.startsWith('sab')));
    if (i >= 0) { do { d.setDate(d.getDate() - 1); } while (d.getDay() !== i); return diasJanela.has(iso(d)); }
    const m = r.match(/^(\d{1,2})\/(\d{1,2})/);
    if (m) return [...diasJanela].some((x) => x.endsWith(`-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`));
    return false;
  };
  // contatos pessoais que o João pediu para não coletar (nome exatamente igual ou telefone)
  const normal = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const termos = (ignorar || []).map(normal).filter(Boolean);
  const ignorado = (nome, fone) => {
    const n = normal(nome), f = String(fone || '').replace(/\D/g, '');
    return termos.some((t) => /^\d{8,}$/.test(t.replace(/ /g, '')) ? (f && f.endsWith(t.replace(/ /g, '').slice(-8))) : n === t);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esperar = async (fn, ms = 20000) => { const fim = Date.now() + ms; while (Date.now() < fim) { const v = fn(); if (v) return v; await sleep(400); } return null; };
  const ehRotulo = (s) => /^\d{1,2}:\d{2}$/.test(s) || /^\d+\s*(min|h)$/.test(s) || /^(dom|seg|ter|qua|qui|sex|sáb|sab)\.?$/i.test(s) || /^ontem$/i.test(s) || /^\d{1,2} de [a-z]+\.?$/i.test(s) || /^\d{1,2}\/\d{1,2}/.test(s);

  const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
  const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  // rótulo de dia do Facebook → AAAA-MM-DD (sem rótulo = hoje)
  const dataDoRotulo = (r) => {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    r = (r || '').trim().toLowerCase();
    if (!r || r === 'hoje') return iso(d);
    if (r === 'ontem') { d.setDate(d.getDate() - 1); return iso(d); }
    let m = r.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    m = r.match(/^(\d{1,2}) de ([a-zç]+)\.?(?: de (\d{4}))?/);
    if (m && MESES.indexOf(m[2].slice(0, 3)) >= 0) return `${m[3] || d.getFullYear()}-${String(MESES.indexOf(m[2].slice(0, 3)) + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    const i = DIAS.findIndex((x) => r.startsWith(x.slice(0, 3)));
    if (i >= 0) { do { d.setDate(d.getDate() - 1); } while (d.getDay() !== i); return iso(d); }
    return '';
  };
  // linhas da caixa de entrada: blocos com "Nome · Título" e um rótulo de horário
  const acharLinhas = () => {
    const vistos = new Set();
    const lista = [];
    for (const el of document.querySelectorAll('div[role="button"], a[role="link"], div[role="row"], div[role="listitem"]')) {
      const t = (el.innerText || '').trim();
      if (!t.includes(' · ') || t.length > 400) continue;
      const l = t.split('\n').map((s) => s.trim()).filter(Boolean);
      const rot = l.find(ehRotulo);
      if (!rot || l.length < 2) continue;
      // linhas: ["Nome", " · Título do anúncio", "última mensagem", "Dom"]
      const chave = l.slice(0, 3).join('|');
      if (vistos.has(chave)) continue;
      vistos.add(chave);
      const nome = l[0].includes(' · ') ? l[0].split(' · ')[0] : l[0];
      const anuncio = (l.find((s) => s.includes('·')) || '').split('·').slice(1).join('·').trim();
      lista.push({ el, l, rot, nome: nome.trim(), anuncio });
    }
    return lista;
  };
  const linhasIni = await esperar(() => { const x = acharLinhas(); return x.length ? x : null; }, 25000);
  if (!linhasIni) return { erro: 'caixa de entrada não carregou (Facebook deslogado?)', conversas: [] };
  await sleep(1500);
  const aba = [...document.querySelectorAll('[role=tab], a, div[role=button]')].find((e) => e.innerText.trim() === 'Venda');
  if (aba && aba.getAttribute('aria-selected') === 'false') { aba.click(); await sleep(2000); }

  const alvos = acharLinhas().filter((x) => rotuloNoPeriodo(x.rot)).slice(0, 40);
  const conversas = [];
  for (const { el, rot, nome, anuncio } of alvos) {
    if (ignorado(nome, '')) continue;
    const resto = [anuncio];
    try {
      document.querySelector('[aria-label="Fechar conversa"]')?.click();
      await sleep(600);
      el.click();
      const log = await esperar(() => {
        const g = document.querySelector('[role=log]');
        return g && (g.getAttribute('aria-label') || '').includes(nome.trim()) ? g : null;
      }, 12000) || document.querySelector('[role=log]');
      if (!log) { conversas.push({ nome, anuncio: resto.join(' · '), contato: 'https://www.facebook.com/marketplace/inbox', rotulo: rot, mensagens: [], aviso: 'conversa não abriu' }); continue; }
      await sleep(2000);
      const msgs = [];
      // "Às 20:30, Rick: texto" (hoje) | "Às Domingo 20:30, Rick: texto" | "Às 02/11/2026 20:30, ..."
      for (const s of [...log.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label'))) {
        const m = s.match(/^Às (?:(.+?),? )?(\d{1,2}:\d{2}), ([^:]+?): ([\s\S]*)$/);
        if (!m) continue;
        const eu = m[3].trim() === 'Você';
        if (/iniciou esta conversa\.?$/.test(m[4])) continue;
        const data = dataDoRotulo(m[1]);
        const ult = msgs[msgs.length - 1];
        if (ult && ult.hora === m[2] && ult.texto === m[4]) continue;
        msgs.push({ data, hora: m[2], eu, autor: eu ? 'João' : m[3].trim(), texto: m[4].slice(0, 1500) });
      }
      if (msgs.length && !msgs.some((m) => noPeriodo(m.data, m.hora))) continue; // nada novo no período
      conversas.push({ nome: nome.trim(), anuncio: resto.join(' · '), contato: 'https://www.facebook.com/marketplace/inbox', rotulo: rot, mensagens: msgs.slice(-80) });
    } catch (e) {
      conversas.push({ nome, contato: 'https://www.facebook.com/marketplace/inbox', mensagens: [], aviso: 'erro: ' + String(e).slice(0, 120) });
    }
  }
  document.querySelector('[aria-label="Fechar conversa"]')?.click();
  return { conversas };
}

// ------------------------------------------------------------------ WhatsApp Web
// A lista de conversas do período vem de WAWebCollections.Chat (só leitura de dados já carregados —
// NÃO usa funções que carregam mensagens). As mensagens são lidas da tela, rolando o painel.
// opcoes: { primeira (espera a sincronização só na 1ª parte), feitos: [chaves já lidas], prazoMs }.
// O Chrome encerra a extensão se uma tarefa passa de ~5 min: o background chama em partes de ~3 min.
async function extrairWhatsapp(desde, ignorar = [], limite = 60, opcoes = {}) {
  // período: tudo desde a última coleta (desde, em ms) até agora
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const diasJanela = (() => { const st = new Set(); const d = new Date(desde); d.setHours(0, 0, 0, 0); const h = new Date(); for (; d <= h; d.setDate(d.getDate() + 1)) st.add(iso(d)); return st; })();
  const noPeriodo = (data, hora) => {
    if (!data) return true;
    const [a, m, d] = data.split('-').map(Number);
    const [hh, mi] = String(hora || '23:59').split(':').map(Number);
    return new Date(a, m - 1, d, hh || 0, mi || 0).getTime() >= desde - 60000;
  };
  // rótulo da lista ("14:32", "Ontem", "Domingo"/"Dom", "05/11") → esse dia cai no período?
  const rotuloNoPeriodo = (r) => {
    r = (r || '').trim().toLowerCase();
    const d = new Date(); d.setHours(0, 0, 0, 0);
    if (/^\d{1,2}:\d{2}$/.test(r) || /^\d+\s*(min|h)$/.test(r)) return true;
    if (r === 'ontem') { d.setDate(d.getDate() - 1); return diasJanela.has(iso(d)); }
    const i = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'].findIndex((x) => r.startsWith(x) || (x === 'sáb' && r.startsWith('sab')));
    if (i >= 0) { do { d.setDate(d.getDate() - 1); } while (d.getDay() !== i); return diasJanela.has(iso(d)); }
    const m = r.match(/^(\d{1,2})\/(\d{1,2})/);
    if (m) return [...diasJanela].some((x) => x.endsWith(`-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`));
    return false;
  };
  // contatos pessoais que o João pediu para não coletar (nome exatamente igual ou telefone)
  const normal = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const termos = (ignorar || []).map(normal).filter(Boolean);
  const ignorado = (nome, fone) => {
    const n = normal(nome), f = String(fone || '').replace(/\D/g, '');
    return termos.some((t) => /^\d{8,}$/.test(t.replace(/ /g, '')) ? (f && f.endsWith(t.replace(/ /g, '').slice(-8))) : n === t);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esperar = async (fn, ms = 20000) => { const fim = Date.now() + ms; while (Date.now() < fim) { const v = fn(); if (v) return v; await sleep(500); } return null; };
  const ini = desde / 1000;

  const pronto = await esperar(() => document.querySelector('#pane-side') && window.require && (() => { try { return window.require('WAWebCollections').Chat.getModelsArray().length > 0; } catch { return false; } })(), 90000);
  if (!pronto) return { erro: document.querySelector('canvas') ? 'WhatsApp Web deslogado (pede QR)' : 'WhatsApp Web não carregou', conversas: [] };
  // WhatsApp Web recém-aberto ainda baixa as mensagens do celular: espera a sincronização terminar
  // (some o aviso "Sincronizando…/Carregando…" da lista) e a lista de conversas parar de mudar.
  const primeira = opcoes.primeira !== false;
  const fimPrazo = Date.now() + (opcoes.prazoMs || 36e5);
  const jaFeitos = new Set(opcoes.feitos || []);
  if (primeira) await sleep(8000);
  const sincronizando = () => /sincroniz|carregando (suas )?(conversas|mensagens)|syncing|loading (your )?(chats|messages)/i.test(document.querySelector('#side')?.innerText || '')
    || !!document.querySelector('#side [role="progressbar"], [data-testid="chat-list-sync-progress"]');
  for (let i = 0, ultimo = -1, iguais = 0; primeira && i < 60; i++) {
    const t = Math.max(0, ...window.require('WAWebCollections').Chat.getModelsArray().map((c) => c.t || 0));
    if (!sincronizando() && t === ultimo) { if (++iguais >= 3) break; } else iguais = 0;
    ultimo = t;
    await sleep(2000);
  }

  const C = window.require('WAWebCollections');
  const chats = C.Chat.getModelsArray()
    .filter((c) => c.id.server !== 'g.us' && c.id.server !== 'newsletter' && c.id.server !== 'broadcast' && (c.t || 0) >= ini)
    .map((c) => {
      const ph = c.id.server === 'c.us' ? c.id.user : (c.contact && c.contact.phoneNumber && c.contact.phoneNumber.user) || '';
      return { ph, nm: (c.contact && (c.contact.name || c.contact.pushname)) || c.formattedTitle || '', t: c.t, empresa: !!(c.contact && c.contact.isEnterprise) };
    })
    .filter((c) => !c.empresa && !ignorado(c.nm, c.ph))
    .sort((a, b) => b.t - a.t)
    .slice(0, limite)
    .filter((c) => !jaFeitos.has(c.ph || c.nm));

  const box = await esperar(() => document.querySelector('#side input[data-tab="3"]') || document.querySelector('#side [contenteditable="true"]'), 10000);
  if (!box) return { erro: 'não achei a busca do WhatsApp', conversas: [] };
  const setValor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  const buscar = async (texto) => {
    box.focus();
    setValor.call(box, ''); box.dispatchEvent(new Event('input', { bubbles: true })); await sleep(400);
    setValor.call(box, texto); box.dispatchEvent(new Event('input', { bubbles: true })); await sleep(2000);
    for (const t of ['keydown', 'keyup']) box.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    await sleep(2200);
  };
  const dataDe = (h) => { const m = (h || '').match(/(\d+):(\d+), (\d+)\/(\d+)\/(\d+)/); return m ? `${m[5]}-${m[4].padStart(2, '0')}-${m[3].padStart(2, '0')}` : ''; };

  async function lerAberta() {
    const main = document.querySelector('#main');
    const pane = main && main.querySelector('[data-testid="conversation-panel-messages"]');
    if (!pane) return null;
    const mapa = new Map(); let ordem = [];
    const chave = (x) => x.querySelector('[data-id]')?.getAttribute('data-id') || '';
    const pr = () => pane.getBoundingClientRect();
    const parse = (x) => {
      const c = x.querySelector('[data-pre-plain-text]');
      if (c) {
        const m = c.getAttribute('data-pre-plain-text').match(/\[([^\]]+)\] (.*?):\s*$/);
        const sel = [...c.querySelectorAll('.selectable-text')].filter((e) => !e.closest('[role=button]')).pop() || c;
        return { h: m ? m[1] : '', autor: m ? m[2] : '', texto: sel.innerText.trim() };
      }
      const mc = x.querySelector('[data-testid="msg-container"]');
      if (!mc) return null;
      const r = mc.getBoundingClientRect(), p = pr();
      const eu = (r.left + r.right) / 2 > (p.left + p.right) / 2;
      const tipo = x.querySelector('[data-icon*="audio"],[data-icon*="ptt"],audio') ? '[áudio]' : x.querySelector('img,video') ? '[foto/vídeo]' : '[mídia]';
      const hm = ((x.innerText || '').match(/(\d{1,2}:\d{2})\s*$/) || [])[1] || '';
      return { h: hm, autor: eu ? 'Gamezeraofc' : '', texto: tipo, semData: true };
    };
    const snap = () => {
      const S = [];
      for (const x of pane.querySelectorAll('[role="row"]')) {
        const k = chave(x); if (!k) continue;
        S.push(k);
        if (!mapa.has(k)) { const p = parse(x); if (p) mapa.set(k, p); }
      }
      if (!ordem.length) { ordem = S; return S.length; }
      const vistos = new Set(ordem); const j = S.findIndex((k) => vistos.has(k));
      if (j > 0) { ordem = S.slice(0, j).concat(ordem); return j; }
      if (j < 0) { ordem = S.concat(ordem); return S.length; }
      return 0;
    };
    // espera a conversa terminar de carregar: a quantidade de mensagens na tela para de mudar
    for (let i = 0, ultimo = -1, iguais = 0; i < 24; i++) {
      const n = pane.querySelectorAll('[role="row"]').length;
      if (n > 0 && n === ultimo) { if (++iguais >= 3) break; } else iguais = 0;
      ultimo = n;
      await sleep(500);
    }
    // botão "carregar mensagens mais antigas (do celular)": precisa de clique "de verdade" (eventos de ponteiro)
    const clicarMaisAntigas = () => {
      const b = [...pane.querySelectorAll('button, [role="button"], div')].find((e) => e.children.length < 4
        && /mensagens mais antigas|older messages/i.test(e.innerText || ''));
      if (!b) return false;
      const alvo = b.closest('button, [role="button"]') || b;
      for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        alvo.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    };
    pane.scrollTop = pane.scrollHeight; await sleep(800); snap();
    let parado = 0, cliques = 0;
    for (let p = 0; p < 50; p++) {
      // para quando já tem mensagens anteriores ao período (contexto suficiente)
      const antigas = ordem.map((k) => mapa.get(k)).filter((m) => m && !m.semData && dataDe(m.h) && !noPeriodo(dataDe(m.h), m.h.slice(0, 5))).length;
      if (antigas >= 8) break;
      const st = pane.scrollTop, h0 = pane.scrollHeight;
      pane.scrollTop = Math.max(0, st - pane.clientHeight * 0.6);
      await sleep(st === 0 ? 1500 : 450);
      const n = snap();
      if (!n && st === 0 && pane.scrollHeight === h0) {
        // chegou no topo sem novidade: tenta o botão das mensagens antigas (até 4x) antes de desistir
        if (cliques < 4 && clicarMaisAntigas()) { cliques++; parado = 0; await sleep(3000); snap(); continue; }
        // conversa curta (sem barra de rolagem) não dispara o "carregar mais": simula rolar para cima
        pane.scrollTop = 30; await sleep(150); pane.scrollTop = 0;
        pane.dispatchEvent(new WheelEvent('wheel', { deltaY: -800, bubbles: true, cancelable: true }));
        pane.dispatchEvent(new Event('scroll', { bubbles: true }));
        if (++parado >= 4) break;
        await sleep(1500);
      } else parado = 0;
    }
    // o cabeçalho pode começar pelas iniciais da foto ("P"): usa o texto todo do cabeçalho para conferir
    const cab = main.querySelector('header');
    const titulo = (cab?.querySelector('span[title]')?.getAttribute('title') || '') + ' ' + (cab?.innerText || '').replace(/\n/g, ' ').slice(0, 200);
    return { titulo, msgs: ordem.map((k) => mapa.get(k)).filter(Boolean) };
  }

  const conversas = [], feitosAgora = [];
  let restantes = false;
  for (const c of chats) {
    if (Date.now() > fimPrazo) { restantes = true; break; } // continua na próxima parte
    feitosAgora.push(c.ph || c.nm);
    try {
      await buscar(c.ph ? c.ph.replace(/^55/, '') : c.nm);
      const r = await lerAberta();
      if (!r) { conversas.push({ nome: c.nm, contato: c.ph, mensagens: [], aviso: 'conversa não abriu' }); continue; }
      const confere = (c.nm && r.titulo.toLowerCase().includes(c.nm.split(' ')[0].toLowerCase())) || (c.ph && r.titulo.replace(/\D/g, '').includes(c.ph.slice(-8)));
      // a busca não abriu a conversa certa: não mistura mensagens de outra pessoa
      if (!confere) { conversas.push({ nome: c.nm, contato: c.ph, mensagens: [], aviso: `não consegui abrir (abriu "${r.titulo}")` }); continue; }
      let ultimaData = '';
      const msgs = r.msgs.map((m) => {
        const d = dataDe(m.h); if (d) ultimaData = d;
        const hora = (m.h.match(/^(\d{1,2}:\d{2})/) || [])[1] || m.h;
        const eu = /Gamezeraofc/i.test(m.autor);
        return { data: d || ultimaData, hora, eu, autor: eu ? 'João' : (m.autor || c.nm), texto: (m.texto || '').slice(0, 1500) };
      });
      if (!msgs.some((m) => m.data && noPeriodo(m.data, m.hora))) continue; // nenhuma mensagem no período (ex.: só abriu)
      conversas.push({ nome: c.nm || r.titulo, contato: c.ph, mensagens: msgs.slice(-80) });
    } catch (e) {
      conversas.push({ nome: c.nm, contato: c.ph, mensagens: [], aviso: 'erro: ' + String(e).slice(0, 120) });
    }
    await sleep(1000 + Math.random() * 1000);
  }
  // limpa a busca
  try { setValor.call(box, ''); box.dispatchEvent(new Event('input', { bubbles: true })); } catch { /* ok */ }
  return { conversas, feitos: feitosAgora, restantes };
}

// ------------------------------------------------------------------ Instagram (Direct da loja)
// Lista: abas Primary/General/Pedidos; cada linha termina com "· 5 min" / "· 9h" / "· 3 d" / "· 2 sem".
// Na conversa o Instagram não mostra a hora de cada mensagem: vai só o lado (João/cliente) e o texto,
// e o rótulo da lista ("última atividade") diz quando foi a última.
async function extrairInstagram(desde, ignorar = []) {
  const normal = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const termos = (ignorar || []).map(normal).filter(Boolean);
  const ignorado = (nome) => termos.includes(normal(nome));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esperar = async (fn, ms = 20000) => { const fim = Date.now() + ms; while (Date.now() < fim) { const v = fn(); if (v) return v; await sleep(400); } return null; };
  // "5 min" → agora − 5 min; para "3 d"/"2 sem" considera o fim do intervalo (folga para não perder ninguém)
  const UN = { min: 60e3, h: 3600e3, d: 864e5, sem: 7 * 864e5 };
  const quando = (r) => {
    r = (r || '').trim().toLowerCase();
    if (r === 'agora') return Date.now();
    const m = r.match(/^(\d+)\s*(min|h|d|sem)$/);
    return m ? Date.now() - Number(m[1]) * UN[m[2]] : null;
  };
  const folga = (r) => { const m = (r || '').match(/(min|h|d|sem)$/); return m ? UN[m[1]] : 0; };
  const ehRotulo = (s) => /^(\d+\s*(min|h|d|sem)|agora)$/i.test((s || '').trim());

  const linhasLista = () => {
    const vistos = new Set(), lista = [];
    for (const el of document.querySelectorAll('div[role="button"], a[role="link"]')) {
      if (el.closest('[role=main]') && !el.closest('[role=navigation]')) continue;
      const t = (el.innerText || '').trim();
      if (!t || t.length > 300) continue;
      // tira o selo de status que aparece antes do nome ("Online", "Ativo agora"...)
      const l = t.split('\n').map((s) => s.trim()).filter((s) => s && s !== '·' && !/^(online|ativo agora|ativa agora|active now|ativo\(a\) h[aá].*)$/i.test(s));
      const rot = l[l.length - 1];
      if (l.length < 2 || !ehRotulo(rot) || vistos.has(l[0] + '|' + l[1])) continue;
      vistos.add(l[0] + '|' + l[1]);
      lista.push({ el, nome: l[0], ultima: l[1], rot });
    }
    return lista;
  };
  if (!await esperar(() => linhasLista().length || document.querySelector('[role=navigation]'), 30000)) {
    return { erro: 'inbox não carregou (Instagram deslogado?)', conversas: [] };
  }
  await sleep(2000);

  const conversas = [], feitos = new Set();
  const abas = ['Primary', 'Principal', 'General', 'Geral', 'Pedidos', 'Solicitações', 'Requests'];
  for (const nomeAba of abas) {
    const aba = [...document.querySelectorAll('[role=tab], div[role=button], a')].find((e) => (e.innerText || '').trim() === nomeAba);
    if (!aba) continue;
    aba.click();
    await sleep(2500);
    const alvos = linhasLista().filter((x) => {
      const q = quando(x.rot);
      return q !== null && q + folga(x.rot) >= desde && !ignorado(x.nome) && !feitos.has(x.nome + '|' + x.ultima);
    }).slice(0, 40);
    for (const x of alvos) {
      feitos.add(x.nome + '|' + x.ultima);
      try {
        const antes = location.pathname;
        x.el.click();
        await esperar(() => location.pathname !== antes && location.pathname.includes('/direct/t/'), 10000);
        // espera as mensagens desta conversa aparecerem
        const arts = await esperar(() => {
          const a = [...document.querySelectorAll('[role=article]')].filter((e) => !e.closest('[role=navigation]'));
          return a.length ? a : null;
        }, 12000);
        await sleep(2000);
        const lista = [...document.querySelectorAll('[role=article]')].filter((e) => !e.closest('[role=navigation]'));
        if (!arts || !lista.length) { conversas.push({ nome: x.nome, contato: location.href, rotulo: x.rot, aba: nomeAba, mensagens: [], aviso: 'conversa não abriu' }); continue; }
        // área da conversa = da borda direita da lista de conversas até o fim da janela (o meio separa João/cliente)
        const navLista = document.querySelector('[role=navigation][aria-label="Lista de tópicos"], [role=navigation][aria-label="Thread list"]');
        const pr = { left: navLista ? navLista.getBoundingClientRect().right : 0, right: window.innerWidth };
        const perfil = (document.querySelector('[role=main] a[aria-label*="perfil de"], [role=main] a[aria-label*="profile page of"]')?.getAttribute('aria-label') || '').split(' ').pop();
        const msgs = [];
        for (const a of lista) {
          let texto = (a.innerText || '').replace(/Ver transcrição/g, '').trim();
          if (/^\d+:\d{2}$/.test(texto) || a.querySelector('[aria-label*="audio" i], [aria-label*="áudio" i]')) texto = '[áudio]';
          else if (!texto && a.querySelector('img, video')) texto = '[foto/vídeo]';
          if (!texto) continue;
          const b = (a.querySelector('[role=presentation]') || a).getBoundingClientRect();
          const eu = (b.left + b.right) / 2 > (pr.left + pr.right) / 2;
          msgs.push({ data: '', hora: '', eu, autor: eu ? 'João' : x.nome, texto: texto.slice(0, 1500) });
        }
        conversas.push({ nome: x.nome, contato: location.href, perfil: perfil || '', rotulo: x.rot, aba: nomeAba, mensagens: msgs.slice(-60) });
      } catch (e) {
        conversas.push({ nome: x.nome, contato: '', mensagens: [], aviso: 'erro: ' + String(e).slice(0, 120) });
      }
      await sleep(1000);
    }
  }
  return { conversas, aviso: 'No Instagram não aparece a hora de cada mensagem: "última atividade" é o tempo desde a última mensagem da conversa.' };
}
