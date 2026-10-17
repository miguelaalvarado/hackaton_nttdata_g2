"""Exporta una cartera demo (JSON) con PD real de GMSC y señales semanales sintéticas.

Real: PD del modelo entrenado y razones por cliente.
Sintético: nombres, series semanales, límite de línea y exposición (EAD).
"""
import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

from train_pd import LATE, TARGET, clean, features

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web" / "public" / "portfolio.json"
N_CLIENTS = 250
WEEKS = 12
SEED = 7

NAMES = ["Ana", "Luis", "Carla", "Jorge", "Rosa", "Pedro", "Lucía", "Miguel", "Elena", "Diego", "Marta", "Andrés",
         "Sofía", "Raúl", "Paula", "Héctor", "Valeria", "Óscar", "Camila", "Iván"]
SURNAMES = ["Quispe", "Flores", "Rojas", "Huamán", "Torres", "Vargas", "Mendoza", "Castillo", "Ramos", "Chávez",
            "Gutiérrez", "Paredes", "Salazar", "Ortiz", "Cárdenas", "Núñez"]

LABELS = {
    "RevolvingUtilizationOfUnsecuredLines": "Uso alto de la línea de crédito",
    "NumberOfTime30-59DaysPastDueNotWorse": "Atrasos de 30-59 días",
    "NumberOfTime60-89DaysPastDueNotWorse": "Atrasos de 60-89 días",
    "NumberOfTimes90DaysLate": "Atrasos de 90+ días",
    "total_late": "Historial de atrasos acumulado",
    "late_severity": "Severidad de los atrasos",
    "age": "Perfil de edad",
    "DebtRatio": "Ratio deuda/ingreso elevado",
    "MonthlyIncome": "Ingreso mensual bajo",
    "NumberOfOpenCreditLinesAndLoans": "Número de líneas y préstamos abiertos",
    "debt_amount": "Monto de deuda mensual",
    "NumberRealEstateLoansOrLines": "Préstamos hipotecarios o inmobiliarios",
    "NumberOfDependents": "Número de dependientes",
    "income_missing": "Ingreso no declarado",
}


def reasons(model, columns, X: pd.DataFrame, p: np.ndarray, medians: pd.Series) -> list[list[dict]]:
    """Razones por cliente: cuánto baja la PD al reemplazar cada variable por la mediana."""
    deltas = {}
    for c in columns:
        Xc = X.copy()
        Xc[c] = medians[c]
        deltas[c] = p - model.predict_proba(Xc)[:, 1]
    D = pd.DataFrame(deltas, index=X.index)
    out = []
    for i in range(len(X)):
        top = D.iloc[i].nlargest(3)
        out.append([{"factor": LABELS.get(k, k), "impact_pp": round(float(v) * 100, 1)} for k, v in top.items() if v > 0.002])
    return out


def series(rng: np.random.Generator, pd_: float, util_now: float) -> dict:
    """12 semanas sintéticas; los clientes de riesgo se deterioran hacia el valor actual."""
    t = np.linspace(0, 1, WEEKS)
    drift = min(1.0, pd_ * 3)  # PD alta -> más deterioro
    util = np.clip(util_now * (1 - 0.45 * drift * (1 - t)) + rng.normal(0, 0.02, WEEKS), 0, 1.5)
    min_pay = np.clip(rng.random(WEEKS) < (0.1 + 0.8 * drift * t), 0, 1).astype(int)  # pago mínimo en la semana
    base = rng.integers(8, 20)
    txns = np.clip(np.round(base * (1 - 0.5 * drift * t) + rng.normal(0, 1.2, WEEKS)), 0, None).astype(int)
    return {
        "utilization": [round(float(x), 3) for x in util],
        "minimum_payment_only": min_pay.tolist(),
        "transactions_per_week": txns.tolist(),
    }


def main() -> None:
    rng = np.random.default_rng(SEED)
    bundle = joblib.load(ROOT / "models" / "pd_gmsc.joblib")
    model, columns = bundle["model"], bundle["columns"]

    raw = pd.read_csv(ROOT / "data" / "gmsc" / "cs-training.csv", index_col=0)
    df = features(clean(raw))
    X = df[columns]
    df["pd"] = model.predict_proba(X)[:, 1]

    # Cartera demo: 30 % de riesgo alto, 40 % medio, 30 % bajo, con datos de uso/ingreso presentes
    ok = df[df["MonthlyIncome"].notna() & df["age"].notna() & (df["RevolvingUtilizationOfUnsecuredLines"] > 0)]
    hi = ok[ok["pd"] >= 0.30].sample(int(N_CLIENTS * 0.30), random_state=SEED)
    mid = ok[(ok["pd"] >= 0.08) & (ok["pd"] < 0.30)].sample(int(N_CLIENTS * 0.40), random_state=SEED)
    lo = ok[ok["pd"] < 0.08].sample(N_CLIENTS - len(hi) - len(mid), random_state=SEED)
    sample = pd.concat([hi, mid, lo]).sample(frac=1, random_state=SEED)

    medians = df[columns].median()
    why = reasons(model, columns, sample[columns], sample["pd"].to_numpy(), medians)

    clients = []
    for k, ((idx, row), rs) in enumerate(zip(sample.iterrows(), why), start=1):
        income = float(row["MonthlyIncome"])
        limit = round(max(1500.0, income * rng.uniform(1.5, 3.5)), -2)  # sintético
        util_now = float(min(row["RevolvingUtilizationOfUnsecuredLines"], 1.2))
        ead = round(limit * min(util_now, 1.0), 0)
        p = float(row["pd"])
        clients.append({
            "id": f"C-{k:04d}",
            "gmsc_row": int(idx),
            "name": f"{rng.choice(NAMES)} {rng.choice(SURNAMES)}",
            "age": int(row["age"]),
            "monthly_income": round(income),
            "credit_limit": limit,
            "exposure_ead": ead,
            "open_credit_lines": int(row["NumberOfOpenCreditLinesAndLoans"]),
            "debt_ratio": round(float(row["DebtRatio"]), 2),
            "late_30_59": int(row[LATE[0]]) if pd.notna(row[LATE[0]]) else 0,
            "late_60_89": int(row[LATE[1]]) if pd.notna(row[LATE[1]]) else 0,
            "late_90_plus": int(row[LATE[2]]) if pd.notna(row[LATE[2]]) else 0,
            "pd": round(p, 4),
            "risk_band": "alto" if p >= 0.30 else "medio" if p >= 0.08 else "bajo",
            "reasons": rs,
            "signals_weekly": series(rng, p, util_now),
            "contact_history": [],
            "actual_default": int(row[TARGET]) if TARGET in row else None,
        })
    clients.sort(key=lambda c: -c["pd"])

    out = {
        "meta": {
            "source": "Give Me Some Credit (Kaggle, brycecf/give-me-some-credit-dataset)",
            "model": "HistGradientBoosting calibrado (AUC 0.868 en holdout)",
            "real": ["pd", "reasons", "age", "monthly_income", "debt_ratio", "late_*", "open_credit_lines", "gmsc_row"],
            "synthetic": ["name", "credit_limit", "exposure_ead", "signals_weekly"],
            "weeks": WEEKS,
        },
        "clients": clients,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    bands = pd.Series([c["risk_band"] for c in clients]).value_counts().to_dict()
    print(f"{len(clients)} clientes -> {OUT} ({OUT.stat().st_size/1024:.0f} KB)", bands)
    print(json.dumps(clients[0], ensure_ascii=False)[:600])


if __name__ == "__main__":
    main()
