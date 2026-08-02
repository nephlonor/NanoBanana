#!/usr/bin/env node
// MCP server for managing a Google Cloud account from Claude.
//
// It covers the things you'd otherwise click through on
// console.cloud.google.com: projects, enabled APIs, billing, IAM, service
// accounts, Cloud Run services, quotas and logs — plus a generic escape hatch
// (gcp_request) for any other googleapis REST endpoint.
//
// Auth is Application Default Credentials, the same mechanism proxy/index.js
// uses. Easiest setup is:
//
//   gcloud auth application-default login
//
// Mutating tools are refused unless GCP_MCP_ALLOW_WRITES=true is set in the
// server's environment, so a read-only setup stays read-only no matter what
// the model decides to call.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { GoogleAuth } from 'google-auth-library';
import { z } from 'zod';

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const DEFAULT_PROJECT = process.env.GCP_MCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || '';
const ALLOW_WRITES = process.env.GCP_MCP_ALLOW_WRITES === 'true';
// Fully-qualified BigQuery billing-export table, e.g.
// "my-proj.billing_export.gcp_billing_export_v1_XXXXXX_XXXXXX_XXXXXX".
// Actual spend lives only in that export — the Cloud Billing API doesn't
// serve cost figures — so the cost tools need this set.
const BILLING_TABLE = process.env.GCP_MCP_BILLING_TABLE || '';

const auth = new GoogleAuth({ scopes: SCOPE });

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

class GcpError extends Error {}

async function accessToken() {
    const client = await auth.getClient();
    const { token } = await client.getAccessToken();
    if (!token) throw new GcpError('No access token from Application Default Credentials. Run: gcloud auth application-default login');
    return token;
}

// One authenticated call against a googleapis REST endpoint. `query` values
// that are undefined/null are dropped so callers can pass optional params
// straight through.
async function gcp(url, { method = 'GET', query, body } = {}) {
    const u = new URL(url);
    for (const [k, v] of Object.entries(query || {})) {
        if (v === undefined || v === null || v === '') continue;
        u.searchParams.set(k, String(v));
    }

    const res = await fetch(u, {
        method,
        headers: {
            Authorization: `Bearer ${await accessToken()}`,
            ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined
    });

    const text = await res.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }

    if (!res.ok) {
        const msg = parsed?.error?.message || res.statusText;
        const status = parsed?.error?.status ? ` (${parsed.error.status})` : '';
        throw new GcpError(`${method} ${u.pathname} → ${res.status}${status}: ${msg}`);
    }
    return parsed;
}

function projectOf(arg) {
    const p = arg || DEFAULT_PROJECT;
    if (!p) throw new GcpError('No project given and GCP_MCP_PROJECT is not set.');
    return p;
}

function requireWrites(what) {
    if (!ALLOW_WRITES) {
        throw new GcpError(`Refusing to ${what}: this server is read-only. Set GCP_MCP_ALLOW_WRITES=true in its environment to allow mutating calls.`);
    }
}

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = (err) => ({ isError: true, content: [{ type: 'text', text: String(err?.message || err) }] });

const server = new McpServer({ name: 'gcp-console', version: '1.0.0' });

// Wraps a handler so every GCP/argument error comes back as a tool error the
// model can read, rather than killing the request.
function tool(name, config, handler) {
    server.registerTool(name, config, async (args) => {
        try { return ok(await handler(args || {})); }
        catch (err) { return fail(err); }
    });
}

const projectArg = z.string().optional().describe('Project ID. Defaults to GCP_MCP_PROJECT.');
const pageSizeArg = z.number().int().min(1).max(500).optional().describe('Max results per page.');
const pageTokenArg = z.string().optional().describe('Page token from a previous response.');

// ---------------------------------------------------------------------------
// Projects & billing
// ---------------------------------------------------------------------------

tool('list_projects', {
    title: 'List projects',
    description: 'List the Google Cloud projects the authenticated account can see.',
    inputSchema: {
        filter: z.string().optional().describe('Cloud Resource Manager filter, e.g. "state:ACTIVE".'),
        pageSize: pageSizeArg,
        pageToken: pageTokenArg
    }
}, ({ filter, pageSize, pageToken }) =>
    gcp('https://cloudresourcemanager.googleapis.com/v1/projects', { query: { filter, pageSize, pageToken } }));

