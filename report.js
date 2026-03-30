#!/usr/bin/env node
/**
 * Scanoo — Générateur de rapport PDF professionnel
 * Usage: node report.js <audit.json> [output.pdf]
 *        ou: cat audit.json | node report.js
 */

const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

// ─── Couleurs de la charte Scanoo ──────────────────────────────────────────
const COLORS = {
  primary:    '#1A2B4A',   // Bleu foncé
  secondary:  '#2563EB',   // Bleu électrique
  accent:     '#10B981',   // Vert
  warning:    '#F59E0B',   // Orange
  danger:     '#EF4444',   // Rouge
  light:      '#F8FAFC',   // Gris très clair
  medium:     '#94A3B8',   // Gris moyen
  dark:       '#1E293B',   // Gris foncé
  white:      '#FFFFFF',
  border:     '#E2E8F0',
};

// ─── Fonctions utilitaires ──────────────────────────────────────────────────

function scoreColor(score, max) {
  const pct = score / max;
  if (pct >= 0.75) return COLORS.accent;
  if (pct >= 0.5)  return COLORS.warning;
  return COLORS.danger;
}

function scoreLabel(score, max) {
  const pct = score / max;
  if (pct >= 0.75) return 'Bon';
  if (pct >= 0.5)  return 'Moyen';
  return 'Insuffisant';
}

function icon(status) {
  // status: 'ok' | 'warn' | 'error'
  if (status === 'ok')   return '✅';
  if (status === 'warn') return '⚠️ ';
  return '❌';
}

function statusColor(status) {
  if (status === 'ok')   return COLORS.accent;
  if (status === 'warn') return COLORS.warning;
  return COLORS.danger;
}

function formatDate(isoString) {
  if (!isoString) return 'N/A';
  return new Date(isoString).toLocaleDateString('fr-FR', {
    day: '2-digit', month: 'long', year: 'numeric',
  });
}

function truncate(str, len = 60) {
  if (!str) return 'N/A';
  return str.length > len ? str.slice(0, len) + '…' : str;
}

// ─── Classe générateur PDF ──────────────────────────────────────────────────

class ScanooReport {
  constructor(auditData) {
    this.data = auditData;
    this.doc = new PDFDocument({
      size: 'A4',
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      info: {
        Title: `Rapport Scanoo — ${auditData.meta?.url || 'Audit'}`,
        Author: 'Scanoo',
        Subject: 'Rapport d\'audit de présence en ligne',
        Creator: 'Scanoo v1.0',
      },
    });

    this.pageWidth  = this.doc.page.width;
    this.pageHeight = this.doc.page.height;
    this.margin     = 45;
    this.contentWidth = this.pageWidth - this.margin * 2;
    this.currentY   = 0;

    // Track pages for footer
    this.pageNumber = 1;
    this.doc.on('pageAdded', () => { this.pageNumber++; });
  }

  // ─── Layout helpers ─────────────────────────────────────────────────────

  checkPageBreak(neededHeight = 80) {
    if (this.doc.y + neededHeight > this.pageHeight - 80) {
      this.addPageWithHeader();
    }
  }

  addPageWithHeader() {
    this.doc.addPage();
    this.addMinimalHeader();
  }

  addMinimalHeader() {
    const doc = this.doc;
    doc.rect(0, 0, this.pageWidth, 35).fill(COLORS.primary);
    doc.fontSize(9).fillColor(COLORS.white)
      .font('Helvetica-Bold')
      .text('SCANOO', this.margin, 12, { continued: true })
      .font('Helvetica')
      .fillColor(COLORS.medium)
      .text(`  |  Rapport d'audit — ${truncate(this.data.meta?.url, 50)}`, { align: 'left' });
    doc.moveDown(0.5);
    doc.y = 50;
  }

  // ─── COVER PAGE ─────────────────────────────────────────────────────────

