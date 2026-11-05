const BASE = "https://api.themoviedb.org/3";

export async function tmdb(route, params = {}) {
  const token = process.env.TMDB_API_TOKEN;
  if (!token) throw new Error("TMDB_API_TOKEN absent. Ajoutez le jeton API Read Access v4 dans les secrets GitHub.");
  const url = new URL(BASE + route);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, accept: "application/json" },
        signal: AbortSignal.timeout(30000)
      });
      if (response.status === 429 || response.status >= 500) {
        const wait = Math.min(15000, Number(response.headers.get("retry-after") || 2) * 1000 * (attempt + 1));
        lastError = new Error(`TMDB ${response.status} sur ${route}`);
        if (attempt < 3) { await new Promise(r => setTimeout(r, wait)); continue; }
      }
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`TMDB ${response.status} sur ${route}: ${body.slice(0, 300)}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt === 3 || /TMDB 4\d\d/.test(error.message)) break;
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastError || new Error(`Échec de la requête TMDB ${route}`);
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
