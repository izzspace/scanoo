#!/usr/bin/env node
/**
 * Scanoo — Outil d'audit automatisé de présence en ligne
 * Usage: node audit.js <url>
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const axios = require('axios');
const cheerio = require('cheerio');

// Allow self-signed / unverifiable certs when fetching target sites
// (the audit tool is checking the *content*, not the certificate chain via axios)
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// ─── Utilitaires ────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await axios.get(url, {
      ...options,
      signal: controller.signal,
      timeout: timeoutMs,
      validateStatus: () => true,
      maxRedirects: 5,
      httpsAgent,
    });
    clearTimeout(timer);
    return resp;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

// ─── 1. PageSpeed Insights ──────────────────────────────────────────────────

async function checkPageSpeed(url) {
  try {
    // Mobile
    const mobileUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=mobile`;
    // Desktop
    const desktopUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=desktop`;

    const [mobileResp, desktopResp] = await Promise.all([
      fetchWithTimeout(mobileUrl, { httpsAgent: new (require('https').Agent)({ rejectUnauthorized: true }) }, 30000)
        .catch(e => ({ data: null, error: e.message })),
      fetchWithTimeout(desktopUrl, { httpsAgent: new (require('https').Agent)({ rejectUnauthorized: true }) }, 30000)
        .catch(e => ({ data: null, error: e.message })),
    ]);

    const extractMetrics = (resp) => {
      if (!resp.data || resp.error) return null;
      const d = resp.data;
      const cats = d.lighthouseResult?.categories || {};
      const audits = d.lighthouseResult?.audits || {};
      return {
        performance: Math.round((cats.performance?.score || 0) * 100),
        accessibility: Math.round((cats.accessibility?.score || 0) * 100),
        seo: Math.round((cats.seo?.score || 0) * 100),
        bestPractices: Math.round((cats['best-practices']?.score || 0) * 100),
        fcp: audits['first-contentful-paint']?.displayValue || 'N/A',
        lcp: audits['largest-contentful-paint']?.displayValue || 'N/A',
        tbt: audits['total-blocking-time']?.displayValue || 'N/A',
        cls: audits['cumulative-layout-shift']?.displayValue || 'N/A',
        tti: audits['interactive']?.displayValue || 'N/A',
        speedIndex: audits['speed-index']?.displayValue || 'N/A',
        mobileFriendly: audits['viewport']?.score === 1,
        textCompression: audits['uses-text-compression']?.score === 1,
        imageOptimization: audits['uses-optimized-images']?.score === 1,
      };
    };

    return {
      mobile: extractMetrics(mobileResp),
      desktop: extractMetrics(desktopResp),
    };
  } catch (e) {
    return { error: e.message, mobile: null, desktop: null };
  }
}

// ─── 2. SSL Check ───────────────────────────────────────────────────────────

async function checkSSL(url) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') {
        return resolve({ valid: false, error: 'Site non HTTPS', daysLeft: 0 });
      }
      const req = https.request(
        { host: parsed.hostname, port: 443, method: 'HEAD', path: '/', rejectUnauthorized: false },
        (res) => {
          const cert = res.socket?.getPeerCertificate?.();
          if (!cert || Object.keys(cert).length === 0) {
            return resolve({ valid: false, error: 'Impossible de lire le certificat', daysLeft: 0 });
          }
          const expiry = new Date(cert.valid_to);
          const now = new Date();
          const daysLeft = Math.floor((expiry - now) / (1000 * 60 * 60 * 24));
          resolve({
            valid: daysLeft > 0,
            expiresAt: expiry.toISOString(),
            daysLeft,
            issuer: cert.issuer?.O || cert.issuer?.CN || 'Inconnu',
            subject: cert.subject?.CN || parsed.hostname,
          });
          res.destroy();
        }
      );
      req.on('error', (e) => resolve({ valid: false, error: e.message, daysLeft: 0 }));
      req.setTimeout(8000, () => { req.destroy(); resolve({ valid: false, error: 'Timeout', daysLeft: 0 }); });
      req.end();
    } catch (e) {
      resolve({ valid: false, error: e.message, daysLeft: 0 });
    }
  });
}

// ─── 3. HTML Fetch & Meta Tags ──────────────────────────────────────────────

async function fetchHTML(url) {
  const resp = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Scanoo-bot/1.0; +https://scanoo.fr)',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
    },
  }, 15000);
  return { html: resp.data, status: resp.status, headers: resp.headers };
}

async function checkSEOMeta(url) {
  try {
    const { html, status } = await fetchHTML(url);
    if (typeof html !== 'string') throw new Error('Réponse non HTML');
    const $ = cheerio.load(html);

    const title = $('title').first().text().trim();
    const description = $('meta[name="description"]').attr('content') || '';
    const h1Tags = $('h1').map((_, el) => $(el).text().trim()).get();
    const h2Tags = $('h2').map((_, el) => $(el).text().trim()).get().slice(0, 5);
    const h3Tags = $('h3').map((_, el) => $(el).text().trim()).get().slice(0, 5);

    // Images alt
    const allImages = $('img');
    const totalImages = allImages.length;
    const imagesWithoutAlt = allImages.filter((_, el) => !$(el).attr('alt')?.trim()).length;

    // Canonical
    const canonical = $('link[rel="canonical"]').attr('href') || null;

    // Lang
    const lang = $('html').attr('lang') || null;

    // Robots
    const robots = $('meta[name="robots"]').attr('content') || null;

    // Viewport
    const viewport = $('meta[name="viewport"]').attr('content') || null;

    // Charset
    const charset = $('meta[charset]').attr('charset') ||
      $('meta[http-equiv="content-type"]').attr('content')?.match(/charset=([^\s;]+)/i)?.[1] || null;

    // Open Graph
    const og = {
      title: $('meta[property="og:title"]').attr('content') || null,
      description: $('meta[property="og:description"]').attr('content') || null,
      image: $('meta[property="og:image"]').attr('content') || null,
      type: $('meta[property="og:type"]').attr('content') || null,
      url: $('meta[property="og:url"]').attr('content') || null,
      siteName: $('meta[property="og:site_name"]').attr('content') || null,
    };

    // Twitter Cards
    const twitter = {
      card: $('meta[name="twitter:card"]').attr('content') || null,
      title: $('meta[name="twitter:title"]').attr('content') || null,
      description: $('meta[name="twitter:description"]').attr('content') || null,
      image: $('meta[name="twitter:image"]').attr('content') || null,
    };

    // Structured data
    const structuredData = [];
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const parsed = JSON.parse($(el).html());
        structuredData.push(parsed);
      } catch (e) { /* ignore invalid JSON-LD */ }
    });

    // Social links
    const socialLinks = {
      facebook: null,
      twitter: null,
      instagram: null,
      linkedin: null,
      youtube: null,
    };
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (href.includes('facebook.com')) socialLinks.facebook = href;
      if (href.includes('twitter.com') || href.includes('x.com')) socialLinks.twitter = href;
      if (href.includes('instagram.com')) socialLinks.instagram = href;
      if (href.includes('linkedin.com')) socialLinks.linkedin = href;
      if (href.includes('youtube.com')) socialLinks.youtube = href;
    });

    // Word count
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
    const wordCount = bodyText.split(' ').filter(w => w.length > 2).length;

    return {
      title,
      titleLength: title.length,
      description,
      descriptionLength: description.length,
      h1: h1Tags,
      h2: h2Tags,
      h3: h3Tags,
      canonical,
      lang,
      robots,
      viewport,
      charset,
      og,
      twitter,
      structuredData,
      socialLinks,
      images: { total: totalImages, withoutAlt: imagesWithoutAlt },
      wordCount,
      httpStatus: status,
    };
  } catch (e) {
    return { error: e.message };
  }
}

