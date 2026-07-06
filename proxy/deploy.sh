#!/usr/bin/env bash
# One-shot deploy for the Omni Flash proxy. Run from inside proxy/:
#   bash deploy.sh
set -e

PROJECT=fhnw-gemini
REGION=us-central1
SERVICE=nanobanana-omni-proxy

echo "▶ Setting project to $PROJECT…"
gcloud config set project "$PROJECT" -q

echo "▶ Enabling required APIs (can take a minute)…"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  aiplatform.googleapis.com -q

SECRET=$(openssl rand -hex 24)

echo "▶ Deploying to Cloud Run (this builds a container — a few minutes)…"
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --set-env-vars "VERTEX_PROJECT=$PROJECT,PROXY_SECRET=$SECRET" \
  -q

echo "▶ Granting the proxy permission to call Vertex…"
SA=$(gcloud run services describe "$SERVICE" --region "$REGION" \
      --format 'value(spec.template.spec.serviceAccountName)')
if [ -z "$SA" ]; then
  SA="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')-compute@developer.gserviceaccount.com"
fi
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member "serviceAccount:$SA" \
  --role roles/aiplatform.user -q >/dev/null

URL=$(gcloud run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)')

echo ""
echo "======================================================"
echo " Paste these two into the app's key panel, then Save:"
echo ""
echo "   PROXY URL    ->  $URL"
echo "   PROXY SECRET ->  $SECRET"
echo ""
echo "======================================================"
