import { clients } from "../portfolio";
import type { PortfolioRepository } from "../core/ports";
import type { RiskScorer } from "../core/ports";

/** Cartera leída del JSON generado por src/export_demo.py. */
export const jsonPortfolio: PortfolioRepository = {
  async list() {
    return clients;
  },
  async get(id) {
    return clients.find((c) => c.id === id);
  },
};

/** PD y razones precalculadas por el modelo de Python (models/pd_gmsc.joblib). */
export const precomputedScorer: RiskScorer = {
  async assess(client) {
    return { pd: client.pd, band: client.risk_band, reasons: client.reasons };
  },
};