tool('get_project', {
    title: 'Get project',
    description: 'Project number, lifecycle state, labels and parent for one project.',
    inputSchema: { project: projectArg }
}, ({ project }) =>
    gcp(`https://cloudresourcemanager.googleapis.com/v1/projects/${projectOf(project)}`));

tool('list_billing_accounts', {
    title: 'List billing accounts',
    description: 'Billing accounts the authenticated account can see, including whether each is open.',
    inputSchema: { pageSize: pageSizeArg, pageToken: pageTokenArg }
}, ({ pageSize, pageToken }) =>
    gcp('https://cloudbilling.googleapis.com/v1/billingAccounts', { query: { pageSize, pageToken } }));

tool('get_project_billing', {
    title: 'Get project billing',
    description: 'Which billing account a project is linked to, and whether billing is enabled.',
    inputSchema: { project: projectArg }
}, ({ project }) =>
    gcp(`https://cloudbilling.googleapis.com/v1/projects/${projectOf(project)}/billingInfo`));

// ---------------------------------------------------------------------------
// APIs / services
// ---------------------------------------------------------------------------

tool('list_services', {
    title: 'List APIs',
    description: 'List APIs for a project. Defaults to the enabled ones — the "APIs & Services → Enabled APIs" page.',
    inputSchema: {
        project: projectArg,
        state: z.enum(['ENABLED', 'DISABLED']).optional().describe('Defaults to ENABLED.'),
        pageSize: pageSizeArg,
        pageToken: pageTokenArg
    }
}, async ({ project, state, pageSize, pageToken }) => {
    const p = await gcp(`https://cloudresourcemanager.googleapis.com/v1/projects/${projectOf(project)}`);
    return gcp(`https://serviceusage.googleapis.com/v1/projects/${p.projectNumber}/services`, {
        query: { filter: `state:${state || 'ENABLED'}`, pageSize, pageToken }
    });
});

tool('enable_service', {
    title: 'Enable an API',
    description: 'Enable an API on a project, e.g. aiplatform.googleapis.com. Requires GCP_MCP_ALLOW_WRITES=true.',
    inputSchema: {
        service: z.string().describe('Service name, e.g. "run.googleapis.com".'),
        project: projectArg
    }
}, async ({ service, project }) => {
    requireWrites(`enable ${service}`);
    const p = await gcp(`https://cloudresourcemanager.googleapis.com/v1/projects/${projectOf(project)}`);
    return gcp(`https://serviceusage.googleapis.com/v1/projects/${p.projectNumber}/services/${service}:enable`, { method: 'POST', body: {} });
});

tool('disable_service', {
    title: 'Disable an API',
    description: 'Disable an API on a project. Breaks anything still using it. Requires GCP_MCP_ALLOW_WRITES=true.',
    inputSchema: {
        service: z.string().describe('Service name, e.g. "run.googleapis.com".'),
        project: projectArg,
        confirm: z.literal(true).describe('Must be true — acknowledges that dependent resources will stop working.')
    }
}, async ({ service, project }) => {
    requireWrites(`disable ${service}`);
    const p = await gcp(`https://cloudresourcemanager.googleapis.com/v1/projects/${projectOf(project)}`);
    return gcp(`https://serviceusage.googleapis.com/v1/projects/${p.projectNumber}/services/${service}:disable`, {
        method: 'POST', body: { disableDependentServices: false }
    });
});

tool('list_quotas', {
    title: 'List quotas for a service',
    description: 'Consumer quota limits and current overrides for one API — the "Quotas" page, e.g. for aiplatform.googleapis.com.',
    inputSchema: {
        service: z.string().describe('Service name, e.g. "aiplatform.googleapis.com".'),
        project: projectArg,
        pageSize: pageSizeArg,
        pageToken: pageTokenArg
    }
}, async ({ service, project, pageSize, pageToken }) => {
    const p = await gcp(`https://cloudresourcemanager.googleapis.com/v1/projects/${projectOf(project)}`);
    return gcp(`https://serviceusage.googleapis.com/v1beta1/projects/${p.projectNumber}/services/${service}/consumerQuotaMetrics`, {
        query: { pageSize, pageToken }
    });
});

