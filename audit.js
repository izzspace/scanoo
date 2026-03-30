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
    recs.push({ priority: 'critique', category: 'Sécurité', action: 'Installer un certificat SSL (HTTPS)', impact: 'Très élevé', difficulty: 'Facile' });
  } else if (data.ssl?.daysLeft < 30) {
    recs.push({ priority: 'urgent', category: 'Sécurité', action: `Renouveler le certificat SSL — expire dans ${data.ssl.daysLeft} jours`, impact: 'Élevé', difficulty: 'Facile' });
  }

  // SEO
  const seo = data.seo || {};
  if (!seo.title) {
    recs.push({ priority: 'élevé', category: 'SEO', action: 'Ajouter une balise <title> à la page d\'accueil', impact: 'Élevé', difficulty: 'Facile' });
  } else if (seo.title.length < 20 || seo.title.length > 70) {
    recs.push({ priority: 'moyen', category: 'SEO', action: `Optimiser le titre (actuellement ${seo.title.length} caractères, idéal : 20-70)`, impact: 'Moyen', difficulty: 'Facile' });
  }

  if (!seo.description) {
    recs.push({ priority: 'élevé', category: 'SEO', action: 'Ajouter une méta description pour améliorer le taux de clic dans Google', impact: 'Élevé', difficulty: 'Facile' });
  } else if (seo.description.length < 50 || seo.description.length > 160) {
    recs.push({ priority: 'moyen', category: 'SEO', action: `Optimiser la méta description (actuellement ${seo.description.length} caractères, idéal : 50-160)`, impact: 'Moyen', difficulty: 'Facile' });
  }

  if (!seo.h1 || seo.h1.length === 0) {
    recs.push({ priority: 'élevé', category: 'SEO', action: 'Ajouter une balise H1 contenant le mot-clé principal de la page', impact: 'Élevé', difficulty: 'Facile' });
  } else if (seo.h1.length > 1) {
    recs.push({ priority: 'moyen', category: 'SEO', action: `Réduire à un seul H1 (${seo.h1.length} trouvés actuellement)`, impact: 'Moyen', difficulty: 'Facile' });
  }

  if (seo.images?.withoutAlt > 0) {
    recs.push({ priority: 'moyen', category: 'SEO', action: `Ajouter des attributs alt aux ${seo.images.withoutAlt} image(s) sans description`, impact: 'Moyen', difficulty: 'Facile' });
  }

  if (!seo.canonical) {
    recs.push({ priority: 'moyen', category: 'SEO', action: 'Ajouter une balise canonical pour éviter le contenu dupliqué', impact: 'Moyen', difficulty: 'Facile' });
  }

  if (!seo.lang) {
    recs.push({ priority: 'faible', category: 'SEO', action: 'Ajouter l\'attribut lang="fr" à la balise <html>', impact: 'Faible', difficulty: 'Très facile' });
  }

  // Structured data
  if (!seo.structuredData || seo.structuredData.length === 0) {
    recs.push({ priority: 'moyen', category: 'SEO', action: 'Ajouter des données structurées schema.org (LocalBusiness, Organization, etc.)', impact: 'Élevé', difficulty: 'Moyen' });
  }

  // Open Graph
  if (!seo.og?.image) {
    recs.push({ priority: 'moyen', category: 'Réseaux sociaux', action: 'Ajouter une image Open Graph pour les partages sur les réseaux sociaux', impact: 'Moyen', difficulty: 'Facile' });
  }

  // Security headers
  const sec = data.securityHeaders?.checks || {};
  if (!sec.strictTransportSecurity) {
    recs.push({ priority: 'moyen', category: 'Sécurité', action: 'Activer l\'en-tête HSTS (Strict-Transport-Security)', impact: 'Moyen', difficulty: 'Moyen' });
  }
  if (!sec.contentSecurityPolicy) {
    recs.push({ priority: 'faible', category: 'Sécurité', action: 'Définir une Content Security Policy (CSP)', impact: 'Élevé', difficulty: 'Difficile' });
  }
  if (!sec.xFrameOptions) {
    recs.push({ priority: 'moyen', category: 'Sécurité', action: 'Ajouter l\'en-tête X-Frame-Options pour prévenir le clickjacking', impact: 'Moyen', difficulty: 'Facile' });
  }

  // Performance (only if PageSpeed API returned real data)
  const perfMobile = data.pageSpeed?.mobile;
  const perfApiAvail = perfMobile && perfMobile.fcp !== 'N/A';
  if (perfApiAvail) {
    const perf = perfMobile.performance;
    if (perf < 50) {
      recs.push({ priority: 'élevé', category: 'Performance', action: 'Optimiser les performances mobiles (score actuel : ' + perf + '/100)', impact: 'Très élevé', difficulty: 'Difficile' });
    } else if (perf < 70) {
      recs.push({ priority: 'moyen', category: 'Performance', action: 'Améliorer la vitesse de chargement mobile (score : ' + perf + '/100)', impact: 'Élevé', difficulty: 'Moyen' });
    }
    if (!perfMobile.textCompression) {
      recs.push({ priority: 'moyen', category: 'Performance', action: 'Activer la compression GZIP/Brotli pour les fichiers texte', impact: 'Élevé', difficulty: 'Facile' });
    }
    if (!perfMobile.imageOptimization) {
      recs.push({ priority: 'moyen', category: 'Performance', action: 'Optimiser et compresser les images du site', impact: 'Élevé', difficulty: 'Facile' });
    }
  } else {
    // PageSpeed not available - give generic advice
    recs.push({ priority: 'moyen', category: 'Performance', action: 'Vérifier la vitesse de chargement avec Google PageSpeed Insights (pagespeed.web.dev)', impact: 'Élevé', difficulty: 'Facile' });
  }

  // Liens cassés
  if (data.brokenLinks?.broken?.length > 0) {
    recs.push({ priority: 'élevé', category: 'Technique', action: `Corriger les ${data.brokenLinks.broken.length} lien(s) cassé(s) (erreurs 404)`, impact: 'Élevé', difficulty: 'Facile' });
  }

  // Mobile friendly (only flag if PageSpeed API was actually available and returned meaningful data)
  const mobileApiAvailForRec = data.pageSpeed?.mobile && data.pageSpeed.mobile.fcp !== 'N/A';
  if (mobileApiAvailForRec && !data.pageSpeed.mobile.mobileFriendly) {
    recs.push({ priority: 'critique', category: 'Mobile', action: 'Rendre le site responsive / mobile-friendly', impact: 'Très élevé', difficulty: 'Difficile' });
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
