"""Cartera de demo: 20 clientes escritos a mano, coherentes entre sí y repartidos en riesgo bajo, medio y alto.

SIMULADO. El modelo (web/seed/modelo.json) sigue entrenado sobre las 800 filas sintéticas de gen_cartera.py; este
script solo reemplaza la cartera que ve la web por una más corta y variada. Cada perfil cuenta una historia
consistente (sueldo, saldo, uso de línea, atrasos y escenario real) y se verifica que la prioridad que calcula el
modelo es la buscada. Columnas `sim_*` son solo del simulador (nunca las ve un agente).

Salida: web/seed/cartera.json
"""
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web" / "seed"
TC, PP, PV = "tarjeta de crédito", "préstamo personal", "préstamo vehicular"

# (nombre, canal, hora, producto, saldo_deuda, cuota, venc_en_dias, dias_atraso, dia_sueldo, sueldo_llego,
#  saldo_cuenta, uso_tc, atrasos_6m, grupo, escenario, paga_sin_gestion, prioridad_esperada)
PERFILES = [
    # --- Riesgo bajo: sueldo al día, saldo que cubre la cuota, historial limpio ---
    ("Valeria Paredes Soto", "whatsapp", "19-21", TC, 2840, 310, 3, 0, 28, True, 4120, 22.5, 0, "tratamiento", "olvido", True, "baja"),
    ("Jorge Luis Cárdenas", "sms", "12-14", PP, 9600, 540, 5, 0, 15, True, 3870, 0.0, 0, "control", "olvido", True, "baja"),
    ("Camila Huamán Ríos", "whatsapp", "18-20", PV, 31500, 1180, 7, 0, 30, True, 6250, 0.0, 0, "tratamiento", "olvido", True, "baja"),
    ("Andrés Salazar Núñez", "llamada", "8-10", TC, 1520, 180, 2, 0, 25, True, 2310, 38.0, 1, "control", "olvido", True, "baja"),
    ("Rosa Elvira Condori", "whatsapp", "12-14", PP, 5200, 290, 0, 3, 5, True, 1640, 0.0, 0, "tratamiento", "olvido", True, "baja"),
    ("Fernando Ortiz Vega", "sms", "19-21", PV, 22800, 960, 9, 0, 1, True, 5480, 0.0, 0, "control", "olvido", True, "baja"),
    ("Lucía Mendoza Prado", "whatsapp", "18-20", TC, 4100, 420, 0, 6, 28, True, 1890, 55.0, 1, "tratamiento", "reclamo", True, "baja"),
    # --- Riesgo medio: liquidez justa, línea muy usada o sueldo que llegó tarde ---
    ("Miguel Ángel Ramos", "whatsapp", "19-21", TC, 7350, 680, 0, 12, 30, True, 410, 91.0, 2, "tratamiento", "iliquidez", True, "media"),
    ("Paula Gutiérrez León", "sms", "18-20", PP, 6800, 390, 4, 0, 10, False, 1150, 0.0, 0, "control", "retraso_ingresos", True, "media"),
    ("Héctor Vargas Quispe", "whatsapp", "12-14", PV, 18400, 870, 0, 18, 15, True, 520, 0.0, 3, "tratamiento", "iliquidez", False, "media"),
    ("Sofía Castillo Mamani", "llamada", "19-21", TC, 3260, 350, 0, 9, 25, True, 120, 86.5, 1, "control", "iliquidez", True, "media"),
    ("Diego Torres Chávez", "whatsapp", "18-20", PP, 11200, 610, 0, 22, 5, True, 280, 0.0, 3, "tratamiento", "desconoce_deuda", False, "media"),
    ("Elena Rojas Flores", "sms", "8-10", TC, 5900, 520, 6, 0, 28, False, 1480, 48.0, 0, "tratamiento", "retraso_ingresos", True, "media"),
    ("Raúl Chávez Ticona", "whatsapp", "12-14", PP, 4300, 260, 0, 14, 10, True, 60, 0.0, 4, "control", "iliquidez", False, "media"),
    # --- Riesgo alto: sin sueldo, cuenta casi vacía, línea al tope y atrasos recurrentes ---
    ("Carla Núñez Huanca", "whatsapp", "19-21", TC, 12800, 1050, 0, 28, 30, False, 85, 98.0, 4, "tratamiento", "desempleo", False, "alta"),
    ("Óscar Mamani Apaza", "llamada", "18-20", PP, 8700, 470, 0, 35, 15, False, 40, 0.0, 5, "control", "retraso_ingresos", False, "alta"),
    ("María Fernanda Ríos", "whatsapp", "18-20", TC, 6400, 590, 0, 19, 5, False, 210, 94.5, 3, "tratamiento", "retraso_ingresos", False, "alta"),
    ("Iván Quispe Lazo", "sms", "12-14", PV, 26900, 1240, 0, 41, 1, False, 330, 0.0, 6, "control", "desempleo", False, "alta"),
    ("Julia Soto Paredes", "whatsapp", "19-21", TC, 9800, 880, 0, 33, 25, True, 30, 100.0, 5, "tratamiento", "reclamo", False, "alta"),
    ("Pedro Castillo Arce", "whatsapp", "8-10", PP, 7600, 430, 2, 0, 28, False, 25, 0.0, 4, "tratamiento", "retraso_ingresos", True, "alta"),
]

