"""
Retomazera - servidor local.

Uma vez por dia, ao ligar o PC, a extensão Retomazera Coletor (em cada perfil do Chrome) manda
as conversas desde a coleta anterior (WhatsApp Web, Marketplace do Facebook, chat da OLX) para
POST /api/coleta. Quando as 3 fontes chegam (ou 20 min depois da primeira), este servidor chama o
Claude Code de linha de comando (claude -p, instruções em analise_prompt.md), que lê os arquivos e
grava coletas/AAAA-MM-DD/resultado.json — daí sai a lista de quem chamar hoje.

Este servidor:
- guarda a lista em lembretes/AAAA-MM-DD.json (no PC);
- publica os últimos dias em lembretes.json num Gist secreto (o app do celular lê dali);
- envia Web Push (VAPID, pywebpush em .vendor/) aos aparelhos inscritos em push.json do Gist.

Mesmo esquema do Ofertazera / Rastreazera. Sem console (pythonw.exe, atalho
"Retomazera (servidor)" na pasta Inicializar): mensagens e erros vão para server.log.

Rode:  python server.py      (iniciar.bat abre com janela; parar.bat para)
"""
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("RETOMAZERA_PORT", "8797"))
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DADOS = os.path.join(BASE_DIR, "dados.json")          # token/gist/inscrição do PC (fora do git)
PASTA_DIAS = os.path.join(BASE_DIR, "lembretes")      # histórico local (fora do git)
PASTA_COLETAS = os.path.join(BASE_DIR, "coletas")     # mensagens copiadas pela extensão (fora do git)
PASTA_SEMANAS = os.path.join(BASE_DIR, "semanas")     # resumos semanais (fora do git)
ACOES = os.path.join(BASE_DIR, "acoes.json")          # Fixar/Já chamei/Vendido/Excluir por cliente (fora do git; cópia no Gist)
NOMES_FONTES = {"whatsapp": "WhatsApp", "facebook": "Facebook", "olx": "OLX", "instagram": "Instagram"}
SITE_PUBLICO = "https://drakezera1337.github.io/retomazera/"
PUSH_PEM = os.path.join(BASE_DIR, "push_vapid.pem")
PUSH_CONTATO = "mailto:276884055+Drakezera1337@users.noreply.github.com"
GIST_API = "https://api.github.com/gists"
GIST_DESCRICAO = "Retomazera – clientes para chamar de novo"
DIAS_NO_GIST = 14
GIST_LER_S = 30

_lock = threading.Lock()
_push = {"inscricoes": [], "testes": {}}
_webpush = None


# --------------------------------------------------------------------------- dados locais
def ler_dados():
    try:
        with open(DADOS, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def gravar_dados(**mudancas):
    with _lock:
        d = ler_dados()
        d.update(mudancas)
        tmp = DADOS + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=1)
        os.replace(tmp, DADOS)


def dias_locais(limite=DIAS_NO_GIST):
    if not os.path.isdir(PASTA_DIAS):
        return []
    nomes = sorted((n for n in os.listdir(PASTA_DIAS) if re.fullmatch(r"\d{4}-\d{2}-\d{2}\.json", n)), reverse=True)
    saida = []
    for n in nomes[:limite]:
        try:
            with open(os.path.join(PASTA_DIAS, n), encoding="utf-8") as f:
                saida.append(json.load(f))
        except (OSError, ValueError):
            pass
    return saida


def semanas_locais(limite=8):
    if not os.path.isdir(PASTA_SEMANAS):
        return []
    nomes = sorted((n for n in os.listdir(PASTA_SEMANAS) if re.fullmatch(r"\d{4}-S\d{2}\.json", n)), reverse=True)
    saida = []
    for n in nomes[:limite]:
        try:
            with open(os.path.join(PASTA_SEMANAS, n), encoding="utf-8") as f:
                saida.append(json.load(f))
        except (OSError, ValueError):
            pass
    return saida


# --------------------------------------------------------------------------- ações dos cards
def ler_acoes():
    try:
        with open(ACOES, encoding="utf-8") as f:
            d = json.load(f)
            return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def juntar_acoes(a, b):
    """Por cliente, vale a ação mais recente (ts)."""
    r = dict(a)
    for k, v in (b or {}).items():
        if isinstance(v, dict) and (k not in r or (v.get("ts") or 0) >= (r[k].get("ts") or 0)):
            r[k] = v
    return r


