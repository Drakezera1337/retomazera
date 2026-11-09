"""Diz à tarefa do Claude se há coleta nova para analisar (roda a cada 30 min).

Imprime:
  PENDENTE AAAA-MM-DD   → há coleta desse dia ainda não analisada (e já completa)
  NADA: <motivo>        → nada a fazer agora

"Completa" = chegaram as 3 fontes (whatsapp, facebook, olx), ou a primeira chegou há mais de
20 min (um perfil do Chrome pode estar fechado: analisa com o que tiver).
"""
import json
import os
import sys
import time

BASE = os.path.dirname(os.path.abspath(__file__))
FONTES = ("whatsapp", "facebook", "olx")


def main():
    hoje = time.strftime("%Y-%m-%d")
    pasta = os.path.join(BASE, "coletas", hoje)
    coletas = {}
    for f in FONTES:
        try:
            with open(os.path.join(pasta, f + ".json"), encoding="utf-8") as arq:
                coletas[f] = json.load(arq).get("coletadoEm") or 0
        except (OSError, ValueError):
            pass
    if not coletas:
        return "NADA: nenhuma coleta hoje ainda"
    ultima = max(coletas.values()) / 1000
    primeira = min(coletas.values()) / 1000
    try:
        with open(os.path.join(BASE, "lembretes", hoje + ".json"), encoding="utf-8") as arq:
            gerado = (json.load(arq).get("geradoEm") or 0) / 1000
    except (OSError, ValueError):
        gerado = 0
    if gerado and gerado >= ultima:
        return f"NADA: a coleta de hoje já foi analisada ({time.strftime('%H:%M', time.localtime(gerado))})"
    faltam = [f for f in FONTES if f not in coletas]
    if faltam and time.time() - primeira < 20 * 60:
        return f"NADA: esperando {', '.join(faltam)} (coleta em andamento)"
    if time.time() - ultima < 60:
        return "NADA: coleta acabou de chegar, confira na próxima rodada"
    return f"PENDENTE {hoje}" + (f" (sem {', '.join(faltam)})" if faltam else "")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    print(main())
