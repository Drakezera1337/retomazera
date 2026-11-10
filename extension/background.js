// Retomazera Coletor — uma vez por dia, alguns minutos depois que o PC/Chrome é ligado (a partir das
// 06:00), abre os sites marcados NESTE perfil do Chrome, copia as mensagens desde a coleta automática
// anterior (madrugada incluída) e manda ao server.py do Retomazera (127.0.0.1:8797/api/coleta), que
// salva em coletas/AAAA-MM-DD/<fonte>.json. A tarefa do Claude confere a cada 30 min e analisa.
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
  noite: true, horaNoite: 21,
  ignorar: ['Pai - Pessoal', 'Mãe', 'Amor', 'Santo Burger', 'Lucian'] };

async function config() {
  const { cfg } = await chrome.storage.local.get('cfg');
  return { ...PADRAO, ...(cfg || {}), fontes: { ...PADRAO.fontes, ...((cfg || {}).fontes || {}) } };
}

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
  if (a.dia === hojeIso() && (a.ok || (a.tentativas || 0) >= 3)) return; // já coletou hoje (ou desistiu)
  if (Date.now() - (await inicioNavegador()) < (c.espera ?? 3) * 60000) return;
  if (a.dia === hojeIso() && a.ultimaTentativa && Date.now() - a.ultimaTentativa < 20 * 60000) return;
  coletar('auto');
}
async function iniciar() {
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

let rodando = false;
async function coletar(origem) {
  if (rodando) return;
  rodando = true;
  const c = await config();
  const data = hojeIso();
  const { est: anterior } = await chrome.storage.local.get('est'); // antes de sobrescrever o estado
  const inicioAnterior = anterior && !anterior.rodando ? anterior.inicio : null;
  const ativas = Object.keys(FONTES).filter((k) => c.fontes[k]);
  await estado({ rodando: true, inicio: Date.now(), data, origem, fontes: {} });
  let janela = null, algumaOk = false;
  try {
    for (const k of ativas) {
      const f = FONTES[k];
      await estado({ atual: f.nome });
      let tabId = null, abriuAqui = false;
      try {
        // WhatsApp Web só funciona numa aba: reaproveita a que já estiver aberta
        const existentes = f.padrao ? await chrome.tabs.query({ url: f.padrao }) : [];
        if (existentes.length) {
          tabId = existentes[0].id;
          await chrome.tabs.update(tabId, { active: true });
          await chrome.windows.update(existentes[0].windowId, { focused: true });
        } else {
          if (!janela) {
            janela = await chrome.windows.create({ url: f.url, focused: true, width: 1280, height: 900 });
            tabId = janela.tabs[0].id;
          } else {
            tabId = (await chrome.tabs.create({ windowId: janela.id, url: f.url, active: true })).id;
          }
          abriuAqui = true;
          await esperarCarregar(tabId);
        }
        await new Promise((r) => setTimeout(r, 3000));
        // noite: só as conversas de hoje (não mexe no ponto de partida da coleta da manhã)
        const meiaNoite = new Date(); meiaNoite.setHours(0, 0, 0, 0);
        const desde = origem === 'noite' ? meiaNoite.getTime() : await desdeDe(k, inicioAnterior);
        const inicioFonte = Date.now();
        const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: f.func, args: [desde, c.ignorar || []] });
        const r = (res && res.result) || { erro: 'sem resposta do extrator', conversas: [] };
        const corpo = { fonte: k, data, perfil: c.perfil, lote: ativas, turno: origem === 'noite' ? 'noite' : '', desde, ate: inicioFonte, coletadoEm: Date.now(), ...r };
        const resp = await fetch(`${SERVIDOR}/api/coleta`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
        const j = await resp.json().catch(() => ({}));
        const n = (r.conversas || []).length;
        if (j.ok && !r.erro && origem === 'auto') { await marcarUltima(k, inicioFonte); algumaOk = true; }
        if (j.ok && !r.erro && origem === 'noite') algumaOk = true;
        await estado({ fontes: { ...((await chrome.storage.local.get('est')).est.fontes || {}), [k]: r.erro ? `erro: ${r.erro}` : (j.ok ? `${n} conversa(s)` : `servidor: ${j.erro || resp.status}`) } });
      } catch (e) {
        await estado({ fontes: { ...((await chrome.storage.local.get('est')).est.fontes || {}), [k]: `erro: ${String(e.message || e).slice(0, 150)}` } });
      } finally {
        if (abriuAqui && tabId && janela && (await chrome.tabs.query({ windowId: janela.id })).length > 1) {
          await chrome.tabs.remove(tabId).catch(() => {});
        }
      }
    }
  } finally {
    if (janela) await chrome.windows.remove(janela.id).catch(() => {});
    if (origem === 'auto' || origem === 'noite') {
      const chave = origem === 'noite' ? 'autoNoite' : 'auto';
      const { [chave]: ant } = await chrome.storage.local.get(chave);
      const a = ant && ant.dia === data ? ant : { dia: data, tentativas: 0 };
      await chrome.storage.local.set({ [chave]: { dia: data, ok: a.ok || algumaOk, tentativas: (a.tentativas || 0) + 1, ultimaTentativa: Date.now(), feitaEm: algumaOk ? Date.now() : a.feitaEm } });
    }
    rodando = false;
    await estado({ rodando: false, atual: '', fim: Date.now() });
  }
}

chrome.runtime.onMessage.addListener((msg, _s, responder) => {
  if (msg.tipo === 'coletar') { coletar(msg.turno === 'noite' ? 'noite' : 'manual'); responder({ ok: true }); }
  if (msg.tipo === 'salvar') {
    chrome.storage.local.set({ cfg: msg.cfg }).then(iniciar).then(() => responder({ ok: true }));
    return true;
  }
  if (msg.tipo === 'info') {
    Promise.all([config(), chrome.storage.local.get(['est', 'auto', 'autoNoite'])])
      .then(([cfg, { est, auto, autoNoite }]) => responder({ cfg, est: est || {}, auto: auto || {}, autoNoite: autoNoite || {}, hoje: hojeIso() }));
    return true;
  }
  return false;
});
