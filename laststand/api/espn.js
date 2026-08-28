// api/espn.js — Vercel serverless function that proxies ESPN requests
// This runs on the server so there's no CORS issue

export default async function handler(req, res) {
  // Allow requests from your app
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { path } = req.query;
  if (!path) {
    res.status(400).json({ error: 'Missing path parameter' });
    return;
  }

  // Only allow ESPN API calls
  const espnBase = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
  const url = `${espnBase}/${path}`;

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LastStand/1.0)',
        'Accept': 'application/json',
      }
    });

    if (!response.ok) {
      res.status(response.status).json({ error: 'ESPN API error' });
      return;
    }

    const data = await response.json();
    // Cache for 5 minutes
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