// ─── 4. Headers de sécurité ─────────────────────────────────────────────────

async function checkSecurityHeaders(url) {
  try {
    const resp = await fetchWithTimeout(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Scanoo-bot/1.0)' },
    }, 10000);
    const headers = resp.headers;

    const checks = {
      strictTransportSecurity: !!headers['strict-transport-security'],
      contentSecurityPolicy: !!headers['content-security-policy'],
      xFrameOptions: !!headers['x-frame-options'],
      xContentTypeOptions: !!headers['x-content-type-options'],
      referrerPolicy: !!headers['referrer-policy'],
      permissionsPolicy: !!(headers['permissions-policy'] || headers['feature-policy']),
      xXssProtection: !!headers['x-xss-protection'],
      cacheControl: !!headers['cache-control'],
    };

    const values = {
      server: headers['server'] || null,
      poweredBy: headers['x-powered-by'] || null,
      strictTransportSecurity: headers['strict-transport-security'] || null,
      contentSecurityPolicy: headers['content-security-policy'] || null,
      xFrameOptions: headers['x-frame-options'] || null,
      xContentTypeOptions: headers['x-content-type-options'] || null,
      referrerPolicy: headers['referrer-policy'] || null,
    };

    const score = Object.values(checks).filter(Boolean).length;
    const maxScore = Object.keys(checks).length;

    return { checks, values, score, maxScore };
  } catch (e) {
    return { error: e.message };
  }
}

// ─── 5. Technologies détectées ──────────────────────────────────────────────

