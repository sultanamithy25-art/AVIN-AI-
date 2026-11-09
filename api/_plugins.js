const E = encodeURIComponent;
const TIMEOUT_MS = 9000;
const HEADERS = { 'User-Agent': 'AVIN-Assistant/1.0', Accept: 'application/json' };

async function get(url, as = 'json') {
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(`Service returned ${r.status}`);
  return as === 'text' ? r.text() : r.json();
}

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const clean = (t) => String(t ?? '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&').trim();
const notFound = (q) => { throw new Error(`Nothing found for "${q}"`); };

async function place(q) {
  const d = await get(`https://geocoding-api.open-meteo.com/v1/search?name=${E(q.split(',')[0].trim())}&count=1`);
  return d.results?.[0] || notFound(q);
}

const WEATHER = { 0: 'clear sky', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 80: 'rain showers', 81: 'rain showers', 82: 'violent showers', 95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'severe thunderstorm' };

// c: category, tool: AVIN may call it during a chat, ask: placeholder (no ask means no input needed).
const PLUGINS = {
  weather: { n: 'Weather', i: '🌤️', c: 'Live', d: 'Current weather and 3-day forecast for any city', ask: 'City name', tool: true, async run(q) {
    const p = await place(q);
    const w = await get(`https://api.open-meteo.com/v1/forecast?latitude=${p.latitude}&longitude=${p.longitude}&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code&daily=temperature_2m_max,temperature_2m_min,weather_code&forecast_days=3&timezone=auto`);
    const days = w.daily.time.map((t, i) => `${t}: ${Math.round(w.daily.temperature_2m_min[i])} to ${Math.round(w.daily.temperature_2m_max[i])}°C, ${WEATHER[w.daily.weather_code[i]] || 'mixed'}`).join('\n');
    return { title: `${p.name}, ${p.country}`, text: `Now: ${Math.round(w.current.temperature_2m)}°C (feels ${Math.round(w.current.apparent_temperature)}°C), ${WEATHER[w.current.weather_code] || 'mixed'}, humidity ${w.current.relative_humidity_2m}%, wind ${Math.round(w.current.wind_speed_10m)} km/h\n${days}` };
  } },
  air: { n: 'Air Quality', i: '🌫️', c: 'Live', d: 'Air quality index for any city', ask: 'City name', tool: true, async run(q) {
    const p = await place(q);
    const a = await get(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${p.latitude}&longitude=${p.longitude}&current=us_aqi,pm2_5,pm10`);
    const v = a.current.us_aqi;
    return { title: `Air in ${p.name}`, text: `US AQI ${v} (${v <= 50 ? 'good' : v <= 100 ? 'moderate' : v <= 150 ? 'unhealthy for sensitive groups' : v <= 200 ? 'unhealthy' : 'very unhealthy'})\nPM2.5 ${a.current.pm2_5}, PM10 ${a.current.pm10}` };
  } },
  time: { n: 'World Clock', i: '🕰️', c: 'Live', d: 'Current local time in any city', ask: 'City name', tool: true, async run(q) {
    const p = await place(q);
    return { title: `${p.name}, ${p.country}`, text: `${new Date().toLocaleString('en-GB', { timeZone: p.timezone, dateStyle: 'full', timeStyle: 'short' })} (${p.timezone})` };
  } },
  sun: { n: 'Sunrise & Sunset', i: '🌅', c: 'Live', d: 'Today’s sunrise and sunset anywhere', ask: 'City name', async run(q) {
    const p = await place(q);
    const s = (await get(`https://api.sunrise-sunset.org/json?lat=${p.latitude}&lng=${p.longitude}&formatted=0`)).results;
    const f = (t) => new Date(t).toLocaleTimeString('en-GB', { timeZone: p.timezone, timeStyle: 'short' });
    return { title: p.name, text: `Sunrise ${f(s.sunrise)}\nSunset ${f(s.sunset)}` };
  } },
  quakes: { n: 'Earthquakes', i: '🌍', c: 'Live', d: 'Significant earthquakes this week', tool: true, async run() {
    const d = await get('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_week.geojson');
    return { title: 'Significant earthquakes this week', text: d.features.slice(0, 6).map((f) => `M${f.properties.mag} ${f.properties.place}, ${new Date(f.properties.time).toUTCString()}`).join('\n') || 'None reported this week.' };
  } },
  iss: { n: 'ISS Tracker', i: '🛰️', c: 'Space', d: 'Where the Space Station is right now', async run() {
    const d = await get('https://api.wheretheiss.at/v1/satellites/25544');
    return { title: 'International Space Station', text: `Latitude ${d.latitude.toFixed(2)}, longitude ${d.longitude.toFixed(2)}\nAltitude ${Math.round(d.altitude)} km, speed ${Math.round(d.velocity)} km/h`, link: `https://www.openstreetmap.org/?mlat=${d.latitude}&mlon=${d.longitude}#map=3/${d.latitude}/${d.longitude}` };
  } },
  launches: { n: 'Rocket Launches', i: '🚀', c: 'Space', d: 'Upcoming launches worldwide', async run() {
    const d = await get('https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=5');
    return { title: 'Upcoming launches', text: d.results.map((l) => `${l.name}, ${new Date(l.net).toUTCString()}, ${l.pad?.location?.name || ''}`).join('\n'), image: d.results[0]?.image || undefined };
  } },
  apod: { n: 'NASA Picture', i: '🔭', c: 'Space', d: 'NASA’s astronomy picture of the day', async run() {
    const d = await get('https://api.nasa.gov/planetary/apod?api_key=DEMO_KEY');
    return { title: d.title, text: d.explanation, image: d.media_type === 'image' ? d.url : undefined, link: d.hdurl };
  } },
  wikipedia: { n: 'Wikipedia', i: '📚', c: 'Knowledge', d: 'Summary of any topic', ask: 'Any topic', tool: true, async run(q) {
    const s = await get(`https://en.wikipedia.org/w/api.php?action=opensearch&search=${E(q)}&limit=1&format=json`);
    if (!s[1]?.[0]) notFound(q);
    const d = await get(`https://en.wikipedia.org/api/rest_v1/page/summary/${E(s[1][0])}`);
    return { title: d.title, text: d.extract, image: d.thumbnail?.source, link: d.content_urls?.desktop?.page };
  } },
  define: { n: 'Dictionary', i: '📖', c: 'Knowledge', d: 'Word meanings and examples', ask: 'A word', tool: true, async run(q) {
    const d = await get(`https://api.datamuse.com/words?sp=${E(q)}&md=dp&max=1`);
    const defs = d[0]?.defs;
    if (!defs) notFound(q);
    return { title: d[0].word, text: defs.slice(0, 5).map((x, i) => `${i + 1}. ${x.split('\t').reverse().join(' (').replace(/ \((\w+)$/, ' ($1)')}`).join('\n') };
  } },
  thesaurus: { n: 'Thesaurus', i: '🔤', c: 'Knowledge', d: 'Synonyms for any word', ask: 'A word', async run(q) {
    const d = await get(`https://api.datamuse.com/words?rel_syn=${E(q)}&max=15`);
    return { title: `Synonyms for ${q}`, text: d.map((x) => x.word).join(', ') || notFound(q) };
  } },
  rhymes: { n: 'Rhyme Finder', i: '🎤', c: 'Knowledge', d: 'Words that rhyme', ask: 'A word', async run(q) {
    const d = await get(`https://api.datamuse.com/words?rel_rhy=${E(q)}&max=25`);
    return { title: `Rhymes with ${q}`, text: d.map((x) => x.word).join(', ') || notFound(q) };
  } },
  translate: { n: 'Translator', i: '🌐', c: 'Knowledge', d: 'Translate text. Write: text > language code', ask: 'Good morning > ur', tool: true, async run(q) {
    const [text, to] = q.split('>').map((s) => s.trim());
    if (!to) throw new Error('Use the form: text > language code, for example: hello > ur');
    const d = await get(`https://api.mymemory.translated.net/get?q=${E(text)}&langpair=en|${E(to)}`);
    return { title: `Translation (${to})`, text: clean(d.responseData.translatedText) };
  } },
  country: { n: 'Countries', i: '🗺️', c: 'Knowledge', d: 'Facts about any country', ask: 'Country name', tool: true, async run(q) {
    const d = (await get(`https://restcountries.com/v3.1/name/${E(q)}?fields=name,capital,population,currencies,languages,flags,region`))[0];
    return { title: d.name.official, text: `Capital: ${d.capital?.join(', ')}\nRegion: ${d.region}\nPopulation: ${d.population.toLocaleString('en')}\nLanguages: ${Object.values(d.languages).join(', ')}\nCurrency: ${Object.values(d.currencies).map((c) => c.name).join(', ')}`, image: d.flags?.png };
  } },
  holidays: { n: 'Public Holidays', i: '🎌', c: 'Knowledge', d: 'Upcoming holidays. Use a 2-letter country code', ask: 'US', tool: true, async run(q) {
    const code = q.trim().toUpperCase().slice(0, 2);
    const today = new Date().toISOString().slice(0, 10);
    const y = new Date().getFullYear();
    const all = [...await get(`https://date.nager.at/api/v3/PublicHolidays/${y}/${E(code)}`), ...await get(`https://date.nager.at/api/v3/PublicHolidays/${y + 1}/${E(code)}`)];
    return { title: `Holidays in ${code}`, text: all.filter((h) => h.date >= today).slice(0, 8).map((h) => `${h.date}: ${h.localName}`).join('\n') };
  } },
  universities: { n: 'Universities', i: '🎓', c: 'Knowledge', d: 'Find universities by name or city', ask: 'Name', async run(q) {
    const d = await get(`http://universities.hipolabs.com/search?name=${E(q)}`);
    return { title: `Universities: ${q}`, text: d.slice(0, 10).map((u) => `${u.name} (${u.country})`).join('\n') || notFound(q) };
  } },
  books: { n: 'Book Finder', i: '📕', c: 'Knowledge', d: 'Search millions of books', ask: 'Title or author', async run(q) {
    const d = await get(`https://openlibrary.org/search.json?q=${E(q)}&limit=5&fields=title,author_name,first_publish_year,cover_i,key`);
    if (!d.docs.length) notFound(q);
    return { title: `Books: ${q}`, text: d.docs.map((b) => `${b.title}, ${b.author_name?.[0] || 'unknown'} (${b.first_publish_year || 'n/a'})`).join('\n'), image: d.docs[0].cover_i ? `https://covers.openlibrary.org/b/id/${d.docs[0].cover_i}-M.jpg` : undefined, link: `https://openlibrary.org${d.docs[0].key}` };
  } },
  arxiv: { n: 'Research Papers', i: '🔬', c: 'Knowledge', d: 'Latest science papers on arXiv', ask: 'Topic', async run(q) {
    const x = await get(`https://export.arxiv.org/api/query?search_query=all:${E(q)}&max_results=4&sortBy=relevance`, 'text');
    const items = [...x.matchAll(/<entry>[\s\S]*?<\/entry>/g)].map((m) => ({ t: clean(m[0].match(/<title>([\s\S]*?)<\/title>/)?.[1]).replace(/\s+/g, ' '), l: m[0].match(/<id>(.*?)<\/id>/)?.[1] }));
    if (!items.length) notFound(q);
    return { title: `Papers: ${q}`, text: items.map((i) => `${i.t}\n${i.l}`).join('\n\n') };
  } },
  wayback: { n: 'Wayback Machine', i: '🕸️', c: 'Knowledge', d: 'Find old versions of a website', ask: 'example.com', async run(q) {
    const s = (await get(`https://archive.org/wayback/available?url=${E(q)}`)).archived_snapshots?.closest;
    if (!s) notFound(q);
    return { title: q, text: `Closest snapshot: ${s.timestamp.slice(0, 4)}-${s.timestamp.slice(4, 6)}-${s.timestamp.slice(6, 8)}`, link: s.url };
  } },
  currency: { n: 'Currency', i: '💱', c: 'Money', d: 'Convert currency, e.g. 100 USD to PKR', ask: '100 USD to PKR', tool: true, async run(q) {
    const m = q.toUpperCase().match(/([\d.,]+)?\s*([A-Z]{3})\s*(?:TO|IN|=|>)?\s*([A-Z]{3})/);
    if (!m) throw new Error('Use the form: 100 USD to EUR');
    const amount = Number((m[1] || '1').replace(/,/g, ''));
    const d = await get(`https://open.er-api.com/v6/latest/${E(m[2])}`);
    const rate = d.rates?.[m[3]];
    if (!rate) notFound(m[3]);
    return { title: `${m[2]} to ${m[3]}`, text: `${amount.toLocaleString('en')} ${m[2]} = ${(amount * rate).toLocaleString('en', { maximumFractionDigits: 2 })} ${m[3]}\nRate: 1 ${m[2]} = ${rate} ${m[3]}\nUpdated: ${d.time_last_update_utc}` };
  } },
  crypto: { n: 'Crypto Prices', i: '🪙', c: 'Money', d: 'Live coin prices, for information only', ask: 'bitcoin', tool: true, async run(q) {
    const id = q.trim().toLowerCase().replace(/\s+/g, '-');
    const d = (await get(`https://api.coingecko.com/api/v3/simple/price?ids=${E(id)}&vs_currencies=usd&include_24hr_change=true`))[id];
    if (!d) notFound(q);
    return { title: q, text: `$${d.usd.toLocaleString('en')} USD\n24h change: ${d.usd_24h_change?.toFixed(2)}%` };
  } },
  hackernews: { n: 'Tech News', i: '📰', c: 'News & Dev', d: 'Top tech stories, or search a topic', ask: 'Topic (optional)', optional: true, tool: true, async run(q) {
    const d = await get(q ? `https://hn.algolia.com/api/v1/search?query=${E(q)}&tags=story&hitsPerPage=6` : 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=6');
    return { title: q ? `Tech news: ${q}` : 'Top tech stories', text: d.hits.map((h) => `${h.title} (${h.points} points)`).join('\n') || notFound(q) };
  } },
  github: { n: 'GitHub Search', i: '🐙', c: 'News & Dev', d: 'Find open source projects', ask: 'Search', async run(q) {
    const d = await get(`https://api.github.com/search/repositories?q=${E(q)}&sort=stars&per_page=5`);
    return { title: `GitHub: ${q}`, text: d.items.map((r) => `${r.full_name} (${r.stargazers_count.toLocaleString('en')} stars): ${r.description || ''}`).join('\n') || notFound(q), link: d.items[0]?.html_url };
  } },
  npm: { n: 'npm Packages', i: '📦', c: 'News & Dev', d: 'Search JavaScript packages', ask: 'Package', async run(q) {
    const d = await get(`https://registry.npmjs.org/-/v1/search?text=${E(q)}&size=5`);
    return { title: `npm: ${q}`, text: d.objects.map((o) => `${o.package.name} ${o.package.version}: ${o.package.description || ''}`).join('\n') || notFound(q) };
  } },
  pypi: { n: 'Python Packages', i: '🐍', c: 'News & Dev', d: 'Details for a Python package', ask: 'Exact package name', async run(q) {
    const d = (await get(`https://pypi.org/pypi/${E(q)}/json`)).info;
    return { title: `${d.name} ${d.version}`, text: d.summary, link: d.package_url };
  } },
  qr: { n: 'QR Code Maker', i: '🔳', c: 'Utility', d: 'Turn text or a link into a QR code', ask: 'Text or link', async run(q) {
    return { title: 'Your QR code', text: q, image: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&margin=12&data=${E(q)}` };
  } },
  palette: { n: 'Color Palette', i: '🎨', c: 'Utility', d: 'Build a palette from a hex color', ask: '8EC5FF', async run(q) {
    const hex = q.replace('#', '').trim();
    const d = await get(`https://www.thecolorapi.com/scheme?hex=${E(hex)}&mode=analogic&count=5`);
    return { title: `Palette from #${hex}`, text: d.colors.map((c) => `${c.hex.value} ${c.name.value}`).join('\n'), image: d.image?.named };
  } },
  yesno: { n: 'Decision Coin', i: '🎱', c: 'Utility', d: 'Can’t decide? Get a yes or no', async run() {
    const d = await get('https://yesno.wtf/api');
    return { title: d.answer.toUpperCase(), text: 'The universe has spoken.', image: d.image };
  } },
  bored: { n: 'Beat Boredom', i: '🥱', c: 'Fun', d: 'Something to do right now', async run() {
    const d = await get('https://bored-api.appbrewery.com/random');
    return { title: d.activity, text: `Type: ${d.type}` };
  } },
  joke: { n: 'Joke Machine', i: '😂', c: 'Fun', d: 'A random safe joke', async run() {
    const d = await get('https://v2.jokeapi.dev/joke/Any?safe-mode');
    return { title: 'Joke', text: d.joke || `${d.setup}\n\n${d.delivery}` };
  } },
  dadjoke: { n: 'Dad Jokes', i: '👨', c: 'Fun', d: 'Painfully good dad jokes', async run() {
    return { title: 'Dad joke', text: (await get('https://icanhazdadjoke.com/')).joke };
  } },
  advice: { n: 'Life Advice', i: '🧭', c: 'Fun', d: 'One random piece of advice', async run() {
    return { title: 'Advice', text: (await get(`https://api.adviceslip.com/advice?t=${Date.now()}`)).slip.advice };
  } },
  quote: { n: 'Quotes', i: '💬', c: 'Fun', d: 'A random quote', async run() {
    const d = await get('https://dummyjson.com/quotes/random');
    return { title: d.author, text: d.quote };
  } },
  trivia: { n: 'Trivia', i: '❓', c: 'Fun', d: 'A random trivia question', async run() {
    const d = (await get('https://opentdb.com/api.php?amount=1')).results[0];
    return { title: clean(d.category), text: `${clean(d.question)}\n\nAnswer: ${clean(d.correct_answer)}` };
  } },
  xkcd: { n: 'xkcd Comic', i: '🖍️', c: 'Fun', d: 'A random xkcd comic', async run() {
    const latest = await get('https://xkcd.com/info.0.json');
    const d = await get(`https://xkcd.com/${1 + Math.floor(Math.random() * latest.num)}/info.0.json`);
    return { title: d.title, text: d.alt, image: d.img, link: `https://xkcd.com/${d.num}` };
  } },
  poem: { n: 'Poem of the Moment', i: '🪶', c: 'Fun', d: 'A random classic poem', async run() {
    const d = (await get('https://poetrydb.org/random/1'))[0];
    return { title: `${d.title}, ${d.author}`, text: d.lines.slice(0, 24).join('\n') };
  } },
  dog: { n: 'Random Dog', i: '🐶', c: 'Fun', d: 'Instant serotonin', async run() {
    return { title: 'Good dog', text: 'You needed this.', image: (await get('https://dog.ceo/api/breeds/image/random')).message };
  } },
  cat: { n: 'Random Cat', i: '🐱', c: 'Fun', d: 'A cat judges you', async run() {
    return { title: 'Cat', text: 'It knows what you did.', image: (await get('https://api.thecatapi.com/v1/images/search'))[0].url };
  } },
  fox: { n: 'Random Fox', i: '🦊', c: 'Fun', d: 'What does it say?', async run() {
    return { title: 'Fox', text: 'Still unclear what it says.', image: (await get('https://randomfox.ca/floof/')).image };
  } },
  pokemon: { n: 'Pokédex', i: '⚡', c: 'Entertainment', d: 'Look up any Pokémon', ask: 'pikachu', async run(q) {
    const d = await get(`https://pokeapi.co/api/v2/pokemon/${E(q.toLowerCase().trim())}`);
    return { title: d.name, text: `Type: ${d.types.map((t) => t.type.name).join(', ')}\nAbilities: ${d.abilities.map((a) => a.ability.name).join(', ')}\n${d.stats.map((s) => `${s.stat.name} ${s.base_stat}`).join(', ')}`, image: d.sprites.other?.['official-artwork']?.front_default };
  } },
  tv: { n: 'TV Shows', i: '📺', c: 'Entertainment', d: 'Ratings and plots for any show', ask: 'Show name', async run(q) {
    const s = (await get(`https://api.tvmaze.com/search/shows?q=${E(q)}`))[0]?.show || notFound(q);
    return { title: s.name, text: `Rating: ${s.rating?.average ?? 'n/a'}\nGenres: ${s.genres.join(', ')}\nStatus: ${s.status}\n${clean(s.summary)}`, image: s.image?.medium, link: s.url };
  } },
  anime: { n: 'Anime', i: '🍥', c: 'Entertainment', d: 'Scores and synopsis', ask: 'Anime name', async run(q) {
    const a = (await get(`https://api.jikan.moe/v4/anime?q=${E(q)}&limit=1&sfw=true`)).data[0] || notFound(q);
    return { title: a.title, text: `Score: ${a.score ?? 'n/a'}\nEpisodes: ${a.episodes ?? 'n/a'}\n${a.synopsis || ''}`, image: a.images?.jpg?.image_url, link: a.url };
  } },
  music: { n: 'Music Search', i: '🎵', c: 'Entertainment', d: 'Songs and artists', ask: 'Song or artist', async run(q) {
    const d = await get(`https://itunes.apple.com/search?term=${E(q)}&entity=song&limit=5`);
    if (!d.results.length) notFound(q);
    return { title: `Music: ${q}`, text: d.results.map((r) => `${r.trackName}, ${r.artistName} (${r.collectionName})`).join('\n'), image: d.results[0].artworkUrl100, link: d.results[0].trackViewUrl };
  } },
  rickmorty: { n: 'Rick & Morty', i: '🛸', c: 'Entertainment', d: 'Character lookup', ask: 'Character', async run(q) {
    const c = (await get(`https://rickandmortyapi.com/api/character/?name=${E(q)}`)).results[0];
    return { title: c.name, text: `${c.status}, ${c.species}\nFrom ${c.origin.name}`, image: c.image };
  } },
  chess: { n: 'Chess Stats', i: '♟️', c: 'Entertainment', d: 'Ratings for a Chess.com player', ask: 'Username', async run(q) {
    const d = await get(`https://api.chess.com/pub/player/${E(q.toLowerCase().trim())}/stats`);
    return { title: q, text: ['chess_blitz', 'chess_rapid', 'chess_bullet'].filter((k) => d[k]).map((k) => `${k.replace('chess_', '')}: ${d[k].last.rating} (best ${d[k].best?.rating ?? 'n/a'})`).join('\n') || notFound(q) };
  } },
  recipes: { n: 'Recipes', i: '🍳', c: 'Food', d: 'Full recipes for any dish', ask: 'Dish', async run(q) {
    const m = (await get(`https://www.themealdb.com/api/json/v1/1/search.php?s=${E(q)}`)).meals?.[0] || notFound(q);
    const items = Array.from({ length: 20 }, (_, i) => m[`strIngredient${i + 1}`] && `${m[`strMeasure${i + 1}`]?.trim()} ${m[`strIngredient${i + 1}`]}`.trim()).filter(Boolean);
    return { title: m.strMeal, text: `${items.join(', ')}\n\n${m.strInstructions.slice(0, 1200)}`, image: m.strMealThumb, link: m.strSource || m.strYoutube };
  } },
  cocktails: { n: 'Mocktails & Cocktails', i: '🍹', c: 'Food', d: 'How to make any drink', ask: 'Drink', async run(q) {
    const m = (await get(`https://www.thecocktaildb.com/api/json/v1/1/search.php?s=${E(q)}`)).drinks?.[0] || notFound(q);
    const items = Array.from({ length: 15 }, (_, i) => m[`strIngredient${i + 1}`]).filter(Boolean);
    return { title: m.strDrink, text: `${m.strAlcoholic}\n${items.join(', ')}\n\n${m.strInstructions}`, image: m.strDrinkThumb };
  } },
  nutrition: { n: 'Food Scanner', i: '🥫', c: 'Food', d: 'Nutrition facts for packaged foods', ask: 'Product', async run(q) {
    const p = (await get(`https://world.openfoodfacts.org/cgi/search.pl?search_terms=${E(q)}&json=1&page_size=1&fields=product_name,brands,nutriments,image_small_url,nutriscore_grade`)).products?.[0] || notFound(q);
    const n = p.nutriments || {};
    return { title: `${p.product_name || q}${p.brands ? `, ${p.brands}` : ''}`, text: `Per 100g: ${Math.round(n['energy-kcal_100g'] ?? 0)} kcal, sugar ${n.sugars_100g ?? 'n/a'}g, fat ${n.fat_100g ?? 'n/a'}g, protein ${n.proteins_100g ?? 'n/a'}g\nNutri-Score: ${(p.nutriscore_grade || 'n/a').toUpperCase()}`, image: p.image_small_url };
  } },
  prayer: { n: 'Prayer Times', i: '🕌', c: 'Faith', d: 'Today’s prayer times by city', ask: 'City, Country', async run(q) {
    const [city, country] = q.split(',').map((s) => s.trim());
    let c = country;
    if (!c) c = (await place(city)).country;
    const t = (await get(`https://api.aladhan.com/v1/timingsByCity?city=${E(city)}&country=${E(c)}`)).data.timings;
    return { title: `${city}, ${c}`, text: ['Fajr', 'Sunrise', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'].map((k) => `${k}: ${t[k]}`).join('\n') };
  } },
  quran: { n: 'Quran Verse', i: '📿', c: 'Faith', d: 'A verse with English translation. Use chapter:verse', ask: '2:255', optional: true, async run(q) {
    const ref = q.trim() || String(1 + Math.floor(Math.random() * 6236));
    const d = (await get(`https://api.alquran.cloud/v1/ayah/${E(ref)}/editions/quran-uthmani,en.asad`)).data;
    return { title: `${d[0].surah.englishName} ${d[0].surah.number}:${d[0].numberInSurah}`, text: `${d[0].text}\n\n${d[1].text}` };
  } },
  bible: { n: 'Bible Verse', i: '✝️', c: 'Faith', d: 'Look up any passage', ask: 'John 3:16', async run(q) {
    const d = await get(`https://bible-api.com/${E(q)}`);
    return { title: d.reference, text: d.text.trim() };
  } },
};

const catalog = () => Object.entries(PLUGINS).map(([id, p]) => ({ id, name: p.n, icon: p.i, cat: p.c, desc: p.d, ask: p.ask || null, optional: !!p.optional, tool: !!p.tool }));

async function runPlugin(id, query) {
  if (!Object.hasOwn(PLUGINS, id)) throw new Error('Unknown plugin');
  const p = PLUGINS[id];
  const q = String(query || '').trim().slice(0, 500);
  if (p.ask && !p.optional && !q) throw new Error(`Please enter: ${p.ask}`);
  const out = await p.run(q);
  return { plugin: p.n, icon: p.i, title: clean(out.title).slice(0, 160), text: String(out.text || '').slice(0, 2400), image: out.image, link: out.link };
}

const toolDefs = (enabled) => Object.entries(PLUGINS)
  .filter(([id, p]) => p.tool && (!Array.isArray(enabled) || enabled.includes(id)))
  .map(([id, p]) => ({ type: 'function', function: { name: id, description: `${p.n}: ${p.d}.`, parameters: { type: 'object', properties: { query: { type: 'string', description: p.ask ? `Input, for example: ${p.ask}` : 'Leave empty' } }, required: ['query'] } } }));

module.exports = { catalog, runPlugin, toolDefs, pick };
