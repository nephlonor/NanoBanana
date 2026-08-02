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