async function detectTechnologies(url) {
  try {
    const { html, headers } = await fetchHTML(url);
    if (typeof html !== 'string') return { error: 'Non HTML' };
    const $ = cheerio.load(html);
    const tech = {
      cms: [],
      frameworks: [],
      analytics: [],
      cdn: [],
      server: null,
      other: [],
    };

    // CMS detection
    if (html.includes('/wp-content/') || html.includes('wp-json')) tech.cms.push('WordPress');
    if (html.includes('Joomla')) tech.cms.push('Joomla');
    if (html.includes('Drupal')) tech.cms.push('Drupal');
    if (html.includes('shopify') || html.includes('Shopify')) tech.cms.push('Shopify');
    if (html.includes('wix.com') || html.includes('Wix.')) tech.cms.push('Wix');
    if (html.includes('squarespace') || html.includes('Squarespace')) tech.cms.push('Squarespace');
    if (html.includes('webflow.com') || html.includes('Webflow')) tech.cms.push('Webflow');
    if (html.includes('prestashop')) tech.cms.push('PrestaShop');
    if (html.includes('magento')) tech.cms.push('Magento');

    // Frameworks JS
    if (html.includes('react') || html.includes('React')) tech.frameworks.push('React');
    if (html.includes('vue.js') || html.includes('Vue.js') || html.includes('__vue')) tech.frameworks.push('Vue.js');
    if (html.includes('angular') || html.includes('Angular')) tech.frameworks.push('Angular');
    if (html.includes('next.js') || html.includes('_next/')) tech.frameworks.push('Next.js');
    if (html.includes('nuxt') || html.includes('__nuxt')) tech.frameworks.push('Nuxt.js');
    if (html.includes('jquery') || html.includes('jQuery')) tech.frameworks.push('jQuery');
    if (html.includes('bootstrap') || html.includes('Bootstrap')) tech.frameworks.push('Bootstrap');
    if (html.includes('tailwind') || html.includes('Tailwind')) tech.frameworks.push('Tailwind CSS');

    // Analytics
    if (html.includes('google-analytics.com') || html.includes('gtag') || html.includes('GA_MEASUREMENT_ID')) tech.analytics.push('Google Analytics');
    if (html.includes('googletagmanager.com') || html.includes('GTM-')) tech.analytics.push('Google Tag Manager');
    if (html.includes('matomo') || html.includes('Matomo')) tech.analytics.push('Matomo');
    if (html.includes('hotjar')) tech.analytics.push('Hotjar');
    if (html.includes('plausible.io')) tech.analytics.push('Plausible');
    if (html.includes('pixel') && html.includes('facebook.com')) tech.analytics.push('Meta Pixel');

    // CDN / Hosting hints
    const server = headers['server'] || '';
    tech.server = server || null;
    if (server.toLowerCase().includes('cloudflare')) tech.cdn.push('Cloudflare');
    if (headers['x-served-by']?.includes('cache')) tech.cdn.push('Fastly');
    if (headers['x-vercel-id']) tech.cdn.push('Vercel');
    if (headers['x-amz-cf-id'] || headers['x-amz-request-id']) tech.cdn.push('AWS CloudFront/S3');
    if (headers['x-netlify-id'] || headers['netlify-vary']) tech.cdn.push('Netlify');

    return tech;
  } catch (e) {
    return { error: e.message };
  }
}

// ─── 6. Liens cassés (sample) ───────────────────────────────────────────────

async function checkBrokenLinks(url, maxLinks = 20) {
  try {
    const { html } = await fetchHTML(url);
    if (typeof html !== 'string') return { error: 'Non HTML', broken: [], checked: 0 };
    const $ = cheerio.load(html);
    const base = new URL(url);

    const links = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
      try {
        const absolute = new URL(href, url).href;
        // Only check internal links for now (avoid hammering third-party sites)
        if (new URL(absolute).hostname === base.hostname) {
          links.push(absolute);
        }
      } catch (e) { /* invalid URL */ }
    });

    // Deduplicate and limit
    const uniqueLinks = [...new Set(links)].slice(0, maxLinks);

    const results = await Promise.allSettled(
      uniqueLinks.map(async (link) => {
        try {
          const resp = await fetchWithTimeout(link, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Scanoo-bot/1.0)' },
          }, 8000);
          return { url: link, status: resp.status, ok: resp.status < 400 };
        } catch (e) {
          return { url: link, status: null, ok: false, error: e.message };
        }
      })
    );

    const checked = results.map(r => r.value || r.reason);
    const broken = checked.filter(r => !r.ok);

    return { checked: checked.length, total: uniqueLinks.length, broken };
  } catch (e) {
    return { error: e.message, broken: [], checked: 0 };
  }
}

// ─── 7. Scoring ─────────────────────────────────────────────────────────────

