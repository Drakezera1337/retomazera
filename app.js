// Retomazera — quem chamar de novo hoje para fechar venda.
// No PC (localhost) fala com o server.py; no celular (GitHub Pages) lê o Gist secreto.
const NO_PC = ['localhost', '127.0.0.1'].includes(location.hostname);
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const K = { cache: 'retomazera:cache', push: 'retomazera:push', acoesPendentes: 'retomazera:acoes-pendentes' };
const lerJSON = (k, p) => { try { return JSON.parse(localStorage.getItem(k)) ?? p; } catch { return p; } };
const gravarJSON = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem storage */ } };

const S = { dias: [], semanas: [], noites: [], retornos: [], espera: [], estoque: [], acoes: {}, cards: {}, mostrarExcluidos: false, ts: 0, status: null, carregando: false, erro: '' };

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
      S.dias = r.dias || []; S.semanas = r.semanas || []; S.noites = r.noites || []; S.retornos = r.retornos || []; S.espera = r.espera || []; S.estoque = r.estoque || []; S.acoes = r.acoes || {}; S.ts = r.ts;
      S.status = await api('status');
    } else if (Sync.enabled()) {
      const { 'lembretes.json': l, 'acoes.json': ac } = await Sync.ler({ 'lembretes.json': { dias: [] }, 'acoes.json': {} });
      S.dias = l.dias || []; S.semanas = l.semanas || []; S.noites = l.noites || []; S.retornos = l.retornos || []; S.espera = l.espera || []; S.estoque = l.estoque || []; S.ts = l.ts || 0;
      S.acoes = juntarAcoes(ac || {}, lerJSON(K.acoesPendentes, {}));
      gravarJSON(K.cache, { dias: S.dias, semanas: S.semanas, noites: S.noites, retornos: S.retornos, espera: S.espera, estoque: S.estoque, acoes: S.acoes, ts: S.ts });
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
function hojeIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function vendasMarcadas() {
  const porCliente = {};
  for (const dia of [...S.dias, ...S.noites].sort((a, b) => (a.geradoEm || 0) - (b.geradoEm || 0))) {
    for (const v of dia.agendadas || []) porCliente[chaveCliente(v)] = { ...v, _listaEm: dia.geradoEm };
  }
  return Object.values(porCliente).map((v) => ({ ...v, _chave: `venda:${chaveCliente(v)}:${v.data}` }))
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
      ${st.concluida ? '<span class="chip vend">Concluída</span>' : v.status === 'a confirmar' ? '<span class="chip media">A confirmar</span>' : '<span class="chip vend">Confirmada</span>'}
    </div>
    <p><b>${atrasada ? `⚠️ Era ${esc(dataBR(v.data, false))}` : v.data === hojeIso() ? 'Hoje' : esc(dataBR(v.data))}${v.hora ? ` · 🕒 ${esc(v.hora)}` : ''}</b>${v.local ? ` · 📍 ${esc(v.local)}` : ''}${v.entrega ? ` <span class="sub">(${esc(v.entrega)})</span>` : ''}</p>
    ${(v.itens || []).length ? `<ul class="venda-itens">${v.itens.map((i) => `<li>${esc(i.descricao)}${brlV(i.valor) ? ` <span class="sub">— ${esc(brlV(i.valor))}</span>` : ''}</li>`).join('')}</ul>` : ''}
    ${brlV(v.total) ? `<p class="venda-total">Total: <b>${esc(brlV(v.total))}</b></p>` : ''}
    ${v.pagamento ? `<p>💳 ${esc(v.pagamento)}</p>` : ''}
    ${v.entrada ? `<p>🔁 Entrada: ${esc(v.entrada)}</p>` : ''}
    ${v.observacoes ? `<p>📝 ${esc(v.observacoes)}</p>` : ''}
    ${v.resumo ? `<p class="sub">${esc(v.resumo)}</p>` : ''}
    <div class="acoes">
      ${link ? `<a class="btn btn-verde" href="${esc(link.split('?')[0])}" target="_blank" rel="noopener">💬 Abrir conversa</a>` : ''}
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
    ${futuros.length ? `<p class="sub"><a href="#/retornos">📅 ${futuros.length} retorno(s) combinado(s) para os próximos dias — ver</a></p>` : ''}`;
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
    ${fila ? `<p class="sub"><a href="#/espera">⏳ ${fila} cliente(s) na fila de espera — ver</a></p>` : ''}`;
}
// unidades da Gestão (disponíveis e chegando) do modelo, com foto, custo e para quem cada uma vai.
// A divisão é refeita aqui (e não só no PC) para o "Desvincular" valer na hora: o primeiro da fila pega a
// primeira unidade que o atende, pulando as que o João desvinculou dele (acoes[cliente].semUnidade).
function alocarFila() {
  const porUid = {}, porChave = {};
  const fila = esperaAtiva().slice().sort((a, b) => (a.desde || '').localeCompare(b.desde || ''));
  const serve = (x, e) => (x.atende ? x.atende.includes(e.chave) : x.para === e.chave);
  const fora = (e) => S.acoes[chaveCliente(e)]?.semUnidade || [];
  const dar = (e, u) => { porUid[u.uid] = e; porChave[e.chave] = u; };
  const tirar = (u) => { const e = porUid[u.uid]; if (e) delete porChave[e.chave]; delete porUid[u.uid]; };
  // 1) divisão normal; 2) vínculos manuais (o mais recente vence) tomam a unidade de quem estava com ela;
  // 3) quem teve a unidade desvinculada larga ela (fica livre, sem mexer nos outros);
  // 4) quem ficou sem unidade pega uma que sobrou e que não foi desvinculada dele
  for (const e of fila) { const u = S.estoque.find((x) => !porUid[x.uid] && serve(x, e)); if (u) dar(e, u); }
  const largadas = new Set();
  const manuais = fila.map((e) => ({ e, v: S.acoes[chaveCliente(e)]?.vinculos?.[e.familia] }))
    .filter((m) => m.v && S.estoque.some((x) => x.uid === m.v.uid)).sort((a, b) => (a.v.em || 0) - (b.v.em || 0));
  const fixos = new Set();
  for (const { e, v } of manuais) {
    const u = S.estoque.find((x) => x.uid === v.uid);
    const antiga = porChave[e.chave];
    if (antiga && antiga.uid !== u.uid) { tirar(antiga); largadas.add(antiga.uid); }
    if (porUid[u.uid] && fixos.has(u.uid)) { const outro = porUid[u.uid]; tirar(u); delete porChave[outro.chave]; }
    tirar(u); dar(e, u); fixos.add(u.uid);
  }
  for (const e of fila) { const u = porChave[e.chave]; if (u && !fixos.has(u.uid) && fora(e).includes(u.uid)) { delete porUid[u.uid]; delete porChave[e.chave]; largadas.add(u.uid); } }
  for (const e of fila) {
    if (porChave[e.chave]) continue;
    const u = S.estoque.find((x) => !porUid[x.uid] && !largadas.has(x.uid) && !fora(e).includes(x.uid) && serve(x, e))
      || S.estoque.find((x) => !porUid[x.uid] && !fora(e).includes(x.uid) && serve(x, e));
    if (u) dar(e, u);
  }
  return { porUid, porChave, fixos };
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
  const desvinculados = esperaAtiva().filter((e) => (S.acoes[chaveCliente(e)]?.semUnidade || []).includes(u.uid));
  const st = u.situacao === 'disponivel' ? '<span class="st-ok">✅ Disponível</span>' : '<span class="st-chegando">🚚 Chegando</span>';
  const lucro = u.preco && u.custo ? Number(u.preco) - Number(u.custo) : null;
  return `<div class="unidade">
    ${u.foto ? `<img src="${u.foto}" alt="" loading="lazy">` : `<div class="sem-foto">${ICONE_FAMILIA(u.familia)}</div>`}
    <div class="unidade-txt"><b>${esc(u.nome || u.item)}</b>
      <div>${st}</div>
      <div>Custo <b>${brlV(u.custo) || '—'}</b>${u.preco ? ` · Venda ${brlV(u.preco)}` : ''}${lucro != null ? ` · <span class="lucro">+${brlV(lucro)}</span>` : ''}</div>
      <div class="para">${dono ? `➡️ Para <b>${esc(dono.nome)}</b>${aloc.fixos.has(u.uid) ? ' 📌' : ''} <button class="btn btn-mini" data-desvincular="${esc(dono.chave)}" data-uid="${esc(u.uid)}">✖ Desvincular</button>` : '🆓 Sem cliente da fila'}</div>
      <select class="vincular" data-vincular-uid="${esc(u.uid)}"><option value="">🔗 Vincular a outro cliente…</option>${esperaAtiva().filter((e) => e.familia === u.familia && e !== dono).map((e) => `<option value="${esc(e.chave)}">${esc(e.nome)}${aloc.porChave[e.chave] ? ' (troca a unidade dele)' : ''}</option>`).join('')}</select>
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
  const vaiUsar = (e) => { const u = aloc.porChave[e.chave]; return u ? `${u.situacao === 'disponivel' ? '✅' : '🚚'} Vai usar: ${u.nome || u.item} (custo ${brlV(u.custo)})` : ''; };
  return `<h1>⏳ Fila de espera</h1><p class="sub">Clientes esperando um modelo sem estoque. Quando a Gestão tiver o item em "Aguardando venda", você recebe a notificação e eles aparecem na aba Hoje. Cada unidade vai para o primeiro da fila que ela atende.</p>
    ${Object.keys(porFamilia).length ? Object.entries(porFamilia).map(([f, l]) => `<h2 style="margin:14px 0 8px">${esc(f)} (${l.length})${l.some((e) => e.chegou) ? ' · 🔔 tem no estoque' : ''}</h2>${blocoEstoque(f)}${l.map((e) => cardEspera(e, Boolean(e.chegou), vaiUsar(e))).join('')}`).join('') : '<div class="vazio">Ninguém na fila de espera.</div>'}`;
}

function telaRetornos() {
  const futuros = S.retornos.filter((r) => r.data >= hojeIso() && !acaoDe(r).excluido);
  return `<h1>📅 Retornos combinados</h1><p class="sub">Clientes que pediram para ser chamados numa data. No dia, aparecem na aba Hoje.</p>
    ${futuros.length ? futuros.map((r) => cartao({ ...r, prioridade: 'media', situacao: `Chamar em ${dataBR(r.data)} · ${r.pedido || ''}` })).join('') : '<div class="vazio">Nenhum retorno combinado.</div>'}`;
}

function blocoVendas() {
  const hoje = hojeIso();
  const limiteAtraso = new Date(Date.now() - 3 * 864e5);
  const todas = vendasMarcadas().filter((v) => !(S.acoes[v._chave] || {}).cancelada);
  const doDia = todas.filter((v) => v.data === hoje);
  const atrasadas = todas.filter((v) => v.data < hoje && new Date(v.data) >= limiteAtraso && !(S.acoes[v._chave] || {}).concluida);
  const proximas = todas.filter((v) => v.data > hoje);
  if (!doDia.length && !atrasadas.length && !proximas.length) return '';
  const total = doDia.filter((v) => !(S.acoes[v._chave] || {}).concluida).reduce((s, v) => s + (Number(v.total) || 0), 0);
  return `<h2 style="margin:4px 0 8px">📦 Vendas do dia${doDia.length ? ` (${doDia.length})` : ''}</h2>
    ${doDia.length ? `${total ? `<p class="sub">A receber hoje: <b>${esc(brlV(total))}</b></p>` : ''}${doDia.map(cartaoVenda).join('')}` : '<p class="sub">Nenhuma venda marcada para hoje.</p>'}
    ${atrasadas.length ? `<h2 style="margin:14px 0 8px">⚠️ Ficaram pendentes</h2>${atrasadas.map(cartaoVenda).join('')}` : ''}
    ${proximas.length ? `<h2 style="margin:14px 0 8px">🗓️ Próximas</h2>${proximas.map(cartaoVenda).join('')}` : ''}
    <h2 style="margin:18px 0 8px">📲 Para chamar</h2>`;
}

// ---------------------------------------------------------------- telas
const CANAIS = { whatsapp: ['wpp', 'WhatsApp'], facebook: ['fb', 'Facebook'], olx: ['olx', 'OLX'], instagram: ['ig', 'Instagram'] };
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
      ${link ? `<a class="btn btn-verde" href="${esc(link)}" target="_blank" rel="noopener">💬 Abrir conversa</a>` : ''}
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
    return `<h1>Chamar hoje</h1>${blocoNoite()}${blocoChegou()}${blocoVendas()}${blocoRetornos(new Set())}<div class="vazio">A lista de quem chamar chega uns minutos depois que o PC é ligado.</div>`;
  }
  if (!dia) {
    const conectar = !NO_PC && !Sync.enabled();
    return `<div class="vazio">${S.carregando ? 'Carregando…' : conectar
      ? 'Conecte ao PC: no PC abra o Retomazera → Ajustes → <b>Mostrar QR code</b>. Aqui: Ajustes → <b>Ler QR do PC</b>.'
      : 'Ainda não há lista. Ela chega todo dia uns minutos depois que o PC é ligado.'}
      ${S.erro ? `<br><br>⚠️ ${esc(S.erro)}` : ''}</div>`;
  }
  const todos = (dia.itens || []).map((x) => ({ ...x, _listaEm: dia.geradoEm }));
  const excluidos = todos.filter((x) => acaoDe(x).excluido);
  const itens = todos.filter((x) => !acaoDe(x).excluido);
  // fixados primeiro, vendidos no fim; dentro disso, por prioridade
  const ordem = { alta: 0, media: 1, média: 1, baixa: 2 };
  const peso = (x) => { const a = acaoDe(x); return (a.fixado ? 0 : 10) + (a.vendido ? 100 : 0) + (ordem[x.prioridade] ?? 3); };
  itens.sort((a, b) => peso(a) - peso(b));
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
    <div class="contagem">
      <span class="chip">${itens.length} para chamar · ${pendentes} pendente(s)</span>
      ${Object.entries(porCanal).map(([c, n]) => { const [cls, nm] = CANAIS[c] || ['', c]; return `<span class="chip ${cls}">${esc(nm)} ${n}</span>`; }).join('')}
    </div>
    ${titulo === 'Chamar hoje' ? blocoNoite() + blocoChegou() + blocoVendas() + blocoRetornos(chavesDoDia) : ''}
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
    const x = S.cards[c.dataset.copiar];
    try { await navigator.clipboard.writeText(x?.mensagem || ''); toast('Mensagem copiada'); } catch { toast('Não consegui copiar'); }
    return;
  }
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
document.addEventListener('change', (e) => {
  const sel = e.target.closest('[data-vincular-uid]');
  if (sel && sel.value) vincular(sel.value, sel.dataset.vincularUid, 'manual');
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
  if (cache?.dias) { S.dias = cache.dias; S.semanas = cache.semanas || []; S.noites = cache.noites || []; S.retornos = cache.retornos || []; S.espera = cache.espera || []; S.estoque = cache.estoque || []; S.acoes = cache.acoes || {}; S.ts = cache.ts; }
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
rotear();
carregar();
conferirInscricao();
