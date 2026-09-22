# cashflow-mcp-server

An MCP server that lets an agent evaluate a real financing decision: IRR, NPV,
payback, working capital, break-even and sensitivity analysis, exposed as tools.

Built on [cashflow-engine](https://github.com/jamejialicona-cmyk/cashflow-engine), a
deterministic project cash flow engine. Every tool is a pure computation. No
network, no filesystem, no clock, no state between calls.

---

## Why an MCP server for this

Language models are unreliable at multi-step financial arithmetic and very good
at the part around it: eliciting terms from a conversation, naming what is being
assumed, and explaining what a number means. Splitting those responsibilities is
the point.

The model gathers the deal. The engine does the arithmetic. The model reads the
result back.

That split also makes the output auditable, which matters more here than in most
domains. The same model always produces the same schedule, the schedule is
returned alongside the metrics, and every tool is annotated `readOnlyHint` and
`idempotentHint`, so any call can be repeated and checked.

## Install

```bash
npm install
npm run build
```

Then register it with your MCP client. For Claude Code:

```bash
claude mcp add cashflow -- node /absolute/path/to/cashflow-mcp-server/dist/index.js
```

Or add it to a client config directly:

```json
{
  "mcpServers": {
    "cashflow": {
      "command": "node",
      "args": ["/absolute/path/to/cashflow-mcp-server/dist/index.js"]
    }
  }
}
```

Inspect it interactively with `npm run inspector`.

## Tools

| Tool | What it answers |
|---|---|
| `cashflow_model_template` | "How do I shape a contract?" Returns a filled-in, valid model to edit |
| `cashflow_evaluate_contract` | "Is this deal worth doing?" Full schedule and metrics |
| `cashflow_run_sensitivity` | "What breaks it?" Scenarios against the base case |
| `cashflow_compare_contracts` | "Which of these variants wins?" Two to five, ranked |
| `cashflow_breakeven` | "How many units a month do we need?" |
| `cashflow_analyze_flows` | "What is the IRR of this vector?" Works on raw flows |
| `cashflow_loan_terms` | "What is the payment, and what does the interest cost?" |
| `cashflow_convert_rate` | "Is 1% a month the same as 12% a year?" It is not |

### A worked exchange

> **User:** We would install 3.5 million of equipment at a hospital, run it for
> five years, and bill a monthly fee plus per-cycle charges. Is that worth doing?

The agent calls `cashflow_model_template` to get a shape, fills in the terms from
the conversation, calls `cashflow_evaluate_contract`, and gets back an 81% IRR
with payback at month 20 and one warning: net working capital exceeds three
months of EBITDA.

> **User:** What if they only send us 80% of the volume they promised?

`cashflow_run_sensitivity` returns the IRR falling by 46 percentage points and
payback sliding from month 20 to month 37. That is the answer the deal actually
turns on, and it took one more call.

## Design decisions worth defending

**Absent values are never sentinel numbers.** A contract with no outflow has no
IRR. `irrAnnual` comes back `null` with `irrUnavailableReason` set, and the
markdown says "not reportable". Returning `-1` or `0` invites an agent to format
it as a percentage and put it in front of a customer. Same for payback: `null`
means "not within the term", not month zero.

**Ranking puts missing values last.** In `cashflow_compare_contracts`, a variant
with no IRR sorts to the bottom rather than to the top. No IRR is not a low IRR,
and "never paid back" is not a fast payback.

**Schedules are summarized by default.** A 60-month contract is 61 rows of eleven
fields. `schedule_detail` defaults to `annual`, which is almost always what the
question needs, and `monthly` is there when a specific month is in dispute.

**Schemas are strict.** An unrecognized field is rejected rather than dropped. An
agent that invents `taxRate` or `currency` should be told the engine does not
model it, not have it silently ignored and the result reported as authoritative.

**Both rate conventions are exposed, and named apart.** Discounting compounds.
Amortization divides. `cashflow_convert_rate` returns both side by side every
time, because the failure mode is not getting the arithmetic wrong, it is not
noticing there were two conventions.

**Every tool is `openWorldHint: false`.** These are functions, not integrations.
The annotation says so, and the test suite asserts it.

## Testing

```bash
npm test
```

Twenty tests drive the real server through a real MCP client over an in-memory
transport. Nothing is stubbed, so a broken input schema, a mismatched
`outputSchema` or a renamed tool fails in the suite rather than in a host.

Expected values are derived by hand or from known references: the textbook
30-year mortgage payment, a break-even case solvable on paper, a payback that
falls on a month you can count to.

## Evaluations

`evaluations/evaluation.xml` holds ten questions that require several tool calls
each, with verified answers. Because the engine is deterministic and the
templates ship with the server, the answers do not drift.

## Scope

This server computes cash flows. It does not convert currencies, apply tax, read
files, or recommend a decision. It has no opinion about your industry's numbers:
every rate, price and cost is an input.

It is also not investment advice. It is arithmetic you can check.

## License

MIT
