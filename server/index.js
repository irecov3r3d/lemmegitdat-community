const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');

const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const broadcast = message => {
  const payload = JSON.stringify(message);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
};

const expireOldReports = () => {
  const cutoff = new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString();
  db.prepare(
    "UPDATE price_reports SET status = 'expired' WHERE status = 'active' AND created_at < ?"
  ).run(cutoff);
};

const haversineDistance = (lat1, lng1, lat2, lng2) => {
  const toRad = value => (value * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusKm * c;
};

const getRegion = regionId =>
  db.prepare('SELECT * FROM regions WHERE id = ?').get(regionId);

const baseReportQuery = `
  SELECT pr.*, fs.name as food_source_name, fs.lat as food_source_lat, fs.lng as food_source_lng
  FROM price_reports pr
  JOIN food_sources fs ON fs.id = pr.food_source_id
  WHERE pr.status = 'active'
    AND pr.region_id = ?
    AND pr.ingredient_id = ?
  ORDER BY pr.created_at DESC
`;

app.get('/api/ingredients', (_req, res) => {
  const ingredients = db.prepare('SELECT * FROM ingredients ORDER BY name').all();
  res.json(ingredients);
});

app.get('/api/regions', (_req, res) => {
  const regions = db.prepare('SELECT * FROM regions ORDER BY name').all();
  res.json(regions);
});

app.get('/api/food-sources', (req, res) => {
  const regionId = Number(req.query.regionId);
  if (!regionId) {
    return res.status(400).json({ error: 'regionId is required' });
  }
  const sources = db
    .prepare('SELECT * FROM food_sources WHERE region_id = ? ORDER BY name')
    .all(regionId);
  return res.json(sources);
});

app.get('/api/recipes', (req, res) => {
  const ingredientId = Number(req.query.ingredientId);
  if (!ingredientId) {
    return res.status(400).json({ error: 'ingredientId is required' });
  }
  const recipes = db
    .prepare('SELECT * FROM recipes WHERE ingredient_id = ? ORDER BY rating DESC')
    .all(ingredientId);
  return res.json(recipes);
});

app.get('/api/price-reports', (req, res) => {
  const ingredientId = Number(req.query.ingredientId);
  const regionId = Number(req.query.regionId);
  if (!ingredientId || !regionId) {
    return res.status(400).json({ error: 'ingredientId and regionId are required' });
  }
  expireOldReports();
  const region = getRegion(regionId);
  const reports = db.prepare(baseReportQuery).all(regionId, ingredientId);
  const enriched = reports.map(report => {
    const distanceKm = haversineDistance(
      region.lat,
      region.lng,
      report.food_source_lat,
      report.food_source_lng
    );
    return { ...report, distance_km: Number(distanceKm.toFixed(2)) };
  });
  return res.json(enriched);
});

app.get('/api/best-price', (req, res) => {
  const ingredientId = Number(req.query.ingredientId);
  const regionId = Number(req.query.regionId);
  if (!ingredientId || !regionId) {
    return res.status(400).json({ error: 'ingredientId and regionId are required' });
  }
  expireOldReports();
  const region = getRegion(regionId);
  if (!region) {
    return res.status(404).json({ error: 'Region not found' });
  }
  const reports = db.prepare(baseReportQuery).all(regionId, ingredientId);
  if (!reports.length) {
    return res.json(null);
  }

  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;

  reports.forEach(report => {
    const distanceKm = haversineDistance(
      region.lat,
      region.lng,
      report.food_source_lat,
      report.food_source_lng
    );
    const distanceWeight = 1 + distanceKm / Math.max(region.radius_km, 1);
    const confirmationWeight = 1 + report.confirmations;
    const score = (report.price * distanceWeight) / confirmationWeight;

    if (score < bestScore) {
      bestScore = score;
      best = {
        ...report,
        distance_km: Number(distanceKm.toFixed(2)),
        score: Number(score.toFixed(3)),
      };
    }
  });

  return res.json(best);
});

app.post('/api/price-reports', (req, res) => {
  const { ingredient_id, food_source_id, region_id, price, unit, reported_by } = req.body;
  if (!ingredient_id || !food_source_id || !region_id || !price || !unit || !reported_by) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const createdAt = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO price_reports
      (ingredient_id, food_source_id, region_id, price, unit, reported_by, created_at, confirmations, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const result = insert.run(
    ingredient_id,
    food_source_id,
    region_id,
    price,
    unit,
    reported_by,
    createdAt,
    0,
    'active'
  );
  const report = db
    .prepare(
      `SELECT pr.*, fs.name as food_source_name, fs.lat as food_source_lat, fs.lng as food_source_lng
       FROM price_reports pr
       JOIN food_sources fs ON fs.id = pr.food_source_id
       WHERE pr.id = ?`
    )
    .get(result.lastInsertRowid);

  broadcast({ type: 'price_report_created', payload: report });

  return res.status(201).json(report);
});

app.post('/api/price-reports/:id/confirm', (req, res) => {
  const reportId = Number(req.params.id);
  const { device_id } = req.body;
  if (!reportId || !device_id) {
    return res.status(400).json({ error: 'reportId and device_id are required' });
  }

  const report = db.prepare('SELECT * FROM price_reports WHERE id = ?').get(reportId);
  if (!report || report.status !== 'active') {
    return res.status(404).json({ error: 'Report not found or expired' });
  }

  const exists = db
    .prepare(
      'SELECT 1 FROM price_report_confirmations WHERE report_id = ? AND device_id = ?'
    )
    .get(reportId, device_id);

  if (exists) {
    return res.status(200).json({ confirmations: report.confirmations });
  }

  const insertConfirmation = db.prepare(
    'INSERT INTO price_report_confirmations (report_id, device_id, created_at) VALUES (?, ?, ?)'
  );
  const updateReport = db.prepare(
    'UPDATE price_reports SET confirmations = confirmations + 1 WHERE id = ?'
  );

  const transaction = db.transaction(() => {
    insertConfirmation.run(reportId, device_id, new Date().toISOString());
    updateReport.run(reportId);
  });

  transaction();

  const updated = db
    .prepare(
      `SELECT pr.*, fs.name as food_source_name, fs.lat as food_source_lat, fs.lng as food_source_lng
       FROM price_reports pr
       JOIN food_sources fs ON fs.id = pr.food_source_id
       WHERE pr.id = ?`
    )
    .get(reportId);

  broadcast({ type: 'price_report_confirmed', payload: updated });

  return res.json({ confirmations: updated.confirmations });
});

app.post('/api/playlists', (req, res) => {
  const { name, recipe_ids, ingredient_quantities, region_id, created_by } = req.body;
  if (!name || !recipe_ids || !ingredient_quantities || !region_id || !created_by) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const result = db
    .prepare(
      'INSERT INTO playlists (name, recipe_ids, ingredient_quantities, region_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(
      name,
      JSON.stringify(recipe_ids),
      JSON.stringify(ingredient_quantities),
      region_id,
      created_by,
      new Date().toISOString()
    );

  const playlist = db
    .prepare('SELECT * FROM playlists WHERE id = ?')
    .get(result.lastInsertRowid);

  return res.status(201).json(playlist);
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`FoodMarket API running on port ${PORT}`);
});
