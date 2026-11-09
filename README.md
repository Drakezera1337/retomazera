# Retomazera 📲

Uma vez por dia, alguns minutos depois que o PC é ligado, a extensão **Retomazera Coletor** (pasta `extension/`,
em cada perfil do Chrome) copia as mensagens desde a coleta anterior do WhatsApp Web, do Marketplace do Facebook
e do chat da OLX (só leitura) para `coletas/AAAA-MM-DD/`. A tarefa agendada do Claude confere a cada 30 min
(`pendente.py`), lê os arquivos e monta a lista de **quem chamar hoje para fechar venda**, com a sugestão de mensagem.

```
Tarefa agendada do Claude (00h) ──POST /api/lembretes──> server.py (PC, porta 8797)
     ├─ lembretes/AAAA-MM-DD.json (histórico no PC)
     ├─ lembretes.json no Gist secreto ──> app no celular (GitHub Pages)
     └─ Web Push (VAPID) ──> notificação "📲 N clientes para chamar hoje"
```

**Site:** https://drakezera1337.github.io/retomazera/

## PC
- O servidor inicia com o Windows, sem janela (atalho `Retomazera (servidor)` em `shell:startup`,
  `pythonw server.py`; mensagens em `server.log`). `iniciar.bat` roda com janela; `parar.bat` para.
- http://localhost:8797 → Ajustes → cole um token do GitHub (permissão **gist**) → **Conectar** → **Mostrar QR code**.
- Tarefa agendada: `C:\Users\Joao\.claude\scheduled-tasks\retomazera-diario\SKILL.md`.

## Celular
1. Abra o site → Ajustes → **📷 Ler QR do PC**
2. Instale (Chrome ⋮ → Instalar app; iPhone: Compartilhar → Adicionar à Tela de Início)
3. Ajustes → **🔔 Ativar notificações** → **Enviar teste**

## Publicar mudança
```bash
python versao.py
git add -A
git commit -m "..."
git push
```

Fora do git (só no PC): `push_vapid.pem`, `.vendor/`, `dados.json`, `lembretes/`.