def gravar_acoes(novas):
    """Junta no arquivo local e devolve o mapa completo."""
    with _lock:
        tudo = juntar_acoes(ler_acoes(), novas)
        tmp = ACOES + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(tudo, f, ensure_ascii=False, indent=1)
        os.replace(tmp, ACOES)
    return tudo


# --------------------------------------------------------------------------- Gist
def gist_cfg():
    d = ler_dados()
    return {"token": d["gist_token"], "gistId": d["gist_id"]} if d.get("gist_token") and d.get("gist_id") else None


def github(url, token, method="GET", corpo=None):
    req = urllib.request.Request(
        url, method=method, data=json.dumps(corpo).encode() if corpo is not None else None,
        headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
                 "Content-Type": "application/json", "User-Agent": "Retomazera"})
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.loads(res.read())


def gist_request(method="GET", corpo=None):
    cfg = gist_cfg()
    return github(f"{GIST_API}/{cfg['gistId']}", cfg["token"], method, corpo)


def conectar_gist(token):
    """Usa o Gist do Retomazera que já existe na conta; senão cria um (secreto)."""
    lista = github(f"{GIST_API}?per_page=100", token)
    existente = next((g for g in lista if g.get("description") == GIST_DESCRICAO), None)
    if existente:
        gid, criado = existente["id"], False
    else:
        gid = github(GIST_API, token, "POST", {
            "description": GIST_DESCRICAO, "public": False,
            "files": {"lembretes.json": {"content": '{"dias": []}'}, "push.json": {"content": "[]"}}})["id"]
        criado = True
    gravar_dados(gist_token=token, gist_id=gid)
    publicar_gist()
    return gid, criado


def json_do_arquivo(arquivos, nome, padrao):
    arq = arquivos.get(nome)
    if not arq:
        return padrao
    conteudo = arq.get("content") or ""
    if arq.get("truncated") and arq.get("raw_url"):
        with urllib.request.urlopen(arq["raw_url"], timeout=30) as r:
            conteudo = r.read().decode("utf-8")
    try:
        return json.loads(conteudo) if conteudo else padrao
    except ValueError:
        return padrao


def publicar_gist():
    if not gist_cfg():
        return False
    corpo = {"dias": dias_locais(), "semanas": semanas_locais(), "ts": int(time.time() * 1000)}
    gist_request("PATCH", {"files": {"lembretes.json": {"content": json.dumps(corpo, ensure_ascii=False)}}})
    return True


# --------------------------------------------------------------------------- Web Push
def carregar_webpush():
    global _webpush
    if _webpush is None:
        vendor = os.path.join(BASE_DIR, ".vendor")
        if vendor not in sys.path:
            sys.path.insert(0, vendor)
        try:
            from pywebpush import WebPushException, webpush
            _webpush = (webpush, WebPushException)
        except ImportError as exc:
            print(f"[push] desligado: pywebpush não encontrado em .vendor ({exc})")
            _webpush = False
    return _webpush or None


def inscricoes_pc():
    return [i for i in ler_dados().get("push_pc", []) if i.get("endpoint") and i.get("keys")]


def enviar_push(payload, inscricoes=None):
    """Envia aos aparelhos inscritos (celulares do Gist + Chrome deste PC); tira os que não existem mais."""
    lib = carregar_webpush()
    if inscricoes is None:
        with _lock:
            inscricoes = list(_push["inscricoes"])
        inscricoes += inscricoes_pc()
    if not lib or not inscricoes or not os.path.exists(PUSH_PEM):
        return 0
    webpush, WebPushException = lib
    mortos, ok = [], 0
    for insc in inscricoes:
        try:
            webpush(subscription_info={"endpoint": insc["endpoint"], "keys": insc["keys"]},
                    data=json.dumps(payload, ensure_ascii=False), vapid_private_key=PUSH_PEM,
                    vapid_claims={"sub": PUSH_CONTATO}, ttl=12 * 3600, timeout=15,
                    headers={"Urgency": "high"})
            ok += 1
        except WebPushException as exc:
            if getattr(exc.response, "status_code", None) in (404, 410):
                mortos.append(insc["endpoint"])
            print(f"[push] {insc.get('aparelho', '?')}: {exc}")
        except (KeyError, TypeError) as exc:
            print(f"[push] inscrição inválida: {exc}")
    if mortos:
        pc = inscricoes_pc()
        if any(i["endpoint"] in mortos for i in pc):
            gravar_dados(push_pc=[i for i in pc if i["endpoint"] not in mortos])
        if gist_cfg():
            with _lock:
                _push["inscricoes"] = [i for i in _push["inscricoes"] if i["endpoint"] not in mortos]
                vivos = list(_push["inscricoes"])
            try:
                gist_request("PATCH", {"files": {"push.json": {"content": json.dumps(vivos, indent=1)}}})
            except Exception as exc:  # noqa: BLE001
                print(f"[push] não consegui limpar push.json: {exc}")
    return ok


