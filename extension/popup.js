const $ = (id) => document.getElementById(id);
const fmt = (ms) => ms ? new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

function mostrar(est, proxima) {
  const linhas = [];
  if (est.rodando) linhas.push(`⏳ Coletando ${est.atual || ''}… (não use o Chrome por ~2 min)`);
  else if (est.fim) linhas.push(`Última coleta: ${fmt(est.fim)} (dia ${est.data})`);
  for (const [k, v] of Object.entries(est.fontes || {})) linhas.push(`• ${k}: ${v}`);
  if (proxima) linhas.push(`Próxima automática: ${fmt(proxima)}`);
  $('est').textContent = linhas.join('\n');
}

chrome.runtime.sendMessage({ tipo: 'info' }, ({ cfg, est, proxima }) => {
  for (const k of ['whatsapp', 'facebook', 'olx']) $(k).checked = !!cfg.fontes[k];
  $('perfil').value = cfg.perfil || '';
  $('hora').value = cfg.hora;
  $('ignorar').value = (cfg.ignorar || []).join('\n');
  mostrar(est, proxima);
});
chrome.runtime.onMessage.addListener((m) => { if (m.tipo === 'estado') mostrar(m.est); });

$('salvar').onclick = () => {
  const cfg = { fontes: { whatsapp: $('whatsapp').checked, facebook: $('facebook').checked, olx: $('olx').checked },
    perfil: $('perfil').value.trim(), hora: $('hora').value || '07:00', manha: true,
    ignorar: $('ignorar').value.split('\n').map((x) => x.trim()).filter(Boolean) };
  chrome.runtime.sendMessage({ tipo: 'salvar', cfg }, () => {
    chrome.runtime.sendMessage({ tipo: 'info' }, ({ est, proxima }) => mostrar(est, proxima));
  });
};
$('agora').onclick = () => chrome.runtime.sendMessage({ tipo: 'coletar' });
