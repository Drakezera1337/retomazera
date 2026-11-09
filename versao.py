"""Sobe a versão do Retomazera antes de publicar (python versao.py).

Atualiza, num número só:
- sw.js      → nome do cache do modo offline (retomazera-vN)
- index.html → ?v=N nos arquivos CSS/JS (o celular baixa os novos, sem reaproveitar velhos)
- config.js  → RZ_VERSAO (aparece em Ajustes para conferir se o aparelho está atualizado)
"""
import re
from pathlib import Path

RAIZ = Path(__file__).parent


def ler(nome):
    return (RAIZ / nome).read_text(encoding="utf-8-sig")


def gravar(nome, texto):
    (RAIZ / nome).write_text(texto, encoding="utf-8")


atual = int(re.search(r"const RZ_VERSAO = (\d+);", ler("config.js")).group(1))
nova = atual + 1

gravar("sw.js", re.sub(r"retomazera-v\d+", f"retomazera-v{nova}", ler("sw.js")))
gravar("index.html", re.sub(r'((?:href|src)="[\w/.-]+\.(?:css|js))(?:\?v=\d+)?"', rf'\1?v={nova}"', ler("index.html")))
gravar("config.js", re.sub(r"const RZ_VERSAO = \d+;", f"const RZ_VERSAO = {nova};", ler("config.js")))
print(f"versao {atual} -> {nova}")