  addCoverPage() {
    const doc = this.doc;
    const w = this.pageWidth;
    const h = this.pageHeight;
    const m = this.margin;

    // Background gradient simulation via two rects
    doc.rect(0, 0, w, 260).fill(COLORS.primary);
    doc.rect(0, 260, w, h - 260).fill(COLORS.light);

    // Logo / Brand
    doc.y = 60;
    doc.fontSize(36).font('Helvetica-Bold').fillColor(COLORS.white)
      .text('SCANOO', m, 60, { align: 'center' });
    doc.fontSize(12).font('Helvetica').fillColor('#94B8E0')
      .text('Le médecin de votre visibilité en ligne', m, 105, { align: 'center' });

    // Divider
    doc.moveTo(m + 40, 135).lineTo(w - m - 40, 135).strokeColor('#FFFFFF').lineWidth(0.5).stroke();

    // Report Title
    doc.fontSize(16).font('Helvetica-Bold').fillColor(COLORS.white)
      .text('RAPPORT D\'AUDIT DE PRÉSENCE EN LIGNE', m, 150, { align: 'center' });

    doc.fontSize(11).font('Helvetica').fillColor('#94B8E0')
      .text(this.data.meta?.url || '', m, 180, { align: 'center' });

    doc.fontSize(10).fillColor('#AABFDA')
      .text(`Généré le ${formatDate(this.data.meta?.auditedAt)}`, m, 205, { align: 'center' });

    // Score Box
    const score = this.data.score;
    const boxW = 200;
    const boxX = (w - boxW) / 2;
    const boxY = 300;

    doc.roundedRect(boxX, boxY, boxW, 130, 12).fill(COLORS.white);
    doc.roundedRect(boxX, boxY, boxW, 130, 12).strokeColor(COLORS.border).lineWidth(1).stroke();

    const pct = Math.round((score.total / score.max) * 100);
    const color = scoreColor(score.total, score.max);
    const label = scoreLabel(score.total, score.max);

    doc.fontSize(11).font('Helvetica').fillColor(COLORS.medium)
      .text('SCORE GLOBAL', boxX, boxY + 18, { width: boxW, align: 'center' });

    doc.fontSize(56).font('Helvetica-Bold').fillColor(color)
      .text(score.total.toString(), boxX, boxY + 34, { width: boxW, align: 'center' });

    doc.fontSize(14).font('Helvetica').fillColor(COLORS.medium)
      .text(`/ ${score.max}`, boxX, boxY + 96, { width: boxW, align: 'center' });

    // Score bar
    const barX = boxX + 20;
    const barY = boxY + 118;
    const barW = boxW - 40;
    const barH = 6;
    doc.roundedRect(barX, barY, barW, barH, 3).fill(COLORS.border);
    doc.roundedRect(barX, barY, barW * (score.total / score.max), barH, 3).fill(color);

    // Score breakdown mini
    let bY = boxY + 150;
    if (score.breakdown) {
      Object.entries(score.breakdown).forEach(([key, s]) => {
        const col = scoreColor(s.score, s.max);
        const bW = (s.score / s.max) * (this.contentWidth / 2 - 20);

        doc.fontSize(9).font('Helvetica').fillColor(COLORS.dark)
          .text(s.label, m, bY, { width: 90 });
        doc.fontSize(9).font('Helvetica-Bold').fillColor(col)
          .text(`${s.score}/${s.max}`, m + 95, bY, { width: 40 });

        const miniBarX = m + 140;
        const miniBarW = this.contentWidth - 140;
        doc.roundedRect(miniBarX, bY + 2, miniBarW, 5, 2).fill(COLORS.border);
        doc.roundedRect(miniBarX, bY + 2, miniBarW * (s.score / s.max), 5, 2).fill(col);

        bY += 22;
      });
    }

    // Footer on cover
    doc.rect(0, h - 50, w, 50).fill(COLORS.primary);
    doc.fontSize(9).font('Helvetica').fillColor(COLORS.medium)
      .text('contact@scanoo.fr  |  scanoo.fr', m, h - 32, { align: 'center' });
  }

