import type pg from "pg";
import type { RiskClassification } from "@acrv/core";
import { reviewCostUsd, type LLMProvider, type RiskClassificationRequest } from "@acrv/llm";

/** Month-to-date LLM spend per account (the GitHub owner the app is installed on). */
export interface SpendLedger {
  spent(account: string, month: string): Promise<number>;
  add(account: string, month: string, usd: number): Promise<void>;
}

export function currentMonth(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

export class InMemorySpendLedger implements SpendLedger {
  private totals = new Map<string, number>();
  async spent(account: string, month: string): Promise<number> {
    return this.totals.get(`${account}|${month}`) ?? 0;
  }
  async add(account: string, month: string, usd: number): Promise<void> {
    const key = `${account}|${month}`;
    this.totals.set(key, (this.totals.get(key) ?? 0) + usd);
  }
}

export class PostgresSpendLedger implements SpendLedger {
  constructor(private readonly pool: pg.Pool) {}
  async spent(account: string, month: string): Promise<number> {
    const { rows } = await this.pool.query<{ usd: string }>("SELECT usd FROM llm_spend WHERE account = $1 AND month = $2", [account, month]);
    return rows[0] ? Number(rows[0].usd) : 0;
  }
  async add(account: string, month: string, usd: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO llm_spend (account, month, usd) VALUES ($1, $2, $3)
       ON CONFLICT (account, month) DO UPDATE SET usd = llm_spend.usd + EXCLUDED.usd`,
      [account, month, usd],
    );
  }
}

/**
 * Enforces a monthly LLM budget per account. Over budget, the review still
 * runs -- rules, generated tests and mutation testing cost nothing extra --
 * but the model isn't called, and the review says so. The check happens
 * before the call, so a single review can overshoot by at most its own cost.
 */
export class BudgetedProvider implements LLMProvider {
  readonly name: string;

  constructor(
    private readonly inner: LLMProvider,
    private readonly ledger: SpendLedger,
    private readonly account: string,
    private readonly monthlyLimitUsd: number,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.name = inner.name;
  }

  async classify(request: RiskClassificationRequest): Promise<RiskClassification> {
    const month = currentMonth(this.now());
    const spent = await this.ledger.spent(this.account, month);
    if (spent >= this.monthlyLimitUsd) {
      return {
        riskLevel: "medium",
        summary: `LLM review skipped: ${this.account} has used its $${this.monthlyLimitUsd} monthly budget.`,
        intent: "",
        findings: [],
        fromFallback: true,
        skipped: true,
        costUsd: 0,
      };
    }
    const result = await this.inner.classify(request);
    await this.ledger.add(this.account, month, reviewCostUsd(result));
    return result;
  }
}
