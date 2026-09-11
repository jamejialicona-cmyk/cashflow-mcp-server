import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ContractModel } from "cashflow-engine";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/**
 * A filled-in contract, so an agent has something concrete to edit rather than
 * a schema to interpret. Numbers are invented and internally consistent.
 */
const MANAGED_SERVICE: ContractModel = {
  termMonths: 60,
  discountRateAnnual: 0.14,
  revenue: {
    fixedMonthly: 300_000,
    streams: [
      { label: "Standard cycles", unitsPerMonth: 180, pricePerUnit: 1_800 },
      { label: "Low-temperature cycles", unitsPerMonth: 45, pricePerUnit: 1_400 },
    ],
    adjustmentsMonthly: -15_000,
    annualEscalation: 0.05,
  },
  costs: {
    fixedMonthly: 340_000,
    variableMonthly: 120_000,
    contingencyRate: 0.05,
    annualEscalation: 0.03,
    maintenance: {
      basis: 3_500_000,
      annualRateByYear: [0.01, 0.015, 0.025, 0.035, 0.05],
    },
  },
  investments: [
    { label: "Site works, deposit", amount: 175_000, month: 0 },
    { label: "Site works, balance", amount: 175_000, month: 2 },
    { label: "Installation and training", amount: 161_630, month: 0 },
  ],
  financedAsset: {
    principal: 3_500_000,
    downPayment: 350_000,
    termMonths: 36,
    annualRate: 0.12,
    residualValue: 0,
  },
  workingCapital: {
    receivableDays: 45,
    payableDays: 60,
    payableBaseMonthly: 120_000,
    inventory: 120_000,
  },
};

const SUBSCRIPTION: ContractModel = {
  termMonths: 36,
  discountRateAnnual: 0.1,
  revenue: {
    fixedMonthly: 12_000,
    streams: [],
    adjustmentsMonthly: 0,
    annualEscalation: 0.03,
  },
  costs: {
    fixedMonthly: 4_000,
    variableMonthly: 1_500,
    contingencyRate: 0,
    annualEscalation: 0.03,
  },
  investments: [{ label: "Onboarding and integration", amount: 60_000, month: 0 }],
};

const EQUIPMENT_LEASE: ContractModel = {
  termMonths: 48,
  discountRateAnnual: 0.12,
  revenue: {
    fixedMonthly: 0,
    streams: [{ label: "Billable hours", unitsPerMonth: 320, pricePerUnit: 95 }],
    adjustmentsMonthly: 0,
    annualEscalation: 0.04,
  },
  costs: {
    fixedMonthly: 14_000,
    variableMonthly: 6_400,
    contingencyRate: 0.03,
    annualEscalation: 0.03,
    maintenance: { basis: 900_000, annualRateByYear: [0.02, 0.03, 0.045] },
  },
  investments: [{ label: "Delivery and commissioning", amount: 45_000, month: 0 }],
  financedAsset: {
    principal: 900_000,
    downPayment: 0,
    termMonths: 24,
    annualRate: 0,
    residualValue: 180_000,
  },
  workingCapital: {
    receivableDays: 30,
    payableDays: 45,
    payableBaseMonthly: 6_400,
    inventory: 0,
  },
};

const TEMPLATES = {
  managed_service: MANAGED_SERVICE,
  subscription: SUBSCRIPTION,
  equipment_lease: EQUIPMENT_LEASE,
} as const;

const NOTES: Record<keyof typeof TEMPLATES, string> = {
  managed_service:
    "Operator installs equipment at a customer site, runs it, and bills a monthly " +
    "fee plus per-unit charges. Exercises every field: metered streams, staged " +
    "investments, a financed asset with interest, age-based maintenance and " +
    "working capital.",
  subscription:
    "Flat monthly fee with no metered volume and no financed asset. Break-even " +
    "returns null for this shape, because there are no units to solve for.",
  equipment_lease:
    "No fixed fee, revenue entirely metered. Interest-free 24-month plan on the " +
    "asset, with a residual value recovered in the final month.",
};

export function registerReferenceTools(server: McpServer): void {
  server.registerTool(
    "cashflow_model_template",
    {
      title: "Get a contract template",
      description: `Return a filled-in, valid contract model to copy and edit.

Call this first when you are about to build a model and are unsure how the fields fit together. Editing a working example is faster and safer than assembling one from the schema, and the returned object is guaranteed to validate.

Three shapes are available:
  - 'managed_service': exercises every field, including metered streams, staged investments, a financed asset with interest, maintenance and working capital.
  - 'subscription': flat fee, no metered volume, no financed asset.
  - 'equipment_lease': fully metered revenue, interest-free installments, residual value.

Args:
  - template ('managed_service' | 'subscription' | 'equipment_lease'): Which shape. Default 'managed_service'.

Returns:
  model (the object to pass to the other tools), notes (what the shape is for),
  and conventions (the rules that govern every model).

Examples:
  - Use when: "Help me model a service contract" and no model exists yet.
  - Use when: you need to check what a field is called or how it is shaped.`,
      inputSchema: {
        template: z
          .enum(["managed_service", "subscription", "equipment_lease"])
          .default("managed_service")
          .describe("Which shape to return."),
      },
      outputSchema: {
        template: z.string(),
        notes: z.string(),
        conventions: z.array(z.string()),
        model: z.unknown(),
      },
      annotations: READ_ONLY,
    },
    async ({ template }) => {
      const model = TEMPLATES[template];
      const payload = {
        template,
        notes: NOTES[template],
        conventions: [
          "Money is unitless. Pick a currency and stay consistent; nothing here converts or adds tax.",
          "Rates are fractions, not percentages: 0.14 means 14%.",
          "discountRateAnnual and the escalation rates are effective annual rates, compounded to monthly internally.",
          "financedAsset.annualRate is nominal: it is divided by 12, matching loan contracts.",
          "Month 0 is signing and carries only capital. Operations run from month 1 to termMonths.",
          "Revenue escalation applies from month 13, compounded each contract year.",
          "The last entry of maintenance.annualRateByYear repeats for every later year.",
          "Working capital is consumed at signing and released in the final month.",
        ],
        model,
      };

      const text = [
        `# Template: ${template}`,
        "",
        payload.notes,
        "",
        "## Conventions",
        "",
        ...payload.conventions.map((c) => `- ${c}`),
        "",
        "## Model",
        "",
        "```json",
        JSON.stringify(model, null, 2),
        "```",
      ].join("\n");

      return { content: [{ type: "text", text }], structuredContent: payload };
    },
  );
}
