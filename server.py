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
import sqlite3
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
PASTA_NOITES = os.path.join(BASE_DIR, "noites")       # análises da noite: preparar as vendas de amanhã (fora do git)
ESPERA = os.path.join(BASE_DIR, "espera.json")        # fila de espera: cliente aguardando um modelo sem estoque (fora do git)
GESTAO_DB = "file:D:/Loja/Programa/Gestao/dist/GestaoVendas/gestao_vendas.db?mode=ro"
RETORNOS = os.path.join(BASE_DIR, "retornos.json")    # "me chama mês que vem": guardado sem prazo (fora do git)
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


def noites_locais(limite=3):
    if not os.path.isdir(PASTA_NOITES):
        return []
    nomes = sorted((n for n in os.listdir(PASTA_NOITES) if re.fullmatch(r"\d{4}-\d{2}-\d{2}\.json", n)), reverse=True)
    saida = []
    for n in nomes[:limite]:
        try:
            with open(os.path.join(PASTA_NOITES, n), encoding="utf-8") as f:
                saida.append(json.load(f))
        except (OSError, ValueError):
            pass
    return saida


# --------------------------------------------------------------------------- retornos combinados
def chave_cliente(x):
    canal = str(x.get("canal") or "").lower()
    dig = re.sub(r"\D", "", str(x.get("contato") or ""))
    if canal == "whatsapp" and len(dig) >= 8:
        return f"whatsapp:{dig[-8:]}"
    if canal in ("olx", "instagram") and str(x.get("contato") or "").startswith("http"):
        return f"{canal}:{x['contato']}"
    return f"{canal}:{str(x.get('nome') or '').strip().lower()}"


def ler_retornos():
    try:
        with open(RETORNOS, encoding="utf-8") as f:
            d = json.load(f)
            return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def registrar_retornos(lista, origem_data):
    """Guarda/atualiza os retornos por cliente (o pedido mais novo vale) e devolve o registro todo."""
    reg = ler_retornos()
    for x in lista or []:
        if not isinstance(x, dict) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(x.get("data") or "")):
            continue
        k = chave_cliente(x)
        reg[k] = {"nome": str(x.get("nome") or "")[:80], "canal": str(x.get("canal") or "")[:20],
                  "contato": str(x.get("contato") or "")[:200], "produto": str(x.get("produto") or "")[:80],
                  "data": x["data"], "pedido": str(x.get("pedido") or "")[:300], "motivo": str(x.get("motivo") or "")[:400],
                  "mensagem": str(x.get("mensagem") or "")[:600], "combinadoEm": origem_data, "ts": int(time.time() * 1000)}
    # limpa retornos vencidos há mais de 30 dias
    limite = (date.today() - timedelta(days=30)).isoformat()
    reg = {k: v for k, v in reg.items() if v.get("data", "") >= limite}
    tmp = RETORNOS + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(reg, f, ensure_ascii=False, indent=1)
    os.replace(tmp, RETORNOS)
    return reg


def retornos_publicos():
    return sorted(ler_retornos().values(), key=lambda v: v.get("data", ""))


# --------------------------------------------------------------------------- fila de espera
FAMILIAS = [  # (família, regex) — a ordem importa: o mais específico primeiro
    ("PS5", r"\bps ?5\b|playstation ?5"), ("PS4 Pro", r"\bps ?4 ?pro\b"), ("PS4", r"\bps ?4\b|playstation ?4"),
    ("PS3", r"\bps ?3\b|playstation ?3"), ("PS2", r"\bps ?2\b|playstation ?2"),
    ("Xbox Series X", r"series ?x\b"), ("Xbox Series S", r"series ?s\b"), ("Xbox One", r"xbox ?one"), ("Xbox 360", r"xbox ?360"),
    ("Nintendo Switch", r"switch"), ("PS Vita", r"vita"), ("PSP", r"\bpsp\b"),
]


def familia(texto):
    t = unicodedata_sem_acento(str(texto or "")).lower().replace("séries", "series")
    m = re.search(r"iphone ?(\d{1,2})( ?pro ?max| ?pro| ?plus| ?mini)?", t)
    if m:
        return ("iPhone " + m.group(1) + (m.group(2) or "").title()).replace("  ", " ").strip()
    for nome, rx in FAMILIAS:
        if re.search(rx, t):
            return nome
    return ""


def unicodedata_sem_acento(s):
    import unicodedata
    return "".join(ch for ch in unicodedata.normalize("NFD", s) if not unicodedata.combining(ch))


def ler_espera():
    try:
        with open(ESPERA, encoding="utf-8") as f:
            d = json.load(f)
            return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def gravar_espera(reg):
    with _lock:
        tmp = ESPERA + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(reg, f, ensure_ascii=False, indent=1)
        os.replace(tmp, ESPERA)


