// Retomazera Coletor — uma vez por dia, alguns minutos depois que o PC/Chrome é ligado (a partir das
// 06:00), abre os sites marcados NESTE perfil do Chrome, copia as mensagens desde a coleta automática
// anterior (madrugada incluída) e manda ao server.py do Retomazera (127.0.0.1:8797/api/coleta), que
// salva em coletas/AAAA-MM-DD/<fonte>.json e chama o Claude. Depois, rondas de 2 em 2 h (8h–22h) e a da noite.
// Só leitura: nada é enviado nos sites.
importScripts('extratores.js');

const SERVIDOR = 'http://127.0.0.1:8797';
const FONTES = {
  whatsapp: { nome: 'WhatsApp', url: 'https://web.whatsapp.com/', padrao: 'https://web.whatsapp.com/*', func: extrairWhatsapp },
  facebook: { nome: 'Facebook', url: 'https://www.facebook.com/marketplace/inbox', padrao: null, func: extrairFacebook },
  olx: { nome: 'OLX', url: 'https://chat.olx.com.br/', padrao: null, func: extrairOlx },
  instagram: { nome: 'Instagram', url: 'https://www.instagram.com/direct/inbox/', padrao: null, func: extrairInstagram },
};
const PADRAO = { fontes: { whatsapp: false, facebook: false, olx: false, instagram: false }, horaMin: 6, espera: 3, perfil: '',
  noite: true, horaNoite: 21, avisos: true, ronda: true,
  ignorar: ['Pai - Pessoal', 'Mãe', 'Amor', 'Santo Burger', 'Lucian'] };

async function config() {
  const { cfg } = await chrome.storage.local.get('cfg');
  return { ...PADRAO, ...(cfg || {}), fontes: { ...PADRAO.fontes, ...((cfg || {}).fontes || {}) } };
}

// Rondas: coleta rápida (só o que é novo) nos horários pares das 8h às 22h, depois da coleta inicial do dia.
// Horário fixo para os dois perfis do Chrome caírem na mesma ronda (o servidor junta por hora).
const RONDAS = [8, 10, 12, 14, 16, 18, 20, 22];

// ---- quando coletar: 1x por dia, na primeira oportunidade a partir de horaMin, esperando 'espera'
// minutos depois que o Chrome abriu (dá tempo de o WhatsApp e os sites carregarem).
async function inicioNavegador() {
  const { abriuEm } = await chrome.storage.session.get('abriuEm'); // some quando o Chrome fecha
  if (abriuEm) return abriuEm;
  const agora = Date.now();
  await chrome.storage.session.set({ abriuEm: agora });
  return agora;
}
async function verificar() {
  const c = await config();
  if (!Object.values(c.fontes).some(Boolean) || rodando) return;
  const agora = new Date();
  if (agora.getHours() < (c.horaMin ?? 6)) return;
  const { auto, autoNoite } = await chrome.storage.local.get(['auto', 'autoNoite']);
  const a = auto || {};
  // coleta da NOITE (preparar as vendas de amanhã): 1x por dia, a partir de horaNoite, se a da manhã já foi feita
  const n = autoNoite || {};
  if (c.noite && agora.getHours() >= (c.horaNoite ?? 21) && a.dia === hojeIso() && a.ok
      && !(n.dia === hojeIso() && (n.ok || (n.tentativas || 0) >= 2))
      && !(n.dia === hojeIso() && n.ultimaTentativa && Date.now() - n.ultimaTentativa < 20 * 60000)) {
    return coletar('noite');
  }
  if (a.dia === hojeIso() && (a.ok || (a.tentativas || 0) >= 3)) { // já coletou hoje (ou desistiu): rondas
    if (!a.ok || c.ronda === false) return;
    const h = agora.getHours();
    const slot = RONDAS.filter((x) => x <= h).pop();
    if (slot == null || h - slot >= 2 || h >= (c.horaNoite ?? 23)) return;
    const inicioSlot = new Date(agora); inicioSlot.setHours(slot, 0, 0, 0);
    if ((a.feitaEm || 0) > inicioSlot.getTime() - 45 * 60000) return; // a coleta inicial acabou de cobrir
    const { autoRonda } = await chrome.storage.local.get('autoRonda');
    const r = (autoRonda && autoRonda.dia === hojeIso() && autoRonda.slots) || {};
    const s = r[slot] || {};
    if (s.ok || (s.tentativas || 0) >= 2 || (s.ultimaTentativa && Date.now() - s.ultimaTentativa < 20 * 60000)) return;
    return coletar('ronda', String(slot).padStart(2, '0'));
  }
  if (Date.now() - (await inicioNavegador()) < (c.espera ?? 3) * 60000) return;
  if (a.dia === hojeIso() && a.ultimaTentativa && Date.now() - a.ultimaTentativa < 20 * 60000) return;
  coletar('auto');
}
async function destravar() {
  const { est } = await chrome.storage.local.get('est');
  if (est && est.rodando && !rodando && Date.now() - (est.inicio || 0) > 15 * 60000) {
    await chrome.storage.local.set({ est: { ...est, rodando: false, atual: '', fim: Date.now(), interrompida: true } });
  }
}
async function iniciar() {
  await destravar();
  await chrome.alarms.clear('coleta'); // alarme antigo (horário fixo)
  chrome.alarms.create('verificar', { delayInMinutes: 1, periodInMinutes: 1 });
}
chrome.runtime.onInstalled.addListener(iniciar);
chrome.runtime.onStartup.addListener(async () => { await chrome.storage.session.set({ abriuEm: Date.now() }); iniciar(); });
chrome.alarms.onAlarm.addListener((al) => { if (al.name === 'verificar') verificar(); });

