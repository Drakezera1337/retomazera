"""
Retomazera - servidor local.

Todo dia, às 00h, uma tarefa agendada do Claude lê as conversas do dia (WhatsApp Web,
Messenger do Facebook e chat da OLX, no Chrome do PC) e manda para cá a lista de quem
vale chamar de novo no dia seguinte para fechar venda (POST /api/lembretes).

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
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("RETOMAZERA_PORT", "8797"))
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DADOS = os.path.join(BASE_DIR, "dados.json")          # token/gist/inscrição do PC (fora do git)
PASTA_DIAS = os.path.join(BASE_DIR, "lembretes")      # histórico local (fora do git)
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
    corpo = {"dias": dias_locais(), "ts": int(time.time() * 1000)}
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
    dia = {"data": data, "geradoEm": int(time.time() * 1000), "resumo": str(corpo.get("resumo") or "")[:1500],
           "fontes": corpo.get("fontes") if isinstance(corpo.get("fontes"), dict) else {}, "itens": limpos}
    os.makedirs(PASTA_DIAS, exist_ok=True)
    with open(os.path.join(PASTA_DIAS, data + ".json"), "w", encoding="utf-8") as f:
        json.dump(dia, f, ensure_ascii=False, indent=1)
    return dia


# --------------------------------------------------------------------------- laço do Gist
def processar_gist():
    """Lê push.json (aparelhos inscritos) e responde aos pedidos de teste do celular."""
    g = gist_request()
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
        return origem is None or origem in (f"http://localhost:{PORT}", f"http://127.0.0.1:{PORT}")

    PRIVADOS = (".pem", ".tmp", ".py", ".bat", ".md", ".log", ".txt")

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/status":
            return self._json(self.status_json())
        if path == "/api/lembretes":
            return self._json({"dias": dias_locais(), "ts": int(time.time() * 1000)})
        if path == "/api/celular":
            cfg = gist_cfg()
            if not cfg:
                return self._json({"erro": "Conecte o Gist primeiro"}, 400)
            dados = json.dumps(cfg, separators=(",", ":")).encode()
            b64 = urllib.parse.quote(base64.urlsafe_b64encode(dados).decode().rstrip("="))
            return self._json({"url": f"{SITE_PUBLICO}#config={b64}"})
        if (path.lower().endswith(self.PRIVADOS) or "/." in path or path.startswith("/lembretes/")
                or path in ("/dados.json",)):
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