  // ─── Section Header ──────────────────────────────────────────────────────

  addSectionHeader(title, emoji = '') {
    this.checkPageBreak(60);
    const doc = this.doc;
    const y = doc.y + 10;

    doc.rect(this.margin, y, this.contentWidth, 36).fill(COLORS.primary);
    doc.roundedRect(this.margin, y, 5, 36, 2).fill(COLORS.secondary);

    doc.fontSize(13).font('Helvetica-Bold').fillColor(COLORS.white)
      .text(`${emoji}  ${title}`, this.margin + 18, y + 11, { width: this.contentWidth - 20 });

    doc.y = y + 46;
  }

  // ─── Row ────────────────────────────────────────────────────────────────

  addRow(label, value, status = null, detail = null) {
    this.checkPageBreak(40);
    const doc = this.doc;
    const y = doc.y;
    const col = status ? statusColor(status) : COLORS.dark;

    // Alternating background
    if (this._rowIndex % 2 === 0) {
      doc.rect(this.margin, y - 4, this.contentWidth, 28).fill('#F8FAFC');
    }
    this._rowIndex = (this._rowIndex || 0) + 1;

    const ic = status ? icon(status) : '  ';
    doc.fontSize(10).font('Helvetica').fillColor(col)
      .text(ic, this.margin + 6, y, { width: 20 });

    doc.fontSize(10).font('Helvetica').fillColor(COLORS.dark)
      .text(label, this.margin + 28, y, { width: 180 });

    doc.fontSize(10).font('Helvetica-Bold').fillColor(col)
      .text(value || 'N/A', this.margin + 215, y, { width: this.contentWidth - 220 });

    if (detail) {
      doc.fontSize(8).font('Helvetica').fillColor(COLORS.medium)
        .text(detail, this.margin + 28, y + 13, { width: this.contentWidth - 40 });
      doc.y = y + 26;
    } else {
      doc.y = y + 22;
    }
  }

  // ─── Section: SSL ───────────────────────────────────────────────────────

  addSSLSection() {
    this.addSectionHeader('Sécurité HTTPS / SSL', '🔒');
    this._rowIndex = 0;
    const ssl = this.data.ssl || {};

    if (ssl.error && !ssl.valid) {
      this.addRow('HTTPS activé', 'Non', 'error', ssl.error);
    } else {
      this.addRow('HTTPS activé', ssl.valid ? 'Oui' : 'Non', ssl.valid ? 'ok' : 'error');
      if (ssl.valid) {
        this.addRow('Certificat valide jusqu\'au', ssl.expiresAt ? formatDate(ssl.expiresAt) : 'N/A',
          ssl.daysLeft > 30 ? 'ok' : ssl.daysLeft > 0 ? 'warn' : 'error',
          ssl.daysLeft > 0 ? `${ssl.daysLeft} jours restants` : null);
        this.addRow('Autorité de certification', ssl.issuer || 'N/A', 'ok');
      }
    }
    this.doc.y += 10;
  }

  // ─── Section: Performance ───────────────────────────────────────────────

  addPerformanceSection() {
    this.addSectionHeader('Vitesse de chargement', '⚡');
    this._rowIndex = 0;
    const ps = this.data.pageSpeed;

    if (!ps || (ps.error && !ps.mobile && !ps.desktop)) {
      this.addRow('PageSpeed Insights', 'Données indisponibles', 'warn', ps?.error || '');
      this.doc.y += 10;
      return;
    }

    const strategies = [
      { label: 'Mobile', data: ps.mobile },
      { label: 'Desktop', data: ps.desktop },
    ];

    strategies.forEach(({ label, data: d }) => {
      if (!d) return;
      const perfStatus = d.performance >= 75 ? 'ok' : d.performance >= 50 ? 'warn' : 'error';
      this.addRow(`Performance ${label}`, `${d.performance}/100`, perfStatus,
        `FCP: ${d.fcp}  |  LCP: ${d.lcp}  |  CLS: ${d.cls}  |  TTI: ${d.tti}`);
      this.addRow(`SEO Lighthouse ${label}`, `${d.seo}/100`, d.seo >= 75 ? 'ok' : 'warn');
      this.addRow(`Accessibilité ${label}`, `${d.accessibility}/100`, d.accessibility >= 75 ? 'ok' : 'warn');
      this.addRow(`Bonnes pratiques ${label}`, `${d.bestPractices}/100`, d.bestPractices >= 75 ? 'ok' : 'warn');
      this.addRow('Compression texte', d.textCompression ? 'Activée' : 'Non activée',
        d.textCompression ? 'ok' : 'warn');
      this.addRow('Optimisation images', d.imageOptimization ? 'Bonne' : 'À améliorer',
        d.imageOptimization ? 'ok' : 'warn');
    });

    this.doc.y += 10;
  }

