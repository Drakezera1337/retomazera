// Extratores do Retomazera Coletor. Cada função roda DENTRO da página (world MAIN) via
// chrome.scripting.executeScript, então precisa ser autossuficiente (nada de fora da função).
// Só leitura: abrem conversas e leem o que está na tela. Nunca digitam em caixa de mensagem.
// Recebem a data alvo 'AAAA-MM-DD' e devolvem { conversas: [...], aviso?, erro? }.
// Cada conversa: { nome, contato, anuncio?, rotulo, mensagens: [{ data, hora, eu, autor, texto }] }.

/* eslint-disable no-unused-vars */

// ------------------------------------------------------------------ OLX
async function extrairOlx(dataAlvo, ignorar = []) {
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
  const SEMANA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
  const [aa, mm, dd] = dataAlvo.split('-').map(Number);
  const alvo = new Date(aa, mm - 1, dd);
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const ehHoje = alvo.getTime() === hoje.getTime();
  const nomeDia = SEMANA[alvo.getDay()];
  const rotuloBate = (r) => {
    r = (r || '').trim().toLowerCase();
    if (/^\d{1,2}:\d{2}$/.test(r)) return true; // hoje (ou depois da meia-noite, se o alvo for ontem)
    if (ehHoje) return false;
    return r === 'ontem' || r.startsWith(nomeDia.slice(0, 3));
  };

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
    .filter((x) => rotuloBate(x.l[x.l.length - 1]))
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
      conversas.push({ nome: l[l.length - 3] || '', anuncio: l[l.length - 4] || '', contato: location.href, rotulo: l[l.length - 1], mensagens: msgs.slice(-80) });
    } catch (e) {
      conversas.push({ nome: l[l.length - 3] || '', contato: href, mensagens: [], aviso: 'erro: ' + String(e).slice(0, 120) });
    }
    await sleep(800);
  }
  return { conversas };
}

// ------------------------------------------------------------------ Facebook Marketplace
async function extrairFacebook(dataAlvo, ignorar = []) {
  // contatos pessoais que o João pediu para não coletar (nome exatamente igual ou telefone)
  const normal = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const termos = (ignorar || []).map(normal).filter(Boolean);
  const ignorado = (nome, fone) => {
    const n = normal(nome), f = String(fone || '').replace(/\D/g, '');
    return termos.some((t) => /^\d{8,}$/.test(t.replace(/ /g, '')) ? (f && f.endsWith(t.replace(/ /g, '').slice(-8))) : n === t);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esperar = async (fn, ms = 20000) => { const fim = Date.now() + ms; while (Date.now() < fim) { const v = fn(); if (v) return v; await sleep(400); } return null; };
  const SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  const [aa, mm, dd] = dataAlvo.split('-').map(Number);
  const alvo = new Date(aa, mm - 1, dd);
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const ehHoje = alvo.getTime() === hoje.getTime();
  const abrev = SEMANA[alvo.getDay()];
  const rotuloBate = (r) => {
    r = (r || '').trim().toLowerCase();
    if (/^\d{1,2}:\d{2}$/.test(r) || /^\d+\s*(min|h)$/.test(r)) return true;
    if (ehHoje) return false;
    return r === 'ontem' || r.startsWith(abrev);
  };
  const ehRotulo = (s) => /^\d{1,2}:\d{2}$/.test(s) || /^\d+\s*(min|h)$/.test(s) || /^(dom|seg|ter|qua|qui|sex|sáb|sab)\.?$/i.test(s) || /^ontem$/i.test(s) || /^\d{1,2} de [a-z]+\.?$/i.test(s) || /^\d{1,2}\/\d{1,2}/.test(s);

  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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

  const alvos = acharLinhas().filter((x) => rotuloBate(x.rot)).slice(0, 40);
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
      conversas.push({ nome: nome.trim(), anuncio: resto.join(' · '), contato: 'https://www.facebook.com/marketplace/inbox', rotulo: rot, mensagens: msgs.slice(-80) });
    } catch (e) {
      conversas.push({ nome, contato: 'https://www.facebook.com/marketplace/inbox', mensagens: [], aviso: 'erro: ' + String(e).slice(0, 120) });
    }
  }
  document.querySelector('[aria-label="Fechar conversa"]')?.click();
  return { conversas };
}

