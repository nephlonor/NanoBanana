# Google Cloud MCP server

An MCP server that lets Claude manage your Google Cloud account — the things
you'd otherwise click through on <https://console.cloud.google.com>: projects,
enabled APIs, billing, IAM, service accounts, Cloud Run services, quotas and
logs.

There is no public API behind the console UI itself, so this talks to the same
REST APIs the console does (`cloudresourcemanager`, `serviceusage`,
`cloudbilling`, `iam`, `run`, `logging`) using your own credentials.

## Setup

```bash
cd mcp
npm install

# Log in once — this is the credential the server uses:
gcloud auth application-default login
```

Then register it with Claude Code:

```bash
claude mcp add gcp-console \
  --env GCP_MCP_PROJECT=my-project-123456 \
  -- node /absolute/path/to/NanoBanana/mcp/index.js
```

For Claude Desktop, add the same thing to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gcp-console": {
      "command": "node",
      "args": ["/absolute/path/to/NanoBanana/mcp/index.js"],
      "env": { "GCP_MCP_PROJECT": "my-project-123456" }
    }
  }
}
```

### Environment

| Variable | Meaning |
| --- | --- |
| `GCP_MCP_PROJECT` | Default project ID, so tool calls can omit `project`. Falls back to `GOOGLE_CLOUD_PROJECT`. |
| `GCP_MCP_ALLOW_WRITES` | Set to `true` to permit mutating calls (including creating API keys). Unset = read-only. |
| `GCP_MCP_BILLING_TABLE` | BigQuery billing-export table (`project.dataset.table`). Needed by the cost tools — see [Cost data](#cost-data). |
| `GOOGLE_APPLICATION_CREDENTIALS` | Optional service-account key file, instead of `gcloud auth application-default login`. |

## Tools

Read-only:

- `list_projects`, `get_project`
- `list_billing_accounts`, `get_project_billing`, `list_billing_budgets`
- `billing_cost_summary`, `billing_cost_trend` (need `GCP_MCP_BILLING_TABLE`)
- `list_api_keys`, `get_api_key_string`
- `list_services` (enabled/disabled APIs), `list_quotas`
- `get_iam_policy`, `list_service_accounts`
- `list_cloud_run_services`, `get_cloud_run_service`
- `query_logs` (Logs Explorer)
- `gcp_request` with `GET`

Mutating — refused unless `GCP_MCP_ALLOW_WRITES=true`:

- `create_api_key`, `delete_api_key` (delete also needs `confirm: true`)
- `enable_service`, `disable_service` (also needs `confirm: true`)
- `add_iam_binding` (read-modify-write, etag-checked so a concurrent change
  fails the call instead of clobbering the policy)
- `gcp_request` with `POST`/`PATCH`/`PUT`/`DELETE`

`gcp_request` is the escape hatch for anything not covered above — any
`*.googleapis.com` REST endpoint. It refuses non-googleapis hosts so your
access token never leaves Google.

## Cost data

The Cloud Billing API serves accounts, project links and budgets — but **not
spend**. Actual cost figures only exist in the BigQuery billing export, so
`billing_cost_summary` and `billing_cost_trend` query that table.

Turn the export on once, in Billing → **Billing export** → *BigQuery export* →
Standard usage cost. Google starts writing to a table named like
`gcp_billing_export_v1_01ABCD_234567_89EFGH`, then point the server at it:

```
GCP_MCP_BILLING_TABLE=my-project-123456.billing_export.gcp_billing_export_v1_01ABCD_234567_89EFGH
```

Two caveats worth knowing before the first weekly review:

- The export is **not retroactive** — it only contains usage from the day you
  enabled it onward, so the first week's trend numbers will look lopsided.
- Rows land with a lag of a few hours, and late-arriving usage can restate
  recent days. Yesterday's number is solid; the last few hours are not.

Costs are reported both gross and net of credits (`cost`, `credits`,
`net_cost`) — for this project, free credits mean the net figure is the one
that matters. Each query is a BigQuery job billed to `GCP_MCP_PROJECT`; a
week of one project's export is well inside the free query tier.

`list_billing_budgets` needs none of this and works immediately.

## Weekly review

```
billing_cost_summary days=7 groupBy=service   # where the money went
billing_cost_trend days=7                     # what moved vs last week
billing_cost_summary days=7 groupBy=day       # spot a spike day
list_billing_budgets billingAccount=01ABCD-234567-89EFGH
list_quotas service=aiplatform.googleapis.com
```

## API keys

`create_api_key` creates the key, waits for the operation to finish, and
returns the key **including its secret string** — so the value lands in your
conversation. Restrict keys at creation rather than after the fact:

```
create_api_key displayName="NanoBanana browser key" \
  apiTargets=["aiplatform.googleapis.com"] \
  browserReferrers=["https://nephlonor.github.io/*"]
```

A key takes either `browserReferrers` or `serverIps`, never both — Google
allows one client restriction per key, and the tool rejects the combination
up front rather than letting the API return a confusing error.

## Safety notes

- The server acts as **you**. Whatever your account can do in the console, it
  can do here — so leave `GCP_MCP_ALLOW_WRITES` unset unless you're actively
  making changes, and prefer a service account with only the roles you need.
- Nothing is cached and no credentials are written anywhere; tokens come from
  ADC per request.
- `get_api_key_string` and `create_api_key` return **live credentials** into
  the conversation. Anyone reading that transcript can use the key, so scope
  new keys tightly and rotate anything that leaks somewhere it shouldn't.
- Billing *changes* (linking/unlinking billing accounts, closing accounts) are
  deliberately not exposed as dedicated tools. They're reachable through
  `gcp_request` with writes enabled if you really want them.

## Useful with this repo

```
list_cloud_run_services region=us-central1     # find the Omni proxy
get_cloud_run_service service=nanobanana-omni-proxy
list_quotas service=aiplatform.googleapis.com  # Vertex image/Veo limits
query_logs filter='resource.type="cloud_run_revision" severity>=ERROR'
```