// ---------------------------------------------------------------------------
// IAM
// ---------------------------------------------------------------------------

tool('get_iam_policy', {
    title: 'Get project IAM policy',
    description: 'Role bindings on a project — the "IAM" page.',
    inputSchema: { project: projectArg }
}, ({ project }) =>
    gcp(`https://cloudresourcemanager.googleapis.com/v1/projects/${projectOf(project)}:getIamPolicy`, { method: 'POST', body: {} }));

tool('list_service_accounts', {
    title: 'List service accounts',
    description: 'Service accounts in a project, with their emails and display names.',
    inputSchema: { project: projectArg, pageSize: pageSizeArg, pageToken: pageTokenArg }
}, ({ project, pageSize, pageToken }) =>
    gcp(`https://iam.googleapis.com/v1/projects/${projectOf(project)}/serviceAccounts`, { query: { pageSize, pageToken } }));

tool('add_iam_binding', {
    title: 'Grant a role',
    description: 'Add one member to one role on a project, read-modify-write against the live policy (etag-checked). Requires GCP_MCP_ALLOW_WRITES=true.',
    inputSchema: {
        member: z.string().describe('e.g. "serviceAccount:x@y.iam.gserviceaccount.com" or "user:me@example.com".'),
        role: z.string().describe('e.g. "roles/aiplatform.user".'),
        project: projectArg
    }
}, async ({ member, role, project }) => {
    requireWrites(`grant ${role} to ${member}`);
    const p = projectOf(project);
    const policy = await gcp(`https://cloudresourcemanager.googleapis.com/v1/projects/${p}:getIamPolicy`, { method: 'POST', body: {} });
    policy.bindings = policy.bindings || [];
    const binding = policy.bindings.find((b) => b.role === role);
    if (binding) {
        binding.members = binding.members || [];
        if (binding.members.includes(member)) return { unchanged: true, message: `${member} already has ${role}.` };
        binding.members.push(member);
    } else {
        policy.bindings.push({ role, members: [member] });
    }
    // The etag from getIamPolicy makes this fail rather than clobber if the
    // policy changed underneath us.
    return gcp(`https://cloudresourcemanager.googleapis.com/v1/projects/${p}:setIamPolicy`, { method: 'POST', body: { policy } });
});

// ---------------------------------------------------------------------------
// Cloud Run (where this repo's Omni proxy lives)
// ---------------------------------------------------------------------------

tool('list_cloud_run_services', {
    title: 'List Cloud Run services',
    description: 'Cloud Run services in a region, with their URLs and ready state.',
    inputSchema: {
        project: projectArg,
        region: z.string().optional().describe('Region, or "-" for all. Defaults to us-central1.'),
        pageSize: pageSizeArg,
        pageToken: pageTokenArg
    }
}, ({ project, region, pageSize, pageToken }) =>
    gcp(`https://run.googleapis.com/v2/projects/${projectOf(project)}/locations/${region || 'us-central1'}/services`, {
        query: { pageSize, pageToken }
    }));

tool('get_cloud_run_service', {
    title: 'Get a Cloud Run service',
    description: 'Full config of one Cloud Run service: image, env vars, service account, traffic, conditions.',
    inputSchema: {
        service: z.string().describe('Service name, e.g. "nanobanana-omni-proxy".'),
        project: projectArg,
        region: z.string().optional().describe('Defaults to us-central1.')
    }
}, ({ service, project, region }) =>
    gcp(`https://run.googleapis.com/v2/projects/${projectOf(project)}/locations/${region || 'us-central1'}/services/${service}`));

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

