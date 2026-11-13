const $ = (id) => document.getElementById(id);
const fmt = (ms) => ms ? new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

function mostrar(est, auto, hoje, autoNoite, autoRonda) {
  const linhas = [];
  if (est.rodando) linhas.push(`⏳ Coletando ${est.atual || ''}… (não use o Chrome por ~2 min)`);
  else if (est.fim) linhas.push(`Última coleta: ${fmt(est.fim)} (dia ${est.data})`);
  for (const [k, v] of Object.entries(est.fontes || {})) linhas.push(`• ${k}: ${v}`);
  if (autoRonda && hoje && autoRonda.dia === hoje && autoRonda.slots) {
    const feitas = Object.entries(autoRonda.slots).filter(([, s]) => s.ok).map(([h]) => `${h}h`);
    if (feitas.length) linhas.push(`Rondas de hoje: ${feitas.join(', ')}`);
  }
  if (autoNoite && hoje && autoNoite.dia === hoje && autoNoite.ok) linhas.push(`Noite de hoje: feita às ${fmt(autoNoite.feitaEm)}`);
  if (auto && hoje) linhas.push(auto.dia === hoje && auto.ok ? `Automática de hoje: feita às ${fmt(auto.feitaEm)}` : 'Automática de hoje: pendente (roda alguns minutos depois de ligar o PC)');
  $('est').textContent = linhas.join('\n');
}

chrome.runtime.sendMessage({ tipo: 'info' }, ({ cfg, est, auto, hoje, autoNoite, autoRonda }) => {
  for (const k of ['whatsapp', 'facebook', 'olx', 'instagram']) $(k).checked = !!cfg.fontes[k];
  $('perfil').value = cfg.perfil || '';
  $('horaMin').value = cfg.horaMin ?? 6;
  $('espera').value = cfg.espera ?? 3;
  $('ignorar').value = (cfg.ignorar || []).join('\n');
  $('noite').checked = cfg.noite !== false;
  $('ronda').checked = cfg.ronda !== false;
  $('avisos').checked = cfg.avisos !== false;
  $('tudoMin').checked = !!cfg.tudoMinimizado;
  $('horaNoite').value = cfg.horaNoite ?? 21;
  mostrar(est, auto, hoje, autoNoite, autoRonda);
});
chrome.runtime.onMessage.addListener((m) => { if (m.tipo === 'estado') mostrar(m.est); });

$('salvar').onclick = () => {
  const cfg = { fontes: { whatsapp: $('whatsapp').checked, facebook: $('facebook').checked, olx: $('olx').checked, instagram: $('instagram').checked },
    perfil: $('perfil').value.trim(), horaMin: Number($('horaMin').value || 6), espera: Number($('espera').value || 3), noite: $('noite').checked, ronda: $('ronda').checked, avisos: $('avisos').checked, tudoMinimizado: $('tudoMin').checked, horaNoite: Number($('horaNoite').value || 21),
    ignorar: $('ignorar').value.split('\n').map((x) => x.trim()).filter(Boolean) };
  chrome.runtime.sendMessage({ tipo: 'salvar', cfg }, () => {
    chrome.runtime.sendMessage({ tipo: 'info' }, ({ est, auto, hoje, autoNoite, autoRonda }) => mostrar(est, auto, hoje, autoNoite, autoRonda));
  });
};
$('agora').onclick = () => chrome.runtime.sendMessage({ tipo: 'coletar' });
$('agoraNoite').onclick = () => chrome.runtime.sendMessage({ tipo: 'coletar', turno: 'noite' });
$('agoraRonda').onclick = () => chrome.runtime.sendMessage({ tipo: 'coletar', turno: 'ronda' });
$('testeMin').onclick = () => chrome.runtime.sendMessage({ tipo: 'testeMin' });