function computeScore(data) {
  const scores = {};
  let totalWeight = 0;
  let totalScore = 0;

  // Performance (25 pts)
  // Use actual scores only if PageSpeed API returned real data (non-zero or explicitly set metrics)
  const mobilePerf = data.pageSpeed?.mobile;
  const desktopPerf = data.pageSpeed?.desktop;
  const psAvailable = (mobilePerf && mobilePerf.fcp !== 'N/A') || (desktopPerf && desktopPerf.fcp !== 'N/A');
  const perfScore = psAvailable
    ? (mobilePerf?.performance ?? desktopPerf?.performance ?? 50)
    : null;
  scores.performance = {
    score: perfScore !== null ? Math.round(perfScore * 0.25) : 12,  // 12/25 = neutral if API unavailable
    max: 25,
    label: 'Performance',
    apiAvailable: psAvailable,
  };

  // SEO (25 pts)
  let seoScore = 0;
  const seo = data.seo || {};
  if (!seo.error) {
    if (seo.title && seo.title.length >= 20 && seo.title.length <= 70) seoScore += 5;
    else if (seo.title) seoScore += 2;
    if (seo.description && seo.description.length >= 50 && seo.description.length <= 160) seoScore += 5;
    else if (seo.description) seoScore += 2;
    if (seo.h1?.length === 1) seoScore += 4;
    else if (seo.h1?.length > 1) seoScore += 2;
    if (seo.canonical) seoScore += 3;
    if (seo.lang) seoScore += 2;
    if (seo.images?.total > 0 && seo.images.withoutAlt === 0) seoScore += 3;
    else if (seo.images?.total > 0 && seo.images.withoutAlt < seo.images.total / 2) seoScore += 1;
    if (seo.structuredData?.length > 0) seoScore += 3;
    seoScore = Math.min(seoScore, 25);
  } else {
    seoScore = 10;
  }
  scores.seo = { score: seoScore, max: 25, label: 'SEO' };

  // Security (20 pts)
  let secScore = 0;
  if (data.ssl?.valid) secScore += 8;
  else if (data.ssl?.daysLeft > 0) secScore += 4;
  const headers = data.securityHeaders?.checks || {};
  if (headers.strictTransportSecurity) secScore += 3;
  if (headers.contentSecurityPolicy) secScore += 2;
  if (headers.xFrameOptions) secScore += 2;
  if (headers.xContentTypeOptions) secScore += 2;
  if (headers.referrerPolicy) secScore += 1;
  if (headers.permissionsPolicy) secScore += 1;
  if (headers.xXssProtection) secScore += 1;
  secScore = Math.min(secScore, 20);
  scores.security = { score: secScore, max: 20, label: 'Sécurité' };

  // Mobile (15 pts)
  let mobileScore = 0;
  const psMobile = data.pageSpeed?.mobile;
  const mobileApiAvail = psMobile && psMobile.fcp !== 'N/A';
  if (mobileApiAvail) {
    if (psMobile.performance >= 90) mobileScore += 8;
    else if (psMobile.performance >= 70) mobileScore += 5;
    else if (psMobile.performance >= 50) mobileScore += 3;
    if (psMobile.mobileFriendly) mobileScore += 7;
  } else {
    // Fallback: check viewport meta tag
    if (data.seo?.viewport) mobileScore += 7;
  }
  mobileScore = Math.min(mobileScore, 15);
  scores.mobile = { score: mobileScore, max: 15, label: 'Mobile' };

  // Social / OG (15 pts)
  let socialScore = 0;
  const og = data.seo?.og || {};
  if (og.title) socialScore += 3;
  if (og.description) socialScore += 3;
  if (og.image) socialScore += 4;
  const tw = data.seo?.twitter || {};
  if (tw.card) socialScore += 2;
  if (tw.image) socialScore += 3;
  socialScore = Math.min(socialScore, 15);
  scores.social = { score: socialScore, max: 15, label: 'Réseaux sociaux' };

  const total = Object.values(scores).reduce((sum, s) => sum + s.score, 0);
  const maxTotal = Object.values(scores).reduce((sum, s) => sum + s.max, 0);

  return { total, max: maxTotal, breakdown: scores };
}

// ─── 8. Recommandations ─────────────────────────────────────────────────────

