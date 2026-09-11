import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  evaluateContract,
  runSensitivity,
  computeBreakeven,
  defaultScenarios,
  type ContractModel,
  type Scenario,
} from "cashflow-engine";
import {
  ContractModelSchema,
  ResponseFormatSchema,
  ScheduleDetailSchema,
  ScenarioSchema,
} from "../schemas.js";
import {
  evaluationMarkdown,
  evaluationPayload,
  money,
  percent,
  months,
  round,
  type ScheduleDetail,
} from "../format.js";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  // Pure computation. No network, no filesystem, no clock: the same input
  // always produces the same output, which is why these tools are safe to
  // call repeatedly and safe to trust.
  openWorldHint: false,
} as const;

const EvaluationOutputShape = {
  metrics: z.object({
    irrAnnual: z.number().nullable(),
    irrUnavailableReason: z.string().nullable(),
    npv: z.number(),
    paybackMonth: z.number().nullable(),
    discountedPaybackMonth: z.number().nullable(),
    moic: z.number(),
    roi: z.number(),
    totalInflows: z.number(),
    totalOutflows: z.number(),
    baseMonthlyEbitda: z.number(),
    averageMonthlyNetCashFlow: z.number(),
    netCashFlowMargin: z.number(),
  }),
  financing: z.object({
    downPayment: z.number(),
    monthlyInstallment: z.number(),
    totalInstallments: z.number(),
    financingCost: z.number(),
  }),
  workingCapital: z.object({
    receivables: z.number(),
    payables: z.number(),
    inventory: z.number(),
    net: z.number(),
  }),
  breakeven: z
    .object({
      units: z.number().nullable(),
      unitsUnreachable: z.boolean(),
      revenue: z.number().nullable(),
      marginOfSafetyPct: z.number(),
      averagePrice: z.number(),
      variableCostPerUnit: z.number(),
      contributionPerUnit: z.number(),
    })
    .nullable(),
  annual: z.array(
    z.object({
      year: z.number(),
      revenue: z.number(),
      operatingCost: z.number(),
      installments: z.number(),
      maintenanceCost: z.number(),
      netCashFlow: z.number(),
      operatingMargin: z.number(),
    }),
  ),
  schedule: z.array(z.record(z.string(), z.number())).optional(),
  scheduleDetail: z.string(),
  warnings: z.array(
    z.object({ code: z.string(), level: z.string(), message: z.string() }),
  ),
};