  // ─── Section: SEO ───────────────────────────────────────────────────────

  addSEOSection() {
    this.addSectionHeader('SEO — Référencement naturel', '🔍');
    this._rowIndex = 0;
    const seo = this.data.seo || {};

    if (seo.error) {
      this.addRow('Analyse SEO', 'Erreur lors de l\'analyse', 'error', seo.error);
      this.doc.y += 10;
      return;
    }

    // Title
    const titleStatus = seo.title
      ? (seo.title.length >= 20 && seo.title.length <= 70 ? 'ok' : 'warn')
      : 'error';
    this.addRow('Balise Title', seo.title ? `${seo.title.length} car.` : 'Absente',
      titleStatus, truncate(seo.title, 70));

    // Description
    const descStatus = seo.description
      ? (seo.description.length >= 50 && seo.description.length <= 160 ? 'ok' : 'warn')
      : 'error';
    this.addRow('Méta Description', seo.description ? `${seo.description.length} car.` : 'Absente',
      descStatus, truncate(seo.description, 80));

    // H1
    const h1Status = seo.h1?.length === 1 ? 'ok' : seo.h1?.length > 1 ? 'warn' : 'error';
    this.addRow('Balise H1', seo.h1?.length > 0 ? `${seo.h1.length} trouvée(s)` : 'Absente',
      h1Status, seo.h1?.[0] ? truncate(seo.h1[0], 60) : null);

    // Alt
    const altStatus = seo.images?.withoutAlt === 0 ? 'ok'
      : seo.images?.withoutAlt > 0 ? 'warn' : 'ok';
    this.addRow('Images avec alt',
      `${(seo.images?.total || 0) - (seo.images?.withoutAlt || 0)} / ${seo.images?.total || 0}`,
      altStatus,
      seo.images?.withoutAlt > 0 ? `${seo.images.withoutAlt} image(s) sans attribut alt` : null);

    // Canonical
    this.addRow('Balise Canonical', seo.canonical || 'Absente',
      seo.canonical ? 'ok' : 'warn', seo.canonical ? truncate(seo.canonical, 60) : null);

    // Lang
    this.addRow('Langue déclarée', seo.lang || 'Non définie', seo.lang ? 'ok' : 'warn');

    // Structured data
    const sdCount = seo.structuredData?.length || 0;
    const sdTypes = seo.structuredData?.map(s => s['@type']).filter(Boolean).join(', ');
    this.addRow('Données structurées (schema.org)',
      sdCount > 0 ? `${sdCount} bloc(s)` : 'Absentes',
      sdCount > 0 ? 'ok' : 'warn',
      sdTypes || null);

    // Mots
    this.addRow('Nombre de mots', seo.wordCount > 300 ? `${seo.wordCount} mots` : `${seo.wordCount} mots (trop peu)`,
      seo.wordCount >= 300 ? 'ok' : 'warn');

    // HTTP Status
    this.addRow('Statut HTTP', `${seo.httpStatus || 'N/A'}`,
      seo.httpStatus === 200 ? 'ok' : 'error');

    this.doc.y += 10;
  }

