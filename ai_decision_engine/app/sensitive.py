"""Detección de atributos sensibles/protegidos. No se usan para decidir ni se aceptan como entrada."""
from __future__ import annotations

import re
import unicodedata

SENSITIVE_TERMS = {
    "age", "edad", "birth_date", "birthdate", "fecha_nacimiento", "gender", "genero", "sexo", "sex",
    "religion", "ethnicity", "etnia", "race", "raza", "nationality", "nacionalidad",
    "disability", "discapacidad", "health", "salud", "medical", "diagnostico",
    "political", "politica", "politico", "sexual_orientation", "orientacion_sexual",
    "marital_status", "estado_civil", "pregnancy", "embarazo", "union", "sindicato",
    "ubigeo", "district", "distrito", "skin_color", "language_origin",
}

# Términos en texto libre que un mensaje nunca debe mencionar
SENSITIVE_TEXT_PATTERN = re.compile(
    r"\b(edad|g[eé]nero|sexo|religi[oó]n|raza|etnia|nacionalidad|discapacidad|salud|embarazo|"
    r"estado civil|orientaci[oó]n sexual|pol[ií]tic[ao]|age|gender|religion|race|ethnicity|disability)\b",
    re.IGNORECASE,
)


def _norm(key: str) -> str:
    key = unicodedata.normalize("NFKD", key).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "_", key).strip("_")


def find_sensitive_keys(data) -> set[str]:
    """Recorre el JSON y devuelve las claves que coinciden con atributos sensibles."""
    found: set[str] = set()
    if isinstance(data, dict):
        for k, v in data.items():
            if isinstance(k, str) and _norm(k) in SENSITIVE_TERMS:
                found.add(k)
            found |= find_sensitive_keys(v)
    elif isinstance(data, list):
        for item in data:
            found |= find_sensitive_keys(item)
    return found


def mentions_sensitive_text(text: str) -> list[str]:
    return sorted({m.group(0).lower() for m in SENSITIVE_TEXT_PATTERN.finditer(text)})
