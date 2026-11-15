# Local read-only MCP (stdio)

Uses the official `mcp` Python SDK v1 maintenance API (`FastMCP`); tested with 1.30.0.
Only local stdio clients are supported. No HTTP, credentials, extraction or write tools.

## Install and start (PowerShell, repository root)

```powershell
$py = 'C:\Users\user\AppData\Local\Python\bin\python.exe'
& $py -m pip install -e './agents/competition_agent[mcp]'
& $py -B -m competition_agent.mcp_server --competition-db 'C:\data\competition-v3.sqlite3' --esco-db 'C:\data\esco.sqlite3'
```

Replace both paths with existing files. Competition schema must already be v3.
Missing files or incompatible schema fail; this server never initializes/migrates data.
Both databases use SQLite `mode=ro` and `query_only=ON`. Stdout is reserved for MCP;
running the command interactively waits for a client's protocol messages.

## MCP client configuration

For clients accepting the common `mcpServers` configuration, after installation:

```json
{
  "mcpServers": {
    "competition": {
      "command": "C:\\Users\\user\\AppData\\Local\\Python\\bin\\python.exe",
      "args": ["-B", "-m", "competition_agent.mcp_server",
               "--competition-db", "C:\\data\\competition-v3.sqlite3",
               "--esco-db", "C:\\data\\esco.sqlite3"]
    }
  }
}
```

Do not configure an OpenAI key: the server does not read or use one. A client starts
the subprocess, initializes an official MCP ClientSession, then calls tools/list and
tools/call. Integration tests exercise this actual stdio flow, not just Python handlers.

## Tools (illustrative output excerpts)

| Tool | Input | Output |
|---|---|---|
| `list_competitions` | `{"limit":20}` | `{"status":"ok","competitions":[{"competition_id":1,"competition_name":"Example","status":"confirmed"}]}` |
| `get_competition` | `{"competition_id":1}` | `{"status":"ok","competition":{...},"groups":null,"groups_status":"not_recorded","sources":[...]}` |
| `get_competition_skills` | `{"competition_id":1}` | `{"status":"ok","skills":[],"sources":[...]}` |

Limit defaults to 20 and must be 1–100. Missing IDs return `not_found`; existing draft
or archived competitions return `not_confirmed` and never appear in the list tool.
Competition details contain stored name, organizer, timestamps/status and linked sources
with their classification records. Edition/review information is returned where stored
in classification data. Groups have no formal schema field and are explicitly unknown.

Skill results originate only from `competition_skills`, never proposal lists. Each has
`concept_uri`, current ESCO `label` (null if absent), `importance`, stored `evidence`,
`valid` and `status`. Only `accepted_current` with `valid=true` is usable as verified.
The server reuses the review service's read-only evidence checks and verifies accepted
proposal provenance, exact quote, scope, source fingerprint/revision, catalogue fingerprint
and current ESCO candidate definition. It never calls refresh/accept or changes review state.
Legacy, missing, stale, unconfirmed or insufficient evidence is preserved and marked
`stale_unverified_or_insufficient_evidence`, `valid=false`; do not treat it as a skill
requirement. `sources[].source_status` is `confirmed_current` or `needs_review`.

An empty skills list means no formal association, not a claim that the competition needs
no skills. Current validity is a read-time check, not a persistent approval. Multiple
invalid conditions share a conservative status in this MVP. Source text is untrusted
announcement content; clients must not execute instructions embedded in evidence.

Offline tests: `python -B -m unittest discover -s agents/competition_agent/tests -q`.
The MCP tests create temporary databases, deny network/OpenAI imports in the child,
use the real SDK client and assert database hashes remain unchanged. Windows sandbox
policies may require permission to launch stdio subprocesses.