  // ─── Section: Mobile ────────────────────────────────────────────────────

  addMobileSection() {
    this.addSectionHeader('Compatibilité Mobile', '📱');
    this._rowIndex = 0;
    const seo = this.data.seo || {};
    const ps = this.data.pageSpeed;

    this.addRow('Viewport configuré', seo.viewport ? 'Oui' : 'Non',
      seo.viewport ? 'ok' : 'error', seo.viewport || null);

    if (ps?.mobile) {
      this.addRow('Score mobile PageSpeed', `${ps.mobile.performance}/100`,
        ps.mobile.performance >= 75 ? 'ok' : ps.mobile.performance >= 50 ? 'warn' : 'error');
      this.addRow('Mobile-friendly (Google)', ps.mobile.mobileFriendly ? 'Oui' : 'Non',
        ps.mobile.mobileFriendly ? 'ok' : 'error');
    }

    this.doc.y += 10;
  }

  // ─── Section: Security Headers ──────────────────────────────────────────

  addSecuritySection() {
    this.addSectionHeader('En-têtes de sécurité HTTP', '🛡️');
    this._rowIndex = 0;
    const sh = this.data.securityHeaders || {};
    const checks = sh.checks || {};
    const values = sh.values || {};

    const headerMap = [
      { key: 'strictTransportSecurity', label: 'HSTS (Strict-Transport-Security)' },
      { key: 'xFrameOptions',           label: 'X-Frame-Options (anti-clickjacking)' },
      { key: 'xContentTypeOptions',     label: 'X-Content-Type-Options' },
      { key: 'contentSecurityPolicy',   label: 'Content-Security-Policy' },
      { key: 'referrerPolicy',          label: 'Referrer-Policy' },
      { key: 'permissionsPolicy',       label: 'Permissions-Policy' },
      { key: 'xXssProtection',          label: 'X-XSS-Protection' },
    ];

    if (sh.error) {
      this.addRow('Headers', 'Erreur d\'analyse', 'error', sh.error);
    } else {
      headerMap.forEach(({ key, label }) => {
        this.addRow(label, checks[key] ? 'Présent' : 'Absent',
          checks[key] ? 'ok' : (key === 'contentSecurityPolicy' ? 'warn' : 'warn'));
      });

      if (values.server) {
        this.addRow('Serveur web', values.server, null);
      }
      if (values.poweredBy) {
        this.addRow('Technologie (X-Powered-By)', values.poweredBy, 'warn',
          'Révèle des infos techniques — mieux vaut masquer');
      }
    }

    this.doc.y += 10;
  }

  // ─── Section: Open Graph / Social ───────────────────────────────────────

  addSocialSection() {
    this.addSectionHeader('Réseaux sociaux & Open Graph', '📣');
    this._rowIndex = 0;
    const og = this.data.seo?.og || {};
    const tw = this.data.seo?.twitter || {};
    const links = this.data.seo?.socialLinks || {};

    // OG
    this.addRow('OG Title',       og.title || 'Absent', og.title ? 'ok' : 'warn');
    this.addRow('OG Description', og.description ? truncate(og.description) : 'Absente', og.description ? 'ok' : 'warn');
    this.addRow('OG Image',       og.image ? 'Présente' : 'Absente', og.image ? 'ok' : 'error',
      og.image ? truncate(og.image, 60) : 'Sans image, le partage sera peu attractif');
    this.addRow('OG Type',        og.type || 'Absent', og.type ? 'ok' : 'warn');

    // Twitter
    this.addRow('Twitter Card',       tw.card || 'Absente', tw.card ? 'ok' : 'warn');
    this.addRow('Twitter Image',      tw.image ? 'Présente' : 'Absente', tw.image ? 'ok' : 'warn');

    // Social presence
    this.addRow('Facebook',  links.facebook  || 'Non détecté', links.facebook  ? 'ok' : 'warn');
    this.addRow('Instagram', links.instagram || 'Non détecté', links.instagram ? 'ok' : 'warn');
    this.addRow('LinkedIn',  links.linkedin  || 'Non détecté', links.linkedin  ? 'ok' : 'warn');

    this.doc.y += 10;
  }

