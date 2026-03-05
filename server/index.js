require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const cookieSession = require('cookie-session');
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { google } = require('googleapis');
const NodeCache = require('node-cache');
const path = require('path');

const app = express();
app.set('trust proxy', 1); // trust Vercel/Netlify reverse proxy for secure cookies
const cache = new NodeCache({ stdTTL: 30 });

// cookie-session: stores session in a signed cookie — works in Vercel serverless (no server-side store needed)
app.use(cookieSession({
  name: 'session',
  secret: process.env.SESSION_SECRET || 'secret123',
  maxAge: 24 * 60 * 60 * 1000, // 24 hours
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax'
}));
// passport compat: cookie-session doesn't expose save()/regenerate(), patch it in
app.use((req, res, next) => {
  if (req.session && !req.session.regenerate) req.session.regenerate = (cb) => cb();
  if (req.session && !req.session.save) req.session.save = (cb) => cb();
  next();
});
app.use(passport.initialize());
app.use(passport.session());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: `${process.env.BASE_URL || 'http://localhost:3000'}/auth/google/callback`,
}, (accessToken, refreshToken, profile, done) => {
  done(null, { id: profile.id, name: profile.displayName, email: profile.emails[0].value, photo: profile.photos[0].value, accessToken });
}));
passport.serializeUser((u, done) => done(null, u));
passport.deserializeUser((u, done) => done(null, u));

const requireAuth = (req, res, next) => req.isAuthenticated() ? next() : res.status(401).json({ error: 'Not authenticated' });

// Requires both auth AND a selected property
const requireProperty = (req, res, next) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not authenticated' });
  if (!req.session.propertyId) return res.status(400).json({ error: 'No property selected', needsProperty: true });
  next();
};

function ga(user) {
  const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ access_token: user.accessToken });
  return google.analyticsdata({ version: 'v1beta', auth });
}

function gaAdmin(user) {
  const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ access_token: user.accessToken });
  return google.analyticsadmin({ version: 'v1beta', auth });
}

// Dynamic property from session, fallback to env var for local dev
const PROP = (req) => `properties/${req.session.propertyId || process.env.GA4_PROPERTY_ID}`;
// Cache key scoped to property so users don't see each other's data
const CK = (req, key) => `${req.session.propertyId || 'default'}_${key}`;

// ── Auth Routes ───────────────────────────────────────────
app.get('/auth/google', passport.authenticate('google', {
  scope: ['profile', 'email', 'https://www.googleapis.com/auth/analytics.readonly']
}));
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=1' }),
  (req, res) => res.redirect('/')
);
app.get('/auth/logout', (req, res) => req.logout(() => res.redirect('/')));
app.get('/auth/me', (req, res) => {
  if (!req.isAuthenticated()) return res.json({ loggedIn: false });
  res.json({
    loggedIn: true,
    name: req.user.name,
    email: req.user.email,
    photo: req.user.photo,
    propertyId: req.session.propertyId || null,
    propertyName: req.session.propertyName || null
  });
});

