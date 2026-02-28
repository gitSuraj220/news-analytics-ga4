# NewsAnalytics GA4 Dashboard — Setup Guide

## Step 1 — Get Google OAuth Credentials
1. Go to https://console.cloud.google.com/
2. Create a new project (or select existing)
3. Go to "APIs & Services" → "Enable APIs"
4. Enable: **Google Analytics Data API**
5. Go to "APIs & Services" → "Credentials"
6. Click "Create Credentials" → "OAuth 2.0 Client IDs"
7. Application type: **Web application**
8. Add Authorized redirect URI: `http://localhost:3000/auth/google/callback`
9. Copy **Client ID** and **Client Secret**

## Step 2 — Get GA4 Property ID
1. Go to https://analytics.google.com/
2. Click Admin (bottom left gear icon)
3. Under "Property" column → "Property Settings"
4. Copy the **Property ID** (numbers only, e.g. 123456789)

## Step 3 — Setup Project
```bash
# Clone/download this folder, then:
cd news-analytics-dashboard
npm install

# Create .env file
cp .env.example .env

# Fill in your values in .env:
# GOOGLE_CLIENT_ID=...
# GOOGLE_CLIENT_SECRET=...
# GA4_PROPERTY_ID=...
# SESSION_SECRET=anyrandomstring123456
```

## Step 4 — Run
```bash
npm start
# Open http://localhost:3000
# Click "Sign in with Google"
# Authorize GA4 access → Dashboard loads!
```

## Step 5 — State News Setup
For MP/CG/RJ columns to work, your news URLs must follow this pattern:
- Madhya Pradesh: `yoursite.com/mp/article-slug`
- Chhattisgarh: `yoursite.com/cg/article-slug`
- Rajasthan: `yoursite.com/rj/article-slug`

## Step 6 — Author Tracking (Optional)
To show Top Authors, set up a GA4 custom event:
Add this to your website's article pages:
```javascript
gtag('event', 'page_view', {
  author: 'Author Name Here'
});
```
Then create a GA4 Custom Dimension named `author` mapped to this event parameter.

## Deploy to a Server (Optional)
- Upload the entire folder to your VPS/cPanel
- Run `npm install && npm start`
- Update `BASE_URL` and redirect URI to your domain
- Use nginx/pm2 for production