def registrar_espera(lista, origem_data):
    """Cliente esperando um modelo: chave = cliente + família. Fica até 120 dias (ou até vender/excluir)."""
    reg = ler_espera()
    for x in lista or []:
        if not isinstance(x, dict):
            continue
        fam = familia(x.get("produto"))
        if not fam:
            continue
        k = chave_cliente(x) + "|" + fam
        antigo = reg.get(k, {})
        reg[k] = {**antigo, "nome": str(x.get("nome") or "")[:80], "canal": str(x.get("canal") or "")[:20],
                  "contato": str(x.get("contato") or "")[:200], "produto": str(x.get("produto") or "")[:80], "familia": fam,
                  "detalhes": str(x.get("detalhes") or "")[:300], "pedido": str(x.get("pedido") or "")[:300],
                  "mensagem": str(x.get("mensagem") or "")[:600],
                  "desde": antigo.get("desde") or origem_data, "ts": int(time.time() * 1000)}
    limite = (date.today() - timedelta(days=120)).isoformat()
    reg = {k: v for k, v in reg.items() if (v.get("desde") or "") >= limite}
    gravar_espera(reg)
    verificar_espera()
    return reg


def estoque_disponivel():
    """Itens 'Aguardando venda' na Gestão (só leitura), com a família de cada um."""
    try:
        c = sqlite3.connect(GESTAO_DB, uri=True, timeout=10)
        linhas = c.execute("select uid, coalesce(nullif(console_nome,''),nome), nome, preco_previsto, data_compra from produtos "
                           "where (data_venda is null or data_venda='') and status_item='Aguardando venda'").fetchall()
        c.close()
    except sqlite3.Error as exc:
        print(f"[espera] não consegui ler a Gestão: {exc}")
        return []
    saida = []
    # acessórios não contam como "chegou o videogame"; aparelho com preço muito abaixo do normal é defeito/peça
    acessorio = re.compile(r"\b(controle|jogo|cabo|fonte|capa|case|headset|fone|carregador|skin|suporte|base|pe[cç]a|placa|sucata|defeito|feira do rolo)\b", re.I)
    minimo = {"PS5": 2500, "Xbox Series X": 2500, "Xbox Series S": 1500, "PS4 Pro": 1200, "PS4": 800, "Xbox One": 700,
              "Nintendo Switch": 1000, "PS3": 300}
    for uid, console, nome, prev, dc in linhas:
        texto = f"{console} {nome}"
        fam = familia(texto)
        if not fam or acessorio.search(texto):
            continue
        if prev and fam in minimo and float(prev) < minimo[fam]:
            continue
        if fam:
            saida.append({"uid": uid, "item": (console or nome or "")[:120], "familia": fam, "preco": prev, "compra": dc})
    return saida


def atende(espera, item):
    """O item do estoque atende o que o cliente pediu? Além da família, confere armazenamento e leitor/digital."""
    desejo = unicodedata_sem_acento(f"{espera.get('produto') or ''} {espera.get('detalhes') or ''}").lower()
    t = unicodedata_sem_acento(str(item.get("item") or "")).lower()
    # armazenamento: "1TB" pedido (e não "não quer 1TB") → item precisa ser 1TB; PS5 Fat/original e "825" são 825GB
    if re.search(r"\b1 ?tb\b", desejo) and not re.search(r"nao quer[^.]{0,20}1 ?tb", desejo):
        tem_1tb = re.search(r"\b1 ?tb\b", t) or ("slim" in t and "825" not in t)
        if not tem_1tb:
            return False
    if re.search(r"\b2 ?tb\b", desejo) and not re.search(r"\b2 ?tb\b", t):
        return False
    if re.search(r"\b512 ?gb?\b", desejo) and re.search(r"\b1 ?tb\b", t):
        pass  # quem pede 512 aceita maior
    # leitor x digital
    quer_digital = "digital" in desejo and not re.search(r"leitor|disco|midia fisica", desejo)
    quer_leitor = bool(re.search(r"com leitor|leitor de disco|midia fisica|com disco", desejo))
    if quer_digital and "digital" not in t:
        return False
    if quer_leitor and "digital" in t:
        return False
    return True


STATUS_FILA = {"Aguardando venda": "disponivel", "Chegando": "chegando"}  # "Aguardando envio" (vendedor ainda não mandou) fica de fora
_miniaturas = {}


def miniatura(caminho):
    """Primeira foto do item reduzida (JPEG ~240px em data URI) para ir no Gist sem pesar."""
    if not caminho or not os.path.exists(caminho):
        return ""
    chave = (caminho, os.path.getmtime(caminho))
    if chave not in _miniaturas:
        try:
            from PIL import Image, ImageOps
            import base64
            import io
            with Image.open(caminho) as im:
                im = ImageOps.exif_transpose(im).convert("RGB")
                im.thumbnail((240, 240))
                buf = io.BytesIO()
                im.save(buf, "JPEG", quality=68, optimize=True)
            _miniaturas[chave] = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
        except Exception as exc:  # noqa: BLE001
            print(f"[espera] miniatura {caminho}: {exc}")
            _miniaturas[chave] = ""
    return _miniaturas[chave]


