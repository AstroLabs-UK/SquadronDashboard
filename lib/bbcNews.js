// Scrapes the BBC News homepage for a clean set of headlines suitable for the
// dashboard carousel. Uses the homepage HTML (not the public RSS) so we get
// thumbnails and short descriptions that look good on screen.
//
// Parsing is deliberately tolerant: BBC change class names often. We key off
// relatively stable data-testid="promo" cards and the PromoHeadline / Paragraph
// patterns currently used on www.bbc.co.uk/news.
const https = require('https');
const http = require('http');
const { URL } = require('url');

const HOME = 'https://www.bbc.co.uk/news';
const UA = 'Mozilla/5.0 (compatible; SquadronDashboard/1.6; +local kiosk news widget)';

function fetchText(url, redirectsLeft = 4) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) { return reject(e); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-GB,en;q=0.9',
        'Cache-Control': 'no-cache'
      },
      timeout: 12000
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(fetchText(next, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('BBC HTTP ' + res.statusCode));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('BBC fetch timeout')); });
    req.on('error', reject);
    req.end();
  });
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function absUrl(href) {
  if (!href) return '';
  try {
    const u = new URL(href, 'https://www.bbc.co.uk');
    if (u.hostname.endsWith('bbc.co.uk') || u.hostname.endsWith('bbci.co.uk') || u.hostname.endsWith('bbc.com')) {
      return u.toString();
    }
  } catch (e) {}
  return '';
}

function pickImage(block) {
  // Prefer a mid-size ichef candidate from srcSet / srcset
  const srcset = block.match(/srcSet=["']([^"']+)["']/i) || block.match(/srcset=["']([^"']+)["']/i);
  if (srcset) {
    const parts = srcset[1].split(',').map(p => p.trim().split(/\s+/));
    // Prefer ~800w, else largest
    let best = '';
    let bestW = 0;
    for (const [url, w] of parts) {
      const u = absUrl(url);
      if (!u) continue;
      const width = parseInt(String(w || '').replace(/w$/i, ''), 10) || 0;
      if (width >= 600 && width <= 900) return u.replace(/\.webp$/i, '');
      if (width >= bestW) { bestW = width; best = u; }
    }
    if (best) return best.replace(/\.webp$/i, '');
  }
  const src = block.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (src) {
    const u = absUrl(src[1]);
    if (u) return u.replace(/\.webp$/i, '');
  }
  return '';
}

function scrapeArticles(html) {
  const items = [];
  const seen = new Set();

  // Split on promo markers; each chunk is roughly one card
  const parts = html.split(/data-testid=["']promo["']/i);
  for (let i = 1; i < parts.length && items.length < 16; i++) {
    const block = parts[i].slice(0, 3500);

    // Skip pure live pages for the carousel (they churn too fast / less useful as static cards)
    const linkMatch = block.match(/href=["']([^"']+)["']/i);
    if (!linkMatch) continue;
    const link = absUrl(linkMatch[1]);
    if (!link || seen.has(link)) continue;
    if (/\/live\//.test(link) && !/\/news\/articles\//.test(link)) continue;

    let title = '';
    const headline = block.match(/PromoHeadline[^>]*>[\s\S]*?<span[^>]*>([^<]{8,200})<\/span>/i)
      || block.match(/<p[^>]*PromoHeadline[^>]*>[\s\S]*?<span[^>]*>([^<]{8,200})<\/span>/i)
      || block.match(/aria-hidden=["']false["']>([^<]{8,200})</i);
    if (headline) title = stripTags(headline[1]);
    if (!title) {
      const h = block.match(/<h[23][^>]*>[\s\S]*?<span[^>]*>([^<]{8,200})<\/span>/i);
      if (h) title = stripTags(h[1]);
    }
    if (!title || title.length < 8) continue;

    let description = '';
    const para = block.match(/<p[^>]*Paragraph[^>]*>([\s\S]*?)<\/p>/i)
      || block.match(/<p class="[^"]*Paragraph[^"]*">([\s\S]*?)<\/p>/i);
    if (para) {
      description = stripTags(para[1]).slice(0, 220);
      if (description === title) description = '';
    }

    const thumbnail = pickImage(block);
    seen.add(link);
    items.push({ title, link, description, thumbnail });
  }

  // Fallback if promo structure changes drastically
  if (items.length < 4) {
    const aRe = /<a[^>]+href=["']((?:https?:\/\/www\.bbc\.co\.uk)?\/news\/(?:articles\/|[^"']+))["'][^>]*>[\s\S]*?<span[^>]*>([^<]{12,180})<\/span>/gi;
    let m;
    while ((m = aRe.exec(html)) && items.length < 12) {
      const link = absUrl(m[1]);
      if (!link || seen.has(link) || /\/live\//.test(link)) continue;
      const title = stripTags(m[2]);
      if (!title) continue;
      seen.add(link);
      items.push({ title, link, description: '', thumbnail: '' });
    }
  }

  return items.slice(0, 12);
}

async function fetchBbcNews() {
  const html = await fetchText(HOME);
  const items = scrapeArticles(html);
  if (!items.length) throw new Error('No BBC news articles parsed from homepage');
  return items;
}

module.exports = { fetchBbcNews, scrapeArticles };
