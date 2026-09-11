import type { Evaluation, MonthlyFlow } from "cashflow-engine";

/**
 * Formatting helpers.
 *
 * Two rules run through this file. Numbers are rounded once, here, at the edge,
 * so the engine never carries presentation concerns. And a value that does not
 * exist is rendered as a phrase, never as a sentinel number: an agent that
 * reads "not within the term" cannot accidentally report -1% as a return.
 */

export function round(value: number, decimals = 2): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

export function percent(value: number | null, decimals = 2): string {
  return value === null ? "not reportable" : `${round(value * 100, decimals).toFixed(decimals)}%`;
}

export function months(value: number | null): string {
  return value === null ? "not within the term" : `month ${value}`;
}

export function money(value: number): string {
  return round(value, 0).toLocaleString("en-US");
}

/** Compact a monthly schedule row for transport. */
export function compactFlow(row: MonthlyFlow) {
  return {
    month: row.month,
    year: row.year,
    revenue: round(row.totalRevenue),
    cost: round(row.totalCost),
    ebitda: round(row.ebitda),
    installment: round(row.installment),
    investment: round(row.investment),
    workingCapitalDelta: round(row.workingCapitalDelta),
    netCashFlow: round(row.netCashFlow),
    cumulativeCashFlow: round(row.cumulativeCashFlow),
  };
}

export type ScheduleDetail = "none" | "annual" | "monthly";

/** The structured payload every evaluation-shaped tool returns. */
export function evaluationPayload(result: Evaluation, detail: ScheduleDetail) {
  const { metrics, breakeven, financing, workingCapital } = result;

  return {
    metrics: {
      irrAnnual: metrics.irrAnnual === null ? null : round(metrics.irrAnnual, 6),
      irrUnavailableReason: metrics.irrUnavailableReason,
      npv: round(metrics.npv),
      paybackMonth: metrics.paybackMonth,
      discountedPaybackMonth: metrics.discountedPaybackMonth,
      moic: round(metrics.moic, 4),
      roi: round(metrics.roi, 4),
      totalInflows: round(metrics.totalInflows),
      totalOutflows: round(metrics.totalOutflows),
      baseMonthlyEbitda: round(metrics.baseMonthlyEbitda),
      averageMonthlyNetCashFlow: round(metrics.averageMonthlyNetCashFlow),
      netCashFlowMargin: round(metrics.netCashFlowMargin, 4),
    },
    financing: {
      downPayment: round(financing.downPayment),
      monthlyInstallment: round(financing.monthlyInstallment),
      totalInstallments: round(financing.totalInstallments),
      financingCost: round(financing.financingCost),
    },
    workingCapital: {
      receivables: round(workingCapital.receivables),
      payables: round(workingCapital.payables),
      inventory: round(workingCapital.inventory),
      net: round(workingCapital.net),
    },
    breakeven: breakeven
      ? {
          units: Number.isFinite(breakeven.units) ? round(breakeven.units, 2) : null,
          unitsUnreachable: !Number.isFinite(breakeven.units),
          revenue: Number.isFinite(breakeven.revenue) ? round(breakeven.revenue) : null,
          marginOfSafetyPct: round(breakeven.marginOfSafetyPct, 2),
          averagePrice: round(breakeven.averagePrice),
          variableCostPerUnit: round(breakeven.variableCostPerUnit),
          contributionPerUnit: round(breakeven.contributionPerUnit),
        }
      : null,
    annual: result.annual.map((year) => ({
      year: year.year,
      revenue: round(year.totalRevenue),
      operatingCost: round(year.operatingCost),
      installments: round(year.installments),
      maintenanceCost: round(year.maintenanceCost),
      netCashFlow: round(year.netCashFlow),
      operatingMargin: round(year.operatingMargin, 4),
    })),
    schedule:
      detail === "monthly"
        ? result.schedule.map(compactFlow)
        : detail === "none"
          ? undefined
          : [],
    scheduleDetail: detail,
    warnings: result.warnings,
  };
}

/** Human-readable report for the same payload. */
export function evaluationMarkdown(
  title: string,
  payload: ReturnType<typeof evaluationPayload>,
): string {
  const m = payload.metrics;
  const lines: string[] = [`# ${title}`, ""];

  lines.push("## Headline");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---|");
  lines.push(`| IRR (annual) | ${percent(m.irrAnnual)} |`);
  lines.push(`| NPV | ${money(m.npv)} |`);
  lines.push(`| Payback | ${months(m.paybackMonth)} |`);
  lines.push(`| Discounted payback | ${months(m.discountedPaybackMonth)} |`);
  lines.push(`| MOIC | ${m.moic.toFixed(2)}x |`);
  lines.push(`| Base monthly EBITDA | ${money(m.baseMonthlyEbitda)} |`);
  lines.push(`| Total outflows | ${money(m.totalOutflows)} |`);
  lines.push("");

  if (m.irrAnnual === null) {
    lines.push(
      `> IRR is not reportable for these flows (${m.irrUnavailableReason}). Read NPV instead.`,
      "",
    );
  }

  const f = payload.financing;
  if (f.totalInstallments > 0 || f.downPayment > 0) {
    lines.push("## Financing");
    lines.push("");
    lines.push(`- Down payment: ${money(f.downPayment)}`);
    lines.push(`- Monthly installment: ${money(f.monthlyInstallment)}`);
    lines.push(`- Total installments: ${money(f.totalInstallments)}`);
    lines.push(`- Interest paid: ${money(f.financingCost)}`);
    lines.push("");
  }

  if (payload.workingCapital.net !== 0) {
    const w = payload.workingCapital;
    lines.push("## Working capital");
    lines.push("");
    lines.push(
      `Net ${money(w.net)} (receivables ${money(w.receivables)}, payables ${money(
        w.payables,
      )}, inventory ${money(w.inventory)}).`,
    );
    lines.push("");
  }

  if (payload.breakeven) {
    const b = payload.breakeven;
    lines.push("## Break-even");
    lines.push("");
    if (b.unitsUnreachable) {
      lines.push(
        "Contribution per unit is zero or negative, so no volume reaches break-even at these prices.",
      );
    } else {
      lines.push(`- Units per month: ${b.units}`);
      lines.push(`- Average price: ${money(b.averagePrice)}`);
      lines.push(`- Contribution per unit: ${money(b.contributionPerUnit)}`);
      lines.push(`- Margin of safety: ${b.marginOfSafetyPct}%`);
    }
    lines.push("");
  }

  if (payload.annual.length > 0 && payload.scheduleDetail !== "none") {
    lines.push("## By contract year");
    lines.push("");
    lines.push("| Year | Revenue | Operating cost | Installments | Net cash flow | Margin |");
    lines.push("|---|---|---|---|---|---|");
    for (const y of payload.annual) {
      lines.push(
        `| ${y.year} | ${money(y.revenue)} | ${money(y.operatingCost)} | ${money(
          y.installments,
        )} | ${money(y.netCashFlow)} | ${(y.operatingMargin * 100).toFixed(1)}% |`,
      );
    }
    lines.push("");
  }

  if (payload.scheduleDetail === "monthly" && payload.schedule?.length) {
    lines.push(
      `## Monthly schedule`,
      "",
      `${payload.schedule.length} rows returned in structuredContent.`,
      "",
    );
  }

  if (payload.warnings.length > 0) {
    lines.push("## Warnings");
    lines.push("");
    for (const w of payload.warnings) {
      lines.push(`- **${w.level.toUpperCase()} ${w.code}**: ${w.message}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