def itens_de_vendas(acoes):
    """Videogames das vendas marcadas (a lista mais nova de cada cliente vale), de 3 dias atrás em diante:
    [(chave do item 'venda:<cliente>:<data>#<i>', família, descrição)]. Acessório/taxa não entra."""
    por_cliente = {}
    for dia in sorted(dias_locais() + noites_locais(), key=lambda d: d.get("geradoEm") or 0):
        for v in dia.get("agendadas") or []:
            if isinstance(v, dict):
                por_cliente[chave_cliente(v)] = v
    limite = (date.today() - timedelta(days=3)).isoformat()
    nao_console = re.compile(r"^\W*(\d+\s*x?\s*)?(controle|jogo|cabo|fonte|capa|case|headset|fone|carregador|skin|suporte|base|taxa|frete|entrega|garantia)", re.I)
    saida = []
    for ck, v in por_cliente.items():
        if (v.get("data") or "") < limite:
            continue
        vk = f"venda:{ck}:{v.get('data')}"
        if acoes.get(vk, {}).get("cancelada") or acoes.get(vk, {}).get("concluida"):
            continue
        for i, it in enumerate(v.get("itens") or []):
            desc = str((it or {}).get("descricao") or "")
            fam = familia(desc)
            if fam and not nao_console.search(desc):
                saida.append((f"{vk}#{i}", fam, desc))
    return saida


def estoque_fila(reg=None):
    """Unidades na Gestão (disponíveis e a caminho) dos modelos que alguém da fila espera, com foto, custo e
    para qual cliente cada uma vai: o primeiro da fila fica com a primeira unidade que atende (disponível antes
    de chegando; dentro disso, a comprada há mais tempo)."""
    reg = ler_espera() if reg is None else reg
    acoes = ler_acoes()
    fila = [(k, e) for k, e in reg.items()
            if not acoes.get(k.split("|")[0], {}).get("excluido") and not acoes.get(k.split("|")[0], {}).get("vendido")]
    familias = {e.get("familia") for _, e in fila}
    # videogames das vendas marcadas também entram (a aba Vendas mostra qual unidade vai ser entregue)
    itens_venda = itens_de_vendas(acoes)
    familias |= {fam for _, fam, _ in itens_venda}
    if not familias:
        return []
    try:
        c = sqlite3.connect(GESTAO_DB, uri=True, timeout=10)
        linhas = c.execute(
            "select uid, coalesce(nullif(trim(console_nome),''),nome), nome, status_item, preco_compra, custo_reparo, "
            "preco_previsto, reparo, data_compra, fotos from produtos where (data_venda is null or data_venda='') "
            "and status_item in ('Aguardando venda','Chegando')").fetchall()
        c.close()
    except sqlite3.Error as exc:
        print(f"[espera] não consegui ler a Gestão: {exc}")
        return []
    acessorio = re.compile(r"\b(controle|jogo|cabo|fonte|capa|case|headset|fone|carregador|skin|suporte|base|pe[cç]a|placa|sucata|defeito|feira do rolo)\b", re.I)
    minimo = {"PS5": 2500, "Xbox Series X": 2500, "Xbox Series S": 1500, "PS4 Pro": 1200, "PS4": 800, "Xbox One": 700,
              "Nintendo Switch": 1000, "PS3": 300}
    unidades = []
    for uid, console, nome, status, compra, reparo_v, prev, reparo, dc, fotos in linhas:
        texto = f"{console} {nome}"
        fam = familia(texto)
        if fam not in familias or acessorio.search(texto.split("|")[0]):
            continue
        if prev and fam in minimo and float(prev) < minimo[fam]:
            continue  # preço muito abaixo do normal: defeito/peça
        try:
            lista_fotos = json.loads(fotos) if fotos else []
        except ValueError:
            lista_fotos = []
        unidades.append({"uid": uid, "item": (console or nome or "").strip()[:120], "nome": (nome or "").strip()[:200],
                         "familia": fam, "status": status, "situacao": STATUS_FILA[status],
                         "custo": round(float(compra or 0) + float(reparo_v or 0), 2), "preco": prev, "compra": dc,
                         "foto": miniatura(lista_fotos[0]) if lista_fotos else "", "para": "", "paraNome": ""})
    unidades.sort(key=lambda u: (u["familia"], u["situacao"] != "disponivel", u["compra"] or ""))
    for u in unidades:  # quem (fila e itens de venda) essa unidade atende — o app faz a divisão na hora
        u["atende"] = [k for k, e in fila if e.get("familia") == u["familia"] and atende(e, u)] +                       [k for k, fam, desc in itens_venda if fam == u["familia"] and atende({"produto": desc}, u)]
    usadas = set()
    for k, e in sorted(fila, key=lambda x: x[1].get("desde") or ""):
        fora = set(acoes.get(k.split("|")[0], {}).get("semUnidade") or [])  # unidades que o João desvinculou dele
        u = next((u for u in unidades if u["uid"] not in usadas and u["uid"] not in fora and k in u["atende"]), None)
        if u:
            usadas.add(u["uid"])
            u["para"], u["paraNome"] = k, e.get("nome") or ""
    return unidades


