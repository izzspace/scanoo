#!/usr/bin/env node
/**
 * Scanoo - Generateur de rapport PDF
 * Usage: node report.js input.json output.pdf
 */

'use strict';

const PDFDocument = require('pdfkit');
const fs = require('fs');

// ─── Couleurs ────────────────────────────────────────────────────────────────
const C = {
  primary:    '#1E3A6E',
  blue:       '#3A6FCA',
  mint:       '#2BD78E',
  green:      '#22C55E',
  orange:     '#F59E0B',
  red:        '#EF4444',
  dark:       '#1E293B',
  muted:      '#64748B',
  light:      '#F8FAFC',
  solutionBg: '#F0F4F8',
  white:      '#FFFFFF',
  border:     '#E2E8F0',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function scoreToColor(val, max) {
  const pct = max > 0 ? (val / max) * 100 : 0;
  if (pct >= 70) return C.green;
  if (pct >= 40) return C.orange;
  return C.red;
}

function pctColor(pct) {
  if (pct >= 70) return C.green;
  if (pct >= 40) return C.orange;
  return C.red;
}

function formatDate(iso) {
  if (!iso) return 'N/A';
  try {
    return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
  } catch (_) { return iso; }
}

function trunc(str, n = 60) {
  if (!str) return 'N/A';
  str = String(str);
  return str.length > n ? str.slice(0, n) + '...' : str;
}

function priorityColor(p) {
  if (!p) return C.muted;
  const lp = p.toLowerCase();
  if (lp === 'critique' || lp === 'urgent') return C.red;
  if (lp === 'eleve' || lp === 'elevee' || lp === 'high') return C.orange;
  if (lp === 'moyen' || lp === 'moyenne' || lp === 'medium') return C.blue;
  return C.muted;
}

// ─── Rapport ──────────────────────────────────────────────────────────────────
class ScanooReport {
  constructor(data) {
    this.data = data;
    this.M = 50;         // marge gauche/droite
    this.BOTTOM_MARGIN = 60; // espace footer
    this.totalPages = 0;

    this.doc = new PDFDocument({
      size: 'A4',
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      bufferPages: true,  // IMPORTANT: permet switchToPage
      info: {
        Title: 'Rapport Scanoo',
        Author: 'Scanoo',
      },
    });

    this.W = this.doc.page.width;   // 595
    this.H = this.doc.page.height;  // 842
    this.CW = this.W - this.M * 2; // content width
  }

  // Y courant
  get y() { return this.doc.y; }
  set y(v) { this.doc.y = v; }

  // Verifier si on a assez de place, sinon nouvelle page
  maybeNewPage(needed) {
    if (this.doc.y + needed > this.H - this.BOTTOM_MARGIN) {
      this.doc.addPage();
      this.doc.y = 50;
    }
  }

  // ─── Cercle de statut ──────────────────────────────────────────────────────
  statusCircle(x, y, status) {
    // status: 'ok' | 'warn' | 'error'
    let color = C.green;
    if (status === 'warn') color = C.orange;
    if (status === 'error') color = C.red;
    this.doc.circle(x, y + 5, 4).fill(color);
  }

  // ─── Barre horizontale coloree ─────────────────────────────────────────────
  hbar(x, y, totalW, val, max, color) {
    const fill = max > 0 ? Math.min(1, val / max) : 0;
    this.doc.rect(x, y, totalW, 6).fill(C.border);
    if (fill > 0) {
      this.doc.rect(x, y, totalW * fill, 6).fill(color);
    }
  }

  // ─── PAGE 1 : COUVERTURE ───────────────────────────────────────────────────
  buildCover() {
    const doc = this.doc;
    const W = this.W;
    const H = this.H;
    const M = this.M;
    const CW = this.CW;

    // Fond haut
    doc.rect(0, 0, W, 320).fill(C.primary);
    // Fond bas
    doc.rect(0, 320, W, H - 320).fill(C.light);

    // Titre SCANOO
    doc.font('Helvetica-Bold').fontSize(52).fillColor(C.white)
      .text('SCANOO', 0, 70, { width: W, align: 'center' });

    // Sous-titre
    doc.font('Helvetica').fontSize(13).fillColor('#8BAACC')
      .text('Rapport de diagnostic de presence en ligne', 0, 138, { width: W, align: 'center' });

    // Ligne separatrice
    doc.moveTo(M + 60, 168).lineTo(W - M - 60, 168)
      .strokeColor(C.blue).lineWidth(1).stroke();

    // URL
    const url = this.data.meta?.url || '';
    doc.font('Helvetica-Bold').fontSize(12).fillColor(C.white)
      .text(trunc(url, 70), 0, 182, { width: W, align: 'center' });

    // Date
    doc.font('Helvetica').fontSize(10).fillColor('#8BAACC')
      .text('Genere le ' + formatDate(this.data.meta?.auditedAt), 0, 206, { width: W, align: 'center' });

    // Boite score global
    const score = this.data.score || { total: 0, max: 100 };
    const total = score.total || 0;
    const max = score.max || 100;
    const scoreCol = scoreToColor(total, max);

    const boxW = 220;
    const boxH = 110;
    const boxX = (W - boxW) / 2;
    const boxY = 252;

    doc.roundedRect(boxX, boxY, boxW, boxH, 10).fill(C.white);

    doc.font('Helvetica').fontSize(10).fillColor(C.muted)
      .text('SCORE GLOBAL', boxX, boxY + 14, { width: boxW, align: 'center' });

    doc.font('Helvetica-Bold').fontSize(54).fillColor(scoreCol)
      .text(String(total), boxX, boxY + 26, { width: boxW, align: 'center' });

    doc.font('Helvetica').fontSize(12).fillColor(C.muted)
      .text('/ ' + max, boxX, boxY + 82, { width: boxW, align: 'center' });

    // Jauge visuelle (barre arc-en-ciel sous le score)
    const gaugeX = boxX + 20;
    const gaugeY = boxY + 97;
    const gaugeW = boxW - 40;
    this.hbar(gaugeX, gaugeY, gaugeW, total, max, scoreCol);

    // Sous-scores
    let subY = boxY + boxH + 24;
    const breakdown = score.breakdown || {};
    const subScores = [
      { label: 'Performance', key: 'performance' },
      { label: 'SEO', key: 'seo' },
      { label: 'Securite', key: 'security' },
      { label: 'Mobile', key: 'mobile' },
      { label: 'Social', key: 'social' },
    ];

    subScores.forEach(({ label, key }) => {
      const s = breakdown[key];
      if (!s) return;
      const col = scoreToColor(s.score, s.max);

      doc.font('Helvetica').fontSize(9).fillColor(C.dark)
        .text(label, M, subY, { width: 100 });

      doc.font('Helvetica-Bold').fontSize(9).fillColor(col)
        .text(s.score + '/' + s.max, M + 100, subY, { width: 40 });

      this.hbar(M + 145, subY + 2, CW - 145, s.score, s.max, col);
      subY += 20;
    });

    // Footer couverture
    doc.rect(0, H - 44, W, 44).fill(C.primary);
    doc.font('Helvetica').fontSize(8).fillColor(C.muted)
      .text('contact@scanoo.fr | scanoo.fr | Confidentiel | Page 1', M, H - 28, { width: CW, align: 'center' });
  }

  // ─── PAGE 2 : RESUME EXECUTIF ──────────────────────────────────────────────
  buildExecutiveSummary() {
    this.doc.addPage();
    const doc = this.doc;
    const M = this.M;
    const CW = this.CW;
    doc.y = 50;

    // Titre de page
    doc.font('Helvetica-Bold').fontSize(20).fillColor(C.primary)
      .text("Ce qu'on a trouve", M, doc.y);
    doc.y += 8;
    doc.rect(M, doc.y, CW, 3).fill(C.mint);
    doc.y += 14;

    // Detecter points forts et problemes
    const recs = this.data.recommendations || [];
    const critiques = recs.filter(r => {
      const p = (r.priority || '').toLowerCase();
      return p === 'critique' || p === 'urgent';
    });

    // Points forts: ce qui va bien
    const ssl = this.data.ssl || {};
    const seo = this.data.seo || {};
    const sh = this.data.securityHeaders || {};

    const strengths = [];
    if (ssl.valid && ssl.daysLeft > 30) strengths.push('Certificat SSL valide et securise');
    if (seo.title && seo.title.length >= 20 && seo.title.length <= 70) strengths.push('Balise Title bien optimisee');
    if (seo.viewport) strengths.push('Site configure pour les mobiles (viewport present)');
    if (seo.canonical) strengths.push('URL canonique definie');
    if (seo.lang) strengths.push('Langue du site declaree correctement');
    if ((sh.score || 0) >= (sh.maxScore || 7) * 0.5) strengths.push('En-tetes de securite partiellement configures');
    if ((this.data.brokenLinks?.broken?.length || 0) === 0 && (this.data.brokenLinks?.checked || 0) > 0) {
      strengths.push('Aucun lien casse detecte');
    }

    const top3strengths = strengths.slice(0, 3);
    if (top3strengths.length === 0) top3strengths.push('Audit realise avec succes');

    // Problemes urgents: top 3 recommandations critiques
    const top3issues = critiques.slice(0, 3);
    if (top3issues.length === 0) {
      // Prendre les 3 premieres recommandations quelconques
      top3issues.push(...recs.slice(0, 3));
    }

    // Points forts
    doc.font('Helvetica-Bold').fontSize(13).fillColor(C.dark)
      .text('Points forts', M, doc.y);
    doc.y += 16;

    top3strengths.forEach(txt => {
      const lineY = doc.y;
      this.statusCircle(M + 4, lineY, 'ok');
      doc.font('Helvetica').fontSize(10).fillColor(C.dark)
        .text(txt, M + 16, lineY, { width: CW - 16 });
      doc.y += 18;
    });

    doc.y += 10;

    // Problemes urgents
    doc.font('Helvetica-Bold').fontSize(13).fillColor(C.dark)
      .text('Problemes urgents', M, doc.y);
    doc.y += 16;

    if (top3issues.length === 0) {
      const lineY = doc.y;
      this.statusCircle(M + 4, lineY, 'ok');
      doc.font('Helvetica').fontSize(10).fillColor(C.dark)
        .text('Aucun probleme critique identifie', M + 16, lineY, { width: CW - 16 });
      doc.y += 18;
    } else {
      top3issues.forEach(rec => {
        const lineY = doc.y;
        this.statusCircle(M + 4, lineY, 'error');
        doc.font('Helvetica').fontSize(10).fillColor(C.dark)
          .text(rec.action || rec.category || 'Probleme detecte', M + 16, lineY, { width: CW - 16 });
        doc.y += 18;
      });
    }

    doc.y += 20;

    // Legende des couleurs
    doc.font('Helvetica-Bold').fontSize(11).fillColor(C.dark)
      .text('Legende des scores', M, doc.y);
    doc.y += 14;

    const legend = [
      { color: C.red,    label: '0 - 40', desc: 'Critique - Action immediate requise' },
      { color: C.orange, label: '40 - 70', desc: 'A ameliorer - Attention recommandee' },
      { color: C.green,  label: '70 - 100', desc: 'Bon - Maintenir ce niveau' },
    ];

    legend.forEach(({ color, label, desc }) => {
      const ly = doc.y;
      doc.circle(M + 6, ly + 5, 6).fill(color);
      doc.font('Helvetica-Bold').fontSize(9).fillColor(color)
        .text(label, M + 18, ly, { width: 55, continued: false });
      doc.font('Helvetica').fontSize(9).fillColor(C.dark)
        .text(desc, M + 78, ly, { width: CW - 78 });
      doc.y += 18;
    });
  }

  // ─── HEADER DE SECTION ─────────────────────────────────────────────────────
  sectionHeader(title) {
    this.maybeNewPage(60);
    const doc = this.doc;
    const M = this.M;
    const CW = this.CW;
    const y = doc.y + 10;

    doc.rect(M, y, CW, 34).fill(C.primary);
    doc.rect(M, y, 4, 34).fill(C.blue);

    doc.font('Helvetica-Bold').fontSize(12).fillColor(C.white)
      .text(title, M + 14, y + 10, { width: CW - 20 });

    doc.y = y + 44;
  }

  // ─── LIGNE DE DETAIL ───────────────────────────────────────────────────────
  detailRow(label, value, status, detail, rowIdx) {
    this.maybeNewPage(30);
    const doc = this.doc;
    const M = this.M;
    const CW = this.CW;
    const y = doc.y;

    if (rowIdx % 2 === 0) {
      doc.rect(M, y - 2, CW, detail ? 32 : 22).fill(C.light);
    }

    if (status) {
      this.statusCircle(M + 6, y, status);
    }

    const labelX = status ? M + 18 : M + 6;
    doc.font('Helvetica').fontSize(9.5).fillColor(C.dark)
      .text(label, labelX, y, { width: 180 });

    const valColor = status === 'ok' ? C.green : status === 'error' ? C.red : status === 'warn' ? C.orange : C.dark;
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(valColor)
      .text(String(value || 'N/A'), M + 210, y, { width: CW - 215 });

    if (detail) {
      doc.font('Helvetica').fontSize(8).fillColor(C.muted)
        .text(String(detail), labelX, y + 14, { width: CW - 20 });
      doc.y = y + 30;
    } else {
      doc.y = y + 22;
    }
  }

  // ─── SECTION SSL ───────────────────────────────────────────────────────────
  buildSSL() {
    this.sectionHeader('Securite SSL');
    const ssl = this.data.ssl || {};
    let idx = 0;

    if (!ssl.valid) {
      this.detailRow('HTTPS / SSL', 'Non securise', 'error', ssl.error || 'Certificat invalide ou absent', idx++);
    } else {
      this.detailRow('HTTPS active', 'Oui', 'ok', null, idx++);
      const daysStatus = (ssl.daysLeft || 0) > 30 ? 'ok' : (ssl.daysLeft || 0) > 0 ? 'warn' : 'error';
      this.detailRow('Expire le', formatDate(ssl.expiresAt), daysStatus,
        ssl.daysLeft != null ? ssl.daysLeft + ' jours restants' : null, idx++);
      if (ssl.issuer) this.detailRow('Autorite (CA)', trunc(ssl.issuer, 60), 'ok', null, idx++);
    }
    this.doc.y += 10;
  }

  // ─── SECTION VITESSE ───────────────────────────────────────────────────────
  buildSpeed() {
    this.sectionHeader('Vitesse de chargement');
    const ps = this.data.pageSpeed;
    let idx = 0;

    // Detecter si les donnees sont N/A ou absentes
    const mobileNA = !ps || !ps.mobile || ps.mobile.fcp === 'N/A' || ps.mobile.performance === null;
    const desktopNA = !ps || !ps.desktop || ps.desktop.fcp === 'N/A' || ps.desktop.performance === null;

    if (mobileNA && desktopNA) {
      this.maybeNewPage(50);
      this.doc.font('Helvetica').fontSize(10).fillColor(C.muted)
        .text(
          'Nous n\'avons pas pu mesurer la vitesse de ce site. Testez manuellement sur pagespeed.web.dev',
          this.M, this.doc.y + 4, { width: this.CW }
        );
      this.doc.y += 30;
      return;
    }

    const renderDevice = (label, d) => {
      if (!d || d.fcp === 'N/A' || d.performance === null) {
        this.detailRow('Performance ' + label, 'Donnees indisponibles', 'warn', null, idx++);
        return;
      }
      const perfStatus = d.performance >= 70 ? 'ok' : d.performance >= 40 ? 'warn' : 'error';
      this.detailRow('Performance ' + label, d.performance + '/100', perfStatus,
        'FCP: ' + d.fcp + '  |  LCP: ' + d.lcp + '  |  CLS: ' + d.cls, idx++);
      if (d.seo != null) this.detailRow('SEO Lighthouse ' + label, d.seo + '/100', d.seo >= 70 ? 'ok' : 'warn', null, idx++);
      if (d.accessibility != null) this.detailRow('Accessibilite ' + label, d.accessibility + '/100', d.accessibility >= 70 ? 'ok' : 'warn', null, idx++);
    };

    if (!mobileNA) renderDevice('Mobile', ps.mobile);
    if (!desktopNA) renderDevice('Desktop', ps.desktop);

    this.doc.y += 10;
  }

  // ─── SECTION SEO ───────────────────────────────────────────────────────────
  buildSEO() {
    this.sectionHeader('SEO - Referencement naturel');
    const seo = this.data.seo || {};
    let idx = 0;

    if (seo.error) {
      this.detailRow('Analyse SEO', 'Erreur', 'error', seo.error, idx++);
      this.doc.y += 10;
      return;
    }

    const titleSt = seo.title ? (seo.titleLength >= 20 && seo.titleLength <= 70 ? 'ok' : 'warn') : 'error';
    this.detailRow('Balise Title', seo.title ? seo.titleLength + ' car.' : 'Absente', titleSt, trunc(seo.title, 70), idx++);

    const descSt = seo.description ? (seo.descriptionLength >= 50 && seo.descriptionLength <= 160 ? 'ok' : 'warn') : 'error';
    this.detailRow('Meta Description', seo.description ? seo.descriptionLength + ' car.' : 'Absente', descSt, trunc(seo.description, 80), idx++);

    const h1Count = Array.isArray(seo.h1) ? seo.h1.length : (seo.h1 ? 1 : 0);
    const h1St = h1Count === 1 ? 'ok' : h1Count > 1 ? 'warn' : 'error';
    this.detailRow('Balise H1', h1Count + ' trouvee(s)', h1St, Array.isArray(seo.h1) && seo.h1[0] ? trunc(seo.h1[0], 60) : null, idx++);

    this.detailRow('URL Canonical', seo.canonical ? 'Presente' : 'Absente', seo.canonical ? 'ok' : 'warn', seo.canonical ? trunc(seo.canonical, 60) : null, idx++);
    this.detailRow('Langue declaree', seo.lang || 'Non definie', seo.lang ? 'ok' : 'warn', null, idx++);
    this.detailRow('Viewport mobile', seo.viewport ? 'Present' : 'Absent', seo.viewport ? 'ok' : 'error', null, idx++);

    const imgs = seo.images || {};
    const imgTotal = imgs.total || 0;
    const imgNoAlt = imgs.withoutAlt || 0;
    const imgSt = imgNoAlt === 0 ? 'ok' : imgNoAlt <= 2 ? 'warn' : 'error';
    this.detailRow('Images avec alt', (imgTotal - imgNoAlt) + ' / ' + imgTotal, imgSt,
      imgNoAlt > 0 ? imgNoAlt + ' image(s) sans attribut alt' : null, idx++);

    const sdCount = Array.isArray(seo.structuredData) ? seo.structuredData.length : 0;
    this.detailRow('Donnees structurees (schema.org)', sdCount > 0 ? sdCount + ' bloc(s)' : 'Absentes', sdCount > 0 ? 'ok' : 'warn', null, idx++);

    const words = seo.wordCount || 0;
    this.detailRow('Nombre de mots', words + ' mots', words >= 300 ? 'ok' : 'warn', null, idx++);

    this.doc.y += 10;
  }

  // ─── SECTION MOBILE ────────────────────────────────────────────────────────
  buildMobile() {
    this.sectionHeader('Compatibilite Mobile');
    const seo = this.data.seo || {};
    const ps = this.data.pageSpeed;
    let idx = 0;

    this.detailRow('Viewport configure', seo.viewport ? 'Oui' : 'Non', seo.viewport ? 'ok' : 'error', seo.viewport || null, idx++);

    if (ps && ps.mobile && ps.mobile.performance !== null && ps.mobile.fcp !== 'N/A') {
      const mSt = ps.mobile.performance >= 70 ? 'ok' : ps.mobile.performance >= 40 ? 'warn' : 'error';
      this.detailRow('Score mobile PageSpeed', ps.mobile.performance + '/100', mSt, null, idx++);
    }

    this.doc.y += 10;
  }

  // ─── SECTION HEADERS SECURITE ──────────────────────────────────────────────
  buildSecurityHeaders() {
    this.sectionHeader('En-tetes de securite HTTP');
    const sh = this.data.securityHeaders || {};
    const checks = sh.checks || {};
    let idx = 0;

    if (sh.error) {
      this.detailRow('Analyse headers', 'Erreur', 'warn', sh.error, idx++);
      this.doc.y += 10;
      return;
    }

    const headers = [
      { key: 'strictTransportSecurity', label: 'HSTS (Strict-Transport-Security)' },
      { key: 'xFrameOptions',           label: 'X-Frame-Options' },
      { key: 'xContentTypeOptions',     label: 'X-Content-Type-Options' },
      { key: 'contentSecurityPolicy',   label: 'Content-Security-Policy' },
      { key: 'referrerPolicy',          label: 'Referrer-Policy' },
      { key: 'permissionsPolicy',       label: 'Permissions-Policy' },
    ];

    headers.forEach(({ key, label }) => {
      const present = !!checks[key];
      this.detailRow(label, present ? 'Present' : 'Absent', present ? 'ok' : 'warn', null, idx++);
    });

    const values = sh.values || {};
    if (values.server) {
      this.detailRow('Serveur web', trunc(values.server, 50), null, null, idx++);
    }
    if (values.poweredBy) {
      this.detailRow('X-Powered-By', trunc(values.poweredBy, 50), 'warn', 'Revele la technologie - mieux vaut masquer', idx++);
    }

    this.doc.y += 10;
  }

  // ─── SECTION RESEAUX SOCIAUX ───────────────────────────────────────────────
  buildSocial() {
    this.sectionHeader('Reseaux sociaux et Open Graph');
    const seo = this.data.seo || {};
    const og = seo.og || {};
    const tw = seo.twitter || {};
    const links = seo.socialLinks || {};
    let idx = 0;

    this.detailRow('OG Title', og.title ? trunc(og.title, 55) : 'Absent', og.title ? 'ok' : 'warn', null, idx++);
    this.detailRow('OG Description', og.description ? 'Presente' : 'Absente', og.description ? 'ok' : 'warn', null, idx++);
    this.detailRow('OG Image', og.image ? 'Presente' : 'Absente', og.image ? 'ok' : 'error', og.image ? null : 'Sans image, le partage sera peu attractif', idx++);
    this.detailRow('Twitter Card', tw.card || 'Absente', tw.card ? 'ok' : 'warn', null, idx++);
    this.detailRow('Twitter Image', tw.image ? 'Presente' : 'Absente', tw.image ? 'ok' : 'warn', null, idx++);

    this.detailRow('Facebook', links.facebook ? trunc(links.facebook, 50) : 'Non detecte', links.facebook ? 'ok' : 'warn', null, idx++);
    this.detailRow('Instagram', links.instagram ? trunc(links.instagram, 50) : 'Non detecte', links.instagram ? 'ok' : 'warn', null, idx++);
    this.detailRow('LinkedIn', links.linkedin ? trunc(links.linkedin, 50) : 'Non detecte', links.linkedin ? 'ok' : 'warn', null, idx++);

    this.doc.y += 10;
  }

  // ─── SECTION TECHNOLOGIES ──────────────────────────────────────────────────
  buildTech() {
    this.sectionHeader('Technologies detectees');
    const tech = this.data.technologies || {};
    let idx = 0;

    if (tech.error) {
      this.detailRow('Detection', 'Erreur', 'warn', tech.error, idx++);
      this.doc.y += 10;
      return;
    }

    const join = arr => (Array.isArray(arr) && arr.length > 0) ? arr.join(', ') : 'Non detecte';
    this.detailRow('CMS / Plateforme', join(tech.cms), null, null, idx++);
    this.detailRow('Frameworks JS', join(tech.frameworks), null, null, idx++);
    this.detailRow('Analytics', join(tech.analytics), tech.analytics?.length > 0 ? 'ok' : 'warn', null, idx++);
    this.detailRow('CDN / Hebergeur', join(tech.cdn), null, null, idx++);
    this.detailRow('Serveur web', tech.server || 'Non divulgue', null, null, idx++);

    this.doc.y += 10;
  }

  // ─── SECTION LIENS ─────────────────────────────────────────────────────────
  buildLinks() {
    this.sectionHeader('Liens verifies');
    const bl = this.data.brokenLinks || {};
    let idx = 0;

    if (bl.error) {
      this.detailRow('Verification', 'Erreur lors de l\'analyse', 'warn', bl.error, idx++);
      this.doc.y += 10;
      return;
    }

    const brokenCount = Array.isArray(bl.broken) ? bl.broken.length : 0;
    this.detailRow('Liens verifies', String(bl.checked || 0), null, null, idx++);
    this.detailRow('Liens casses (404)', brokenCount > 0 ? brokenCount + ' lien(s) casse(s)' : 'Aucun', brokenCount > 0 ? 'error' : 'ok', null, idx++);

    if (brokenCount > 0) {
      const limit = Math.min(bl.broken.length, 5);
      for (let i = 0; i < limit; i++) {
        const lnk = bl.broken[i];
        this.detailRow('Lien casse', trunc(lnk.url, 65), 'error', 'Statut: ' + (lnk.status || 'Erreur reseau'), idx++);
      }
    }

    this.doc.y += 10;
  }

  // ─── SECTION RECOMMANDATIONS ───────────────────────────────────────────────
  buildRecommendations() {
    this.doc.addPage();
    this.doc.y = 50;

    const doc = this.doc;
    const M = this.M;
    const CW = this.CW;

    // Titre section
    doc.font('Helvetica-Bold').fontSize(18).fillColor(C.primary)
      .text('Recommandations', M, doc.y);
    doc.y += 8;
    doc.rect(M, doc.y, CW, 3).fill(C.blue);
    doc.y += 16;

    const recs = this.data.recommendations || [];
    if (recs.length === 0) {
      doc.font('Helvetica').fontSize(11).fillColor(C.muted)
        .text('Aucune recommandation identifiee.', M, doc.y);
      doc.y += 30;
      return;
    }

    recs.forEach((rec, i) => {
      // Estimer la hauteur du bloc : titre (30) + impact (20) + solution (variable) + padding (30)
      const solutionText = rec.solution || '';
      const solutionEstimate = Math.ceil(solutionText.length / 80) * 12 + 40;
      const blockHeight = 30 + 20 + solutionEstimate + 30;

      // Saut de page AVANT le bloc entier si ca ne tient pas
      if (doc.y + blockHeight > this.H - this.BOTTOM_MARGIN) {
        doc.addPage();
        doc.y = 50;
      }

      const blockY = doc.y;
      const col = priorityColor(rec.priority);

      // Numero + badge priorite + categorie
      // Numero
      doc.circle(M + 10, blockY + 10, 10).fill(col);
      doc.font('Helvetica-Bold').fontSize(9).fillColor(C.white)
        .text(String(i + 1), M + 4, blockY + 5, { width: 13, align: 'center' });

      // Badge priorite
      const badgeX = M + 26;
      const badgeTxt = (rec.priority || 'moyen').toUpperCase();
      doc.roundedRect(badgeX, blockY + 2, 68, 16, 8).fill(col);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(C.white)
        .text(badgeTxt, badgeX, blockY + 5, { width: 68, align: 'center' });

      // Categorie
      if (rec.category) {
        doc.font('Helvetica').fontSize(8).fillColor(C.muted)
          .text(rec.category, M + 100, blockY + 5, { width: CW - 105 });
      }

      doc.y = blockY + 24;

      // Titre du probleme
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor(C.dark)
        .text(rec.action || 'Probleme detecte', M + 2, doc.y, { width: CW - 4 });
      doc.y += 4;

      // Impact + Difficulte
      doc.font('Helvetica').fontSize(9).fillColor(C.muted)
        .text('Impact: ' + (rec.impact || 'N/A') + '  |  Difficulte: ' + (rec.difficulty || 'N/A'), M + 2, doc.y, { width: CW - 4 });
      doc.y += 14;

      // Solution
      if (solutionText) {
        // Label "Comment faire :" en gras vert
        doc.font('Helvetica-Bold').fontSize(9).fillColor(C.mint)
          .text('Comment faire :', M + 2, doc.y, { width: CW - 4 });
        doc.y += 14;

        // Fond gris solution
        const solY = doc.y;
        const solW = CW - 4;
        const solTextH = doc.heightOfString(solutionText, { font: 'Helvetica', fontSize: 9, width: solW - 16 });
        const solBoxH = solTextH + 16;

        doc.roundedRect(M + 2, solY, solW, solBoxH, 5).fill(C.solutionBg);
        doc.font('Helvetica').fontSize(9).fillColor(C.dark)
          .text(solutionText, M + 10, solY + 8, { width: solW - 16 });

        doc.y = solY + solBoxH + 10;
      }

      doc.y += 6;
    });
  }

  // ─── DERNIERE PAGE : CONCLUSION ────────────────────────────────────────────
  buildConclusion() {
    this.doc.addPage();
    const doc = this.doc;
    const M = this.M;
    const CW = this.CW;
    doc.y = 50;

    // Titre
    doc.font('Helvetica-Bold').fontSize(20).fillColor(C.primary)
      .text('Conclusion', M, doc.y);
    doc.y += 8;
    doc.rect(M, doc.y, CW, 3).fill(C.mint);
    doc.y += 20;

    const recs = this.data.recommendations || [];
    const critiques = recs.filter(r => {
      const p = (r.priority || '').toLowerCase();
      return p === 'critique' || p === 'urgent';
    });

    // Recapitulatif
    doc.font('Helvetica-Bold').fontSize(13).fillColor(C.dark)
      .text('Recapitulatif', M, doc.y);
    doc.y += 16;

    const lines = [
      recs.length + ' probleme(s) identifie(s), dont ' + critiques.length + ' critique(s)',
      'Score global : ' + (this.data.score?.total || 0) + ' / ' + (this.data.score?.max || 100),
    ];

    lines.forEach(line => {
      const ly = doc.y;
      this.statusCircle(M + 4, ly, critiques.length > 0 ? 'warn' : 'ok');
      doc.font('Helvetica').fontSize(10).fillColor(C.dark)
        .text(line, M + 16, ly, { width: CW - 16 });
      doc.y += 18;
    });

    doc.y += 20;

    // Boite contact
    const boxY = doc.y;
    doc.roundedRect(M, boxY, CW, 100, 8).fill(C.primary);

    doc.font('Helvetica-Bold').fontSize(12).fillColor(C.white)
      .text('Besoin d\'aide ?', M, boxY + 16, { width: CW, align: 'center' });

    doc.font('Helvetica').fontSize(10).fillColor('#8BAACC')
      .text('Contactez-nous a contact@scanoo.fr', M, boxY + 36, { width: CW, align: 'center' });

    doc.font('Helvetica').fontSize(9).fillColor('#8BAACC')
      .text('Nous recommandons un nouveau diagnostic dans 3 mois', M, boxY + 56, { width: CW, align: 'center' });

    doc.moveTo(M + 60, boxY + 74).lineTo(CW - 20, boxY + 74)
      .strokeColor(C.blue).lineWidth(0.5).stroke();

    doc.font('Helvetica').fontSize(8).fillColor(C.muted)
      .text('Rapport genere par Scanoo - scanoo.fr', M, boxY + 80, { width: CW, align: 'center' });
  }

  // ─── FOOTERS SUR TOUTES LES PAGES ─────────────────────────────────────────
  addFooters() {
    const doc = this.doc;
    const range = doc.bufferedPageRange();
    const total = range.count;

    for (let i = 0; i < total; i++) {
      doc.switchToPage(range.start + i);
      const pageNum = i + 1;

      // Skip la couverture (page 1) car elle a son propre footer
      if (pageNum === 1) continue;

      const footerY = this.H - 30;
      doc.rect(0, footerY - 4, this.W, 34).fill(C.primary);

      doc.font('Helvetica').fontSize(7.5).fillColor(C.muted)
        .text(
          'contact@scanoo.fr | scanoo.fr | Confidentiel | Page ' + pageNum,
          this.M, footerY + 4,
          { width: this.CW, align: 'center' }
        );
    }
  }

  // ─── GENERATE ──────────────────────────────────────────────────────────────
  async generate(outputPath) {
    // Page 1: Couverture
    this.buildCover();

    // Page 2: Resume executif
    this.buildExecutiveSummary();

    // Pages 3+: Sections d'analyse
    this.doc.addPage();
    this.doc.y = 50;

    this.buildSSL();
    this.buildSpeed();
    this.buildSEO();
    this.buildMobile();
    this.buildSecurityHeaders();
    this.buildSocial();
    this.buildTech();
    this.buildLinks();

    // Pages Recommandations
    this.buildRecommendations();

    // Derniere page: Conclusion
    this.buildConclusion();

    // Footers sur toutes les pages (apres generation)
    this.addFooters();

    // Ecriture du fichier
    return new Promise((resolve, reject) => {
      const stream = fs.createWriteStream(outputPath);
      this.doc.pipe(stream);
      stream.on('finish', () => resolve(outputPath));
      stream.on('error', reject);
      doc_error_handler(this.doc, reject);
      this.doc.end();
    });
  }
}

function doc_error_handler(doc, reject) {
  doc.on('error', reject);
}

// ─── CLI ──────────────────────────────────────────────────────────────────────
async function main() {
  const inputArg = process.argv[2];
  const outputArg = process.argv[3];

  if (!inputArg) {
    console.error('Usage: node report.js input.json output.pdf');
    process.exit(1);
  }

  let auditData;
  try {
    auditData = JSON.parse(fs.readFileSync(inputArg, 'utf8'));
  } catch (e) {
    console.error('Erreur de lecture du fichier ' + inputArg + ': ' + e.message);
    process.exit(1);
  }

  const outputPath = outputArg || ('rapport-scanoo-' + Date.now() + '.pdf');
  console.error('Generation du rapport -> ' + outputPath);

  const report = new ScanooReport(auditData);
  await report.generate(outputPath);

  console.error('Rapport genere : ' + outputPath);
}

main().catch(err => {
  console.error('Erreur: ' + err.message);
  process.exit(1);
});

module.exports = { ScanooReport };
