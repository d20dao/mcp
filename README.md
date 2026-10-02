# D20DAO MCP server

Verifiable randomness for AI agents: dice, coin flips, ranges, winners and shuffles, each one a VRF request on Arc with a proof anyone can replay. 0.05 USDC per draw, paid from your Circle Agent Wallet.

## Setup

1. **Wallet.** Have your agent follow [Circle's setup guide](https://agents.circle.com/skills/setup.md). It installs the Circle CLI, logs you in with an emailed code and creates an agent wallet. You accept Circle's terms yourself.
2. **Funds.** Fund the wallet with USDC and deposit some into Circle Gateway, for example on Arc:
   ```bash
   circle gateway deposit --chain ARC --method direct --amount 1 --address <wallet>
   ```
   Arc, Polygon, Avalanche, Base, Arbitrum, Optimism, Unichain and Ethereum balances all work.
3. **Server.** Add it to your client.

   Claude Code:
   ```bash
   claude mcp add d20dao -- npx -y @d20dao/mcp@0.1.0
   ```
   Claude Desktop, Cursor and others (`mcpServers` in the client's MCP config):
   ```json
   { "mcpServers": { "d20dao": { "command": "npx", "args": ["-y", "@d20dao/mcp@0.1.0"] } } }
   ```
   On Windows, use `"command": "cmd"` with `"args": ["/c", "npx", "-y", "@d20dao/mcp@0.1.0"]` if the client cannot start `npx` directly. Pin the version, since the server runs with your Circle session.

Ask your agent to call `setup_status`; it names the next step until everything is ready.

## Tools

| Tool | Cost | Does |
| --- | --- | --- |
| `draw` | 0.05 USDC | `raw`, `coinFlip`, `dice` (up to 128), `range`, `chooseOne`, `chooseMany`, `shuffle` (up to 256 items). Returns the result with request, fulfillment and proof links. |
| `get_result` | free | Reads a draw by `paymentId` or a request by `requestId`. |
| `setup_status` | free | Checks the CLI, login, wallet, Gateway balance and today's spending. |

An optional `seed` (up to 64 bytes) is bound on chain to the draw, so a raffle can name its round before the result exists. Give each separate draw its own seed: an identical draw within five minutes returns the earlier one without paying.

A draw usually answers in about ten seconds, but it can take longer. If your client's tool timeout is short (60 seconds is a common default), raise it; a retry after a timeout returns the same draw rather than paying twice.

## Settings

| Variable | Default | |
| --- | --- | --- |
| `D20_DAILY_LIMIT_USDC` | `1` | Spending cap per UTC day, shared by every server process of the user. `0` turns paid draws off. |
| `D20_NETWORK` | `mainnet` | `testnet` uses the Arc Testnet API and a testnet CLI login (`circle wallet login <email> --testnet`). |
| `D20_PAY_CHAIN` | first funded | Circle CLI chain code to pay from, such as `ARC` or `BASE`. |
| `D20_WALLET_ADDRESS` | first agent wallet | Agent wallet to pay from. |
| `D20_CIRCLE_CLI` | `circle` on PATH | Path to the CLI's `dist/index.js`. |
| `D20_MCP_HOME` | `~/.d20dao-mcp` | Where the spending record is kept. |

## Safety

- The server holds no keys. The Circle CLI signs, and your Circle wallet limits apply. It never accepts Circle's terms for you: `CIRCLE_ACCEPT_TERMS` is kept out of the CLI it runs, and `DO_NOT_TRACK` is set so your item labels stay out of the CLI's telemetry.
- It pays only `api.d20dao.org` (or `api-testnet.d20dao.org`) and never more than 0.05 USDC per draw. If the CLI ever reports another seller, that draw comes back with a warning and paid draws stop until you delete `halt.json` from the server's home folder.
- Each draw reserves its price in the daily record before paying; if the record cannot be written, it does not pay.
- A draw that is still pending is finished for free with `get_result`. If the answer is lost after payment, the server resends the payment the CLI signed, which the API honours at most once.
- A result says `charged: false` only when that is known. When it says `unknown`, do not draw again; check with `get_result` or the wallet.
- `draw` is marked as a tool with side effects, so clients ask before running it unless you allow it.

## Verify

Every result links its request and fulfillment transactions and a proof page. Replay the proof yourself with [`@d20dao/vrf-sdk`](https://www.npmjs.com/package/@d20dao/vrf-sdk) 0.5.0 or later; see [verification](https://d20dao.org/docs/verification) and the [agent API guide](https://d20dao.org/docs/agents).

## License

MIT