def verificar_espera(notificar=True):
    """Cruza a fila com o estoque; cliente com o modelo disponível ganha 'chegou' e vira notificação (1x por item)."""
    reg = ler_espera()
    if not reg:
        return []
    estoque = estoque_disponivel()
    acoes = ler_acoes()
    novos = []
    for k, e in reg.items():
        cliente = acoes.get(k.split("|")[0], {})
        if cliente.get("excluido"):
            continue
        disp = [i for i in estoque if i["familia"] == e.get("familia") and atende(e, i)]
        if not disp:
            if e.get("chegou"):
                e["chegou"] = None  # o item foi vendido para outra pessoa: volta a esperar
            continue
        avisados = set(e.get("avisados") or [])
        novo = next((i for i in disp if i["uid"] not in avisados), None)
        opcoes = [{"item": i["item"], "preco": i["preco"]} for i in disp]
        if e.get("chegou"):
            e["chegou"]["opcoes"] = opcoes  # todas as unidades do modelo em estoque (o João escolhe a que combina)
        if not e.get("chegou") or novo:
            item = novo or disp[0]
            e["chegou"] = {"uid": item["uid"], "item": item["item"], "preco": item["preco"], "em": int(time.time() * 1000),
                           "opcoes": opcoes}
            if novo:
                e["avisados"] = sorted(avisados | {novo["uid"]})
                novos.append(e)
    gravar_espera(reg)
    if novos and notificar:
        por_familia = {}
        for e in novos:
            por_familia.setdefault(e["familia"], []).append(e)
        for fam, lista in por_familia.items():
            nomes = ", ".join(x.get("nome") or "?" for x in lista[:4]) + (f" e mais {len(lista) - 4}" if len(lista) > 4 else "")
            enviar_push({"title": f"🔔 Chegou {fam}! {len(lista)} cliente{'s' if len(lista) > 1 else ''} esperando",
                         "body": f"{nomes} — {lista[0]['chegou']['item']}", "tag": "retomazera-espera-" + fam, "data": "espera"})
        try:
            publicar_gist()
        except Exception as exc:  # noqa: BLE001
            print(f"[gist] publicar: {exc}")
        print(f"[espera] chegou: {', '.join(e['familia'] + ' → ' + (e.get('nome') or '?') for e in novos)}")
    return novos


def espera_publica():
    return sorted(({**v, "chave": k} for k, v in ler_espera().items()), key=lambda v: v.get("desde") or "")


def laco_espera():
    assinatura = None
    while True:
        try:
            verificar_espera()
            # estoque mudou na Gestão (chegou, vendeu, mudou custo/foto)? republica para a aba Fila do celular
            atual = json.dumps([[u["uid"], u["status"], u["custo"], u["preco"], u["para"], bool(u["foto"])] for u in estoque_fila()])
            if assinatura is not None and atual != assinatura:
                publicar_gist()
            assinatura = atual
        except Exception as exc:  # noqa: BLE001
            print(f"[espera] {exc}")
        time.sleep(600)


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
    corpo = {"dias": dias_locais(), "semanas": semanas_locais(), "noites": noites_locais(), "retornos": retornos_publicos(),
             "espera": espera_publica(), "estoque": estoque_fila(),
             "ts": int(time.time() * 1000)}
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
    ret = [r for r in ler_retornos().values() if r.get("data") == dia.get("data")]
    if ret:
        itens = itens + [{"nome": r.get("nome"), "produto": "📅 combinado", "prioridade": "alta"} for r in ret]
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
    limpos = salvar_dia_itens(itens, data)
    agendadas = limpar_agendadas(corpo.get("agendadas") or [])
    registrar_retornos(corpo.get("retornos") or [], data)
    try:
        registrar_espera(corpo.get("espera") or [], data)
    except Exception as exc:  # noqa: BLE001
        print(f"[espera] {exc}")
    dia = {"data": data, "geradoEm": int(time.time() * 1000), "resumo": str(corpo.get("resumo") or "")[:1500],
           "fontes": corpo.get("fontes") if isinstance(corpo.get("fontes"), dict) else {}, "itens": limpos,
           "agendadas": agendadas}
    os.makedirs(PASTA_DIAS, exist_ok=True)
    with open(os.path.join(PASTA_DIAS, data + ".json"), "w", encoding="utf-8") as f:
        json.dump(dia, f, ensure_ascii=False, indent=1)
    return dia


