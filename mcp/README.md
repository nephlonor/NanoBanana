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
  --env GCP_MCP_PROJECT=fhnw-gemini \
  -- node /absolute/path/to/NanoBanana/mcp/index.js
```

For Claude Desktop, add the same thing to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gcp-console": {
      "command": "node",
      "args": ["/absolute/path/to/NanoBanana/mcp/index.js"],
      "env": { "GCP_MCP_PROJECT": "fhnw-gemini" }
    }
  }
}
```

### Environment

| Variable | Meaning |
| --- | --- |
| `GCP_MCP_PROJECT` | Default project ID, so tool calls can omit `project`. Falls back to `GOOGLE_CLOUD_PROJECT`. |
| `GCP_MCP_ALLOW_WRITES` | Set to `true` to permit mutating calls. Unset = read-only. |
| `GOOGLE_APPLICATION_CREDENTIALS` | Optional service-account key file, instead of `gcloud auth application-default login`. |

## Tools

Read-only:

- `list_projects`, `get_project`
- `list_billing_accounts`, `get_project_billing`
- `list_services` (enabled/disabled APIs), `list_quotas`
- `get_iam_policy`, `list_service_accounts`
- `list_cloud_run_services`, `get_cloud_run_service`
- `query_logs` (Logs Explorer)
- `gcp_request` with `GET`

Mutating — refused unless `GCP_MCP_ALLOW_WRITES=true`:

- `enable_service`, `disable_service` (also needs `confirm: true`)
- `add_iam_binding` (read-modify-write, etag-checked so a concurrent change
  fails the call instead of clobbering the policy)
- `gcp_request` with `POST`/`PATCH`/`PUT`/`DELETE`

`gcp_request` is the escape hatch for anything not covered above — any
`*.googleapis.com` REST endpoint. It refuses non-googleapis hosts so your
access token never leaves Google.

## Safety notes

- The server acts as **you**. Whatever your account can do in the console, it
  can do here — so leave `GCP_MCP_ALLOW_WRITES` unset unless you're actively
  making changes, and prefer a service account with only the roles you need.
- Nothing is cached and no credentials are written anywhere; tokens come from
  ADC per request.
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
