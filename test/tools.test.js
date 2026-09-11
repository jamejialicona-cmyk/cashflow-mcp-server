import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";

/**
 * Every test drives the real server through a real MCP client over an
 * in-memory transport. Nothing is stubbed, so a broken schema, a mismatched
 * outputSchema or a bad tool name fails here rather than in a host.
 */
async function connect() {
  const server = createServer();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, `${name} returned an error: ${JSON.stringify(result.content)}`);
  return result;
}

/** A model small enough to reason about by hand. */
function baseModel() {
  return {
    termMonths: 24,
    discountRateAnnual: 0.12,
    revenue: {
      fixedMonthly: 10000,
      streams: [{ label: "Units", unitsPerMonth: 400, pricePerUnit: 10 }],
    },
    costs: { fixedMonthly: 3000, variableMonthly: 2000 },
    investments: [{ label: "Installation", amount: 100000, month: 0 }],
  };
}

test("every registered tool is listed with annotations and schemas", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();

  assert.deepEqual(names, [
    "cashflow_analyze_flows",
    "cashflow_breakeven",
    "cashflow_compare_contracts",
    "cashflow_convert_rate",
    "cashflow_evaluate_contract",
    "cashflow_loan_terms",
    "cashflow_model_template",
    "cashflow_run_sensitivity",
  ]);

  for (const tool of tools) {
    assert.ok(tool.description && tool.description.length > 120, `${tool.name} needs a real description`);
    assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} should be read-only`);
    assert.equal(tool.annotations?.openWorldHint, false, `${tool.name} touches nothing external`);
    assert.ok(tool.inputSchema, `${tool.name} needs an input schema`);
  }
});

test("model_template returns a model the other tools accept", async () => {
  const { client } = await connect();
  for (const template of ["managed_service", "subscription", "equipment_lease"]) {
    const res = await call(client, "cashflow_model_template", { template });
    const model = res.structuredContent.model;
    assert.ok(model.termMonths > 0, `${template} template must have a term`);

    // The point of a template is that it round-trips into the real tools.
    const evaluated = await call(client, "cashflow_evaluate_contract", { model });
    assert.ok(typeof evaluated.structuredContent.metrics.npv === "number");
  }
});

test("evaluate_contract computes payback and IRR on a hand-checked model", async () => {
  const { client } = await connect();
  const res = await call(client, "cashflow_evaluate_contract", { model: baseModel() });
  const { metrics } = res.structuredContent;

  // 100,000 invested against 9,000 of monthly EBITDA: whole at month 12.
  assert.equal(metrics.baseMonthlyEbitda, 9000);
  assert.equal(metrics.paybackMonth, 12);
  assert.equal(metrics.totalOutflows, 100000);
  assert.equal(metrics.totalInflows, 216000);
  assert.ok(metrics.irrAnnual > 0, "a recovered investment has a positive IRR");
  assert.equal(metrics.irrUnavailableReason, null);
});

test("a contract that commits no cash reports a null IRR with a reason", async () => {
  const { client } = await connect();
  const model = baseModel();
  delete model.investments;
  const res = await call(client, "cashflow_evaluate_contract", { model });

  assert.equal(res.structuredContent.metrics.irrAnnual, null);
  assert.equal(res.structuredContent.metrics.irrUnavailableReason, "NO_OUTFLOW");
  assert.ok(
    res.structuredContent.warnings.some((w) => w.code === "IRR_UNAVAILABLE"),
    "the absent IRR must be surfaced as a warning",
  );
});

test("schedule_detail controls how many rows come back", async () => {
  const { client } = await connect();
  const model = baseModel();

  const annual = await call(client, "cashflow_evaluate_contract", { model });
  assert.equal(annual.structuredContent.schedule.length, 0, "annual is the default");
  assert.equal(annual.structuredContent.annual.length, 2);

  const monthly = await call(client, "cashflow_evaluate_contract", {
    model,
    schedule_detail: "monthly",
  });
  assert.equal(monthly.structuredContent.schedule.length, 25, "month 0 through 24");
});

test("both response formats return the same structured data", async () => {
  const { client } = await connect();
  const model = baseModel();
  const md = await call(client, "cashflow_evaluate_contract", { model, response_format: "markdown" });
  const json = await call(client, "cashflow_evaluate_contract", { model, response_format: "json" });

  assert.deepEqual(md.structuredContent, json.structuredContent);
  assert.match(md.content[0].text, /^# Contract evaluation/);
  assert.doesNotThrow(() => JSON.parse(json.content[0].text));
});

test("run_sensitivity reports every default scenario against the base", async () => {
  const { client } = await connect();
  const res = await call(client, "cashflow_run_sensitivity", { model: baseModel() });
  const { base, scenarios } = res.structuredContent;

  assert.equal(scenarios.length, 5);
  const down = scenarios.find((s) => s.id === "volume_down_20");
  const up = scenarios.find((s) => s.id === "volume_up_20");
  assert.ok(down.npvDelta < 0, "less volume must hurt NPV");
  assert.ok(up.npvDelta > 0, "more volume must help NPV");
  assert.ok(typeof base.npv === "number");
});

test("run_sensitivity accepts caller-defined scenarios", async () => {
  const { client } = await connect();
  const res = await call(client, "cashflow_run_sensitivity", {
    model: baseModel(),
    scenarios: [{ id: "hard", label: "Hard year", volumeFactor: 0.85, costFactor: 1.08 }],
  });
  assert.equal(res.structuredContent.scenarios.length, 1);
  assert.equal(res.structuredContent.scenarios[0].label, "Hard year");
});

test("compare_contracts ranks variants and names a winner", async () => {
  const { client } = await connect();
  const cheap = baseModel();
  const expensive = baseModel();
  expensive.investments = [{ label: "Installation", amount: 180000, month: 0 }];

  const res = await call(client, "cashflow_compare_contracts", {
    variants: [
      { name: "High capex", model: expensive },
      { name: "Low capex", model: cheap },
    ],
  });

  assert.equal(res.structuredContent.variants.length, 2);
  assert.equal(res.structuredContent.winner, "Low capex");
  assert.equal(res.structuredContent.rankedBy, "npv");
});

test("compare_contracts refuses a single variant", async () => {
  const { client } = await connect();
  const result = await client.callTool({
    name: "cashflow_compare_contracts",
    arguments: { variants: [{ name: "Only one", model: baseModel() }] },
  });
  assert.ok(result.isError, "one variant is not a comparison");
});

test("breakeven solves the textbook case", async () => {
  const { client } = await connect();
  const res = await call(client, "cashflow_breakeven", {
    model: {
      termMonths: 12,
      discountRateAnnual: 0.1,
      revenue: { fixedMonthly: 0, streams: [{ label: "Units", unitsPerMonth: 400, pricePerUnit: 10 }] },
      costs: { fixedMonthly: 1000, variableMonthly: 2000 },
    },
  });

  const b = res.structuredContent.breakeven;
  assert.equal(res.structuredContent.hasMeteredVolume, true);
  assert.equal(b.averagePrice, 10);
  assert.equal(b.variableCostPerUnit, 5);
  assert.equal(b.units, 200);
  assert.equal(b.marginOfSafetyPct, 50);
});

test("breakeven says so when there is no metered volume", async () => {
  const { client } = await connect();
  const res = await call(client, "cashflow_breakeven", {
    model: {
      termMonths: 12,
      discountRateAnnual: 0.1,
      revenue: { fixedMonthly: 5000, streams: [] },
      costs: { fixedMonthly: 1000, variableMonthly: 0 },
    },
  });
  assert.equal(res.structuredContent.hasMeteredVolume, false);
  assert.equal(res.structuredContent.breakeven, null);
  assert.match(res.content[0].text, /no metered revenue streams/);
});

test("analyze_flows matches known IRR and NPV values", async () => {
  const { client } = await connect();
  const res = await call(client, "cashflow_analyze_flows", {
    flows: [-100, 110],
    period: "annual",
    discount_rate_annual: 0,
  });
  const s = res.structuredContent;
  assert.equal(s.irrAvailable, true);
  assert.ok(Math.abs(s.irrAnnual - 0.1) < 1e-6, `expected 10%, got ${s.irrAnnual}`);
  assert.equal(s.npv, 10);
  assert.equal(s.payback, 1);
  assert.equal(s.signChanges, 1);
});

test("analyze_flows reports why a vector has no IRR", async () => {
  const { client } = await connect();
  const res = await call(client, "cashflow_analyze_flows", { flows: [100, 100] });
  assert.equal(res.structuredContent.irrAvailable, false);
  assert.equal(res.structuredContent.irrUnavailableReason, "NO_OUTFLOW");
  assert.equal(res.structuredContent.irrAnnual, null);
});

test("analyze_flows flags a vector with several sign changes", async () => {
  const { client } = await connect();
  const res = await call(client, "cashflow_analyze_flows", { flows: [-100, 300, -250, 200] });
  assert.ok(res.structuredContent.signChanges > 1);
  assert.match(res.content[0].text, /more than one IRR/);
});

test("loan_terms matches the textbook mortgage payment", async () => {
  const { client } = await connect();
  const res = await call(client, "cashflow_loan_terms", {
    principal: 200000,
    term_months: 360,
    annual_rate: 0.06,
  });
  assert.ok(Math.abs(res.structuredContent.monthlyPayment - 1199.1) < 0.05);
  assert.ok(res.structuredContent.interestPaid > 0);
});

test("loan_terms charges no interest on a zero-rate plan and closes the balance", async () => {
  const { client } = await connect();
  const res = await call(client, "cashflow_loan_terms", {
    principal: 12000,
    term_months: 24,
    annual_rate: 0,
    include_amortization: true,
  });
  const s = res.structuredContent;
  assert.equal(s.monthlyPayment, 500);
  assert.equal(s.interestPaid, 0);
  assert.equal(s.amortization.length, 24);
  assert.equal(s.amortization[23].balance, 0, "the last payment must close the balance");
});

test("convert_rate keeps the two conventions visibly apart", async () => {
  const { client } = await connect();
  const res = await call(client, "cashflow_convert_rate", { value: 0.12 });
  const s = res.structuredContent;
  assert.ok(Math.abs(s.divided - 0.01) < 1e-9);
  assert.ok(s.compounded < s.divided, "compounding gives a smaller monthly rate");
  assert.equal(s.output, s.compounded, "compound is the default convention");
});

test("a malformed model is rejected with a validation error", async () => {
  const { client } = await connect();
  const result = await client.callTool({
    name: "cashflow_evaluate_contract",
    arguments: { model: { termMonths: 24 } },
  });
  assert.ok(result.isError, "an incomplete model must not silently evaluate");
});

test("an unknown field is rejected rather than ignored", async () => {
  const { client } = await connect();
  const model = baseModel();
  model.revenue.tipoDeCambio = 18.5;
  const result = await client.callTool({
    name: "cashflow_evaluate_contract",
    arguments: { model },
  });
  assert.ok(result.isError, "strict schemas must reject fields the engine would drop");
});