// ------------------------------------------------------------------ WhatsApp Web
// A lista de conversas do dia vem de WAWebCollections.Chat (só leitura de dados já carregados —
// NÃO usa funções que carregam mensagens). As mensagens são lidas da tela, rolando o painel.
async function extrairWhatsapp(dataAlvo, ignorar = [], limite = 60) {
  // contatos pessoais que o João pediu para não coletar (nome exatamente igual ou telefone)
  const normal = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const termos = (ignorar || []).map(normal).filter(Boolean);
  const ignorado = (nome, fone) => {
    const n = normal(nome), f = String(fone || '').replace(/\D/g, '');
    return termos.some((t) => /^\d{8,}$/.test(t.replace(/ /g, '')) ? (f && f.endsWith(t.replace(/ /g, '').slice(-8))) : n === t);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esperar = async (fn, ms = 20000) => { const fim = Date.now() + ms; while (Date.now() < fim) { const v = fn(); if (v) return v; await sleep(500); } return null; };
  const [aa, mm, dd] = dataAlvo.split('-').map(Number);
  const ini = new Date(aa, mm - 1, dd).getTime() / 1000;
  const fim = ini + 86400;

  const pronto = await esperar(() => document.querySelector('#pane-side') && window.require && (() => { try { return window.require('WAWebCollections').Chat.getModelsArray().length > 0; } catch { return false; } })(), 90000);
  if (!pronto) return { erro: document.querySelector('canvas') ? 'WhatsApp Web deslogado (pede QR)' : 'WhatsApp Web não carregou', conversas: [] };
  await sleep(5000); // termina de sincronizar

  const C = window.require('WAWebCollections');
  const chats = C.Chat.getModelsArray()
    .filter((c) => c.id.server !== 'g.us' && c.id.server !== 'newsletter' && c.id.server !== 'broadcast' && (c.t || 0) >= ini)
    .map((c) => {
      const ph = c.id.server === 'c.us' ? c.id.user : (c.contact && c.contact.phoneNumber && c.contact.phoneNumber.user) || '';
      return { ph, nm: (c.contact && (c.contact.name || c.contact.pushname)) || c.formattedTitle || '', t: c.t, empresa: !!(c.contact && c.contact.isEnterprise) };
    })
    .filter((c) => !c.empresa && !ignorado(c.nm, c.ph))
    .sort((a, b) => b.t - a.t)
    .slice(0, limite);

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
    pane.scrollTop = pane.scrollHeight; await sleep(800); snap();
    let parado = 0;
    for (let p = 0; p < 40; p++) {
      // para quando já tem mensagens anteriores ao dia alvo (contexto suficiente)
      const antigas = ordem.map((k) => mapa.get(k)).filter((m) => m && !m.semData && dataDe(m.h) && dataDe(m.h) < dataAlvo).length;
      if (antigas >= 8) break;
      const st = pane.scrollTop, h0 = pane.scrollHeight;
      pane.scrollTop = Math.max(0, st - pane.clientHeight * 0.6);
      await sleep(st === 0 ? 1500 : 450);
      const n = snap();
      if (!n && st === 0 && pane.scrollHeight === h0) { if (++parado >= 3) break; } else parado = 0;
    }
    // o cabeçalho pode começar pelas iniciais da foto ("P"): usa o texto todo do cabeçalho para conferir
    const cab = main.querySelector('header');
    const titulo = (cab?.querySelector('span[title]')?.getAttribute('title') || '') + ' ' + (cab?.innerText || '').replace(/\n/g, ' ').slice(0, 200);
    return { titulo, msgs: ordem.map((k) => mapa.get(k)).filter(Boolean) };
  }

  const conversas = [];
  for (const c of chats) {
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
      const doDia = msgs.filter((m) => m.data === dataAlvo).length;
      if (!doDia && confere) continue; // última atividade não era mensagem do dia (ex.: só abriu)
      conversas.push({ nome: c.nm || r.titulo, contato: c.ph, mensagens: msgs.slice(-80), ...(confere ? {} : { aviso: `título aberto "${r.titulo}" não confere` }) });
    } catch (e) {
      conversas.push({ nome: c.nm, contato: c.ph, mensagens: [], aviso: 'erro: ' + String(e).slice(0, 120) });
    }
    await sleep(1000 + Math.random() * 1000);
  }
  // limpa a busca
  try { setValor.call(box, ''); box.dispatchEvent(new Event('input', { bubbles: true })); } catch { /* ok */ }
  void fim;
  return { conversas };
}