tool('query_logs', {
    title: 'Query logs',
    description: 'Read Cloud Logging entries for a project — the "Logs Explorer" page.',
    inputSchema: {
        filter: z.string().optional().describe('Logging query, e.g. \'resource.type="cloud_run_revision" severity>=ERROR\'.'),
        project: projectArg,
        pageSize: z.number().int().min(1).max(200).optional().describe('Defaults to 20.'),
        pageToken: pageTokenArg,
        orderBy: z.string().optional().describe('Defaults to "timestamp desc".')
    }
}, ({ filter, project, pageSize, pageToken, orderBy }) =>
    gcp('https://logging.googleapis.com/v2/entries:list', {
        method: 'POST',
        body: {
            resourceNames: [`projects/${projectOf(project)}`],
            filter,
            orderBy: orderBy || 'timestamp desc',
            pageSize: pageSize || 20,
            pageToken
        }
    }));

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

// apikeys.googleapis.com returns a long-running operation for create/delete;
// poll it so the tool result is the finished key rather than an operation the
// caller has to chase.
async function awaitOperation(name, { tries = 20, delayMs = 1000 } = {}) {
    for (let i = 0; i < tries; i++) {
        const op = await gcp(`https://apikeys.googleapis.com/v2/${name}`);
        if (op.done) {
            if (op.error) throw new GcpError(`Operation failed: ${op.error.message}`);
            return op.response;
        }
        await new Promise((r) => setTimeout(r, delayMs));
    }
    throw new GcpError(`Operation ${name} did not finish in time — check it with gcp_request.`);
}

tool('list_api_keys', {
    title: 'List API keys',
    description: 'API keys in a project with their display names and restrictions. Does not include the secret key strings — use get_api_key_string for one key.',
    inputSchema: { project: projectArg, pageSize: pageSizeArg, pageToken: pageTokenArg }
}, ({ project, pageSize, pageToken }) =>
    gcp(`https://apikeys.googleapis.com/v2/projects/${projectOf(project)}/locations/global/keys`, { query: { pageSize, pageToken } }));

tool('get_api_key_string', {
    title: 'Get an API key string',
    description: 'Reveal the secret string for one API key. Treat the result as a credential — it grants whatever the key is allowed to call.',
    inputSchema: {
        key: z.string().describe('Key ID, or a full "projects/…/keys/…" name.'),
        project: projectArg
    }
}, ({ key, project }) => {
    const name = key.startsWith('projects/') ? key : `projects/${projectOf(project)}/locations/global/keys/${key}`;
    return gcp(`https://apikeys.googleapis.com/v2/${name}/keyString`);
});

tool('create_api_key', {
    title: 'Create an API key',
    description: 'Create an API key, optionally restricted to specific APIs and/or HTTP referrers, and return it with its key string. Requires GCP_MCP_ALLOW_WRITES=true.',
    inputSchema: {
        displayName: z.string().describe('Human-readable name, e.g. "NanoBanana browser key".'),
        project: projectArg,
        apiTargets: z.array(z.string()).optional()
            .describe('Restrict the key to these services, e.g. ["aiplatform.googleapis.com"]. Unrestricted if omitted.'),
        browserReferrers: z.array(z.string()).optional()
            .describe('Restrict to these HTTP referrers, e.g. ["https://example.com/*"]. Mutually exclusive with serverIps.'),
        serverIps: z.array(z.string()).optional()
            .describe('Restrict to these caller IPs/CIDRs. Mutually exclusive with browserReferrers.')
    }
}, async ({ displayName, project, apiTargets, browserReferrers, serverIps }) => {
    requireWrites(`create API key "${displayName}"`);
    if (browserReferrers?.length && serverIps?.length) {
        throw new GcpError('An API key can carry only one client restriction — pass browserReferrers or serverIps, not both.');
    }

    const restrictions = {};
    if (apiTargets?.length) restrictions.apiTargets = apiTargets.map((service) => ({ service }));
    if (browserReferrers?.length) restrictions.browserKeyRestrictions = { allowedReferrers: browserReferrers };
    if (serverIps?.length) restrictions.serverKeyRestrictions = { allowedIps: serverIps };

    const p = projectOf(project);
    const op = await gcp(`https://apikeys.googleapis.com/v2/projects/${p}/locations/global/keys`, {
        method: 'POST',
        body: { displayName, ...(Object.keys(restrictions).length ? { restrictions } : {}) }
    });
    const key = op.done ? op.response : await awaitOperation(op.name);
    const { keyString } = await gcp(`https://apikeys.googleapis.com/v2/${key.name}/keyString`);
    return { ...key, keyString };
});