// ── API: List GA4 Properties accessible to logged-in user ─
app.get('/api/properties', requireAuth, async (req, res) => {
  try {
    const admin = gaAdmin(req.user);
    const response = await admin.accountSummaries.list({ pageSize: 200 });
    const properties = [];
    for (const account of (response.data.accountSummaries || [])) {
      for (const prop of (account.propertySummaries || [])) {
        properties.push({
          propertyId: prop.property.replace('properties/', ''),
          displayName: prop.displayName,
          account: account.displayName
        });
      }
    }
    res.json(properties);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: Select a GA4 Property (stores in session) ────────
app.post('/api/select-property', requireAuth, async (req, res) => {
  try {
    const { propertyId, displayName } = req.body;
    if (!propertyId) return res.status(400).json({ error: 'propertyId required' });

    // Validate user actually has access to this property
    const admin = gaAdmin(req.user);
    const response = await admin.accountSummaries.list({ pageSize: 200 });
    const allIds = (response.data.accountSummaries || [])
      .flatMap(a => (a.propertySummaries || []).map(p => p.property.replace('properties/', '')));

    if (!allIds.includes(String(propertyId))) {
      return res.status(403).json({ error: 'Access denied to this property' });
    }

    req.session.propertyId = String(propertyId);
    req.session.propertyName = displayName || propertyId;
    res.json({ ok: true, propertyId: req.session.propertyId, propertyName: req.session.propertyName });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: Realtime Users ───────────────────────────────────
app.get('/api/realtime', requireProperty, async (req, res) => {
  try {
    const k = CK(req, 'rt');
    if (cache.has(k)) return res.json(cache.get(k));
    const a = ga(req.user);

    const now = new Date();
    const startOfMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

    const [rtTotal, rtMinutes, todayStats, monthStats] = await Promise.all([
      a.properties.runRealtimeReport({
        property: PROP(req),
        requestBody: { metrics: [{ name: 'activeUsers' }] }
      }),
      a.properties.runRealtimeReport({
        property: PROP(req),
        requestBody: {
          metrics: [{ name: 'activeUsers' }],
          dimensions: [{ name: 'minutesAgo' }]
        }
      }),
      a.properties.runReport({
        property: PROP(req),
        requestBody: {
          dateRanges: [{ startDate: 'today', endDate: 'today' }],
          metrics: [{ name: 'sessions' }, { name: 'screenPageViews' }]
        }
      }),
      a.properties.runReport({
        property: PROP(req),
        requestBody: {
          dateRanges: [{ startDate: startOfMonth, endDate: 'today' }],
          metrics: [{ name: 'bounceRate' }, { name: 'averageSessionDuration' }]
        }
      })
    ]);

    const active = parseInt(rtTotal.data.rows?.[0]?.metricValues?.[0]?.value || 0);
    const sparkline = Array(30).fill(0);
    (rtMinutes.data.rows || []).forEach(row => {
      const minAgo = parseInt(row.dimensionValues[0].value);
      if (minAgo >= 0 && minAgo < 30) sparkline[29 - minAgo] = parseInt(row.metricValues[0].value || 0);
    });
    const lastMinRow = (rtMinutes.data.rows || []).find(r => r.dimensionValues[0].value === '0');
    const pvPerMin = parseInt(lastMinRow?.metricValues?.[0]?.value || 0);
    const today = todayStats.data.rows?.[0]?.metricValues || [];
    const month = monthStats.data.rows?.[0]?.metricValues || [];
    const totalPv = parseInt(today[1]?.value || 0);
    const mins = Math.max(now.getHours() * 60 + now.getMinutes(), 1);
    const dur = parseInt(month[1]?.value || 0);

    const d = {
      activeUsers: active,
      bounceRate: parseFloat(month[0]?.value || 0).toFixed(1) + '%',
      avgDuration: `${Math.floor(dur / 60)}:${(dur % 60).toString().padStart(2, '0')}`,
      pageviewsPerMin: pvPerMin || Math.round(totalPv / mins),
      newPerMin: Math.round(parseInt(today[0]?.value || 0) / mins),
      sparkline
    };
    cache.set(k, d, 15);
    res.json(d);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: Top 10 News (Realtime — last 30 min pageviews) ───
app.get('/api/top-news', requireProperty, async (req, res) => {
  try {
    const k = CK(req, 'top10');
    if (cache.has(k)) return res.json(cache.get(k));
    const r = await ga(req.user).properties.runRealtimeReport({
      property: PROP(req),
      requestBody: {
        metrics: [{ name: 'screenPageViews' }, { name: 'activeUsers' }],
        dimensions: [{ name: 'unifiedScreenName' }],
        orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
        limit: 50
      }
    });
    const rows = (r.data.rows || [])
      .filter(row => {
        const t = row.dimensionValues[0].value;
        return t && t !== '(other)' && t !== '(not set)' && t.trim() !== '';
      })
      .slice(0, 10)
      .map((row, i) => ({
        rank: i + 1,
        title: row.dimensionValues[0].value,
        pageViews: parseInt(row.metricValues[0].value),
        activeUsers: parseInt(row.metricValues[1].value)
      }));
    cache.set(k, rows, 30);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: Top Categories (7-day pageviews, dynamic) ────────
app.get('/api/categories', requireProperty, async (req, res) => {
  try {
    const k = CK(req, 'categories');
    if (cache.has(k)) return res.json(cache.get(k));
    const r = await ga(req.user).properties.runReport({
      property: PROP(req),
      requestBody: {
        dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
        metrics: [{ name: 'screenPageViews' }],
        dimensions: [{ name: 'pagePath' }],
        orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
        limit: 5000
      }
    });

    // Extract top-level path segment as category, sum views per category
    const catMap = {};
    for (const row of (r.data.rows || [])) {
      const p = row.dimensionValues[0].value;
      const seg = p.split('/').filter(Boolean)[0];
      if (!seg || seg.length < 2) continue;
      // Skip non-category paths
      if (['author', 'reader', 'newsletter', 'page', 'tag', 'search', 'amp'].includes(seg)) continue;
      catMap[seg] = (catMap[seg] || 0) + parseInt(row.metricValues[0].value || 0);
    }

    const categories = Object.entries(catMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([slug, views]) => ({
        slug,
        displayName: slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        views
      }));

    cache.set(k, categories, 300);
    res.json(categories);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: Category News (Last 7 days) ──────────────────────
app.get('/api/category-news/:slug', requireProperty, async (req, res) => {
  try {
    const slug = req.params.slug.toLowerCase();
    const k = CK(req, `cat_${slug}`);
    if (cache.has(k)) return res.json(cache.get(k));
    const r = await ga(req.user).properties.runReport({
      property: PROP(req),
      requestBody: {
        dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
        metrics: [{ name: 'screenPageViews' }],
        dimensions: [{ name: 'pageTitle' }, { name: 'pagePath' }],
        dimensionFilter: {
          filter: { fieldName: 'pagePath', stringFilter: { matchType: 'CONTAINS', value: `/${slug}/` } }
        },
        orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
        limit: 5
      }
    });
    const rows = (r.data.rows || [])
      .filter(row => {
        const t = row.dimensionValues[0].value;
        return t && t !== '(not set)' && t.trim() !== '';
      })
      .map((row, i) => ({
        rank: i + 1,
        title: row.dimensionValues[0].value,
        path: row.dimensionValues[1].value,
        views: parseInt(row.metricValues[0].value)
      }));
    cache.set(k, rows, 300);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: Top Authors (Current Month) ─────────────────────
app.get('/api/top-authors', requireProperty, async (req, res) => {
  try {
    const k = CK(req, 'authors');
    if (cache.has(k)) return res.json(cache.get(k));
    const tryReport = async (dim, metric, startDate) => {
      const r = await ga(req.user).properties.runReport({
        property: PROP(req),
        requestBody: {
          dateRanges: [{ startDate, endDate: 'today' }],
          metrics: [{ name: metric }, { name: 'screenPageViews' }],
          dimensions: [{ name: dim }],
          orderBys: [{ metric: { metricName: metric }, desc: true }],
          limit: 50
        }
      });
      return (r.data.rows || [])
        .filter(row => {
          const n = row.dimensionValues[0].value;
          return n && n !== '(not set)' && n !== '(not provided)' && n !== '(other)' && n.trim() !== '';
        })
        .slice(0, 6)
        .map((row, i) => ({
          rank: i + 1,
          name: row.dimensionValues[0].value,
          views: parseInt(row.metricValues[0].value),
          articles: parseInt(row.metricValues[1].value)
        }));
    };

    const attempts = [
      { dim: 'customEvent:author', metric: 'eventCount',      startDate: '30daysAgo' },
      { dim: 'customEvent:author', metric: 'screenPageViews', startDate: '30daysAgo' },
      { dim: 'customEvent:author', metric: 'eventCount',      startDate: '90daysAgo' },
      { dim: 'customUser:author',  metric: 'screenPageViews', startDate: '30daysAgo' },
      { dim: 'customUser:author',  metric: 'screenPageViews', startDate: '90daysAgo' },
    ];

    let rows = [];
    for (const { dim, metric, startDate } of attempts) {
      try { rows = await tryReport(dim, metric, startDate); } catch (_) { rows = []; }
      if (rows.length) break;
    }
    cache.set(k, rows, 300);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: GA4 Custom Dimensions (diagnostic) ───────────────
app.get('/api/ga4-dims', requireProperty, async (req, res) => {
  try {
    const meta = await ga(req.user).properties.getMetadata({ name: `${PROP(req)}/metadata` });
    const custom = (meta.data.dimensions || [])
      .filter(d => d.apiName && d.apiName.startsWith('custom'))
      .map(d => ({ apiName: d.apiName, uiName: d.uiName, description: d.description }));
    res.json(custom);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Local dev: start the server directly
// Netlify Functions: import this module, listen() is skipped
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`✅ Running at http://localhost:${PORT}`));
}

module.exports = app;
