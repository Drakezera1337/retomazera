"""Números de uma semana na Gestão (só leitura), para o resumo semanal do Retomazera.

Uso: python numeros_semana.py AAAA-MM-DD AAAA-MM-DD   (início e fim da semana, inclusive)
Imprime JSON com a semana pedida e a anterior: vendas, faturamento, lucro, por origem, itens
vendidos (com comprador), compras e estoque atual.
"""
import json
import sqlite3
import sys
from datetime import date, timedelta

DB = "file:D:/Loja/Programa/Gestao/dist/GestaoVendas/gestao_vendas.db?mode=ro"
NOME = "coalesce(nullif(console_nome,''),nome)"
LUCRO = "coalesce(preco_venda,0)-coalesce(preco_compra,0)-coalesce(custo_reparo,0)"


def semana(c, ini, fim, detalhes=True):
    v = c.execute(f"select count(*), coalesce(sum(preco_venda),0), coalesce(sum({LUCRO}),0) from produtos "
                  "where data_venda between ? and ? and coalesce(preco_venda,0)>0", (ini, fim)).fetchone()
    r = {"inicio": ini, "fim": fim, "vendas": v[0], "faturamento": round(v[1], 2), "lucro": round(v[2], 2)}
    r["por_origem"] = {o or "(sem origem)": n for o, n in c.execute(
        "select origem_venda, count(*) from produtos where data_venda between ? and ? and coalesce(preco_venda,0)>0 group by 1", (ini, fim))}
    cp = c.execute("select count(*), coalesce(sum(preco_compra),0) from produtos where data_compra between ? and ?", (ini, fim)).fetchone()
    r["compras"] = cp[0]
    r["valor_compras"] = round(cp[1], 2)
    if detalhes:
        r["itens_vendidos"] = [
            {"data": d, "item": n, "preco": p, "lucro": round(l, 2), "comprador": cb or "", "tel_fim": (t or "")[-8:], "origem": o or ""}
            for d, n, p, l, cb, t, o in c.execute(
                f"select data_venda, {NOME}, preco_venda, {LUCRO}, nome_comprador, tel_comprador, origem_venda from produtos "
                "where data_venda between ? and ? and coalesce(preco_venda,0)>0 order by data_venda", (ini, fim))]
    return r


def main():
    ini, fim = sys.argv[1], sys.argv[2]
    d0 = date.fromisoformat(ini)
    c = sqlite3.connect(DB, uri=True)
    saida = {
        "semana": semana(c, ini, fim),
        "semana_anterior": semana(c, (d0 - timedelta(days=7)).isoformat(), (d0 - timedelta(days=1)).isoformat(), detalhes=False),
        "estoque_atual": [{"item": n, "previsto": p} for n, p in c.execute(
            f"select {NOME}, preco_previsto from produtos where (data_venda is null or data_venda='') "
            "and status_item in ('Aguardando venda','Chegando')")],
    }
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(saida, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
