// Retomazera — quem chamar de novo hoje para fechar venda.
// No PC (localhost) fala com o server.py; no celular (GitHub Pages) lê o Gist secreto.
const NO_PC = ['localhost', '127.0.0.1'].includes(location.hostname);
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const K = { cache: 'retomazera:cache', push: 'retomazera:push', acoesPendentes: 'retomazera:acoes-pendentes' };
const lerJSON = (k, p) => { try { return JSON.parse(localStorage.getItem(k)) ?? p; } catch { return p; } };
const gravarJSON = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem storage */ } };

const S = { dias: [], semanas: [], noites: [], retornos: [], espera: [], estoque: [], ofertas: [], precos: {}, fotosOfertas: {}, gestao: {}, lancadas: {}, acoes: {}, cards: {}, mostrarExcluidos: false, ts: 0, status: null, carregando: false, erro: '' };

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
      S.dias = r.dias || []; S.semanas = r.semanas || []; S.noites = r.noites || []; S.retornos = r.retornos || []; S.espera = r.espera || []; S.estoque = r.estoque || []; S.ofertas = r.ofertas || []; S.precos = r.precos || {}; S.fotosOfertas = r.fotosOfertas || {}; S.gestao = r.gestao || {}; S.lancadas = r.lancadas || {}; S.acoes = r.acoes || {}; S.ts = r.ts;
      S.status = await api('status');
    } else if (Sync.enabled()) {
      const { 'lembretes.json': l, 'acoes.json': ac, 'fotos_ofertas.json': fo } = await Sync.ler({ 'lembretes.json': { dias: [] }, 'acoes.json': {}, 'fotos_ofertas.json': {} });
      S.fotosOfertas = fo || {};
      S.dias = l.dias || []; S.semanas = l.semanas || []; S.noites = l.noites || []; S.retornos = l.retornos || []; S.espera = l.espera || []; S.estoque = l.estoque || []; S.ofertas = l.ofertas || []; S.precos = l.precos || {}; S.gestao = l.gestao || {}; S.lancadas = l.lancadas || {}; S.ts = l.ts || 0;
      S.acoes = juntarAcoes(ac || {}, lerJSON(K.acoesPendentes, {}));
      gravarJSON(K.cache, { dias: S.dias, semanas: S.semanas, noites: S.noites, retornos: S.retornos, espera: S.espera, estoque: S.estoque, ofertas: S.ofertas, precos: S.precos, gestao: S.gestao, lancadas: S.lancadas, acoes: S.acoes, ts: S.ts });
    }
  } catch (err) {
    S.erro = err.message || String(err);
  }
  S.carregando = false;
  rotear();
}

// ---------------------------------------------------------------- ações nos cards (sincronizadas)
// Fixar, Já chamei, Vendido e Excluir valem para o CLIENTE (não só para o card do dia) e ficam no Gist
// (acoes.json), então aparecem no celular e no PC — e a análise do Claude respeita: excluído e vendido
// não voltam a ser sugeridos.
function chaveCliente(x) {
  const canal = (x.canal || '').toLowerCase();
  const dig = String(x.contato || '').replace(/\D/g, '');
  if (canal === 'whatsapp' && dig.length >= 8) return `whatsapp:${dig.slice(-8)}`;
  if ((canal === 'olx' || canal === 'instagram') && /^https?:/.test(x.contato || '')) return `${canal}:${x.contato}`;
  return `${canal}:${String(x.nome || '').trim().toLowerCase()}`;
}
// Ação valendo para ESTE card. "Vendido" e "Já chamei" marcados ANTES desta lista ser gerada eram da
// negociação anterior: se o cliente voltou a aparecer (ex.: comprou um Xbox e agora quer um controle),
// o card aparece normal, com a etiqueta "⭐ Já comprou". Fixar e Excluir valem sempre.
function acaoDe(x) {
  const a = S.acoes[chaveCliente(x)] || {};
  if (!x._listaEm) return a;
  const vendidoEm = a.vendidoEm || a.ts || 0;
  return {
    ...a,
    vendido: Boolean(a.vendido && vendidoEm >= x._listaEm),
    chamado: a.chamado && a.chamado >= x._listaEm ? a.chamado : 0,
    jaComprou: Boolean(a.vendido && vendidoEm < x._listaEm),
  };
}
// junta dois mapas de ações: por cliente, vale o mais recente
function juntarAcoes(a, b) {
  const r = { ...a };
  for (const [k, v] of Object.entries(b || {})) if (!r[k] || (v.ts || 0) >= (r[k].ts || 0)) r[k] = v;
  return r;
}
let filaGravar = Promise.resolve();
async function marcar(chave, campo, ligadoAgora) {
  const x = S.cards[chave] || S.acoes[chave] || {};
  const atual = S.acoes[chave] || {};
  // o botão diz o estado que aparece NESTE card (pode ser diferente do salvo, ver acaoDe)
  const ligado = ligadoAgora ?? Boolean(atual[campo]);
  const valor = campo === 'chamado' ? (ligado ? 0 : Date.now()) : !ligado;
  const novo = {
    ...atual,
    nome: x.nome, canal: x.canal, contato: x.contato, produto: x.produto, prioridade: x.prioridade,
    situacao: x.situacao, motivo: x.motivo, mensagem: x.mensagem, ultimaMsg: x.ultimaMsg, quando: x.quando,
    [campo]: valor, ts: Date.now(),
    ...(campo === 'vendido' && valor ? { vendidoEm: Date.now(), vendas: (atual.vendas || 0) + 1 } : {}),
  };
  if (campo === 'excluido' && valor) toast('Excluído — não volta a ser sugerido. Para desfazer: "mostrar excluídos" no fim da lista.');
  if (campo === 'vendido' && valor) toast('Marcado como vendido 💰 — lembre de lançar a venda na Gestão.');
  salvarAcoes({ [chave]: novo });
}
// grava ações (no PC pelo servidor; no celular direto no Gist), em fila para um clique não atropelar o outro
function salvarAcoes(novas) {
  S.acoes = { ...S.acoes, ...novas };
  rotear();
  filaGravar = filaGravar.then(async () => {
    try {
      if (NO_PC) {
        const r = await api('acoes', { method: 'POST', body: novas });
        if (!r.ok) throw new Error(r.erro || 'servidor recusou');
        for (const [k, l] of Object.entries(r.lancadas || {})) {
          S.lancadas[k] = { ...l, em: Date.now() };  // l.ts = ts do formulário lançado
          toast(l.erro ? `⚠️ Não lancei na Gestão: ${l.erro}` : l.ok ? '📒 Venda lançada na Gestão' : '');
        }
        if (Object.keys(r.lancadas || {}).length) rotear();
      } else if (Sync.enabled()) {
        const pend = { ...lerJSON(K.acoesPendentes, {}), ...novas };
        gravarJSON(K.acoesPendentes, pend);
        const { 'acoes.json': remoto } = await Sync.ler({ 'acoes.json': {} });
        const junto = juntarAcoes(remoto || {}, pend);
        await Sync.gravar('acoes.json', junto);
        gravarJSON(K.acoesPendentes, {});
        S.acoes = juntarAcoes(S.acoes, junto);
      }
    } catch (err) {
      toast(`Salvo só neste aparelho por enquanto (${err.message}); envio de novo depois.`);
    }
  });
}

