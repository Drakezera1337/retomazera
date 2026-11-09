// Retomazera Coletor — todo dia (padrão 23:55) abre os sites marcados NESTE perfil do Chrome,
// copia as mensagens do dia e manda ao server.py do Retomazera (127.0.0.1:8797/api/coleta),
// que salva em coletas/AAAA-MM-DD/<fonte>.json. Depois a tarefa do Claude só lê esses arquivos.
// Só leitura: nada é enviado nos sites.
importScripts('extratores.js');

const SERVIDOR = 'http://127.0.0.1:8797';
const FONTES = {
  whatsapp: { nome: 'WhatsApp', url: 'https://web.whatsapp.com/', padrao: 'https://web.whatsapp.com/*', func: extrairWhatsapp },
  facebook: { nome: 'Facebook', url: 'https://www.facebook.com/marketplace/inbox', padrao: null, func: extrairFacebook },
  olx: { nome: 'OLX', url: 'https://chat.olx.com.br/', padrao: null, func: extrairOlx },
};
const PADRAO = { fontes: { whatsapp: false, facebook: false, olx: false }, hora: '23:55', perfil: '' };

async function config() {
  const { cfg } = await chrome.storage.local.get('cfg');
  return { ...PADRAO, ...(cfg || {}), fontes: { ...PADRAO.fontes, ...((cfg || {}).fontes || {}) } };
}

function proximaVez(hora) {
  const [h, m] = hora.split(':').map(Number);
  const d = new Date(); d.setSeconds(0, 0); d.setHours(h, m);
  if (d.getTime() <= Date.now() + 30000) d.setDate(d.getDate() + 1);
  return d.getTime();
}
async function agendar() {
  const c = await config();
  await chrome.alarms.clear('coleta');
  chrome.alarms.create('coleta', { when: proximaVez(c.hora), periodInMinutes: 1440 });
}
chrome.runtime.onInstalled.addListener(agendar);
chrome.runtime.onStartup.addListener(agendar);
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'coleta') coletar('alarme'); });

// Data alvo: até 06:00 conta como o dia anterior (coleta atrasada por PC/Chrome desligado)
function dataAlvo() {
  const d = new Date();
  if (d.getHours() < 6) d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
  const data = dataAlvo();
  const ativas = Object.keys(FONTES).filter((k) => c.fontes[k]);
  await estado({ rodando: true, inicio: Date.now(), data, origem, fontes: {} });
  let janela = null;
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
        const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: f.func, args: [data] });
        const r = (res && res.result) || { erro: 'sem resposta do extrator', conversas: [] };
        const corpo = { fonte: k, data, perfil: c.perfil, coletadoEm: Date.now(), ...r };
        const resp = await fetch(`${SERVIDOR}/api/coleta`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
        const j = await resp.json().catch(() => ({}));
        const n = (r.conversas || []).length;
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
    rodando = false;
    await estado({ rodando: false, atual: '', fim: Date.now() });
  }
}

chrome.runtime.onMessage.addListener((msg, _s, responder) => {
  if (msg.tipo === 'coletar') { coletar('manual'); responder({ ok: true }); }
  if (msg.tipo === 'salvar') {
    chrome.storage.local.set({ cfg: msg.cfg }).then(agendar).then(() => responder({ ok: true }));
    return true;
  }
  if (msg.tipo === 'info') {
    Promise.all([config(), chrome.storage.local.get('est'), chrome.alarms.get('coleta')])
      .then(([cfg, { est }, alarme]) => responder({ cfg, est: est || {}, proxima: alarme ? alarme.scheduledTime : null }));
    return true;
  }
  return false;
});