export function registerContractTools(server: McpServer): void {
  server.registerTool(
    "cashflow_evaluate_contract",
    {
      title: "Evaluate a contract",
      description: `Expand a contract into a month-by-month cash flow schedule and compute the metrics that follow from it: IRR, NPV, simple and discounted payback, MOIC, ROI, working capital, break-even volume, and the financing cost of any asset paid in installments.

Use this as the main entry point whenever someone asks whether a deal, contract, lease, managed-service agreement or equipment purchase is worth doing.

Args:
  - model (object): The contract. Call cashflow_model_template first if you are unsure how to shape it.
  - schedule_detail ('none' | 'annual' | 'monthly'): How much of the schedule to return. Default 'annual'. Ask for 'monthly' only when a specific month matters; a 60-month contract returns 61 rows.
  - response_format ('markdown' | 'json'): Default 'markdown'.

Returns:
  metrics (IRR, NPV, payback, MOIC, ROI, EBITDA), financing, workingCapital,
  breakeven, annual rollup, optional schedule, and warnings.

  irrAnnual is null when the flows have no reportable IRR, with the reason in
  irrUnavailableReason. Treat null as "no IRR exists", never as zero.
  paybackMonth is null when the investment is never recovered within the term.

Examples:
  - Use when: "Is this 5-year service contract worth signing?"
  - Use when: "What is the IRR and payback on this equipment deal?"
  - Don't use when: comparing two or more variants (use cashflow_compare_contracts)
  - Don't use when: stress-testing assumptions (use cashflow_run_sensitivity)

Error handling:
  Returns a validation error naming the offending field if the model is malformed.`,
      inputSchema: {
        model: ContractModelSchema,
        schedule_detail: ScheduleDetailSchema,
        response_format: ResponseFormatSchema,
      },
      outputSchema: EvaluationOutputShape,
      annotations: READ_ONLY,
    },
    async ({ model, schedule_detail, response_format }) => {
      const result = evaluateContract(model as ContractModel);
      const payload = evaluationPayload(result, schedule_detail as ScheduleDetail);
      const text =
        response_format === "json"
          ? JSON.stringify(payload, null, 2)
          : evaluationMarkdown("Contract evaluation", payload);
      return { content: [{ type: "text", text }], structuredContent: payload };
    },
  );

  server.registerTool(
    "cashflow_run_sensitivity",
    {
      title: "Stress-test a contract",
      description: `Re-evaluate a contract under a set of scenarios and report each one against the base case.

Five scenarios run by default: volume -20%, volume -10%, volume +20%, no price indexation, and operating cost +10%. Pass your own scenarios to override them.

Volume is listed first on purpose: a volume forecast taken from a customer's own estimate is a negotiating position, not a measurement, and it is the assumption that breaks most often.

Args:
  - model (object): The contract, same shape as cashflow_evaluate_contract.
  - scenarios (array, optional): Custom scenarios. Each has id, label, and any of volumeFactor, priceFactor, costFactor, revenueEscalation, costEscalation.
  - response_format ('markdown' | 'json'): Default 'markdown'.

Returns:
  base (the unmodified case) and scenarios[], each with irrAnnual, npv,
  paybackMonth, irrDeltaPoints (percentage points against base, null when
  either side has no IRR) and npvDelta.

Examples:
  - Use when: "What happens to this deal if volume comes in 20% under plan?"
  - Use when: "How fragile is the return to the inflation clause?"`,
      inputSchema: {
        model: ContractModelSchema,
        scenarios: z
          .array(ScenarioSchema)
          .min(1)
          .max(20)
          .optional()
          .describe("Custom scenarios. Omit to use the five defaults."),
        response_format: ResponseFormatSchema,
      },
      outputSchema: {
        base: z.object({
          irrAnnual: z.number().nullable(),
          npv: z.number(),
          paybackMonth: z.number().nullable(),
        }),
        scenarios: z.array(
          z.object({
            id: z.string(),
            label: z.string(),
            description: z.string(),
            irrAnnual: z.number().nullable(),
            npv: z.number(),
            paybackMonth: z.number().nullable(),
            irrDeltaPoints: z.number().nullable(),
            npvDelta: z.number(),
          }),
        ),
      },
      annotations: READ_ONLY,
    },
    async ({ model, scenarios, response_format }) => {
      const contract = model as ContractModel;
      const base = evaluateContract(contract);
      const results = runSensitivity(
        contract,
        (scenarios as Scenario[] | undefined) ?? defaultScenarios,
      );

      const payload = {
        base: {
          irrAnnual:
            base.metrics.irrAnnual === null ? null : round(base.metrics.irrAnnual, 6),
          npv: round(base.metrics.npv),
          paybackMonth: base.metrics.paybackMonth,
        },
        scenarios: results.map((s) => ({
          id: s.id,
          label: s.label,
          description: s.description,
          irrAnnual: s.irrAnnual === null ? null : round(s.irrAnnual, 6),
          npv: round(s.npv),
          paybackMonth: s.paybackMonth,
          irrDeltaPoints:
            s.irrDeltaPoints === null ? null : round(s.irrDeltaPoints * 100, 2),
          npvDelta: round(s.npvDelta),
        })),
      };

      let text: string;
      if (response_format === "json") {
        text = JSON.stringify(payload, null, 2);
      } else {
        const lines = [
          "# Sensitivity",
          "",
          "| Scenario | IRR | Delta (pts) | NPV | NPV delta | Payback |",
          "|---|---|---|---|---|---|",
          `| Base | ${percent(payload.base.irrAnnual)} | — | ${money(
            payload.base.npv,
          )} | — | ${months(payload.base.paybackMonth)} |`,
        ];
        for (const s of payload.scenarios) {
          lines.push(
            `| ${s.label} | ${percent(s.irrAnnual)} | ${
              s.irrDeltaPoints === null ? "n/a" : s.irrDeltaPoints.toFixed(2)
            } | ${money(s.npv)} | ${money(s.npvDelta)} | ${months(s.paybackMonth)} |`,
          );
        }
        text = lines.join("\n");
      }
      return { content: [{ type: "text", text }], structuredContent: payload };
    },
  );

  server.registerTool(
    "cashflow_compare_contracts",
    {
      title: "Compare contract variants",
      description: `Evaluate two to five named contract variants and rank them side by side.

Built for the question these models exist to answer: pay cash or finance, 24 months interest-free or 36 with interest, higher fixed fee or higher per-unit price, 3-year term or 5-year.

Args:
  - variants (array): 2 to 5 entries of { name, model }.
  - rank_by ('npv' | 'irr' | 'payback'): Which metric orders the result. Default 'npv'.
  - response_format ('markdown' | 'json'): Default 'markdown'.

Returns:
  variants[] ordered best first by the chosen metric, each with its headline
  metrics and financing cost, plus the name of the winner.

  Ranking by IRR places variants without a reportable IRR last, because an
  absent IRR is not a low one.

Examples:
  - Use when: "Should we take the 24-month interest-free plan or pay cash?"
  - Use when: "Compare a 3-year and a 5-year term on the same contract."`,
      inputSchema: {
        variants: z
          .array(
            z
              .object({
                name: z.string().min(1).describe("Label for this variant."),
                model: ContractModelSchema,
              })
              .strict(),
          )
          .min(2, "Comparing needs at least two variants")
          .max(5, "More than five variants is a table nobody reads")
          .describe("The variants to compare."),
        rank_by: z
          .enum(["npv", "irr", "payback"])
          .default("npv")
          .describe("Metric that orders the result."),
        response_format: ResponseFormatSchema,
      },
      outputSchema: {
        rankedBy: z.string(),
        winner: z.string(),
        variants: z.array(
          z.object({
            name: z.string(),
            irrAnnual: z.number().nullable(),
            npv: z.number(),
            paybackMonth: z.number().nullable(),
            moic: z.number(),
            totalOutflows: z.number(),
            financingCost: z.number(),
            warningCount: z.number(),
          }),
        ),
      },
      annotations: READ_ONLY,
    },
    async ({ variants, rank_by, response_format }) => {
      const evaluated = variants.map((v) => {
        const r = evaluateContract(v.model as ContractModel);
        return {
          name: v.name,
          irrAnnual: r.metrics.irrAnnual === null ? null : round(r.metrics.irrAnnual, 6),
          npv: round(r.metrics.npv),
          paybackMonth: r.metrics.paybackMonth,
          moic: round(r.metrics.moic, 4),
          totalOutflows: round(r.metrics.totalOutflows),
          financingCost: round(r.financing.financingCost),
          warningCount: r.warnings.length,
        };
      });

      // A missing value sorts last in every ranking: "no IRR" is not a low IRR,
      // and "never paid back" is not a fast payback.
      const sorted = [...evaluated].sort((a, b) => {
        if (rank_by === "irr") {
          if (a.irrAnnual === null && b.irrAnnual === null) return 0;
          if (a.irrAnnual === null) return 1;
          if (b.irrAnnual === null) return -1;
          return b.irrAnnual - a.irrAnnual;
        }
        if (rank_by === "payback") {
          if (a.paybackMonth === null && b.paybackMonth === null) return 0;
          if (a.paybackMonth === null) return 1;
          if (b.paybackMonth === null) return -1;
          return a.paybackMonth - b.paybackMonth;
        }
        return b.npv - a.npv;
      });

      const payload = {
        rankedBy: rank_by,
        winner: sorted[0]?.name ?? "",
        variants: sorted,
      };

      let text: string;
      if (response_format === "json") {
        text = JSON.stringify(payload, null, 2);
      } else {
        const lines = [
          `# Comparison (ranked by ${rank_by})`,
          "",
          "| # | Variant | IRR | NPV | Payback | MOIC | Cash out | Interest |",
          "|---|---|---|---|---|---|---|---|",
        ];
        sorted.forEach((v, i) => {
          lines.push(
            `| ${i + 1} | ${v.name} | ${percent(v.irrAnnual)} | ${money(v.npv)} | ${months(
              v.paybackMonth,
            )} | ${v.moic.toFixed(2)}x | ${money(v.totalOutflows)} | ${money(
              v.financingCost,
            )} |`,
          );
        });
        lines.push("", `**Best by ${rank_by}: ${payload.winner}.**`);
        text = lines.join("\n");
      }
      return { content: [{ type: "text", text }], structuredContent: payload };
    },
  );

  server.registerTool(
    "cashflow_breakeven",
    {
      title: "Break-even volume",
      description: `Compute the monthly volume at which a contract stops losing money, without running the full schedule.

Contingency is folded into the contribution margin rather than added to fixed cost, because total cost is (fixed + maintenance + variable x u/u0) x (1 + contingency): contingency multiplies both sides. Fixed revenue offsets fixed cost, so a contract whose flat fee already covers its fixed base breaks even at zero units.

Escalation is excluded on purpose. Break-even is a statement about the base year.

Args:
  - model (object): The contract, same shape as cashflow_evaluate_contract.
  - volume_factor (number): Scales planned volume before solving. Default 1.

Returns:
  units, revenue, marginOfSafetyPct, averagePrice, variableCostPerUnit and
  contributionPerUnit. Returns null when the model has no metered streams to
  break even on, and unitsUnreachable true when contribution per unit is zero
  or negative.

Examples:
  - Use when: "How many units a month do we need to cover costs?"
  - Use when: "How much headroom is there between plan and break-even?"`,
      inputSchema: {
        model: ContractModelSchema,
        volume_factor: z
          .number()
          .finite()
          .min(0)
          .default(1)
          .describe("Scales planned volume before solving."),
      },
      outputSchema: {
        hasMeteredVolume: z.boolean(),
        breakeven: z
          .object({
            units: z.number().nullable(),
            unitsUnreachable: z.boolean(),
            revenue: z.number().nullable(),
            marginOfSafetyPct: z.number(),
            averagePrice: z.number(),
            variableCostPerUnit: z.number(),
            contributionPerUnit: z.number(),
          })
          .nullable(),
      },
      annotations: READ_ONLY,
    },
    async ({ model, volume_factor }) => {
      const result = computeBreakeven(model as ContractModel, volume_factor);
      if (!result) {
        const payload = { hasMeteredVolume: false, breakeven: null };
        return {
          content: [
            {
              type: "text" as const,
              text:
                "This contract has no metered revenue streams, so there is no unit " +
                "volume to break even on. Add at least one stream, or read the " +
                "monthly EBITDA from cashflow_evaluate_contract instead.",
            },
          ],
          structuredContent: payload,
        };
      }

      const unreachable = !Number.isFinite(result.units);
      const payload = {
        hasMeteredVolume: true,
        breakeven: {
          units: unreachable ? null : round(result.units, 2),
          unitsUnreachable: unreachable,
          revenue: Number.isFinite(result.revenue) ? round(result.revenue) : null,
          marginOfSafetyPct: round(result.marginOfSafetyPct, 2),
          averagePrice: round(result.averagePrice),
          variableCostPerUnit: round(result.variableCostPerUnit),
          contributionPerUnit: round(result.contributionPerUnit),
        },
      };

      const text = unreachable
        ? `Contribution per unit is ${money(
            payload.breakeven.contributionPerUnit,
          )}, which is not positive. No volume reaches break-even at these prices.`
        : [
            "# Break-even",
            "",
            `- Units per month: **${payload.breakeven.units}**`,
            `- Revenue at break-even: ${money(payload.breakeven.revenue ?? 0)}`,
            `- Average price: ${money(payload.breakeven.averagePrice)}`,
            `- Variable cost per unit: ${money(payload.breakeven.variableCostPerUnit)}`,
            `- Contribution per unit: ${money(payload.breakeven.contributionPerUnit)}`,
            `- Margin of safety: ${payload.breakeven.marginOfSafetyPct}%`,
          ].join("\n");

      return { content: [{ type: "text", text }], structuredContent: payload };
    },
  );
}
