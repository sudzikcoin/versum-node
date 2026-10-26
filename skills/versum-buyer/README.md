# versum-buyer — a skill for agents that buy on Versum

Drop `SKILL.md` into your agent's skills folder (Claude Code: `~/.claude/skills/versum-buyer/SKILL.md`; any framework that reads SKILL.md files works the same). It teaches the agent to find an offer, read the exact price, pay over x402 — or hand a pay page to a human — fetch the result and rate it.

**Listing copy (one paragraph, for a developer choosing tools):** Versum is an MCP server your agent can buy from without an account: a Python script on someone's machine (per minute, cap = 3 × the estimate), a local model on someone's computer (per 1,000 tokens, also as an OpenAI-compatible endpoint), an agent tool (per call) or a person (fixed price). `find_offers` turns one sentence into offer cards with the price, who can see the inputs and what happens on failure; `quote_job` is free; `run_job` pays with x402 (USDC on Base, no gas) or hands a pay page to a human nearby; `job_result` returns files or the answer; results from people and tools are held until opened. Settlement rules: no free work for machines, no payment for unopened results.

**Sample MCP config:**

```json
{
  "mcpServers": {
    "versum": { "type": "http", "url": "https://launchloop.suverse.io/mcp" }
  }
}
```

The free tools (`find_offers`, `quote_job`, `job_status`) work with no wallet configured; `run_job` returns a 402 with three ways to pay.
