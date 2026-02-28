require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const cookieSession = require('cookie-session');
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { google } = require('googleapis');
const NodeCache = require('node-cache');
const path = require('path');

const app = express();
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

function ga(user) {
  const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ access_token: user.accessToken });
  return google.analyticsdata({ version: 'v1beta', auth });
}
const PROP = () => `properties/${process.env.GA4_PROPERTY_ID}`;

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
  res.json({ loggedIn: true, name: req.user.name, email: req.user.email, photo: req.user.photo });
});

// ── API: Realtime Users ───────────────────────────────────
app.get('/api/realtime', requireAuth, async (req, res) => {
  try {
    const k = 'rt';
    if (cache.has(k)) return res.json(cache.get(k));
    const a = ga(req.user);

    const now = new Date();
    const startOfMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

    const [rtTotal, rtMinutes, todayStats, monthStats] = await Promise.all([
      // No dimension = GA4's true deduplicated "users right now" count
      a.properties.runRealtimeReport({
        property: PROP(),
        requestBody: { metrics: [{ name: 'activeUsers' }] }
      }),
      // minutesAgo = last 30 min breakdown for sparkline (matches GA4 realtime chart)
      a.properties.runRealtimeReport({
        property: PROP(),
        requestBody: {
          metrics: [{ name: 'activeUsers' }],
          dimensions: [{ name: 'minutesAgo' }]
        }
      }),
      // Today's data — used for per-minute session/pageview counts
      a.properties.runReport({
        property: PROP(),
        requestBody: {
          dateRanges: [{ startDate: 'today', endDate: 'today' }],
          metrics: [{ name: 'sessions' }, { name: 'screenPageViews' }]
        }
      }),
      // Current month — bounce rate and avg session duration
      a.properties.runReport({
        property: PROP(),
        requestBody: {
          dateRanges: [{ startDate: startOfMonth, endDate: 'today' }],
          metrics: [{ name: 'bounceRate' }, { name: 'averageSessionDuration' }]
        }
      })
    ]);

    // True active users — matches GA4 "Users in last 30 min"
    const active = parseInt(rtTotal.data.rows?.[0]?.metricValues?.[0]?.value || 0);

    // Build 30-point sparkline from minutesAgo (index 0 = now, 29 = 29 min ago)
    const sparkline = Array(30).fill(0);
    (rtMinutes.data.rows || []).forEach(row => {
      const minAgo = parseInt(row.dimensionValues[0].value);
      if (minAgo >= 0 && minAgo < 30) sparkline[29 - minAgo] = parseInt(row.metricValues[0].value || 0);
    });

    // Pageviews per minute from last minute's realtime data
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
    cache.set(k, d, 10);
    res.json(d);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: Top 10 News (Realtime — last 30 min active users) ───
app.get('/api/top-news', requireAuth, async (req, res) => {
  try {
    const k = 'top10';
    if (cache.has(k)) return res.json(cache.get(k));
    const r = await ga(req.user).properties.runRealtimeReport({
      property: PROP(),
      requestBody: {
        metrics: [{ name: 'activeUsers' }],
        dimensions: [{ name: 'unifiedScreenName' }],
        orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }],
        limit: 10
      }
    });
    const rows = (r.data.rows || []).map((row, i) => ({
      rank: i + 1,
      title: row.dimensionValues[0].value,
      activeUsers: parseInt(row.metricValues[0].value)
    }));
    cache.set(k, rows, 10);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: State News (Last 7 days) ─────────────────────────
// Supports both old short paths (/mp/, /cg/, /rj/) and new full paths (/state/madhya-pradesh/ etc.)
const STATE_PATH_MAP = {
  mp: ['/mp/', '/state/madhya-pradesh/'],
  cg: ['/cg/', '/state/chhattisgarh/'],
  rj: ['/rj/', '/state/rajasthan/']
};
app.get('/api/state-news/:state', requireAuth, async (req, res) => {
  try {
    const state = req.params.state.toLowerCase();
    const k = `state_${state}`;
    if (cache.has(k)) return res.json(cache.get(k));
    const paths = STATE_PATH_MAP[state] || [`/${state}/`];
    const r = await ga(req.user).properties.runReport({
      property: PROP(),
      requestBody: {
        dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
        metrics: [{ name: 'screenPageViews' }],
        dimensions: [{ name: 'pageTitle' }, { name: 'pagePath' }],
        dimensionFilter: {
          orGroup: {
            expressions: paths.map(p => ({
              filter: { fieldName: 'pagePath', stringFilter: { matchType: 'CONTAINS', value: p } }
            }))
          }
        },
        orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
        limit: 5
      }
    });
    const rows = (r.data.rows || []).map((row, i) => ({
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
// Tries customUser:author, then customEvent:author; returns [] if neither is configured in GA4
app.get('/api/top-authors', requireAuth, async (req, res) => {
  try {
    const k = 'authors';
    if (cache.has(k)) return res.json(cache.get(k));
    const now = new Date();
    const startOfMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const tryDimension = async (dim) => {
      const r = await ga(req.user).properties.runReport({
        property: PROP(),
        requestBody: {
          dateRanges: [{ startDate: startOfMonth, endDate: 'today' }],
          metrics: [{ name: 'screenPageViews' }, { name: 'sessions' }],
          dimensions: [{ name: dim }],
          orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
          limit: 20
        }
      });
      return (r.data.rows || [])
        .filter(row => {
          const n = row.dimensionValues[0].value;
          return n && n !== '(not set)' && n !== '(not provided)' && n.trim() !== '';
        })
        .slice(0, 6)
        .map((row, i) => ({
          rank: i + 1,
          name: row.dimensionValues[0].value,
          views: parseInt(row.metricValues[0].value),
          articles: parseInt(row.metricValues[1].value)
        }));
    };
    // Auto-discover author dimension from GA4 metadata
    let rows = [];
    let foundDim = null;
    try {
      const meta = await ga(req.user).properties.getMetadata({ name: `${PROP()}/metadata` });
      const customDims = (meta.data.dimensions || []).filter(d => d.apiName && d.apiName.startsWith('custom'));
      // Look for any custom dim whose name/description contains author/writer
      const authorDim = customDims.find(d => {
        const n = (d.apiName + ' ' + (d.uiName || '') + ' ' + (d.description || '')).toLowerCase();
        return n.includes('author') || n.includes('writer') || n.includes('byline');
      });
      if (authorDim) foundDim = authorDim.apiName;
    } catch (_) {}

    // Fall back to common guesses if metadata discovery fails
    const dimsToTry = foundDim
      ? [foundDim]
      : ['customUser:author', 'customEvent:author', 'customUser:Author', 'customEvent:Author', 'customUser:writer', 'customEvent:writer'];

    for (const dim of dimsToTry) {
      try { rows = await tryDimension(dim); } catch (_) { rows = []; }
      if (rows.length) break;
    }
    cache.set(k, rows, 300);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: GA4 Custom Dimensions (diagnostic) ───────────────
app.get('/api/ga4-dims', requireAuth, async (req, res) => {
  try {
    const meta = await ga(req.user).properties.getMetadata({ name: `${PROP()}/metadata` });
    const custom = (meta.data.dimensions || [])
      .filter(d => d.apiName && d.apiName.startsWith('custom'))
      .map(d => ({ apiName: d.apiName, uiName: d.uiName, description: d.description }));
    res.json(custom);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Running at http://localhost:${PORT}`));
