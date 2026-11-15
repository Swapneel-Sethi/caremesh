export const config = Object.freeze({
  port: Number(process.env.PORT || 8080),
  nodeEnv: process.env.NODE_ENV || 'development',
  sessionSecret: process.env.SESSION_SECRET || 'caremesh-dev-only-secret-change-me',
  googleProject: process.env.GOOGLE_CLOUD_PROJECT || '',
  googleLocation: process.env.GOOGLE_CLOUD_LOCATION || 'us-central1',
  geminiModel: process.env.GOOGLE_GEMINI_MODEL || 'gemini-2.5-flash',
  resendApiKey: process.env.RESEND_API_KEY || '',
  mailFrom: process.env.MAIL_FROM || 'CareMesh <onboarding@resend.dev>'
});
