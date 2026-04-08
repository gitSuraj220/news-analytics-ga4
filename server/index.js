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

// Returns true only for article URLs (have a numeric ID in path)
const isArticlePath = p => /(-\d{5,}|\/n\d{5,})/.test(p);

// Normalize a path: strip query string, fragment, and trailing slash
const normPath = p => p.split('?')[0].split('#')[0].replace(/\/+$/, '') || '/';

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

// ── Static page clean URLs ─────────────────────────────────
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, '../public/privacy.html')));
app.get('/terms',   (req, res) => res.sendFile(path.join(__dirname, '../public/terms.html')));
app.get('/dashboard', (req, res) => res.redirect('/dashboard.html'));

// ── Auth Routes ───────────────────────────────────────────
app.get('/auth/google', passport.authenticate('google', {
  scope: ['profile', 'email', 'https://www.googleapis.com/auth/analytics.readonly']
}));
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=1' }),
  (req, res) => res.redirect('/dashboard.html')
);
app.get('/auth/logout', (req, res) => req.logout(() => {
  req.session = null; // wipe entire cookie-session so propertyId doesn't persist on next login
  res.redirect('/');
}));
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

    const [rtTotal, rtMinutes, todayStats] = await Promise.all([
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
          metrics: [{ name: 'screenPageViews' }]
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
    const totalPv = parseInt(todayStats.data.rows?.[0]?.metricValues?.[0]?.value || 0);
    const mins = Math.max(now.getHours() * 60 + now.getMinutes(), 1);

    const d = {
      activeUsers: active,
      pageviewsPerMin: pvPerMin || Math.round(totalPv / mins),
      sparkline
    };
    cache.set(k, d, 15);
    res.json(d);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: Top 10 News (multi-range) ────────────────────────
app.get('/api/top-news', requireProperty, async (req, res) => {
  try {
    const range = req.query.range || 'realtime';
    const cacheKey = range === 'custom'
      ? CK(req, `top10_custom_${req.query.start}_${req.query.end}`)
      : CK(req, `top10_${range}`);
    if (cache.has(cacheKey)) return res.json(cache.get(cacheKey));

    let rows = [];

    if (range === 'realtime') {
      const r = await ga(req.user).properties.runRealtimeReport({
        property: PROP(req),
        requestBody: {
          metrics: [{ name: 'screenPageViews' }, { name: 'activeUsers' }],
          dimensions: [{ name: 'unifiedScreenName' }],
          orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
          limit: 50
        }
      });
      rows = (r.data.rows || [])
        .filter(row => {
          const t = row.dimensionValues[0].value;
          return t && t !== '(other)' && t !== '(not set)' && t.trim() !== '';
        })
        .slice(0, 10)
        .map((row, i) => ({
          rank: i + 1, title: row.dimensionValues[0].value,
          pageViews: parseInt(row.metricValues[0].value),
          activeUsers: parseInt(row.metricValues[1].value)
        }));
      cache.set(cacheKey, rows, 30);
    } else {
      const now = new Date();
      let startDate, endDate = 'today';
      if (range === 'today')       startDate = 'today';
      else if (range === '7days')  startDate = '7daysAgo';
      else if (range === '30days') startDate = '30daysAgo';
      else if (range === 'month')  startDate = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
      else if (range === 'custom') {
        startDate = req.query.start; endDate = req.query.end || 'today';
        if (!startDate) return res.status(400).json({ error: 'start required' });
      }
      const r = await ga(req.user).properties.runReport({
        property: PROP(req),
        requestBody: {
          dateRanges: [{ startDate, endDate }],
          metrics: [{ name: 'screenPageViews' }],
          dimensions: [{ name: 'pageTitle' }, { name: 'pagePath' }],
          orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
          limit: 15
        }
      });
      rows = (r.data.rows || [])
        .filter(row => {
          const t = row.dimensionValues[0].value;
          return t && t !== '(not set)' && t.trim() !== '';
        })
        .slice(0, 10)
        .map((row, i) => ({
          rank: i + 1, title: row.dimensionValues[0].value,
          path: row.dimensionValues[1].value,
          pageViews: parseInt(row.metricValues[0].value),
          activeUsers: null
        }));
      cache.set(cacheKey, rows, 300);
    }
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: Bottom 10 Stories (published within selected range) ──
app.get('/api/bottom-news', requireProperty, async (req, res) => {
  try {
    const range = req.query.range || '7days';
    const k = CK(req, `bottom10_${range}`);
    if (cache.has(k)) return res.json(cache.get(k));

    const now = new Date();
    let startDate = '7daysAgo', endDate = 'today';
    if (range === 'today')       startDate = 'today';
    else if (range === '7days')  startDate = '7daysAgo';
    else if (range === '30days') startDate = '30daysAgo';
    else if (range === 'month')  startDate = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;

    const toAbsDate = (s) => {
      if (s === 'today') return new Date(now);
      if (/^\d+daysAgo$/.test(s)) { const d = new Date(now); d.setDate(d.getDate() - parseInt(s)); return d; }
      return new Date(s + 'T00:00:00Z');
    };


    const runBottom = async () => {
      // Call 1a: Which article paths existed BEFORE the selected range?
      // Using a long lookback (730 days) without the date dimension keeps rows to one-per-path,
      // so 50 000 rows covers ~50 000 unique articles — enough for any news site.
      // Articles found here are "old" and must be excluded from Bottom 10.
      const rangeStartDate = toAbsDate(startDate);
      const dayBefore = new Date(rangeStartDate);
      dayBefore.setDate(dayBefore.getDate() - 1);
      const preRangeEnd = dayBefore.toISOString().slice(0, 10);

      const r1a = await ga(req.user).properties.runReport({
        property: PROP(req),
        requestBody: {
          dateRanges: [{ startDate: '730daysAgo', endDate: preRangeEnd }],
          metrics: [{ name: 'screenPageViews' }],
          dimensions: [{ name: 'pagePath' }],
          limit: 250000  // GA4 API maximum — covers up to 250k unique article paths
        }
      });
      const preExistingPaths = new Set();
      for (const row of (r1a.data.rows || [])) {
        const p = normPath(row.dimensionValues[0].value);
        if (isArticlePath(p)) preExistingPaths.add(p);
      }

      // Call 1b: First appearance date within the selected range (used as display publish date).
      // Only articles NOT in preExistingPaths are truly new.
      const r1b = await ga(req.user).properties.runReport({
        property: PROP(req),
        requestBody: {
          dateRanges: [{ startDate, endDate }],
          metrics: [{ name: 'screenPageViews' }],
          dimensions: [{ name: 'date' }, { name: 'pagePath' }],
          limit: 50000
        }
      });
      const firstSeen = new Map();
      for (const row of (r1b.data.rows || [])) {
        const date = row.dimensionValues[0].value;  // YYYYMMDD
        const path = normPath(row.dimensionValues[1].value);
        if (!isArticlePath(path)) continue;
        if (!firstSeen.has(path) || date < firstSeen.get(path)) firstSeen.set(path, date);
      }
      // Newly published = appeared in the selected range AND not seen in the 730-day pre-range window
      const newPaths = new Set(
        [...firstSeen.keys()].filter(p => !preExistingPaths.has(p))
      );

      // Call 2: Get ACCURATE view counts for the selected range (no date dimension = exact totals)
      // Use high limit to ensure we capture all title×path variants for new articles
      const r2 = await ga(req.user).properties.runReport({
        property: PROP(req),
        requestBody: {
          dateRanges: [{ startDate, endDate }],
          metrics: [{ name: 'screenPageViews' }],
          dimensions: [{ name: 'pageTitle' }, { name: 'pagePath' }],
          limit: 50000
        }
      });

      // Deduplicate by normalized path: GA4 may return multiple rows for the same article with
      // slightly different titles (whitespace variants) or path variants (query params, trailing
      // slashes). Sum views and keep the title with most views.
      const pathMap = new Map();
      for (const row of (r2.data.rows || [])) {
        const t = row.dimensionValues[0].value;
        const p = normPath(row.dimensionValues[1].value);
        if (!t || t === '(not set)' || t.trim() === '' || !newPaths.has(p)) continue;
        const views = parseInt(row.metricValues[0].value);
        if (pathMap.has(p)) {
          const entry = pathMap.get(p);
          entry.pageViews += views;
          if (views > entry.topViews) { entry.topViews = views; entry.title = t; }
        } else {
          pathMap.set(p, { title: t, path: p, pageViews: views, topViews: views });
        }
      }

      // Second pass: deduplicate by normalized title to merge same article at different paths
      const normTitle = t => t.normalize('NFC').trim().replace(/\s+/g, ' ');
      const titleMap = new Map();
      for (const entry of pathMap.values()) {
        const key = normTitle(entry.title);
        const entryDate = firstSeen.get(entry.path) || '';
        if (titleMap.has(key)) {
          const ex = titleMap.get(key);
          ex.pageViews += entry.pageViews;
          if (entry.pageViews > ex.topViews) {
            ex.topViews = entry.pageViews;
            ex.path = entry.path;
            ex.title = entry.title;
          }
          // Keep the earliest first-seen date across all merged paths
          if (entryDate && (!ex.firstSeen || entryDate < ex.firstSeen)) {
            ex.firstSeen = entryDate;
          }
        } else {
          titleMap.set(key, { ...entry, firstSeen: entryDate });
        }
      }

      return [...titleMap.values()]
        .sort((a, b) => a.pageViews - b.pageViews)
        .slice(0, 10)
        .map((entry, i) => {
          const d = entry.firstSeen || '';
          const publishDate = d ? `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}` : '';
          return {
            rank: i + 1,
            title: entry.title,
            path: entry.path,
            pageViews: entry.pageViews,
            publishDate
          };
        });
    };

    const rows = await runBottom();

    cache.set(k, rows, 300);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: Top Categories (dynamic range) ───────────────────
app.get('/api/categories', requireProperty, async (req, res) => {
  try {
    const range = req.query.range || '7days';
    const cacheKey = range === 'custom'
      ? CK(req, `categories_custom_${req.query.start}_${req.query.end}`)
      : CK(req, `categories_${range}`);
    if (cache.has(cacheKey)) return res.json(cache.get(cacheKey));
    const now = new Date();
    let startDate = '7daysAgo', endDate = 'today';
    if (range === 'today')       startDate = 'today';
    else if (range === '7days')  startDate = '7daysAgo';
    else if (range === '30days') startDate = '30daysAgo';
    else if (range === 'month')  startDate = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
    else if (range === 'custom') {
      startDate = req.query.start; endDate = req.query.end || 'today';
      if (!startDate) return res.status(400).json({ error: 'start required' });
    }
    const r = await ga(req.user).properties.runReport({
      property: PROP(req),
      requestBody: {
        dateRanges: [{ startDate, endDate }],
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

    cache.set(cacheKey, categories, 300);
    res.json(categories);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: Category News (dynamic range) ────────────────────
app.get('/api/category-news/:slug', requireProperty, async (req, res) => {
  try {
    const slug = req.params.slug.toLowerCase();
    const range = req.query.range || '7days';
    const cacheKey = range === 'custom'
      ? CK(req, `cat_${slug}_custom_${req.query.start}_${req.query.end}`)
      : CK(req, `cat_${slug}_${range}`);
    if (cache.has(cacheKey)) return res.json(cache.get(cacheKey));
    const now = new Date();
    let startDate = '7daysAgo', endDate = 'today';
    if (range === 'today')       startDate = 'today';
    else if (range === '7days')  startDate = '7daysAgo';
    else if (range === '30days') startDate = '30daysAgo';
    else if (range === 'month')  startDate = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
    else if (range === 'custom') {
      startDate = req.query.start; endDate = req.query.end || 'today';
      if (!startDate) return res.status(400).json({ error: 'start required' });
    }
    const r = await ga(req.user).properties.runReport({
      property: PROP(req),
      requestBody: {
        dateRanges: [{ startDate, endDate }],
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
    cache.set(cacheKey, rows, 300);
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

// ── API: Banner Stats (bounce rate, unique visitors, avg engagement) ────
app.get('/api/banner-stats', requireProperty, async (req, res) => {
  try {
    const range = req.query.range || '7days';
    const k = CK(req, `banner_${range}`);
    if (cache.has(k)) return res.json(cache.get(k));
    const now = new Date();
    let startDate = '7daysAgo', endDate = 'today';
    if (range === 'today')       startDate = 'today';
    else if (range === '7days')  startDate = '7daysAgo';
    else if (range === '30days') startDate = '30daysAgo';
    else if (range === 'month')  startDate = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
    const r = await ga(req.user).properties.runReport({
      property: PROP(req),
      requestBody: {
        dateRanges: [{ startDate, endDate }],
        metrics: [
          { name: 'bounceRate' },
          { name: 'newUsers' },
          { name: 'userEngagementDuration' },
          { name: 'sessions' }
        ]
      }
    });
    const mv = r.data.rows?.[0]?.metricValues || [];
    const totalEngagement = parseFloat(mv[2]?.value || 0);
    const sessions = parseInt(mv[3]?.value || 1) || 1;
    const dur = totalEngagement / sessions;
    const d = {
      bounceRate: (parseFloat(mv[0]?.value || 0) * 100).toFixed(1) + '%',
      uniqueVisitors: parseInt(mv[1]?.value || 0),
      avgEngagementTime: `${Math.floor(dur / 60)}:${Math.round(dur % 60).toString().padStart(2, '0')}`
    };
    cache.set(k, d, 120);
    res.json(d);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: Geo Traffic (city + country breakdown) ────────────
app.get('/api/geo-traffic', requireProperty, async (req, res) => {
  try {
    const range = req.query.range || '7days';
    const k = range === 'custom'
      ? CK(req, `geo_custom_${req.query.start}_${req.query.end}`)
      : CK(req, `geo_${range}`);
    if (cache.has(k)) return res.json(cache.get(k));
    const now = new Date();
    let startDate = '7daysAgo', endDate = 'today';
    if (range === 'today')       startDate = 'today';
    else if (range === '7days')  startDate = '7daysAgo';
    else if (range === '30days') startDate = '30daysAgo';
    else if (range === 'month')  startDate = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
    else if (range === 'custom') {
      startDate = req.query.start; endDate = req.query.end || 'today';
      if (!startDate) return res.status(400).json({ error: 'start required' });
    }
    const r = await ga(req.user).properties.runReport({
      property: PROP(req),
      requestBody: {
        dateRanges: [{ startDate, endDate }],
        metrics: [{ name: 'totalUsers' }],
        dimensions: [{ name: 'city' }, { name: 'country' }],
        orderBys: [{ metric: { metricName: 'totalUsers' }, desc: true }],
        limit: 250
      }
    });
    const rows = (r.data.rows || [])
      .filter(row => { const c = row.dimensionValues[0].value; return c && c !== '(not set)'; })
      .map(row => ({
        city: row.dimensionValues[0].value,
        country: row.dimensionValues[1].value,
        visitors: parseInt(row.metricValues[0].value)
      }));
    cache.set(k, rows, 300);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: Traffic Source Breakdown ─────────────────────────
app.get('/api/traffic-sources', requireProperty, async (req, res) => {
  try {
    const range = req.query.range || '7days';
    const k = CK(req, `traffic_src_${range}`);
    if (cache.has(k)) return res.json(cache.get(k));
    const now = new Date();
    let startDate = '7daysAgo', endDate = 'today';
    if (range === 'today')       startDate = 'today';
    else if (range === '7days')  startDate = '7daysAgo';
    else if (range === '30days') startDate = '30daysAgo';
    else if (range === 'month')  startDate = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;

    const r = await ga(req.user).properties.runReport({
      property: PROP(req),
      requestBody: {
        dateRanges: [{ startDate, endDate }],
        metrics: [{ name: 'sessions' }, { name: 'screenPageViews' }, { name: 'totalUsers' }],
        dimensions: [{ name: 'sessionDefaultChannelGroup' }],
        orderBys: [{ metric: { metricName: 'totalUsers' }, desc: true }]
      }
    });

    const rows = (r.data.rows || [])
      .filter(row => {
        const ch = row.dimensionValues[0].value;
        return ch && ch !== '(not set)' && ch !== '(other)';
      })
      .map(row => ({
        channel: row.dimensionValues[0].value,
        sessions: parseInt(row.metricValues[0].value || 0),
        pageViews: parseInt(row.metricValues[1].value || 0),
        users: parseInt(row.metricValues[2].value || 0)
      }));

    const totalUsers = rows.reduce((s, r) => s + r.users, 0) || 1;
    const result = rows.map(r => ({ ...r, pct: parseFloat(((r.users / totalUsers) * 100).toFixed(1)) }));
    cache.set(k, result, 300);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: Best Publishing Time (hour + day heatmap) ─────────
app.get('/api/publishing-time', requireProperty, async (req, res) => {
  try {
    const range = req.query.range || '30days';
    const k = CK(req, `pub_time_${range}`);
    if (cache.has(k)) return res.json(cache.get(k));
    const now = new Date();
    let startDate = '30daysAgo', endDate = 'today';
    if (range === '7days')   startDate = '7daysAgo';
    else if (range === '30days') startDate = '30daysAgo';
    else if (range === '90days') startDate = '90daysAgo';
    else if (range === 'month')  startDate = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;

    const [byHour, byDay] = await Promise.all([
      ga(req.user).properties.runReport({
        property: PROP(req),
        requestBody: {
          dateRanges: [{ startDate, endDate }],
          metrics: [{ name: 'screenPageViews' }, { name: 'sessions' }],
          dimensions: [{ name: 'hour' }],
          orderBys: [{ dimension: { dimensionName: 'hour' } }]
        }
      }),
      ga(req.user).properties.runReport({
        property: PROP(req),
        requestBody: {
          dateRanges: [{ startDate, endDate }],
          metrics: [{ name: 'screenPageViews' }, { name: 'sessions' }],
          dimensions: [{ name: 'dayOfWeek' }],
          orderBys: [{ dimension: { dimensionName: 'dayOfWeek' } }]
        }
      })
    ]);

    // hour: 0-23 array
    const hours = Array(24).fill(null).map((_, i) => ({ hour: i, pageViews: 0, sessions: 0 }));
    (byHour.data.rows || []).forEach(row => {
      const h = parseInt(row.dimensionValues[0].value);
      if (h >= 0 && h < 24) {
        hours[h].pageViews = parseInt(row.metricValues[0].value || 0);
        hours[h].sessions = parseInt(row.metricValues[1].value || 0);
      }
    });

    // dayOfWeek: GA4 returns 0=Sun,1=Mon,...,6=Sat
    const days = Array(7).fill(null).map((_, i) => ({ day: i, pageViews: 0, sessions: 0 }));
    const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    (byDay.data.rows || []).forEach(row => {
      const d = parseInt(row.dimensionValues[0].value);
      if (d >= 0 && d < 7) {
        days[d].pageViews = parseInt(row.metricValues[0].value || 0);
        days[d].sessions = parseInt(row.metricValues[1].value || 0);
        days[d].dayName = dayNames[d];
      }
    });
    days.forEach(d => { if (!d.dayName) d.dayName = dayNames[d.day]; });

    const result = { hours, days };
    cache.set(k, result, 600);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: Content Gap Analysis ──────────────────────────────
app.get('/api/content-gap', requireProperty, async (req, res) => {
  try {
    const range = req.query.range || '30days';
    const k = CK(req, `content_gap_${range}`);
    if (cache.has(k)) return res.json(cache.get(k));
    const now = new Date();
    let startDate = '30daysAgo', endDate = 'today';
    if (range === '7days')   startDate = '7daysAgo';
    else if (range === '30days') startDate = '30daysAgo';
    else if (range === '90days') startDate = '90daysAgo';
    else if (range === 'month')  startDate = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;

    const r = await ga(req.user).properties.runReport({
      property: PROP(req),
      requestBody: {
        dateRanges: [{ startDate, endDate }],
        metrics: [
          { name: 'screenPageViews' },
          { name: 'sessions' },
          { name: 'bounceRate' },
          { name: 'averageSessionDuration' }
        ],
        dimensions: [{ name: 'pagePath' }],
        orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
        limit: 5000
      }
    });

    // Aggregate by top-level category slug
    const skipSegs = ['author','reader','newsletter','page','tag','search','amp'];
    const catMap = {};
    for (const row of (r.data.rows || [])) {
      const p = row.dimensionValues[0].value;
      const seg = p.split('/').filter(Boolean)[0];
      if (!seg || seg.length < 2 || skipSegs.includes(seg)) continue;
      if (!catMap[seg]) catMap[seg] = { pageViews: 0, sessions: 0, bounceRateSum: 0, durationSum: 0, articleCount: 0 };
      catMap[seg].pageViews += parseInt(row.metricValues[0].value || 0);
      catMap[seg].sessions += parseInt(row.metricValues[1].value || 0);
      catMap[seg].bounceRateSum += parseFloat(row.metricValues[2].value || 0);
      catMap[seg].durationSum += parseFloat(row.metricValues[3].value || 0);
      catMap[seg].articleCount += 1;
    }

    const categories = Object.entries(catMap)
      .filter(([, v]) => v.articleCount >= 1)
      .map(([slug, v]) => {
        const avgBounce = v.articleCount > 0 ? v.bounceRateSum / v.articleCount : 0;
        const avgDuration = v.articleCount > 0 ? v.durationSum / v.articleCount : 0;
        const viewsPerArticle = v.articleCount > 0 ? Math.round(v.pageViews / v.articleCount) : 0;
        // Gap score: high bounce + low duration + low views/article = high gap (needs attention)
        const gapScore = Math.round((avgBounce * 50) + (Math.max(0, 120 - avgDuration) / 120 * 30) + (Math.max(0, 500 - viewsPerArticle) / 500 * 20));
        return {
          slug,
          displayName: slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
          pageViews: v.pageViews,
          sessions: v.sessions,
          articleCount: v.articleCount,
          viewsPerArticle,
          avgBounceRate: parseFloat((avgBounce * 100).toFixed(1)),
          avgDuration: Math.round(avgDuration),
          gapScore: Math.min(gapScore, 100)
        };
      })
      .sort((a, b) => b.pageViews - a.pageViews)
      .slice(0, 12);

    cache.set(k, categories, 600);
    res.json(categories);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: Article Search by title (all-time views) ──────────
app.get('/api/article-search', requireProperty, async (req, res) => {
  const runSearch = async (startDate) => {
    const q = (req.query.q || '').trim();
    const requestBody = {
      dateRanges: [{ startDate, endDate: 'today' }],
      metrics: [{ name: 'screenPageViews' }],
      dimensions: [{ name: 'pageTitle' }, { name: 'pagePath' }],
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      limit: 100
    };
    if (q) {
      requestBody.dimensionFilter = {
        filter: {
          fieldName: 'pageTitle',
          stringFilter: { matchType: 'CONTAINS', value: q, caseSensitive: false }
        }
      };
    }
    const r = await ga(req.user).properties.runReport({ property: PROP(req), requestBody });
    const allRows = (r.data.rows || [])
      .filter(row => {
        const t = row.dimensionValues[0].value;
        const p = row.dimensionValues[1].value;
        return t && t !== '(not set)' && t.trim() !== '' && isArticlePath(p);
      })
      .map(row => ({
        title: row.dimensionValues[0].value,
        path: row.dimensionValues[1].value,
        pageViews: parseInt(row.metricValues[0].value)
      }));
    // Deduplicate by normalized title — sum views across all variants (whitespace/encoding differences)
    // Normalizes unicode + collapses whitespace to catch visually identical but byte-different titles
    const normKey = t => t.normalize('NFC').trim().replace(/\s+/g, ' ');
    const titleMap = new Map();
    for (const row of allRows) {
      const key = normKey(row.title);
      const existing = titleMap.get(key);
      if (existing) {
        existing.pageViews += row.pageViews;
        // Keep path/title from the variant with the most views
        if (row.pageViews > existing._topViews) {
          existing._topViews = row.pageViews;
          existing.path = row.path;
          existing.title = row.title;
        }
      } else {
        titleMap.set(key, { ...row, _topViews: row.pageViews });
      }
    }
    return [...titleMap.values()].sort((a, b) => b.pageViews - a.pageViews).slice(0, 20);
  };
  try {
    try {
      res.json(await runSearch('2015-01-01'));
    } catch (e) {
      // GA4 tells us the property's actual earliest date — parse and retry
      const m = e.message && e.message.match(/greater than (\d{4}-\d{2}-\d{2})/);
      if (m) {
        // GA4 requires strictly greater than the reported date, so add 1 day
        const minDate = new Date(m[1]);
        minDate.setDate(minDate.getDate() + 1);
        const startDate = minDate.toISOString().slice(0, 10);
        res.json(await runSearch(startDate));
      } else {
        throw e;
      }
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Local dev: start the server directly
// Netlify Functions: import this module, listen() is skipped
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`✅ Running at http://localhost:${PORT}`));
}

module.exports = app;