CELULARES = ["987412365", "954128730", "961037482", "975820614", "948312907", "932674150", "986501273",
             "913847206", "940265831", "978130459", "925718364", "969402817", "951683720", "937204586",
             "984560312", "916735048", "972308165", "943817592", "958024671", "929461803"]


def prob(c: dict, m: dict) -> float:
    x = {
        "sin_sueldo": 0.0 if c["sueldo_llego_mes"] else 1.0,
        "cobertura_cuota": min(max(c["saldo_cuenta"] / c["monto_cuota"], 0), 3),
        "uso_linea": c["uso_linea_tc_pct"] / 100,
        "atrasos_6m": c["atrasos_ult_6m"],
        "dias_atraso_30": c["dias_atraso"] / 30,
    }
    z = m["intercept"] + sum(k * x[f] for f, k in zip(m["features"], m["coef"]))
    return 1 / (1 + math.exp(-z))


def main() -> None:
    modelo = json.loads((OUT / "modelo.json").read_text(encoding="utf-8"))
    cartera = []
    for i, (p, cel) in enumerate(zip(PERFILES, CELULARES)):
        (nombre, canal, hora, prod, deuda, cuota, venc, atraso, dia, llego, saldo, uso, atr, grupo, esc, paga, esperada) = p
        c = {
            "cliente_id": f"CL{i + 1:04d}", "nombre": nombre, "celular": cel, "canal_preferido": canal, "hora_respuesta": hora,
            "producto": prod, "saldo_deuda": float(deuda), "monto_cuota": float(cuota), "venc_en_dias": venc, "dias_atraso": atraso,
            "dia_abono_sueldo": dia, "sueldo_llego_mes": llego, "saldo_cuenta": float(saldo), "uso_linea_tc_pct": uso if prod == TC else 0.0,
            "atrasos_ult_6m": atr, "grupo": grupo, "sim_escenario": esc, "sim_pago_base": paga,
        }
        pr = prob(c, modelo)
        nivel = "alta" if pr >= 0.55 else "media" if pr >= 0.3 else "baja"
        assert nivel == esperada, f"{nombre}: p={pr:.3f} → {nivel}, se esperaba {esperada}"
        assert (venc == 0) == (atraso > 0), f"{nombre}: o vence a futuro o ya está atrasado"
        print(f"{c['cliente_id']} {nombre:<24} {grupo:<11} {esc:<17} p={pr:.2f} {nivel}")
        cartera.append(c)

    (OUT / "cartera.json").write_text(json.dumps(cartera, ensure_ascii=False, indent=1), encoding="utf-8")
    niveles = [p[-1] for p in PERFILES]
    print({n: niveles.count(n) for n in ("baja", "media", "alta")})


if __name__ == "__main__":
    main()
