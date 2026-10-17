"""NEXO AI · Demo Arena (entrada única de Streamlit). Navegación entre vistas; la lógica vive en app/ (sin cambios)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import streamlit as st

st.set_page_config(page_title="NEXO AI · Demo Arena", page_icon="🏟️", layout="wide")
pages = [
    st.Page("views/home.py", title="Portafolio", icon="🏠", default=True),
    st.Page("views/cliente360.py", title="Expediente del cliente", icon="👤"),
    st.Page("views/agentes.py", title="Agentes en vivo", icon="🤖"),
    st.Page("views/demo.py", title="Demo en 2 minutos", icon="⏱️"),
    st.Page("views/consola_tecnica.py", title="Consola técnica", icon="🛠️"),
]
st.navigation(pages).run()