tool('delete_api_key', {
    title: 'Delete an API key',
    description: 'Delete an API key. Anything still using it breaks immediately. Requires GCP_MCP_ALLOW_WRITES=true.',
    inputSchema: {
        key: z.string().describe('Key ID, or a full "projects/…/keys/…" name.'),
        project: projectArg,
        confirm: z.literal(true).describe('Must be true — acknowledges that callers using this key will start failing.')
    }
}, async ({ key, project }) => {
    requireWrites(`delete API key ${key}`);
    const name = key.startsWith('projects/') ? key : `projects/${projectOf(project)}/locations/global/keys/${key}`;
    const op = await gcp(`https://apikeys.googleapis.com/v2/${name}`, { method: 'DELETE' });
    return op.done ? (op.response ?? op) : await awaitOperation(op.name);
});

// ---------------------------------------------------------------------------
// Cost reporting (weekly review)
// ---------------------------------------------------------------------------

// The Cloud Billing API exposes accounts, links and budgets — but not spend.
// Cost figures come from the BigQuery billing export, so these tools query
// that table directly.
function billingTable() {
    if (!BILLING_TABLE) {
        throw new GcpError('Cost data needs the BigQuery billing export. Set GCP_MCP_BILLING_TABLE to the export table (project.dataset.table) — see mcp/README.md for how to turn the export on.');
    }
    if (!/^[A-Za-z0-9_.:-]+$/.test(BILLING_TABLE)) {
        throw new GcpError(`GCP_MCP_BILLING_TABLE is not a valid table reference: ${BILLING_TABLE}`);
    }
    return '`' + BILLING_TABLE.replace(/`/g, '') + '`';
}

async function bigQuery(project, query, params) {
    return gcp(`https://bigquery.googleapis.com/bigquery/v2/projects/${project}/queries`, {
        method: 'POST',
        body: {
            query,
            useLegacySql: false,
            timeoutMs: 60000,
            parameterMode: 'NAMED',
            queryParameters: params
        }
    });
}

const intParam = (name, value) => ({
    name,
    parameterType: { type: 'INT64' },
    parameterValue: { value: String(value) }
});

// BigQuery returns rows as positional {f:[{v}]} — reshape to plain objects.
function bqRows(result) {
    const fields = result.schema?.fields || [];
    return (result.rows || []).map((row) =>
        Object.fromEntries(fields.map((f, i) => {
            const v = row.f[i]?.v;
            return [f.name, f.type === 'NUMERIC' || f.type === 'FLOAT' ? Number(v) : v];
        })));
}

tool('billing_cost_summary', {
    title: 'Cost summary',
    description: 'Total spend over the last N days, broken down by service or project — the numbers for a weekly billing review. Reads the BigQuery billing export (GCP_MCP_BILLING_TABLE).',
    inputSchema: {
        days: z.number().int().min(1).max(365).optional().describe('Look-back window in days. Defaults to 7.'),
        groupBy: z.enum(['service', 'project', 'sku', 'day']).optional().describe('Breakdown dimension. Defaults to service.'),
        project: projectArg.describe('Project that runs the BigQuery job (billed for the query). Defaults to GCP_MCP_PROJECT.'),
        limit: z.number().int().min(1).max(200).optional().describe('Max rows. Defaults to 25.')
    }
}, async ({ days, groupBy, project, limit }) => {
    const window = days || 7;
    const dimension = {
        service: 'service.description',
        project: 'project.name',
        sku: 'sku.description',
        day: 'FORMAT_TIMESTAMP("%Y-%m-%d", usage_start_time)'
    }[groupBy || 'service'];

    const query = `
        SELECT
          ${dimension} AS dimension,
          ROUND(SUM(cost), 2) AS cost,
          ROUND(SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)), 2) AS credits,
          ROUND(SUM(cost) + SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)), 2) AS net_cost,
          ANY_VALUE(currency) AS currency
        FROM ${billingTable()}
        WHERE usage_start_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
        GROUP BY dimension
        ORDER BY net_cost DESC
        LIMIT @max_rows`;

    const result = await bigQuery(projectOf(project), query, [intParam('days', window), intParam('max_rows', limit || 25)]);
    const rows = bqRows(result);
    return {
        windowDays: window,
        groupBy: groupBy || 'service',
        totalNetCost: Math.round(rows.reduce((sum, r) => sum + (r.net_cost || 0), 0) * 100) / 100,
        currency: rows[0]?.currency,
        rows
    };
});

tool('billing_cost_trend', {
    title: 'Week-over-week cost trend',
    description: 'Compare the last N days of spend per service against the N days before that — what moved since the previous weekly review. Reads the BigQuery billing export.',
    inputSchema: {
        days: z.number().int().min(1).max(90).optional().describe('Length of each period in days. Defaults to 7.'),
        project: projectArg.describe('Project that runs the BigQuery job. Defaults to GCP_MCP_PROJECT.'),
        limit: z.number().int().min(1).max(200).optional().describe('Max rows. Defaults to 25.')
    }
}, async ({ days, project, limit }) => {
    const window = days || 7;
    const query = `
        WITH windowed AS (
          SELECT
            service.description AS service,
            cost + IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0) AS net_cost,
            IF(usage_start_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY), 'current', 'previous') AS period
          FROM ${billingTable()}
          WHERE usage_start_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @double_days DAY)
        )
        SELECT
          service,
          ROUND(SUM(IF(period = 'current', net_cost, 0)), 2) AS current_cost,
          ROUND(SUM(IF(period = 'previous', net_cost, 0)), 2) AS previous_cost,
          ROUND(SUM(IF(period = 'current', net_cost, 0)) - SUM(IF(period = 'previous', net_cost, 0)), 2) AS delta
        FROM windowed
        GROUP BY service
        ORDER BY ABS(delta) DESC
        LIMIT @max_rows`;

    const result = await bigQuery(projectOf(project), query,
        [intParam('days', window), intParam('double_days', window * 2), intParam('max_rows', limit || 25)]);
    return { periodDays: window, rows: bqRows(result) };
});

tool('list_billing_budgets', {
    title: 'List budgets',
    description: 'Budgets and alert thresholds on a billing account — the guardrails half of a weekly review. Works without the BigQuery export.',
    inputSchema: {
        billingAccount: z.string().describe('Billing account ID, e.g. "01ABCD-234567-89EFGH", or a full "billingAccounts/…" name.'),
        pageSize: pageSizeArg,
        pageToken: pageTokenArg
    }
}, ({ billingAccount, pageSize, pageToken }) => {
    const name = billingAccount.startsWith('billingAccounts/') ? billingAccount : `billingAccounts/${billingAccount}`;
    return gcp(`https://billingbudgets.googleapis.com/v1/${name}/budgets`, { query: { pageSize, pageToken } });
});

// ---------------------------------------------------------------------------
// Escape hatch
// ---------------------------------------------------------------------------

tool('gcp_request', {
    title: 'Raw googleapis request',
    description: 'Authenticated request against any *.googleapis.com REST endpoint, for anything the dedicated tools do not cover. Non-GET requires GCP_MCP_ALLOW_WRITES=true.',
    inputSchema: {
        url: z.string().describe('Full https URL on a googleapis.com host.'),
        method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']).optional().describe('Defaults to GET.'),
        query: z.record(z.string()).optional().describe('Extra query parameters.'),
        body: z.record(z.any()).optional().describe('JSON request body.')
    }
}, ({ url, method, query, body }) => {
    const m = method || 'GET';
    let host;
    try { host = new URL(url).host; } catch { throw new GcpError(`Not a valid URL: ${url}`); }
    if (!/(^|\.)googleapis\.com$/.test(host)) {
        throw new GcpError(`Refusing to send credentials to ${host} — googleapis.com hosts only.`);
    }
    if (m !== 'GET') requireWrites(`send ${m} ${url}`);
    return gcp(url, { method: m, query, body });
});

// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