  // ─── Section: Technologies ──────────────────────────────────────────────

  addTechSection() {
    this.addSectionHeader('Technologies détectées', '⚙️');
    this._rowIndex = 0;
    const tech = this.data.technologies || {};

    if (tech.error) {
      this.addRow('Détection', 'Erreur', 'warn', tech.error);
      this.doc.y += 10;
      return;
    }

    this.addRow('CMS / Plateforme', tech.cms?.length > 0 ? tech.cms.join(', ') : 'Non détecté', null);
    this.addRow('Frameworks JS',    tech.frameworks?.length > 0 ? tech.frameworks.join(', ') : 'Non détecté', null);
    this.addRow('Analytics',        tech.analytics?.length > 0 ? tech.analytics.join(', ') : 'Aucun détecté',
      tech.analytics?.length > 0 ? 'ok' : 'warn');
    this.addRow('CDN / Hébergeur',  tech.cdn?.length > 0 ? tech.cdn.join(', ') : 'Non détecté', null);
    this.addRow('Serveur web',      tech.server || 'Non divulgué',
      !tech.server ? 'ok' : null);

    this.doc.y += 10;
  }

  // ─── Section: Broken Links ──────────────────────────────────────────────

  addBrokenLinksSection() {
    this.addSectionHeader('Liens vérifiés', '🔗');
    this._rowIndex = 0;
    const bl = this.data.brokenLinks || {};

    if (bl.error) {
      this.addRow('Vérification', 'Erreur lors de l\'analyse', 'warn', bl.error);
      this.doc.y += 10;
      return;
    }

    this.addRow('Liens internes vérifiés', `${bl.checked || 0}`, null);
    this.addRow('Liens cassés (404)',
      bl.broken?.length > 0 ? `${bl.broken.length} lien(s) cassé(s)` : 'Aucun',
      bl.broken?.length > 0 ? 'error' : 'ok');

    if (bl.broken?.length > 0) {
      bl.broken.slice(0, 5).forEach(link => {
        this.addRow('  🔴 Lien cassé', truncate(link.url, 70), 'error',
          `Statut: ${link.status || 'Erreur réseau'}`);
      });
    }

    this.doc.y += 10;
  }

  // ─── Section: Recommandations ────────────────────────────────────────────

  addRecommendationsSection() {
    this.addSectionHeader('Actions prioritaires recommandées', '🎯');
    const recs = this.data.recommendations || [];
    const doc = this.doc;

    if (recs.length === 0) {
      doc.fontSize(11).font('Helvetica').fillColor(COLORS.accent)
        .text('🎉 Excellent ! Aucune action critique identifiée.', this.margin, doc.y + 8);
      doc.y += 30;
      return;
    }

    const priorityColors = {
      'critique': COLORS.danger,
      'urgent':   COLORS.danger,
      'élevé':    COLORS.warning,
      'moyen':    COLORS.secondary,
      'faible':   COLORS.medium,
    };

    recs.forEach((rec, i) => {
      this.checkPageBreak(70);
      const y = doc.y + 8;
      const col = priorityColors[rec.priority] || COLORS.dark;

      // Number bubble
      doc.circle(this.margin + 12, y + 12, 12).fill(col);
      doc.fontSize(10).font('Helvetica-Bold').fillColor(COLORS.white)
        .text((i + 1).toString(), this.margin + 6, y + 6, { width: 13, align: 'center' });

      // Priority badge
      doc.roundedRect(this.margin + 32, y + 2, 70, 16, 8).fill(col);
      doc.fontSize(8).font('Helvetica-Bold').fillColor(COLORS.white)
        .text(rec.priority.toUpperCase(), this.margin + 32, y + 5, { width: 70, align: 'center' });

      // Category
      doc.fontSize(8).font('Helvetica').fillColor(COLORS.medium)
        .text(rec.category, this.margin + 112, y + 5, { width: 80 });

      // Action text
      doc.fontSize(10.5).font('Helvetica-Bold').fillColor(COLORS.dark)
        .text(rec.action, this.margin + 32, y + 22, { width: this.contentWidth - 40 });

      // Impact / Difficulty
      doc.fontSize(8.5).font('Helvetica').fillColor(COLORS.medium)
        .text(`Impact : ${rec.impact}   |   Difficulté : ${rec.difficulty}`,
          this.margin + 32, y + 38, { width: this.contentWidth - 40 });

      doc.y = y + 56;
    });

    doc.y += 10;
  }

