import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  irr,
  npv,
  pmt,
  totalPayments,
  financingCost,
  paybackPeriod,
  fractionalPaybackPeriod,
  annualToMonthlyEffective,
  monthlyToAnnualEffective,
} from "cashflow-engine";
import { money, months, percent, round } from "../format.js";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export function registerPrimitiveTools(server: McpServer): void {
  server.registerTool(
    "cashflow_analyze_flows",
    {
      title: "Analyze a raw cash flow vector",
      description: `Compute NPV, IRR and payback directly on a list of period cash flows, with no contract model involved.

Use this when the numbers already exist, for example flows lifted from a spreadsheet, a schedule produced elsewhere, or a quick sanity check.

The first element sits at period 0 and is not discounted. Outflows are negative.

Args:
  - flows (array of numbers): Cash flow per period, flows[0] at t=0. Needs at least 2 entries.
  - period ('monthly' | 'annual'): What one element represents. Default 'monthly'. Determines how the rate is annualized.
  - discount_rate_annual (number): Effective annual rate for NPV, e.g. 0.14 for 14%. Default 0.
  - interpolate_payback (boolean): Return a fractional payback period instead of whole periods. Default false.

Returns:
  npv, irrAnnual, irrPeriodic, irrAvailable, irrUnavailableReason, payback and
  cumulative totals.

  irrAnnual is null when the vector has no reportable IRR: no outflow, no
  inflow, or flows that never sum positive. The reason says which.

  A vector whose sign changes more than once may have several real IRRs. The
  engine returns one and flags nothing, which is a property of IRR itself.
  signChanges is reported so you can tell when to trust NPV instead.

Examples:
  - Use when: "What is the IRR of -1000, 500, 500, 500?"
  - Use when: "Discount these annual flows at 12% and tell me the NPV."
  - Don't use when: you have contract terms rather than flows (use cashflow_evaluate_contract)`,
      inputSchema: {
        flows: z
          .array(z.number().finite())
          .min(2, "Need at least two periods to say anything")
          .max(1200, "Vector too long; aggregate before analyzing")
          .describe("Cash flow per period. flows[0] is period 0 and is not discounted."),
        period: z
          .enum(["monthly", "annual"])
          .default("monthly")
          .describe("What one element represents."),
        discount_rate_annual: z
          .number()
          .finite()
          .min(-1)
          .max(10)
          .default(0)
          .describe("Effective annual discount rate, e.g. 0.14 for 14%."),
        interpolate_payback: z
          .boolean()
          .default(false)
          .describe("Return a fractional payback period instead of whole periods."),
      },
      outputSchema: {
        npv: z.number(),
        discountRatePeriodic: z.number(),
        irrAvailable: z.boolean(),
        irrPeriodic: z.number().nullable(),
        irrAnnual: z.number().nullable(),
        irrUnavailableReason: z.string().nullable(),
        payback: z.number().nullable(),
        totalInflows: z.number(),
        totalOutflows: z.number(),
        netTotal: z.number(),
        signChanges: z.number(),
      },
      annotations: READ_ONLY,
    },
    async ({ flows, period, discount_rate_annual, interpolate_payback }) => {
      const periodicRate =
        period === "monthly"
          ? annualToMonthlyEffective(discount_rate_annual)
          : discount_rate_annual;

      const result = irr(flows);
      const irrPeriodic = result.ok ? result.periodicRate : null;
      const irrAnnual =
        irrPeriodic === null
          ? null
          : period === "monthly"
            ? monthlyToAnnualEffective(irrPeriodic)
            : irrPeriodic;

      let cumulative = 0;
      const running = flows.map((f) => (cumulative += f));
      const payback = interpolate_payback
        ? fractionalPaybackPeriod(running)
        : paybackPeriod(running);

      let inflows = 0;
      let outflows = 0;
      let signChanges = 0;
      let lastSign = 0;
      for (const f of flows) {
        if (f > 0) inflows += f;
        else outflows += -f;
        const sign = Math.sign(f);
        if (sign !== 0) {
          if (lastSign !== 0 && sign !== lastSign) signChanges++;
          lastSign = sign;
        }
      }

      const payload = {
        npv: round(npv(flows, periodicRate), 4),
        discountRatePeriodic: round(periodicRate, 8),
        irrAvailable: result.ok,
        irrPeriodic: irrPeriodic === null ? null : round(irrPeriodic, 8),
        irrAnnual: irrAnnual === null ? null : round(irrAnnual, 6),
        irrUnavailableReason: result.ok ? null : result.reason,
        payback: payback === null ? null : round(payback, 4),
        totalInflows: round(inflows, 4),
        totalOutflows: round(outflows, 4),
        netTotal: round(inflows - outflows, 4),
        signChanges,
      };

      const lines = [
        "# Flow analysis",
        "",
        `- NPV at ${percent(discount_rate_annual)} annual: **${payload.npv}**`,
        `- IRR (annual): **${percent(payload.irrAnnual)}**`,
        `- IRR (per ${period === "monthly" ? "month" : "year"}): ${percent(
          payload.irrPeriodic,
        )}`,
        `- Payback: ${payback === null ? "not within the vector" : `period ${payload.payback}`}`,
        `- Inflows ${payload.totalInflows}, outflows ${payload.totalOutflows}, net ${payload.netTotal}`,
      ];
      if (!result.ok) {
        lines.push("", `> No IRR is reportable for these flows (${result.reason}).`);
      }
      if (signChanges > 1) {
        lines.push(
          "",
          `> The vector changes sign ${signChanges} times, so more than one IRR may ` +
            "satisfy it. Prefer NPV for this decision.",
        );
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: payload,
      };
    },
  );

  server.registerTool(
    "cashflow_loan_terms",
    {
      title: "Installment plan terms",
      description: `Compute the level monthly payment that amortizes a principal, plus the total paid and the interest it costs.

Matches the spreadsheet PMT(rate/12, nper, -pv) convention, including the zero-rate case, so the output can be checked against Excel cell by cell.

Note the rate convention: loans divide the annual rate by 12, they do not compound it. This tool divides. Discounting elsewhere in this server compounds. Mixing the two is the most common error in a hand-built model.

Args:
  - principal (number): Amount financed.
  - term_months (integer): Number of level payments. 0 means paid in cash.
  - annual_rate (number): Nominal annual rate, e.g. 0.12 for 12% APR. Use 0 for an interest-free plan.
  - include_amortization (boolean): Return the per-month interest and principal split. Default false.

Returns:
  monthlyPayment, totalPaid, interestPaid, and optionally an amortization
  schedule of { month, payment, interest, principal, balance }.

Examples:
  - Use when: "What is the payment on 3.5 million over 36 months at 12%?"
  - Use when: "How much interest does the 36-month plan cost versus 24 months interest-free?"`,
      inputSchema: {
        principal: z.number().finite().min(0).describe("Amount financed."),
        term_months: z
          .number()
          .int()
          .min(0)
          .max(600)
          .describe("Number of level payments. 0 means paid in cash."),
        annual_rate: z
          .number()
          .finite()
          .min(0)
          .max(10)
          .default(0)
          .describe("Nominal annual rate, divided by 12 per month. 0 is interest-free."),
        include_amortization: z
          .boolean()
          .default(false)
          .describe("Return the per-month interest and principal split."),
      },
      outputSchema: {
        monthlyPayment: z.number(),
        totalPaid: z.number(),
        interestPaid: z.number(),
        monthlyRate: z.number(),
        amortization: z
          .array(
            z.object({
              month: z.number(),
              payment: z.number(),
              interest: z.number(),
              principal: z.number(),
              balance: z.number(),
            }),
          )
          .optional(),
      },
      annotations: READ_ONLY,
    },
    async ({ principal, term_months, annual_rate, include_amortization }) => {
      const payment = pmt(annual_rate, term_months, principal);
      const monthlyRate = annual_rate / 12;

      let amortization:
        | Array<{
            month: number;
            payment: number;
            interest: number;
            principal: number;
            balance: number;
          }>
        | undefined;

      if (include_amortization && term_months > 0) {
        amortization = [];
        let balance = principal;
        for (let m = 1; m <= term_months; m++) {
          const interest = balance * monthlyRate;
          // The last payment absorbs the rounding drift so the balance closes at zero.
          const principalPart = m === term_months ? balance : payment - interest;
          balance = Math.max(0, balance - principalPart);
          amortization.push({
            month: m,
            payment: round(interest + principalPart),
            interest: round(interest),
            principal: round(principalPart),
            balance: round(balance),
          });
        }
      }

      const payload = {
        monthlyPayment: round(payment),
        totalPaid: round(totalPayments(annual_rate, term_months, principal)),
        interestPaid: round(financingCost(annual_rate, term_months, principal)),
        monthlyRate: round(monthlyRate, 8),
        ...(amortization ? { amortization } : {}),
      };

      const text = [
        "# Installment plan",
        "",
        `- Principal: ${money(principal)}`,
        `- Term: ${term_months} months at ${percent(annual_rate)} nominal`,
        `- Monthly payment: **${money(payload.monthlyPayment)}**`,
        `- Total paid: ${money(payload.totalPaid)}`,
        `- Interest: ${money(payload.interestPaid)}`,
        ...(amortization
          ? ["", `Amortization for ${amortization.length} months in structuredContent.`]
          : []),
      ].join("\n");

      return { content: [{ type: "text", text }], structuredContent: payload };
    },
  );

  server.registerTool(
    "cashflow_convert_rate",
    {
      title: "Convert between rate conventions",
      description: `Convert an annual rate to a monthly one and back, under either convention.

'compound' is the discounting convention: (1 + annual)^(1/12) - 1. 'divide' is the loan convention: annual / 12. A 12% annual rate is 0.9489% per month compounded but 1% per month divided, and using one where the other belongs quietly distorts every downstream number.

Args:
  - value (number): The rate to convert, e.g. 0.14 for 14%.
  - direction ('annual_to_monthly' | 'monthly_to_annual'): Which way to convert.
  - convention ('compound' | 'divide'): 'compound' for discounting, 'divide' for amortization.

Returns:
  input, output, and both conventions side by side so the difference is visible.

Examples:
  - Use when: "What monthly rate should I discount at for a 14% cost of capital?"
  - Use when: "Is 1% a month the same as 12% a year?"`,
      inputSchema: {
        value: z.number().finite().min(-1).max(10).describe("The rate to convert."),
        direction: z
          .enum(["annual_to_monthly", "monthly_to_annual"])
          .default("annual_to_monthly")
          .describe("Which way to convert."),
        convention: z
          .enum(["compound", "divide"])
          .default("compound")
          .describe("'compound' for discounting, 'divide' for amortization."),
      },
      outputSchema: {
        input: z.number(),
        output: z.number(),
        convention: z.string(),
        direction: z.string(),
        compounded: z.number(),
        divided: z.number(),
      },
      annotations: READ_ONLY,
    },
    async ({ value, direction, convention }) => {
      const toMonthly = direction === "annual_to_monthly";
      const compounded = toMonthly
        ? annualToMonthlyEffective(value)
        : monthlyToAnnualEffective(value);
      const divided = toMonthly ? value / 12 : value * 12;
      const output = convention === "compound" ? compounded : divided;

      const payload = {
        input: value,
        output: round(output, 8),
        convention,
        direction,
        compounded: round(compounded, 8),
        divided: round(divided, 8),
      };

      const text = [
        `Converting ${percent(value, 4)} ${
          toMonthly ? "annual to monthly" : "monthly to annual"
        }:`,
        "",
        `- Compounded (discounting): ${percent(payload.compounded, 6)}`,
        `- Divided (amortization): ${percent(payload.divided, 6)}`,
        "",
        `Requested convention **${convention}** gives ${percent(payload.output, 6)}.`,
      ].join("\n");

      return { content: [{ type: "text", text }], structuredContent: payload };
    },
  );
}