// ---------------------------------------------------------------- vendas marcadas
// A análise do Claude acha nas conversas as vendas combinadas para um dia ("agendadas").
// Junta as de todas as listas (a lista mais nova vale, se o cliente remarcou) e mostra as de hoje.
// atalho para outra aba (fila, vendas, retornos): botão largo e legível no tema escuro
const atalho = (href, icone, titulo, sub) => `<a class="atalho" href="${href}"><span class="atalho-ic">${icone}</span><span class="atalho-txt"><b>${esc(titulo)}</b><small>${esc(sub)}</small></span><span class="atalho-seta">›</span></a>`;
function hojeIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// valor de venda digitado pelo João (acoes['venda:...#i'].valor) vale mais que o que a análise achou;
// o total acompanha a diferença
function comValoresManuais(v) {
  let delta = 0, mudou = false;
  const a = S.acoes[v._chave] || {};
  const g = a.concluida && a.gestao?.itens ? a.gestao.itens.slice() : [];
  const itens = (v.itens || []).map((it, i) => {
    const gi = g.findIndex((x) => x.descricao === it.descricao);
    const doForm = gi >= 0 ? g.splice(gi, 1)[0] : null;
    if (doForm && S.acoes[`${v._chave}#${i}`]?.valor == null) {
      mudou = true; delta += Number(doForm.preco_venda) - (Number(it.valor) || 0);
      return { ...it, valor: Number(doForm.preco_venda), _gestao: doForm };
    }
    const m = S.acoes[`${v._chave}#${i}`]?.valor;
    if (m == null || m === '') return it;
    mudou = true; delta += Number(m) - (Number(it.valor) || 0);
    return { ...it, valor: Number(m), _manual: true, _original: it.valor };
  });
  if (!mudou) return v;
  const base = Number(v.total) || (v.itens || []).reduce((s, it) => s + (Number(it.valor) || 0), 0);
  return { ...v, itens, total: Math.round((base + delta) * 100) / 100 };
}
function salvarValorItem(chaveItem, txt) {
  const n = String(txt || '').trim() === '' ? null : Number(String(txt).replace(/\./g, '').replace(',', '.'));
  if (n != null && (isNaN(n) || n < 0)) { toast('Valor inválido'); return; }
  S.editValor = '';
  salvarAcoes({ [chaveItem]: { ...(S.acoes[chaveItem] || {}), valor: n, ts: Date.now() } });
  toast(n == null ? 'Voltou ao valor da conversa' : `Valor de venda: ${brlV(n)}`);
}
function itemVendaHtml(v, i, it, concluida) {
  const k = `${v._chave}#${i}`;
  if (S.editValor === k) {
    return `<li class="edita-valor">${esc(it.descricao)}<div class="acoes"><input class="valor-item" data-valor-item="${esc(k)}" inputmode="decimal" placeholder="R$ (vazio = o da conversa)" value="${esc(it.valor ? String(it.valor).replace('.', ',') : '')}">
      <button class="btn btn-mini btn-verde" data-salvar-valor="${esc(k)}">✔ Salvar</button><button class="btn btn-mini" data-editar-valor="">✕</button></div></li>`;
  }
  const val = brlV(it.valor);
  return `<li>${esc(it.descricao)}${val ? ` <span class="sub">— ${esc(val)}${it._manual ? ' (manual)' : ''}</span>` : ''}${concluida ? ''
    : ` <button class="btn-link" data-editar-valor="${esc(k)}">${val ? '✏️ editar' : '✏️ pôr valor'}</button>`}</li>`;
}
function vendasMarcadas() {
  const porCliente = {};
  for (const dia of [...S.dias, ...S.noites].sort((a, b) => (a.geradoEm || 0) - (b.geradoEm || 0))) {
    for (const v of dia.agendadas || []) porCliente[chaveCliente(v)] = { ...v, _listaEm: dia.geradoEm };
  }
  return Object.values(porCliente).map((v) => comValoresManuais({ ...v, _chave: `venda:${chaveCliente(v)}:${v.data}` }))
    .sort((a, b) => (a.data + (a.hora || '')).localeCompare(b.data + (b.hora || '')));
}
const brlV = (v) => (v == null || v === '' || isNaN(Number(v)) ? '' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
function textoVenda(v) {
  return [`${v.nome}${foneBR(v) ? ' ' + foneBR(v) : ''} — ${dataBR(v.data, false)}${v.hora ? ' ' + v.hora : ''}`,
    v.local ? `Local: ${v.local}${v.entrega ? ` (${v.entrega})` : ''}` : '',
    ...(v.itens || []).map((i) => `• ${i.descricao}${brlV(i.valor) ? ' — ' + brlV(i.valor) : ''}`),
    brlV(v.total) ? `Total: ${brlV(v.total)}` : '', v.pagamento ? `Pagamento: ${v.pagamento}` : '',
    v.entrada ? `Entrada: ${v.entrada}` : '', v.observacoes ? `Obs.: ${v.observacoes}` : ''].filter(Boolean).join('\n');
}
function blocoUnidadesVenda(v) {
  if ((S.acoes[v._chave] || {}).concluida) {
    return (v.itens || []).filter((it) => it._gestao).map((it) => {
      const g = it._gestao, lucro = Number(g.preco_venda) - (Number(g.custo) || 0);
      return `<div class="unidade"><div class="sem-foto">${ICONE_FAMILIA(g.familia || '')}</div>
        <div class="unidade-txt"><span class="sub">🎮 Saiu:</span> <b>${esc(g.nome || '')}</b>
        <div>Custo <b>${brlV(g.custo) || '—'}</b> · Vendido por ${brlV(g.preco_venda)}${g.custo != null ? ` · <span class="${lucro >= 0 ? 'lucro' : 'prejuizo'}">${lucro >= 0 ? '+' : ''}${brlV(lucro)}</span>` : ''}</div></div></div>`;
    }).join('');
  }
  if (!S.estoque.length) return '';
  const aloc = alocarVendas();
  return (v.itens || []).map((it, i) => ({ it, chave: `${v._chave}#${i}` })).map(({ it, chave }) => {
    const fam = S.estoque.find((u) => (u.atende || []).includes(chave))?.familia;
    if (!fam) return '';
    const u = aloc.porItem[chave];
    const outras = S.estoque.filter((x) => x.familia === fam && x !== u && (!aloc.porUid[x.uid] || aloc.porUid[x.uid].chave === chave));
    const troca = outras.length ? `<select class="vincular" data-trocar-item="${esc(chave)}"><option value="">🔄 Trocar o videogame…</option>${outras.map((x) => `<option value="${esc(x.uid)}">${esc(x.nome || x.item)} — custo ${esc(brlV(x.custo))}${x.situacao === 'disponivel' ? '' : ' (chegando)'}</option>`).join('')}</select>` : '';
    if (!u) return `<div class="unidade"><div class="sem-foto">❓</div><div class="unidade-txt"><b>Não achei ${esc(fam)} livre no estoque da Gestão</b>${troca}</div></div>`;
    const lucro = Number(it.valor) && u.custo ? Number(it.valor) - Number(u.custo) : null;
    return `<div class="unidade">
      ${u.foto ? `<img src="${u.foto}" alt="" loading="lazy">` : `<div class="sem-foto">${ICONE_FAMILIA(u.familia)}</div>`}
      <div class="unidade-txt"><span class="sub">🎮 Vai este:</span> <b>${esc(u.nome || u.item)}</b>
        <div>${u.situacao === 'disponivel' ? '<span class="st-ok">✅ Disponível</span>' : '<span class="st-chegando">🚚 Chegando — ainda não está com você!</span>'}${S.acoes[chave]?.uid === u.uid ? ' 📌' : ''}</div>
        <div>Custo <b>${brlV(u.custo) || '—'}</b>${brlV(it.valor) ? ` · Vendido por ${brlV(it.valor)}` : ` · <button class="btn-link" data-editar-valor="${esc(chave)}">✏️ pôr valor de venda</button>`}${lucro != null ? ` · <span class="lucro">${lucro >= 0 ? '+' : ''}${brlV(lucro)}</span>` : ''}</div>
        ${troca}</div></div>`;
  }).join('');
}
function trocarUnidadeVenda(chaveItem, uid) {
  salvarAcoes({ [chaveItem]: { ...(S.acoes[chaveItem] || {}), uid, ts: Date.now() } });
  toast('Videogame da venda trocado');
}
function cartaoVenda(v) {
  const [cls, nomeCanal] = CANAIS[(v.canal || '').toLowerCase()] || ['', v.canal || '—'];
  const st = S.acoes[v._chave] || {};
  S.cards[v._chave] = v;
  const fone = foneBR(v);
  const link = linkConversa(v);
  const atrasada = v.data < hojeIso();
  return `<div class="item venda ${st.concluida ? 'vendido' : ''}">
    <div class="item-topo">
      <span class="item-nome">${esc(v.nome || 'Cliente')}${fone ? ` <span class="item-fone">${esc(fone)}</span>` : ''}</span>
      <span class="chip ${cls}">${esc(nomeCanal)}</span>
      ${st.concluida ? `<span class="chip vend">Concluída</span>${seloGestao(v._chave)}` : v.status === 'a confirmar' ? '<span class="chip media">A confirmar</span>' : '<span class="chip vend">Confirmada</span>'}
    </div>
    <p><b>${atrasada ? `⚠️ Era ${esc(dataBR(v.data, false))}` : v.data === hojeIso() ? 'Hoje' : esc(dataBR(v.data))}${v.hora ? ` · 🕒 ${esc(v.hora)}` : ''}</b>${v.local ? ` · 📍 ${esc(v.local)}` : ''}${v.entrega ? ` <span class="sub">(${esc(v.entrega)})</span>` : ''}</p>
    ${(v.itens || []).length ? `<ul class="venda-itens">${v.itens.map((it, i) => itemVendaHtml(v, i, it, st.concluida)).join('')}</ul>` : ''}
    ${blocoUnidadesVenda(v)}
    ${brlV(v.total) ? `<p class="venda-total">Total: <b>${esc(brlV(v.total))}</b></p>` : ''}
    ${v.pagamento ? `<p>💳 ${esc(v.pagamento)}</p>` : ''}
    ${v.entrada ? `<p>🔁 Entrada: ${esc(v.entrada)}</p>` : ''}
    ${v.observacoes ? `<p>📝 ${esc(v.observacoes)}</p>` : ''}
    ${v.resumo ? `<p class="sub">${esc(v.resumo)}</p>` : ''}
    ${erroGestao(v._chave)}
    <div class="acoes">
      ${botaoConversa(link && link.split('?')[0])}
      <button class="btn" data-copiar-venda="${esc(v._chave)}">📋 Copiar</button>
    </div>
    <div class="acoes">
      <button class="btn btn-mini ${st.concluida ? 'ligado' : ''}" data-venda="concluida" data-chave="${esc(v._chave)}">${st.concluida ? '↩️ Desfazer' : '✅ Vendido'}</button>
      ${st.concluida ? '' : `<button class="btn btn-mini" data-venda="cancelada" data-chave="${esc(v._chave)}">❌ Desmarcou</button>`}
    </div>
  </div>`;
}
function marcarVenda(chaveVenda, campo) {
  const v = S.cards[chaveVenda] || {};
  const atual = S.acoes[chaveVenda] || {};
  const valor = !atual[campo];
  if (campo === 'concluida' && valor) { abrirFormVenda(chaveVenda); return; }
  if (campo === 'concluida' && !valor && S.lancadas[chaveVenda]?.ok
      && !confirm('Desfazer a venda? O videogame volta para o estoque na Gestão (sem preço de venda, pagamento e parcelas).')) return;
  const novas = { [chaveVenda]: { ...atual, nome: v.nome, canal: v.canal, data: v.data, [campo]: valor, ts: Date.now() } };
  // venda concluída = cliente vendido (sai das sugestões; se voltar a negociar, aparece com "⭐ Já comprou")
  if (campo === 'concluida') {
    const ck = chaveCliente(v), c = S.acoes[ck] || {};
    novas[ck] = { ...c, nome: v.nome, canal: v.canal, contato: v.contato, vendido: valor, ...(valor ? { vendidoEm: Date.now(), vendas: (c.vendas || 0) + 1 } : {}), ts: Date.now() };
    if (valor) toast('Venda concluída 💰 — lembre de lançar na Gestão.');
  }
  if (campo === 'cancelada' && valor) toast('Venda tirada da lista.');
  salvarAcoes(novas);
}
// ---------------------------------------------------------------- lançar a venda na Gestão (✅ Vendido)
// O formulário tem os mesmos campos da venda na Gestão; vai junto da ação (acoes[venda].gestao) e o
// servidor do PC grava no produto da Gestão — do PC na hora, do celular quando o PC lê o Gist.
const FORMAS = [['cartao', '💳 Cartão'], ['pix', '💚 Pix'], ['dinheiro', '💵 Dinheiro'], ['fiado', '🧾 Fiado']];
const ORIGEM_CANAL = { olx: 'OLX', facebook: 'Facebook', whatsapp: 'Instagram / WhatsApp', instagram: 'Instagram / WhatsApp' };
const brlNum = (s) => { const n = Number(String(s ?? '').replace(/\./g, '').replace(',', '.')); return isNaN(n) ? 0 : n; };
const numTxt = (n) => (n ? String(Math.round(n * 100) / 100).replace('.', ',') : '');
function foneGestao(v) { // Gestão guarda "22 99891-9570"
  const f = foneBR(v);
  return f.replace(/^\((\d{2})\) /, '$1 ');
}
function somarMes(iso, n = 1) {
  const [a, m, d] = iso.split('-').map(Number);
  const dt = new Date(a, m - 1 + n, 1);
  const ult = new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate();
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(Math.min(d, ult)).padStart(2, '0')}`;
}
function recebedoresDe(forma) { // já usados na Gestão, sem repetir (João/Joao)
  const vistos = new Set();
  return ((S.gestao.recebedores || {})[forma] || []).filter((r) => {
    const k = `${r.tipo}|${(r.nome || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()}`;
    if (vistos.has(k) || /^\d+$/.test(r.nome || '')) return false;
    vistos.add(k); return true;
  });
}
function itensParaGestao(v) {
  const aloc = alocarVendas();
  return itensConsoleVenda(v).map((x) => ({ ...x, u: aloc.porItem[x.chave] })).filter((x) => x.u);
}
function pagamentoSugerido(v, preco) {
  const t = `${v.pagamento || ''} ${v.observacoes || ''}`.toLowerCase();
  const pag = { pix: /pix/.test(t), cartao: /cart[aã]o|cr[eé]dito|d[eé]bito|maquin/.test(t), dinheiro: /dinheiro|esp[eé]cie/.test(t), fiado: /fiado|depois de 30|ap[oó]s 30|30 dias depois/.test(t) };
  if (!Object.values(pag).some(Boolean)) pag.pix = true;
  const formas = Object.keys(pag).filter((k) => pag[k]);
  return { pag, val: formas.length === 1 ? { [formas[0]]: preco } : {} };
}
function abrirFormVenda(chaveVenda) {
  const v = S.cards[chaveVenda];
  if (!v) return;
  const ant = (S.acoes[chaveVenda] || {}).gestao; // reabrindo depois de um erro: começa do que foi enviado
  // "Corrigir" (venda ainda concluída) refaz os itens do envio; depois de desfazer, vale o videogame escolhido agora
  const itens = ant?.itens?.length && (S.acoes[chaveVenda] || {}).concluida
    ? ant.itens.map((a) => ({ it: { descricao: a.descricao || '', valor: a.preco_venda },
      u: S.estoque.find((x) => x.uid === a.uid) || { uid: a.uid, nome: a.nome, custo: a.custo, familia: a.familia || '' } }))
    : itensParaGestao(v);
  const hoje = hojeIso();
  const base = ant?.itens?.[0] || {};
  const dataV = base.data_venda || (v.data && v.data <= hoje ? v.data : hoje);
  const origens = S.gestao.origens || Object.values(ORIGEM_CANAL);
  const origem = base.origem_venda ?? ORIGEM_CANAL[(v.canal || '').toLowerCase()] ?? '';
  const nomeComp = base.nome_comprador || `${v.nome || ''} Comprador ${itens[0]?.u.familia || ''}`.trim();
  const blocos = itens.map((x, i) => {
    const a = ant?.itens?.find((y) => y.uid === x.u.uid);
    const preco = a ? a.preco_venda : Number(x.it.valor) || (itens.length === 1 ? Number(v.total) : 0) || Number(x.u.preco) || 0;
    const sug = a ? { pag: a.pag, val: a.val } : pagamentoSugerido(v, preco);
    const linhas = FORMAS.map(([k, rot]) => {
      const recs = recebedoresDe(k);
      const r = a?.rec?.[k] || recs[0] || { tipo: 'CPF', nome: '' };
      const tipos = k === 'fiado' ? ['CPF', 'CNPJ', 'Dinheiro'] : ['CPF', 'CNPJ'];
      return `<div class="fp-linha" data-forma="${k}">
        <label class="fp-chk"><input type="checkbox" ${sug.pag?.[k] ? 'checked' : ''}> ${rot}</label>
        <div class="fp-det">
          <input class="fp-val" inputmode="decimal" placeholder="R$ (vazio = o que falta)" value="${esc(numTxt(Number(sug.val?.[k]) || 0))}">
          ${k === 'dinheiro' ? '' : `<select class="fp-tipo">${tipos.map((t) => `<option ${t === r.tipo ? 'selected' : ''}>${t}</option>`).join('')}</select>
          <input class="fp-nome" list="rec-${k}" placeholder="Quem recebeu" value="${esc(r.nome || '')}">`}
        </div>
      </div>`;
    }).join('');
    const parc = a?.parcelas?.length ? a.parcelas : [];
    return `<div class="fv-item" data-uid="${esc(x.u.uid)}" data-custo="${Number(x.u.custo) || 0}" data-nome="${esc(x.u.nome || x.u.item || '')}" data-familia="${esc(x.u.familia || '')}" data-descricao="${esc(x.it.descricao || '')}">
      <div class="unidade">${x.u.foto ? `<img src="${x.u.foto}" alt="">` : `<div class="sem-foto">${ICONE_FAMILIA(x.u.familia)}</div>`}
        <div class="unidade-txt"><b>${esc(x.u.nome || x.u.item)}</b><div class="sub">${esc(x.it.descricao || '')} · custo ${esc(brlV(x.u.custo) || '—')}</div></div></div>
      <label class="fv-campo">Preço de venda (R$)<input class="fv-preco" inputmode="decimal" value="${esc(numTxt(preco))}"></label>
      <div class="fv-lucro sub"></div>
      <div class="fv-rot">Forma de pagamento</div>
      ${linhas}
      <div class="fv-parcelas" ${sug.pag?.fiado ? '' : 'hidden'}>
        <div class="sub">Parcelas do fiado (data e valor de cada uma)</div>
        <div class="fv-plista">${parc.map((p) => linhaParcela(p.venc, numTxt(Number(p.valor)))).join('')}</div>
        <div class="acoes"><button type="button" class="btn btn-mini" data-fv="parcela">+ Parcela</button>
          <button type="button" class="btn btn-mini" data-fv="dividir">Dividir igualmente</button><span class="fv-soma sub"></span></div>
      </div>
    </div>`;
  }).join('');
  const listas = ['cartao', 'pix', 'fiado'].map((k) => `<datalist id="rec-${k}">${recebedoresDe(k).map((r) => `<option value="${esc(r.nome)}">${esc(r.tipo)}</option>`).join('')}</datalist>`).join('');
  fecharFormVenda();
  const d = document.createElement('div');
  d.className = 'modal';
  d.dataset.modalVenda = chaveVenda;
  d.innerHTML = `<form class="modal-caixa form-venda" novalidate>
    <h2>💰 Vendido — ${esc(v.nome || 'cliente')}</h2>
    ${itens.length ? `<p class="sub">Vai direto para a Gestão como vendido, igual ao formulário de lá.</p>
      <div class="fv-grade">
        <label class="fv-campo">Data da venda<input type="date" class="fv-data" value="${esc(dataV)}" max="${esc(hoje)}"></label>
        <label class="fv-campo">Origem da venda<select class="fv-origem"><option value=""></option>${origens.map((o) => `<option ${o === origem ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>
        <label class="fv-campo">Nome do comprador<input class="fv-comprador" value="${esc(nomeComp)}"></label>
        <label class="fv-campo">Telefone do comprador<input class="fv-tel" value="${esc(base.tel_comprador ?? foneGestao(v))}"></label>
      </div>
      ${blocos}${listas}`
    : `<p>Não achei o videogame dessa venda no estoque da Gestão — dá para concluir aqui e lançar a venda por lá.</p>`}
    ${v.pagamento || v.entrada ? `<p class="sub">Combinado: ${esc([v.pagamento, v.entrada ? `entrada ${v.entrada}` : ''].filter(Boolean).join(' · '))}</p>` : ''}
    <p class="fv-erro" hidden></p>
    <div class="acoes fv-botoes">
      ${itens.length ? '<button type="submit" class="btn btn-verde">✅ Lançar na Gestão</button>' : ''}
      <button type="button" class="btn" data-fv="so-concluir">${itens.length ? 'Só concluir aqui' : '✅ Concluir'}</button>
      <button type="button" class="btn" data-fv="fechar">Cancelar</button>
    </div>
  </form>`;
  document.body.appendChild(d);
  d.querySelectorAll('.fv-item').forEach(atualizarItemVenda);
}
function linhaParcela(venc = '', valor = '') {
  return `<div class="fv-parcela"><input type="date" class="fp-venc" value="${esc(venc)}"><input class="fp-pval" inputmode="decimal" placeholder="R$" value="${esc(valor)}"><button type="button" class="btn btn-mini" data-fv="tirar">✕</button></div>`;
}
function fecharFormVenda() { document.querySelector('.modal')?.remove(); }
function valorFiado(item) {
  const l = item.querySelector('[data-forma="fiado"]');
  const preco = brlNum(item.querySelector('.fv-preco').value);
  const v = brlNum(l.querySelector('.fp-val').value);
  if (v) return v;
  const outros = [...item.querySelectorAll('.fp-linha')].filter((x) => x !== l && x.querySelector('input[type=checkbox]').checked);
  const semValor = outros.filter((x) => !brlNum(x.querySelector('.fp-val').value)).length;
  return semValor ? 0 : Math.max(preco - outros.reduce((s, x) => s + brlNum(x.querySelector('.fp-val').value), 0), 0);
}
function atualizarItemVenda(item) {
  const preco = brlNum(item.querySelector('.fv-preco').value), custo = Number(item.dataset.custo) || 0;
  const luc = preco - custo;
  item.querySelector('.fv-lucro').innerHTML = preco && custo ? `Lucro <b class="${luc >= 0 ? 'lucro' : 'prejuizo'}">${luc >= 0 ? '+' : ''}${esc(brlV(luc))}</b>` : '';
  item.querySelectorAll('.fp-linha').forEach((l) => { l.classList.toggle('on', l.querySelector('input[type=checkbox]').checked); });
  item.querySelectorAll('.fp-linha').forEach((l) => {
    const t = l.querySelector('.fp-tipo'), n = l.querySelector('.fp-nome');
    if (t && n) n.hidden = t.value === 'Dinheiro';
  });
  const fiado = item.querySelector('[data-forma="fiado"] input[type=checkbox]').checked;
  const bp = item.querySelector('.fv-parcelas');
  bp.hidden = !fiado;
  if (fiado && !bp.querySelector('.fv-parcela')) {
    const data = document.querySelector('.fv-data')?.value || hojeIso();
    bp.querySelector('.fv-plista').insertAdjacentHTML('beforeend', linhaParcela(somarMes(data), numTxt(valorFiado(item))));
  }
  const soma = [...bp.querySelectorAll('.fp-pval')].reduce((s, x) => s + brlNum(x.value), 0);
  const total = valorFiado(item);
  bp.querySelector('.fv-soma').textContent = fiado ? `Soma ${brlV(soma)}${total ? ` de ${brlV(total)}` : ''}` : '';
}
function acaoFormVenda(btn) {
  const modal = btn.closest('.modal'), item = btn.closest('.fv-item');
  const o = btn.dataset.fv;
  if (o === 'fechar') { fecharFormVenda(); return; }
  if (o === 'so-concluir') { const k = modal.dataset.modalVenda; fecharFormVenda(); concluirVenda(k, null); return; }
  if (o === 'tirar') { btn.closest('.fv-parcela').remove(); atualizarItemVenda(item); return; }
  if (o === 'parcela') {
    const ps = [...item.querySelectorAll('.fv-parcela')];
    const ult = ps.at(-1)?.querySelector('.fp-venc').value || modal.querySelector('.fv-data').value || hojeIso();
    const falta = Math.max(valorFiado(item) - ps.reduce((s, p) => s + brlNum(p.querySelector('.fp-pval').value), 0), 0);
    item.querySelector('.fv-plista').insertAdjacentHTML('beforeend', linhaParcela(somarMes(ult), numTxt(falta)));
    atualizarItemVenda(item); return;
  }
  if (o === 'dividir') {
    const ps = [...item.querySelectorAll('.fp-pval')], total = valorFiado(item);
    if (!ps.length || !total) return;
    const cada = Math.floor((total / ps.length) * 100) / 100;
    ps.forEach((p, i) => { p.value = numTxt(i === ps.length - 1 ? total - cada * (ps.length - 1) : cada); });
    atualizarItemVenda(item);
  }
}
function lerFormVenda(modal) {
  const erro = (m) => { throw new Error(m); };
  const data = modal.querySelector('.fv-data').value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) erro('Preencha a data da venda.');
  const comum = { data_venda: data, origem_venda: modal.querySelector('.fv-origem').value,
    nome_comprador: modal.querySelector('.fv-comprador').value.trim(), tel_comprador: modal.querySelector('.fv-tel').value.trim() };
  return [...modal.querySelectorAll('.fv-item')].map((item) => {
    const preco = brlNum(item.querySelector('.fv-preco').value);
    if (!preco) erro('Preencha o preço de venda.');
    const pag = {}, val = {}, rec = {};
    item.querySelectorAll('.fp-linha').forEach((l) => {
      const k = l.dataset.forma;
      pag[k] = l.querySelector('input[type=checkbox]').checked;
      if (!pag[k]) return;
      val[k] = brlNum(l.querySelector('.fp-val').value);
      const t = l.querySelector('.fp-tipo');
      if (t) rec[k] = { tipo: t.value, nome: t.value === 'Dinheiro' ? '' : l.querySelector('.fp-nome').value.trim() };
    });
    if (!Object.values(pag).some(Boolean)) erro('Marque a forma de pagamento.');
    const parcelas = pag.fiado ? [...item.querySelectorAll('.fv-parcela')].map((p, i) => {
      const venc = p.querySelector('.fp-venc').value, valor = brlNum(p.querySelector('.fp-pval').value);
      if (!venc) erro(`Data da ${i + 1}ª parcela do fiado.`);
      if (!valor) erro(`Valor da ${i + 1}ª parcela do fiado.`);
      return { venc, valor };
    }) : [];
    if (pag.fiado) {
      if (!parcelas.length) erro('Adicione as parcelas do fiado.');
      const soma = parcelas.reduce((s, p) => s + p.valor, 0), total = val.fiado || 0;
      if (total && Math.abs(soma - total) > 0.01) erro(`A soma das parcelas (${brlV(soma)}) é diferente do valor do fiado (${brlV(total)}).`);
    }
    return { uid: item.dataset.uid, nome: item.dataset.nome, custo: Number(item.dataset.custo) || 0, familia: item.dataset.familia,
      descricao: item.dataset.descricao, preco_venda: preco, ...comum, pag, val, rec, parcelas };
  });
}
function enviarFormVenda(modal) {
  const msg = modal.querySelector('.fv-erro');
  try {
    const itens = lerFormVenda(modal);
    const k = modal.dataset.modalVenda;
    fecharFormVenda();
    concluirVenda(k, { ts: Date.now(), itens });
  } catch (err) {
    msg.textContent = err.message; msg.hidden = false;
  }
}
// conclui a venda (cliente vira vendido) — com gestao = formulário para lançar na Gestão
function concluirVenda(chaveVenda, gestao) {
  const v = S.cards[chaveVenda] || {};
  const atual = S.acoes[chaveVenda] || {};
  const ck = chaveCliente(v), c = S.acoes[ck] || {};
  const novas = {
    [chaveVenda]: { ...atual, nome: v.nome, canal: v.canal, data: v.data, concluida: true, ...(gestao ? { gestao } : {}), ts: Date.now() },
    [ck]: { ...c, nome: v.nome, canal: v.canal, contato: v.contato, vendido: true, vendidoEm: Date.now(), vendas: (c.vendas || 0) + (atual.concluida ? 0 : 1), ts: Date.now() },
  };
  toast(gestao ? (NO_PC ? 'Venda concluída 💰 — lançando na Gestão…' : 'Venda concluída 💰 — o PC lança na Gestão quando ler o Gist.') : 'Venda concluída 💰 — lembre de lançar na Gestão.');
  salvarAcoes(novas);
}
function seloGestao(chaveVenda) {
  const a = S.acoes[chaveVenda] || {}, l = S.lancadas[chaveVenda];
  if (!a.concluida || !a.gestao) return '';
  if (!l || l.ts !== a.gestao.ts) return '<span class="chip media">⏳ Indo p/ Gestão</span>';  // relógio do celular ≠ do PC: compara o ts do formulário
  if (l.erro) return '<span class="chip alta">⚠️ Gestão</span>';
  return l.ok ? '<span class="chip vend">📒 Na Gestão</span>' : '';
}
function erroGestao(chaveVenda) {
  const a = S.acoes[chaveVenda] || {}, l = S.lancadas[chaveVenda];
  if (!a.concluida || !a.gestao || !l?.erro || l.ts !== a.gestao.ts) return '';
  return `<p class="fv-erro">⚠️ Não lancei na Gestão: ${esc(l.erro)} <button class="btn btn-mini" data-corrigir-venda="${esc(chaveVenda)}">✏️ Corrigir</button></p>`;
}
// ---------------------------------------------------------------- noite: preparar as vendas de amanhã
function blocoNoite() {
  const hoje = hojeIso();
  const n = S.noites.find((x) => x.data === hoje || x.amanha === hoje);
  if (!n) return '';
  const deHoje = n.data === hoje; // à noite: preparar amanhã; de manhã (amanha === hoje): o que ficou do preparo
  const prep = (n.preparar || []).map((t, i) => ({ t, k: `prep:${n.data}:${i}` }));
  const feitos = prep.filter((p) => (S.acoes[p.k] || {}).feito).length;
  if (!deHoje && feitos === prep.length) return '';
  const vendas = vendasMarcadas().filter((v) => v.data === n.amanha && !(S.acoes[v._chave] || {}).cancelada);
  const conf = deHoje ? (n.confirmar || []).filter((x) => !acaoDe(x).excluido) : [];
  return `<h2 style="margin:4px 0 8px">🌙 ${deHoje ? 'Preparar amanhã' : 'Preparo de ontem à noite'} <span class="sub">(${esc(dataBR(n.amanha))})</span></h2>
    ${n.resumo && deHoje ? `<div class="painel resumo">${esc(n.resumo)}</div>` : ''}
    ${prep.length ? `<div class="painel"><h2>✅ Checklist <span class="sub">${feitos}/${prep.length}</span></h2>
      ${prep.map((p) => { const ok = (S.acoes[p.k] || {}).feito; return `<label class="check ${ok ? 'ok' : ''}"><input type="checkbox" data-prep="${esc(p.k)}" ${ok ? 'checked' : ''}> <span>${esc(p.t)}</span></label>`; }).join('')}
    </div>` : ''}
    ${deHoje && vendas.length ? `<h2 style="margin:14px 0 8px">📦 Vendas de amanhã (${vendas.length})</h2>${vendas.map(cartaoVenda).join('')}` : ''}
    ${conf.length ? `<h2 style="margin:14px 0 8px">📞 Confirmar hoje à noite</h2>${conf.map(cartao).join('')}` : ''}`;
}

// ---------------------------------------------------------------- retornos combinados ("me chama mês que vem")
function blocoRetornos(chavesDoDia) {
  const hoje = hojeIso();
  const semana = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  // vencidos há até 7 dias continuam aparecendo enquanto não marcar "Já chamei" depois da data
  const devidos = S.retornos.filter((r) => r.data <= hoje && r.data >= semana && !chavesDoDia.has(chaveCliente(r)))
    .map((r) => ({ ...r, prioridade: 'alta', situacao: `Combinado em ${dataBR(r.combinadoEm, false)}: ${r.pedido || ''}`,
      quando: r.data < hoje ? `era ${dataBR(r.data, false)}` : '', _listaEm: new Date(r.data + 'T00:00:00').getTime() }))
    .filter((r) => { const a = acaoDe(r); return !a.excluido && !a.vendido && !a.chamado; });
  const futuros = S.retornos.filter((r) => r.data > hoje && !acaoDe(r).excluido);
  if (!devidos.length && !futuros.length) return '';
  return `${devidos.length ? `<h2 style="margin:4px 0 8px">📅 Combinado de chamar hoje (${devidos.length})</h2>${devidos.map(cartao).join('')}` : ''}
    ${futuros.length ? atalho('#/retornos', '📅', `${futuros.length} ${futuros.length === 1 ? 'retorno combinado' : 'retornos combinados'}`, 'para os próximos dias') : ''}`;
}
// ---------------------------------------------------------------- fila de espera ("quando chegar eu te aviso")
function cardEspera(e, chegou, unidade = '') {
  const ch = e.chegou || {};
  const preco = brlV(ch.preco);
  const msg = e.mensagem || `Bom dia, irmão, beleza? Chegou o ${e.produto} que você tava procurando! Ainda tem interesse?`;
  return cartao({
    ...e, prioridade: chegou ? 'alta' : 'media',
    produto: e.produto + (e.detalhes ? ` · ${e.detalhes}` : ''),
    situacao: [chegou ? `🔔 Tem no estoque: ${(ch.opcoes && ch.opcoes.length ? ch.opcoes : [ch]).map((o) => `${o.item}${brlV(o.preco) ? ` (${brlV(o.preco)})` : ''}`).join(' · ')}` : `Esperando ${e.familia} desde ${dataBR(e.desde, false)}${e.pedido ? ` · ${e.pedido}` : ''}`, unidade].filter(Boolean).join(' · '),
    motivo: chegou ? `Esperando desde ${dataBR(e.desde, false)}${e.pedido ? ` · ${e.pedido}` : ''}` : '',
    mensagem: chegou && preco && !/R\$/.test(msg) && !(ch.opcoes && ch.opcoes.length > 1) ? `${msg} Tá saindo ${preco}.` : msg,
    _listaEm: chegou ? ch.em : undefined,
  });
}
function esperaAtiva() {
  return S.espera.filter((e) => { const a = acaoDe({ ...e, _listaEm: e.chegou?.em }); return !a.excluido && !a.vendido; });
}
function blocoChegou() {
  const chegou = esperaAtiva().filter((e) => e.chegou && !acaoDe({ ...e, _listaEm: e.chegou.em }).chamado);
  const fila = esperaAtiva().length;
  if (!chegou.length && !fila) return '';
  return `${chegou.length ? `<h2 style="margin:4px 0 8px">🔔 Chegou o que estavam esperando (${chegou.length})</h2>${chegou.map((e) => cardEspera(e, true)).join('')}` : ''}
    ${fila ? atalho('#/espera', '⏳', `${fila} ${fila === 1 ? 'cliente' : 'clientes'} na fila de espera`, 'esperando chegar o videogame') : ''}`;
}
// unidades da Gestão (disponíveis e chegando) do modelo, com foto, custo e para quem cada uma vai.
// A divisão é refeita aqui (e não só no PC) para o "Desvincular" valer na hora: o primeiro da fila pega a
// primeira unidade que o atende, pulando as que o João desvinculou dele (acoes[cliente].semUnidade).
// Vendas marcadas reservam primeiro a unidade (cada videogame da venda): a que o João escolheu à mão
// (acoes[item].uid), senão a de preço igual ao combinado, disponível antes de chegando, comprada há mais tempo.
function itensConsoleVenda(v) {
  return (v.itens || []).map((it, i) => ({ it, chave: `${v._chave}#${i}` }))
    .filter(({ chave }) => S.estoque.some((u) => (u.atende || []).includes(chave)));
}
function alocarVendas() {
  const porUid = {}, porItem = {};
  // venda concluída ou desmarcada não segura unidade (a vendida já sai do estoque na Gestão)
  const vendas = vendasMarcadas().filter((v) => { const a = S.acoes[v._chave] || {}; return !a.cancelada && !a.concluida; });
  const itens = vendas.flatMap((v) => itensConsoleVenda(v).map((x) => ({ ...x, v })));
  for (const x of itens) {  // escolhas manuais primeiro
    const uid = S.acoes[x.chave]?.uid;
    const u = uid && S.estoque.find((y) => y.uid === uid);
    if (u && !porUid[u.uid]) { porUid[u.uid] = x; porItem[x.chave] = u; }
  }
  for (const x of itens) {
    if (porItem[x.chave]) continue;
    const cand = S.estoque.filter((u) => !porUid[u.uid] && (u.atende || []).includes(x.chave));
    const valor = Number(x.it.valor) || 0;
    cand.sort((a, b) => (Number(a.preco) === valor ? 0 : 1) - (Number(b.preco) === valor ? 0 : 1)
      || (a.situacao === 'disponivel' ? 0 : 1) - (b.situacao === 'disponivel' ? 0 : 1));
    if (cand[0]) { porUid[cand[0].uid] = x; porItem[x.chave] = cand[0]; }
  }
  return { porUid, porItem };
}
// ordem de prioridade da fila, por modelo: a que o João arrumou (acoes['ordem:<modelo>'].lista), depois os
// que entraram depois por data de entrada
function filaOrdenada(lista = esperaAtiva()) {
  const pos = (e) => { const l = S.acoes[`ordem:${e.familia}`]?.lista || []; const i = l.indexOf(e.chave); return i < 0 ? 1e6 : i; };
  return lista.slice().sort((a, b) => pos(a) - pos(b) || (a.desde || '').localeCompare(b.desde || ''));
}
function moverNaFila(chave, dir) {
  const e = S.espera.find((x) => x.chave === chave);
  if (!e) return;
  const l = filaOrdenada(esperaAtiva().filter((x) => x.familia === e.familia)).map((x) => x.chave);
  const i = l.indexOf(chave), j = i + dir;
  if (i < 0 || j < 0 || j >= l.length) return;
  [l[i], l[j]] = [l[j], l[i]];
  salvarAcoes({ [`ordem:${e.familia}`]: { lista: l, ts: Date.now() } });
}
function alocarFila() {
  // Só videogame DISPONÍVEL fica de alguém. O que está CHEGANDO mostra só a previsão pela ordem da fila:
  // quando a Gestão mudar para "Aguardando venda", ele vai para o primeiro da fila naquele momento.
  const reservadas = alocarVendas().porUid;
  const porUid = {}, porChave = {}, fixos = new Set(), previsao = new Set();
  // quem já tem um videogame do modelo reservado numa venda marcada não pega outro da fila
  const comVenda = new Set(vendasMarcadas().filter((v) => { const a = S.acoes[v._chave] || {}; return !a.cancelada && !a.concluida; })
    .flatMap((v) => itensConsoleVenda(v).map(({ chave }) => `${chaveCliente(v)}|${S.estoque.find((u) => (u.atende || []).includes(chave))?.familia}`)));
  const fila = filaOrdenada().filter((e) => !comVenda.has(`${chaveCliente(e)}|${e.familia}`));
  const serve = (x, e) => !reservadas[x.uid] && (x.atende ? x.atende.includes(e.chave) : x.para === e.chave);
  const fora = (e) => S.acoes[chaveCliente(e)]?.semUnidade || [];
  const dar = (e, u) => { porUid[u.uid] = e; porChave[e.chave] = u; };
  const disp = S.estoque.filter((u) => u.situacao === 'disponivel');
  // 1) vínculos manuais (só disponível; o mais recente vence)
  const manuais = fila.map((e) => ({ e, v: S.acoes[chaveCliente(e)]?.vinculos?.[e.familia] }))
    .filter((m) => m.v && !reservadas[m.v.uid] && disp.some((x) => x.uid === m.v.uid)).sort((a, b) => (b.v.em || 0) - (a.v.em || 0));
  for (const { e, v } of manuais) {
    if (porChave[e.chave] || porUid[v.uid]) continue;
    dar(e, disp.find((x) => x.uid === v.uid)); fixos.add(v.uid);
  }
  // 2) disponíveis pela ordem da fila, pulando o que o João desvinculou daquele cliente
  for (const e of fila) {
    if (porChave[e.chave]) continue;
    const u = disp.find((x) => !porUid[x.uid] && !fora(e).includes(x.uid) && serve(x, e));
    if (u) dar(e, u);
  }
  // 3) chegando: previsão pela ordem da fila (não prende ninguém)
  for (const e of fila) {
    if (porChave[e.chave]) continue;
    const u = S.estoque.find((x) => x.situacao !== 'disponivel' && !porUid[x.uid] && serve(x, e));
    if (u) { dar(e, u); previsao.add(u.uid); }
  }
  return { porUid, porChave, fixos, reservadas, previsao, comVenda };
}
// modo: 'desvincular' | 'desfazer' (tira o desvínculo) | 'manual' (liga esta unidade a este cliente)
function vincular(chaveEspera, uid, modo) {
  const e = S.espera.find((x) => x.chave === chaveEspera);
  if (!e) return;
  const ck = chaveCliente(e), atual = S.acoes[ck] || {};
  const fora = new Set(atual.semUnidade || []);
  const vinculos = { ...(atual.vinculos || {}) };
  if (modo === 'desvincular') { fora.add(uid); if (vinculos[e.familia]?.uid === uid) delete vinculos[e.familia]; }
  if (modo === 'desfazer') fora.delete(uid);
  if (modo === 'manual') { fora.delete(uid); vinculos[e.familia] = { uid, em: Date.now() }; }
  const novas = { [ck]: { ...atual, nome: e.nome, canal: e.canal, contato: e.contato, semUnidade: [...fora], vinculos, ts: Date.now() } };
  // quem tinha esta unidade fixada manualmente perde o vínculo
  if (modo === 'manual') {
    for (const o of esperaAtiva()) {
      const ok = chaveCliente(o); if (ok === ck) continue;
      const a = novas[ok] || S.acoes[ok];
      if (a?.vinculos?.[o.familia]?.uid === uid) { const vs = { ...a.vinculos }; delete vs[o.familia]; novas[ok] = { ...a, vinculos: vs, ts: Date.now() }; }
    }
  }
  salvarAcoes(novas);
  toast(modo === 'desvincular' ? `Desvinculado de ${e.nome}` : modo === 'manual' ? `Vinculado a ${e.nome}` : `Vinculado de novo a ${e.nome}`);
}
const ICONE_FAMILIA = (f) => (/PS|PlayStation/i.test(f) ? '🎮' : /Xbox/i.test(f) ? '🟩' : /Switch/i.test(f) ? '🕹️' : /iPhone/i.test(f) ? '📱' : '🎮');
function unidadeEstoque(u, aloc) {
  const dono = aloc.porUid[u.uid];
  const desvinculados = u.situacao !== 'disponivel' ? [] : esperaAtiva().filter((e) => (S.acoes[chaveCliente(e)]?.semUnidade || []).includes(u.uid));
  const st = u.situacao === 'disponivel' ? '<span class="st-ok">✅ Disponível</span>' : '<span class="st-chegando">🚚 Chegando</span>';
  const lucro = u.preco && u.custo ? Number(u.preco) - Number(u.custo) : null;
  return `<div class="unidade">
    ${u.foto ? `<img src="${u.foto}" alt="" loading="lazy">` : `<div class="sem-foto">${ICONE_FAMILIA(u.familia)}</div>`}
    <div class="unidade-txt"><b>${esc(u.nome || u.item)}</b>
      <div>${st}</div>
      <div>Custo <b>${brlV(u.custo) || '—'}</b>${u.preco ? ` · Venda ${brlV(u.preco)}` : ''}${lucro != null ? ` · <span class="lucro">+${brlV(lucro)}</span>` : ''}</div>
      <div class="para">${aloc.reservadas[u.uid] ? `💰 Reservado: venda para <b>${esc(aloc.reservadas[u.uid].v.nome)}</b> (${esc(dataBR(aloc.reservadas[u.uid].v.data, false))})` : aloc.previsao.has(u.uid) ? `🔮 Pela fila: <b>${esc(dono.nome)}</b> <span class="sub">(fica dele quando chegar, se continuar o primeiro)</span>` : u.situacao !== 'disponivel' ? '🔮 Ninguém da fila na vez' : dono ? `➡️ Para <b>${esc(dono.nome)}</b>${aloc.fixos.has(u.uid) ? ' 📌' : ''} <button class="btn btn-mini" data-desvincular="${esc(dono.chave)}" data-uid="${esc(u.uid)}">✖ Desvincular</button>` : '🆓 Sem cliente da fila'}</div>
      ${aloc.reservadas[u.uid] || u.situacao !== 'disponivel' ? '' : `<select class="vincular" data-vincular-uid="${esc(u.uid)}"><option value="">🔗 Vincular a outro cliente…</option>${esperaAtiva().filter((e) => e.familia === u.familia && e !== dono).map((e) => `<option value="${esc(e.chave)}">${esc(e.nome)}${aloc.porChave[e.chave] ? ' (troca a unidade dele)' : ''}</option>`).join('')}</select>`}
      ${desvinculados.map((e) => `<div class="para">🚫 Desvinculado de ${esc(e.nome)} <button class="btn btn-mini" data-revincular="${esc(e.chave)}" data-uid="${esc(u.uid)}">↩ Desfazer</button></div>`).join('')}</div></div>`;
}
function telaEspera() {
  const lista = esperaAtiva();
  const porFamilia = {};
  lista.forEach((e) => { (porFamilia[e.familia] = porFamilia[e.familia] || []).push(e); });
  const aloc = alocarFila();
  const unid = (f) => S.estoque.filter((u) => u.familia === f);
  const blocoEstoque = (f) => {
    const us = unid(f);
    if (!us.length) return '<p class="sub">📦 Nada desse modelo na Gestão (nem disponível, nem chegando).</p>';
    const disp = us.filter((u) => u.situacao === 'disponivel').length;
    return `<details class="estoque" open><summary>📦 Estoque na Gestão: ${disp} disponível(is) · ${us.length - disp} chegando</summary>${us.map((u) => unidadeEstoque(u, aloc)).join('')}</details>`;
  };
  const vaiUsar = (e) => { const u = aloc.porChave[e.chave]; if (aloc.comVenda.has(`${chaveCliente(e)}|${e.familia}`)) return '💰 Já tem venda marcada desse modelo (sai da fila quando concluir)'; return !u ? '' : u.situacao === 'disponivel' ? `✅ Vai usar: ${u.nome || u.item} (custo ${brlV(u.custo)})` : `🔮 Previsto (chegando): ${u.nome || u.item} (custo ${brlV(u.custo)})`; };
  return `<h1>⏳ Fila de espera</h1><p class="sub">Clientes esperando um modelo sem estoque. Quando a Gestão tiver o item em "Aguardando venda", você recebe a notificação e eles aparecem na aba Hoje. Videogame disponível vai para o primeiro da fila que ele atende; o que está chegando só mostra a previsão e vai para quem for o primeiro quando chegar — use ▲ ▼ para mudar a prioridade.</p>
    ${Object.keys(porFamilia).length ? Object.entries(porFamilia).map(([f, l]) => `<h2 style="margin:14px 0 8px">${esc(f)} (${l.length})${l.some((e) => e.chegou) ? ' · 🔔 tem no estoque' : ''}</h2>${blocoEstoque(f)}${filaOrdenada(l).map((e, i, arr) => `<div class="ordem-fila"><b>${i + 1}º da fila</b><span><button class="btn btn-mini" data-mover="${esc(e.chave)}" data-dir="-1" ${i ? '' : 'disabled'}>▲ Subir</button><button class="btn btn-mini" data-mover="${esc(e.chave)}" data-dir="1" ${i < arr.length - 1 ? '' : 'disabled'}>▼ Descer</button></span></div>${cardEspera(e, Boolean(e.chegou), vaiUsar(e))}`).join('')}`).join('') : '<div class="vazio">Ninguém na fila de espera.</div>'}`;
}

// ---------------------------------------------------------------- comprar: gente querendo vender videogame (WhatsApp)
function cartaoOferta(o) {
  const st = S.acoes[`oferta:${o.chave}`] || {};
  S.cards[o.chave] = o;
  const fone = foneBR(o);
  const link = linkConversa(o);
  const ref = S.precos[o.familia] || {};
  // negociado = o que o João ofereceu (senão, o que a pessoa pediu); margem = venda média − negociado
  const negociado = o.ofertado || o.preco || null;
  const margem = negociado && ref.venda ? ref.venda - negociado : null;
  const col = (rot, val, sub = '') => `<div class="neg-col"><small>${rot}</small><b>${val ? esc(brlV(val)) : '—'}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  const refTxt = `<div class="negocio">
      ${col('Média de compra', ref.compra, ref.nCompra ? `${ref.nCompra} compra(s)` : 'sem histórico')}
      ${col('Negociado', negociado, o.ofertado ? 'sua oferta' : o.preco ? 'pedido dele' : 'sem valor ainda')}
      ${col('Venda média', ref.venda, ref.nVenda ? `${ref.nVenda} venda(s)` : 'sem histórico')}
    </div>
    ${margem != null ? `<p class="neg-margem">Comprando por ${esc(brlV(negociado))} e vendendo na média: <b class="${margem >= 0 ? 'lucro' : 'prejuizo'}">${margem >= 0 ? '+' : ''}${esc(brlV(margem))}</b>${o.ofertado && o.preco && o.preco !== o.ofertado ? ` · ele pediu ${esc(brlV(o.preco))}` : ''}</p>` : ''}
    ${o.ofertadoTexto ? `<p class="sub">🤝 Sua oferta: ${esc(o.ofertadoTexto)}</p>` : ''}`;
  return `<div class="item media ${st.comprei ? 'vendido' : ''} ${st.descartada ? 'excluido' : ''}">
    <div class="item-topo">
      <span class="item-nome">${/^[+\d\s()-]+$/.test(o.nome || '') ? esc(fone || o.nome) : `${esc(o.nome || 'Contato')}${fone ? ` <span class="item-fone">${esc(fone)}</span>` : ''}`}</span>
      <span class="chip wpp">WhatsApp</span>
      ${st.comprei ? '<span class="chip vend">Comprei</span>' : ''}
    </div>
    <p><b>🎮 ${esc(o.produto)}</b>${o.preco ? ` · pede <b>${esc(brlV(o.preco))}</b>` : ''}${o.precoTexto && !o.preco ? ` · ${esc(o.precoTexto)}` : ''}</p>
    ${o.precoTexto && o.preco ? `<p class="sub">💬 ${esc(o.precoTexto)}</p>` : ''}
    ${o.detalhes ? `<p>📝 ${esc(o.detalhes)}</p>` : ''}
    ${o.situacao ? `<p><span class="rot">Onde parou</span>${esc(o.situacao)}</p>` : ''}
    ${(S.fotosOfertas[o.chave] || []).length ? `<div class="fotos-oferta">${S.fotosOfertas[o.chave].map((f, i) => `<img src="${f}" alt="Foto ${i + 1} enviada pelo cliente" loading="lazy" data-ampliar="${esc(o.chave)}" data-i="${i}">`).join('')}</div>` : ''}
    ${refTxt}
    ${o.ultimaMsg ? `<p class="sub">“${esc(o.ultimaMsg)}”${o.quando ? ` · ${esc(o.quando)}` : ''} · ${esc(dataBR(o.atualizado, false))}</p>` : ''}
    ${o.mensagem ? `<div class="msg">${esc(o.mensagem)}</div>` : ''}
    <div class="acoes">
      ${botaoConversa(link && link.split('?')[0])}
      ${o.mensagem ? `<button class="btn" data-copiar="${esc(o.chave)}">📋 Copiar resposta</button>` : ''}
    </div>
    <div class="acoes">
      <button class="btn btn-mini ${st.comprei ? 'ligado' : ''}" data-oferta="comprei" data-chave="${esc(o.chave)}">${st.comprei ? '↩️ Desfazer' : '✅ Comprei'}</button>
      <button class="btn btn-mini ${st.descartada ? 'ligado' : ''}" data-oferta="descartada" data-chave="${esc(o.chave)}">${st.descartada ? '↩️ Voltar' : '🗑️ Descartar'}</button>
    </div>
  </div>`;
}
function ampliarFoto(chave, i) {
  const fotos = S.fotosOfertas[chave] || [];
  if (!fotos[i]) return;
  document.querySelector('.foto-grande')?.remove();
  const d = document.createElement('div');
  d.className = 'foto-grande';
  d.innerHTML = `<img src="${fotos[i]}" alt=""><span>${i + 1} de ${fotos.length} · toque para fechar</span>`;
  document.body.appendChild(d);
}
function marcarOferta(chave, campo) {
  const k = `oferta:${chave}`, atual = S.acoes[k] || {};
  salvarAcoes({ [k]: { ...atual, [campo]: !atual[campo], ts: Date.now() } });
  if (campo === 'comprei' && !atual.comprei) toast('Comprado 🎮 — lembre de cadastrar na Gestão.');
}
function telaComprar() {
  const st = (o) => S.acoes[`oferta:${o.chave}`] || {};
  const abertas = S.ofertas.filter((o) => !st(o).comprei && !st(o).descartada);
  const fechadas = S.ofertas.filter((o) => st(o).comprei || st(o).descartada);
  return `<h1>🛒 Comprar</h1><p class="sub">Gente querendo te vender videogame no WhatsApp (últimos 30 dias), com o que você costuma pagar e vender na Gestão.</p>
    ${abertas.length ? abertas.map(cartaoOferta).join('') : '<div class="vazio">Nenhuma oferta em aberto. Quando alguém oferecer um videogame no WhatsApp, aparece aqui.</div>'}
    ${fechadas.length ? `<p class="sub"><a href="#" data-mostrar-excluidos="1">✅ ${fechadas.length} comprada(s)/descartada(s) — ${S.mostrarExcluidos ? 'esconder' : 'mostrar'}</a></p>${S.mostrarExcluidos ? fechadas.map(cartaoOferta).join('') : ''}` : ''}`;
}

function telaRetornos() {
  const futuros = S.retornos.filter((r) => r.data >= hojeIso() && !acaoDe(r).excluido);
  return `<h1>📅 Retornos combinados</h1><p class="sub">Clientes que pediram para ser chamados numa data. No dia, aparecem na aba Hoje.</p>
    ${futuros.length ? futuros.map((r) => cartao({ ...r, prioridade: 'media', situacao: `Chamar em ${dataBR(r.data)} · ${r.pedido || ''}` })).join('') : '<div class="vazio">Nenhum retorno combinado.</div>'}`;
}

function telaVendas() {
  const corpo = blocoVendas(true);
  return `<h1>💰 Vendas</h1><p class="sub">Vendas combinadas nas conversas, com o videogame do estoque da Gestão que vai em cada uma.</p>
    ${corpo || '<div class="vazio">Nenhuma venda marcada. Quando um cliente combinar dia de entrega/retirada, ela aparece aqui.</div>'}`;
}
function linkVendasHoje() {
  const hoje = hojeIso();
  const n = vendasMarcadas().filter((v) => v.data === hoje && !(S.acoes[v._chave] || {}).cancelada && !(S.acoes[v._chave] || {}).concluida).length;
  return n ? atalho('#/vendas', '💰', `${n} ${n === 1 ? 'venda marcada' : 'vendas marcadas'} para hoje`, 'ver o videogame e o combinado') : '';
}
function blocoVendas(naAba) {
  const hoje = hojeIso();
  const limiteAtraso = new Date(Date.now() - 3 * 864e5);
  const todas = vendasMarcadas().filter((v) => !(S.acoes[v._chave] || {}).cancelada);
  const doDia = todas.filter((v) => v.data === hoje);
  const atrasadas = todas.filter((v) => v.data < hoje && new Date(v.data) >= limiteAtraso && !(S.acoes[v._chave] || {}).concluida);
  const proximas = todas.filter((v) => v.data > hoje);
  if (!doDia.length && !atrasadas.length && !proximas.length) return '';
  const r = resultadoVendas(doDia);
  return `<h2 style="margin:4px 0 8px">📦 Vendas do dia${doDia.length ? ` (${doDia.length})` : ''}</h2>
    ${doDia.length ? `${r.fat ? `<p class="sub">Faturamento <b>${esc(brlV(r.fat))}</b> · Lucro <b class="lucro">${esc(brlV(r.lucro))}</b></p>` : ''}${doDia.map(cartaoVenda).join('')}` : '<p class="sub">Nenhuma venda marcada para hoje.</p>'}
    ${atrasadas.length ? `<h2 style="margin:14px 0 8px">⚠️ Ficaram pendentes</h2>${atrasadas.map(cartaoVenda).join('')}` : ''}
    ${proximas.length ? `<h2 style="margin:14px 0 8px">🗓️ Próximas</h2>${proximas.map(cartaoVenda).join('')}` : ''}
    ${naAba ? '' : '<h2 style="margin:18px 0 8px">📲 Para chamar</h2>'}`;
}
// faturamento = total combinado; lucro = faturamento − custo (Gestão) dos videogames que vão em cada venda.
// Item sem custo conhecido (jogo, acessório, taxa) entra inteiro no lucro — o painel avisa quantos são.
function resultadoVendas(lista) {
  const aloc = alocarVendas();
  let fat = 0, custo = 0, semCusto = 0;
  for (const v of lista) {
    const itens = (v.itens || []).map((it, i) => ({ it, u: aloc.porItem[`${v._chave}#${i}`] }));
    fat += Number(v.total) || itens.reduce((s, x) => s + (Number(x.it.valor) || 0), 0);
    for (const { it, u } of itens) {
      if (it._gestao) custo += Number(it._gestao.custo) || 0;
      else if (u) custo += Number(u.custo) || 0;
      else if (!/^\W*(taxa|frete|entrega)/i.test(it.descricao || '')) semCusto += 1;
    }
  }
  return { fat, custo, lucro: fat - custo, semCusto };
}

// ---------------------------------------------------------------- telas
const CANAIS = { whatsapp: ['wpp', 'WhatsApp'], facebook: ['fb', 'Facebook'], olx: ['olx', 'OLX'], instagram: ['ig', 'Instagram'] };
const PRIOR = { alta: 'Alta', media: 'Média', média: 'Média', baixa: 'Baixa' };

// Botão "Abrir conversa". No computador, link do WhatsApp vai direto pelo app (whatsapp://), sem abrir uma aba
// do wa.me que fica sobrando no navegador; no celular continua o wa.me (o sistema já abre o app).
const NO_CELULAR = /iPhone|iPad|Android/i.test(navigator.userAgent);
function botaoConversa(link) {
  if (!link) return '';
  const m = link.match(/^https:\/\/wa\.me\/(\d+)(?:\?text=(.*))?$/);
  if (m && !NO_CELULAR) {
    return `<a class="btn btn-verde" href="${esc(`whatsapp://send?phone=${m[1]}${m[2] ? `&text=${m[2]}` : ''}`)}">💬 Abrir conversa</a>`;
  }
  return `<a class="btn btn-verde" href="${esc(link)}" target="_blank" rel="noopener">💬 Abrir conversa</a>`;
}
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
  if (canal === 'instagram') return 'https://www.instagram.com/direct/inbox/';
  return '';
}