def salvar_dia_itens(itens, prefixo):
    limpos = []
    for i, x in enumerate(itens if isinstance(itens, list) else []):
        if not isinstance(x, dict):
            continue
        limpos.append({
            "id": str(x.get("id") or f"{prefixo}-{i}"),
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
    return limpos


def limpar_agendadas(lista):
    agendadas = []
    for x in lista or []:
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
    return agendadas


# --------------------------------------------------------------------------- coletas da extensão
def pasta_coleta(data, turno=""):
    if turno == "noite":
        return os.path.join(PASTA_COLETAS, data, "noite")
    if turno.startswith("ronda:"):  # rondas de 2 em 2 h: coletas/<data>/rondas/<HH>
        return os.path.join(PASTA_COLETAS, data, "rondas", turno.split(":", 1)[1])
    return os.path.join(PASTA_COLETAS, data)


def turno_de(corpo):
    t = str(corpo.get("turno") or "")
    if t == "noite":
        return "noite"
    if t == "ronda" and re.fullmatch(r"\d{2}", str(corpo.get("rodada") or "")):
        return "ronda:" + str(corpo["rodada"])
    return ""


def salvar_coleta(corpo):
    """Grava coletas/AAAA-MM-DD[/noite]/<fonte>.json e refaz o conversas.txt (todas as fontes juntas, para o Claude ler)."""
    data, fonte = str(corpo.get("data") or ""), str(corpo.get("fonte") or "")
    turno = turno_de(corpo)
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", data) or fonte not in NOMES_FONTES:
        raise ValueError("data ou fonte inválida")
    pasta = pasta_coleta(data, turno)
    os.makedirs(pasta, exist_ok=True)
    with open(os.path.join(pasta, fonte + ".json"), "w", encoding="utf-8") as f:
        json.dump(corpo, f, ensure_ascii=False, indent=1)
    # cada perfil do Chrome diz quais fontes coleta: a análise espera a soma de todos
    if isinstance(corpo.get("lote"), list):
        lotes = ler_dados().get("fontes_perfis", {})
        lotes[str(corpo.get("perfil") or "?")] = [f for f in corpo["lote"] if f in NOMES_FONTES]
        gravar_dados(fontes_perfis=lotes)
    gerar_texto(data, turno)
    return len(corpo.get("conversas") or [])


def coletas_do_dia(data, turno=""):
    pasta = pasta_coleta(data, turno)
    saida = {}
    for fonte in NOMES_FONTES:
        try:
            with open(os.path.join(pasta, fonte + ".json"), encoding="utf-8") as f:
                saida[fonte] = json.load(f)
        except (OSError, ValueError):
            pass
    return saida


def gerar_texto(data, turno=""):
    """Texto compacto: cabeçalho por conversa e uma linha por mensagem (J = João, C = cliente)."""
    rotulo = " (NOITE)" if turno == "noite" else f" (RONDA DAS {turno.split(':')[1]}H)" if turno else ""
    linhas = [f"CONVERSAS DE {data}{rotulo} (J = João/loja, C = cliente)", ""]
    for fonte, c in coletas_do_dia(data, turno).items():
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
    with open(os.path.join(pasta_coleta(data, turno), "conversas.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(linhas))


# --------------------------------------------------------------------------- análise pelo Claude Code
ESPERA_FONTES_S = 20 * 60      # espera as outras fontes até 20 min depois da primeira
ANALISE_TIMEOUT_S = 20 * 60
_analise = {"rodando": False, "timer": None, "timer_noite": None, "timer_ronda": None, "lock": threading.Lock()}


def claude_exe():
    return shutil.which("claude") or os.path.expanduser(r"~\.local\bin\claude.exe")


def chamar_claude(prompt, arquivo_log, modelo=None):
    """Roda `claude -p` na pasta do Retomazera, só com leitura/gravação de arquivos e python.
    Grava no log a resposta e o uso de tokens (e soma em uso_claude.json, por dia)."""
    cmd = [claude_exe(), "-p", "--allowedTools", "Read", "Write", "Grep", "Glob", "Bash(python:*)", "Bash(python -X utf8:*)",
           "--output-format", "json"] + (["--model", modelo] if modelo else [])
    inicio = time.time()
    r = subprocess.run(cmd, input=prompt, capture_output=True, text=True, encoding="utf-8", errors="replace",
                       cwd=BASE_DIR, timeout=ANALISE_TIMEOUT_S, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    texto, uso = r.stdout, ""
    try:
        j = json.loads(r.stdout)
        texto = str(j.get("result") or "")
        u = j.get("usage") or {}
        uso = (f"modelo {modelo or 'padrão'} · {j.get('num_turns')} passos · tokens: novos {u.get('input_tokens', 0) + u.get('cache_creation_input_tokens', 0)}"
               f", do cache {u.get('cache_read_input_tokens', 0)}, resposta {u.get('output_tokens', 0)}")
        registrar_uso(os.path.basename(os.path.dirname(arquivo_log)) or "?", modelo or "padrão", u, time.time() - inicio)
    except (ValueError, AttributeError):
        pass
    os.makedirs(os.path.dirname(arquivo_log), exist_ok=True)
    with open(arquivo_log, "w", encoding="utf-8") as f:
        f.write(f"código {r.returncode} em {time.time() - inicio:.0f} s\n{uso}\n\n--- saída ---\n{texto}\n--- erros ---\n{r.stderr}")
    r.stdout = texto
    # login do Claude Code expirado: não adianta tentar de novo, o João precisa entrar de novo
    if r.returncode and re.search(r"authenticat|oauth|session expired|not logged|please run /login", (r.stdout or "") + (r.stderr or ""), re.I):
        raise RuntimeError("o login do Claude no PC expirou: abra o terminal, rode 'claude' e digite /login")
    return r


USO_CLAUDE = os.path.join(BASE_DIR, "uso_claude.json")  # tokens por dia e por tipo de análise (fora do git)


def registrar_uso(tipo, modelo, u, segundos):
    try:
        with _lock:
            try:
                with open(USO_CLAUDE, encoding="utf-8") as f:
                    reg = json.load(f)
            except (OSError, ValueError):
                reg = {}
            dia = reg.setdefault(time.strftime("%Y-%m-%d"), [])
            dia.append({"hora": time.strftime("%H:%M"), "tipo": tipo, "modelo": modelo, "segundos": round(segundos),
                        "novos": (u.get("input_tokens") or 0) + (u.get("cache_creation_input_tokens") or 0),
                        "cache": u.get("cache_read_input_tokens") or 0, "resposta": u.get("output_tokens") or 0})
            limite = (date.today() - timedelta(days=60)).isoformat()
            reg = {k: v for k, v in reg.items() if k >= limite}
            with open(USO_CLAUDE, "w", encoding="utf-8") as f:
                json.dump(reg, f, ensure_ascii=False, indent=1)
    except Exception as exc:  # noqa: BLE001
        print(f"[uso] {exc}")


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


def agendar_analise(data, turno=""):
    # Chamado a cada coleta recebida: analisa já se todas as fontes chegaram; senão, em até 20 min.
    coletas = coletas_do_dia(data, turno)
    completas = all(f in coletas for f in fontes_esperadas())
    primeira = min((c.get("coletadoEm") or 0) for c in coletas.values()) / 1000
    atraso = 30 if completas else max(30, ESPERA_FONTES_S - (time.time() - primeira))
    chave_timer = "timer_noite" if turno == "noite" else "timer_ronda" if turno.startswith("ronda:") else "timer"
    funcao, args = (analisar_noite, (data,)) if turno == "noite" else \
        (analisar_ronda, (data, turno.split(":")[1])) if turno.startswith("ronda:") else (analisar, (data,))
    with _analise["lock"]:
        if _analise[chave_timer]:
            _analise[chave_timer].cancel()
        t = threading.Timer(atraso, funcao, args=args)
        t.daemon = True
        _analise[chave_timer] = t
        t.start()
    print(f"[análise{' noite' if turno else ''}] {data}: {'todas as fontes chegaram' if completas else 'esperando as outras fontes'}; roda em {int(atraso)} s")


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


MODELO_RONDA = "sonnet"


def analisar_ronda(data, rodada, notificar=True, forcar=False):
    """Ronda de 2 em 2 h: só as conversas novas desde a coleta anterior. O Claude (Sonnet) devolve só o que MUDOU
    na lista do dia (novos/atualizados/remover, vendas, fila, retornos); o servidor junta em dias/<data>.json."""
    turno = "ronda:" + rodada
    pasta = pasta_coleta(data, turno)
    saida = os.path.join(pasta, "resultado.json")
    with _analise["lock"]:
        if _analise["rodando"]:
            print(f"[ronda {rodada}h] já tem uma análise rodando; tento de novo em 2 min")
            t = threading.Timer(120, analisar_ronda, args=(data, rodada, notificar, forcar)); t.daemon = True; t.start()
            return False
        coletas = coletas_do_dia(data, turno)
        ultima = max([c.get("coletadoEm") or 0 for c in coletas.values()] or [0])
        if not coletas or (not forcar and os.path.exists(saida) and os.path.getmtime(saida) * 1000 >= ultima):
            return False
        _analise["rodando"] = True
    try:
        n_conv = sum(len(c.get("conversas") or []) for c in coletas.values())
        if not n_conv:  # nada novo: nem chama o Claude
            print(f"[ronda {rodada}h] {data}: nenhuma conversa nova — sem análise")
            with open(saida, "w", encoding="utf-8") as f:
                json.dump({"vazia": True}, f)
            return True
        with open(os.path.join(BASE_DIR, "ronda_prompt.md"), encoding="utf-8") as f:
            prompt = f.read().replace("{DATA}", data).replace("{RODADA}", rodada)
        print(f"[ronda {rodada}h] {data}: {n_conv} conversa(s) nova(s); chamando o Claude ({MODELO_RONDA})…")
        inicio = time.time()
        r = chamar_claude(prompt, os.path.join(pasta, "analise.log"), modelo=MODELO_RONDA)
        if not os.path.exists(saida):
            raise RuntimeError(f"o Claude não gravou resultado.json (código {r.returncode}; veja coletas/{data}/rondas/{rodada}/analise.log)")
        with open(saida, encoding="utf-8") as f:
            corpo = json.load(f)
        dia, mudou = juntar_ronda(data, rodada, corpo)
        try:
            publicar_gist()
        except Exception as exc:  # noqa: BLE001
            print(f"[gist] publicar: {exc}")
        enviados = 0
        if notificar and corpo.get("avisar") and mudou:
            enviados = enviar_push({"title": f"🔄 {rodada}h: {str(corpo.get('titulo') or 'novidades na lista')[:80]}",
                                    "body": str(corpo.get("resumo") or "")[:220], "tag": f"retomazera-ronda-{data}", "data": data})
        print(f"[ronda {rodada}h] {data}: {mudou} mudança(s), push={enviados}, {time.time() - inicio:.0f} s")
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"[ronda {rodada}h] {data}: FALHOU — {exc}")
        return False  # ronda falhando não incomoda no celular: a próxima (ou a da noite) cobre
    finally:
        _analise["rodando"] = False


def juntar_ronda(data, rodada, corpo):
    """Aplica as mudanças da ronda na lista do dia. Item novo/atualizado ganha 'listaEm' (agora), para que um
    'Já chamei' de antes não esconda o cliente que voltou a precisar de atenção."""
    arq = os.path.join(PASTA_DIAS, data + ".json")
    try:
        with open(arq, encoding="utf-8") as f:
            dia = json.load(f)
    except (OSError, ValueError):
        dia = {"data": data, "geradoEm": int(time.time() * 1000), "resumo": "", "fontes": {}, "itens": [], "agendadas": []}
    agora = int(time.time() * 1000)
    mudou = 0
    por_chave = {chave_cliente(x): x for x in dia.get("itens") or []}
    for x in corpo.get("remover") or []:
        if isinstance(x, dict) and por_chave.pop(chave_cliente(x), None) is not None:
            mudou += 1
    novos = salvar_dia_itens(corpo.get("itens") or [], f"{data}-r{rodada}")
    for x in novos:
        x.update({"listaEm": agora, "ronda": rodada + "h"})
        por_chave[chave_cliente(x)] = x
        mudou += 1
    dia["itens"] = list(por_chave.values())
    ag = {chave_cliente(a): a for a in dia.get("agendadas") or []}
    for a in corpo.get("cancelar_agendadas") or []:
        if isinstance(a, dict) and ag.pop(chave_cliente(a), None) is not None:
            mudou += 1
    for a in limpar_agendadas(corpo.get("agendadas") or []):
        ag[chave_cliente(a)] = a
        mudou += 1
    dia["agendadas"] = list(ag.values())
    if corpo.get("resumo"):
        dia.setdefault("rondas", []).append({"hora": rodada + "h", "resumo": str(corpo["resumo"])[:600], "em": agora})
        dia["rondas"] = dia["rondas"][-8:]
    registrar_retornos(corpo.get("retornos") or [], data)
    try:
        registrar_espera(corpo.get("espera") or [], data)
    except Exception as exc:  # noqa: BLE001
        print(f"[espera] {exc}")
    os.makedirs(PASTA_DIAS, exist_ok=True)
    with open(arq, "w", encoding="utf-8") as f:
        json.dump(dia, f, ensure_ascii=False, indent=1)
    return dia, mudou


def payload_noite(n):
    vendas = [a for a in n.get("agendadas") or [] if a.get("data") == n.get("amanha")]
    prep = n.get("preparar") or []
    conf = n.get("confirmar") or []
    if vendas:
        titulo = f"🌙 Amanhã: {len(vendas)} venda{'s' if len(vendas) > 1 else ''} marcada{'s' if len(vendas) > 1 else ''}"
        corpo = " · ".join(f"{a.get('hora') or ''} {a.get('nome') or '?'}".strip() for a in vendas[:3])
        if prep:
            corpo += f" | Preparar: {prep[0]}" + (f" (+{len(prep) - 1})" if len(prep) > 1 else "")
    else:
        titulo = "🌙 Amanhã: nenhuma venda marcada"
        corpo = str(n.get("resumo") or "")[:150]
    if conf:
        corpo += f" | Confirmar hoje: {len(conf)}"
    return {"title": titulo, "body": corpo[:220], "tag": "retomazera-noite-" + n.get("data", ""), "data": "noite"}


def analisar_noite(data, notificar=True, forcar=False):
    # Análise da noite: lê coletas/<data>/noite e grava noites/<data>.json (vendas de amanhã + preparo + confirmar hoje).
    pasta = pasta_coleta(data, "noite")
    saida = os.path.join(pasta, "resultado.json")
    arquivo = os.path.join(PASTA_NOITES, data + ".json")
    with _analise["lock"]:
        if _analise["rodando"]:
            print("[noite] já tem uma análise rodando; tento de novo em 2 min")
            t = threading.Timer(120, analisar_noite, args=(data, notificar, forcar)); t.daemon = True; t.start()
            return False
        coletas = coletas_do_dia(data, "noite")
        ultima = max([c.get("coletadoEm") or 0 for c in coletas.values()] or [0])
        if not coletas or (not forcar and os.path.exists(arquivo) and os.path.getmtime(arquivo) * 1000 >= ultima):
            return False
        _analise["rodando"] = True
    try:
        amanha = (date.fromisoformat(data) + timedelta(days=1)).isoformat()
        with open(os.path.join(BASE_DIR, "noite_prompt.md"), encoding="utf-8") as f:
            prompt = f.read().replace("{DATA}", data).replace("{AMANHA}", amanha)
        if os.path.exists(saida):
            os.remove(saida)
        print(f"[noite] {data}: chamando o Claude Code…")
        inicio = time.time()
        r = chamar_claude(prompt, os.path.join(pasta, "analise.log"))
        if not os.path.exists(saida):
            raise RuntimeError(f"o Claude não gravou resultado.json (código {r.returncode}; veja coletas/{data}/noite/analise.log)")
        with open(saida, encoding="utf-8") as f:
            corpo = json.load(f)
        # reaproveita a limpeza da análise do dia para as vendas marcadas
        limpas = limpar_agendadas(corpo.get("agendadas") or [])
        confirmar = [x for x in (corpo.get("confirmar") or []) if isinstance(x, dict)][:15]
        noite = {"data": data, "amanha": amanha, "geradoEm": int(time.time() * 1000),
                 "resumo": str(corpo.get("resumo") or "")[:1500], "agendadas": limpas,
                 "preparar": [str(x)[:300] for x in (corpo.get("preparar") or [])][:20],
                 "confirmar": [{k: str(x.get(k) or "")[:600] for k in ("nome", "canal", "contato", "produto", "situacao", "motivo", "mensagem")}
                               | {"prioridade": "alta"} for x in confirmar]}
        os.makedirs(PASTA_NOITES, exist_ok=True)
        with open(arquivo, "w", encoding="utf-8") as f:
            json.dump(noite, f, ensure_ascii=False, indent=1)
        try:
            publicar_gist()
        except Exception as exc:  # noqa: BLE001
            print(f"[gist] publicar: {exc}")
        n = enviar_push(payload_noite(noite)) if notificar else 0
        print(f"[noite] {data}: {len(limpas)} venda(s) marcada(s), {len(noite['preparar'])} preparo(s), push={n}, {time.time() - inicio:.0f} s")
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"[noite] {data}: FALHOU — {exc}")
        if notificar:
            enviar_push({"title": "Retomazera ⚠️", "body": f"A análise da noite falhou: {str(exc)[:150]}", "tag": "retomazera-erro"})
        return False
    finally:
        _analise["rodando"] = False


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
            return self._json({"dias": dias_locais(), "semanas": semanas_locais(), "noites": noites_locais(), "acoes": ler_acoes(),
                               "retornos": retornos_publicos(),
                               "espera": espera_publica(), "estoque": estoque_fila(),
                               "ts": int(time.time() * 1000)})
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
                or path.startswith("/coletas/") or path.startswith("/semanas/") or path.startswith("/noites/") or path in ("/dados.json",)):
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
            agendar_analise(corpo["data"], turno_de(corpo))
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
        if path == "/api/noite":
            data = str(corpo.get("data") or time.strftime("%Y-%m-%d"))
            if not coletas_do_dia(data, "noite"):
                return self._json({"ok": False, "erro": "sem coleta da noite nesse dia"}, 400)
            threading.Thread(target=analisar_noite, args=(data, corpo.get("notificar", True), True), daemon=True).start()
            return self._json({"ok": True, "iniciada": data})
        if path == "/api/espera":
            # adicionar à fila manualmente pelo app: {nome, canal, contato, produto, detalhes}
            if corpo.get("produto") and familia(corpo.get("produto")):
                registrar_espera([corpo], time.strftime("%Y-%m-%d"))
                return self._json({"ok": True})
            return self._json({"ok": False, "erro": "modelo não reconhecido"}, 400)
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
    threading.Thread(target=laco_espera, daemon=True).start()
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
