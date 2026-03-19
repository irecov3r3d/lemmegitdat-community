const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'foodmarket.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS ingredients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    emoji TEXT NOT NULL,
    unit TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS regions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    radius_km REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS food_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    region_id INTEGER NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    FOREIGN KEY(region_id) REFERENCES regions(id)
  );

  CREATE TABLE IF NOT EXISTS price_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ingredient_id INTEGER NOT NULL,
    food_source_id INTEGER NOT NULL,
    region_id INTEGER NOT NULL,
    price REAL NOT NULL,
    unit TEXT NOT NULL,
    reported_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    confirmations INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    FOREIGN KEY(ingredient_id) REFERENCES ingredients(id),
    FOREIGN KEY(food_source_id) REFERENCES food_sources(id),
    FOREIGN KEY(region_id) REFERENCES regions(id)
  );

  CREATE TABLE IF NOT EXISTS price_report_confirmations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(report_id, device_id),
    FOREIGN KEY(report_id) REFERENCES price_reports(id)
  );

  CREATE TABLE IF NOT EXISTS recipes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    ingredient_id INTEGER NOT NULL,
    instructions TEXT NOT NULL,
    spice_level TEXT NOT NULL,
    servings INTEGER NOT NULL,
    rating REAL NOT NULL,
    FOREIGN KEY(ingredient_id) REFERENCES ingredients(id)
  );

  CREATE TABLE IF NOT EXISTS playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    recipe_ids TEXT NOT NULL,
    ingredient_quantities TEXT NOT NULL,
    region_id INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(region_id) REFERENCES regions(id)
  );
`);

const seedDatabase = () => {
  const ingredientCount = db.prepare('SELECT COUNT(*) as count FROM ingredients').get().count;
  if (ingredientCount > 0) {
    return;
  }

  const insertIngredient = db.prepare(
    'INSERT INTO ingredients (name, emoji, unit) VALUES (?, ?, ?)'
  );
  const insertRegion = db.prepare(
    'INSERT INTO regions (name, lat, lng, radius_km) VALUES (?, ?, ?, ?)'
  );
  const insertFoodSource = db.prepare(
    'INSERT INTO food_sources (name, region_id, lat, lng) VALUES (?, ?, ?, ?)'
  );
  const insertRecipe = db.prepare(
    'INSERT INTO recipes (name, ingredient_id, instructions, spice_level, servings, rating) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insertReport = db.prepare(
    `INSERT INTO price_reports
      (ingredient_id, food_source_id, region_id, price, unit, reported_by, created_at, confirmations, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const crawfishId = insertIngredient.run('Crawfish', '🦞', 'lb').lastInsertRowid;

  const regionId = insertRegion.run('Hammond, LA', 30.5044, -90.4612, 25).lastInsertRowid;

  const sources = [
    { name: 'Cajun Crawfish Co.', lat: 30.5049, lng: -90.4762 },
    { name: 'Tangi Seafood Market', lat: 30.4982, lng: -90.4778 },
    { name: 'Bayou Harvest Stop', lat: 30.5134, lng: -90.4543 },
  ];

  const sourceIds = sources.map(source =>
    insertFoodSource.run(source.name, regionId, source.lat, source.lng).lastInsertRowid
  );

  insertRecipe.run(
    'Classic Crawfish Boil',
    crawfishId,
    'Bring a large pot of seasoned water to a rolling boil. Add potatoes and corn for 10 minutes. Add crawfish and boil for 3-4 minutes. Shut off heat, soak for 15 minutes, then serve hot with extra seasoning.',
    'medium',
    4,
    4.7
  );
  insertRecipe.run(
    'Crawfish Étouffée',
    crawfishId,
    'Make a blond roux with butter and flour. Add onion, bell pepper, and celery; cook until tender. Stir in stock, simmer, then add crawfish tails and seasonings. Serve over rice with green onions.',
    'mild',
    6,
    4.8
  );
  insertRecipe.run(
    'Spicy Crawfish Pasta',
    crawfishId,
    'Sauté garlic, onions, and peppers. Add crawfish tails with Cajun spices and cream. Simmer until thick, toss with pasta, and finish with parmesan and parsley.',
    'hot',
    4,
    4.6
  );

  const now = new Date();
  const reportTimes = [
    new Date(now.getTime() - 1000 * 60 * 60 * 2),
    new Date(now.getTime() - 1000 * 60 * 60 * 6),
    new Date(now.getTime() - 1000 * 60 * 60 * 12),
  ];

  insertReport.run(
    crawfishId,
    sourceIds[0],
    regionId,
    3.99,
    'lb',
    'seed-device-1',
    reportTimes[0].toISOString(),
    3,
    'active'
  );
  insertReport.run(
    crawfishId,
    sourceIds[1],
    regionId,
    4.25,
    'lb',
    'seed-device-2',
    reportTimes[1].toISOString(),
    1,
    'active'
  );
  insertReport.run(
    crawfishId,
    sourceIds[2],
    regionId,
    4.05,
    'lb',
    'seed-device-3',
    reportTimes[2].toISOString(),
    2,
    'active'
  );
};

seedDatabase();

module.exports = db;
