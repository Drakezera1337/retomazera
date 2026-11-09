// Retomazera — quem chamar de novo hoje para fechar venda.
// No PC (localhost) fala com o server.py; no celular (GitHub Pages) lê o Gist secreto.
const NO_PC = ['localhost', '127.0.0.1'].includes(location.hostname);
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const K = { cache: 'retomazera:cache', feitos: 'retomazera:feitos', push: 'retomazera:push' };
const lerJSON = (k, p) => { try { return JSON.parse(localStorage.getItem(k)) ?? p; } catch { return p; } };
const gravarJSON = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem storage */ } };

const S = { dias: [], ts: 0, status: null, carregando: false, erro: '' };

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 3500);
}
async function api(rota, { method = 'GET', body } = {}) {
  const r = await fetch(`/api/${rota}`, { method, cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}
function dataBR(iso, comSemana = true) {
  if (!iso) return '';
  const [a, m, d] = iso.split('-').map(Number);
  const dt = new Date(a, m - 1, d);
  const s = dt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  return comSemana ? `${dt.toLocaleDateString('pt-BR', { weekday: 'long' })}, ${s}` : s;
}
function ago(ms) {
  if (!ms) return '';
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return 'agora'; if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60); if (h < 24) return `há ${h} h`;
  return `há ${Math.round(h / 24)} dia(s)`;
}

// ---------------------------------------------------------------- dados
async function carregar() {
  S.carregando = true; S.erro = '';
  try {
    if (NO_PC) {
      const r = await api('lembretes');
      S.dias = r.dias || []; S.ts = r.ts;
      S.status = await api('status');
    } else if (Sync.enabled()) {
      const { 'lembretes.json': l } = await Sync.ler({ 'lembretes.json': { dias: [] } });
      S.dias = l.dias || []; S.ts = l.ts || 0;
      gravarJSON(K.cache, { dias: S.dias, ts: S.ts });
    }
  } catch (err) {
    S.erro = err.message || String(err);
  }
  S.carregando = false;
  rotear();
}

// ---------------------------------------------------------------- feitos (marcados neste aparelho)
const feitos = () => lerJSON(K.feitos, {});
function alternarFeito(id) {
  const f = feitos();
  if (f[id]) delete f[id]; else f[id] = Date.now();
  // guarda só os últimos 30 dias
  const limite = Date.now() - 30 * 864e5;
  for (const [k, v] of Object.entries(f)) if (v < limite) delete f[k];
  gravarJSON(K.feitos, f);
  rotear();
}

// ---------------------------------------------------------------- telas
const CANAIS = { whatsapp: ['wpp', 'WhatsApp'], facebook: ['fb', 'Facebook'], olx: ['olx', 'OLX'] };
const PRIOR = { alta: 'Alta', media: 'Média', média: 'Média', baixa: 'Baixa' };

function linkConversa(x) {
  const canal = (x.canal || '').toLowerCase();
  const contato = x.contato || '';
  if (canal === 'whatsapp') {
    const dig = contato.replace(/\D/g, '');
    if (dig.length >= 10) {
      const num = dig.length <= 11 ? '55' + dig : dig;
      return `https://wa.me/${num}${x.mensagem ? `?text=${encodeURIComponent(x.mensagem)}` : ''}`;
    }
  }
  if (/^https:\/\//.test(contato)) return contato;
  if (canal === 'olx') return 'https://www.olx.com.br/chat';
  if (canal === 'facebook') return 'https://www.facebook.com/messages';
  return '';
}

function cartao(x) {
  const [cls, nomeCanal] = CANAIS[(x.canal || '').toLowerCase()] || ['', x.canal || '—'];
  const p = (x.prioridade || 'media').toLowerCase().replace('é', 'e');
  const feito = Boolean(feitos()[x.id]);
  const link = linkConversa(x);
  return `<div class="item ${p} ${feito ? 'feito' : ''}">
    <div class="item-topo">
      <span class="item-nome">${esc(x.nome || 'Cliente')}</span>
      <span class="chip ${cls}">${esc(nomeCanal)}</span>
      <span class="chip ${p}">${esc(PRIOR[p] || p)}</span>
    </div>
    ${x.produto ? `<p><b>${esc(x.produto)}</b>${x.quando ? ` <span class="sub">· última msg ${esc(x.quando)}</span>` : ''}</p>` : ''}
    ${x.situacao ? `<p><span class="rot">Onde parou</span>${esc(x.situacao)}</p>` : ''}
    ${x.motivo ? `<p><span class="rot">Por que chamar</span>${esc(x.motivo)}</p>` : ''}
    ${x.mensagem ? `<span class="rot">Sugestão de mensagem</span><div class="msg">${esc(x.mensagem)}</div>` : ''}
    <div class="acoes">
      ${x.mensagem ? `<button class="btn" data-copiar="${esc(x.id)}">📋 Copiar</button>` : ''}
      ${link ? `<a class="btn btn-verde" href="${esc(link)}" target="_blank" rel="noopener">💬 Abrir conversa</a>` : ''}
      <button class="btn" data-feito="${esc(x.id)}">${feito ? '↩️ Desmarcar' : '✅ Já chamei'}</button>
    </div>
  </div>`;
}

function telaDia(dia, titulo) {
  if (!dia) {
    const conectar = !NO_PC && !Sync.enabled();
    return `<div class="vazio">${S.carregando ? 'Carregando…' : conectar
      ? 'Conecte ao PC: no PC abra o Retomazera → Ajustes → <b>Mostrar QR code</b>. Aqui: Ajustes → <b>Ler QR do PC</b>.'
      : 'Ainda não há lista. A primeira chega depois da meia-noite.'}
      ${S.erro ? `<br><br>⚠️ ${esc(S.erro)}` : ''}</div>`;
  }
  const itens = [...(dia.itens || [])];
  const ordem = { alta: 0, media: 1, média: 1, baixa: 2 };
  itens.sort((a, b) => (ordem[a.prioridade] ?? 3) - (ordem[b.prioridade] ?? 3));
  const f = feitos();
  const pendentes = itens.filter((x) => !f[x.id]).length;
  const porCanal = {};
  itens.forEach((x) => { const c = (x.canal || 'outro').toLowerCase(); porCanal[c] = (porCanal[c] || 0) + 1; });
  const fontes = dia.fontes || {};
  return `<h1>${esc(titulo)}</h1>
    <p class="sub">Conversas de ${esc(dataBR(dia.data))} · gerado ${esc(ago(dia.geradoEm))}</p>
    ${dia.resumo ? `<div class="painel resumo">${esc(dia.resumo)}</div>` : ''}
    <div class="contagem">
      <span class="chip">${itens.length} para chamar · ${pendentes} pendente(s)</span>
      ${Object.entries(porCanal).map(([c, n]) => { const [cls, nm] = CANAIS[c] || ['', c]; return `<span class="chip ${cls}">${esc(nm)} ${n}</span>`; }).join('')}
    </div>
    ${itens.length ? itens.map(cartao).join('') : '<div class="vazio">Ninguém para retomar a partir desse dia. 👍</div>'}
    ${Object.keys(fontes).length ? `<p class="sub">Fontes lidas: ${Object.entries(fontes).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(' · ')}</p>` : ''}`;
}

function telaHistorico() {
  if (!S.dias.length) return telaDia(null);
  return `<h1>Dias anteriores</h1><p class="sub">Últimos ${S.dias.length} dias</p>
    <div class="painel dias" style="padding:0">${S.dias.map((d) => `<a href="#/dia/${esc(d.data)}">
      <span>${esc(dataBR(d.data))}</span><b>${(d.itens || []).length} cliente(s)</b></a>`).join('')}</div>`;
}

// ---------------------------------------------------------------- ajustes
function pushSuportado() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
function chaveParaBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
function deBase64url(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  return decodeURIComponent(escape(atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'))));
}
function descreverAparelho() {
  const ua = navigator.userAgent;
  const tipo = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : 'Navegador';
  return `${tipo} · Retomazera (ativado em ${new Date().toLocaleDateString('pt-BR')})`;
}
function carregarScript(src) {
  return new Promise((ok, erro) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = erro; document.head.appendChild(s); });
}

function telaAjustes() {
  if (NO_PC) {
    const st = S.status || {};
    return `<h1>Ajustes (PC)</h1>
      <div class="painel"><h2>Celular</h2>
        ${st.gist ? `<p>✅ Gist conectado (${esc(st.gist.id.slice(0, 8))}…, token …${esc(st.gist.tokenFim)}).</p>`
          : '<p>Cole um token do GitHub com permissão <b>gist</b> para o celular receber as listas.</p>'}
        <div class="campo"><input id="token" type="password" placeholder="ghp_… ou github_pat_…"></div>
        <div class="acoes"><button class="btn ${st.gist ? '' : 'btn-verde'}" id="conectar">${st.gist ? 'Trocar token' : 'Conectar'}</button>
          <button class="btn btn-verde" id="qr" ${st.gist ? '' : 'disabled'}>Mostrar QR code</button></div>
        <div id="qrCodigo" class="qr" hidden></div>
        <p style="margin-top:12px"><b>Aparelhos com notificação (${(st.aparelhos || []).length})</b><br>
          ${(st.aparelhos || []).length ? st.aparelhos.map(esc).join('<br>') : 'Nenhum ainda. No celular: leia o QR → Ajustes → 🔔 Ativar notificações.'}</p>
        <p>Push: ${st.pushPronto ? '✅ pronto' : '⚠️ falta push_vapid.pem ou .vendor'}</p>
      </div>
      <div class="painel"><h2>Notificação neste PC</h2>
        <div class="acoes"><button class="btn" id="pushPc">🔔 Ativar no Chrome do PC</button></div>
        <p class="sub" id="statusPc"></p></div>
      <p class="sub">Versão ${RZ_VERSAO}</p>`;
  }
  const reg = lerJSON(K.push, null);
  const conectado = Sync.enabled();
  return `<h1>Ajustes</h1>
    <div class="painel"><h2>Conectar ao PC</h2>
      <p>${conectado ? `✅ Conectado ao Gist ${esc(Sync.config().gistId.slice(0, 8))}…` : 'No PC: Retomazera → Ajustes → <b>Mostrar QR code</b>. Aqui: leia o QR.'}</p>
      <div class="acoes"><button class="btn ${conectado ? '' : 'btn-verde'}" id="lerQr">📷 Ler QR do PC</button></div>
      <div id="leitorQr" hidden><video id="videoQr" playsinline muted></video><div class="acoes"><button class="btn" id="pararQr">Cancelar</button></div></div>
      <div class="campo"><input id="linkConfig" placeholder="Ou cole o link https://…#config=…"></div>
    </div>
    <div class="painel"><h2>Notificações</h2>
      ${!pushSuportado() ? '<p>Este navegador não suporta notificações. No iPhone, instale o app (Compartilhar → Adicionar à Tela de Início) e abra pelo ícone.</p>'
        : reg ? `<p>🔔 Ativadas: ${esc(reg.aparelho)}</p><div class="acoes"><button class="btn" id="testePush">Enviar teste</button><button class="btn" id="desativarPush">Desativar</button><button class="btn" id="ativarPush">Reativar</button></div>`
        : `<p>Receba a lista todo dia logo depois da meia-noite.</p><div class="acoes"><button class="btn btn-verde" id="ativarPush" ${conectado ? '' : 'disabled'}>🔔 Ativar notificações</button></div>`}
    </div>
    <p class="sub">Versão ${RZ_VERSAO}</p>`;
}

function ligarAjustes() {
  if (NO_PC) {
    $('#conectar').onclick = async () => {
      const token = $('#token').value.trim();
      if (!token) return toast('Cole o token');
      const r = await api('gist', { method: 'POST', body: { token } });
      if (!r.ok) return toast(`Não conectou: ${r.erro}`);
      toast(r.criado ? 'Gist criado e conectado' : 'Conectado ao Gist existente');
      carregar();
    };
    $('#qr').onclick = mostrarQr;
    $('#pushPc').onclick = ativarPushPc;
    return;
  }
  $('#lerQr').onclick = lerQr;
  $('#pararQr').onclick = pararLeitorQr;
  $('#linkConfig').onchange = (e) => { if (aplicarLinkConfig(e.target.value)) { location.hash = '#/'; carregar(); } };
  $('#ativarPush')?.addEventListener('click', ativarPush);
  $('#testePush')?.addEventListener('click', testarPush);
  $('#desativarPush')?.addEventListener('click', desativarPush);
}

let qrScript;
async function mostrarQr() {
  const caixa = $('#qrCodigo');
  if (!caixa.hidden) { caixa.hidden = true; caixa.innerHTML = ''; return; }
  const r = await api('celular');
  if (!r.url) return toast(r.erro || 'Conecte o Gist primeiro');
  try {
    qrScript ??= carregarScript('https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js').catch((e) => { qrScript = null; throw e; });
    await qrScript;
  } catch { return toast('Não foi possível carregar o gerador de QR code'); }
  caixa.innerHTML = '';
  new QRCode(caixa, { text: r.url, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.L });
  caixa.hidden = false;
}

function aplicarLinkConfig(texto) {
  const m = String(texto || '').match(/#config=([\w%-]+)/);
  if (!m) return false;
  try {
    const { token, gistId } = JSON.parse(deBase64url(decodeURIComponent(m[1])));
    if (!token || !gistId) throw new Error();
    Sync.setConfig({ token, gistId });
    toast('Conectado ao PC');
    return true;
  } catch { toast('Link de configuração inválido'); return false; }
}
let leitorStream = null, jsQrScript;
function pararLeitorQr() {
  leitorStream?.getTracks().forEach((t) => t.stop());
  leitorStream = null;
  const box = $('#leitorQr'); if (box) box.hidden = true;
}
async function lerQr() {
  const video = $('#videoQr');
  try { leitorStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); } catch {
    return toast('Sem acesso à câmera — permita nas configurações ou cole o link abaixo');
  }
  video.srcObject = leitorStream; $('#leitorQr').hidden = false;
  await video.play().catch(() => {});
  let ler;
  if ('BarcodeDetector' in window && (await BarcodeDetector.getSupportedFormats?.())?.includes('qr_code')) {
    const det = new BarcodeDetector({ formats: ['qr_code'] });
    ler = async () => (await det.detect(video))[0]?.rawValue;
  } else {
    try {
      jsQrScript ??= carregarScript('https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js').catch((e) => { jsQrScript = null; throw e; });
      await jsQrScript;
    } catch { pararLeitorQr(); return toast('Não foi possível carregar o leitor de QR — cole o link abaixo'); }
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ler = async () => {
      if (!video.videoWidth) return null;
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
      return jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)?.data;
    };
  }
  while (leitorStream) {
    const texto = await ler().catch(() => null);
    if (texto?.includes('#config=')) {
      pararLeitorQr();
      if (aplicarLinkConfig(texto)) { location.hash = '#/'; carregar(); }
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function ativarPush() {
  if (!Sync.enabled()) return toast('Conecte ao PC primeiro (Ler QR do PC)');
  const permissao = await Notification.requestPermission();
  if (permissao !== 'granted') { rotear(); return toast('Sem permissão para notificar'); }
  try {
    const reg = await navigator.serviceWorker.getRegistration('./') || await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
    const anterior = lerJSON(K.push, null);
    const atual = await reg.pushManager.getSubscription();
    const velhos = [anterior?.endpoint, atual?.endpoint].filter(Boolean);
    await atual?.unsubscribe().catch(() => {});
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: chaveParaBytes(RZ_CONFIG.pushChavePublica) });
    const { endpoint, keys } = sub.toJSON();
    const registro = { endpoint, keys, aparelho: descreverAparelho(), criadoEm: Date.now(), testeEm: Date.now() };
    await Sync.atualizarInscricao(endpoint, registro, velhos);
    gravarJSON(K.push, registro);
    toast('Notificações ativadas — um teste chega em até 30 s');
  } catch (err) { toast(`Não foi possível ativar: ${err.message}`); }
  rotear();
}
async function testarPush() {
  const registro = lerJSON(K.push, null);
  if (!registro) return rotear();
  try {
    await Sync.atualizarInscricao(registro.endpoint, { ...registro, testeEm: Date.now() });
    toast('Teste pedido ao PC — chega em até 30 s (com o PC ligado)');
  } catch (err) { toast(`Não foi possível pedir o teste: ${err.message}`); }
}
async function desativarPush() {
  const registro = lerJSON(K.push, null);
  try {
    const reg = await navigator.serviceWorker.getRegistration('./');
    await (await reg?.pushManager.getSubscription())?.unsubscribe();
    if (registro) await Sync.atualizarInscricao(registro.endpoint, null);
  } catch { /* segue desligando localmente */ }
  gravarJSON(K.push, null);
  toast('Notificações desativadas neste aparelho');
  rotear();
}
// Ao abrir: se o iPhone trocou a inscrição sozinho, atualiza no Gist
async function conferirInscricao() {
  const registro = lerJSON(K.push, null);
  if (NO_PC || !registro || !Sync.enabled() || !pushSuportado()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration('./');
    const sub = await reg?.pushManager.getSubscription();
    if (sub && sub.endpoint !== registro.endpoint) {
      const { endpoint, keys } = sub.toJSON();
      const novo = { ...registro, endpoint, keys, criadoEm: Date.now() };
      await Sync.atualizarInscricao(endpoint, novo, [registro.endpoint]);
      gravarJSON(K.push, novo);
    }
  } catch { /* tenta na próxima abertura */ }
}
async function ativarPushPc() {
  const mostrar = (m) => { const s = $('#statusPc'); if (s) s.textContent = m; };
  try {
    mostrar('Pedindo permissão…');
    if (await Notification.requestPermission() !== 'granted') throw new Error('sem permissão');
    const reg = await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
    const atual = await reg.pushManager.getSubscription();
    await atual?.unsubscribe().catch(() => {});
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: chaveParaBytes(RZ_CONFIG.pushChavePublica) });
    const { endpoint, keys } = sub.toJSON();
    const r = await api('push-pc', { method: 'POST', body: { endpoint, keys, remover: atual ? [atual.endpoint] : [] } });
    if (!r.ok) throw new Error(r.erro || 'servidor recusou');
    const t = await api('push-teste', { method: 'POST', body: { exemplo: true, endpoint } });
    mostrar(t.ok ? '✅ Ativado — veja o exemplo no canto da tela' : '⚠️ Inscrito, mas o envio falhou (veja server.log)');
    carregar();
  } catch (err) { mostrar(`❌ ${err.message}`); }
}

// ---------------------------------------------------------------- roteador
function rotear() {
  const h = location.hash || '#/';
  let html, aba = 'hoje';
  const m = h.match(/^#\/dia\/(\d{4}-\d{2}-\d{2})/);
  if (m) {
    const dia = S.dias.find((d) => d.data === m[1]);
    html = telaDia(dia, dia ? `Lista de ${dataBR(dia.data, false)}` : 'Dia não encontrado'); aba = 'historico';
  } else if (h.startsWith('#/historico')) { html = telaHistorico(); aba = 'historico'; }
  else if (h.startsWith('#/ajustes')) { html = telaAjustes(); aba = 'ajustes'; }
  else html = telaDia(S.dias[0], 'Chamar hoje');
  $('#view').innerHTML = html;
  document.querySelectorAll('.abas a').forEach((a) => a.classList.toggle('ativa', a.dataset.aba === aba));
  $('#selo').textContent = S.ts ? `atualizado ${ago(S.ts)}` : '';
  if (aba === 'ajustes') ligarAjustes();
}
document.addEventListener('click', async (e) => {
  const c = e.target.closest('[data-copiar]');
  if (c) {
    const x = S.dias.flatMap((d) => d.itens || []).find((i) => i.id === c.dataset.copiar);
    try { await navigator.clipboard.writeText(x?.mensagem || ''); toast('Mensagem copiada'); } catch { toast('Não consegui copiar'); }
    return;
  }
  const f = e.target.closest('[data-feito]');
  if (f) alternarFeito(f.dataset.feito);
});
window.addEventListener('hashchange', rotear);
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.tipo === 'abrir') { location.href = e.data.url; carregar(); }
  if (e.data?.tipo === 'push') carregar();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) carregar(); });

// ---------------------------------------------------------------- início
if (location.hash.startsWith('#config=')) {
  const hash = location.hash;
  history.replaceState(null, '', location.pathname + location.search);
  aplicarLinkConfig(hash);
}
if (!NO_PC) {
  const cache = lerJSON(K.cache, null);
  if (cache?.dias) { S.dias = cache.dias; S.ts = cache.ts; }
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
rotear();
carregar();
conferirInscricao();
