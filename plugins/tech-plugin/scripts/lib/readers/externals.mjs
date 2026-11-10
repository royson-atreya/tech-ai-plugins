// Where each known external service is used in code: file and line numbers
// only. The matched text is never stored, so no key or URL in code can leak
// into the docs. Other third-party hosts found in code are listed by host name
// as candidates. Ported from the atreya plugin's externals.sh, with a general
// list of services; a project adds its own in _map/overrides.yaml.

import { isTestFile, isVendored } from './common.mjs';

export const SYSTEMS = [
  ['Razorpay', /razorpay/i],
  ['Stripe', /\bstripe\b|stripe\.com|@stripe\//i],
  ['PayPal', /paypal/i],
  ['Paytm / PhonePe / Cashfree / CCAvenue', /paytm|phonepe|cashfree|ccavenue/i],
  ['ENACH / e-mandate', /\benach\b|e-nach|e_nach|paynimo|e-?mandate/i],
  ['Firebase', /firebase|kreait|fcm\.googleapis|firebase_messaging|firebase_auth/i],
  ['AWS S3', /s3client|storage::disk\(\s*['"]s3|\.s3\.|s3\.amazonaws|amazons3|@aws-sdk\/client-s3|boto3\.(client|resource)\(\s*['"]s3/i],
  ['AWS (other)', /aws-sdk|@aws-sdk\/|boto3|lambda-url\.|execute-api\.|amazonaws\.com|AwsClient/i],
  ['Twilio', /twilio/i],
  ['WhatsApp (Interakt / Gupshup / Meta)', /interakt|gupshup|graph\.facebook\.com\/v\d+\.\d+\/\d+\/messages|whatsapp/i],
  ['Email (SendGrid / Mailgun / SES / ZeptoMail / Postmark / Mailchimp)', /sendgrid|mailgun|zeptomail|postmark|mailchimp|mandrill|\bses\b|SESClient/i],
  ['SMS gateway', /msg91|textlocal|fast2sms|kaleyra|exotel|smscountry/i],
  ['Google Maps', /maps\.googleapis|google_maps|googlemaps|@googlemaps/i],
  ['Google Sign-In / OAuth', /google_sign_in|accounts\.google\.com|googleapis\.com\/oauth|GoogleAuthProvider/i],
  ['Sentry', /sentry/i],
  ['Pusher / Socket.IO', /pusher|socket\.io|laravel-echo/i],
  ['OneSignal', /onesignal/i],
  ['Agora / Twilio Video / Jitsi / Zoom', /agora|jitsi|zoom\.us|twilio-video/i],
  ['OpenAI', /openai/i],
  ['Anthropic', /anthropic/i],
  ['Zoho', /zoho/i],
  ['Elasticsearch / Algolia', /elasticsearch|algolia/i],
  ['Cloudinary', /cloudinary/i],
  ['Auth0 / Okta / Cognito', /auth0|okta|cognito/i],
  ['Slack', /hooks\.slack\.com|slack\.com\/api|@slack\//i],
];

const LIBRARY_HOSTS = /(w3\.org|schemas\.|xmlsoap|apache\.org|github|githubusercontent|gitlab|bitbucket|packagist|npmjs|yarnpkg|pub\.dev|dart\.dev|flutter\.dev|php\.net|laravel\.com|symfony|getcomposer|jquery|bootstrapcdn|getbootstrap|cloudflare|jsdelivr|unpkg|cdnjs|fonts\.googleapis|fonts\.gstatic|gstatic|example\.|localhost|127\.0|0\.0\.0\.0|purl\.org|creativecommons|mozilla\.org|apple\.com|android\.com|microsoft\.com|opensource\.org|tidelift|opencollective|feross|nette\.org|php-fig|doctrine-project|swagger|openapis|python\.org|djangoproject|fastapi\.tiangolo|pydantic|spring\.io|maven\.apache|gradle\.org|reactjs\.org|react\.dev|nextjs\.org|vuejs\.org|angular\.io|nodejs\.org|stackoverflow|wikipedia|json-schema\.org|ietf\.org|tools\.ietf|googletagmanager|google-analytics|youtube\.com|twitter\.com|x\.com|facebook\.com\/(?!v\d)|linkedin\.com|instagram\.com|placeholder|placehold|picsum|gravatar|fontawesome|typekit|material\.io|schema\.org|xml\.org|xmlns|ogp\.me|tailwindcss|vitejs|webpack|babeljs|eslint|prettier)/i;

const CODE_EXT = /\.(php|dart|js|jsx|ts|tsx|mjs|cjs|vue|svelte|py|go|java|kt|kts|rb|cs|rs|swift|m|scala|yaml|yml|json|xml|gradle|html?)$/i;
const SKIP = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|pubspec\.lock|Podfile\.lock|poetry\.lock|Cargo\.lock|go\.sum)$|(^|\/)(sdlc-docs|graphify-out)\//i;

export function readExternals({ files, src, extra = [], ownHosts = [] }) {
  const systems = [...SYSTEMS, ...extra.map((e) => [e.name, new RegExp(e.pattern, 'i')])];
  const hits = new Map();
  const hosts = new Map();
  const own = ownHosts.map((h) => h.toLowerCase());
  for (const f of files) {
    if (!CODE_EXT.test(f) || SKIP.test(f) || isVendored(f) || isTestFile(f)) continue;
    const s = src(f);
    if (!s) continue;
    const lines = s.text.split('\n');
    lines.forEach((l, i) => {
      if (l.length > 2000) return; // minified or data line
      for (const [name, re] of systems) {
        if (re.test(l)) {
          if (!hits.has(name)) hits.set(name, new Map());
          const m = hits.get(name);
          if (!m.has(f)) m.set(f, []);
          if (m.get(f).length < 50) m.get(f).push(i + 1);
        }
      }
      for (const hm of l.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
        const h = hm[1].toLowerCase();
        if (LIBRARY_HOSTS.test(h) || own.some((o) => h === o || h.endsWith('.' + o))) continue;
        hosts.set(h, (hosts.get(h) || 0) + 1);
      }
    });
  }
  return {
    note: 'file and line numbers only; matched text is never stored',
    systems: [...hits.entries()]
      .map(([system, m]) => ({ system, files: [...m.entries()].map(([file, lines]) => ({ file, lines })).sort((a, b) => a.file.localeCompare(b.file)) }))
      .sort((a, b) => a.system.localeCompare(b.system)),
    otherHosts: [...hosts.entries()].map(([host, count]) => ({ host, count })).sort((a, b) => b.count - a.count || a.host.localeCompare(b.host)).slice(0, 50),
  };
}
