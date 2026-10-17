import raw from "../public/portfolio.json";

export type Reason = { factor: string; impact_pp: number };

export type Client = {
  id: string;
  name: string;
  age: number;
  monthly_income: number;
  credit_limit: number;
  exposure_ead: number;
  open_credit_lines: number;
  debt_ratio: number;
  late_30_59: number;
  late_60_89: number;
  late_90_plus: number;
  pd: number;
  risk_band: "alto" | "medio" | "bajo";
  reasons: Reason[];
  signals_weekly: {
    utilization: number[];
    minimum_payment_only: number[];
    transactions_per_week: number[];
  };
  contact_history: unknown[];
};

export const meta = raw.meta;
export const clients = raw.clients as unknown as Client[];

export const getClient = (id: string) => clients.find((c) => c.id === id);

import { LGD } from "./core/channels";
export { LGD };
export const expectedLoss = (c: Client) => c.pd * c.exposure_ead * LGD;

export const money = (n: number) =>
  new Intl.NumberFormat("es-PE", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