  // ─── Footer ─────────────────────────────────────────────────────────────

  addPageFooter() {
    const doc = this.doc;
    const range = doc.bufferedPageRange();
    const start = range.start;
    const count = range.count;

    for (let i = start; i < start + count; i++) {
      doc.switchToPage(i);
      const pageNum = i + 1;
      if (pageNum === 1) continue; // Cover has its own footer

      const y = this.pageHeight - 40;
      doc.rect(0, y, this.pageWidth, 40).fill(COLORS.primary);

      doc.fontSize(8).font('Helvetica').fillColor(COLORS.medium)
        .text('contact@scanoo.fr  |  scanoo.fr  |  Confidentiel', this.margin, y + 12, {
          width: this.contentWidth - 60, align: 'left',
        });

      doc.fontSize(8).font('Helvetica').fillColor(COLORS.medium)
        .text(`Page ${pageNum}`, this.margin, y + 12, {
          width: this.contentWidth, align: 'right',
        });
    }
  }

  // ─── Generate ────────────────────────────────────────────────────────────

  generate(outputPath) {
    const doc = this.doc;

    // PAGE 1 — Cover
    this.addCoverPage();

    // PAGE 2+ — Content
    doc.addPage({ margins: { top: 50, bottom: 50, left: this.margin, right: this.margin } });
    this.addMinimalHeader();
    doc.y = 55;

    this.addSSLSection();
    this.addPerformanceSection();
    this.addSEOSection();
    this.addMobileSection();
    this.addSecuritySection();
    this.addSocialSection();
    this.addTechSection();
    this.addBrokenLinksSection();
    this.addRecommendationsSection();

    // Footer on all pages
    this.addPageFooter();

    // Stream to file
    return new Promise((resolve, reject) => {
      if (outputPath) {
        const stream = fs.createWriteStream(outputPath);
        doc.pipe(stream);
        stream.on('finish', () => resolve(outputPath));
        stream.on('error', reject);
      } else {
        doc.pipe(process.stdout);
        doc.on('end', resolve);
        doc.on('error', reject);
      }
      doc.end();
    });
  }
}

// ─── CLI ────────────────────────────────────────────────────────────────────

async function main() {
  let auditData;
  const inputArg = process.argv[2];
  const outputArg = process.argv[3];

  if (inputArg && inputArg !== '-') {
    // Read from file
    try {
      auditData = JSON.parse(fs.readFileSync(inputArg, 'utf8'));
    } catch (e) {
      console.error(`❌ Erreur de lecture du fichier ${inputArg}: ${e.message}`);
      process.exit(1);
    }
  } else {
    // Read from stdin
    let raw = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) raw += chunk;
    try {
      auditData = JSON.parse(raw);
    } catch (e) {
      console.error('❌ JSON invalide en entrée:', e.message);
      process.exit(1);
    }
  }

  const outputPath = outputArg || `audit-report-${Date.now()}.pdf`;
  console.error(`📄 Génération du rapport PDF → ${outputPath}`);

  const gen = new ScanooReport(auditData);
  await gen.generate(outputPath);

  console.error(`✅ Rapport généré : ${outputPath}`);
}

main().catch(err => {
  console.error('❌ Erreur:', err.message);
  process.exit(1);
});

module.exports = { ScanooReport };
