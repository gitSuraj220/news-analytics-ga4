require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const { BetaAnalyticsDataClient } = require('@google-analytics/data');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'newsanalytics_secret_key',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// ── Google OAuth2 Setup ──────────────────────────────────────────
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  `http://localhost:${process.env.PORT || 3000}/auth/callback`
);

const SCOPES = [
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
];

// ── Auth Middleware ──────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session.tokens) {
    oauth2Client.setCredentials(req.session.tokens);
    return next();
  }
  res.status(401).json({ error: 'Not authenticated', loginUrl: '/auth/login' });
}

function getAnalyticsClient(tokens) {
  const authClient = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  authClient.setCredentials(tokens);
  return new BetaAnalyticsDataClient({ authClient });
}

// ── Auth Routes ──────────────────────────────────────────────────
app.get('/auth/login', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken(code);
    req.session.tokens = tokens;

    // Get user info
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data } = await oauth2.userinfo.get();
    req.session.user = { name: data.name, email: data.email, picture: data.picture };

    res.redirect('/dashboard.html');
  } catch (err) {
    console.error('Auth error:', err);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

app.get('/auth/me', (req, res) => {
  if (req.session.user) return res.json({ loggedIn: true, user: req.session.user });
  res.json({ loggedIn: false });
});

// ── GA4 API Helper ───────────────────────────────────────────────
const PROPERTY_ID = process.env.GA4_PROPERTY_ID;

async function runReport(tokens, params) {
  const analyticsClient = getAnalyticsClient(tokens);
  const [response] = await analyticsClient.runReport({
    property: `properties/${PROPERTY_ID}`,
    ...params
  });
  return response;
}

async function runRealtimeReport(tokens, params) {
  const analyticsClient = getAnalyticsClient(tokens);
  const [response] = await analyticsClient.runRealtimeReport({
    property: `properties/${PROPERTY_ID}`,
    ...params
  });
  return response;
}

// ── API: Realtime Active Users ───────────────────────────────────
app.get('/api/realtime', requireAuth, async (req, res) => {
  try {
    const response = await runRealtimeReport(req.session.tokens, {
      dimensions: [{ name: 'country' }],
      metrics: [{ name: 'activeUsers' }]
    });

    let totalUsers = 0;
    if (response.rows) {
      response.rows.forEach(row => {
        totalUsers += parseInt(row.metricValues[0].value || 0);
      });
    }

    // Also get page views per minute
    const pvResponse = await runRealtimeReport(req.session.tokens, {
      dimensions: [{ name: 'minutesAgo' }],
      metrics: [{ name: 'activeUsers' }, { name: 'screenPageViews' }]
    });

    let pagesPerMin = 0, usersPerMin = 0;
    if (pvResponse.rows && pvResponse.rows.length > 0) {
      const latestRow = pvResponse.rows.find(r => r.dimensionValues[0].value === '0');
      if (latestRow) {
        usersPerMin = parseInt(latestRow.metricValues[0].value || 0);
        pagesPerMin = parseInt(latestRow.metricValues[1].value || 0);
      }
    }

    res.json({ totalUsers, usersPerMin, pagesPerMin, timestamp: Date.now() });
  } catch (err) {
    console.error('Realtime error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Top 10 News (Realtime) ──────────────────────────────────
app.get('/api/top-news', requireAuth, async (req, res) => {
  try {
    const response = await runRealtimeReport(req.session.tokens, {
      dimensions: [
        { name: 'pageTitle' },
        { name: 'pagePath' },
        { name: 'pageReferrer' }
      ],
      metrics: [
        { name: 'activeUsers' },
        { name: 'screenPageViews' }
      ],
      limit: 10
    });

    const news = (response.rows || []).map((row, i) => ({
      rank: i + 1,
      title: row.dimensionValues[0].value || 'Untitled',
      path: row.dimensionValues[1].value || '/',
      activeUsers: parseInt(row.metricValues[0].value || 0),
      pageViews: parseInt(row.metricValues[1].value || 0)
    }));

    res.json({ news });
  } catch (err) {
    console.error('Top news error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── API: State-wise News (Last 7 Days) ───────────────────────────
app.get('/api/state-news', requireAuth, async (req, res) => {
  try {
    const { state } = req.query; // mp, cg, rj

    const stateFilters = {
      mp: 'Madhya Pradesh',
      cg: 'Chhattisgarh',
      rj: 'Rajasthan'
    };

    const regionName = stateFilters[state];
    if (!regionName) return res.status(400).json({ error: 'Invalid state' });

    const response = await runReport(req.session.tokens, {
      dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
      dimensions: [
        { name: 'pageTitle' },
        { name: 'pagePath' },
        { name: 'region' }
      ],
      metrics: [
        { name: 'screenPageViews' },
        { name: 'activeUsers' }
      ],
      dimensionFilter: {
        filter: {
          fieldName: 'region',
          stringFilter: {
            matchType: 'CONTAINS',
            value: regionName,
            caseSensitive: false
          }
        }
      },
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      limit: 5
    });

    const news = (response.rows || []).map((row, i) => ({
      rank: i + 1,
      title: row.dimensionValues[0].value || 'Untitled',
      path: row.dimensionValues[1].value || '/',
      views: parseInt(row.metricValues[0].value || 0),
      users: parseInt(row.metricValues[1].value || 0)
    }));

    res.json({ state, region: regionName, news });
  } catch (err) {
    console.error('State news error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Top Authors (Current Month) ────────────────────────────
// This requires a custom dimension 'author' set up in GA4
// Dimension name: customEvent:author OR customUser:author
app.get('/api/top-authors', requireAuth, async (req, res) => {
  try {
    const now = new Date();
    const startOfMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

    const response = await runReport(req.session.tokens, {
      dateRanges: [{ startDate: startOfMonth, endDate: 'today' }],
      dimensions: [
        { name: 'customEvent:author' }  // Your GA4 custom dimension for author
      ],
      metrics: [
        { name: 'screenPageViews' },
        { name: 'activeUsers' },
        { name: 'sessions' }
      ],
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      limit: 6
    });

    const authors = (response.rows || []).map((row, i) => ({
      rank: i + 1,
      name: row.dimensionValues[0].value || 'Unknown Author',
      views: parseInt(row.metricValues[0].value || 0),
      users: parseInt(row.metricValues[1].value || 0),
      sessions: parseInt(row.metricValues[2].value || 0)
    }));

    const maxViews = authors[0]?.views || 1;
    authors.forEach(a => { a.pct = Math.round((a.views / maxViews) * 100); });

    res.json({ authors, month: startOfMonth });
  } catch (err) {
    console.error('Authors error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Bounce Rate & Session Duration (for realtime stats) ─────
app.get('/api/session-stats', requireAuth, async (req, res) => {
  try {
    const response = await runReport(req.session.tokens, {
      dateRanges: [{ startDate: 'today', endDate: 'today' }],
      metrics: [
        { name: 'bounceRate' },
        { name: 'averageSessionDuration' }
      ]
    });

    const row = response.rows?.[0];
    const bounceRate = row ? parseFloat(row.metricValues[0].value || 0) : 0;
    const avgDuration = row ? parseFloat(row.metricValues[1].value || 0) : 0;
    const mins = Math.floor(avgDuration / 60);
    const secs = Math.floor(avgDuration % 60);

    res.json({
      bounceRate: (bounceRate * 100).toFixed(1) + '%',
      avgDuration: `${mins}:${String(secs).padStart(2, '0')}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start Server ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 NewsAnalytics server running at http://localhost:${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}/dashboard.html`);
  console.log(`🔐 Login: http://localhost:${PORT}/auth/login\n`);
});