def payload_dia(dia):
    itens = dia.get("itens") or []
    data_br = "/".join(reversed(dia.get("data", "").split("-"))) if dia.get("data") else ""
    hoje = [a for a in dia.get("agendadas") or [] if a.get("data") == dia.get("data")]
    if hoje:
        n_v = len(hoje)
        quem = " · ".join(f"{a.get('hora') or ''} {a.get('nome') or '?'}".strip() for a in hoje[:3])
        extra = f" | +{len(itens)} para chamar" if itens else ""
        return {"title": f"📦 {n_v} venda{'s' if n_v > 1 else ''} marcada{'s' if n_v > 1 else ''} para hoje",
                "body": quem + extra, "tag": "retomazera-" + dia.get("data", ""), "data": dia.get("data", "")}
    if not itens:
        return {"title": "Retomazera", "body": f"Conversas de {data_br}: ninguém para retomar hoje.",
                "tag": "retomazera-" + dia.get("data", ""), "data": dia.get("data", "")}
    ordem = {"alta": 0, "media": 1, "média": 1, "baixa": 2}
    top = sorted(itens, key=lambda x: ordem.get(str(x.get("prioridade", "")).lower(), 3))[:3]
    nomes = " · ".join(f"{x.get('nome') or '?'} ({x.get('produto') or x.get('canal') or ''})".replace(" ()", "") for x in top)
    resto = f" e mais {len(itens) - 3}" if len(itens) > 3 else ""
    n = len(itens)
    return {"title": f"📲 {n} cliente{'s' if n > 1 else ''} para chamar hoje",
            "body": nomes + resto, "tag": "retomazera-" + dia.get("data", ""), "data": dia.get("data", "")}


# --------------------------------------------------------------------------- lembretes
def salvar_dia(corpo):
    data = str(corpo.get("data") or "")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", data):
        raise ValueError("campo 'data' deve ser AAAA-MM-DD")
    itens = corpo.get("itens") or []
    if not isinstance(itens, list):
        raise ValueError("campo 'itens' deve ser uma lista")
    limpos = []
    for i, x in enumerate(itens):
        if not isinstance(x, dict):
            continue
        limpos.append({
            "id": str(x.get("id") or f"{data}-{i}"),
            "nome": str(x.get("nome") or "")[:80],
            "canal": str(x.get("canal") or "")[:20],
            "contato": str(x.get("contato") or "")[:200],
            "produto": str(x.get("produto") or "")[:80],
            "prioridade": str(x.get("prioridade") or "media").lower()[:10],
            "situacao": str(x.get("situacao") or "")[:400],
            "motivo": str(x.get("motivo") or "")[:400],
            "mensagem": str(x.get("mensagem") or "")[:600],
            "ultimaMsg": str(x.get("ultimaMsg") or "")[:300],
            "quando": str(x.get("quando") or "")[:20],
        })
    agendadas = []
    for x in corpo.get("agendadas") or []:
        if not isinstance(x, dict) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(x.get("data") or "")):
            continue
        txt = lambda k, n=200: str(x.get(k) or "")[:n]
        itens_v = [{"descricao": str(i.get("descricao") or "")[:120], "valor": i.get("valor")}
                   for i in (x.get("itens") or []) if isinstance(i, dict)][:10]
        agendadas.append({
            "nome": txt("nome", 80), "canal": txt("canal", 20), "contato": txt("contato"),
            "data": txt("data", 10), "hora": txt("hora", 30), "local": txt("local", 200), "entrega": txt("entrega", 60),
            "itens": itens_v, "total": x.get("total"), "pagamento": txt("pagamento", 200),
            "entrada": txt("entrada", 200), "status": txt("status", 20) or "confirmada",
            "observacoes": txt("observacoes", 400), "resumo": txt("resumo", 400),
        })
    dia = {"data": data, "geradoEm": int(time.time() * 1000), "resumo": str(corpo.get("resumo") or "")[:1500],
           "fontes": corpo.get("fontes") if isinstance(corpo.get("fontes"), dict) else {}, "itens": limpos,
           "agendadas": agendadas}
    os.makedirs(PASTA_DIAS, exist_ok=True)
    with open(os.path.join(PASTA_DIAS, data + ".json"), "w", encoding="utf-8") as f:
        json.dump(dia, f, ensure_ascii=False, indent=1)
    return dia


