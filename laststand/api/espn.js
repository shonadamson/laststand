export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { path } = req.query;
  if (!path) { res.status(400).json({ error: 'Missing path' }); return; }

  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/${path}`;

  // Try multiple approaches to get ESPN data
  const attempts = [
    { headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1', 'Accept': 'application/json', 'Accept-Language': 'en-US,en;q=0.9', 'Referer': 'https://www.espn.com/' } },
    { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': 'application/json' } },
    { headers: { 'Accept': 'application/json' } },
  ];

  for (const options of attempts) {
    try {
      const response = await fetch(url, options);
      if (response.ok) {
        const data = await response.json();
        res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
        return res.status(200).json(data);
      }
    } catch {}
  }

  res.status(403).json({ error: 'ESPN API error' });
}
