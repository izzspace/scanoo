#!/usr/bin/env node
/**
 * Scanoo - Generateur de rapport PDF
 * Usage: node report.js input.json output.pdf
 *
 * Rapport redige en langage simple pour des non-techniciens
 * (plombiers, restaurateurs, coiffeurs, etc.)
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

function formatDate(iso) {
  if (!iso) return 'N/A';
  try {
    return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
  } catch (_) { return iso; }
}

function trunc(str, n) {
  n = n || 60;
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

function scoreContext(total, max) {
  const pct = max > 0 ? (total / max) * 100 : 0;
  if (pct >= 80) {
    return total + '/' + max + ' — Excellent ! Ton site est bien optimise. Continue comme ca.';
  } else if (pct >= 60) {
    return total + '/' + max + ' — Dans la moyenne. Quelques ameliorations simples peuvent te faire passer devant tes concurrents.';
  } else if (pct >= 40) {
    return total + '/' + max + ' — En dessous de la moyenne. La plupart de tes concurrents font mieux. Mais la bonne nouvelle : les corrections sont simples.';
  } else {
    return total + '/' + max + ' — Ton site a besoin d\'attention. Plusieurs problemes importants ont ete detectes. On t\'explique tout ci-dessous.';
  }
}

// Detecter la version PHP dans les headers ou technologies
function detectPhpVersion(data) {
  const sh = data.securityHeaders || {};
  const values = sh.values || {};
  const powered = values.poweredBy || '';
  const match = powered.match(/PHP\/(\d+)\.(\d+)/i);
  if (match) {
    return { major: parseInt(match[1]), minor: parseInt(match[2]), raw: match[0] };
  }
  // Chercher aussi dans tech
  const tech = data.technologies || {};
  const server = tech.server || '';
  const match2 = server.match(/PHP\/(\d+)\.(\d+)/i);
  if (match2) {
    return { major: parseInt(match2[1]), minor: parseInt(match2[2]), raw: match2[0] };
  }
  return null;
}

// ─── Rapport ──────────────────────────────────────────────────────────────────
class ScanooReport {
  constructor(data) {
    this.data = data;
    this.M = 50;
    this.BOTTOM_MARGIN = 60;

    this.doc = new PDFDocument({
      size: 'A4',
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      bufferPages: true,
      info: {
        Title: 'Rapport Scanoo',
        Author: 'Scanoo',
      },
    });

    this.W = this.doc.page.width;   // 595
    this.H = this.doc.page.height;  // 842
    this.CW = this.W - this.M * 2;
  }

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

    doc.rect(0, 0, W, 320).fill(C.primary);
    doc.rect(0, 320, W, H - 320).fill(C.light);

    doc.font('Helvetica-Bold').fontSize(52).fillColor(C.white)
      .text('SCANOO', 0, 70, { width: W, align: 'center' });

    doc.font('Helvetica').fontSize(13).fillColor('#8BAACC')
      .text('Rapport de diagnostic de presence en ligne', 0, 138, { width: W, align: 'center' });

    doc.moveTo(M + 60, 168).lineTo(W - M - 60, 168)
      .strokeColor(C.blue).lineWidth(1).stroke();

    const url = this.data.meta?.url || '';
    doc.font('Helvetica-Bold').fontSize(12).fillColor(C.white)
      .text(trunc(url, 70), 0, 182, { width: W, align: 'center' });

    doc.font('Helvetica').fontSize(10).fillColor('#8BAACC')
      .text('Genere le ' + formatDate(this.data.meta?.auditedAt), 0, 206, { width: W, align: 'center' });

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

    const gaugeX = boxX + 20;
    const gaugeY = boxY + 97;
    const gaugeW = boxW - 40;
    this.hbar(gaugeX, gaugeY, gaugeW, total, max, scoreCol);

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

    doc.rect(0, H - 44, W, 44).fill(C.primary);
    doc.font('Helvetica').fontSize(8).fillColor(C.muted)
      .text('contact@scanoo.fr | scanoo.fr | Confidentiel | Page 1', M, H - 28, { width: CW, align: 'center' });
  }

  // ─── PAGE 2 : RESUME ───────────────────────────────────────────────────────
  buildExecutiveSummary() {
    this.doc.addPage();
    const doc = this.doc;
    const M = this.M;
    const CW = this.CW;
    doc.y = 50;

    doc.font('Helvetica-Bold').fontSize(20).fillColor(C.primary)
      .text("Ce qu'on a trouve", M, doc.y);
    doc.y += 8;
    doc.rect(M, doc.y, CW, 3).fill(C.mint);
    doc.y += 14;

    // Contexte du score
    const score = this.data.score || { total: 0, max: 100 };
    const total = score.total || 0;
    const max = score.max || 100;
    const scoreCol = scoreToColor(total, max);
    const context = scoreContext(total, max);

    const ctxY = doc.y;
    doc.roundedRect(M, ctxY, CW, 36, 6).fill(C.solutionBg);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(scoreCol)
      .text(context, M + 12, ctxY + 10, { width: CW - 24 });
    doc.y = ctxY + 46;

    const recs = this.data.recommendations || [];
    const critiques = recs.filter(r => {
      const p = (r.priority || '').toLowerCase();
      return p === 'critique' || p === 'urgent';
    });

    const ssl = this.data.ssl || {};
    const seo = this.data.seo || {};

    const strengths = [];
    if (ssl.valid && ssl.daysLeft > 30) strengths.push('Ton site est securise (le cadenas est bien present)');
    if (seo.title && seo.titleLength >= 20 && seo.titleLength <= 70) strengths.push('Le titre de ton site dans Google est bien configure');
    if (seo.viewport) strengths.push('Ton site est accessible depuis un telephone');
    if ((this.data.brokenLinks?.broken?.length || 0) === 0 && (this.data.brokenLinks?.checked || 0) > 0) {
      strengths.push('Tous les liens de ton site fonctionnent correctement');
    }
    const tech = this.data.technologies || {};
    if (tech.analytics && tech.analytics.length > 0) {
      strengths.push('Tu suis le nombre de visiteurs de ton site');
    }

    const top3strengths = strengths.slice(0, 3);
    if (top3strengths.length === 0) top3strengths.push('Audit realise avec succes');

    const top3issues = critiques.slice(0, 3);
    if (top3issues.length === 0) {
      top3issues.push(...recs.slice(0, 3));
    }

    // Points forts
    doc.font('Helvetica-Bold').fontSize(13).fillColor(C.dark)
      .text('Ce qui va bien', M, doc.y);
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
      .text('Ce qui necessite ton attention', M, doc.y);
    doc.y += 16;

    if (top3issues.length === 0) {
      const lineY = doc.y;
      this.statusCircle(M + 4, lineY, 'ok');
      doc.font('Helvetica').fontSize(10).fillColor(C.dark)
        .text('Aucun probleme urgent identifie', M + 16, lineY, { width: CW - 16 });
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
      .text('Comment lire ce rapport', M, doc.y);
    doc.y += 14;

    const legend = [
      { color: C.red,    label: 'Probleme', desc: 'A corriger rapidement - ca peut faire partir tes clients' },
      { color: C.orange, label: 'Attention', desc: 'A ameliorer - pas urgent mais important' },
      { color: C.green,  label: 'Bien', desc: 'Tout va bien sur ce point' },
    ];

    legend.forEach(({ color, label, desc }) => {
      const ly = doc.y;
      doc.circle(M + 6, ly + 5, 6).fill(color);
      doc.font('Helvetica-Bold').fontSize(9).fillColor(color)
        .text(label, M + 18, ly, { width: 60, continued: false });
      doc.font('Helvetica').fontSize(9).fillColor(C.dark)
        .text(desc, M + 84, ly, { width: CW - 84 });
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

  // ─── LIGNE DE DETAIL SIMPLE ────────────────────────────────────────────────
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
      .text(label, labelX, y, { width: 195 });

    const valColor = status === 'ok' ? C.green : status === 'error' ? C.red : status === 'warn' ? C.orange : C.dark;
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(valColor)
      .text(String(value || 'N/A'), M + 220, y, { width: CW - 225 });

    if (detail) {
      doc.font('Helvetica').fontSize(8).fillColor(C.muted)
        .text(String(detail), labelX, y + 14, { width: CW - 20 });
      doc.y = y + 30;
    } else {
      doc.y = y + 22;
    }
  }

  // ─── SECTION SECURITE ─────────────────────────────────────────────────────
  buildSecurity() {
    this.sectionHeader('Securite de ton site');
    const ssl = this.data.ssl || {};
    let idx = 0;

    if (!ssl.valid) {
      this.detailRow(
        'Le cadenas de securite',
        'Absent — ton site n\'est pas securise',
        'error',
        'Sans cadenas, les navigateurs affichent un avertissement qui fait fuir les visiteurs.',
        idx++
      );
      this.maybeNewPage(30);
      const summaryY = this.doc.y;
      this.doc.roundedRect(this.M, summaryY, this.CW, 28, 5).fill('#FEF2F2');
      this.doc.font('Helvetica-Bold').fontSize(9.5).fillColor(C.red)
        .text('Ton site a des problemes de securite — contacte la personne qui s\'occupe de ton site (ou ton hebergeur).',
          this.M + 10, summaryY + 8, { width: this.CW - 20 });
      this.doc.y = summaryY + 38;
    } else {
      this.detailRow('Le cadenas de securite', 'Ton site est securise (le cadenas est la)', 'ok', null, idx++);

      const daysLeft = ssl.daysLeft != null ? ssl.daysLeft : 999;
      const expStatus = daysLeft > 30 ? 'ok' : daysLeft > 0 ? 'warn' : 'error';
      let expDetail = null;
      if (daysLeft <= 30 && daysLeft > 0) {
        expDetail = 'Ca se renouvelle normalement tout seul — si ce n\'est pas le cas, contacte ton hebergeur.';
      }
      this.detailRow(
        'Le cadenas expire le',
        formatDate(ssl.expiresAt) + (daysLeft != null ? ' (' + daysLeft + ' jours)' : ''),
        expStatus,
        expDetail,
        idx++
      );

      this.maybeNewPage(30);
      const summaryY = this.doc.y + 6;
      this.doc.roundedRect(this.M, summaryY, this.CW, 28, 5).fill('#F0FDF4');
      this.doc.font('Helvetica-Bold').fontSize(9.5).fillColor(C.green)
        .text('Ton site est bien protege.',
          this.M + 10, summaryY + 8, { width: this.CW - 20 });
      this.doc.y = summaryY + 38;
    }

    this.doc.y += 4;
  }

  // ─── SECTION VITESSE ───────────────────────────────────────────────────────
  buildSpeed() {
    this.sectionHeader('Vitesse de ton site');
    const ps = this.data.pageSpeed;

    const mobileData = ps && ps.mobile;
    const mobileNA = !mobileData || mobileData.performance === null || mobileData.fcp === 'N/A' || mobileData.performance === undefined;

    this.maybeNewPage(60);

    if (mobileNA) {
      const msgY = this.doc.y + 4;
      this.doc.roundedRect(this.M, msgY, this.CW, 52, 5).fill(C.solutionBg);
      this.doc.circle(this.M + 10, msgY + 15, 4).fill(C.orange);
      this.doc.font('Helvetica-Bold').fontSize(10).fillColor(C.dark)
        .text('On n\'a pas pu mesurer la vitesse exacte de ton site.', this.M + 22, msgY + 9, { width: this.CW - 34 });
      this.doc.font('Helvetica').fontSize(9.5).fillColor(C.muted)
        .text('Tu peux tester toi-meme : va sur pagespeed.web.dev et tape l\'adresse de ton site.', this.M + 22, msgY + 26, { width: this.CW - 34 });
      this.doc.y = msgY + 62;
    } else {
      const perf = mobileData.performance;
      let vitesse, statusCircle;
      let fcp = parseFloat(mobileData.fcp);
      if (!isNaN(fcp)) {
        if (fcp < 2) { vitesse = 'rapide'; statusCircle = 'ok'; }
        else if (fcp < 4) { vitesse = 'correct'; statusCircle = 'warn'; }
        else { vitesse = 'lent'; statusCircle = 'error'; }
      } else {
        if (perf >= 70) { vitesse = 'rapide'; statusCircle = 'ok'; }
        else if (perf >= 40) { vitesse = 'correct'; statusCircle = 'warn'; }
        else { vitesse = 'lent'; statusCircle = 'error'; }
      }

      let fcpText = !isNaN(fcp) ? fcp + ' secondes' : 'voir ci-dessous';
      this.detailRow(
        'Ton site sur telephone',
        'S\'affiche en ' + fcpText + ' — c\'est ' + vitesse,
        statusCircle,
        null,
        0
      );

      if (vitesse === 'lent') {
        this.maybeNewPage(30);
        const warnY = this.doc.y + 4;
        this.doc.roundedRect(this.M, warnY, this.CW, 28, 5).fill('#FFF7ED');
        this.doc.font('Helvetica').fontSize(9.5).fillColor(C.orange)
          .text('Un site lent fait fuir les visiteurs. 53% des gens quittent un site qui met plus de 3 secondes a charger.',
            this.M + 10, warnY + 8, { width: this.CW - 20 });
        this.doc.y = warnY + 38;
      }
    }

    this.doc.y += 4;
  }

  // ─── SECTION GOOGLE ────────────────────────────────────────────────────────
  buildGoogleVisibility() {
    this.sectionHeader('Est-ce que tes clients te trouvent sur Google ?');
    const seo = this.data.seo || {};
    let idx = 0;

    if (seo.error) {
      this.detailRow('Analyse', 'Impossible d\'analyser le site', 'warn', seo.error, idx++);
      this.doc.y += 10;
      return;
    }

    // Titre dans Google
    let titleStatus, titleValue, titleDetail;
    if (!seo.title) {
      titleStatus = 'error';
      titleValue = 'Absent';
      titleDetail = 'Ton site n\'a pas de titre dans Google. Les gens ne savent pas ce que tu fais.';
    } else if (seo.titleLength < 20) {
      titleStatus = 'warn';
      titleValue = trunc(seo.title, 55) + ' (trop court)';
      titleDetail = 'Le titre est trop court pour etre bien vu sur Google.';
    } else if (seo.titleLength > 70) {
      titleStatus = 'warn';
      titleValue = trunc(seo.title, 55) + ' (trop long)';
      titleDetail = 'Le titre est trop long, Google va le couper. Essaie de le raccourcir.';
    } else {
      titleStatus = 'ok';
      titleValue = trunc(seo.title, 55);
      titleDetail = null;
    }
    this.detailRow('Le titre de ton site dans Google', titleValue, titleStatus, titleDetail, idx++);

    // Description dans Google
    let descStatus, descValue, descDetail;
    if (!seo.description) {
      descStatus = 'warn';
      descValue = 'Absente';
      descDetail = 'Sans description, Google affiche n\'importe quel texte de ton site. Tu rates une occasion d\'attirer des clients.';
    } else if (seo.descriptionLength < 50 || seo.descriptionLength > 160) {
      descStatus = 'warn';
      descValue = trunc(seo.description, 55) + (seo.descriptionLength > 160 ? ' (trop longue)' : ' (trop courte)');
      descDetail = null;
    } else {
      descStatus = 'ok';
      descValue = trunc(seo.description, 55);
      descDetail = null;
    }
    this.detailRow('La description dans Google', descValue, descStatus, descDetail, idx++);

    // Titre principal de la page (H1)
    const h1Count = Array.isArray(seo.h1) ? seo.h1.length : (seo.h1 ? 1 : 0);
    const h1Text = Array.isArray(seo.h1) && seo.h1[0] ? seo.h1[0] : (typeof seo.h1 === 'string' ? seo.h1 : null);
    let h1Status, h1Value, h1Detail;
    if (h1Count === 0) {
      h1Status = 'warn';
      h1Value = 'Aucun titre principal';
      h1Detail = 'Ton site devrait avoir un grand titre qui explique ce que tu fais.';
    } else if (h1Count > 1) {
      h1Status = 'warn';
      h1Value = 'Tu en as ' + h1Count + ', il en faut 1 seul';
      h1Detail = h1Text ? 'Exemple : "' + trunc(h1Text, 50) + '"' : null;
    } else {
      h1Status = 'ok';
      h1Value = h1Text ? trunc(h1Text, 50) : 'Present';
      h1Detail = null;
    }
    this.detailRow('Le titre principal de ta page', h1Value, h1Status, h1Detail, idx++);

    // Photos avec description
    const imgs = seo.images || {};
    const imgTotal = imgs.total || 0;
    const imgNoAlt = imgs.withoutAlt || 0;
    const imgWithAlt = imgTotal - imgNoAlt;
    if (imgTotal > 0) {
      let imgStatus = imgNoAlt === 0 ? 'ok' : imgNoAlt <= 2 ? 'warn' : 'error';
      let imgDetail = imgNoAlt > 0
        ? imgNoAlt + ' photo(s) n\'ont pas de description. Google ne peut pas les "lire".'
        : null;
      this.detailRow(
        'Tes photos',
        imgWithAlt + ' sur ' + imgTotal + ' ont une description pour Google',
        imgStatus,
        imgDetail,
        idx++
      );
    }

    this.doc.y += 4;
  }

  // ─── SECTION MOBILE ────────────────────────────────────────────────────────
  buildMobile() {
    this.sectionHeader('Ton site sur telephone');
    const seo = this.data.seo || {};
    const ps = this.data.pageSpeed;
    let idx = 0;

    const hasViewport = !!seo.viewport;
    const mobilePerf = ps && ps.mobile && ps.mobile.performance !== null ? ps.mobile.performance : null;

    let isAdapted = hasViewport;
    // Si on a un score mobile < 40, on considere pas adapte
    if (mobilePerf !== null && mobilePerf < 40) isAdapted = false;

    if (isAdapted) {
      this.detailRow('Ton site est adapte au telephone', 'Oui', 'ok', null, idx++);
    } else {
      this.detailRow(
        'Ton site est adapte au telephone',
        'Non — il est difficile a lire sur telephone',
        'error',
        '6 personnes sur 10 visitent ton site depuis leur telephone. Si c\'est illisible, ils partent.',
        idx++
      );
    }

    this.doc.y += 4;
  }

  // ─── SECTION RESEAUX SOCIAUX ───────────────────────────────────────────────
  buildSocial() {
    this.sectionHeader('Reseaux sociaux');
    const seo = this.data.seo || {};
    const og = seo.og || {};
    let idx = 0;

    this.maybeNewPage(30);
    this.doc.font('Helvetica').fontSize(9.5).fillColor(C.muted)
      .text('Quand quelqu\'un partage ton site sur Facebook ou WhatsApp :', this.M, this.doc.y, { width: this.CW });
    this.doc.y += 18;

    this.detailRow('Image affichee lors du partage', og.image ? 'Oui' : 'Non — pas d\'image', og.image ? 'ok' : 'error',
      og.image ? null : 'Sans image, le partage de ton site ne donne pas envie de cliquer.',
      idx++);

    this.detailRow('Titre affiche lors du partage', og.title ? trunc(og.title, 50) : 'Non configure', og.title ? 'ok' : 'warn',
      null, idx++);

    this.detailRow('Description affichee lors du partage', og.description ? 'Presente' : 'Non configuree', og.description ? 'ok' : 'warn',
      null, idx++);

    // Liens reseaux sociaux
    const links = seo.socialLinks || {};
    if (links.facebook || links.instagram) {
      this.doc.y += 6;
      this.doc.font('Helvetica').fontSize(9.5).fillColor(C.muted)
        .text('Liens vers tes reseaux sociaux detectes sur ton site :', this.M, this.doc.y, { width: this.CW });
      this.doc.y += 14;
      if (links.facebook) this.detailRow('Facebook', trunc(links.facebook, 50), 'ok', null, idx++);
      if (links.instagram) this.detailRow('Instagram', trunc(links.instagram, 50), 'ok', null, idx++);
      if (links.linkedin) this.detailRow('LinkedIn', trunc(links.linkedin, 50), 'ok', null, idx++);
    }

    this.doc.y += 4;
  }

  // ─── SECTION TECHNIQUE ─────────────────────────────────────────────────────
  buildTech() {
    this.sectionHeader('Informations techniques');
    const tech = this.data.technologies || {};
    const sh = this.data.securityHeaders || {};
    const values = sh.values || {};
    let idx = 0;

    if (tech.error) {
      this.detailRow('Detection', 'Impossible d\'analyser', 'warn', tech.error, idx++);
      this.doc.y += 10;
      return;
    }

    // CMS simplifie
    const cms = tech.cms && tech.cms.length > 0 ? tech.cms.join(', ') : null;
    if (cms) {
      this.detailRow('Ton site est fait avec', cms, null, null, idx++);
    } else {
      this.detailRow('Technologie du site', 'Non identifiee', null, null, idx++);
    }

    // Analytics
    const hasAnalytics = tech.analytics && tech.analytics.length > 0;
    if (hasAnalytics) {
      this.detailRow(
        'Suivi des visiteurs',
        tech.analytics.join(', ') + ' installe',
        'ok',
        null,
        idx++
      );
    } else {
      this.detailRow(
        'Suivi des visiteurs',
        'Pas installe',
        'warn',
        'Tu ne sais pas combien de gens visitent ton site ni d\'ou ils viennent.',
        idx++
      );
    }

    // PHP obsolete
    const phpVersion = detectPhpVersion(this.data);
    if (phpVersion && phpVersion.major < 8) {
      this.maybeNewPage(40);
      const warnY = this.doc.y + 4;
      this.doc.roundedRect(this.M, warnY, this.CW, 36, 5).fill('#FFF7ED');
      this.doc.circle(this.M + 10, warnY + 18, 4).fill(C.orange);
      this.doc.font('Helvetica-Bold').fontSize(9.5).fillColor(C.orange)
        .text(
          'Attention : ton site utilise une technologie obsolete (' + phpVersion.raw + '). Demande a ton hebergeur de mettre a jour gratuitement.',
          this.M + 22, warnY + 10, { width: this.CW - 34 }
        );
      this.doc.y = warnY + 46;
    }

    this.doc.y += 4;
  }

  // ─── SECTION LIENS ─────────────────────────────────────────────────────────
  buildLinks() {
    this.sectionHeader('Les liens de ton site');
    const bl = this.data.brokenLinks || {};
    let idx = 0;

    if (bl.error) {
      this.detailRow('Verification des liens', 'Impossible a verifier', 'warn', bl.error, idx++);
      this.doc.y += 10;
      return;
    }

    const checked = bl.checked || 0;
    const brokenCount = Array.isArray(bl.broken) ? bl.broken.length : 0;

    if (checked === 0) {
      this.detailRow('Liens verifies', 'Aucun lien a verifier', null, null, idx++);
    } else if (brokenCount === 0) {
      this.detailRow(
        'On a verifie ' + checked + ' lien(s) sur ton site',
        'Tous fonctionnent',
        'ok',
        null,
        idx++
      );
    } else {
      this.detailRow(
        'On a verifie ' + checked + ' lien(s) sur ton site',
        brokenCount + ' sont casses (ils menent nulle part)',
        'error',
        'Les liens casses font mauvaise impression et peuvent nuire a ton referencement Google.',
        idx++
      );

      const limit = Math.min(bl.broken.length, 5);
      for (let i = 0; i < limit; i++) {
        const lnk = bl.broken[i];
        this.detailRow('Lien casse', trunc(lnk.url, 65), 'error', null, idx++);
      }
    }

    this.doc.y += 4;
  }

  // ─── SECTION RECOMMANDATIONS ───────────────────────────────────────────────
  buildRecommendations() {
    this.doc.addPage();
    this.doc.y = 50;

    const doc = this.doc;
    const M = this.M;
    const CW = this.CW;

    doc.font('Helvetica-Bold').fontSize(18).fillColor(C.primary)
      .text('Que faire maintenant ?', M, doc.y);
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
      // Nettoyer le texte des termes techniques
      function cleanText(txt) {
        if (!txt) return txt;
        return txt
          .replace(/\bwebmaster\b/gi, 'la personne qui s\'occupe de ton site (ou ton hebergeur)')
          .replace(/\battribut alt\b/gi, 'description textuelle des photos')
          .replace(/\battributs alt\b/gi, 'descriptions textuelles des photos');
      }

      const action = cleanText(rec.action || 'Probleme detecte');
      const solutionText = cleanText(rec.solution || '');

      const solutionEstimate = Math.ceil((solutionText || '').length / 80) * 12 + 40;
      const blockHeight = 30 + 20 + solutionEstimate + 30;

      if (doc.y + blockHeight > this.H - this.BOTTOM_MARGIN) {
        doc.addPage();
        doc.y = 50;
      }

      const blockY = doc.y;
      const col = priorityColor(rec.priority);

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

      if (rec.category) {
        doc.font('Helvetica').fontSize(8).fillColor(C.muted)
          .text(rec.category, M + 100, blockY + 5, { width: CW - 105 });
      }

      doc.y = blockY + 24;

      doc.font('Helvetica-Bold').fontSize(10.5).fillColor(C.dark)
        .text(action, M + 2, doc.y, { width: CW - 4 });
      doc.y += 4;

      doc.font('Helvetica').fontSize(9).fillColor(C.muted)
        .text('Impact: ' + (rec.impact || 'N/A') + '  |  Difficulte: ' + (rec.difficulty || 'N/A'), M + 2, doc.y, { width: CW - 4 });
      doc.y += 14;

      if (solutionText) {
        doc.font('Helvetica-Bold').fontSize(9).fillColor(C.mint)
          .text('Comment faire :', M + 2, doc.y, { width: CW - 4 });
        doc.y += 14;

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

    doc.font('Helvetica-Bold').fontSize(13).fillColor(C.dark)
      .text('Recapitulatif', M, doc.y);
    doc.y += 16;

    const lines = [
      recs.length + ' probleme(s) identifie(s), dont ' + critiques.length + ' urgent(s)',
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

    // Page 2: Resume
    this.buildExecutiveSummary();

    // Pages 3+: Sections d'analyse (en language simple)
    this.doc.addPage();
    this.doc.y = 50;

    this.buildSecurity();
    this.buildSpeed();
    this.buildGoogleVisibility();
    this.buildMobile();
    this.buildSocial();
    this.buildTech();
    this.buildLinks();

    // Pages Recommandations
    this.buildRecommendations();

    // Derniere page: Conclusion
    this.buildConclusion();

    // Footers sur toutes les pages
    this.addFooters();

    return new Promise((resolve, reject) => {
      const stream = fs.createWriteStream(outputPath);
      this.doc.pipe(stream);
      stream.on('finish', () => resolve(outputPath));
      stream.on('error', reject);
      this.doc.on('error', reject);
      this.doc.end();
    });
  }
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