# --------------------------------------------------------------------------- coletas da extensão
def salvar_coleta(corpo):
    """Grava coletas/AAAA-MM-DD/<fonte>.json e refaz o conversas.txt (as 3 fontes juntas, para o Claude ler)."""
    data, fonte = str(corpo.get("data") or ""), str(corpo.get("fonte") or "")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", data) or fonte not in NOMES_FONTES:
        raise ValueError("data ou fonte inválida")
    pasta = os.path.join(PASTA_COLETAS, data)
    os.makedirs(pasta, exist_ok=True)
    with open(os.path.join(pasta, fonte + ".json"), "w", encoding="utf-8") as f:
        json.dump(corpo, f, ensure_ascii=False, indent=1)
    # cada perfil do Chrome diz quais fontes coleta: a análise espera a soma de todos
    if isinstance(corpo.get("lote"), list):
        lotes = ler_dados().get("fontes_perfis", {})
        lotes[str(corpo.get("perfil") or "?")] = [f for f in corpo["lote"] if f in NOMES_FONTES]
        gravar_dados(fontes_perfis=lotes)
    gerar_texto(data)
    return len(corpo.get("conversas") or [])


def coletas_do_dia(data):
    pasta = os.path.join(PASTA_COLETAS, data)
    saida = {}
    for fonte in NOMES_FONTES:
        try:
            with open(os.path.join(pasta, fonte + ".json"), encoding="utf-8") as f:
                saida[fonte] = json.load(f)
        except (OSError, ValueError):
            pass
    return saida


