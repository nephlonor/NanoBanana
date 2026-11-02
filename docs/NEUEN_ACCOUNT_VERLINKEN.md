# Neuen Account verlinken

Step-by-step guide for linking a **fresh** Google Cloud account/project to NanoBanana. It assumes the Google
Cloud account exists and a billing account / payment method is already linked
to the project.

Placeholders used below — replace them with your own values:

| Placeholder | What it is | Where to find it |
|---|---|---|
| `PROJECT_ID` | The project **ID** (not the display name) | Console project picker, "ID" column |
| `YOUR_EMAIL` | The Google account you sign in to the app with | — |

> **Naming note:** Vertex AI was renamed **Gemini Enterprise Agent Platform**
> ("Agent Platform") in 2026. Only the name changed: the API is still
> `aiplatform.googleapis.com`, the role is still `roles/aiplatform.user`, and
> the app needs no code changes. The console shows the new names.

---

## 1. Enable the Agent Platform API

Console: <https://console.cloud.google.com/apis/library/aiplatform.googleapis.com?project=PROJECT_ID>
→ **Enable**.

Or in Cloud Shell (<https://shell.cloud.google.com>):

```bash
gcloud config set project PROJECT_ID
gcloud services enable aiplatform.googleapis.com
```

## 2. Configure the OAuth consent screen

The app signs you in with Google (OAuth) and calls Vertex with your own
token. API keys are not used — `aiplatform.googleapis.com` doesn't accept them.

Console: **Google Auth Platform** → <https://console.cloud.google.com/auth/overview?project=PROJECT_ID>

1. **Get started** / **Branding:** app name + support email.
2. **Audience:** user type **External**, leave publishing status on **Testing**.
3. **Audience → Test users → + Add users:** add `YOUR_EMAIL`.
   Every Google account that will sign in to the app must be listed here.

## 3. Create the OAuth client ID

Console: **Google Auth Platform → Clients** → <https://console.cloud.google.com/auth/clients?project=PROJECT_ID>
→ **Create client**.

- **Application type:** **Web application** (not Desktop/iOS/Android).
- **Authorized JavaScript origins:** **+ Add URI** → exactly

  ```
  https://nephlonor.github.io
  ```

  The app lives at `https://nephlonor.github.io/NanoBanana/`, but Google wants
  the **origin only** — no `/NanoBanana`, no trailing slash, `https` not
  `http`. Entering the full app URL is rejected or silently doesn't match.
  Only add more entries if you open the app from somewhere else (e.g.
  `http://localhost:8000` for local testing).
- **Authorized redirect URIs:** leave empty.

Copy the **Client ID** (format `123456789012-xxxx.apps.googleusercontent.com`).
Not the client secret (`GOCSPX-…`) and not an API key (`AIza…`).

Changes to origins can take 5–10 minutes to take effect.

## 4. Grant the signing-in account access to Vertex

The project **Owner** already has everything. Any other account needs the
**Agent Platform User** role:

Console: **IAM & Admin → IAM** → <https://console.cloud.google.com/iam-admin/iam?project=PROJECT_ID>
→ **Grant access** → principal `YOUR_EMAIL` → role **Agent Platform User**
(`roles/aiplatform.user`).

Or:

```bash
gcloud projects add-iam-policy-binding PROJECT_ID \
  --member "user:YOUR_EMAIL" --role roles/aiplatform.user
```

## 5. Configure the app

Open the app → tap the **Sign-in** panel:

1. **Google Cloud project ID:** `PROJECT_ID`
2. **Vertex AI region:** leave `us-central1` (Omni is pinned to `global`
   automatically and ignores this setting).
3. **OAuth Client ID:** clear the field completely, paste the new Client ID.
4. **Save**, then **reload the page**.
5. **Sign in with Google / switch account** → pick `YOUR_EMAIL`.

## 6. Optional: Omni proxy on Cloud Run

Only needed if Omni should run as a service account instead of your own
sign-in. From Cloud Shell, in a checkout of this repo:

```bash
cd proxy
PROJECT=PROJECT_ID bash deploy.sh
```

It enables the required APIs, deploys the proxy, grants it
`roles/aiplatform.user`, and prints a **proxy URL** and **secret** — paste both
into the app under **Manual token / proxy (advanced)**. Details:
[`proxy/README.md`](../proxy/README.md).

---

## Troubleshooting

Tap **error details** in Google's "Access blocked" popup to see the exact code.

| Message | Cause | Fix |
|---|---|---|
| **The OAuth client was not found** / `invalid_client` | The Client ID in the app doesn't exist: old ID from another project, truncated copy, stray space, or a secret/API key pasted instead | Re-copy the Client ID from **Clients** (step 3), clear the field, paste, Save, reload |
| `origin_mismatch` / `redirect_uri_mismatch` | `https://nephlonor.github.io` isn't in **Authorized JavaScript origins**, or was entered with `/NanoBanana` / a trailing slash | Fix the origin (step 3), wait 5–10 min |
| **…has not completed the Google verification process** / `access_denied` | The account you picked isn't a test user | Add it under **Audience → Test users** (step 2) |
| Error appears **before** an account chooser shows | Problem with the client itself (wrong ID, wrong type, origin) — not the test-user list | Check step 3 |
| `Permission 'aiplatform.endpoints.predict' denied … (or it may not exist)` | The signed-in account has no Vertex role on this project, **or** you're signed in with a different account than intended (the app remembers the last account) | Check which account the panel shows; switch account or grant the role (step 4). The Troubleshooter link in the error names the principal that was checked |
| `SERVICE_DISABLED` / API not enabled | Step 1 skipped | Enable the API |
| `429` / quota exceeded | New projects start with low quotas for Veo/image models | **IAM & Admin → Quotas**, request an increase |

If the permission error persists although account and role are correct, the
model may not be served in the selected region for your project (some preview
models are `global`-only). Try a different model or Veo to narrow it down.