// Pasta da coleta = dia em que ela roda
function hojeIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// Início do período de cada fonte: fim da última coleta AUTOMÁTICA que deu certo (as manuais não
// mexem nisso). Na primeira vez: a última coleta feita (ou meia-noite de ontem). Nunca mais que 7 dias para trás.
async function desdeDe(k, inicioAnterior) {
  const { ultimas } = await chrome.storage.local.get('ultimas');
  const ontem = new Date(); ontem.setDate(ontem.getDate() - 1); ontem.setHours(0, 0, 0, 0);
  // primeira automática: continua de onde a última coleta (mesmo manual) parou
  const v = (ultimas || {})[k] || inicioAnterior || ontem.getTime();
  return Math.max(v, Date.now() - 7 * 864e5);
}
// Ronda: desde a última ronda que deu certo HOJE nessa fonte (ou desde a coleta inicial do dia)
async function desdeRonda(k) {
  const { ultimas, ultimasRonda } = await chrome.storage.local.get(['ultimas', 'ultimasRonda']);
  const r = ultimasRonda && ultimasRonda.dia === hojeIso() ? ultimasRonda : {};
  return Math.max(r[k] || 0, (ultimas || {})[k] || 0, Date.now() - 6 * 3600000);
}
async function marcarUltimaRonda(k, ms) {
  const { ultimasRonda } = await chrome.storage.local.get('ultimasRonda');
  const r = ultimasRonda && ultimasRonda.dia === hojeIso() ? ultimasRonda : { dia: hojeIso() };
  await chrome.storage.local.set({ ultimasRonda: { ...r, [k]: ms } });
}
async function marcarUltima(k, ms) {
  const { ultimas } = await chrome.storage.local.get('ultimas');
  await chrome.storage.local.set({ ultimas: { ...(ultimas || {}), [k]: ms } });
}

async function estado(mud) {
  const { est } = await chrome.storage.local.get('est');
  const novo = { ...(est || {}), ...mud };
  await chrome.storage.local.set({ est: novo });
  chrome.runtime.sendMessage({ tipo: 'estado', est: novo }).catch(() => {});
  return novo;
}

function esperarCarregar(tabId, ms = 60000) {
  return new Promise((ok) => {
    const fim = setTimeout(() => { chrome.tabs.onUpdated.removeListener(l); ok(); }, ms);
    function l(id, info) { if (id === tabId && info.status === 'complete') { clearTimeout(fim); chrome.tabs.onUpdated.removeListener(l); ok(); } }
    chrome.tabs.onUpdated.addListener(l);
  });
}

// Notificação do Windows com o progresso: uma só (mesmo id), recriada a cada mudança para aparecer de novo.
const ICONE = { aguardando: '⏸️', coletando: '⏳', ok: '✅', erro: '❌' };
async function avisarProgresso(c, origem, prog, fim, rodada) {
  if (c.avisos === false) return;
  if (origem === 'ronda' && !fim) return; // ronda: só um aviso discreto no fim
  const turno = origem === 'noite' ? 'da noite' : origem === 'manual' ? 'manual' : origem === 'ronda' ? `ronda das ${Number(rodada)}h` : 'da manhã';
  const linhas = Object.entries(prog).map(([k, p]) => `${FONTES[k].nome} ${ICONE[p.estado]} ${p.estado === 'ok' ? `OK (${p.n} conversa${p.n === 1 ? '' : 's'})` : p.estado === 'erro' ? `erro: ${p.msg}` : p.estado}`);
  const titulo = fim
    ? `Retomazera: coleta ${turno} concluída${c.perfil ? ` · ${c.perfil}` : ''}`
    : `Retomazera: coletando ${turno}${c.perfil ? ` · ${c.perfil}` : ''}`;
  const opcoes = { type: 'basic', iconUrl: 'icon.png', title: titulo, message: linhas.join('\n').slice(0, 500),
    priority: origem === 'ronda' ? 0 : 1, silent: !fim || origem === 'ronda', requireInteraction: false };
  if (fim) opcoes.contextMessage = 'A análise roda no PC e o resumo chega no celular em alguns minutos.';
  try {
    await chrome.notifications.clear('rz-coleta');
    await chrome.notifications.create('rz-coleta', opcoes);
  } catch { /* sem permissão de notificação: segue sem aviso */ }
}

