# Deployment Notes

## Local

```bash
npm start
curl http://localhost:8080/api/health
```

## Cloud Run from source

1. Set the active Google Cloud project.
2. Enable Cloud Run, Artifact Registry, Firestore, and Vertex AI / Generative AI services as required by the project.
3. Give the Cloud Run runtime service account permissions for Firestore and Vertex AI access.
4. Deploy from the repository root:

```bash
gcloud run deploy caremesh \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars NODE_ENV=production,GOOGLE_CLOUD_PROJECT=$GOOGLE_CLOUD_PROJECT,GOOGLE_CLOUD_LOCATION=us-central1,GOOGLE_GEMINI_MODEL=gemini-2.5-flash,SESSION_SECRET=$SESSION_SECRET
```

5. If email is configured through Resend, add `RESEND_API_KEY` and `MAIL_FROM` as secrets or environment variables. Do not commit them.
6. Verify the returned service URL and `/api/health` before submission.

Cloud Run requires the process to listen on the `PORT` environment variable and bind to `0.0.0.0`; `server.mjs` already follows that contract.
