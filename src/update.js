import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmdb, sleep } from "./tmdb.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data");
const PUBLIC_DIR = path.join(ROOT, "public");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const LOOKBACK_DAYS = Math.max(365, Number(process.env.LOOKBACK_DAYS || 365));
const MAX_PAGES = Math.min(500, Math.max(1, Number(process.env.MAX_PAGES_PER_TYPE_REGION || 20)));
const CONCURRENCY = Math.min(8, Math.max(1, Number(process.env.CONCURRENCY || 3)));
const EVENT_HISTORY_DAYS = Math.max(30, Number(process.env.EVENT_HISTORY_DAYS || 90));
const MONETIZATION = String(process.env.MONETIZATION_TYPES || "flatrate").split(",").map(x => x.trim()).filter(Boolean);
const REGIONS = [
  { code: "FR", label: "France", language: "fr-FR" },
  { code: "CA", label: "Canada", language: "fr-CA" }
];
const TYPES = ["movie", "tv"];
const now = () => new Date().toISOString();
const dateOnly = d => d.toISOString().slice(0, 10);
const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86400000);
const today = new Date();
const cutoffISO = dateOnly(cutoff);
const todayISO = dateOnly(today);
const eventCutoff = Date.now() - EVENT_HISTORY_DAYS * 86400000;

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await fs.rename(temp, file);
}
async function readState() {
  try {
    const value = JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
    if (!value || typeof value !== "object" || !value.items) throw new Error("État invalide");
    return { version: 2, bootstrapped: Boolean(value.bootstrapped), lastRun: value.lastRun || null,
      items: value.items || {}, events: Array.isArray(value.events) ? value.events : [] };
  } catch (error) {
    if (error.code !== "ENOENT") console.warn(`État précédent illisible, initialisation propre : ${error.message}`);
    return { version: 2, bootstrapped: false, lastRun: null, items: {}, events: [] };
  }
}
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try { results[index] = await fn(items[index], index); }
      catch (error) { console.warn(`Élément ignoré : ${error.message}`); results[index] = null; }
    }
  }));
  return results;
}
function mediaId(type, id) { return `tmdb:${type === "movie" ? "movie" : "tv"}:${id}`; }
function mediaType(type) { return type === "movie" ? "movie" : "series"; }
function titleOf(type, item) { return type === "movie" ? item.title : item.name; }
function releaseOf(type, item) { return type === "movie" ? item.release_date : item.first_air_date; }