// Coleta em segundo plano: janela própria aberta SEM foco (não rouba a tela). Se o WhatsApp já estiver
// aberto numa aba, ela é movida para essa janela durante a coleta e volta para o lugar depois.
async function janelaDeFundo() {
  return chrome.windows.create({ url: 'about:blank', focused: false, state: 'normal', width: 1280, height: 900 });
}
async function devolverAba(d) {
  if (!d) return;
  try {
    const existe = await chrome.windows.get(d.windowId).catch(() => null);
    if (existe) {
      await chrome.tabs.move(d.tabId, { windowId: d.windowId, index: d.index });
      if (d.active) await chrome.tabs.update(d.tabId, { active: true });
    } else {
      await chrome.windows.create({ tabId: d.tabId, focused: false });
    }
  } catch { /* aba fechada no meio: segue */ }
}

let rodando = false;
async function coletar(origem, rodada = '') {
  if (rodando) return;
  rodando = true;
  // mantém a extensão acordada durante a coleta (o Chrome encerra o service worker parado por 30 s)
  const vivo = setInterval(() => { chrome.runtime.getPlatformInfo(() => {}); }, 20000);
  const c = await config();
  // coleta da noite feita depois da meia-noite (até 6h) vale para o dia anterior
  const madrugada = origem === 'noite' && new Date().getHours() < 6;
  const data = madrugada ? (() => { const d = new Date(); d.setDate(d.getDate() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })() : hojeIso();
  const { est: anterior } = await chrome.storage.local.get('est'); // antes de sobrescrever o estado
  const inicioAnterior = anterior && !anterior.rodando ? anterior.inicio : null;
  const ativas = Object.keys(FONTES).filter((k) => c.fontes[k]);
  await estado({ rodando: true, inicio: Date.now(), data, origem, fontes: {} });
  const prog = Object.fromEntries(ativas.map((k) => [k, { estado: 'aguardando' }]));
  let janela = null, algumaOk = false;
  try {
    for (const k of ativas) {
      const f = FONTES[k];
      await estado({ atual: f.nome });
      prog[k] = { estado: 'coletando' };
      await avisarProgresso(c, origem, prog, false);
      let tabId = null, abriuAqui = false, devolver = null;
      try {
        // WhatsApp Web só funciona numa aba: reaproveita a que já estiver aberta
        const existentes = f.padrao ? await chrome.tabs.query({ url: f.padrao }) : [];
        if (!janela) janela = await janelaDeFundo();
        if (existentes.length) {
          const t = existentes[0];
          tabId = t.id;
          if (t.windowId !== janela.id) {
            devolver = { tabId: t.id, windowId: t.windowId, index: t.index, active: t.active };
            await chrome.tabs.move(t.id, { windowId: janela.id, index: -1 });
          }
          await chrome.tabs.update(tabId, { active: true });
        } else {
          tabId = (await chrome.tabs.create({ windowId: janela.id, url: f.url, active: true })).id;
          abriuAqui = true;
          await esperarCarregar(tabId);
        }
        await new Promise((r) => setTimeout(r, 3000));
        // noite: só as conversas de hoje (não mexe no ponto de partida da coleta da manhã)
        const [aa, mm, dd] = data.split('-').map(Number);
        const meiaNoite = new Date(aa, mm - 1, dd);
        const desde = origem === 'noite' ? meiaNoite.getTime() : origem === 'ronda' ? await desdeRonda(k) : await desdeDe(k, inicioAnterior);
        const inicioFonte = Date.now();
        let r;
        if (k === 'whatsapp') {
          // em partes de até 3 min (cada chamada bem abaixo do limite de ~5 min do Chrome)
          const todas = []; let feitos = [];
          for (let parte = 0; parte < 8; parte++) {
            const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: f.func,
              args: [desde, c.ignorar || [], 60, { primeira: parte === 0, feitos, prazoMs: 180000 }] });
            const p = (res && res.result) || { erro: 'sem resposta do extrator', conversas: [] };
            if (p.erro) { r = p; break; }
            todas.push(...(p.conversas || []));
            feitos = feitos.concat(p.feitos || []);
            r = { ...p, conversas: todas };
            if (!p.restantes) break;
            prog[k] = { estado: 'coletando' };
            await avisarProgresso(c, origem, { ...prog, [k]: { estado: 'coletando' } }, false);
          }
        } else {
          const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: f.func, args: [desde, c.ignorar || []] });
          r = (res && res.result) || { erro: 'sem resposta do extrator', conversas: [] };
        }
        r = r || { erro: 'sem resposta do extrator', conversas: [] };
        delete r.feitos; delete r.restantes;
        const corpo = { fonte: k, data, perfil: c.perfil, lote: ativas, turno: origem === 'noite' ? 'noite' : origem === 'ronda' ? 'ronda' : '', rodada, desde, ate: inicioFonte, coletadoEm: Date.now(), ...r };
        const resp = await fetch(`${SERVIDOR}/api/coleta`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
        const j = await resp.json().catch(() => ({}));
        const n = (r.conversas || []).length;
        prog[k] = r.erro || !j.ok ? { estado: 'erro', msg: String(r.erro || j.erro || resp.status).slice(0, 60) } : { estado: 'ok', n };
        if (j.ok && !r.erro && origem === 'auto') { await marcarUltima(k, inicioFonte); algumaOk = true; }
        if (j.ok && !r.erro && origem === 'noite') algumaOk = true;
        if (j.ok && !r.erro && origem === 'ronda') { await marcarUltimaRonda(k, inicioFonte); algumaOk = true; }
        await estado({ fontes: { ...((await chrome.storage.local.get('est')).est.fontes || {}), [k]: r.erro ? `erro: ${r.erro}` : (j.ok ? `${n} conversa(s)` : `servidor: ${j.erro || resp.status}`) } });
      } catch (e) {
        prog[k] = { estado: 'erro', msg: String(e.message || e).slice(0, 60) };
        await estado({ fontes: { ...((await chrome.storage.local.get('est')).est.fontes || {}), [k]: `erro: ${String(e.message || e).slice(0, 150)}` } });
      } finally {
        await devolverAba(devolver);
        if (abriuAqui && tabId && janela && (await chrome.tabs.query({ windowId: janela.id })).length > 1) {
          await chrome.tabs.remove(tabId).catch(() => {});
        }
      }
    }
  } finally {
    if (janela) await chrome.windows.remove(janela.id).catch(() => {});
    if (ativas.length) await avisarProgresso(c, origem, prog, true, rodada);
    if (origem === 'ronda') {
      const { autoRonda } = await chrome.storage.local.get('autoRonda');
      const r = autoRonda && autoRonda.dia === data ? autoRonda : { dia: data, slots: {} };
      const s = r.slots[Number(rodada)] || { tentativas: 0 };
      r.slots[Number(rodada)] = { ok: s.ok || algumaOk, tentativas: (s.tentativas || 0) + 1, ultimaTentativa: Date.now() };
      if (algumaOk) r.feitaEm = Date.now();
      await chrome.storage.local.set({ autoRonda: r });
    }
    if (origem === 'auto' || origem === 'noite') {
      const chave = origem === 'noite' ? 'autoNoite' : 'auto';
      const { [chave]: ant } = await chrome.storage.local.get(chave);
      const a = ant && ant.dia === data ? ant : { dia: data, tentativas: 0 };
      await chrome.storage.local.set({ [chave]: { dia: data, ok: a.ok || algumaOk, tentativas: (a.tentativas || 0) + 1, ultimaTentativa: Date.now(), feitaEm: algumaOk ? Date.now() : a.feitaEm } });
    }
    clearInterval(vivo);
    rodando = false;
    await estado({ rodando: false, atual: '', fim: Date.now() });
  }
}

chrome.notifications.onClicked.addListener((id) => {
  if (id === 'rz-coleta') { chrome.tabs.create({ url: `${SERVIDOR}/` }); chrome.notifications.clear(id); }
});

chrome.runtime.onMessage.addListener((msg, _s, responder) => {
  if (msg.tipo === 'coletar') {
    if (msg.turno === 'ronda') { const h = new Date().getHours(); coletar('ronda', String(RONDAS.filter((x) => x <= h).pop() ?? 8).padStart(2, '0')); }
    else coletar(msg.turno === 'noite' ? 'noite' : 'manual');
    responder({ ok: true });
  }
  if (msg.tipo === 'salvar') {
    chrome.storage.local.set({ cfg: msg.cfg }).then(iniciar).then(() => responder({ ok: true }));
    return true;
  }
  if (msg.tipo === 'info') {
    Promise.all([config(), chrome.storage.local.get(['est', 'auto', 'autoNoite', 'autoRonda'])])
      .then(([cfg, { est, auto, autoNoite, autoRonda }]) => responder({ cfg, est: est || {}, auto: auto || {}, autoNoite: autoNoite || {}, autoRonda: autoRonda || {}, hoje: hojeIso() }));
    return true;
  }
  return false;
});