// 5522999447760 → (22) 99944-7760 (só para WhatsApp; outros canais não têm telefone)
function foneBR(x) {
  if ((x.canal || '').toLowerCase() !== 'whatsapp') return '';
  let d = String(x.contato || '').replace(/\D/g, '');
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return d;
}

function cartao(x) {
  const [cls, nomeCanal] = CANAIS[(x.canal || '').toLowerCase()] || ['', x.canal || '—'];
  const fone = foneBR(x);
  const p = (x.prioridade || 'media').toLowerCase().replace('é', 'e');
  const chave = chaveCliente(x);
  S.cards[chave] = x;
  const a = acaoDe(x);
  const link = linkConversa(x);
  const bt = (campo, ligado, sim, nao) => `<button class="btn btn-mini ${ligado ? 'ligado' : ''}" data-acao="${campo}" data-chave="${esc(chave)}" data-ligado="${ligado ? 1 : 0}">${ligado ? sim : nao}</button>`;
  return `<div class="item ${p} ${a.chamado ? 'feito' : ''} ${a.vendido ? 'vendido' : ''} ${a.excluido ? 'excluido' : ''}">
    <div class="item-topo">
      <span class="item-nome">${a.fixado ? '📌 ' : ''}${esc(x.nome || 'Cliente')}${fone ? ` <span class="item-fone">${esc(fone)}</span>` : ''}</span>
      ${x.ronda ? `<span class="chip ronda" title="Novo ou atualizado na ronda das ${esc(x.ronda)}">🔄 ${esc(x.ronda)}</span>` : ''}
      ${a.jaComprou ? '<span class="chip vend" title="Já comprou de você antes">⭐ Já comprou</span>' : ''}
      <span class="chip ${cls}">${esc(nomeCanal)}</span>
      ${a.vendido ? '<span class="chip vend">Vendido</span>' : `<span class="chip ${p}">${esc(PRIOR[p] || p)}</span>`}
    </div>
    ${x.produto ? `<p><b>${esc(x.produto)}</b>${x.quando ? ` <span class="sub">· última msg ${esc(x.quando)}</span>` : ''}</p>` : ''}
    ${x.situacao ? `<p><span class="rot">Onde parou</span>${esc(x.situacao)}</p>` : ''}
    ${x.motivo ? `<p><span class="rot">Por que chamar</span>${esc(x.motivo)}</p>` : ''}
    ${x.mensagem ? `<span class="rot">Sugestão de mensagem</span><div class="msg">${esc(x.mensagem)}</div>` : ''}
    <div class="acoes">
      ${x.mensagem ? `<button class="btn" data-copiar="${esc(chave)}">📋 Copiar</button>` : ''}
      ${botaoConversa(link)}
    </div>
    <div class="acoes">
      ${a.excluido ? bt('excluido', true, '↩️ Restaurar', '') : `
      ${bt('chamado', a.chamado, '✅ Chamei', '☑️ Já chamei')}
      ${bt('fixado', a.fixado, '📌 Desafixar', '📌 Fixar')}
      ${bt('vendido', a.vendido, '↩️ Desfazer venda', '💰 Vendido')}
      ${bt('excluido', false, '', '🗑️ Excluir')}`}
    </div>
  </div>`;
}

