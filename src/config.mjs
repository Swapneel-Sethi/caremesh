function list(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

export const config = Object.freeze({
  port: Number(process.env.PORT || 8080),
  nodeEnv: process.env.NODE_ENV || 'development',
  appOrigin: process.env.APP_ORIGIN || 'https://caremesh-one.vercel.app',
  vercelOrigin: process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '',
  sessionSecret: process.env.SESSION_SECRET || 'caremesh-dev-only-secret-change-me',
  googleProject: process.env.GOOGLE_CLOUD_PROJECT || '',
  googleLocation: process.env.GOOGLE_CLOUD_LOCATION || 'us-central1',
  geminiModel: process.env.GOOGLE_GEMINI_MODEL || 'gemini-2.5-flash',
  resendApiKey: process.env.RESEND_API_KEY || '',
  mailFrom: process.env.MAIL_FROM || 'CareMesh <onboarding@resend.dev>',
  careTeamAlertEmails: list(process.env.CARE_TEAM_ALERT_EMAILS),
  cronSecret: process.env.CRON_SECRET || '',
  reminderTimeZone: process.env.CARE_TIME_ZONE || 'Asia/Kolkata',
  voiceEnabled: process.env.CARE_VOICE_ENABLED === 'true',
  voiceProvider: process.env.CARE_VOICE_PROVIDER || 'twilio',
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || '',
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || '',
  twilioFromNumber: process.env.TWILIO_FROM_NUMBER || '',
  voicePhone: process.env.CARE_VOICE_PHONE || '',
  voicePublicOrigin: process.env.CARE_VOICE_PUBLIC_ORIGIN || '',
  voiceLanguage: process.env.CARE_VOICE_LANGUAGE || 'en-IN',
  voiceMaxAttempts: Number(process.env.CARE_VOICE_MAX_ATTEMPTS || 2),
  voiceAutoEscalate: process.env.CARE_VOICE_AUTO_ESCALATE !== 'false'
});
