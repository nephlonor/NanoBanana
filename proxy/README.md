# Omni Flash proxy (Cloud Run)

The browser app can't call the Vertex **Interactions API** (Omni Flash) directly:
that endpoint rejects API keys and requires an OAuth2 access token. This tiny
proxy runs on **Cloud Run**, authenticates as a service account, and forwards
the request to Vertex — so Omni runs on your project's **free credits**.

Everything else in the app (image, Veo) keeps calling Vertex directly with the
API key and is unaffected.

## Deploy (one command)

You need the [gcloud CLI](https://cloud.google.com/sdk/docs/install), or use
**Cloud Shell** (https://shell.cloud.google.com — works from an iPhone browser).

```bash
cd proxy

# Pick any random string as the shared secret (you'll paste it into the app too):
SECRET="choose-a-long-random-string"

gcloud run deploy nanobanana-omni-proxy \
  --source . \
  --project fhnw-gemini \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars "VERTEX_PROJECT=fhnw-gemini,PROXY_SECRET=$SECRET"
```

When it finishes it prints a **Service URL** like
`https://nanobanana-omni-proxy-xxxxxxxxxx-uc.a.run.app`.

## Give the proxy permission to call Vertex

The Cloud Run service runs as a service account that needs the **Vertex AI User**
role. The default compute service account usually already has broad access, but
to be explicit:

```bash
# Find the service account the service runs as:
gcloud run services describe nanobanana-omni-proxy \
  --project fhnw-gemini --region us-central1 \
  --format 'value(spec.template.spec.serviceAccountName)'

# Grant it Vertex AI User (replace SA with the value printed above, or the
# default: PROJECT_NUMBER-compute@developer.gserviceaccount.com):
gcloud projects add-iam-policy-binding fhnw-gemini \
  --member "serviceAccount:SA" \
  --role roles/aiplatform.user
```

## Wire it into the app

In the app's API-key panel, fill in:

- **Omni proxy URL** → the Service URL from the deploy step
- **Omni proxy secret** → the same `SECRET` string you chose above

Save. Now switch to **VIDEO → OMNI** and generate — it routes through the proxy
and bills your free credits. (Without a proxy URL set, Omni falls back to the
Gemini Developer API, which works but bills paid credits.)

## Notes

- **Security:** the proxy is public (`--allow-unauthenticated`) but gated by the
  shared secret. The secret lives in your browser and in requests, so treat the
  URL+secret as semi-private — anyone with both could spend your credits. Rotate
  by redeploying with a new `PROXY_SECRET`.
- **Timeout:** Cloud Run's default request timeout is 300s, comfortably longer
  than an Omni render. Raise it with `--timeout=600` if you ever need to.
- **Cost:** Cloud Run's free tier covers occasional personal use; the proxy is
  idle (scales to zero) when unused.