function telaDia(dia, titulo) {
  if (!dia && titulo === 'Chamar hoje' && (S.noites.length || vendasMarcadas().length)) {
    return `<h1>Chamar hoje</h1>${blocoNoite()}${blocoChegou()}${linkVendasHoje()}${blocoRetornos(new Set())}<div class="vazio">A lista de quem chamar chega uns minutos depois que o PC é ligado.</div>`;
  }
  if (!dia) {
    const conectar = !NO_PC && !Sync.enabled();
    return `<div class="vazio">${S.carregando ? 'Carregando…' : conectar
      ? 'Conecte ao PC: no PC abra o Retomazera → Ajustes → <b>Mostrar QR code</b>. Aqui: Ajustes → <b>Ler QR do PC</b>.'
      : 'Ainda não há lista. Ela chega todo dia uns minutos depois que o PC é ligado.'}
      ${S.erro ? `<br><br>⚠️ ${esc(S.erro)}` : ''}</div>`;
  }
  // item novo/atualizado numa ronda vale a partir da hora da ronda (um "Já chamei" de antes não esconde)
  const todos = (dia.itens || []).map((x) => ({ ...x, _listaEm: x.listaEm || dia.geradoEm }));
  const excluidos = todos.filter((x) => acaoDe(x).excluido);
  const itens = todos.filter((x) => !acaoDe(x).excluido);
  // fixados primeiro, vendidos no fim; dentro disso, por prioridade
  const ordem = { alta: 0, media: 1, média: 1, baixa: 2 };
  const peso = (x) => { const a = acaoDe(x); return (a.fixado ? 0 : 10) + (a.vendido ? 100 : 0) + (ordem[x.prioridade] ?? 3); };
  itens.sort((a, b) => peso(a) - peso(b) || (b.listaEm || 0) - (a.listaEm || 0));
  const pendentes = itens.filter((x) => { const a = acaoDe(x); return !a.chamado && !a.vendido; }).length;
  // fixados de dias anteriores que não estão na lista deste dia
  const chavesDoDia = new Set(todos.map(chaveCliente));
  const fixadosAntigos = titulo === 'Chamar hoje'
    ? Object.entries(S.acoes).filter(([k, a]) => a.fixado && !a.excluido && !a.vendido && !chavesDoDia.has(k)).map(([, a]) => a)
    : [];
  const porCanal = {};
  itens.forEach((x) => { const c = (x.canal || 'outro').toLowerCase(); porCanal[c] = (porCanal[c] || 0) + 1; });
  const fontes = dia.fontes || {};
  return `<h1>${esc(titulo)}</h1>
    <p class="sub">Lista de ${esc(dataBR(dia.data))} (conversas das últimas ~24 h) · gerada ${esc(ago(dia.geradoEm))}</p>
    ${dia.resumo ? `<div class="painel resumo">${esc(dia.resumo)}</div>` : ''}
    ${(dia.rondas || []).length ? `<div class="painel rondas">${dia.rondas.slice().reverse().map((r) => `<p><b>🔄 ${esc(r.hora)}</b> ${esc(r.resumo)}</p>`).join('')}</div>` : ''}
    <div class="contagem">
      <span class="chip">${itens.length} para chamar · ${pendentes} pendente(s)</span>
      ${Object.entries(porCanal).map(([c, n]) => { const [cls, nm] = CANAIS[c] || ['', c]; return `<span class="chip ${cls}">${esc(nm)} ${n}</span>`; }).join('')}
    </div>
    ${titulo === 'Chamar hoje' ? blocoNoite() + blocoChegou() + linkVendasHoje() + blocoRetornos(chavesDoDia) : ''}
    ${fixadosAntigos.length ? `<h2 style="margin:4px 0 8px">📌 Fixados</h2>${fixadosAntigos.map(cartao).join('')}<h2 style="margin:14px 0 8px">Lista do dia</h2>` : ''}
    ${itens.length ? itens.map(cartao).join('') : '<div class="vazio">Ninguém para retomar a partir desse dia. 👍</div>'}
    ${excluidos.length ? `<p class="sub"><a href="#" data-mostrar-excluidos="1">🗑️ ${excluidos.length} excluído(s) — ${S.mostrarExcluidos ? 'esconder' : 'mostrar'}</a></p>${S.mostrarExcluidos ? excluidos.map(cartao).join('') : ''}` : ''}
    ${Object.keys(fontes).length ? `<p class="sub">Fontes lidas: ${Object.entries(fontes).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(' · ')}</p>` : ''}`;
}