async function discover(type, region, page) {
  const movie = type === "movie";
  const route = movie ? "/discover/movie" : "/discover/tv";
  const dates = movie
    ? { "primary_release_date.gte": cutoffISO, "primary_release_date.lte": todayISO }
    : { "first_air_date.gte": cutoffISO, "first_air_date.lte": todayISO };
  return tmdb(route, {
    language: region.language, region: region.code, watch_region: region.code,
    with_watch_monetization_types: MONETIZATION.join("|"), include_adult: false,
    sort_by: movie ? "popularity.desc" : "popularity.desc", page, ...dates
  });
}
async function currentOffers(type, id) {
  const route = type === "movie" ? `/movie/${id}/watch/providers` : `/tv/${id}/watch/providers`;
  return tmdb(route);
}
async function getMovieCountries(id) {
  const detail = await tmdb(`/movie/${id}`);
  return (detail.production_countries || []).map(c => c.iso_3166_1);
}
function providersFor(result, monetization = MONETIZATION) {
  const out = [];
  const fields = ["flatrate", "free", "ads", "rent", "buy"];
  for (const field of fields) {
    if (!monetization.includes(field)) continue;
    for (const p of result?.[field] || []) out.push({ id: p.provider_id, name: p.provider_name, offer: field });
  }
  const unique = new Map(out.map(p => [`${p.id}:${p.offer}`, p]));
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name, "fr") || a.offer.localeCompare(b.offer));
}
function makeMeta(type, item, region, providers, watchLink, countryCodes) {
  const releaseDate = releaseOf(type, item) || "";
  const providersText = providers.length ? providers.map(p => `${p.name}${p.offer === "flatrate" ? "" : ` (${p.offer})`}`).join(", ") : "Non disponible";
  const description = [item.overview || "", `Disponibilité ${region.label} : ${providersText}.`, "Données de disponibilité fournies par JustWatch via TMDB."].filter(Boolean).join("\n\n");
  return {
    id: mediaId(type, item.id), type: mediaType(type), name: titleOf(type, item),
    poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : undefined,
    background: item.backdrop_path ? `https://image.tmdb.org/t/p/w1280${item.backdrop_path}` : undefined,
    description,
    releaseInfo: releaseDate.slice(0, 4) || undefined,
    imdbRating: item.vote_average ? String(Number(item.vote_average.toFixed(1))) : undefined,
    links: [
      { name: "TMDB", category: "source", url: `https://www.themoviedb.org/${type === "movie" ? "movie" : "tv"}/${item.id}` },
      ...(watchLink ? [{ name: "JustWatch", category: "watch", url: watchLink }] : [])
    ],
    behaviorHints: { defaultVideoId: mediaId(type, item.id), hasScheduledVideos: type === "tv" },
    _source: { tmdbId: item.id, mediaType: type, region: region.code, providers, watchLink, releaseDate, popularity: item.popularity || 0, countryCodes }
  };
}
function eventRecord(kind, region, type, meta, provider, timestamp) {
  return { id: `${kind}:${region.code}:${type}:${meta._source.tmdbId}:${provider?.id ?? "all"}:${timestamp}`,
    kind, region: region.code, regionName: region.label, type: mediaType(type), tmdbId: meta._source.tmdbId,
    titleId: meta.id, name: meta.name, poster: meta.poster, background: meta.background,
    releaseDate: meta._source.releaseDate, provider: provider || null, detectedAt: timestamp,
    popularity: meta._source.popularity };
}
function sortRecent(a, b) { return new Date(b.detectedAt) - new Date(a.detectedAt); }
function toPublicMeta(meta) {
  const { _source, ...publicMeta } = meta;
  return publicMeta;
}
function catalogFileName(region, group, type) {
  return `nuvio-${group}-${region.code.toLowerCase()}-${type === "movie" ? "movies" : "series"}`;
}
function createCatalog(metas) { return { metas, cacheMaxAge: 10800, staleRevalidate: 3600, staleError: 86400 }; }

async function scanRegionType(region, type, state, bootstrap, stats) {
  const discovered = new Map();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await discover(type, region, page);
    for (const item of response.results || []) discovered.set(String(item.id), item);
    if (page >= (response.total_pages || 1) || page >= MAX_PAGES) break;
    await sleep(180);
  }
  const previousKeys = Object.keys(state.items).filter(k => k.startsWith(`${region.code}:${type}:`));
  const candidateIds = new Set([...discovered.keys(), ...previousKeys.map(k => k.split(":")[2])]);
  stats.candidates += discovered.size;
  const results = await mapLimit([...candidateIds], CONCURRENCY, async id => {
    const key = `${region.code}:${type}:${id}`;
    const previous = state.items[key];
    let item = discovered.get(String(id));
    let countries = previous?.countryCodes || [];
    if (!item) {
      // Recheck previously known IDs even if they no longer appear in Discover,
      // so that removals can be detected.
      const detail = await tmdb(type === "movie" ? `/movie/${id}` : `/tv/${id}`, { language: region.language });
      item = detail;
      if (type === "movie") countries = (detail.production_countries || []).map(c => c.iso_3166_1);
      else countries = detail.origin_country || [];
    } else if (type === "movie") {
      countries = await getMovieCountries(id);
    } else {
      countries = item.origin_country || [];
    }
    // Exclude only Indian productions, not titles merely in an Indian language.
    if (countries.includes("IN")) return { key, ignored: "India" };
    const offers = await currentOffers(type, id);
    const countryResult = offers.results?.[region.code];
    const providers = providersFor(countryResult);
    const watchLink = countryResult?.link || null;
    const meta = makeMeta(type, item, region, providers, watchLink, countries);
    const oldProviders = previous?.providers || [];
    const oldMap = new Map(oldProviders.map(p => [`${p.id}:${p.offer}`, p]));
    const newMap = new Map(providers.map(p => [`${p.id}:${p.offer}`, p]));
    const added = providers.filter(p => !oldMap.has(`${p.id}:${p.offer}`));
    const removed = oldProviders.filter(p => !newMap.has(`${p.id}:${p.offer}`));
    const stamp = now();
    if (!bootstrap && !previous && providers.length) {
      for (const provider of providers) state.events.push(eventRecord("added", region, type, meta, provider, stamp));
    } else if (!bootstrap && previous) {
      for (const provider of added) state.events.push(eventRecord("added", region, type, meta, provider, stamp));
      for (const provider of removed) state.events.push(eventRecord("removed", region, type, meta, provider, stamp));
    }
    state.items[key] = {
      id: meta.id, type: meta.type, name: meta.name, poster: meta.poster || null, background: meta.background || null,
      description: item.overview || "", releaseInfo: meta.releaseInfo || null, imdbRating: meta.imdbRating || null,
      tmdbId: item.id, releaseDate: meta._source.releaseDate, popularity: item.popularity || 0,
      region: region.code, regionName: region.label, providers, watchLink, countryCodes: countries,
      firstSeen: previous?.firstSeen || stamp, lastChecked: stamp, active: providers.length > 0
    };
    return { key, meta, providers, previous, added, removed };
  });
  const active = results.filter(x => x?.meta && x.providers.length);
  stats.checked += results.filter(Boolean).length;
  stats.available += active.length;
  return active;
}