def gerar_texto(data):
    """Texto compacto: cabeçalho por conversa e uma linha por mensagem (J = João, C = cliente)."""
    linhas = [f"CONVERSAS DE {data} (J = João/loja, C = cliente)", ""]
    for fonte, c in coletas_do_dia(data).items():
        quando = time.strftime("%d/%m %H:%M", time.localtime((c.get("coletadoEm") or 0) / 1000))
        convs = c.get("conversas") or []
        linhas.append(f"======== {NOMES_FONTES[fonte]} — {len(convs)} conversa(s) — coletado {quando}"
                      + (f" — perfil {c['perfil']}" if c.get("perfil") else ""))
        if c.get("desde"):
            fmt = lambda ms: time.strftime("%d/%m %H:%M", time.localtime(ms / 1000))
            linhas.append(f"período: mensagens desde {fmt(c['desde'])} até {fmt(c.get('ate') or c.get('coletadoEm') or 0)}")
        if c.get("erro"):
            linhas.append(f"ERRO NA COLETA: {c['erro']}")
        if c.get("aviso"):
            linhas.append(f"aviso: {c['aviso']}")
        for i, cv in enumerate(convs, 1):
            linhas.append("")
            cab = f"### {NOMES_FONTES[fonte]} #{i} | {cv.get('nome') or '?'}"
            if cv.get("anuncio"):
                cab += f" | anúncio: {cv['anuncio']}"
            cab += f" | contato: {cv.get('contato') or '—'}"
            if cv.get("rotulo"):
                cab += f" | última atividade: {cv['rotulo']}"
            linhas.append(cab)
            if cv.get("aviso"):
                linhas.append(f"(aviso: {cv['aviso']})")
            dia_atual = None
            for m in cv.get("mensagens") or []:
                if m.get("data") and m["data"] != dia_atual:
                    dia_atual = m["data"]
                    linhas.append(f"[{'/'.join(reversed(dia_atual.split('-')))}]")
                texto = " ".join(str(m.get("texto") or "").split())
                linhas.append(f"{m.get('hora') or '--:--'} {'J' if m.get('eu') else 'C'}: {texto}")
        linhas.append("")
    with open(os.path.join(PASTA_COLETAS, data, "conversas.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(linhas))


# --------------------------------------------------------------------------- análise pelo Claude Code
ESPERA_FONTES_S = 20 * 60      # espera as outras fontes até 20 min depois da primeira
ANALISE_TIMEOUT_S = 20 * 60
_analise = {"rodando": False, "timer": None, "lock": threading.Lock()}


def claude_exe():
    return shutil.which("claude") or os.path.expanduser(r"~\.local\bin\claude.exe")


def chamar_claude(prompt, arquivo_log):
    """Roda `claude -p` na pasta do Retomazera, só com leitura/gravação de arquivos e python."""
    cmd = [claude_exe(), "-p", "--allowedTools", "Read", "Write", "Grep", "Glob", "Bash(python:*)", "Bash(python -X utf8:*)",
           "--output-format", "text"]
    inicio = time.time()
    r = subprocess.run(cmd, input=prompt, capture_output=True, text=True, encoding="utf-8", errors="replace",
                       cwd=BASE_DIR, timeout=ANALISE_TIMEOUT_S, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    os.makedirs(os.path.dirname(arquivo_log), exist_ok=True)
    with open(arquivo_log, "w", encoding="utf-8") as f:
        f.write(f"código {r.returncode} em {time.time() - inicio:.0f} s\n\n--- saída ---\n{r.stdout}\n--- erros ---\n{r.stderr}")
    return r


def fontes_esperadas():
    lotes = ler_dados().get("fontes_perfis") or {}
    esperadas = {f for lista in lotes.values() for f in lista}
    return esperadas or {"whatsapp", "facebook", "olx"}


def ja_analisada(data):
    # True se o resultado do dia é mais novo que a última coleta recebida.
    coletas = coletas_do_dia(data)
    if not coletas:
        return True
    ultima = max((c.get("coletadoEm") or 0) for c in coletas.values())
    try:
        with open(os.path.join(PASTA_DIAS, data + ".json"), encoding="utf-8") as f:
            return (json.load(f).get("geradoEm") or 0) >= ultima
    except (OSError, ValueError):
        return False


def agendar_analise(data):
    # Chamado a cada coleta recebida: analisa já se as 3 fontes chegaram; senão, em até 20 min.
    coletas = coletas_do_dia(data)
    completas = all(f in coletas for f in fontes_esperadas())
    primeira = min((c.get("coletadoEm") or 0) for c in coletas.values()) / 1000
    atraso = 30 if completas else max(30, ESPERA_FONTES_S - (time.time() - primeira))
    with _analise["lock"]:
        if _analise["timer"]:
            _analise["timer"].cancel()
        t = threading.Timer(atraso, analisar, args=(data,))
        t.daemon = True
        _analise["timer"] = t
        t.start()
    print(f"[análise] {data}: {'todas as fontes chegaram' if completas else 'esperando as outras fontes'}; roda em {int(atraso)} s")


def analisar(data, notificar=True, forcar=False):
    # Roda `claude -p` com analise_prompt.md, lê o resultado.json e publica (Gist + push).
    with _analise["lock"]:
        if _analise["rodando"]:
            print("[análise] já tem uma rodando")
            return False
        if not forcar and ja_analisada(data):
            print(f"[análise] {data} já analisada")
            return False
        _analise["rodando"] = True
    pasta = os.path.join(PASTA_COLETAS, data)
    saida = os.path.join(pasta, "resultado.json")
    try:
        with open(os.path.join(BASE_DIR, "analise_prompt.md"), encoding="utf-8") as f:
            prompt = f.read().replace("{DATA}", data)
        if os.path.exists(saida):
            os.remove(saida)
        print(f"[análise] {data}: chamando o Claude Code…")
        inicio = time.time()
        r = chamar_claude(prompt, os.path.join(pasta, "analise.log"))
        if not os.path.exists(saida):
            raise RuntimeError(f"o Claude não gravou resultado.json (código {r.returncode}; veja coletas/{data}/analise.log)")
        with open(saida, encoding="utf-8") as f:
            corpo = json.load(f)
        corpo["data"] = data
        dia = salvar_dia(corpo)
        try:
            publicar_gist()
        except Exception as exc:  # noqa: BLE001
            print(f"[gist] publicar: {exc}")
        enviados = enviar_push(payload_dia(dia)) if notificar else 0
        print(f"[análise] {data}: {len(dia['itens'])} cliente(s), push={enviados}, {time.time() - inicio:.0f} s")
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"[análise] {data}: FALHOU — {exc}")
        enviar_push({"title": "Retomazera ⚠️", "body": f"A análise de hoje falhou: {str(exc)[:150]}", "tag": "retomazera-erro"}) if notificar else None
        return False
    finally:
        _analise["rodando"] = False
        # primeira análise de uma semana nova: faz o resumo da semana que passou
        try:
            ini, _fim, chave = semana_anterior()
            if notificar and not os.path.exists(os.path.join(PASTA_SEMANAS, chave + ".json")):
                analisar_semana()
        except Exception as exc:  # noqa: BLE001
            print(f"[semana] {exc}")


def semana_anterior(hoje=None):
    """(início, fim, chave) da semana anterior (segunda a domingo). Chave: AAAA-Snn (semana ISO)."""
    hoje = hoje or date.today()
    ini = hoje - timedelta(days=hoje.weekday() + 7)
    fim = ini + timedelta(days=6)
    ano, sem, _ = ini.isocalendar()
    return ini.isoformat(), fim.isoformat(), f"{ano}-S{sem:02d}"


def analisar_semana(notificar=True, forcar=False):
    ini, fim, chave = semana_anterior()
    arquivo = os.path.join(PASTA_SEMANAS, chave + ".json")
    with _analise["lock"]:
        if _analise["rodando"] or (os.path.exists(arquivo) and not forcar):
            return False
        _analise["rodando"] = True
    try:
        os.makedirs(PASTA_SEMANAS, exist_ok=True)
        d0 = date.fromisoformat(ini)
        dias = [(d0 + timedelta(days=i)).isoformat() for i in range(7)]
        com_lista = [d for d in dias if os.path.exists(os.path.join(PASTA_DIAS, d + ".json"))]
        with open(os.path.join(BASE_DIR, "semanal_prompt.md"), encoding="utf-8") as f:
            prompt = (f.read().replace("{INICIO}", ini).replace("{FIM}", fim).replace("{CHAVE}", chave)
                      .replace("{DIAS}", ", ".join(com_lista) or "nenhuma lista diária nessa semana"))
        if os.path.exists(arquivo):
            os.remove(arquivo)
        print(f"[semana] {chave} ({ini} a {fim}): chamando o Claude Code…")
        inicio = time.time()
        r = chamar_claude(prompt, os.path.join(PASTA_SEMANAS, chave + ".log"))
        if not os.path.exists(arquivo):
            raise RuntimeError(f"o Claude não gravou semanas/{chave}.json (código {r.returncode})")
        with open(arquivo, encoding="utf-8") as f:
            rel = json.load(f)
        rel.update({"semana": chave, "inicio": ini, "fim": fim, "geradoEm": int(time.time() * 1000)})
        with open(arquivo, "w", encoding="utf-8") as f:
            json.dump(rel, f, ensure_ascii=False, indent=1)
        try:
            publicar_gist()
        except Exception as exc:  # noqa: BLE001
            print(f"[gist] publicar: {exc}")
        n = 0
        if notificar:
            br = lambda iso: "/".join(reversed(iso.split("-")[1:]))
            n = enviar_push({"title": f"📊 Resumo da semana {br(ini)} a {br(fim)}",
                             "body": str(rel.get("titulo") or "Toque para ver como foi a semana.")[:180],
                             "tag": "retomazera-" + chave, "data": "semana/" + chave})
        print(f"[semana] {chave}: pronto em {time.time() - inicio:.0f} s, push={n}")
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"[semana] {chave}: FALHOU — {exc}")
        return False
    finally:
        _analise["rodando"] = False


# --------------------------------------------------------------------------- laço do Gist
def processar_gist():
    """Lê push.json (aparelhos inscritos) e responde aos pedidos de teste do celular."""
    g = gist_request()
    remotas = json_do_arquivo(g.get("files") or {}, "acoes.json", {})
    if isinstance(remotas, dict) and remotas:
        gravar_acoes(remotas)
    lista = json_do_arquivo(g.get("files") or {}, "push.json", [])
    lista = [i for i in lista if isinstance(i, dict) and i.get("endpoint") and i.get("keys")]
    with _lock:
        _push["inscricoes"] = lista
    for insc in lista:
        t = insc.get("testeEm") or 0
        if t and _push["testes"].get(insc["endpoint"], 0) < t:
            _push["testes"][insc["endpoint"]] = t
            if time.time() * 1000 - t < 10 * 60 * 1000:  # pedido recente (não reenvia ao reiniciar)
                enviar_push({"title": "Retomazera ✅", "body": "Notificações funcionando neste aparelho.",
                             "tag": "retomazera-teste"}, [insc])


def laco_gist():
    primeira = True
    while True:
        if gist_cfg():
            try:
                if primeira:  # ao iniciar: marca os testes antigos como já vistos
                    g = gist_request()
                    for i in json_do_arquivo(g.get("files") or {}, "push.json", []):
                        if isinstance(i, dict) and i.get("endpoint"):
                            _push["testes"][i["endpoint"]] = i.get("testeEm") or 0
                    primeira = False
                processar_gist()
            except Exception as exc:  # noqa: BLE001
                print(f"[gist] {exc}")
        time.sleep(GIST_LER_S)


# --------------------------------------------------------------------------- HTTP
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=BASE_DIR, **kw)

    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return {}

    # só aceita POST da própria página (localhost) ou de scripts locais sem Origin
    def _origem_ok(self):
        origem = self.headers.get("Origin")
        return (origem is None or origem in (f"http://localhost:{PORT}", f"http://127.0.0.1:{PORT}")
                or origem.startswith("chrome-extension://"))

    PRIVADOS = (".pem", ".tmp", ".py", ".bat", ".md", ".log", ".txt")

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/status":
            return self._json(self.status_json())
        if path == "/api/lembretes":
            return self._json({"dias": dias_locais(), "semanas": semanas_locais(), "acoes": ler_acoes(), "ts": int(time.time() * 1000)})
        if path == "/api/coletas":
            data = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("data", [""])[0]
            return self._json({f: {"conversas": len(c.get("conversas") or []), "erro": c.get("erro"), "coletadoEm": c.get("coletadoEm")}
                               for f, c in coletas_do_dia(data).items()})
        if path == "/api/celular":
            cfg = gist_cfg()
            if not cfg:
                return self._json({"erro": "Conecte o Gist primeiro"}, 400)
            dados = json.dumps(cfg, separators=(",", ":")).encode()
            b64 = urllib.parse.quote(base64.urlsafe_b64encode(dados).decode().rstrip("="))
            return self._json({"url": f"{SITE_PUBLICO}#config={b64}"})
        if (path.lower().endswith(self.PRIVADOS) or "/." in path or path.startswith("/lembretes/")
                or path.startswith("/coletas/") or path.startswith("/semanas/") or path in ("/dados.json",)):
            return self._json({"erro": "não encontrado"}, 404)
        return super().do_GET()

    def status_json(self):
        cfg = gist_cfg()
        with _lock:
            aparelhos = [i.get("aparelho", "?") for i in _push["inscricoes"]]
        pc = inscricoes_pc()
        return {
            "gist": {"id": cfg["gistId"], "tokenFim": cfg["token"][-4:]} if cfg else None,
            "aparelhos": aparelhos + [i.get("aparelho", "PC") for i in pc],
            "pcEndpoints": [i["endpoint"] for i in pc],
            "pushPronto": os.path.exists(PUSH_PEM) and bool(carregar_webpush()),
            "server_time": int(time.time() * 1000),
        }

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if not self._origem_ok():
            return self._json({"erro": "origem não permitida"}, 403)
        corpo = self._body()
        if path == "/api/lembretes":
            try:
                dia = salvar_dia(corpo)
            except ValueError as exc:
                return self._json({"ok": False, "erro": str(exc)}, 400)
            publicado = False
            try:
                publicado = publicar_gist()
            except Exception as exc:  # noqa: BLE001
                print(f"[gist] publicar: {exc}")
            enviados = enviar_push(payload_dia(dia)) if corpo.get("notificar", True) else 0
            print(f"[lembretes] {dia['data']}: {len(dia['itens'])} cliente(s), gist={publicado}, push={enviados}")
            return self._json({"ok": True, "itens": len(dia["itens"]), "gist": publicado, "push": enviados})
        if path == "/api/coleta":
            try:
                n = salvar_coleta(corpo)
            except (ValueError, OSError) as exc:
                return self._json({"ok": False, "erro": str(exc)}, 400)
            print(f"[coleta] {corpo.get('data')} {corpo.get('fonte')}: {n} conversa(s)" + (f" — ERRO {corpo['erro']}" if corpo.get("erro") else ""))
            agendar_analise(corpo["data"])
            return self._json({"ok": True, "conversas": n})
        if path == "/api/acoes":
            novas = {k: v for k, v in corpo.items() if isinstance(v, dict)}
            tudo = gravar_acoes(novas)
            if gist_cfg():
                try:
                    g = gist_request()
                    tudo = gravar_acoes(json_do_arquivo(g.get("files") or {}, "acoes.json", {}) or {})
                    gist_request("PATCH", {"files": {"acoes.json": {"content": json.dumps(tudo, ensure_ascii=False)}}})
                except Exception as exc:  # noqa: BLE001
                    print(f"[gist] ações: {exc}")
                    return self._json({"ok": True, "aviso": "salvo no PC; Gist falhou"})
            return self._json({"ok": True})
        if path == "/api/semanal":
            threading.Thread(target=analisar_semana, args=(corpo.get("notificar", True), True), daemon=True).start()
            return self._json({"ok": True, "semana": semana_anterior()[2]})
        if path == "/api/analisar":
            data = str(corpo.get("data") or time.strftime("%Y-%m-%d"))
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", data) or not coletas_do_dia(data):
                return self._json({"ok": False, "erro": "sem coleta nesse dia"}, 400)
            threading.Thread(target=analisar, args=(data, corpo.get("notificar", True), True), daemon=True).start()
            return self._json({"ok": True, "iniciada": data})
        if path == "/api/gist":
            token = str(corpo.get("token") or "").strip()
            if not token:
                return self._json({"ok": False, "erro": "cole o token"}, 400)
            try:
                gid, criado = conectar_gist(token)
            except urllib.error.HTTPError as exc:
                return self._json({"ok": False, "erro": "token inválido" if exc.code == 401 else f"GitHub: erro {exc.code}"}, 400)
            except Exception as exc:  # noqa: BLE001
                return self._json({"ok": False, "erro": str(exc)}, 400)
            return self._json({"ok": True, "gistId": gid, "criado": criado})
        if path == "/api/push-pc":
            ep, keys = corpo.get("endpoint"), corpo.get("keys")
            if not ep or not keys:
                return self._json({"ok": False, "erro": "inscrição incompleta"}, 400)
            fora = set([ep] + list(corpo.get("remover") or []))
            pc = [i for i in inscricoes_pc() if i["endpoint"] not in fora]
            pc.append({"endpoint": ep, "keys": keys, "aparelho": "Chrome deste PC", "criadoEm": int(time.time() * 1000)})
            gravar_dados(push_pc=pc)
            return self._json({"ok": True})
        if path == "/api/push-pc-remover":
            ep = corpo.get("endpoint")
            gravar_dados(push_pc=[i for i in inscricoes_pc() if i["endpoint"] != ep])
            return self._json({"ok": True})
        if path == "/api/push-teste":
            ep = corpo.get("endpoint")
            alvo = [i for i in inscricoes_pc() if i["endpoint"] == ep] if ep else None
            dias = dias_locais(1)
            payload = payload_dia(dias[0]) if dias and corpo.get("exemplo") else \
                {"title": "Retomazera ✅", "body": "Notificações funcionando.", "tag": "retomazera-teste"}
            n = enviar_push(payload, alvo)
            return self._json({"ok": n > 0, "enviados": n})
        if path == "/api/republicar":
            try:
                return self._json({"ok": publicar_gist()})
            except Exception as exc:  # noqa: BLE001
                return self._json({"ok": False, "erro": str(exc)}, 500)
        return self._json({"erro": "rota desconhecida"}, 404)