function telaHistorico() {
  if (!S.dias.length) return telaDia(null);
  return `<h1>Dias anteriores</h1><p class="sub">Últimos ${S.dias.length} dias</p>
    <div class="painel dias" style="padding:0">${S.dias.map((d) => `<a href="#/dia/${esc(d.data)}">
      <span>${esc(dataBR(d.data))}</span><b>${(d.itens || []).length} cliente(s)</b></a>`).join('')}</div>`;
}

// ---------------------------------------------------------------- resumo semanal
const brl = (v) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
function lista(titulo, itens) {
  return itens && itens.length ? `<div class="painel"><h2>${titulo}</h2><ul style="margin:0;padding-left:18px">${itens.map((t) => `<li style="margin:4px 0">${esc(t)}</li>`).join('')}</ul></div>` : '';
}
function telaSemana(chave) {
  if (!S.semanas.length) {
    return `<h1>Resumo da semana</h1><div class="vazio">${S.carregando ? 'Carregando…' : 'O primeiro resumo chega na segunda-feira, logo depois da lista do dia.'}</div>`;
  }
  const w = (chave && S.semanas.find((x) => x.semana === chave)) || S.semanas[0];
  const n = w.numeros || {};
  const outras = S.semanas.filter((x) => x.semana !== w.semana);
  const difVendas = n.vendas_semana_anterior != null ? ` <span class="sub">(anterior: ${n.vendas_semana_anterior})</span>` : '';
  return `<h1>Semana ${esc(dataBR(w.inicio, false))} a ${esc(dataBR(w.fim, false))}</h1>
    <p class="sub">${esc(w.titulo || '')}</p>
    <div class="painel">
      <p style="margin:0"><b>${n.vendas ?? 0}</b> vendas${difVendas} · faturamento <b>${brl(n.faturamento)}</b></p>
      <p style="margin:6px 0 0">Lucro <b>${brl(n.lucro)}</b>${n.lucro_semana_anterior != null ? ` <span class="sub">(anterior: ${brl(n.lucro_semana_anterior)})</span>` : ''} · ${n.compras ?? 0} compras</p>
      ${n.clientes_sugeridos ? `<p style="margin:6px 0 0">Clientes sugeridos: ${n.clientes_sugeridos} · retomados ${n.retomados ?? 0} · convertidos ${n.convertidos ?? 0} · ficaram para trás ${n.ficaram_para_tras ?? 0}</p>` : ''}
    </div>
    ${w.resumo ? `<div class="painel resumo">${esc(w.resumo)}</div>` : ''}
    ${lista('✅ O que foi feito', w.feito)}
    ${lista('🏆 O que deu certo', w.deu_certo)}
    ${(w.ficou_pra_tras || []).length ? `<h2 style="margin:14px 0 8px">⏳ Ficou para trás</h2>${w.ficou_pra_tras.map((x) => ({ ...x, prioridade: 'media', _listaEm: w.geradoEm })).filter((x) => !acaoDe(x).excluido).map(cartao).join('')}` : ''}
    ${lista('🎯 Para a próxima semana', w.recomendacoes)}
    ${outras.length ? `<div class="painel dias" style="padding:0">${outras.map((x) => `<a href="#/semana/${esc(x.semana)}"><span>${esc(dataBR(x.inicio, false))} a ${esc(dataBR(x.fim, false))}</span><b>${x.numeros?.vendas ?? 0} vendas</b></a>`).join('')}</div>` : ''}`;
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
  } else if (h.startsWith('#/semana')) { html = telaSemana(h.split('/')[2]); aba = 'semana'; }
  else if (h.startsWith('#/historico')) { html = telaHistorico(); aba = 'historico'; }
  else if (h.startsWith('#/retornos')) { html = telaRetornos(); aba = 'hoje'; }
  else if (h.startsWith('#/espera')) { html = telaEspera(); aba = 'espera'; }
  else if (h.startsWith('#/vendas')) { html = telaVendas(); aba = 'vendas'; }
  else if (h.startsWith('#/comprar')) { html = telaComprar(); aba = 'comprar'; }
  else if (h.startsWith('#/ajustes')) { html = telaAjustes(); aba = 'ajustes'; }
  else html = telaDia(S.dias[0], 'Chamar hoje');
  $('#view').innerHTML = html;
  document.querySelectorAll('.abas a').forEach((a) => a.classList.toggle('ativa', a.dataset.aba === aba));
  $('#selo').textContent = S.ts ? `atualizado ${ago(S.ts)}` : '';
  if (aba === 'ajustes') ligarAjustes();
}
document.addEventListener('click', async (e) => {
  const ev = e.target.closest('[data-editar-valor]');
  if (ev) { S.editValor = ev.dataset.editarValor; rotear(); setTimeout(() => { const i = document.querySelector('.valor-item'); i?.focus(); i?.select(); }, 30); return; }
  const sv = e.target.closest('[data-salvar-valor]');
  if (sv) { salvarValorItem(sv.dataset.salvarValor, document.querySelector(`[data-valor-item="${CSS.escape(sv.dataset.salvarValor)}"]`)?.value); return; }
  const fv = e.target.closest('[data-fv]');
  if (fv) { e.preventDefault(); acaoFormVenda(fv); return; }
  const cg = e.target.closest('[data-corrigir-venda]');
  if (cg) { abrirFormVenda(cg.dataset.corrigirVenda); return; }
  const c = e.target.closest('[data-copiar]');
  if (c) {
    const x = S.cards[c.dataset.copiar];
    try { await navigator.clipboard.writeText(x?.mensagem || ''); toast('Mensagem copiada'); } catch { toast('Não consegui copiar'); }
    return;
  }
  const amp = e.target.closest('[data-ampliar]');
  if (amp) { ampliarFoto(amp.dataset.ampliar, Number(amp.dataset.i)); return; }
  if (e.target.closest('.foto-grande')) { e.target.closest('.foto-grande').remove(); return; }
  const of = e.target.closest('[data-oferta]');
  if (of) { marcarOferta(of.dataset.chave, of.dataset.oferta); return; }
  const mv = e.target.closest('[data-mover]');
  if (mv) { moverNaFila(mv.dataset.mover, Number(mv.dataset.dir)); return; }
  const dv = e.target.closest('[data-desvincular],[data-revincular]');
  if (dv) { vincular(dv.dataset.desvincular || dv.dataset.revincular, dv.dataset.uid, dv.dataset.desvincular ? 'desvincular' : 'desfazer'); return; }
  const b = e.target.closest('[data-acao]');
  if (b) { marcar(b.dataset.chave, b.dataset.acao, b.dataset.ligado === '1'); return; }
  if (e.target.closest('[data-mostrar-excluidos]')) { e.preventDefault(); S.mostrarExcluidos = !S.mostrarExcluidos; rotear(); }
  const cp = e.target.closest('[data-prep]');
  if (cp) { const k = cp.dataset.prep; salvarAcoes({ [k]: { feito: cp.checked, ts: Date.now() } }); return; }
  const bv = e.target.closest('[data-venda]');
  if (bv) { marcarVenda(bv.dataset.chave, bv.dataset.venda); return; }
  const cv = e.target.closest('[data-copiar-venda]');
  if (cv) {
    try { await navigator.clipboard.writeText(textoVenda(S.cards[cv.dataset.copiarVenda] || {})); toast('Resumo da venda copiado'); } catch { toast('Não consegui copiar'); }
  }
});
document.addEventListener('submit', (e) => {
  const f = e.target.closest('.form-venda');
  if (f) { e.preventDefault(); enviarFormVenda(f.closest('.modal')); }
});
document.addEventListener('keydown', (e) => {
  const i = e.target.closest('[data-valor-item]');
  if (i && e.key === 'Enter') salvarValorItem(i.dataset.valorItem, i.value);
  if (i && e.key === 'Escape') { S.editValor = ''; rotear(); }
});
document.addEventListener('input', (e) => { const it = e.target.closest('.fv-item'); if (it) atualizarItemVenda(it); });
document.addEventListener('change', (e) => {
  const it = e.target.closest('.fv-item');
  if (it) { atualizarItemVenda(it); return; }
  const sel = e.target.closest('[data-vincular-uid]');
  if (sel && sel.value) vincular(sel.value, sel.dataset.vincularUid, 'manual');
  const tr = e.target.closest('[data-trocar-item]');
  if (tr && tr.value) trocarUnidadeVenda(tr.dataset.trocarItem, tr.value);
});
// trocou de tela: volta ao topo (agora quem rola é o <main>, não a página)
window.addEventListener('hashchange', () => { rotear(); $('#view').scrollTop = 0; });
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
  if (cache?.dias) { S.dias = cache.dias; S.semanas = cache.semanas || []; S.noites = cache.noites || []; S.retornos = cache.retornos || []; S.espera = cache.espera || []; S.estoque = cache.estoque || []; S.ofertas = cache.ofertas || []; S.precos = cache.precos || {}; S.gestao = cache.gestao || {}; S.lancadas = cache.lancadas || {}; S.acoes = cache.acoes || {}; S.ts = cache.ts; }
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
rotear();
carregar();
conferirInscricao();