function generateRecommendations(data, score) {
  const recs = [];

  // SSL
  if (!data.ssl?.valid) {
    recs.push({ priority: 'critique', category: 'Sécurité', action: 'Ton site n\'est pas sécurisé (pas de cadenas)', impact: 'Très élevé', difficulty: 'Facile',
      solution: 'Quand tes clients visitent ton site, leur navigateur affiche "Non sécurisé" à côté de l\'adresse. Ça fait fuir.\n\nCe qu\'il faut faire :\n-> Appelle ton hébergeur (celui chez qui tu paies ton site) et demande : "Je voudrais activer le certificat SSL gratuit sur mon site." C\'est souvent fait en 5 minutes par leur support.\n\nRésultat : le petit cadenas vert apparaît -> tes visiteurs ont confiance -> Google te met mieux dans les résultats.' });
  } else if (data.ssl?.daysLeft < 30) {
    recs.push({ priority: 'urgent', category: 'Sécurité', action: `Ton cadenas de sécurité expire dans ${data.ssl.daysLeft} jours`, impact: 'Élevé', difficulty: 'Facile',
      solution: `Ton site est sécurisé, mais le certificat expire bientôt. Si rien n'est fait, tes visiteurs verront un gros avertissement "Site dangereux".\n\nCe qu'il faut faire :\n-> Appelle ton hébergeur et demande : "Mon certificat SSL expire bientôt, peux-tu le renouveler ?" Normalement c'est automatique, mais mieux vaut vérifier.\n\nC'est gratuit et ça prend 2 minutes au téléphone.` });
  }

  // SEO
  const seo = data.seo || {};
  if (!seo.title) {
    recs.push({ priority: 'élevé', category: 'Référencement', action: 'Ton site n\'a pas de titre dans Google', impact: 'Élevé', difficulty: 'Facile',
      solution: 'Quand quelqu\'un cherche ton activité sur Google, ton site apparaît sans titre clair. Résultat : personne ne clique dessus.\n\nCe qu\'il faut faire :\n-> Demande à la personne qui gère ton site d\'ajouter un titre. Donne-lui cette phrase :\n"[Ton métier] à [Ta ville] — [Nom de ton entreprise]"\nExemple : "Plombier à Lyon — Martin Plomberie"\n\nSi tu es sur WordPress, tu peux le faire toi-même : Réglages -> Général -> Titre du site.\n\nRésultat : les gens qui cherchent ton métier sur Google voient clairement qui tu es -> plus de clics -> plus de clients.' });
  } else if (seo.title.length < 20 || seo.title.length > 70) {
    recs.push({ priority: 'moyen', category: 'Référencement', action: `Le titre de ton site dans Google n'est pas optimal`, impact: 'Moyen', difficulty: 'Facile',
      solution: `Ton titre fait ${seo.title.length} caractères. ${seo.title.length < 20 ? 'Il est trop court — Google ne comprend pas bien ce que tu fais.' : 'Il est trop long — Google le coupe et tes clients ne voient pas tout.'}\n\nCe qu'il faut faire :\n-> Demande à la personne qui gère ton site de modifier le titre avec ce format :\n"[Ton métier] à [Ta ville] | [Nom entreprise]"\n\nGarde ça entre 30 et 60 caractères, c'est la longueur idéale pour Google.` });
  }

  if (!seo.description) {
    recs.push({ priority: 'élevé', category: 'Référencement', action: 'Ton site n\'a pas de description dans Google', impact: 'Élevé', difficulty: 'Facile',
      solution: 'Dans les résultats Google, sous le titre de ton site, il y a normalement 2 lignes de description. Les tiennes sont vides ou affichent n\'importe quoi.\n\nCe qu\'il faut faire :\n-> Demande à la personne qui gère ton site d\'ajouter une description. Donne-lui ce texte (adapte-le) :\n"[Ton métier] à [Ville] depuis [X] ans. [Ton point fort]. Devis gratuit au [téléphone]."\n\nExemple : "Plombier à Paris depuis 15 ans. Intervention en 1h, 7j/7. Devis gratuit au 01 23 45 67 89."\n\nRésultat : les gens comprennent ce que tu fais -> ils cliquent -> ils t\'appellent. Ça peut augmenter tes visites de 20 à 30%.' });
  } else if (seo.description.length < 50 || seo.description.length > 160) {
    recs.push({ priority: 'moyen', category: 'Référencement', action: `La description de ton site dans Google n'est pas optimale`, impact: 'Moyen', difficulty: 'Facile',
      solution: `Ta description fait ${seo.description.length} caractères. ${seo.description.length < 50 ? 'C\'est trop court — Google risque de l\'ignorer.' : 'C\'est trop long — Google la coupe.'}\n\nCe qu'il faut faire :\n-> Réécris-la en 120-155 caractères. Inclus : ce que tu fais + où + pourquoi te choisir.\n-> Demande à la personne qui s\'occupe de ton site de la mettre à jour.` });
  }

  if (!seo.h1 || seo.h1.length === 0) {
    recs.push({ priority: 'élevé', category: 'Référencement', action: 'Il manque un titre principal sur ta page d\'accueil', impact: 'Élevé', difficulty: 'Facile',
      solution: 'Ta page d\'accueil n\'a pas de "gros titre" visible. C\'est comme une vitrine sans enseigne — Google ne comprend pas ce que tu vends.\n\nCe qu\'il faut faire :\n-> Demande à la personne qui gère ton site d\'ajouter un titre principal visible en haut de page, par exemple :\n"Plombier à Paris — Dépannage rapide 7j/7"\n\nC\'est le texte le plus important de ton site pour Google.' });
  } else if (seo.h1.length > 1) {
    recs.push({ priority: 'moyen', category: 'Référencement', action: `Ta page a ${seo.h1.length} titres principaux au lieu d'un seul`, impact: 'Moyen', difficulty: 'Facile',
      solution: `Ta page affiche ${seo.h1.length} titres principaux : ${seo.h1.map(h => '"' + h + '"').join(', ')}.\n\nLe problème : Google ne sait pas lequel est le vrai titre -> il comprend moins bien ta page.\n\nCe qu'il faut faire :\n-> Demande à la personne qui s\'occupe de ton site de garder UN SEUL titre principal (le plus important) et de transformer les autres en sous-titres.` });
  }

  if (seo.images?.withoutAlt > 0) {
    recs.push({ priority: 'moyen', category: 'Référencement', action: `${seo.images.withoutAlt} photo(s) de ton site sont invisibles pour Google`, impact: 'Moyen', difficulty: 'Facile',
      solution: `Google ne peut pas "voir" les photos. Il lit une description textuelle de chaque image. ${seo.images.withoutAlt} de tes photos n'ont pas de description -> Google les ignore complètement.\n\nCe qu'il faut faire :\n-> Demande à la personne qui s\'occupe de ton site d'ajouter une description à chaque photo. Exemple : pour une photo de ta boutique, la description serait "Boulangerie Martin à Bordeaux — façade".\n\nRésultat : tes photos peuvent apparaître dans Google Images -> des clients te trouvent par là aussi.` });
  }

  if (!seo.canonical) {
    recs.push({ priority: 'moyen', category: 'Référencement', action: 'Risque de pages en double dans Google', impact: 'Moyen', difficulty: 'Facile',
      solution: 'Ton site peut apparaître sous plusieurs adresses dans Google (avec www, sans www, etc.). Ça disperse ta visibilité.\n\nCe qu\'il faut faire :\n-> Demande à la personne qui s\'occupe de ton site d\'ajouter une "balise canonical" — dis-lui simplement : "Il faut indiquer à Google quelle est l\'adresse principale du site." Il saura quoi faire.\n\nC\'est une modification rapide (2 minutes) qui concentre toute ta puissance sur une seule adresse.' });
  }

  if (!seo.lang) {
    recs.push({ priority: 'faible', category: 'Référencement', action: 'Google ne sait pas que ton site est en français', impact: 'Faible', difficulty: 'Très facile',
      solution: 'Ton site ne précise pas qu\'il est en français. Google peut donc le proposer à des gens qui cherchent dans d\'autres langues.\n\nCe qu\'il faut faire :\n-> Dites à la personne qui s\'occupe de ton site : "Il faut indiquer la langue française sur le site." C\'est 10 secondes de travail pour lui.' });
  }

  // Structured data
  if (!seo.structuredData || seo.structuredData.length === 0) {
    recs.push({ priority: 'moyen', category: 'Référencement', action: 'Vos infos business n\'apparaissent pas directement dans Google', impact: 'Élevé', difficulty: 'Moyen',
      solution: 'Vous savez quand tu cherches un restaurant sur Google et tu vois directement ses horaires, son adresse, ses avis, son téléphone ? Ton site ne fait pas ça.\n\nCe qu\'il faut faire :\n-> Demande à la personne qui s\'occupe de ton site d\'ajouter des "données structurées" (il comprendra). Dis-lui : "Je veux que nos horaires, adresse et téléphone apparaissent directement dans les résultats Google."\n\nRésultat : tes clients trouvent ton téléphone et tes horaires sans même visiter ton site -> ils t\'appellent directement.' });
  }

  // Open Graph
  if (!seo.og?.image) {
    recs.push({ priority: 'moyen', category: 'Réseaux sociaux', action: 'Quand on partage ton site sur Facebook/WhatsApp, aucune image ne s\'affiche', impact: 'Moyen', difficulty: 'Facile',
      solution: 'Si un client satisfait partage ton site sur Facebook ou WhatsApp, le lien apparaît sans image — c\'est moche et personne ne clique dessus.\n\nCe qu\'il faut faire :\n-> Demande à la personne qui s\'occupe de ton site d\'ajouter une "image de partage" (aussi appelée Open Graph). Fournis-lui une belle photo de ton activité (ta vitrine, ton équipe, tes produits).\n\nRésultat : quand quelqu\'un partage ton site, ça affiche une belle image avec ton nom -> ça donne envie de cliquer.' });
  }

  // Security headers
  const sec = data.securityHeaders?.checks || {};
  if (!sec.strictTransportSecurity) {
    recs.push({ priority: 'moyen', category: 'Sécurité', action: 'Ton site n\'oblige pas la connexion sécurisée', impact: 'Moyen', difficulty: 'Moyen',
      solution: 'Même si ton site a le cadenas, quelqu\'un pourrait y accéder sans la protection sécurisée. C\'est une faille.\n\nCe qu\'il faut faire :\n-> Demande à ton hébergeur ou à la personne qui s\'occupe de ton site : "Je voudrais forcer la connexion HTTPS sur tout le site." C\'est un réglage courant, ils sauront faire.\n\nRésultat : tous tes visiteurs sont automatiquement protégés.' });
  }
  if (!sec.contentSecurityPolicy) {
    recs.push({ priority: 'faible', category: 'Sécurité', action: 'Protection avancée contre le piratage manquante', impact: 'Élevé', difficulty: 'Difficile',
      solution: 'Ton site manque d\'une protection avancée contre certaines attaques informatiques.\n\nCe qu\'il faut faire :\n-> Ce point est technique. Mentionne-le lors de ta prochaine refonte de site ou à ton prestataire web : "On m\'a recommandé d\'ajouter une une protection avancée." Il saura quoi faire.\n\nPas urgent, mais c\'est un plus pour la sécurité de tes visiteurs.' });
  }
  if (!sec.xFrameOptions) {
    recs.push({ priority: 'moyen', category: 'Sécurité', action: 'Ton site peut être copié par des sites malveillants', impact: 'Moyen', difficulty: 'Facile',
      solution: 'Des sites malveillants peuvent intégrer ton site dans le leur pour tromper tes clients (arnaque au clic).\n\nCe qu\'il faut faire :\n-> Demande à la personne qui s\'occupe de ton site : "Il faut ajouter la protection une protection contre le piratage sur le site." C\'est une modification simple et rapide.\n\nRésultat : impossible pour un site frauduleux d\'utiliser ton site pour arnaquer tes clients.' });
  }

  // Performance
  const perfMobile = data.pageSpeed?.mobile;
  const perfApiAvail = perfMobile && perfMobile.fcp !== 'N/A';
  if (perfApiAvail) {
    const perf = perfMobile.performance;
    if (perf < 50) {
      recs.push({ priority: 'élevé', category: 'Vitesse', action: 'Ton site est trop lent sur téléphone (score : ' + perf + '/100)', impact: 'Très élevé', difficulty: 'Difficile',
        solution: 'Plus de la moitié des gens quittent un site qui met plus de 3 secondes à charger. Le tien est en dessous de la moyenne.\n\nCe qu\'il faut faire :\n-> Demande à la personne qui s\'occupe de ton site de faire 3 choses :\n  1. Réduire la taille des photos du site (elles sont probablement trop lourdes)\n  2. Activer le "cache" du site (ça accélère le chargement pour les visiteurs qui reviennent)\n  3. Activer la "compression" (ça réduit le poids des pages)\n\nSi tu es sur WordPress, dis-lui d\'installer un plugin de cache comme "LiteSpeed Cache" (gratuit).\n\nRésultat : ton site charge plus vite -> les visiteurs restent -> Google te met plus haut dans les résultats.' });
    } else if (perf < 70) {
      recs.push({ priority: 'moyen', category: 'Vitesse', action: 'Ton site pourrait charger plus vite sur téléphone (score : ' + perf + '/100)', impact: 'Élevé', difficulty: 'Moyen',
        solution: 'Ton site n\'est pas lent, mais il peut faire mieux. Chaque seconde gagnée = plus de clients qui restent.\n\nCe qu\'il faut faire :\n-> Demande à la personne qui s\'occupe de ton site de réduire la taille des images et d\'activer le cache du site.\n\nSi tu es sur WordPress, un simple plugin de cache (gratuit) peut faire une grande différence.' });
    }
    if (!perfMobile.textCompression) {
      recs.push({ priority: 'moyen', category: 'Vitesse', action: 'La compression n\'est pas activée sur ton site', impact: 'Élevé', difficulty: 'Facile',
        solution: 'C\'est comme envoyer un fichier par email sans le compresser — c\'est plus lourd et plus long.\n\nCe qu\'il faut faire :\n-> Demande à ton hébergeur d\'activer la "compression GZIP". C\'est souvent un simple bouton à cocher dans ton panneau d\'administration.\n\nRésultat : ton site charge 2 à 3 fois plus vite, surtout sur mobile.' });
    }
    if (!perfMobile.imageOptimization) {
      recs.push({ priority: 'moyen', category: 'Vitesse', action: 'Les photos de ton site sont trop lourdes', impact: 'Élevé', difficulty: 'Facile',
        solution: 'Les photos représentent souvent 80% du poids de ton site. Si elles sont trop grosses, tout rame.\n\nCe qu\'il faut faire :\n-> Avant de mettre une photo sur ton site, réduisez-la sur squoosh.app (gratuit, rien à installer). Ça prend 30 secondes par photo.\n-> Si tu es sur WordPress, demande à la personne qui s\'occupe de ton site d\'installer "ShortPixel" (gratuit) — il compresse automatiquement toutes les photos.\n\nRésultat : pages 2 à 5 fois plus légères = site rapide = clients contents.' });
    }
  } else {
    recs.push({ priority: 'moyen', category: 'Vitesse', action: 'Testez la vitesse de ton site', impact: 'Élevé', difficulty: 'Facile',
      solution: 'On n\'a pas pu mesurer la vitesse exacte de ton site, mais c\'est un facteur crucial.\n\nCe qu\'il faut faire :\n-> Va sur le site de test de vitesse de Google (pagespeed.web.dev), tapez l\'adresse de ton site, et regardez le score sur mobile.\n-> Si c\'est en dessous de 50 (rouge) : montrez le résultat à la personne qui s\'occupe de ton site et demandez-lui d\'optimiser.\n-> Si c\'est entre 50 et 90 (orange) : quelques améliorations simples suffisent.\n-> Au-dessus de 90 (vert) : tout est bon !\n\nUn site rapide = des clients qui restent. Un site lent = des clients qui partent chez le concurrent.' });
  }

  // Liens cassés
  if (data.brokenLinks?.broken?.length > 0) {
    const brokenUrls = data.brokenLinks.broken.map(b => b.url || b).slice(0, 5).join('\n  • ');
    recs.push({ priority: 'élevé', category: 'Technique', action: `${data.brokenLinks.broken.length} lien(s) sur ton site mènent vers des pages qui n'existent plus`, impact: 'Élevé', difficulty: 'Facile',
      solution: `Quand un visiteur clique sur un de ces liens, il tombe sur une page d'erreur. C'est frustrant et ça donne une mauvaise image.\n\nLiens concernés :\n  • ${brokenUrls}\n\nCe qu'il faut faire :\n-> Demande à la personne qui s\'occupe de ton site de vérifier ces liens et soit les corriger, soit les supprimer.\n\nRésultat : tes visiteurs naviguent sans problème sur ton site -> ils restent plus longtemps -> plus de chances qu'ils te contactent.` });
  }

  // Mobile friendly
  const mobileApiAvailForRec = data.pageSpeed?.mobile && data.pageSpeed.mobile.fcp !== 'N/A';
  if (mobileApiAvailForRec && !data.pageSpeed.mobile.mobileFriendly) {
    recs.push({ priority: 'critique', category: 'Mobile', action: 'Ton site est illisible sur téléphone', impact: 'Très élevé', difficulty: 'Difficile',
      solution: 'ATTENTION : C\'est le problème le plus grave de ton site.\n\n6 personnes sur 10 visitent ton site depuis leur téléphone. Si c\'est illisible (texte trop petit, boutons impossibles à cliquer, page qui déborde), ils partent immédiatement chez ton concurrent.\n\nEn plus, Google privilégie les sites adaptés au mobile dans ses résultats.\n\nCe qu\'il faut faire :\n-> Si ton site a été créé il y a plus de 5 ans, il est probablement temps de le refaire avec un outil moderne (WordPress, Wix, Squarespace — tous créent des sites adaptés au mobile automatiquement).\n-> Si ton site est récent, demande à la personne qui s\'occupe de ton site de le rendre "responsive" (adapté à tous les écrans).\n\nC\'est un investissement, mais c\'est LE plus rentable que tu puisses faire pour ta visibilité.' });
  }

  // Sort by priority
  const priorityOrder = { critique: 0, urgent: 1, élevé: 2, moyen: 3, faible: 4 };
  recs.sort((a, b) => (priorityOrder[a.priority] ?? 5) - (priorityOrder[b.priority] ?? 5));

  return recs.slice(0, 10);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function audit(url) {
  // Normalize URL
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  // Use HTTPS if available
  const targetUrl = url;

  console.error(`🔍 Audit de ${targetUrl}...`);

  const startTime = Date.now();

  console.error('  ⏳ Vérification SSL...');
  const ssl = await checkSSL(targetUrl);

  console.error('  ⏳ Analyse SEO & méta tags...');
  const seo = await checkSEOMeta(targetUrl);

  console.error('  ⏳ Analyse des headers de sécurité...');
  const securityHeaders = await checkSecurityHeaders(targetUrl);

  console.error('  ⏳ Détection des technologies...');
  const technologies = await detectTechnologies(targetUrl);

  console.error('  ⏳ Vérification des liens cassés...');
  const brokenLinks = await checkBrokenLinks(targetUrl);

  console.error('  ⏳ PageSpeed Insights (peut prendre ~30s)...');
  const pageSpeed = await checkPageSpeed(targetUrl);

  const elapsedMs = Date.now() - startTime;

  const data = { url: targetUrl, ssl, seo, securityHeaders, technologies, brokenLinks, pageSpeed };
  const score = computeScore(data);
  const recommendations = generateRecommendations(data, score);

  const result = {
    meta: {
      url: targetUrl,
      auditedAt: new Date().toISOString(),
      elapsedMs,
      tool: 'Scanoo v1.0',
    },
    score,
    ssl,
    seo,
    securityHeaders,
    technologies,
    brokenLinks,
    pageSpeed,
    recommendations,
  };

  console.error(`\n✅ Audit terminé en ${(elapsedMs / 1000).toFixed(1)}s — Score: ${score.total}/${score.max}`);

  return result;
}

// ─── CLI Entry ───────────────────────────────────────────────────────────────

if (require.main === module) {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: node audit.js <url>');
    console.error('Exemple: node audit.js https://example.com');
    process.exit(1);
  }

  audit(url)
    .then(result => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch(err => {
      console.error('❌ Erreur:', err.message);
      process.exit(1);
    });
}

module.exports = { audit };
