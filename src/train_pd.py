"""Limpia GMSC y entrena el modelo de probabilidad de mora (PD)."""
import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.inspection import permutation_importance
from sklearn.metrics import average_precision_score, brier_score_loss, roc_auc_score
from sklearn.model_selection import train_test_split

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "gmsc" / "cs-training.csv"
OUT = ROOT / "models"
TARGET = "SeriousDlqin2yrs"

LATE = ["NumberOfTime30-59DaysPastDueNotWorse", "NumberOfTime60-89DaysPastDueNotWorse", "NumberOfTimes90DaysLate"]


def clean(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    # 96/98 son centinelas en los conteos de atrasos
    for c in LATE:
        df[c] = df[c].where(~df[c].isin([96, 98]), np.nan)
    df["age"] = df["age"].where(df["age"] >= 18, np.nan)
    df["RevolvingUtilizationOfUnsecuredLines"] = df["RevolvingUtilizationOfUnsecuredLines"].clip(upper=2.0)
    df["DebtRatio"] = df["DebtRatio"].clip(upper=df["DebtRatio"].quantile(0.99))
    df["MonthlyIncome"] = df["MonthlyIncome"].clip(upper=df["MonthlyIncome"].quantile(0.999))
    return df


def features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["income_missing"] = df["MonthlyIncome"].isna().astype(int)
    df["total_late"] = df[LATE].sum(axis=1, min_count=1)
    df["late_severity"] = (df[LATE[0]].fillna(0) + 2 * df[LATE[1]].fillna(0) + 3 * df[LATE[2]].fillna(0))
    df["debt_amount"] = df["DebtRatio"] * df["MonthlyIncome"]
    return df


def main() -> None:
    raw = pd.read_csv(RAW, index_col=0)
    df = features(clean(raw))
    X, y = df.drop(columns=TARGET), df[TARGET]
    Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=0.25, random_state=0, stratify=y)

    base = HistGradientBoostingClassifier(
        learning_rate=0.05, max_iter=400, max_leaf_nodes=15, min_samples_leaf=100,
        l2_regularization=1.0, early_stopping=True, validation_fraction=0.15,
        n_iter_no_change=30, random_state=0,
    )
    model = CalibratedClassifierCV(base, method="isotonic", cv=3)
    model.fit(Xtr, ytr)
    p = model.predict_proba(Xte)[:, 1]

    k = int(len(yte) * 0.10)
    top = np.argsort(-p)[:k]
    metrics = {
        "rows": int(len(df)), "default_rate": round(float(y.mean()), 4),
        "auc": round(roc_auc_score(yte, p), 4),
        "pr_auc": round(average_precision_score(yte, p), 4),
        "brier": round(brier_score_loss(yte, p), 4),
        "recall_top10pct": round(float(yte.to_numpy()[top].sum() / yte.sum()), 4),
        "precision_top10pct": round(float(yte.to_numpy()[top].mean()), 4),
        "mean_pred": round(float(p.mean()), 4),
    }

    imp = permutation_importance(model, Xte, yte, scoring="roc_auc", n_repeats=3, random_state=0, n_jobs=-1)
    metrics["top_features"] = dict(
        sorted(zip(X.columns, imp.importances_mean.round(4).tolist()), key=lambda t: -t[1])[:6]
    )

    OUT.mkdir(exist_ok=True)
    joblib.dump({"model": model, "columns": list(X.columns)}, OUT / "pd_gmsc.joblib")
    (OUT / "pd_gmsc_metrics.json").write_text(json.dumps(metrics, indent=2))
    print(json.dumps(metrics, indent=2))


if __name__ == "__main__":
    main()