export async function updateCatalogs() {
  if (!process.env.TMDB_API_TOKEN) throw new Error("TMDB_API_TOKEN manquant.");
  await fs.mkdir(DATA_DIR, { recursive: true });
  const state = await readState();
  const bootstrap = !state.bootstrapped;
  const stats = { candidates: 0, checked: 0, available: 0 };
  const activeByRegion = {};
  for (const region of REGIONS) {
    activeByRegion[region.code] = { movie: [], tv: [] };
    for (const type of TYPES) {
      const active = await scanRegionType(region, type, state, bootstrap, stats);
      activeByRegion[region.code][type] = active.map(x => x.meta);
      console.log(`${region.code}/${type}: ${active.length} titres actuellement disponibles (fenêtre sorties ${LOOKBACK_DAYS} jours)`);
    }
  }

  state.events = state.events.filter(e => Date.parse(e.detectedAt) >= eventCutoff);
  // Retain only titles whose initial release still falls inside the rolling 12-month window.
  for (const [key, item] of Object.entries(state.items)) {
    if (!item.releaseDate || item.releaseDate < cutoffISO || item.releaseDate > todayISO) delete state.items[key];
  }
  const eventGroups = state.events;
  const allActive = Object.values(activeByRegion).flatMap(group => [...group.movie, ...group.tv]);
  const trending = [...allActive].sort((a, b) => (b._source.popularity || 0) - (a._source.popularity || 0));
  const outputs = [];
  await fs.rm(path.join(PUBLIC_DIR, "catalog"), { recursive: true, force: true });
  for (const region of REGIONS) {
    const regionEvents = eventGroups.filter(e => e.region === region.code).sort(sortRecent);
    for (const type of TYPES) {
      const suffix = type === "movie" ? "movies" : "series";
      const active = activeByRegion[region.code][type];
      const eventMetas = regionEvents.filter(e => e.type === mediaType(type)).map(e => ({
        id: e.titleId, type: e.type, name: e.name, poster: e.poster || undefined, background: e.background || undefined,
        description: `${e.kind === "added" ? "Disponibilité détectée" : "Disponibilité retirée"} ${e.provider?.name ? `chez ${e.provider.name}` : ""} — ${region.label}.\nDate de détection : ${e.detectedAt}.\nDonnées fournies par JustWatch via TMDB.`,
        releaseInfo: (e.releaseDate || "").slice(0, 4) || undefined,
        links: [{ name: "TMDB", category: "source", url: `https://www.themoviedb.org/${type === "movie" ? "movie" : "tv"}/${e.tmdbId}` }]
      }));
      const added = eventMetas.filter((_, i) => regionEvents.filter(e => e.type === mediaType(type))[i]?.kind === "added");
      const removed = eventMetas.filter((_, i) => regionEvents.filter(e => e.type === mediaType(type))[i]?.kind === "removed");
      const trend = [...active].sort((a, b) => (b._source.popularity || 0) - (a._source.popularity || 0));
      outputs.push([catalogFileName(region, "releases", type), createCatalog(active.map(toPublicMeta))]);
      outputs.push([catalogFileName(region, "additions", type), createCatalog(added)]);
      outputs.push([catalogFileName(region, "removals", type), createCatalog(removed)]);
      outputs.push([catalogFileName(region, "trending", type), createCatalog(trend.map(toPublicMeta))]);
    }
  }

  // Generate Stremio static paths and full metadata responses.
  const metaDir = path.join(PUBLIC_DIR, "meta");
  await fs.rm(metaDir, { recursive: true, force: true });
  const metaWritten = new Set();
  for (const group of Object.values(activeByRegion)) {
    for (const type of TYPES) for (const meta of group[type]) {
      const publicMeta = toPublicMeta(meta);
      const metaKey = `${meta.type}/${meta.id}.json`;
      if (metaWritten.has(metaKey)) continue;
      metaWritten.add(metaKey);
      await writeJson(path.join(metaDir, metaKey), { meta: publicMeta });
    }
  }
  for (const [file, value] of outputs) {
    const typeFolder = file.endsWith("-movies") ? "movie" : "series";
    await writeJson(path.join(PUBLIC_DIR, "catalog", typeFolder, file + ".json"), value);
  }

  const catalogs = [];
  for (const region of REGIONS) {
    const label = region.label;
    for (const type of TYPES) {
      const typeLabel = type === "movie" ? "Films" : "Séries";
      for (const [group, groupLabel] of [["releases", "Sorties des 12 derniers mois — actuellement disponibles"], ["additions", "Ajouts détectés depuis le lancement"], ["removals", "Disponibilités retirées"], ["trending", "Tendances"]]) {
        const id = catalogFileName(region, group, type);
        catalogs.push({ type: mediaType(type), id, name: `${groupLabel} — ${typeLabel} (${label})`, extra: [{ name: "search", isRequired: false }] });
      }
    }
  }
  const manifest = {
    id: "org.nuvio.streaming.catalogues.hybrid", version: "2.0.0", name: "Nuvio — Streaming France & Canada",
    description: "Catalogues rétroactifs sur 12 mois et changements de disponibilités détectés à partir du premier scan. Disponibilités fournies par JustWatch via TMDB.",
    resources: ["catalog", "meta"], types: ["movie", "series"], catalogs,
    idPrefixes: ["tmdb:movie:", "tmdb:tv:"], behaviorHints: { adult: false, p2p: false }
  };
  await writeJson(path.join(PUBLIC_DIR, "manifest.json"), manifest);
  state.lastRun = now();
  state.bootstrapped = true;
  state.version = 2;
  await writeJson(STATE_FILE, state);
  await writeJson(path.join(PUBLIC_DIR, "status.json"), {
    ok: true, version: 2, lastRun: state.lastRun, bootstrap: bootstrap,
    lookbackDays: LOOKBACK_DAYS, eventHistoryDays: EVENT_HISTORY_DAYS,
    candidates: stats.candidates, checked: stats.checked, currentlyAvailable: stats.available,
    trackedTitleRegionPairs: Object.keys(state.items).length, eventCount: state.events.length,
    note: "Le catalogue rétroactif repose sur les dates de sortie initiale et les disponibilités actuelles. Les dates d'ajout/retrait sont les dates de première observation par ce service, pas des dates historiques officielles de lancement sur les plateformes.",
    attribution: "Données de disponibilité fournies par JustWatch via TMDB."
  });
  console.log(`Export terminé : ${outputs.length} catalogues, ${metaWritten.size} fiches, ${state.events.length} événements. Bootstrap=${bootstrap}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  updateCatalogs().catch(error => { console.error(error); process.exitCode = 1; });
}