class Servidor(ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        if isinstance(sys.exc_info()[1], (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)

    # No Windows, SO_REUSEADDR deixaria um segundo server.py escutar a mesma porta junto com o primeiro
    allow_reuse_address = sys.platform != "win32"
    daemon_threads = True


def log_sem_janela():
    """Com pythonw.exe não há console: as mensagens vão para server.log (máx. ~1 MB + o anterior)."""
    if sys.stdout is not None:
        return
    caminho = os.path.join(BASE_DIR, "server.log")
    if os.path.exists(caminho) and os.path.getsize(caminho) > 1_000_000:
        os.replace(caminho, caminho + ".1")
    arquivo = open(caminho, "a", encoding="utf-8", buffering=1)
    sys.stdout = sys.stderr = arquivo
    print(f"\n--- iniciado em {time.strftime('%d/%m/%Y %H:%M:%S')} ---")


def main():
    log_sem_janela()
    try:
        server = Servidor(("127.0.0.1", PORT), Handler)
    except OSError:
        print(f"O Retomazera já está rodando (porta {PORT} ocupada).")
        return
    threading.Thread(target=laco_gist, daemon=True).start()
    cfg = gist_cfg()
    print("=" * 60)
    print(" RETOMAZERA rodando!")
    print(f"   No PC:    http://localhost:{PORT}/")
    print(f"   Celular:  {SITE_PUBLICO}  ({'Gist conectado' if cfg else 'conecte o Gist em Ajustes'})")
    print(f"   Push:     {'pronto' if os.path.exists(PUSH_PEM) and carregar_webpush() else 'FALTA push_vapid.pem ou .vendor'}")
    print("=" * 60)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
