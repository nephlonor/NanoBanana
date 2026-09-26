# NanoBanana

Single-page PWA (`index.html`, no build step) that generates images and video
through Vertex AI, plus a small Cloud Run OAuth proxy in `proxy/` so Omni can
run on the project's free credits.

## Workflow

- Merge your own pull requests to `main` without asking. Push the branch, open
  the PR, mark it ready, squash-merge. Don't leave work sitting in a draft
  waiting for approval.
- Bump `APP_BUILD` in `index.html` on any user-visible change — it's shown in
  the status line and is how a stale service-worker cache gets spotted.

## Vertex endpoints

Two different location rules apply, and mixing them up is a recurring bug:

- **Image / Veo** — ordinary regional endpoints. The region picker in settings
  drives these; `us-central1` is the default and is valid.
- **Omni (Interactions API)** — `locations/global` on
  `aiplatform.googleapis.com`, pinned via `OMNI_LOCATION`. It ignores the
  region picker on purpose. Regional values (`us-central1`) are rejected
  outright, and the `us`/`eu` multi-region endpoints accept the request but
  don't carry the Omni Flash publisher model. `proxy/index.js` normalizes the
  location the same way.

Omni model IDs differ between the two APIs: the Gemini API's GA ID is
`gemini-omni-1.1-flash`, but Vertex only serves `gemini-omni-1.1-flash-preview`
(global). The old `gemini-omni-flash-preview` is switched off on 2026-09-30;
the app falls back to it only when a project isn't allowed 1.1.

Multi-region endpoints, if ever needed, live on their own host
(`aiplatform.us.rep.googleapis.com`) — the plain host with `locations/us` is
not valid.
