"""Genera la cartera sintética (tabla `cartera`), las reglas y entrena el modelo de probabilidad de no pago.

SIMULADO: casi todo es sintético. Solo `uso_linea_tc_pct` y `atrasos_ult_6m` se anclan a las distribuciones
reales de Give Me Some Credit. Los patrones se plantean a propósito (sin sueldo, saldo menor a la cuota, tarjeta
al límite y atrasos suben la probabilidad de no pago), así que el AUC mide cuánto recupera el modelo de esos
patrones con ruido, NO desempeño en producción. Columnas `sim_*` son solo del simulador (nunca las ve un agente).

Salidas (web/seed/): cartera.json, reglas.json, modelo.json
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score, roc_curve
from sklearn.model_selection import train_test_split

from train_pd import LATE, clean

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web" / "seed"
N = 800
SEED = 11
rng = np.random.default_rng(SEED)

NAMES = ["Ana", "Luis", "Carla", "Jorge", "Rosa", "Pedro", "Lucía", "Miguel", "Elena", "Diego", "Marta", "Andrés",
         "Sofía", "Raúl", "Paula", "Héctor", "Valeria", "Óscar", "Camila", "Iván", "María", "Carlos", "Julia", "Fernando"]
SURNAMES = ["Quispe", "Flores", "Rojas", "Huamán", "Torres", "Vargas", "Mendoza", "Castillo", "Ramos", "Chávez",
            "Gutiérrez", "Paredes", "Salazar", "Ortiz", "Cárdenas", "Núñez", "Condori", "Mamani", "Ríos", "Soto"]

FEATURES = ["sin_sueldo", "cobertura_cuota", "uso_linea", "atrasos_6m", "dias_atraso_30"]


def build() -> pd.DataFrame:
    # Anclaje a datos reales: uso de línea y atrasos salen de GMSC
    g = clean(pd.read_csv(ROOT / "data" / "gmsc" / "cs-training.csv", index_col=0)).dropna(subset=["RevolvingUtilizationOfUnsecuredLines"])
    s = g.sample(N, random_state=SEED, replace=False).reset_index(drop=True)
    uso_real = (s["RevolvingUtilizationOfUnsecuredLines"].clip(0, 1.0) * 100).round(1)
    atr_real = s[LATE].fillna(0).sum(axis=1).clip(0, 6).astype(int)

    producto = rng.choice(["tarjeta de crédito", "préstamo personal", "préstamo vehicular"], N, p=[0.45, 0.40, 0.15])
    es_tc = producto == "tarjeta de crédito"
    sueldo_llego = rng.random(N) < 0.78
    sin_sueldo = ~sueldo_llego

    # Patrones plantados: sin sueldo -> más atrasos y menos saldo
    atrasos = np.clip(atr_real.to_numpy() + np.where(sin_sueldo, rng.integers(0, 3, N), 0), 0, 6)
    cuota = np.round(rng.lognormal(5.6, 0.55, N), -1).clip(80, 2500)
    saldo_cuenta = np.round(np.where(sin_sueldo, rng.lognormal(4.6, 0.9, N), rng.lognormal(6.3, 0.8, N)), 0)
    uso = np.where(es_tc, uso_real.to_numpy(), 0.0)
    dias_atraso = np.where(rng.random(N) < 0.55, 0, rng.integers(1, 46, N))
    dias_atraso = np.where((atrasos > 2) & (dias_atraso == 0), rng.integers(1, 20, N), dias_atraso)

    saldo_deuda = np.round(cuota * rng.uniform(4, 30, N), 0)

    # Probabilidad latente de no pago (con ruido no observable por el modelo)
    logit = (-2.3 + 1.5 * sin_sueldo + 1.1 * (saldo_cuenta < cuota) + 0.9 * (uso > 80) + 0.30 * atrasos
             + 0.025 * dias_atraso + rng.normal(0, 0.8, N))
    p_no_pago = 1 / (1 + np.exp(-logit))
    no_pago = rng.random(N) < p_no_pago

    # Escenario real del cliente (guía al cliente simulado; el Gestor debe descubrirlo conversando)
    esc = []
    for i in range(N):
        r = rng.random()
        if r < 0.05: esc.append("desempleo")
        elif r < 0.08: esc.append("reclamo")
        elif r < 0.10: esc.append("desconoce_deuda")
        elif sin_sueldo[i]: esc.append("retraso_ingresos")
        elif saldo_cuenta[i] < cuota[i] or uso[i] > 80: esc.append("iliquidez")
        else: esc.append("olvido")

    venc_en_dias = np.where(dias_atraso > 0, 0, rng.integers(1, 11, N))
    hora = rng.choice(["8-10", "12-14", "18-20", "19-21"], N, p=[0.12, 0.2, 0.3, 0.38])
    # Tratamiento / control 50-50, balanceado
    grupo = np.where(rng.random(N) < 0.5, "tratamiento", "control")

    df = pd.DataFrame({
        "cliente_id": [f"CL{idx+1:04d}" for idx in range(N)],
        "nombre": [f"{rng.choice(NAMES)} {rng.choice(SURNAMES)}" for _ in range(N)],
        "celular": ["9" + "".join(map(str, rng.integers(0, 10, 8))) for _ in range(N)],
        "canal_preferido": rng.choice(["whatsapp", "sms", "llamada"], N, p=[0.6, 0.25, 0.15]),
        "hora_respuesta": hora,
        "producto": producto,
        "saldo_deuda": saldo_deuda,
        "monto_cuota": cuota,
        "venc_en_dias": venc_en_dias.astype(int),
        "dias_atraso": dias_atraso.astype(int),
        "dia_abono_sueldo": rng.choice([1, 5, 10, 15, 25, 28, 30], N),
        "sueldo_llego_mes": sueldo_llego,
        "saldo_cuenta": saldo_cuenta,
        "uso_linea_tc_pct": uso,
        "atrasos_ult_6m": atrasos.astype(int),
        "grupo": grupo,
        "sim_escenario": esc,
        "sim_pago_base": ~no_pago,
    })
    return df


def feats(df: pd.DataFrame) -> pd.DataFrame:
    return pd.DataFrame({
        "sin_sueldo": (~df["sueldo_llego_mes"]).astype(float),
        "cobertura_cuota": (df["saldo_cuenta"] / df["monto_cuota"]).clip(0, 3),
        "uso_linea": df["uso_linea_tc_pct"] / 100,
        "atrasos_6m": df["atrasos_ult_6m"].astype(float),
        "dias_atraso_30": df["dias_atraso"] / 30,
    })[FEATURES]


def ks(y, p) -> float:
    fpr, tpr, _ = roc_curve(y, p)
    return float(np.max(tpr - fpr))


def regla_docx(df: pd.DataFrame) -> np.ndarray:
    """Puntaje por reglas del documento de diseño (baseline)."""
    return (30 * (~df["sueldo_llego_mes"]) + 25 * (df["saldo_cuenta"] < df["monto_cuota"])
            + 20 * (df["uso_linea_tc_pct"] > 80) + 25 * (df["atrasos_ult_6m"] > 0)).to_numpy()


def main() -> None:
    df = build()
    X, y = feats(df), (~df["sim_pago_base"]).astype(int)
    Xtr, Xte, ytr, yte, dtr, dte = train_test_split(X, y, df, test_size=0.3, random_state=SEED, stratify=y)
    lr = LogisticRegression(C=1.0, max_iter=1000).fit(Xtr, ytr)
    p = lr.predict_proba(Xte)[:, 1]
    rule = regla_docx(dte)

    k = int(len(yte) * 0.2)
    top = np.argsort(-p)[:k]
    base_rate = float(yte.mean())
    prec = float(yte.to_numpy()[top].mean())
    metrics = {
        "origen": "SINTÉTICO: patrones plantados con ruido; no es desempeño en producción",
        "n_total": int(len(df)), "n_test": int(len(yte)),
        "tasa_no_pago": round(base_rate, 4),
        "auc_modelo": round(roc_auc_score(yte, p), 4),
        "auc_regla_docx": round(roc_auc_score(yte, rule), 4),
        "ks_modelo": round(ks(yte, p), 4),
        "precision_top20": round(prec, 4),
        "lift_top20": round(prec / base_rate, 2),
    }

    modelo = {"features": FEATURES, "coef": [round(float(c), 5) for c in lr.coef_[0]],
              "intercept": round(float(lr.intercept_[0]), 5), "metricas": metrics}

    OUT.mkdir(parents=True, exist_ok=True)
    out = df.copy()
    for c in ("sueldo_llego_mes", "sim_pago_base"):
        out[c] = out[c].astype(bool)
    (OUT / "cartera.json").write_text(json.dumps(out.to_dict("records"), ensure_ascii=False, default=float), encoding="utf-8")
    (OUT / "modelo.json").write_text(json.dumps(modelo, ensure_ascii=False, indent=2), encoding="utf-8")

    reglas = [
        {"regla_id": 1, "tipo": "horario", "condicion": "lunes a sábado", "valor": "08:00-20:00",
         "descripcion": "Horario permitido de contacto (demo). Ajustar a la norma real: puede excluir fines de semana y feriados."},
        {"regla_id": 2, "tipo": "limite_contacto", "condicion": "por cliente", "valor": "máx. 3 por semana",
         "descripcion": "Contactos iniciales por cliente en 7 días."},
        {"regla_id": 3, "tipo": "opcion_pago", "condicion": "motivo = retraso_ingresos", "valor": "mover la fecha de pago hasta 7 días",
         "descripcion": "Reprogramación corta cuando el ingreso llega tarde."},
        {"regla_id": 4, "tipo": "opcion_pago", "condicion": "dias_atraso 1–30", "valor": "fraccionar la cuota en 2 pagos",
         "descripcion": "Fraccionamiento para atrasos de hasta 30 días."},
        {"regla_id": 5, "tipo": "escalamiento", "condicion": "motivo = desempleo, reclamo, desconoce_deuda", "valor": "pasar a un humano",
         "descripcion": "Casos sensibles los atiende una persona."},
        {"regla_id": 6, "tipo": "opcion_pago", "condicion": "motivo = olvido", "valor": "pagar hoy por app o transferencia",
         "descripcion": "(demo, no está en el documento) Pago inmediato cuando solo fue olvido."},
        {"regla_id": 7, "tipo": "opcion_pago", "condicion": "motivo = iliquidez", "valor": "mover la fecha de pago hasta 7 días",
         "descripcion": "(demo, no está en el documento) Reprogramación corta por falta de liquidez."},
        {"regla_id": 8, "tipo": "lenguaje", "condicion": "siempre",
         "valor": "embargo, denuncia, policía, cárcel, familiares, vecinos, demanda judicial",
         "descripcion": "(demo) Términos prohibidos en cualquier mensaje."},
    ]
    (OUT / "reglas.json").write_text(json.dumps(reglas, ensure_ascii=False, indent=2), encoding="utf-8")

    print(json.dumps(metrics, ensure_ascii=False, indent=2))
    print("coef:", dict(zip(FEATURES, modelo["coef"])), "intercept", modelo["intercept"])
    print("escenarios:", df["sim_escenario"].value_counts().to_dict(), "| prioridad alta aprox:", int((lr.predict_proba(X)[:, 1] >= 0.55).sum()))


if __name__ == "__main__":
    main()
