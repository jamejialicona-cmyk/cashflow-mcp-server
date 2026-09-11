import { z } from "zod";

/**
 * Zod mirrors of the engine's domain model.
 *
 * The engine owns the types; this file owns their *validation* and, just as
 * important, their *descriptions*. Every `.describe()` here becomes part of the
 * JSON schema an agent reads before calling a tool, so these strings are the
 * difference between an agent that builds a correct model and one that guesses.
 */

const money = z.number().finite();
const rate = z
  .number()
  .finite()
  .min(-1, "A rate below -100% is not meaningful")
  .max(10, "A rate above 1000% is almost certainly a decimal-point error");

export const RevenueStreamSchema = z
  .object({
    label: z.string().min(1).describe('Name of the line, e.g. "Standard cycles".'),
    unitsPerMonth: z
      .number()
      .finite()
      .min(0)
      .describe("Units delivered per month at the planned volume."),
    pricePerUnit: money.min(0).describe("Price charged per unit, before escalation."),
  })
  .strict();

export const InvestmentLineSchema = z
  .object({
    label: z.string().min(1).describe('What the money buys, e.g. "Installation".'),
    amount: money.min(0).describe("Cash amount leaving in that month."),
    month: z
      .number()
      .int()
      .min(0)
      .describe(
        "Month the cash leaves. 0 is signing. Use several lines for a staged " +
          "disbursement, e.g. 50% at month 0 and 50% at month 2.",
      ),
  })
  .strict();

export const FinancedAssetSchema = z
  .object({
    principal: money.min(0).describe("Full purchase price of the asset."),
    downPayment: money
      .min(0)
      .default(0)
      .describe("Paid in cash at month 0. Only the remainder is amortized."),
    termMonths: z
      .number()
      .int()
      .min(0)
      .describe("Number of level monthly payments. 0 means paid in cash."),
    annualRate: rate
      .default(0)
      .describe(
        "Nominal annual rate on the financed balance, charged as rate/12 per " +
          "month. Use 0 for an interest-free installment plan.",
      ),
    residualValue: money
      .min(0)
      .default(0)
      .describe(
        "Recovery value booked as an inflow in the final month. Use 0 when the " +
          "asset transfers to the customer.",
      ),
  })
  .strict();

export const WorkingCapitalSchema = z
  .object({
    receivableDays: z
      .number()
      .finite()
      .min(0)
      .describe("Days between delivering and being paid."),
    payableDays: z
      .number()
      .finite()
      .min(0)
      .describe("Days between being billed and paying."),
    payableBaseMonthly: money
      .min(0)
      .describe(
        "Monthly cost actually financed by suppliers. Usually a subset of total " +
          "cost, since payroll is not on supplier terms.",
      ),
    inventory: money.min(0).default(0).describe("Cash permanently locked in stock."),
  })
  .strict();

export const MaintenanceSchema = z
  .object({
    basis: money
      .min(0)
      .describe("Amount the yearly rates apply to, typically the asset principal."),
    annualRateByYear: z
      .array(rate.min(0))
      .min(1)
      .describe(
        "Annual rate per contract year as a fraction of basis. [0.01, 0.02] is " +
          "1% in year one and 2% in year two. The LAST entry repeats for every " +
          "later year, so a short array models a plateau, not a drop to zero.",
      ),
  })
  .strict();

export const ContractModelSchema = z
  .object({
    termMonths: z
      .number()
      .int()
      .min(1)
      .max(600)
      .describe("Contract length in months. The schedule runs month 0 to this value."),
    discountRateAnnual: rate.describe(
      "Effective annual discount rate for NPV, typically the cost of capital. " +
        "Converted to a compounded monthly rate internally.",
    ),
    revenue: z
      .object({
        fixedMonthly: money
          .min(0)
          .describe("Flat monthly fee, independent of volume."),
        streams: z
          .array(RevenueStreamSchema)
          .default([])
          .describe("Metered lines. Empty for a pure subscription."),
        adjustmentsMonthly: money
          .default(0)
          .describe(
            "Signed monthly adjustment to the fixed side: rebates and commissions " +
              "negative, ancillary income positive.",
          ),
        annualEscalation: rate
          .default(0)
          .describe(
            "Annual price increase, applied from month 13 and compounded each " +
              "contract year. Models an inflation-indexation clause.",
          ),
      })
      .strict(),
    costs: z
      .object({
        fixedMonthly: money
          .min(0)
          .describe("Monthly cost that does not move with volume."),
        variableMonthly: money
          .min(0)
          .describe("Monthly cost that moves with volume, at the planned volume."),
        contingencyRate: rate
          .min(0)
          .default(0)
          .describe(
            "Fraction of operating cost plus maintenance. Never applied to " +
              "financing payments, which are contractual and not at risk.",
          ),
        annualEscalation: rate
          .default(0)
          .describe(
            "Annual cost inflation, compounded per contract year. Set it below " +
              "the revenue escalation to model margin expansion.",
          ),
        maintenance: MaintenanceSchema.optional().describe(
          "Age-based maintenance, independent of volume.",
        ),
      })
      .strict(),
    investments: z
      .array(InvestmentLineSchema)
      .default([])
      .describe("One-off outflows outside the financed asset."),
    financedAsset: FinancedAssetSchema.optional().describe(
      "Capital equipment paid over time rather than in cash at signing.",
    ),
    workingCapital: WorkingCapitalSchema.optional().describe(
      "Omit to model a business that collects and pays on the same day.",
    ),
  })
  .strict();

export type ContractModelInput = z.infer<typeof ContractModelSchema>;

export const ResponseFormatSchema = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe(
    "'markdown' for a readable report, 'json' for the full structured result. " +
      "Structured data is returned either way in structuredContent.",
  );

export const ScheduleDetailSchema = z
  .enum(["none", "annual", "monthly"])
  .default("annual")
  .describe(
    "How much of the cash flow schedule to include. 'annual' rolls it up by " +
      "contract year and is almost always enough. 'monthly' can be hundreds of " +
      "rows, so ask for it only when a specific month is in question.",
  );

export const ScenarioSchema = z
  .object({
    id: z.string().min(1).describe("Stable identifier for the scenario."),
    label: z.string().min(1).describe("Short human-readable name."),
    description: z.string().default("").describe("What the scenario assumes."),
    volumeFactor: z
      .number()
      .finite()
      .min(0)
      .optional()
      .describe("Scales metered volume and the variable cost that follows it."),
    priceFactor: z
      .number()
      .finite()
      .min(0)
      .optional()
      .describe("Scales unit prices without touching volume."),
    costFactor: z
      .number()
      .finite()
      .min(0)
      .optional()
      .describe("Scales the operating cost base."),
    revenueEscalation: rate
      .optional()
      .describe("Replaces the model's annual revenue escalation."),
    costEscalation: rate
      .optional()
      .describe("Replaces the model's annual cost escalation."),
  })
  .strict();
